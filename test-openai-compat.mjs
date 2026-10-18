// OpenAI 兼容与驱动层确定性测试: mock 全局 fetch / Response / ReadableStream, 不联网不耗积分。
// 覆盖: 缺省 stream / stream=true / stream=false、include_usage、上游 HTTP 错误、status:error、
//       读流中断、客户端取消、工具调用(完整/截断/非法参数/未知工具)、会话隔离与并发守卫、
//       采样参数忽略策略、tool_choice=required、reasoning_effort 别名。
import { ChatglmAuthPlugin, _internal } from './index.mjs'

const { parseToolCalls, normalizeTools } = _internal

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label, '\n     got =', JSON.stringify(got)?.slice(0, 220), '\n     期望 =', JSON.stringify(want)?.slice(0, 220)) }
}

// ── mock 基建 ─────────────────────────────────────────────────────────────
const AUTH = { type: 'api', key: 'fake-cookie-token' }
const realFetch = globalThis.fetch
let upstreamCalls = [] // 每次上游请求: { conversation_id, meta_data }
let upstreamHandler = null // () => Response

const enc = new TextEncoder()
const encSse = (objs) => new ReadableStream({
  start(c) { for (const o of objs) c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); c.close() },
})
const sseRes = (events) => new Response(encSse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const firstFrame = (conv, text) => ({ id: 'u1', conversation_id: conv, status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text }] }] })
const finishFrame = (conv, text) => ({ conversation_id: conv, status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text }] }] })
const okUpstream = (conv = 'conv-x', text = '你好。') => [firstFrame(conv, text), finishFrame(conv, text)]

const plugin = await ChatglmAuthPlugin({ client: { app: { log() {} } } })
const loader = await plugin.auth.loader(async () => AUTH)

async function call(body, { sessionId = 'sess-default', signal } = {}) {
  const headers = { 'content-type': 'application/json', ...(sessionId ? { 'x-session-id': sessionId } : {}) }
  return loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
}
async function sseParts(res) {
  const raw = await res.text()
  const chunks = []
  for (const l of raw.split('\n')) {
    if (!l.startsWith('data:')) continue
    const t = l.slice(5).trim()
    if (!t) continue
    if (t === '[DONE]') { chunks.push({ done: true }); continue }
    try { chunks.push(JSON.parse(t)) } catch { chunks.push({ bad: t }) }
  }
  return { chunks, raw }
}
const finOf = (chunks) => chunks.filter((c) => c.choices?.[0]?.finish_reason).at(-1)?.choices?.[0]?.finish_reason
const toolCallsOf = (chunks) => chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TOOLS = [
  { type: 'function', function: { name: 'bash', description: '运行命令', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'edit', description: '写文件', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } },
]

