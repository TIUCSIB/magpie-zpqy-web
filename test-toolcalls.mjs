// 测工具调用: 提示词协议输出的解析、历史回放、请求翻译(会话复用)、SSE 组装
// 不联网 —— 清言帧用构造的假事件喂给 ChatglmSSE。
import { _internal } from './index.mjs'

const { parseToolCalls, normalizeTools, renderTurn, translateRequest, ChatglmSSE, remember, convs } = _internal

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label, '\n     got =', JSON.stringify(got), '\n     期望 =', JSON.stringify(want)) }
}
// 解析结果简化成 [名字, 参数字符串][] 便于断言
const callsOf = (s) => {
  const r = parseToolCalls(s)
  return r ? r.calls.map((c) => [c.function.name, c.function.arguments]) : null
}
const textOf = (s) => parseToolCalls(s)?.text

console.log('[1] 解析: 提示词协议的主形态')
check('标准 JSON', callsOf('{"tool_calls":[{"name":"bash","arguments":{"command":"ls -la"}}]}'), [['bash', '{"command":"ls -la"}']])
check('前后夹带文字 → 文字留在 content', textOf('好的,我来看看:\n{"tool_calls":[{"name":"read","arguments":{}}]}'), '好的,我来看看:')
check('代码围栏(含前后文字)', callsOf('好的:\n```json\n{"tool_calls":[{"name":"read","arguments":{"path":"a.ts"}}]}\n```'), [['read', '{"path":"a.ts"}']])
check('多个工具一次给出', callsOf('{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{"x":2}}]}'), [['a', '{}'], ['b', '{"x":2}']])
check('function 包裹 + arguments 是字符串', callsOf('{"tool_calls":[{"function":{"name":"read","arguments":"{\\"path\\":\\"x\\"}"}}]}'), [['read', '{"path":"x"}']])
check('parameters 别名', callsOf('{"tool_calls":[{"name":"t","parameters":{"a":1}}]}'), [['t', '{"a":1}']])
check('裸单调用对象', callsOf('{"name":"bash","arguments":{"command":"pwd"}}'), [['bash', '{"command":"pwd"}']])
check('裸数组', callsOf('[{"name":"x","arguments":{}}]'), [['x', '{}']])
check('嵌套参数', callsOf('{"tool_calls":[{"name":"w","arguments":{"a":{"b":[1,2]}}}]}'), [['w', '{"a":{"b":[1,2]}}']])

console.log('[2] 解析: 模型不守协议时的兜底')
check('JS 对象字面量(裸键+单引号)', callsOf("{tool_calls:[{name:'bash',arguments:{cmd:'ls'}}]}"), [['bash', '{"cmd":"ls"}']])
check('GLM 原生 <tool_call> 标签', callsOf('<tool_call>get_weather\n<arg_key>city</arg_key>\n<arg_value>北京</arg_value>\n</tool_call>'), [['get_weather', '{"city":"北京"}']])
check('标签里是 JSON', callsOf('<tool_call>{"name":"bash","arguments":{"c":1}}</tool_call>'), [['bash', '{"c":1}']])
check('尾逗号', callsOf('{"tool_calls":[{"name":"a","arguments":{},},],}'), [['a', '{}']])

console.log('[3] 解析: 不该误判成工具调用')
check('普通回答', callsOf('你好!有什么可以帮你的?'), null)
check('正文里带花括号', callsOf('函数长这样 { "a": 1 } 对吧'), null)
check('用户要的 JSON 回答', callsOf('{"answer":42}'), null)
check('空输出', callsOf(''), null)

console.log('[4] 工具定义归一')
check('OpenAI 形态', normalizeTools([{ type: 'function', function: { name: 'bash', description: 'd', parameters: { type: 'object' } } }])[0].function.name, 'bash')
check('Anthropic 形态的 input_schema', normalizeTools([{ name: 'rw', description: 'd', input_schema: { type: 'object', properties: {} } }])[0].function.parameters, { type: 'object', properties: {} })
check('脏数据被过滤', normalizeTools([{ type: 'function' }, null, { function: { name: 'ok' } }]).length, 1)

