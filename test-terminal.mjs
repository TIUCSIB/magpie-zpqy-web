// 确定性回归测试: 用 mock 的 fetch/Response/ReadableStream 驱动真实插件(loader.fetch),
// 覆盖响应终态、SSE 读取异常、非正常 EOF、错误态工具调用、取消与重试、stream 默认值、
// usage 门控、会话提交条件。不联网、不消耗清言积分。
import { ChatglmAuthPlugin, _internal } from './index.mjs'

const { convs, remember, ROUND, MAX_OUTPUT_CHARS, checkToolCall } = _internal

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label, '\n     got =', JSON.stringify(got), '\n     期望 =', JSON.stringify(want)) }
}

// ---- 插件实例与 mock fetch -----------------------------------------------------------
const AUTH = { type: 'oauth', access: 'test-token', refresh: JSON.stringify({ token: 'test-token', device: 'testdevice', guest: false }) }
const plugin = await ChatglmAuthPlugin({ client: { app: { log: () => {} } } })
const loader = await plugin.auth.loader(async () => AUTH)

let script = []   // 每个元素 = 一轮上游的返回值: Response、错误、或 (signal)=>Response 的工厂
let glmCalls = [] // 记录发给上游的清言请求体
let glmIntercept = null // 测试自定义的上游行为(优先于 script)
const realFetch = globalThis.fetch
const mockFetch = async (url, init) => {
  if (String(url).includes('/assistant/stream')) {
    glmCalls.push(JSON.parse(init.body))
    if (glmIntercept) return glmIntercept(init)
    const next = script.shift()
    if (!next) throw new Error('test bug: 上游请求次数超出脚本')
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(init.signal)
    return next
  }
  return realFetch(url, init) // 理论上不会走到这里
}
globalThis.fetch = mockFetch
const restoreFetch = () => { globalThis.fetch = realFetch }

// ---- 构造上游 SSE 流 -----------------------------------------------------------------
const frame = (evt) => `data: ${JSON.stringify(evt)}\n\n`
const sseResp = (text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
// 帧序列逐块下发, 且带背压: 只有 pump 真的 read 了才吐下一块(测截断路径不需要先灌几 MB)。
// frames 可以是数组, 也可以是 (n)=>string|null 的生成器(返回 null 表示 EOF)。
// throwAfter = 成功下发几块之后开始抛错(模拟连接中断)
function sseRespSeq(frames, { throwAfter = Infinity } = {}) {
  let n = 0
  const gen = typeof frames === 'function' ? frames : (i) => (i < frames.length ? frames[i] : null)
  return new Response(new ReadableStream({
    pull(ctrl) {
      if (n >= throwAfter) { n++; throw new Error('连接被重置') }
      const f = gen(n)
      if (f == null) { ctrl.close(); return }
      n++
      ctrl.enqueue(new TextEncoder().encode(f))
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
// 先吐一块, 之后 hang(直到 signal abort 才结束) —— 测「流中途取消 / 下游断开」
function sseRespHangAfterOne(signal) {
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '你好' }] }] }))) },
    pull(c) {
      return new Promise((res) => {
        const fin = () => { c.close(); res() } // abort 后以 EOF 结束(不 reject, 免 unhandled rejection)
        if (signal?.aborted) return fin()
        signal?.addEventListener('abort', fin, { once: true })
      })
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
const hangResp = (signal) => new Response(sseRespHangAfterOne(signal), { headers: { 'content-type': 'text/event-stream' } })

const userMsg = (extra = {}) => ({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: '你好' }], ...extra })
const withTools = (extra = {}) => ({
  ...extra,
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: '看看目录' }],
  tools: [
    { type: 'function', function: { name: 'bash', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'open_url', description: 'open', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  ],
})
const OK_JSON = '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}'
const okFinishFrame = (text) => frame({ conversation_id: 'cv', status: 'finish', parts: [{ logic_id: 'p', status: 'finish', content: [{ type: 'text', text }] }] })