// ── A. stream 缺省/false/true ─────────────────────────────────────────────
console.log('[A] stream 缺省/false 走 JSON, true 走 SSE')
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  upstreamCalls.push({ conversation_id: body.conversation_id, meta_data: body.meta_data })
  return sseRes(okUpstream('conv-' + (upstreamCalls.length), '你好。'))
}
{
  const res = await call({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }, { sessionId: 'sess-a1' })
  check('缺省 stream → JSON 响应', (res.headers.get('content-type') || '').includes('application/json'), true)
  const j = await res.json()
  check('finish_reason=stop', j.choices?.[0]?.finish_reason, 'stop')
  check('非流式含 usage', (j.usage?.prompt_tokens || 0) > 0, true)
  const res2 = await call({ model: 'glm-5.3-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] }, { sessionId: 'sess-a2' })
  check('stream=false → JSON 响应', (res2.headers.get('content-type') || '').includes('application/json'), true)
  const res3 = await call({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { sessionId: 'sess-a3' })
  check('stream=true → SSE 响应', (res3.headers.get('content-type') || '').includes('text/event-stream'), true)
  const { chunks } = await sseParts(res3)
  check('流式 role 首块', chunks[0]?.choices?.[0]?.delta?.role, 'assistant')
  check('流式 finish_reason=stop', finOf(chunks), 'stop')
}

// ── B. include_usage 门控 ────────────────────────────────────────────────
console.log('[B] include_usage 门控')
{
  const r1 = await call({ model: 'glm-5.3-flash', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }, { sessionId: 'sess-b1' })
  const { chunks } = await sseParts(r1)
  check('include_usage=true → usage 尾块', chunks.some((c) => c.usage), true)
  const r2 = await call({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { sessionId: 'sess-b2' })
  const { chunks: c2 } = await sseParts(r2)
  check('include_usage 缺省 → 无 usage 尾块', c2.some((c) => c.usage), false)
  check('仍有正常 finish', finOf(c2), 'stop')
}

// ── C. 上游 HTTP 500: 重试一次后放弃, OpenAI 错误体 ──────────────────────
console.log('[C] 上游 HTTP 500')
{
  let n = 0
  globalThis.fetch = async () => { n++; return new Response('upstream boom', { status: 500 }) }
  const res = await call({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'sess-c' })
  check('上游 500 → HTTP 500 错误响应', res.status, 500)
  const e = await res.json()
  check('OpenAI 错误体结构', typeof e.error?.message, 'string')
  check('重试一次后放弃(共 2 次上游调用)', n, 2)
}

// ── D. 上游 status:error 帧 → 流内错误对象, 不伪装成功 ───────────────────
console.log('[D] 上游 status:error 帧(流式)')
{
  globalThis.fetch = async () => sseRes([{ conversation_id: 'c', status: 'error', last_error: { message: '模型服务异常' } }])
  const res = await call({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'sess-d' })
  const { chunks } = await sseParts(res)
  check('流内 OpenAI 错误对象', chunks.some((c) => c.error?.type === 'upstream_error'), true)
  check('不发正常 finish_reason', finOf(chunks), undefined)
  check('以 [DONE] 收尾', chunks.at(-1)?.done, true)
}
console.log('[D2] 上游 status:error 帧(非流式) → HTTP 502')
{
  globalThis.fetch = async () => sseRes([{ conversation_id: 'c', status: 'error', last_error: { message: '模型服务异常' } }])
  const res = await call({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'sess-d2' })
  check('非流式上游错误 → HTTP 502', res.status, 502)
  const e = await res.json()
  check('错误体携带信息', (e.error?.message || '').includes('模型服务异常'), true)
}

// ── E. 读流中断: 部分输出后断流, 不得报正常 stop ─────────────────────────
console.log('[E] 读流中断(部分输出后)')
{
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify(firstFrame('c', '部分'))}\n\n`))
      c.enqueue(enc.encode(`data: ${JSON.stringify({ conversation_id: 'c', status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '输出' }] }] })}\n\n`))
      setTimeout(() => c.error(new Error('connection reset')), 10)
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const res = await call({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'sess-e' })
  const { chunks } = await sseParts(res)
  check('断流 → 流内错误对象', chunks.some((c) => c.error?.type === 'upstream_error'), true)
  check('断流 → 无正常 finish_reason=stop', finOf(chunks), undefined)
}

// ── F. 客户端取消: 停止读上游, 流及时终止 ────────────────────────────────
console.log('[F] 客户端取消')
{
  let upCancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify(firstFrame('c', '开始'))}\n\n`)) },
    cancel() { upCancelled = true },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const ac = new AbortController()
  const res = await call({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'sess-f', signal: ac.signal })
  const reader = res.body.getReader()
  const first = await reader.read()
  check('取消前收到首块', first.done, false)
  ac.abort()
  const second = await Promise.race([reader.read(), sleep(500).then(() => ({ timedOut: true }))])
  check('取消后流及时终止', second.done === true, true)
  await sleep(30)
  check('上游读取被取消', upCancelled, true)
}