console.log('[5] 历史回放')
check('assistant 的 tool_calls 按协议回放', renderTurn({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"c":1}' } }] }).text, '{"tool_calls":[{"name":"bash","arguments":{"c":1}}]}')
check('tool 结果消息', renderTurn({ role: 'tool', name: 'bash', tool_call_id: 'c1', content: 'ok' }).text, '# 工具执行结果\n`bash` (c1) 返回:\nok')
check('数组正文取文字', renderTurn({ role: 'user', content: [{ type: 'text', text: 'hi' }] }).text, 'hi')

console.log('[6] 请求翻译: 会话复用(agent 循环的关键)')
const tools = normalizeTools([{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }])
convs.clear()
// 第 1 轮: 新会话, 内联 system + 工具协议
const r1 = translateRequest({ messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: '帮我看看目录' }] }, tools)
check('第 1 轮开新会话', r1.conv, '')
check('第 1 轮注入工具协议', /工具调用协议/.test(r1.text), true)
check('第 1 轮带系统指令', /SYS/.test(r1.text), true)
remember('conv-1', r1.sig)

// 第 2 轮: 模型回了 tool_calls, 客户端带工具结果回来 → 必须复用会话(旧的实现这里会重开会话)
const r2 = translateRequest({ messages: [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: '帮我看看目录' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'a.ts b.ts' },
] }, tools)
check('第 2 轮复用会话', r2.conv, 'conv-1')
check('第 2 轮只发工具结果', /工具执行结果/.test(r2.text) && !/SYS/.test(r2.text), true)
check('第 2 轮带提醒', /还需要工具/.test(r2.text), true)
remember('conv-1', r2.sig)

// 第 3 轮: 普通追加, 仍复用
const r3 = translateRequest({ messages: [
  { role: 'user', content: '帮我看看目录' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'a.ts b.ts' },
  { role: 'assistant', content: '目录里有两个文件' },
  { role: 'user', content: '再读一下 a.ts' },
] }, tools)
check('第 3 轮复用会话', r3.conv, 'conv-1')
check('第 3 轮只发新消息', r3.text, '再读一下 a.ts')

// 历史对不上(新会话/被压缩) → 重开
const r4 = translateRequest({ messages: [{ role: 'user', content: '完全不相干的另一件事' }] }, tools)
check('历史对不上 → 重开会话', r4.conv, '')

console.log('[7] SSE 组装: 普通回答')
const chunks = []
const run = (evts, opts) => { const s = new ChatglmSSE('glm-5.3', { ...opts, onChunk: (c) => chunks.push(c) }); for (const e of evts) s.feed(e); return s }
chunks.length = 0
let s = run([
  { conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '你' }] }] },
  { status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '好' }] }] },
  { status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: '你好' }] }] },
])
check('正文不重复(finish 帧是全量)', s.text, '你好')
check('结束原因是 stop', chunks.at(-1).choices[0].finish_reason, 'stop')
check('会话 id 取到了', s.conv, 'cv')
check('推理内容透传', run([{ status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'think', think: '想' }] }] }], { onChunk: () => {} }).think, '想')

console.log('[8] SSE 组装: 工具调用(整段 JSON 不能漏进 content)')
chunks.length = 0
const json = '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}'
const evts = []
for (const ch of json) evts.push({ status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: ch }] }] })
evts.push({ conversation_id: 'cv', status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: json }] }] })
s = run(evts, { tools })
check('正文没有漏出 JSON', s.text, '')
check('结束时给出 tool_calls', chunks.filter((c) => c.choices[0].delta.tool_calls).length, 1)
check('finish_reason=tool_calls', chunks.at(-1).choices[0].finish_reason, 'tool_calls')
check('工具名与参数正确', chunks.at(-2).choices[0].delta.tool_calls[0].function, { name: 'bash', arguments: '{"command":"ls"}' })
check('带 index 便于客户端拼装', chunks.at(-2).choices[0].delta.tool_calls[0].index, 0)