const post = (body, init = {}) => loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init,
})
// 收流并解析: 流式路径按 SSE 行拆, 非流式按 JSON 读
async function callStream(body, init) {
  const res = await post(body, init)
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('event-stream')) {
    const j = await res.json().catch(() => null)
    return { res, ct, json: j, chunks: j?.object === 'chat.completion.chunk' ? [j] : [], hasDone: false, raw: JSON.stringify(j) }
  }
  const raw = await res.text()
  const chunks = []
  let done = false, error = null
  for (const line of raw.split('\n')) {
    const t = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!t) continue
    if (t === '[DONE]') { done = true; continue }
    try { const j = JSON.parse(t); if (j.error) error = j.error; else chunks.push(j) } catch {}
  }
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop() || null
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('')
  const usage = chunks.find((c) => c.usage)?.usage
  const lastUsageIndex = chunks.map((c) => (c.usage ? 1 : 0)).lastIndexOf(1)
  return { res, ct, raw, chunks, done, error, finish, content, usage, lastUsageIndex }
}
async function callJson(body, init) {
  const res = await post(body, init)
  const j = await res.json().catch(() => null)
  return { res, ct: res.headers.get('content-type') || '', json: j }
}

console.log('[T1] 非流式: 正常完成 → chat.completion + 会话提交')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '你好呀!' }] }] }) + frame({ status: 'finish', parts: [{ logic_id: 'p', status: 'finish', content: [{ type: 'text', text: '你好呀!' }] }] }))]
let r = await callJson(userMsg())
check('HTTP 200', r.res.status, 200)
check('是 JSON', /application\/json/.test(r.ct), true)
check('object=chat.completion', r.json.object, 'chat.completion')
check('正文完整', r.json.choices[0].message.content, '你好呀!')
check('finish_reason=stop', r.json.choices[0].finish_reason, 'stop')
check('有 usage', typeof r.json.usage?.total_tokens === 'number' && r.json.usage.total_tokens > 0, true)
check('会话映射已提交', convs.get('cv') != null, true)

console.log('\n[T2] 非流式: 上游 status:error → 502 错误体, 不提交会话')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '先说一半' }] }] }) + frame({ status: 'error', last_error: { message: '模型服务异常' } }))]
r = await callJson(userMsg())
check('HTTP 502', r.res.status, 502)
check('是 JSON', /application\/json/.test(r.ct), true)
check('错误体带 message', /模型服务异常/.test(r.json?.error?.message || ''), true)
check('code=upstream_error', r.json?.error?.code, 'upstream_error')
check('不是伪装的 chat.completion', r.json?.object, undefined)
check('会话映射未提交', convs.size, 0)

console.log('\n[T3] 非流式: 上游 status:intervene → 502, 不当普通完成')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'intervene', last_error: { intervene_text: '内容不合规' } }))]
r = await callJson(userMsg())
check('HTTP 502', r.res.status, 502)
check('code=content_intervene', r.json?.error?.code, 'content_intervene')
check('透出拦截文案', /内容不合规/.test(r.json?.error?.message || ''), true)
check('会话映射未提交', convs.size, 0)

console.log('\n[T4] 非流式: reader.read() 中途抛异常 → interrupted, 不自动重放整轮')
convs.clear()
script = [sseRespSeq([frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '甲' }] }] })], { throwAfter: 1 })]
glmCalls.length = 0
r = await callJson(userMsg())
check('HTTP 502', r.res.status, 502)
check('message 说明连接中断', /连接|中断/.test(r.json?.error?.message || ''), true)
check('code=stream_interrupted', r.json?.error?.code, 'stream_interrupted')
check('整轮没有被重放(上游只请求一次)', glmCalls.length, 1)
check('会话映射未提交', convs.size, 0)