// ── G. 工具调用: 完整 / 缺参数续写补齐 / 截断 / 未知工具 ─────────────────
console.log('[G] 工具调用端到端')
{
  globalThis.fetch = async () => sseRes(okUpstream('c', '好的。{"tool_calls":[{"name":"bash","arguments":{"command":"ls","description":"列目录"}}]}'))
  const res = await call({ model: 'glm-5.3-flash', stream: true, tools: TOOLS, messages: [{ role: 'user', content: '列目录' }] }, { sessionId: 'sess-g1' })
  const { chunks } = await sseParts(res)
  const tcs = toolCallsOf(chunks)
  check('工具调用被解析', tcs[0]?.function?.name, 'bash')
  check('参数保留', JSON.parse(tcs[0]?.function?.arguments || '{}').command, 'ls')
  check('finish=tool_calls', finOf(chunks), 'tool_calls')
}
{
  let seq = 0
  const seqRes = [
    sseRes(okUpstream('c', '{"tool_calls":[{"name":"edit","arguments":{"file_path":"a.ts"}}]}')),
    sseRes(okUpstream('c', '{"tool_calls":[{"name":"edit","arguments":{"file_path":"a.ts","content":"hello"}}]}')),
  ]
  globalThis.fetch = async () => seqRes[seq++] || sseRes(okUpstream('c', '你好。'))
  const res = await call({ model: 'glm-5.3-flash', stream: true, tools: TOOLS, messages: [{ role: 'user', content: '写文件' }] }, { sessionId: 'sess-g2' })
  const { chunks } = await sseParts(res)
  const tcs = toolCallsOf(chunks)
  check('缺 required 的调用不外发', tcs.some((t) => JSON.parse(t.function?.arguments || '{}').content === undefined), false)
  check('续写轮补齐后给出调用', JSON.parse(tcs.at(-1)?.function?.arguments || '{}').content, 'hello')
  check('上游共 2 轮(含续写)', seq, 2)
}
{
  let seq = 0
  const seqRes = [
    sseRes(okUpstream('c', '好的。{"tool_calls":[{"name":"edit","arguments":{"file_path":"a.ts","content":"he"}')),
    sseRes(okUpstream('c', '{"tool_calls":[{"name":"bash","arguments":{"command":"pwd","description":"x"}}]}')),
  ]
  globalThis.fetch = async () => seqRes[seq++] || sseRes(okUpstream('c', '你好。'))
  const res = await call({ model: 'glm-5.3-flash', stream: true, tools: TOOLS, messages: [{ role: 'user', content: '编辑' }] }, { sessionId: 'sess-g3' })
  const { chunks } = await sseParts(res)
  check('截断 JSON 不产生 edit 调用', toolCallsOf(chunks).some((t) => t.function?.name === 'edit'), false)
  check('截断 → 续写轮给出合法调用', toolCallsOf(chunks).some((t) => t.function?.name === 'bash'), true)
  check('截断正文不漏 JSON', JSON.stringify(chunks).includes('{"tool_calls"'), false)
}
{
  let seq = 0
  const seqRes = [
    sseRes(okUpstream('c', '{"tool_calls":[{"name":"nonexistent","arguments":{"x":1}}]}')),
    sseRes(okUpstream('c', '{"tool_calls":[{"name":"bash","arguments":{"command":"ls","description":"d"}}]}')),
  ]
  globalThis.fetch = async () => seqRes[seq++] || sseRes(okUpstream('c', '你好。'))
  const res = await call({ model: 'glm-5.3-flash', stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'y' }] }, { sessionId: 'sess-g4' })
  const { chunks } = await sseParts(res)
  check('未知工具名不外发', toolCallsOf(chunks).some((t) => t.function?.name === 'nonexistent'), false)
  check('未知工具触发续写, 第二轮给出合法调用', toolCallsOf(chunks).some((t) => t.function?.name === 'bash'), true)
  check('上游共 2 轮(含续写)', seq, 2)
}

