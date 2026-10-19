// 第二阶段步骤 1 回归: 会话记录结构、acct/ctxKey 门控、六条件匹配、
// 前缀强制与退役、增量三重保护、清理与棘轮。mock fetch 端到端 + 单元级混合。
// 不联网、不消耗清言积分。用例编号对齐 docs/phase2-session-design.md §10。
import { ChatglmAuthPlugin, _internal } from './index.mjs'

const { convs, dirty, remember, translateRequest, normalizeTools, acctOf, ctxKeyOf, quarantine, retire, dirtyAdd, newRecord, SESSION_HEADER, jwtIsGuest } = _internal

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label, '\n     got =', JSON.stringify(got), '\n     期望 =', JSON.stringify(want)) }
}

// ---- 单元级辅助: 直接以 ctx 走 translateRequest + remember 的匹配门控 -------------------
const tools1 = normalizeTools([{ type: 'function', function: { name: 'bash', description: 'd', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }])
const CTX = { acct: 'acct-A', sessionKey: 'sess-A', model: 'glm-5.3-flash', effort: 'low' }
const sysMsg = (s = 'SYS') => ({ role: 'system', content: s })
const userMsg = (u) => ({ role: 'user', content: u })
const asstCall = () => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] })
const toolResult = (out = 'a.ts b.ts') => ({ role: 'tool', tool_call_id: 'c1', name: 'bash', content: out })
// 完整 ctx 的 translateRequest: ctxKey 由实现计算, 这里同步算一份给 remember 用
const reqOf = (messages, tools = tools1, ctx = CTX) => {
  const openai = { model: ctx.model, messages, tools }
  const req = translateRequest(openai, tools, ctx)
  return req
}
const commit = (conv, req) => remember(conv, req.sig, { acct: req.acct, ctxKey: req.ctxKey, sessionKey: req.sessionKey })

console.log('[S3] 系统提示词变更 → ctxKey 变 → 不复用(重开)')
convs.clear(); dirty.clear()
const a1 = reqOf([sysMsg('SYS-1'), userMsg('看看目录')])
commit('conv-A', a1)
const a2 = reqOf([sysMsg('SYS-2-变了'), userMsg('看看目录')])
check('sys 变更后不复用', a2.conv, '')
check('旧 conv 记录还在(未退役, 只是 ctx 不符)', convs.has('conv-A'), true)