console.log('[9] SSE 组装: 先正常文字再工具调用(缓冲要能放行文字)')
chunks.length = 0
s = run([
  { status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '先看看目录。然后' }] }] },
  { status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '{"tool_calls":[{"name":"bash","arguments":{}}]}' }] }] },
  { status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: '先看看目录。然后{"tool_calls":[{"name":"bash","arguments":{}}]}' }] }] },
], { tools })
check('前置文字照常流出', s.text, '先看看目录。然后')
check('结束时仍报 tool_calls', chunks.at(-1).choices[0].finish_reason, 'tool_calls')

console.log('[10] SSE 组装: 以 { 开头但不是工具调用 → 放行')
chunks.length = 0
s = run([
  { status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '{"answer":42, "note":"这是你要的 JSON"}' }] }] },
  { status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: '{"answer":42, "note":"这是你要的 JSON"}' }] }] },
], { tools })
check('JSON 正文完整发出', s.text, '{"answer":42, "note":"这是你要的 JSON"}')
check('结束原因是 stop', chunks.at(-1).choices[0].finish_reason, 'stop')

console.log('[11] SSE 组装: 多 part 与合规拦截')
chunks.length = 0
s = run([
  { status: 'init', parts: [{ logic_id: 'a', status: 'init', content: [{ type: 'text', text: '甲' }] }] },
  { status: 'init', parts: [{ logic_id: 'b', status: 'init', content: [{ type: 'text', text: '乙' }] }] },
  { status: 'finish', parts: [
    { logic_id: 'a', status: 'finish', content: [{ type: 'text', text: '甲' }] },
    { logic_id: 'b', status: 'finish', content: [{ type: 'text', text: '乙' }] },
  ] },
])
check('两个 part 都收全', s.text, '甲乙')
chunks.length = 0
s = run([{ status: 'intervene', last_error: { intervene_text: '内容不合规' } }])
check('intervene 有回话', /内容不合规/.test(s.text), true)
check('intervene 不当成功完成(无 stop 结束标记)', chunks.every((c) => c.choices[0].finish_reason !== 'stop'), true)
check('intervene 终态=upstream_error', s.round, 'upstream_error')
check('intervene 记 outError(由调用方发错误帧)', !!s.outError, true)

console.log('[12] 多行代码参数: 模型不转义换行(JSON 非法)也要能解析')
// 真实失败形态: oldString/newString 里直接换行, JSON.parse 必挂
const multiline = '{"tool_calls":[{"name":"edit","arguments":{"filePath":"a.ts","oldString":"const x = 1\nreturn x","newString":"const x = 2\nreturn x"}}]}'
check('裸换行能解析出调用', callsOf(multiline), [['edit', '{"filePath":"a.ts","oldString":"const x = 1\\nreturn x","newString":"const x = 2\\nreturn x"}']])
check('裸换行不吞掉前置正文', textOf(`继续。三处编辑一次做完：\n${multiline}`), '继续。三处编辑一次做完：')
check('制表符也能解析', callsOf('{"tool_calls":[{"name":"edit","arguments":{"s":"\tfoo"}}]}'), [['edit', '{"s":"\\tfoo"}']])
// 字符串里真正的换行保留为 \n, 不能被压成一行
check('换行语义保留', JSON.parse(callsOf(multiline)[0][1]).oldString, 'const x = 1\nreturn x')

console.log('[13] 空转判定: 只有引导语/半句话 → 该续写')
const { looksStalled } = _internal
check('冒号收尾的引导语', looksStalled('继续。三处编辑一次做完（加常量、替换两处硬编码、升版本号）：'), true)
check('逗号收尾', looksStalled('我先看看目录，'), true)
check('极短无句号', looksStalled('继续执行'), true)
check('空输出', looksStalled(''), true)
check('完整回答不算空转', looksStalled('改好了，共三处：常量、两处引用、版本号。'), false)
check('英文完整句不算空转', looksStalled('Let me execute. First the edits.'), false)
check('长正文不算空转', looksStalled('甲'.repeat(300)), false)
check('写到一半的调用不算空转', looksStalled('{"tool_calls":[{"name":"edit","arguments":{'), false)