// ── H. 会话隔离与并发守卫 ────────────────────────────────────────────────
console.log('[H] 会话隔离(x-session-id 主键 + 上下文指纹)')
{
  upstreamCalls.length = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    upstreamCalls.push({ conversation_id: body.conversation_id, meta_data: body.meta_data })
    return sseRes(okUpstream('conv-' + upstreamCalls.length, '你好。'))
  }
  const M1 = [{ role: 'user', content: 'a' }]
  const M2 = [{ role: 'user', content: 'a' }, { role: 'assistant', content: '好的。' }, { role: 'user', content: 'b' }]
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M1 }, { sessionId: 's-iso' })
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M2 }, { sessionId: 's-iso' })
  check('同会话同上下文 → 复用清言会话', upstreamCalls[1].conversation_id, 'conv-1')
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M2 }, { sessionId: 's-iso-2' })
  check('不同会话头 → 不复用', upstreamCalls[2].conversation_id, '')
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: [{ role: 'system', content: '不同的系统提示' }, { role: 'user', content: 'a' }] }, { sessionId: 's-iso' })
  check('系统提示变化 → 不复用', upstreamCalls[3].conversation_id, '')
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M1 }, { sessionId: 's-iso3' })
  await call({ model: 'glm-5.3', tools: TOOLS, messages: M2 }, { sessionId: 's-iso3' })
  check('模型变化 → 不复用', upstreamCalls[5].conversation_id, '')
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M1 }, { sessionId: 's-iso4' })
  await call({ model: 'glm-5.3-flash', tools: [], messages: M2 }, { sessionId: 's-iso4' })
  check('工具集变化 → 不复用', upstreamCalls[7].conversation_id, '')
}
console.log('[H2] 并发守卫')
{
  // 在途时第二个相似请求 → 降级为新会话, 不交叉写入
  upstreamCalls.length = 0
  let release
  const gate = new Promise((r) => { release = r })
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    upstreamCalls.push({ conversation_id: body.conversation_id })
    const conv = 'conv-' + upstreamCalls.length
    if (upstreamCalls.length === 1) return gate.then(() => sseRes(okUpstream(conv, '你好。')))
    return sseRes(okUpstream(conv, '你好。'))
  }
  const M2 = [{ role: 'user', content: 'a' }, { role: 'assistant', content: '好的。' }, { role: 'user', content: 'b' }]
  const p1 = call({ model: 'glm-5.3-flash', tools: TOOLS, messages: [{ role: 'user', content: 'a' }] }, { sessionId: 's-conc' })
  const p2 = call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M2 }, { sessionId: 's-conc' })
  const p3 = call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M2 }, { sessionId: 's-conc' })
  release()
  await Promise.all([p1, p2, p3])
  check('在途会话未登记前, 相似请求不交叉复用(全部新会话)', upstreamCalls.every((c) => c.conversation_id === ''), true)
  // 已 remember 后并发: busy 标记让第二个降级(q2 上游挂住 40ms, 保证 q3 在 q2 在途时发起)
  upstreamCalls.length = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    upstreamCalls.push({ conversation_id: body.conversation_id })
    const delay = upstreamCalls.length === 2 ? sleep(40) : Promise.resolve()
    return delay.then(() => sseRes(okUpstream('conv-b' + upstreamCalls.length, '你好。')))
  }
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: [{ role: 'user', content: 'a' }] }, { sessionId: 's-conc2' })
  const q2 = call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M2 }, { sessionId: 's-conc2' })
  const q3 = call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M2 }, { sessionId: 's-conc2' })
  await Promise.all([q2, q3])
  check('busy 在途时并发请求降级为新会话', upstreamCalls[2].conversation_id, '')
  check('在途请求不受影响正常完成', upstreamCalls[1].conversation_id, 'conv-b1')
}