console.log('\n[T5] 非流式: 没有完成帧的 EOF → incomplete')
convs.clear()
script = [sseRespSeq([frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '还没说完呢' }] }] })])]
glmCalls.length = 0
r = await callJson(userMsg())
check('HTTP 502', r.res.status, 502)
check('code=stream_incomplete', r.json?.error?.code, 'stream_incomplete')
check('EOF 后未重试(只请求一次)', glmCalls.length, 1)
check('会话映射未提交', convs.size, 0)

console.log('\n[T6] 非流式: 正常完成后 EOF 仍算完成(回归: 别把好轮误杀)')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '说完了。' }] }] }) + okFinishFrame('说完了。'))]
r = await callJson(userMsg())
check('HTTP 200', r.res.status, 200)
check('正文', r.json.choices[0].message.content, '说完了。')
check('finish_reason=stop', r.json.choices[0].finish_reason, 'stop')

console.log('\n[T7] 非流式工具调用: 正常完成 → tool_calls 放行')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: OK_JSON }] }] }) + okFinishFrame(OK_JSON))]
glmCalls.length = 0
r = await callJson(withTools({ stream: false }))
check('HTTP 200', r.res.status, 200)
check('finish_reason=tool_calls', r.json.choices[0].finish_reason, 'tool_calls')
check('工具名与参数', [r.json.choices[0].message.tool_calls[0].function.name, r.json.choices[0].message.tool_calls[0].function.arguments], ['bash', '{"command":"ls"}'])
check('正文不漏 JSON', r.json.choices[0].message.content, null)
check('会话映射已提交', convs.get('cv') != null, true)
check('未触发额外轮', glmCalls.length, 1)

console.log('\n[T8] 错误状态下的工具 JSON 不能当成功调用(任务书事故形态)')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: OK_JSON }] }] }) + frame({ status: 'error', last_error: { message: '模型服务异常' } }))]
r = await callJson(withTools({ stream: false }))
check('HTTP 502', r.res.status, 502)
check('code=upstream_error', r.json?.error?.code, 'upstream_error')
check('没有 tool_calls 输出', r.json?.choices, undefined)
check('会话映射未提交', convs.size, 0)

console.log('\n[T9] EOF 断在半截工具 JSON → incomplete, 不伪装调用也不重放')
convs.clear()
script = [sseRespSeq([frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '{"tool_calls":[{"name":"bash","arg' }] }] })])]
glmCalls.length = 0
r = await callJson(withTools({ stream: false }))
check('HTTP 502', r.res.status, 502)
check('code=stream_incomplete', r.json?.error?.code, 'stream_incomplete')
check('未重放整轮', glmCalls.length, 1)
check('会话映射未提交', convs.size, 0)

console.log('\n[T10] 声明外的工具名被拒 → 按普通文本收尾')
convs.clear()
const bogus = '{"tool_calls":[{"name":"rm_rf_everything","arguments":{}}]}'
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: bogus }] }] }) + okFinishFrame(bogus))]
r = await callJson(withTools({ stream: false }))
check('HTTP 200', r.res.status, 200)
check('finish_reason=stop(没塞调用给 Agent)', r.json.choices[0].finish_reason, 'stop')
check('没有 tool_calls', r.json.choices[0].message.tool_calls, undefined)
check('原始 JSON 保留在正文', /rm_rf_everything/.test(r.json.choices[0].message.content || ''), true)
check('会话映射已提交(完成轮仍算完成)', convs.get('cv') != null, true)

console.log('\n[T11] 参数不合 schema 被拒')
convs.clear()
const badArgs = '{"tool_calls":[{"name":"bash","arguments":{"cmd":"ls"}}]}'
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: badArgs }] }] }) + okFinishFrame(badArgs))]
r = await callJson(withTools({ stream: false }))
check('finish_reason=stop', r.json.choices[0].finish_reason, 'stop')
check('没有 tool_calls', r.json.choices[0].message.tool_calls, undefined)

