// 测 browserFlow 的轮询判定逻辑: 注入 cookie 源, 不依赖真实浏览器/扫码
import { _internal } from './index.mjs'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const mkTok = (payload) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`
const realTok = mkTok({ uid: 'deadbeef01234567', is_guest: false, exp: Math.floor(Date.now() / 1000) + 7200 })
const guestTok = mkTok({ uid: 'guest1234567890ab', is_guest: true, exp: Math.floor(Date.now() / 1000) + 7200 })

const cg = (name, value) => ({ name, value, domain: 'chatglm.cn', path: '/' })
let pass = 0, fail = 0
const check = (label, cond) => { if (cond) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label) } }

// 1) 注入游客 token → 一直不满足 → 超时 failed
{
  const flow = _internal.browserFlow(() => {}, { readCookies: async () => [cg('chatglm_token', guestTok)], })
  process.env.CHATGLM_LOGIN_TIMEOUT_MS = '3000'; process.env.CHATGLM_LOGIN_POLL_MS = '300'
  const out = await flow.callback()
  console.log('[游客应被拒]')
  check('type=failed', out.type === 'failed')
  check('含超时文案', /超时/.test(out.error || ''))
}

// 2) 前几轮游客/空, 第 3 轮出现真实 token → success
{
  const seq = [[], [cg('chatglm_token', guestTok)], [cg('chatglm_token', realTok), cg('chatglm_refresh_token', 'rt-1')]]
  let i = 0
  const flow = _internal.browserFlow(() => {}, { readCookies: async () => seq[Math.min(i++, 2)] })
  process.env.CHATGLM_LOGIN_TIMEOUT_MS = '5000'; process.env.CHATGLM_LOGIN_POLL_MS = '200'
  const out = await flow.callback()
  console.log('[真实 token 应成功]')
  check('type=success', out.type === 'success')
  check('access=真实 token', out.access === realTok)
  check('accountId 带 uid 后 6 位', out.accountId === 'chatglm#234567')
  const st = JSON.parse(out.refresh || '{}')
  check('refresh 里 guest=false', st.guest === false)
  check('refresh 里带 refresh_token', st.refresh === 'rt-1')
  check('expires 来自 JWT exp', out.expires === (Math.floor(Date.now() / 1000) + 7200) * 1000 || Math.abs(out.expires - (Math.floor(Date.now() / 1000) + 7200) * 1000) < 5000)
}

// 3) 域名不匹配的 cookie 不算
{
  const flow = _internal.browserFlow(() => {}, { readCookies: async () => [{ name: 'chatglm_token', value: realTok, domain: 'evil.com' }] })
  process.env.CHATGLM_LOGIN_TIMEOUT_MS = '1500'; process.env.CHATGLM_LOGIN_POLL_MS = '300'
  const out = await flow.callback()
  console.log('[域名校验]')
  check('非 chatglm.cn 的 cookie 被忽略 → failed', out.type === 'failed')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