console.log('[14] SSE holdEnd: finish 帧只结束回合, 由调用方决定是否续写')
chunks.length = 0
const held = new ChatglmSSE('glm-5.3', { tools, onChunk: (c) => chunks.push(c) })
held.holdEnd = true
held.feed({ conversation_id: 'cv', status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '继续：' }] }] })
held.feed({ status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: '继续：' }] }] })
check('回合结束但不终结流', held.roundDone && !held.finished, true)
check('此时没有 finish_reason', chunks.some((c) => c.choices[0].finish_reason), false)
held.beginRound()
check('beginRound 清掉上一轮 raw', held.raw, '')
held.feed({ status: 'init', parts: [{ logic_id: 'p2', status: 'init', content: [{ type: 'text', text: '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}' }] }] })
held.feed({ status: 'finish', parts: [{ logic_id: 'p2', status: 'finish', content: [{ type: 'text', text: '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}' }] }] })
held.end()
check('续写轮给出 tool_calls', held.calls?.[0]?.function?.name, 'bash')
check('两轮正文都保留', held.text, '继续：')
check('最终 finish_reason=tool_calls', chunks.at(-1).choices[0].finish_reason, 'tool_calls')

console.log('[15] beginRound: 上一轮押在缓冲里的正文不能丢')
// 末尾以 { 开头时正文还压在 buf 里(probe 态), 直接清空会让这句话凭空消失
chunks.length = 0
const carried = new ChatglmSSE('glm-5.3', { tools, onChunk: (c) => chunks.push(c) })
carried.holdEnd = true
carried.feed({ status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '我先看看：' }] }] })
carried.feed({ status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: '{' }] }] })
carried.feed({ status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: '我先看看：{' }] }] })
check('收尾前正文还押在 buf 里', carried.text, '我先看看：')
carried.beginRound()
check('beginRound 把押着的正文放出去', carried.text, '我先看看：{')

console.log('[16] 上游 error 帧: 要当终止信号, 且不触发续写')
chunks.length = 0
s = run([{ status: 'error', last_error: { message: '模型服务异常' } }])
check('error 也收尾', s.finished, true)
check('error 记到 sse.error', /模型服务异常/.test(s.error || ''), true)
check('error 不当成功完成(无 stop 结束标记)', chunks.every((c) => c.choices[0].finish_reason !== 'stop'), true)
check('error 终态=upstream_error', s.round, 'upstream_error')
check('error 记 outError', !!s.outError, true)

// holdEnd 下 error 必须终结(否则 pump 永远等不到 roundDone, 还会被误判成空转再补一轮)
chunks.length = 0
const errHeld = new ChatglmSSE('glm-5.3', { tools, onChunk: (c) => chunks.push(c) })
errHeld.holdEnd = true
errHeld.feed({ status: 'error', last_error: { message: 'boom' } })
check('holdEnd 下 error 直接终结', errHeld.finished, true)
check('holdEnd 下 error 不标记 roundDone', errHeld.roundDone, false)

console.log('[17] 退化输出: 超过上限要截断而不是无限收')
const { MAX_OUTPUT_CHARS } = _internal
check('上限常量存在且合理', typeof MAX_OUTPUT_CHARS === 'number' && MAX_OUTPUT_CHARS > 100_000, true)

console.log('[18] OpenAI 兼容细节: 截断报 length')
chunks.length = 0
const tr = new ChatglmSSE('glm-5.3', { onChunk: (c) => chunks.push(c) })
tr.truncated = true
tr.end()
check('截断的输出 finish_reason=length', chunks.at(-1).choices[0].finish_reason, 'length')

