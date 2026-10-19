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
let passthrough = []    // 非对话透传请求(GET 探测/非聊天端点): {url, method}
const realFetch = globalThis.fetch
const mockFetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/assistant/stream')) {
    glmCalls.push(JSON.parse(init.body))
    if (glmIntercept) return glmIntercept(init)
    const next = script.shift()
    if (!next) throw new Error('test bug: 上游请求次数超出脚本')
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(init.signal)
    return next
  }
  // 其余清言 URL(透传探测 / available_models)一律本地应答, 保证零联网
  if (u.includes('operation/detail')) {
    return new Response(JSON.stringify({ result: { models: [{ selected_model: 'glm-5.3', display_name: 'GLM-5.3', reasoning_efforts: [{ am_effort: 'low' }, { am_effort: 'high' }, { am_effort: 'max' }] }] } }), { headers: { 'content-type': 'application/json' } })
  }
  passthrough.push({ url: u, method: (init && init.method) || 'GET' })
  return new Response('{"probe":true}', { status: 200, headers: { 'content-type': 'application/json' } })
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

// ---- 第四阶段 P0/P1 定点修复回归 ------------------------------------------------------
// 注意: Chat Completions 判定按 AI SDK 实际请求路径(baseURL + /chat/completions)。
const CHAT_URL = 'https://chatglm.cn/chat/completions'
const postChat = (rawBody, init = {}) => loader.fetch(CHAT_URL, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody, ...init,
})

console.log('\n[P0-1] 非法 arguments 字符串不得静默转成空参数调用')
convs.clear()
{
  // 模型把 arguments 写成非法 JSON 字符串(外层协议 JSON 合法, arguments 字段值解析不了)
  const badArgs = '{"tool_calls":[{"name":"bash","arguments":"{\\"command\\": \\"ls' + '"}]}'
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: badArgs }] }] }) + okFinishFrame(badArgs))]
  r = await callJson(withTools({ stream: false }))
  check('HTTP 200(完成回合但调用被拒)', r.res.status, 200)
  check('不出 tool_calls', r.json.choices[0].message.tool_calls, undefined)
  check('不是空参数调用', JSON.stringify(r.json.choices[0].message.tool_calls || []).includes('"arguments":"{}"'), false)
  check('finish_reason=stop', r.json.choices[0].finish_reason, 'stop')
  check('原始内容保留在正文', /bash/.test(r.json.choices[0].message.content || ''), true)
  // 流式路径同样拒绝
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: badArgs }] }] }) + okFinishFrame(badArgs))]
  const s = await callStream(withTools({ stream: true }), {})
  check('流式不出 tool_calls chunk', s.chunks.some((c) => c.choices?.[0]?.delta?.tool_calls), false)
  check('流式 finish_reason=stop', s.finish, 'stop')
}
convs.clear()
{
  // 合法 arguments 字符串(内层合法 JSON) → 仍要能解包放行(容错不回退)
  const strArgs = '{"tool_calls":[{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}]}'
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: strArgs }] }] }) + okFinishFrame(strArgs))]
  r = await callJson(withTools({ stream: false }))
  check('合法字符串参数仍解包为调用', r.json.choices[0].finish_reason, 'tool_calls')
  check('参数内容正确', r.json.choices[0].message.tool_calls[0].function.arguments, '{"command":"ls"}')
  // 缺失 arguments + schema 有必填 → 拒绝(不得转成可执行空调用)
  const missingArgs = '{"tool_calls":[{"name":"bash"}]}'
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: missingArgs }] }] }) + okFinishFrame(missingArgs))]
  r = await callJson(withTools({ stream: false }))
  check('缺必填参数被拒(不出 tool_calls)', r.json.choices[0].finish_reason, 'stop')
  check('无 tool_calls 字段', r.json.choices[0].message.tool_calls, undefined)
  // 合法空对象 {} + schema 允许空对象(open_url 无 required? 有) → 用 open_url(必填 url) 拒绝、bash 必填也拒绝;
  // 构造一个无必填 schema 的工具验证「合法 {} 通过」
  const noReq = { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'x' }], stream: false, tools: [{ type: 'function', function: { name: 'ping', description: 'd', parameters: { type: 'object', properties: {} } } }] }
  const pingJson = '{"tool_calls":[{"name":"ping","arguments":{}}]}'
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: pingJson }] }] }) + okFinishFrame(pingJson))]
  r = await callJson(noReq)
  check('合法 {} 且 schema 允许 → 通过', r.json.choices[0].finish_reason, 'tool_calls')
  check('arguments 为 {}', r.json.choices[0].message.tool_calls[0].function.arguments, '{}')
  // 决定性用例(P0 本体): 无必填字段的工具 + 非法 arguments 字符串。
  // 旧代码 looseJson()??{} 会把它变成合法的空参数调用 → Agent 真会执行 ping{};
  // 新代码保留原文 → checkToolCall 按「不是合法 JSON」拒绝。
  const pingBad = '{"tool_calls":[{"name":"ping","arguments":"{\\"x\\": \\"y' + '"}]}'
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: pingBad }] }] }) + okFinishFrame(pingBad))]
  r = await callJson(noReq)
  check('无必填工具+非法参数 → 不出 tool_calls(旧代码会放行空参数调用)', r.json.choices[0].message.tool_calls, undefined)
  check('按 stop 返回', r.json.choices[0].finish_reason, 'stop')
  check('原始非法调用保留在正文', /ping/.test(r.json.choices[0].message.content || ''), true)
  check('非法 arguments 原文未被吞掉', /arguments/.test(r.json.choices[0].message.content || ''), true)
}

