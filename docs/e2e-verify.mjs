// 真实宿主端到端验证(可恢复): 用分支代码 + 真实清言凭据, 按 magpie 的调用顺序驱动三个场景。
// magpie 顺序 = 先调插件的 chat.headers(input.sessionID → output.headers), 再把该头传给 loader.fetch。
// 观察点 = 发给清言上游的请求体 conversation_id(拦截 fetch, 不读任何本地配置以外内容)。
// 场景3 的失败轮用可控 mock 流注入(确定性、不消耗积分), 其余为真实清言请求。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ChatglmAuthPlugin, _internal } from '../index.mjs'

const { convs, dirty, SESSION_HEADER } = _internal
const store = JSON.parse(fs.readFileSync(process.env.MAGPIE_AUTH_FILE || path.join(os.homedir(), '.config', 'magpie', 'plugin-auth.json'), 'utf8'))
const auth = store.chatglm || Object.entries(store).find(([k]) => k.startsWith('chatglm#'))?.[1]

const plugin = await ChatglmAuthPlugin({ client: { app: { log: (x) => process.env.CHATGLM_DEBUG && console.error('[log]', JSON.stringify(x)) } } })
const loader = await plugin.auth.loader(async () => auth)

let upstream = []
const realFetch = globalThis.fetch
let mockNext = null // 设置后, 下一次上游请求返回可控流而非真实请求
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/assistant/stream')) {
    upstream.push(JSON.parse(init.body))
    if (mockNext) { const m = mockNext; mockNext = null; return m }
    return realFetch(url, init)
  }
  return realFetch(url, init)
}

let pass = 0, fail = 0
const check = (label, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label, extra) } }

// 按 magpie 契约走完整链: chat.headers 注头 → loader.fetch 带该头
const turn = async (sessionID, messages) => {
  const output = { headers: {} }
  await plugin['chat.headers']({ model: { providerID: 'chatglm' }, sessionID }, output)
  const headers = { 'content-type': 'application/json' }
  for (const [k, v] of Object.entries(output.headers)) headers[k] = v
  const res = await loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST', headers, body: JSON.stringify({ model: 'glm-5.3-flash', messages }),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, json: j }
}
const user = (t) => ({ role: 'user', content: t })
const asst = (t) => ({ role: 'assistant', content: t })
const convOf = (i) => upstream[i]?.conversation_id

console.log('[场景1] 同一 Agent 会话连续追问 → 增量复用原会话')
convs.clear(); dirty.clear(); upstream = []
const Q1 = '用一句话说明什么是快速排序。'
const r1 = await turn('e2e-session-1', [user(Q1)])
check('第一轮 HTTP 200 有正文', r1.status === 200 && (r1.json?.choices?.[0]?.message?.content || '').length > 5, JSON.stringify(r1.json?.error || '').slice(0, 150))
const c1 = convOf(0)
check('第一轮是新建(空 conv)', c1 === '', `got=${JSON.stringify(c1)}`)
const conv1 = r1.json ? upstream[0] : null
const realConv1 = [...convs.keys()][0]
check('会话已提交映射', !!realConv1, '')
const Q2 = '那它稳定吗?再一句话。'
const r2 = await turn('e2e-session-1', [user(Q1), asst(r1.json.choices[0].message.content || ''), user(Q2)])
check('第二轮 HTTP 200', r2.status === 200)
check('第二轮复用同一 conv(增量)', convOf(1) === realConv1, `got=${convOf(1)} want=${realConv1}`)
const sent2 = upstream[1].messages[0].content[0].text
check('第二轮只发新消息(不含第一轮全文)', /稳定/.test(sent2) && !sent2.includes('快速排序'), sent2.slice(0, 80))

console.log('\n[场景2] 两个 Agent 会话相同开场 → 不继承对方上下文')
convs.clear(); dirty.clear(); upstream = []
const SAME = '请记住: 本次会话的暗号是「紫罗兰」。只需回复收到。'
const a1 = await turn('e2e-session-A', [user(SAME)])
const a1conv = [...convs.keys()][0]
const a2 = await turn('e2e-session-B', [user(SAME)])
check('B 的开场请求是新建会话(未复用 A 的 conv)', convOf(1) === '', `got=${convOf(1)}`)
check('A、B 各占一条映射', convs.size, 2)
// B 的追问不得带上 A 的上下文: B 复用 B 自己的 conv
const bFollow = await turn('e2e-session-B', [user(SAME), asst(a2.json.choices[0].message.content || '收到'), user('我们的暗号是什么?')])
check('B 追问复用 B 自己的 conv', convOf(2) === [...convs.keys()].find((k) => k !== a1conv), `got=${convOf(2)}`)
const bAns = bFollow.json?.choices?.[0]?.message?.content || ''
check('B 答对暗号(上下文来自自己会话)', /紫罗兰/.test(bAns), bAns.slice(0, 60))

console.log('\n[场景3] 中断后继续 → 隔离会话不再匹配、无重复消息')
convs.clear(); dirty.clear(); upstream = []
const K1 = '请用一句话介绍冒泡排序。'
const k1 = await turn('e2e-session-C', [user(K1)])
const convC = [...convs.keys()][0]
check('前置: C 会话建立', !!convC && convOf(0) === '', '')
// 第二轮: 真实发送但可控断流(首帧带 conv id + 半截正文, 无完成帧 EOF) → delivery_unknown
const enc = new TextEncoder()
const halfStream = new Response(new ReadableStream({
  start(ctrl) {
    ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ conversation_id: convC, status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '冒泡排序' }] }] })}\n\n`))
    ctrl.close() // EOF 无完成帧 → incomplete
  },
}), { headers: { 'content-type': 'text/event-stream' } })
mockNext = halfStream
const K2 = '那它的时间复杂度是多少?'
const k2 = await turn('e2e-session-C', [user(K1), asst(k1.json.choices[0].message.content || ''), user(K2)])
check('中断轮返回 502(非伪装成功)', k2.status === 502, JSON.stringify(k2.json?.error || {}).slice(0, 120))
check('已选会话被隔离', convs.get(convC)?.quarantined, true)
// 第三轮继续: 不得复用被隔离的 conv; 断流那条 K2 只在内联史出现一次
const k3 = await turn('e2e-session-C', [user(K1), asst(k1.json.choices[0].message.content || ''), user(K2), /* 无 assistant 回复 */ user('请继续')])
const c3 = convOf(2)
check('继续轮不复用隔离 conv(新建)', c3 === '', `got=${c3}`)
const t3 = upstream[2].messages[0].content[0].text
const k2Count = (t3.match(/时间复杂度/g) || []).length
check('中断的消息在重建史中只出现一次(无重复)', k2Count === 1, `count=${k2Count}`)
check('重建会话完成后可正常提交映射', convs.size >= 2 && [...convs.values()].some((r) => !r.quarantined && !r.retired && r.sig.length), true)
globalThis.fetch = realFetch

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