console.log('[S4] 工具清单变更 → ctxKey 变 → 不复用')
convs.clear(); dirty.clear()
const t1 = reqOf([sysMsg(), userMsg('看看目录')], tools1)
commit('conv-T', t1)
const tools2 = normalizeTools([...tools1, { type: 'function', function: { name: 'read', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }])
const t2 = reqOf([sysMsg(), userMsg('看看目录')], tools2)
check('工具集变更后不复用', t2.conv, '')

console.log('[S5] 模型/档位变更 → ctxKey 变 → 不复用')
convs.clear(); dirty.clear()
const m1 = reqOf([sysMsg(), userMsg('你好')], tools1, { ...CTX, model: 'glm-5.3-flash', effort: 'low' })
commit('conv-M', m1)
const m2 = reqOf([sysMsg(), userMsg('你好')], tools1, { ...CTX, model: 'glm-5.3', effort: 'low' })
check('换模型不复用', m2.conv, '')
const m3 = reqOf([sysMsg(), userMsg('你好')], tools1, { ...CTX, model: 'glm-5.3-flash', effort: 'max' })
check('换档位不复用', m3.conv, '')

console.log('[S7] 不同账号作用域(acct) → 不复用')
convs.clear(); dirty.clear()
const g1 = reqOf([sysMsg(), userMsg('你好')], tools1, { ...CTX, acct: 'acct-X' })
commit('conv-X', g1)
const g2 = reqOf([sysMsg(), userMsg('你好')], tools1, { ...CTX, acct: 'acct-Y' })
check('换账号不复用', g2.conv, '')

console.log('[N1] 有 sessionKey 但历史前缀不匹配 → 退役重建(禁止 slice)')
convs.clear(); dirty.clear()
const h1 = reqOf([userMsg('甲'), asstCall(), toolResult(), userMsg('乙')])
commit('conv-H', h1)
// 同 session/同 ctx, 但中段分叉(客户端压缩了历史)
const h2 = reqOf([userMsg('完全不同的压缩史'), userMsg('乙')], tools1, { ...CTX, sessionKey: 'sess-A' })
check('前缀分叉不复用', h2.conv, '')
check('旧 conv 退役 history-diverged', convs.get('conv-H')?.retired, 'history-diverged')
check('退役后不再参与匹配', reqOf([userMsg('甲'), asstCall(), toolResult(), userMsg('乙')]).conv, '')

console.log('[N5] 历史被裁剪(sig 比 sent 短) → 不复用不 slice')
convs.clear(); dirty.clear()
const c1 = reqOf([userMsg('一'), asstCall(), toolResult(), userMsg('二')])
commit('conv-C', c1)
const c2 = reqOf([userMsg('一')]) // 客户端把后面的都删了
check('裁剪后不复用', c2.conv, '')
check('旧 conv 退役', !!convs.get('conv-C')?.retired, true)

console.log('[N7] uid 后 6 位相同、全值不同 → acct 摘要不同')
const mkJwt = (uid) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ uid, exp: 9999999999 })}.sig`
}
const uidA = '1234567890', uidB = '9994567890' // 后 6 位都是 4567890? 不: 都是 "4567890" 截 6 = "567890"
check('两 uid 后 6 位确实相同', uidA.slice(-6), uidB.slice(-6))
check('acctOf 用全值摘要 → 不同', acctOf(mkJwt(uidA)) !== acctOf(mkJwt(uidB)), true)
check('同 uid 换 token 其余字段 → acct 稳定', acctOf(mkJwt(uidA)) === acctOf(mkJwt(uidA)), true)
check('无 uid 退回凭据摘要', acctOf('not-a-jwt') !== acctOf('another-token'), true)

console.log('[N13] 清理与棘轮: 隔离拒写 → 过期整条删除 → 同 id 可作新记录重入')
convs.clear(); dirty.clear()
const p1 = reqOf([userMsg('你好')])
commit('conv-P', p1)
quarantine('conv-P', 'test')
check('隔离后 remember 拒写(棘轮)', (() => { remember('conv-P', ['x'.repeat(32)], { acct: p1.acct }); return convs.get('conv-P').sig })(), p1.sig)
check('隔离记录不参与匹配', reqOf([userMsg('你好')]).conv, '')
// 把隔离时刻拨回 25h 前 → 下一次 remember(任意 conv) 触发 sweep 整条删除
convs.get('conv-P').ts = Date.now() - 25 * 3600_000
remember('conv-Q', p1.sig, { acct: p1.acct, ctxKey: p1.ctxKey, sessionKey: p1.sessionKey })
check('过期隔离记录被删除(不是解封保留)', convs.has('conv-P'), false)
check('删除后同 id 可作新记录重入', (() => { commit('conv-P', p1); return convs.get('conv-P')?.quarantined })(), false)
// dirty TTL
dirtyAdd('conv-D')
dirty.set('conv-D', Date.now() - 2 * 3600_000)
remember('conv-R', p1.sig, { acct: p1.acct })
check('dirty 过期删除', dirty.has('conv-D'), false)
// LRU: 灌 49 条, 最旧 lastUsed 被逐
convs.clear()
for (let i = 0; i < 49; i++) remember(`lru-${i}`, [`h${i}`.padEnd(32, '0')], { acct: 'a' }), (convs.get(`lru-${i}`).lastUsed = Date.now() - (49 - i) * 1000)
check('active 超容量按 lastUsed 淘汰', convs.size <= 48 && !convs.has('lru-0'), true)

console.log('[N14] 耗时保护: lastUsed 超 STALE_MS 不复用')
convs.clear(); dirty.clear()
const s1 = reqOf([userMsg('你好'), asstCall(), toolResult(), userMsg('继续')])
commit('conv-S', s1)
convs.get('conv-S').lastUsed = Date.now() - 31 * 60_000 // 31 分钟前
const s2 = reqOf([userMsg('你好'), asstCall(), toolResult(), userMsg('继续'), userMsg('再来')])
check('陈旧映射不复用', s2.conv, '')
check('退役原因 stale-or-oversized', convs.get('conv-S')?.retired, 'stale-or-oversized')

console.log('[N18] 增量消息数/体积超限 → 不复用重建')
convs.clear(); dirty.clear()
// 有 sessionKey: 前缀 1 条, 新增 65 条 > GAP_MAX_WITH_SESSION(64)
const many = [userMsg('开场')]
for (let i = 0; i < 65; i++) many.push(userMsg(`第${i}步`), asstCall(), toolResult())
const base = reqOf([userMsg('开场')], tools1, CTX)
commit('conv-N18', base)
const big = reqOf(many, tools1, CTX)
check('消息数超限不复用', big.conv, '')
check('退役原因', convs.get('conv-N18')?.retired, 'stale-or-oversized')
// 体积: 单条 600KB 消息
convs.clear()
const base2 = reqOf([userMsg('开场')], tools1, CTX)
commit('conv-N18b', base2)
const huge = reqOf([userMsg('开场'), userMsg('巨'.repeat(300_000))], tools1, CTX) // 900KB utf8
check('体积超限不复用', huge.conv, '')

console.log('[N17] 无头(无 sessionKey)前缀不匹配 → 同样退役重建(门控与 sessionKey 无关)')
convs.clear(); dirty.clear()
const n0 = { acct: 'acct-A', model: 'glm-5.3-flash', effort: 'low' } // 无 sessionKey
const n1 = reqOf([userMsg('甲'), asstCall(), toolResult(), userMsg('乙')], tools1, n0)
commit('conv-N17', n1)
const n2 = reqOf([userMsg('压缩后的不同历史')], tools1, n0)
check('无头前缀分叉不复用', n2.conv, '')
check('无头同样退役', convs.get('conv-N17')?.retired, 'history-diverged')
// 降级可达性: 未被退役的映射, 前缀成立+有增量 → 照常复用(与有头环境行为一致)
convs.clear(); dirty.clear()
const d1 = reqOf([userMsg('开场白')], tools1, n0)
commit('conv-DGR', d1)
const d2 = reqOf([userMsg('开场白'), { role: 'assistant', content: '答' }, userMsg('追问')], tools1, n0)
check('无头降级路径仍可达(前缀成立+有增量 → 复用)', d2.conv, 'conv-DGR')

console.log('[N19] ctxKeyOf 结构化规范化确定性')
const sysA = [{ role: 'system', text: 'X' }]
const sysB = [{ role: 'developer', text: 'X' }]
const k1 = ctxKeyOf({ sys: sysA, tools: tools1, model: 'm', effort: 'e' })
const k2 = ctxKeyOf({ sys: sysA, tools: tools1, model: 'm', effort: 'e' })
check('同输入两次同 key', k1 === k2, true)
const toolsShuffled = normalizeTools([...tools1, { type: 'function', function: { name: 'aaa', parameters: { type: 'object' } } }])
const toolsShuffled2 = [toolsShuffled[1], toolsShuffled[0]]
check('tools 乱序同 key', ctxKeyOf({ sys: sysA, tools: toolsShuffled, model: 'm', effort: 'e' }) === ctxKeyOf({ sys: sysA, tools: toolsShuffled2, model: 'm', effort: 'e' }), true)
const schemaOrdered = normalizeTools([{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } } }])
const schemaSwapped = normalizeTools([{ type: 'function', function: { name: 'bash', parameters: { required: ['a', 'b'], type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } } } } }])
check('schema 键序不同同 key', ctxKeyOf({ sys: sysA, tools: schemaOrdered, model: 'm', effort: 'e' }) === ctxKeyOf({ sys: sysA, tools: schemaSwapped, model: 'm', effort: 'e' }), true)
check('角色边界进指纹(system vs developer 不同 key)', ctxKeyOf({ sys: sysA, tools: [], model: 'm', effort: 'e' }) === ctxKeyOf({ sys: sysB, tools: [], model: 'm', effort: 'e' }), false)
check('model/effort 进指纹', ctxKeyOf({ sys: sysA, tools: [], model: 'm1', effort: 'e' }) === ctxKeyOf({ sys: sysA, tools: [], model: 'm2', effort: 'e' }), false)

console.log('\n[S1/S6/S14] 端到端: sessionKey 头读取、两任务隔离、头不透传上游')
{
  const AUTH = { type: 'oauth', access: 'test-token', refresh: JSON.stringify({ token: 'test-token', device: 'dev1', guest: false }) }
  const plugin = await ChatglmAuthPlugin({ client: { app: { log: () => {} } } })
  const loader = await plugin.auth.loader(async () => AUTH)
  const realFetch = globalThis.fetch
  let upstream = []
  const okSse = (conv) => new Response(`data: ${JSON.stringify({ conversation_id: conv, status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '好的。' }] }] })}\n\ndata: ${JSON.stringify({ status: 'finish', parts: [{ logic_id: 'p', status: 'finish', content: [{ type: 'text', text: '好的。' }] }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/assistant/stream')) {
      upstream.push({ headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()), body: JSON.parse(init.body) })
      return okSse(`conv-e2e-${upstream.length}`)
    }
    return realFetch(url, init)
  }
  convs.clear(); dirty.clear()
  const body = (sess) => JSON.stringify({ model: 'glm-5.3-flash', messages: [sysMsg(), userMsg('看看项目')] })
  const call = async (sess) => {
    const headers = { 'content-type': 'application/json' }
    if (sess) headers[SESSION_HEADER] = sess
    const res = await loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', { method: 'POST', headers, body: body(sess) })
    await res.text()
  }
  // 任务 A 完成 → 提交 conv-e2e-1(sessionKey=A)
  await call('session-AAA')
  // 任务 B 同前缀同账号, sessionKey 不同 → 不得复用 A 的 conv
  await call('session-BBB')
  check('两任务各自新会话(不串用)', upstream[1].body.conversation_id, '')
  check('A 的 conv 已记录且带 sessionKey', !!convs.get('conv-e2e-1')?.sessionKey, true)
  check('两 sessionKey 摘要不同', convs.get('conv-e2e-1').sessionKey !== convs.get('conv-e2e-2').sessionKey, true)
  // 任务 A 的下一条消息(同 sessionKey) → 复用 A 的 conv 增量
  upstream.length = 0
  await loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'session-AAA' },
    body: JSON.stringify({ model: 'glm-5.3-flash', messages: [sysMsg(), userMsg('看看项目'), { role: 'assistant', content: '好的。' }, userMsg('继续') ] }),
  }).then((r) => r.text())
  check('同 sessionKey 增量复用 A 的 conv', upstream[0].body.conversation_id, 'conv-e2e-1')
  check('增量只补新回合(不含开场白全文)', /继续/.test(upstream[0].body.messages[0].content[0].text) && !/看看项目/.test(upstream[0].body.messages[0].content[0].text), true)
  // 头不透传上游
  check('上游收到的 headers 无会话头', upstream.every((u) => !(SESSION_HEADER in u.headers)), true)
  globalThis.fetch = realFetch
}