console.log('\n[P1-1] Chat Completions POST 坏请求体 → 400 invalid_request_error')
{
  const before = glmCalls.length
  r = await postChat('{"model":"glm-5.3-flash", 坏JSON')
  check('坏 JSON → 400', r.status, 400)
  const j1 = await r.json()
  check('type=invalid_request_error', j1.error?.type, 'invalid_request_error')
  check('是 JSON 不是透传', /application\/json/.test(r.headers.get('content-type') || ''), true)
  r = await postChat(JSON.stringify({ model: 'glm-5.3-flash' }))
  check('缺 messages → 400', r.status, 400)
  const j2 = await r.json()
  check('param=messages', j2.error?.param, 'messages')
  r = await postChat(JSON.stringify({ model: 'glm-5.3-flash', messages: '不是数组' }))
  check('messages 非数组 → 400', r.status, 400)
  check('错误信息说明必须是数组', /数组/.test((await r.json()).error?.message || ''), true)
  check('三类坏请求零上游调用', glmCalls.length, before)
  // 合法空数组 messages → 通过校验进入聊天路径(非 400)
  script = [sseResp(okFinishFrame('好的。'))]
  r = await postChat(JSON.stringify({ model: 'glm-5.3-flash', messages: [] }))
  check('messages=[] 合法 → 不进 400', r.status, 200)
  await r.text()
}
{
  // GET 探测透传保留: 非聊天 URL 的 GET → 透传分支(本地 mock 应答 {"probe":true})
  passthrough.length = 0
  const res = await loader.fetch('https://chatglm.cn/chatglm/agent-api/some-probe', { method: 'GET' })
  const t = await res.text()
  check('GET 探测仍走透传(未变 400)', res.status, 200)
  check('透传命中本地 mock 应答', t.includes('probe'), true)
  check('透传记录到一次非 stream 请求', passthrough.length, 1)
  // POST 非聊天端点(无 messages) → 保持原透传行为(不按聊天 400)
  passthrough.length = 0
  const res2 = await loader.fetch('https://chatglm.cn/chatglm/backend-api/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' })
  check('POST 非聊天端点仍透传', res2.status, 200)
  await res2.text()
}

console.log('\n[P1-2] 模型能力声明快照: temperature=false')
{
  const cfg = { provider: {} }
  await plugin.config(cfg)
  const provider = { models: cfg.provider.chatglm ? Object.fromEntries(Object.keys(cfg.provider.chatglm.models).map((id) => [id, { id, providerID: 'chatglm' }])) : {} }
  const ms = await plugin.provider.models(provider, { auth: AUTH })
  const anyModel = Object.values(ms)[0]
  check('provider.models 有数据(mock available_models)', Object.keys(ms).length > 0, true)
  check('capabilities.temperature === false', anyModel?.capabilities?.temperature, false)
  check('capabilities.toolcall 仍为 true(提示词协议已声明)', anyModel?.capabilities?.toolcall, true)
  check('capabilities.reasoning 仍为 true', anyModel?.capabilities?.reasoning, true)
  const cfg2 = { provider: {} }
  await plugin.config(cfg2)
  check('config 声明不含 temperature 生效承诺(tool_call/reasoning 保留)', [cfg2.provider.chatglm.models['glm-5.3'].tool_call, cfg2.provider.chatglm.models['glm-5.3'].reasoning], [true, true])
}