console.log('\n[T12] checkToolCall 单元语义')
const declared = withTools().tools.map((t) => t.function.name)
check('合法调用放行', checkToolCall({ id: 'x', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }, withTools().tools), '')
check('未知工具拦截', /不在本次声明/.test(checkToolCall({ function: { name: 'nope', arguments: '{}' } }, withTools().tools)), true)
check('非法 arguments 拦截', checkToolCall({ function: { name: 'bash', arguments: '{invalid' } }, withTools().tools), '工具 bash 的 arguments 不是合法 JSON')
check('缺必填参数拦截', /缺少必填参数/.test(checkToolCall({ function: { name: 'bash', arguments: '{}' } }, withTools().tools)), true)
check('类型不符拦截', /应为 string 类型/.test(checkToolCall({ function: { name: 'bash', arguments: '{"command":123}' } }, withTools().tools)), true)

console.log('\n[T13] 取消: 建流时 signal 已 abort → 不重试、不续写')
convs.clear()
{
  const ac = new AbortController()
  ac.abort()
  script = []
  glmCalls.length = 0
  r = await callJson(userMsg(), { signal: ac.signal })
  check('HTTP 499', r.res.status, 499)
  check('code=cancelled', r.json?.error?.code, 'cancelled')
  check('fetch 根本没发出', glmCalls.length, 0)
  check('会话映射未提交', convs.size, 0)
}

console.log('\n[T14] 取消: 流中途 abort → 不发 [DONE], 不提交会话, 不重试')
convs.clear()
{
  const ac = new AbortController()
  script = [hangResp] // 工厂: 把插件的内部 signal 接上, abort 时以 EOF 结束上游流
  glmCalls.length = 0
  const res = await post(withTools({ stream: true }), { signal: ac.signal })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  const readOne = async () => { const { value, done } = await reader.read(); if (value) out += dec.decode(value); return done }
  await readOne() // 首块: role delta(说明流已正常开始)
  setTimeout(() => ac.abort(), 30)
  try { while (!await readOne()) {} } catch {}
  check('没有 [DONE]', /data: \[DONE\]/.test(out), false)
  check('没有成功的 finish_reason', /"finish_reason":"(stop|tool_calls)"/.test(out), false)
  check('会话映射未提交', convs.size, 0)
  check('上游只请求过一次(取消不重试)', glmCalls.length, 1)
}

console.log('\n[T15] 取消: 下游断开(reader cancel)→ 掐上游流, 不重试')
convs.clear()
{
  script = [hangResp]
  glmCalls.length = 0
  const res = await post(withTools({ stream: true }))
  const reader = res.body.getReader()
  await reader.read() // 起流
  await reader.cancel() // 下游断开
  await new Promise((r2) => setTimeout(r2, 50))
  check('会话映射未提交', convs.size, 0)
  check('没有新的上游请求', glmCalls.length, 1)
}

console.log('\n[T16] 延迟重试不穿越取消: 建流期间 abort → 不发起第二次 fetch')
convs.clear()
{
  const ac = new AbortController()
  glmCalls.length = 0
  glmIntercept = async () => {
    if (glmCalls.length === 1) { setTimeout(() => ac.abort(), 5); await new Promise((r2) => setTimeout(r2, 30)); throw new Error('boom') }
    throw new Error('test bug: 取消后还发起了重试')
  }
  r = await callJson(userMsg(), { signal: ac.signal })
  glmIntercept = null
  check('取消后的重试被跳过(HTTP 499)', r.res.status, 499)
  check('fetch 只发生一次', glmCalls.length, 1)
}

console.log('\n[T17] 空转续写仍正常(回归): 只补一轮, 完成后提交会话')
convs.clear()
script = [
  sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '继续：' }] }] }) + okFinishFrame('继续：')),
  sseResp(frame({ status: 'init', parts: [{ logic_id: 'p2', status: 'init', content: [{ type: 'text', text: OK_JSON }] }] }) + okFinishFrame(OK_JSON)),
]
glmCalls.length = 0
r = await callJson(withTools({ stream: false }))
check('续写后给出调用', r.json.choices[0].finish_reason, 'tool_calls')
check('上游请求次数=2(原轮+一轮续写)', glmCalls.length, 2)
check('续写复用会话', glmCalls[1].conversation_id, 'cv')
check('会话映射已提交', convs.get('cv') != null, true)