console.log('[H3] 无会话头降级: 前缀 + 上下文指纹匹配仍生效(0.3.0 回归修复)')
{
  upstreamCalls.length = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    upstreamCalls.push({ conversation_id: body.conversation_id })
    return sseRes(okUpstream('conv-' + upstreamCalls.length, '你好。'))
  }
  const M1 = [{ role: 'user', content: 'H3 独有内容 c1' }]
  const M2 = [{ role: 'user', content: 'H3 独有内容 c1' }, { role: 'assistant', content: '好的。' }, { role: 'user', content: 'H3 独有内容 c2' }]
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M1 }, { sessionId: '' })
  await call({ model: 'glm-5.3-flash', tools: TOOLS, messages: M2 }, { sessionId: '' })
  check('无会话头 → 前缀+指纹降级复用', upstreamCalls[1].conversation_id, 'conv-1')
}

// ── I. 采样参数忽略策略 + effort 别名 + tool_choice=required ─────────────
console.log('[I] 参数策略')
{
  upstreamCalls.length = 0
  let lastText = ''
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    upstreamCalls.push(body)
    lastText = body.messages?.[0]?.content?.[0]?.text || ''
    return sseRes(okUpstream('conv-i', '你好。'))
  }
  await call({
    model: 'glm-5.3-flash', temperature: 0.5, top_p: 0.9, seed: 42, max_tokens: 100,
    messages: [{ role: 'user', content: 'x' }],
  }, { sessionId: 'sess-i1' })
  check('采样参数不透传上游', ['temperature', 'top_p', 'seed', 'max_tokens'].every((k) => !(k in upstreamCalls.at(-1))), true)
  await call({ model: 'glm-5.3-flash', reasoning_effort: 'medium', messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'sess-i2' })
  check('reasoning_effort=medium → high', upstreamCalls.at(-1).meta_data.reasoning_effort, 'high')
  check('medium → deep_thinking', upstreamCalls.at(-1).meta_data.chat_mode, 'deep_thinking')
  await call({ model: 'glm-5.3-flash', tools: TOOLS, tool_choice: 'required', messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'sess-i3' })
  check('tool_choice=required 注入强制段', lastText.includes('# 强制'), true)
}

// ── J. 解析层单测(多段 / 校验) ───────────────────────────────────────────
console.log('[J] parseToolCalls: 多段收集与校验')
{
  const r = parseToolCalls('三处编辑一次做完：\n{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}\n{"tool_calls":[{"name":"edit","arguments":{"file_path":"a.ts","content":"x"}}]}', normalizeTools(TOOLS))
  check('两段都收集', r.calls.map((c) => c.function.name), ['bash', 'edit'])
  check('引导语保留、调用剥净', r.text, '三处编辑一次做完：')
  check('无 invalid', r.invalid, 0)
  const r2 = parseToolCalls('<invoke_app>jupyter</invoke_app>\n{"tool_calls":[{"name":"bash","arguments":{"command":"pwd"}}]}', normalizeTools(TOOLS))
  check('臆造包装标签清理', r2.text, '')
  const r3 = parseToolCalls('{"tool_calls":[{"name":"edit","arguments":{"filePath":"a.ts","content":"x"}}]}', normalizeTools(TOOLS))
  check('camelCase 键对齐后合法', JSON.parse(r3.calls[0].function.arguments).file_path, 'a.ts')
  const r4 = parseToolCalls('{"tool_calls":[{"name":"nonexistent","arguments":{}}]}', normalizeTools(TOOLS))
  check('未知工具丢弃', r4.calls.length, 0)
  check('标记 invalid', r4.invalid, 1)
  check('参数非法 JSON → 无有效调用(返回 null)', parseToolCalls('{"tool_calls":[{"name":"bash","arguments":"不是json"}]}', normalizeTools(TOOLS)), null)
  const r6 = parseToolCalls('{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}')
  check('无 tools 时兼容放行(旧测试路径)', r6.calls.length, 1)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