console.log('\n[步骤3] 交付状态机: 隔离快照 / dirty / not_sent / 单次提交 (端到端)')
{
  const AUTH = { type: 'oauth', access: 'test-token', refresh: JSON.stringify({ token: 'test-token', device: 'dev1', guest: false }) }
  const plugin = await ChatglmAuthPlugin({ client: { app: { log: () => {} } } })
  const loader = await plugin.auth.loader(async () => AUTH)
  const realFetch = globalThis.fetch
  let script = []
  let sent = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/assistant/stream')) {
      sent.push(JSON.parse(init.body))
      const next = script.shift()
      if (!next) throw new Error('test bug: 上游请求超出脚本')
      if (next instanceof Error) throw next
      return next
    }
    return realFetch(url, init)
  }
  const frame = (o) => `data: ${JSON.stringify(o)}\n\n`
  const okResp = (conv, text = '好的。') => new Response(
    frame({ conversation_id: conv, status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text }] }] }) +
    frame({ status: 'finish', parts: [{ logic_id: 'p', status: 'finish', content: [{ type: 'text', text }] }] }),
    { headers: { 'content-type': 'text/event-stream' } })
  const call = async (messages, signal, sess = 'sess-Z') => {
    const res = await loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: sess },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages }), signal,
    })
    return { status: res.status, body: await res.text() }
  }
  const M1 = [sysMsg(), userMsg('看看目录')]
  const M2 = [sysMsg(), userMsg('看看目录'), { role: 'assistant', content: '好的。' }, userMsg('再读一下')]
  const M3 = [...M2, { role: 'assistant', content: '好的。' }, userMsg('第三问')]

  // 建立会话: 完成 → 提交 conv-C1
  convs.clear(); dirty.clear()
  script = [okResp('conv-C1')]
  await call(M1)
  check('前置: 完成轮已提交', convs.has('conv-C1'), true)

  // T-N16: 复用请求在 fetch 发出前被取消 → not_sent → conv 不动, 后续仍可复用
  {
    const ac = new AbortController(); ac.abort()
    sent.length = 0
    const r = await call(M2, ac.signal)
    check('not_sent: 返回 499', r.status, 499)
    check('not_sent: fetch 未发出', sent.length, 0)
    check('not_sent: conv-C1 未被隔离', convs.get('conv-C1').quarantined, false)
    script = [okResp('conv-C1')]
    sent.length = 0
    await call(M2)
    check('not_sent 后仍可增量复用', sent[0].conversation_id, 'conv-C1')
  }

  // T-N2: 复用请求 fetch 网络抛错(无新 conv id) → 隔离快照 conv-C1
  {
    script = [new Error('连接被重置'), new Error('连接被重置')] // 两次 attempt 都失败
    const r = await call(M3)
    check('建流失败 → 502', r.status, 502)
    check('T-N2: 快照 conv-C1 被隔离', convs.get('conv-C1').quarantined, true)
    check('隔离原因', convs.get('conv-C1').qreason, 'delivery-unknown')
    // 后续同历史请求: 不复用隔离的 C1, 全史内联新建
    script = [okResp('conv-C2')]
    sent.length = 0
    await call(M3)
    check('隔离后不复用(内联新建)', sent[0].conversation_id, '')
    check('内联文本含完整历史', /看看目录/.test(sent[0].messages[0].content[0].text) && /第三问/.test(sent[0].messages[0].content[0].text), true)
  }

  // T-N11: 隔离的 conv 不被迟到的 completed 复活(remember 棘轮)
  {
    script = [okResp('conv-C1')] // 响应声称是 C1 的完成轮
    await call([...M3, { role: 'assistant', content: '好的。' }, userMsg('换个问法')], undefined, 'sess-Z')
    check('迟到 completed 不复活隔离记录', convs.get('conv-C1').quarantined, true)
  }

  // T-N3: 新建请求 EOF 无完成帧(曾见过响应 conv id) → 不写映射, id 入 dirty
  {
    convs.clear(); dirty.clear()
    script = [new Response(frame({ conversation_id: 'conv-D3', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '半句' }] }] }), { headers: { 'content-type': 'text/event-stream' } })]
    const r = await call(M1)
    check('T-N3: 无完成帧 EOF → 502', r.status, 502)
    check('见过的 id 不入映射', convs.has('conv-D3'), false)
    check('见过的 id 入 dirty', dirty.has('conv-D3'), true)
    // dirty 永不参与匹配: 再来同请求不得复用 conv-D3
    script = [okResp('conv-D4')]
    sent.length = 0
    await call(M1)
    check('dirty 不参与匹配(新建而非复用)', sent[0].conversation_id, '')
  }

  // T-N15: 复用请求的响应回了不同的新 id 后报错 → 隔离的是快照 E1(不依赖响应), 新 id 不入映射
  {
    convs.clear(); dirty.clear()
    script = [okResp('conv-E1')]
    await call(M1)
    script = [new Response(
      frame({ conversation_id: 'conv-E9', status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '甲' }] }] }) +
      frame({ status: 'error', last_error: { message: 'boom' } }),
      { headers: { 'content-type': 'text/event-stream' } })]
    await call(M2)
    check('T-N15: 隔离的是快照 E1 而非响应 id E9', convs.get('conv-E1')?.quarantined, true)
    check('复用请求不把响应新 id 写进映射', convs.has('conv-E9'), false)
  }

  // T-N12: 多阶段失败只处置一次(建流两次都抛 → 单次 settle, 无二次崩溃)
  {
    convs.clear(); dirty.clear()
    script = [okResp('conv-F1')]
    await call(M1)
    const tsBefore = convs.get('conv-F1').ts
    script = [new Error('reset'), new Error('reset')]
    const r = await call(M2)
    check('T-N12: 双阶段失败仍只产出一个 502', r.status, 502)
    check('隔离只发生一次(ts 已置位)', convs.get('conv-F1').quarantined && convs.get('conv-F1').ts >= tsBefore, true)
  }
  globalThis.fetch = realFetch
}

