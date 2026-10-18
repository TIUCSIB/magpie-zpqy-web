// 联网冒烟: 直接驱动插件(不经网关)跑一遍 签名→对话 SSE→工具调用→会话复用。
// 用本机 magpie 已登录的清言账号(~/.config/magpie/plugin-auth.json), 会消耗少量积分。
//   node test-live.mjs
// 若只想验证纯逻辑, 跑 test-toolcalls.mjs(不联网)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ChatglmAuthPlugin } from './index.mjs'

const authFile = process.env.MAGPIE_AUTH_FILE || path.join(os.homedir(), '.config', 'magpie', 'plugin-auth.json')
if (!fs.existsSync(authFile)) {
  console.error(`找不到 ${authFile} —— 先用 magpie 登录清言, 或设 MAGPIE_AUTH_FILE 指向别的账号文件`)
  process.exit(1)
}
const auth = JSON.parse(fs.readFileSync(authFile, 'utf8')).chatglm
if (!auth) {
  console.error(`${authFile} 里没有 chatglm 账号`)
  process.exit(1)
}
console.log(`账号: ${auth.type} 方式, 凭据长度 ${String(auth.key || auth.access || '').length}`)

const plugin = await ChatglmAuthPlugin({ client: { app: { log: (x) => console.error('[plugin]', JSON.stringify(x)) } } })
const cfg = { provider: {} }
await plugin.config(cfg)
console.log('config 声明:', JSON.stringify(cfg.provider.chatglm.models['glm-5.3-flash']))

// 账号下的模型 + 能力位(agent 就是看这里决定要不要带工具)
const ms = await plugin.provider.models(cfg.provider.chatglm, { auth })
for (const [id, m] of Object.entries(ms)) {
  console.log(`provider.models: ${id} [${m.name}] toolcall=${m.capabilities?.toolcall} variants=${Object.keys(m.variants || {}).join('/')}`)
}

const loader = await plugin.auth.loader(async () => auth)
let pass = 0, fail = 0
const check = (label, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label, extra) } }

const call = async (body) => {
  const res = await loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream_options: { include_usage: true }, ...body }),
  })
  const raw = await res.text()
  if (!res.ok) return { status: res.status, error: raw.slice(0, 300) }
  const chunks = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const t = line.slice(5).trim()
    if (t === '[DONE]') continue
    try { chunks.push(JSON.parse(t)) } catch {}
  }
  return {
    status: res.status,
    content: chunks.map((c) => c.choices?.[0]?.delta?.content || '').join(''),
    reasoningLen: chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content || '').join('').length,
    calls: chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []),
    finish: chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop(),
    usage: chunks.find((c) => c.usage)?.usage,
  }
}

const tools = [
  { type: 'function', function: { name: 'read_file', description: '读取工作区里的一个文本文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列出一个目录下的文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]
const SYS = '你是一个能操作本地文件的编码助手。'
const ASK = '读一下 src/index.ts 这个文件的内容。'

console.log('\n[1] 带工具请求 → 应给出 tool_calls, 正文里不能漏 JSON')
const r1 = await call({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'system', content: SYS }, { role: 'user', content: ASK }], tools })
check('HTTP 200', r1.status === 200, JSON.stringify(r1).slice(0, 300))
check('finish_reason=tool_calls', r1.finish === 'tool_calls', `finish=${r1.finish} content=${(r1.content || '').slice(0, 120)}`)
check('给出了工具名', /read_file|list_dir/.test(r1.calls[0]?.function?.name || ''), JSON.stringify(r1.calls))
check('参数是合法 JSON', (() => { try { JSON.parse(r1.calls[0]?.function?.arguments || ''); return true } catch { return false } })(), r1.calls[0]?.function?.arguments)
check('正文没有漏出 JSON', !/"tool_calls"/.test(r1.content || ''), r1.content)
check('每个调用都带 index/id', r1.calls.every((c) => c.index != null && c.id))

console.log('\n[2] 回填工具结果 → 应复用会话并给出最终回答(agent 循环第二步)')
let r2 = null
if (r1.calls?.length) {
  const c0 = r1.calls[0]
  r2 = await call({
    model: 'glm-5.3-flash', stream: true, tools,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: ASK },
      { role: 'assistant', content: null, tool_calls: [{ id: c0.id, type: 'function', function: { name: c0.function.name, arguments: c0.function.arguments } }] },
      { role: 'tool', tool_call_id: c0.id, name: c0.function.name, content: 'export const hello = () => "hi"\nconsole.log(hello())' },
    ],
  })
  check('HTTP 200', r2.status === 200, JSON.stringify(r2).slice(0, 300))
  check('最终回答是文本', r2.finish === 'stop' && r2.content.length > 0, `finish=${r2.finish}`)
  check('答到了文件内容', /hello/.test(r2.content || ''), r2.content.slice(0, 200))
  check('prompt 随轮次累加(按客户端完整上下文计账, 不再是 in=2)', r2.usage?.prompt_tokens > (r1.usage?.prompt_tokens || 0), `r1=${r1.usage?.prompt_tokens} r2=${r2.usage?.prompt_tokens}`)
} else {
  fail++; console.log('  ✗ 用例 1 没给出 tool_calls, 跳过')
}

console.log('\n[3] 不带工具的普通对话(回归)')
const r3 = await call({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: '用一句话说明什么是快速排序。' }] })
check('HTTP 200', r3.status === 200, JSON.stringify(r3).slice(0, 300))
check('finish_reason=stop', r3.finish === 'stop', `finish=${r3.finish}`)
check('有正文', (r3.content || '').length > 10, r3.content)
check('没被误判成工具调用', !/tool_calls/.test(r3.content || ''))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