console.log('[19] 原样重发拦截: 报错调用的指纹')
const { callKey, failedCallKeys, TOOL_ERR_RE, TOOL_NUDGE_REPEAT } = _internal
// 指纹: 同名同参的不同写法要判等, 参数不同要判不等
check('字符串参数与对象参数判等', callKey('bash', '{"command":"ls -la"}'), callKey('bash', { command: 'ls -la' }))
check('键序不同判等', callKey('edit', '{"a":1,"b":2}'), callKey('edit', { b: 2, a: 1 }))
check('参数不同判不等', callKey('bash', { command: 'ls' }) === callKey('bash', { command: 'pwd' }), false)
// 历史里只有「结果像报错」的调用才进黑名单
const hist = [
  { role: 'user', content: '看看' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'c1', function: { name: 'open_url', arguments: '{"url":"file:///F:/x"}' } },
    { id: 'c2', function: { name: 'bash', arguments: '{"command":"ls"}' } },
  ] },
  { role: 'tool', tool_call_id: 'c1', name: 'open_url', content: 'Error: 该工具只支持 http(s) 链接' },
  { role: 'tool', tool_call_id: 'c2', name: 'bash', content: 'a.ts b.ts' },
]
const blockedHist = failedCallKeys(hist)
check('报错的调用进黑名单', blockedHist.has(callKey('open_url', { url: 'file:///F:/x' })), true)
check('成功的调用不进黑名单', blockedHist.has(callKey('bash', { command: 'ls' })), false)

console.log('[20] 报错轮: 纪律要在当轮消息里重新钉一遍(防协议被长历史冲淡)')
convs.clear()
const e1 = translateRequest({ messages: [{ role: 'user', content: '看看项目' }] }, tools)
remember('conv-1', e1.sig)
const e2 = translateRequest({ messages: [
  { role: 'user', content: '看看项目' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'open_url', arguments: '{"url":"file:///F:/x"}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'open_url', content: 'Error: 该工具只支持 http(s) 链接' },
] }, tools)
check('复用会话', e2.conv, 'conv-1')
check('报错轮带强化提醒', /报错的调用绝不允许原样重发/.test(e2.text), true)
check('报错轮带每轮提醒', /还需要工具/.test(e2.text), true)
check('带重发拦截黑名单', e2.blocked.has(callKey('open_url', { url: 'file:///F:/x' })), true)
const e3 = translateRequest({ messages: [
  { role: 'user', content: '看看项目' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'a.ts b.ts' },
] }, tools)
check('无报错不带强化提醒', /报错的调用绝不允许原样重发/.test(e3.text), false)
check('每轮提醒仍带纪律行', /绝不允许原样重发/.test(e3.text), true)
check('TOOL_ERR_RE 识别英文报错', TOOL_ERR_RE.test('Error: file not found'), true)
check('TOOL_ERR_RE 识别中文报错', TOOL_ERR_RE.test('命令执行失败, exit code 1'), true)
check('TOOL_ERR_RE 不咬普通输出', TOOL_ERR_RE.test('a.ts b.ts c.ts'), false)

console.log('[21] SSE 出站: 混在新调用里的重发要被丢掉')
// 这个场景里 open_url 与 bash 都必须是本次声明的工具(终态校验只放行声明内的调用)
const tools21 = normalizeTools([
  { type: 'function', function: { name: 'open_url', parameters: { type: 'object', properties: { url: { type: 'string' } } } } },
  { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
])
const blockedSet = new Set([callKey('open_url', { url: 'file:///F:/x' })])
chunks.length = 0
const both = '{"tool_calls":[{"name":"open_url","arguments":{"url":"file:///F:/x"}},{"name":"bash","arguments":{"command":"ls"}}]}'
s = run([
  { status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: both }] }] },
  { status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: both }] }] },
], { tools: tools21, blockedCalls: blockedSet })
check('只发新调用', s.calls.map((c) => c.function.name), ['bash'])
check('index 重排连续', chunks.filter((c) => c.choices[0].delta.tool_calls)[0].choices[0].delta.tool_calls[0].index, 0)
check('finish_reason=tool_calls', chunks.at(-1).choices[0].finish_reason, 'tool_calls')