console.log('\n[T18] 错误终态禁止自动续写(回归: 旧代码会在半句后补轮)')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '我先看' }] }] }) + frame({ status: 'error', last_error: { message: 'boom' } }))]
glmCalls.length = 0
r = await callJson(withTools({ stream: false }))
check('不续写(只一次上游)', glmCalls.length, 1)
check('HTTP 502', r.res.status, 502)
check('会话映射未提交', convs.size, 0)

console.log('\n[T19] stream 默认值: 未传 stream → JSON(OpenAI 默认非流式)')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'finish', parts: [{ logic_id: 'p', status: 'finish', content: [{ type: 'text', text: '好了。' }] }] }))]
r = await post(userMsg(), {})
check('content-type=JSON', /application\/json/.test(r.headers.get('content-type') || ''), true)
const j = await r.json()
check('object=chat.completion', j.object, 'chat.completion')

console.log('\n[T20] stream:false → JSON; stream:true → SSE')
convs.clear()
script = [sseResp(okFinishFrame('答案。')), sseResp(okFinishFrame('答案。'))]
r = await post(userMsg({ stream: false }), {})
check('stream:false 是 JSON', /application\/json/.test(r.headers.get('content-type') || ''), true)
await r.text()
{
  const s = await callStream(userMsg({ stream: true }), {})
  check('stream:true 是 SSE', /text\/event-stream/.test(s.ct), true)
  check('有 chunk', s.chunks.length > 0, true)
  check('finish_reason=stop', s.finish, 'stop')
  check('以 [DONE] 收尾', s.done, true)
}

console.log('\n[T21] include_usage 门控: 默认不发 usage 尾块; 请求了才发且在 [DONE] 前')
convs.clear()
script = [sseResp(okFinishFrame('答案。')), sseResp(okFinishFrame('答案。'))]
{
  const s = await callStream(userMsg({ stream: true }), {})
  check('未请求 → 无 usage 尾块', s.usage, undefined)
}
{
  const s = await callStream(userMsg({ stream: true, stream_options: { include_usage: true } }), {})
  check('请求了 → 有 usage 尾块', typeof s.usage?.total_tokens === 'number', true)
  const usageIdx = s.raw.lastIndexOf('"usage"')
  const doneIdx = s.raw.lastIndexOf('[DONE]')
  check('usage 在 [DONE] 之前', usageIdx > -1 && doneIdx > usageIdx, true)
  const finishIdx = s.raw.lastIndexOf('"finish_reason":"stop"')
  check('finish_reason 在 usage 之前(顺序: chunk→usage→DONE)', finishIdx > -1 && finishIdx < usageIdx, true)
}

console.log('\n[T22] 流式正常完成: chunk + finish_reason + [DONE]')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '你好。' }] }] }) + okFinishFrame('你好。'))]
r = await callStream(withTools({ stream: true }), {})
check('HTTP 200', r.res.status, 200)
check('finish_reason=stop', r.finish, 'stop')
check('有 [DONE]', r.done, true)
check('流内无错误帧', r.error, null)
check('会话映射已提交', convs.get('cv') != null, true)

console.log('\n[T23] 流式工具调用: 正常完成 → tool_calls chunk')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: OK_JSON }] }] }) + okFinishFrame(OK_JSON))]
r = await callStream(withTools({ stream: true }), {})
check('finish_reason=tool_calls', r.finish, 'tool_calls')
check('有调用 chunk', r.chunks.some((c) => c.choices?.[0]?.delta?.tool_calls), true)
check('有 [DONE]', r.done, true)