console.log('\n[P1-3] tool_choice 语义钉死')
{
  const callJson2 = async (body) => {
    const res = await postChat(JSON.stringify(body))
    return { res, json: await res.json().catch(() => null) }
  }
  // none: 模型即使吐调用 JSON, 也不得输出 tool_calls
  convs.clear()
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: OK_JSON }] }] }) + okFinishFrame(OK_JSON))]
  glmCalls.length = 0
  r = await callJson2({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: '看看目录' }], tools: withTools().tools, tool_choice: 'none', stream: false })
  check('none: 不出 tool_calls', r.json.choices[0].finish_reason, 'stop')
  check('none: 无 tool_calls 字段', r.json.choices[0].message.tool_calls, undefined)
  check('none: 调用 JSON 以正文形式保留', /tool_calls/.test(r.json.choices[0].message.content || ''), true)
  check('none: 注入文本不含工具协议', /工具调用协议/.test(glmCalls[0].messages[0].content[0].text), false)
  // required: 模型给合法调用 → tool_calls
  convs.clear()
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: OK_JSON }] }] }) + okFinishFrame(OK_JSON))]
  glmCalls.length = 0
  r = await callJson2({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: '看看目录' }], tools: withTools().tools, tool_choice: 'required', stream: false })
  check('required+模型配合 → tool_calls', r.json.choices[0].finish_reason, 'tool_calls')
  check('required: 注入强制文案', /本轮必须输出/.test(glmCalls[0].messages[0].content[0].text), true)
  // required: 模型只给纯文本 → stop, 不伪造
  convs.clear()
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '我直接回答你。' }] }] }) + okFinishFrame('我直接回答你。'))]
  r = await callJson2({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: '看看目录' }], tools: withTools().tools, tool_choice: 'required', stream: false })
  check('required+模型不配合 → stop(不伪造调用)', [r.json.choices[0].finish_reason, r.json.choices[0].message.tool_calls], ['stop', undefined])
  // 指定函数: 协议里只留该函数, 其他工具名调用被 schema 校验拒绝
  convs.clear()
  script = [sseResp(frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: OK_JSON }] }] }) + okFinishFrame(OK_JSON))]
  glmCalls.length = 0
  r = await callJson2({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: '看看目录' }], tools: withTools().tools, tool_choice: { type: 'function', function: { name: 'open_url' } }, stream: false })
  check('指定 open_url 后 bash 调用被拒(协议里已无 bash)', r.json.choices[0].finish_reason, 'stop')
  check('协议段含 open_url 不含 bash 定义', /### open_url/.test(glmCalls[0].messages[0].content[0].text) && !/### bash/.test(glmCalls[0].messages[0].content[0].text), true)
}

console.log('\n[P1-4] 非流式思考内容边界钉死(当前行为: 不含思考字段)')
convs.clear()
{
  const thinkJson = { model: 'glm-5.3-flash', messages: [{ role: 'user', content: '想一下' }], stream: false }
  const thinkSse = frame({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'think', think: '内部推理过程' }] }] }) +
    frame({ status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '结论是 42。' }] }] }) +
    okFinishFrame('结论是 42。')
  script = [sseResp(thinkSse)]
  r = await callJson(thinkJson)
  check('非流式正文只有回答', r.json.choices[0].message.content, '结论是 42。')
  check('非流式 message 不含 reasoning 字段(边界声明)', Object.keys(r.json.choices[0].message).sort(), ['content', 'role'])
  check('usage 的 reasoning_tokens 仍计入思考', r.json.usage.completion_tokens_details.reasoning_tokens > 0, true)
  script = [sseResp(thinkSse)]
  const s = await callStream({ ...thinkJson, stream: true }, {})
  check('流式则透传 reasoning_content', s.raw.includes('内部推理过程'), true)
}

restoreFetch()
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