console.log('\n[步骤4] 并发: busy 全生命周期 / 多候选重建 / 隔离不被他人解除 (端到端)')
{
  const AUTH = { type: 'oauth', access: 'test-token', refresh: JSON.stringify({ token: 'test-token', device: 'dev1', guest: false }) }
  const plugin = await ChatglmAuthPlugin({ client: { app: { log: () => {} } } })
  const loader = await plugin.auth.loader(async () => AUTH)
  const realFetch = globalThis.fetch
  let script = []
  let sent = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/assistant/stream')) {
      sent.push(JSON.parse(init.body))
      const next = script.shift()
      if (!next) throw new Error('test bug: 上游请求超出脚本')
      if (next instanceof Error) throw next
      return next
    }
    return realFetch(url, init)
  }
  const frame = (o) => `data: ${JSON.stringify(o)}\n\n`
  const okResp = (conv, text = '好的。') => new Response(
    frame({ conversation_id: conv, status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text }] }] }) +
    frame({ status: 'finish', parts: [{ logic_id: 'p', status: 'finish', content: [{ type: 'text', text }] }] }),
    { headers: { 'content-type': 'text/event-stream' } })
  // 可控流: 手动推 init 帧与 finish 帧, 精确编排「A 还在读时 B 到达」的时序
  const controllable = (conv) => {
    let ctrl
    const rs = new ReadableStream({ start(c) { ctrl = c } })
    const resp = new Response(rs, { headers: { 'content-type': 'text/event-stream' } })
    return {
      resp,
      init() { ctrl.enqueue(new TextEncoder().encode(frame({ conversation_id: conv, status: 'init', parts: [{ logic_id: 'p', status: 'init', content: [{ type: 'text', text: '好的' }] }] }))) },
      finish() { ctrl.enqueue(new TextEncoder().encode(frame({ status: 'finish', parts: [{ logic_id: 'p', status: 'finish', content: [{ type: 'text', text: '好的。' }] }] }))); ctrl.close() },
    }
  }
  const call = async (messages, sess = 'sess-W') => {
    const res = await loader.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: sess },
      body: JSON.stringify({ model: 'glm-5.3-flash', stream: true, messages }),
    })
    return res.text() // 消费到流关闭
  }
  const tick = () => new Promise((r) => setImmediate(r))
  const waitFor = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('waitFor 超时'); await tick() } }
  const M1 = [sysMsg(), userMsg('看看目录')]
  const M2 = [sysMsg(), userMsg('看看目录'), { role: 'assistant', content: '好的。' }, userMsg('再读一下')]
  const M3 = [...M2, { role: 'assistant', content: '好的。' }, userMsg('第三问')]

  // T-N8 + T-N4 + T-N6: A 复用 C1 在途 → busy 挡住 B(重建 C2) → 都完成后第三请求见双候选 → 重建权威
  convs.clear(); dirty.clear()
  script = [okResp('conv-C1')]
  await call(M1) // 建立: C1.sig=[h1]
  check('前置: C1 已提交', convs.get('conv-C1').sig.length, 1)

  const ctlA = controllable('conv-C1')
  script = [ctlA.resp]
  const pA = call(M2) // A: 复用 C1, 流挂起
  await waitFor(() => convs.get('conv-C1').busy === 1)
  check('T-N8: 流在途时 busy=1', convs.get('conv-C1').busy, 1)
  ctlA.init()
  await waitFor(() => convs.get('conv-C1').busy === 1) // init 帧到达后仍不得归零
  check('T-N8: 收到 init 帧 busy 仍不归零', convs.get('conv-C1').busy, 1)

  sent.length = 0
  const ctlB = controllable('conv-C2')
  script = [ctlB.resp] // 必须在发起前入队: loader.fetch 同步取脚本
  const pB = call(M3) // B: 同 sessionKey, C1 busy → 拒绝复用, 重建
  await waitFor(() => sent.length === 1)
  check('T-N8: B 见 busy 不复用(新建)', sent[0].conversation_id, '')
  ctlB.init()

  // 收尾 A、B: 都正常完成
  ctlA.finish()
  await pA
  check('T-N4: A 完成后 busy 归零', convs.get('conv-C1').busy, 0)
  check('T-N4: A 提交增量 sig', convs.get('conv-C1').sig.length, 2)
  ctlB.finish()
  await pB
  check('T-N4: B 的 C2 已提交', convs.get('conv-C2')?.sig.length >= 1, true)

  // 第三请求: C1 与 C2 都是其前缀 → 多候选 → 不比较, 重建权威, 双退役
  sent.length = 0
  script = [okResp('conv-C3')]
  await call(M3)
  check('T-N6: 多候选不任意选择(第三请求新建)', sent[0].conversation_id, '')
  check('T-N4: 旧候选双双退役 branched', [convs.get('conv-C1')?.retired, convs.get('conv-C2')?.retired], ['branched', 'branched'])
  // 第四请求: 新权威 C3 正常增量复用
  sent.length = 0
  script = [okResp('conv-C3')]
  await call([...M3, { role: 'assistant', content: '好的。' }, userMsg('第四问')])
  check('T-N4: 权威会话后续正常增量', sent[0].conversation_id, 'conv-C3')

  // T-N10: 隔离不被其他请求解除
  convs.clear(); dirty.clear()
  script = [okResp('conv-D1')]
  await call(M1)
  script = [new Error('reset'), new Error('reset')]
  await call(M2) // 失败 → D1 隔离
  check('前置: D1 已隔离', convs.get('conv-D1').quarantined, true)
  const tsD1 = convs.get('conv-D1').ts
  script = [okResp('conv-D2')]
  await call(M2) // 另一请求在新会话上成功
  check('T-N10: 他人完成不解除 D1 隔离', convs.get('conv-D1').quarantined && convs.get('conv-D1').ts === tsD1, true)
  check('T-N10: 新会话 D2 正常可用', convs.get('conv-D2').quarantined, false)
  globalThis.fetch = realFetch
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