console.log('\n[T24] 流式上游错误: 错误帧收尾, 不发 [DONE], 无成功 finish_reason')
convs.clear()
script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '前半句' }] }] }) + frame({ status: 'error', last_error: { message: '模型服务异常' } }))]
r = await callStream(withTools({ stream: true }), {})
check('HTTP 200(已开始不能再改状态码)', r.res.status, 200)
check('流内 error 帧', /模型服务异常/.test(r.error?.message || ''), true)
check('不发 [DONE]', r.done, false)
check('无 finish_reason', r.finish, null)
check('没有伪装的 tool_calls', r.chunks.some((c) => c.choices?.[0]?.delta?.tool_calls), false)
check('会话映射未提交', convs.size, 0)

console.log('\n[T25] 流式无完成帧 EOF → incomplete 错误帧, 不发 [DONE]')
convs.clear()
script = [sseRespSeq([frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '还没完' }] }] })])]
r = await callStream(withTools({ stream: true }), {})
check('HTTP 200', r.res.status, 200)
check('error 帧 code=stream_incomplete', r.error?.code, 'stream_incomplete')
check('不发 [DONE]', r.done, false)
check('会话映射未提交', convs.size, 0)

console.log('\n[T26] 流式读流异常 → interrupted 错误帧')
convs.clear()
script = [sseRespSeq([frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '甲' }] }] })], { throwAfter: 1 })]
r = await callStream(withTools({ stream: true }), {})
check('error 帧 code=stream_interrupted', r.error?.code, 'stream_interrupted')
check('不发 [DONE]', r.done, false)
check('会话映射未提交', convs.size, 0)

console.log('\n[T27] 主动截断: 报 length 不伪装自然完成; 不提交会话')
convs.clear()
{
  const big = '甲'.repeat(25_000)
  script = [sseRespSeq(() => frame({ status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: big }] }] }))]
  glmCalls.length = 0
  r = await callJson(userMsg({ stream: false }))
  check('HTTP 200(截断是有效回答)', r.res.status, 200)
  check('finish_reason=length', r.json.choices[0].finish_reason, 'length')
  check('未重放整轮', glmCalls.length, 1)
  check('会话映射未提交(截断不算完成)', convs.size, 0)
  {
    script = [sseRespSeq(() => frame({ status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: big }] }] }))]
    const s = await callStream(userMsg({ stream: true }), {})
    check('流式截断也报 length 且有 [DONE]', [s.finish, s.done], ['length', true])
  }
}

console.log('\n[T28] 单帧 JSON 解析失败与传输失败分开: 坏帧跳过, 好帧照常, 完成轮仍成功')
convs.clear()
script = [sseResp('data: {broken json\n\n' + frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '好了。' }] }] }) + okFinishFrame('好了。'))]
r = await callJson(userMsg())
check('HTTP 200(坏帧不升级为传输错误)', r.res.status, 200)
check('好帧照常收', r.json.choices[0].message.content, '好了。')
check('会话映射已提交', convs.get('cv') != null, true)

console.log('\n[T29] 非 SSE 响应(风控页)→ 502 错误体(回归)')
convs.clear()
script = [new Response('<html>安全验证</html>', { headers: { 'content-type': 'text/html' } })]
r = await callJson(userMsg())
check('HTTP 502', r.res.status, 502)
check('风控文案', /风控|验证/.test(r.json?.error?.message || ''), true)

console.log('\n[T30] 续写轮发不出去: 不倒扣首轮(收到过 finish 帧 = 完成)')
convs.clear()
{
  // 首轮照常, 续写轮建流直接 4xx 失败(<500 不重试, 也不该重放)
  script = [
    sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '继续：' }] }] }) + okFinishFrame('继续：')),
    new Response('{"status":400}', { status: 400, headers: { 'content-type': 'application/json' } }),
  ]
  glmCalls.length = 0
  r = await callJson(withTools({ stream: false }))
  check('仍返回 200(首轮是完成回合)', r.res.status, 200)
  check('正文保留', r.json.choices[0].message.content, '继续：')
  check('finish_reason=stop', r.json.choices[0].finish_reason, 'stop')
  check('会话映射已提交', convs.get('cv') != null, true)
}

restoreFetch()
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