console.log('[22] SSE 出站: 整轮都是重发 → 放行(续写预算只有一次, 客户端上限兜底)')
chunks.length = 0
const repeat = '{"tool_calls":[{"name":"open_url","arguments":{"url":"file:///F:/x"}}]}'
s = run([
  { status: 'init', parts: [{ logic_id: 'p1', status: 'init', content: [{ type: 'text', text: repeat }] }] },
  { status: 'finish', parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: repeat }] }] },
], { tools: tools21, blockedCalls: blockedSet })
check('仍给出调用由客户端兜底', s.calls.map((c) => c.function.name), ['open_url'])
check('点名续写轮就绪', /原样重发/.test(TOOL_NUDGE_REPEAT) && /换做法/.test(TOOL_NUDGE_REPEAT), true)

console.log('[23] 多围栏: 示例围栏在前, 真调用在正文里')
check('跳过不含 tool_calls 的围栏', callsOf('示例:\n```json\n{"name":"demo","arguments":{}}\n```\n{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}'), [['bash', '{"command":"ls"}']])
check('围栏+裸调用并存仍可解析', callsOf('```text\n随便什么\n```\n{"tool_calls":[{"name":"a","arguments":{}}]}'), [['a', '{}']])

console.log('[24] 终态判定: 各路径的 round 与 end 行为')
const { ROUND, checkToolCall } = _internal
// 构造一帧「事件级 status + 单个 text part」的清言帧
const tf = (conv, status, text) => ({
  ...(conv ? { conversation_id: conv } : {}),
  status,
  parts: [{ logic_id: 'p', status, content: [{ type: 'text', text }] }],
})
// EOF 没完成帧 → incomplete: 不伪造 finish_reason, 记 outError(EOF 时 pump 会调 end())
chunks.length = 0
s = run([tf('cv', 'init', '说了一半')])
s.end()
check('没 finish 帧的 end 判 incomplete', s.round, ROUND.INCOMPLETE)
check('incomplete 不发 finish_reason', chunks.some((c) => c.choices[0].finish_reason), false)
check('incomplete 记 outError', s.outError?.code, 'stream_incomplete')
// 半截正文保留原样(不追加错误说明覆盖已有输出)
check('已有正文不被错误文案顶掉', s.text, '说了一半')
// pump 先 markRound 再 end 的中断路径
chunks.length = 0
const sInt = new ChatglmSSE('glm-5.3', { onChunk: (c) => chunks.push(c) })
sInt.markRound(ROUND.INTERRUPTED, '读取上游流失败: 连接被重置')
sInt.end()
check('interrupted 无 finish_reason', chunks.some((c) => c.choices[0].finish_reason), false)
check('interrupted 的 outError.code', sInt.outError?.code, 'stream_interrupted')
check('markRound 先到先得: 已定局不被 EOF 洗白', (() => { sInt.markRound(ROUND.COMPLETED); return sInt.round })(), ROUND.INTERRUPTED)
// 截断: 报 length 但绝不报 tool_calls/不提交调用
chunks.length = 0
const sTr = new ChatglmSSE('glm-5.3', { tools, onChunk: (c) => chunks.push(c) })
sTr.feed(tf('cv', 'init', '{"tool_calls":[{"name":"bash","arguments":{"command":"ls'))
sTr.truncated = true
sTr.markRound(ROUND.TRUNCATED)
sTr.end()
check('截断轮不伪装成功工具调用', sTr.calls, null)
check('截断轮 finish_reason=length', chunks.at(-1).choices[0].finish_reason, 'length')
// 正常完成轮才有 tool_calls; checkToolCall 把住名字/JSON/schema 三道关
check('合法调用通过校验', checkToolCall({ function: { name: 'bash', arguments: '{"command":"ls"}' } }, tools), '')
check('未声明的工具名被拒', /不在本次声明/.test(checkToolCall({ function: { name: 'rm_rf', arguments: '{}' } }, tools)), true)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
