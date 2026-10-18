// magpie-chatglm-auth —— 智谱清言 (chatglm.cn) magpie/OpenCode 供应商插件
//
// 协议(逆向自 chatglm.cn 网页端, 2026-10 实测验证):
//   x-sign = md5(`${x-timestamp}-${x-nonce}-<salt>`);  x-timestamp 为 Date.now() 做 Luhn
//   校验位替换(倒数第 2 位 = 其余数字之和 %10); x-nonce = uuidv4 去横杠。签名不含请求体。
//   游客登录 POST /chatglm/user-api/guest/access → token(约 2h; 游客无法 refresh)
//   模型     GET  /chatglm/agent-api/operation/detail?tag=available_models
//   对话     POST /chatglm/backend-api/assistant/stream → SSE:
//            part 的 content 帧分两种 —— status:init 为增量, status:finish 为该 part 全量;
//            会话 id 在首帧即返回; 多轮必须走 conversation_id(实测多条消息内联会被忽略)。
//
// 工具调用: 清言协议没有接收外部工具定义的字段(messages 只认 user/assistant 文本),
// 所以走「提示词协议 + 出站解析」: 工具定义注入首条消息, 要求模型只吐一个 JSON;
// 解析回来翻译成 OpenAI tool_calls。做法参考 HelloGML/GLM-Free-API, 见下方"工具调用"段。
//
// 登录方式:
//   1. oauth「浏览器授权」: 插件启动专用 Chrome/Edge 打开清言, 用户登录(扫码/手机),
//      插件经 CDP(Storage.getCookies) 轮询到真实账号 token 即完成 —— 绕开 cookie 文件锁与加密。
//   2. oauth「游客模式」: 一键领 guest token(额度小)。
//   3. api「粘贴 Cookie」: 手动贴浏览器 cookie 整串。
// magpie 约定: 模块导出的每个【函数】都会被当作插件调用, 辅助函数不导出。

import crypto from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PROVIDER = "chatglm"
const LABEL = "智谱清言"
const HOST = "https://chatglm.cn"
const API = `${HOST}/chatglm` // 所有业务端点的前缀; 漏了它会命中 SPA 首页返回 HTML
const ASSISTANT_ID = "65940acff94777010aa6b796" // 清言默认助手(普通对话)
const SIGN_SALT = "8a1317a7468aa3ad86e997d08f3f31cb"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
const TOKEN_TTL = 2 * 3600_000

const FALLBACK_MODELS = [
  { id: "glm-5.3", name: "GLM-5.3" },
  { id: "glm-5.3-flash", name: "GLM-Flash" },
]

// 网页协议不暴露上限(available_models 里相应字段为 null, 前端 bundle 亦无常量),
// 按 models.dev 官方目录声明: GLM-5.3 / GLM-5.3-Flash = 1M 上下文 / 131072 输出。
// 输入侧实测 80 万字不截断; 输出模型自己不肯写长文, 那是网页版习惯, 非协议限制。
const LIMIT = { context: 1_000_000, output: 131_072 }

// 清言的推理档位(抓包 available_models + 网页选择器): 快速/深度/极致 = ""/thinking/deep_thinking
// magpie 的 variants 键即档位名, 会渲染成模型设置里那排勾选框; 值必须带 reasoningEffort,
// 否则网关不会往请求体里放字段(社区插件 opencode-qoder-auth/grok-auth 同此约定)。
const EFFORTS = ["low", "high", "max"]
const VARIANTS = {
  low: { reasoningEffort: "low" },
  high: { reasoningEffort: "high" },
  max: { reasoningEffort: "max" },
}
// magpie 档位 → 清言请求 meta_data 映射(网页端实测: 极致=deep_thinking+max)
const EFFORT_TO_META = {
  low: { chat_mode: "fast", reasoning_effort: "" },
  high: { chat_mode: "deep_thinking", reasoning_effort: "high" },
  max: { chat_mode: "deep_thinking", reasoning_effort: "max" },
}
const DEFAULT_EFFORT = "low" // 客户端没选档位时用「快速」: deep_thinking 首字动辄 70s+, agent 循环扛不住

// ---- 签名 --------------------------------------------------------------------------

const uuid32 = () => crypto.randomUUID().replace(/-/g, "")
const md5hex = (s) => crypto.createHash("md5").update(s).digest("hex")

// 毫秒时间戳倒数第 2 位换成「其余数字之和 %10」(即前端 j() 的等价实现)
function luhnStamp(ms) {
  const A = String(ms)
  const dig = A.split("").map(Number)
  const sum = dig.reduce((a, b) => a + b, 0) - dig[A.length - 2]
  return A.substring(0, A.length - 2) + (sum % 10) + A.substring(A.length - 1)
}

function signedHeaders({ device, token = "", json = false, sse = false }) {
  const ts = luhnStamp(Date.now())
  const nonce = uuid32()
  return {
    "app-name": "chatglm",
    "x-app-platform": "pc",
    "x-app-version": "0.0.1",
    "x-app-fr": "default",
    "x-lang": "zh",
    "x-device-id": device,
    "x-request-id": uuid32(),
    "x-timestamp": ts,
    "x-nonce": nonce,
    "x-sign": md5hex(`${ts}-${nonce}-${SIGN_SALT}`),
    origin: HOST,
    referer: `${HOST}/`,
    "user-agent": UA,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(json ? { "content-type": "application/json" } : {}),
    ...(sse ? { accept: "text/event-stream" } : {}),
  }
}

// ---- 凭据 --------------------------------------------------------------------------

function parseCookies(raw) {
  const out = {}
  for (const part of String(raw || "").split(/;\s*/)) {
    const i = part.indexOf("=")
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

// auth(api: cookie 整串或裸 chatglm_token / oauth) → { token, refresh, device, guest } | null
function credsOf(auth) {
  if (!auth) return null
  if (auth.type === "oauth") {
    let s = {}
    try { s = JSON.parse(auth.refresh || "{}") } catch {}
    const token = auth.access || s.token
    if (!token) return null
    return { token, refresh: s.refresh || "", device: s.device || uuid32(), guest: !!s.guest }
  }
  if (auth.type === "api") {
    const key = String(auth.key || "").trim()
    if (!key) return null
    if (key.includes("=")) {
      const c = parseCookies(key)
      if (!c["chatglm_token"]) return null
      return { token: c["chatglm_token"], refresh: c["chatglm_refresh_token"] || "", device: uuid32(), guest: false }
    }
    return { token: key, refresh: "", device: uuid32(), guest: false }
  }
  return null
}

async function guestAccess(device) {
  const res = await fetch(`${HOST}/chatglm/user-api/guest/access`, {
    method: "POST", headers: signedHeaders({ device, json: true }), body: "",
  })
  const j = await res.json().catch(() => null)
  if (!res.ok || j?.status !== 0 || !j?.result?.access_token) throw new Error(`清言游客登录失败 HTTP ${res.status} ${j?.message ?? ""}`)
  return j.result
}

// 游客实测 40104 不可续期; 真实账号可用
// 注意: /user/refresh 的 Bearer 要放 refresh_token(网页端与 HelloGML 均如此),
// 拿 access_token 去换是不会续期的。
async function apiRefresh(creds) {
  const bearer = creds?.refresh || creds?.token
  if (!bearer || creds.guest) return null
  const res = await fetch(`${HOST}/chatglm/user-api/user/refresh`, {
    method: "POST", headers: signedHeaders({ device: creds.device, token: bearer }), body: "",
  }).catch(() => null)
  const j = res && (await res.json().catch(() => null))
  if (!res?.ok || j?.status !== 0 || !j?.result?.access_token) return null
  return j.result
}

async function listModels(creds) {
  const res = await fetch(`${HOST}/chatglm/agent-api/operation/detail?tag=available_models`, {
    headers: signedHeaders({ device: creds.device, token: creds.token }),
  })
  if (!res.ok) throw new Error(`models HTTP ${res.status}`)
  const j = await res.json().catch(() => null)
  return Array.isArray(j?.result?.models) ? j.result.models : []
}

async function userInfo(creds) {
  try {
    const res = await fetch(`${API}/user-api/user/info`, {
      headers: signedHeaders({ device: creds.device, token: creds.token }),
    })
    const ct = res.headers.get("content-type") || ""
    if (!ct.includes("json")) return { error: "not-json" } // 风控 HTML
    const j = await res.json().catch(() => null)
    if (j?.result) return j
    if (j?.status === 40103 || res.status === 401 || res.status === 403) return { error: "needs-login" }
    return { error: "no-data" }
  } catch {
    return { error: "fetch-failed" }
  }
}

async function scoreActivity(creds) {
  const res = await fetch(`${API}/member-api/member/score_activity_status`, {
    headers: signedHeaders({ device: creds.device, token: creds.token }),
  })
  return res.json().catch(() => null)
}

async function memberInfo(creds) {
  const res = await fetch(`${API}/member-api/member/member_info`, {
    headers: signedHeaders({ device: creds.device, token: creds.token }),
  })
  if (!res.ok) return null
  const ct = res.headers.get("content-type") || ""
  if (!ct.includes("json")) return null // 风控 HTML 页
  return res.json().catch(() => null)
}

// 每日登录积分: 领取一次并回报结果(幂等, 已领服务端会拒)。只在真实账号 usage 时顺带做。
async function claimDaily(creds) {
  try {
    const res = await fetch(`${API}/member-api/member/daily_login_score`, {
      method: "POST", headers: signedHeaders({ device: creds.device, token: creds.token }), body: "",
    })
    const j = await res.json().catch(() => null)
    return j // { status, message, result }
  } catch {
    return null
  }
}

// 清言积分用量 → magpie usage 卡片。真实账号才有数据(游客全部 40103)。
async function usageOf(creds) {
  const ui = await userInfo(creds)
  const r = ui?.result
  if (!r) {
    // 区分: 风控(非 JSON/HTML)、token 过期(40103)、其它
    const e = ui?.error
    if (e === "not-json") return { error: "清言风控限流中, 稍后再看", windows: [], signIn: "kept" }
    if (e === "needs-login") return { error: "登录已过期, 请重新登录", windows: [], signIn: "expired" }
    return { error: "user/info 无数据", windows: [], signIn: "kept" }
  }
  if (r.is_guest) return { plan: "游客", user: r.nickname || "guest", windows: [], signIn: "kept" }
  const out = { user: r.nickname || r.username || "", windows: [], signIn: "kept" }
  // member_info 是积分/等级的真正来源(前端 leftScore getter 即读它)
  let mi = {}
  try {
    const m = await memberInfo(creds)
    mi = m?.result || m || {}
  } catch {}
  if (!mi.left_score && r.member_info) mi = r.member_info // 回落 user/info 内联

  // plan: score_rule 是人话(如「免费用户，登录赠送200积分/天」), 优先它; 否则用等级
  if (typeof mi.score_rule === "string" && mi.score_rule.trim()) out.plan = mi.score_rule.trim()
  else if (mi.level) out.plan = String(mi.level)
  else if (mi.is_member) out.plan = "会员"

  // 积分余额: left_score 以「分」为单位(如 100050 表示 1000.50), 前端除以 100
  if (typeof mi.left_score === "number") {
    const pts = (mi.left_score / 100).toFixed(2).replace(/\.00$/, "")
    out.balance = `${pts} 积分`
    out.windows.push({ name: "积分余额", used: 0, display: `${pts} 积分`, aside: true })
  }
  // Token 余量: token_left_percent 是字符串 "100%"
  const tlp = typeof mi.token_left_percent === "string" ? parseInt(mi.token_left_percent, 10) : mi.token_left_percent
  if (typeof tlp === "number" && !Number.isNaN(tlp)) {
    out.windows.push({ name: "Token 余量", used: 100 - tlp, display: `剩 ${tlp}%` })
  }
  // 每日登录积分: 领一次, 成功(或已领)在卡片上标注
  const dl = await claimDaily(creds)
  if (dl && dl.status === 0) out.windows.push({ name: "每日登录", used: 0, display: "+200 已领", aside: true })
  else if (dl && /已|重复|limit|today/i.test(String(dl.message || ""))) out.windows.push({ name: "每日登录", used: 0, display: "今日已领", aside: true })
  // 活动积分: status>0 才是真在活动(-2=无活动)
  try {
    const sa = await scoreActivity(creds)
    const s = sa?.result
    if (s && s.status > 0 && s.target_score > 0) {
      out.windows.push({
        name: s.title || "活动积分",
        used: Math.max(0, 100 - Math.round(((s.target_score - (s.current_score || 0)) / s.target_score) * 100)),
        display: `${s.current_score || 0} / ${s.target_score}`,
      })
    }
  } catch {}
  return out
}

// ---- 浏览器授权登录(CDP) ----------------------------------------------------------
// 插件自己启动一个带调试端口的 Chrome/Edge(专用 profile, 不碰用户日常浏览器),
// 打开 chatglm.cn 让用户登录; 浏览器开着时 cookie 数据库是独占锁的(实测 cp 都失败),
// 所以不走文件, 而是经 CDP 的浏览器级 Storage.getCookies 直接读内存 —— 绕开锁与加密。
// 轮询到「非游客」的 chatglm_token(JWT payload 的 is_guest 不为 true)即登录成功。

const BROWSER_TIMEOUT_MS = () => Number(process.env.CHATGLM_LOGIN_TIMEOUT_MS || 0) || 5 * 60_000
const POLL_MS = () => Number(process.env.CHATGLM_LOGIN_POLL_MS || 0) || 2000

function findBrowser() {
  const win = process.platform === "win32"
  const cands = []
  if (win) {
    // 注册表 App Paths 优先
    for (const exe of ["chrome.exe", "msedge.exe"]) {
      for (const hive of ["HKCU", "HKLM"]) {
        try {
          const out = execFileSync("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          const m = out.match(/REG_SZ\s+(.+chrome\.exe|.+msedge\.exe)/i)
          if (m) cands.push(m[1].trim())
        } catch {}
      }
    }
    const PF = process.env["PROGRAMFILES"] || "C:\\Program Files"
    const PF86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"
    const LD = process.env.LOCALAPPDATA || ""
    cands.push(
      path.join(PF, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(PF86, "Google", "Chrome", "Application", "chrome.exe"),
      LD && path.join(LD, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(PF86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(PF, "Microsoft", "Edge", "Application", "msedge.exe"),
    )
  } else if (process.platform === "darwin") {
    cands.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
  } else {
    cands.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge")
  }
  return cands.find((p) => p && fs.existsSync(p)) || null
}

function jwtIsGuest(token) {
  try {
    const b64 = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    const p = JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
    return { guest: p.is_guest === true, uid: p.uid || p.sub || "", exp: (p.exp || 0) * 1000 }
  } catch {
    return { guest: true, uid: "", exp: 0 } // 解不出按游客等, 宁可多等不误收
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function browserFlow(log, opts = {}) {
  const exe = opts.exe ?? findBrowser()
  const state = { exe, child: null, port: 0, profile: "", ws: null }
  const cleanup = () => {
    try { state.ws && state.ws.readyState === 1 && state.ws.close() } catch {}
    state.ws = null
    if (state.child && state.child.pid != null) {
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(state.child.pid), "/T", "/F"], { stdio: "ignore" })
        else state.child.kill("SIGKILL")
      } catch {}
    }
    state.child = null
  }

  const start = async () => {
    if (!state.exe) throw new Error("找不到 Chrome/Edge —— 请改用「粘贴 Cookie」方式登录")
    state.port = 9300 + Math.floor(Math.random() * 500)
    state.profile = path.join(process.env.LOCALAPPDATA || os.homedir(), "magpie-chatglm-auth", "browser")
    fs.mkdirSync(state.profile, { recursive: true })
    state.child = spawn(state.exe, [
      `--remote-debugging-port=${state.port}`,
      `--user-data-dir=${state.profile}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--window-size=520,760",
      `${HOST}/`,
    ], { stdio: "ignore", detached: false })
    let version = null
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      try { version = await (await fetch(`http://127.0.0.1:${state.port}/json/version`)).json(); break } catch {}
      if (state.child.exitCode != null) break
    }
    if (!version) throw new Error("调试端口没起来 —— 若已开着一个同 profile 的窗口, 关掉它再重试")
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP WebSocket 连接失败")) })
    state.ws = ws
  }

  // 浏览器级 Storage.getCookies: 不需要 attach 任何 target
  const readCookies = () => new Promise((res) => {
    const ws = state.ws
    if (!ws || ws.readyState !== 1) return res([])
    const mid = "cdp-" + crypto.randomBytes(8).toString("hex")
    const onMsg = (e) => {
      let m
      try { m = JSON.parse(e.data) } catch { return }
      if (m.id === mid) {
        ws.removeEventListener("message", onMsg)
        res(m.result?.cookies || [])
      }
    }
    ws.addEventListener("message", onMsg)
    ws.send(JSON.stringify({ id: mid, method: "Storage.getCookies" }))
    setTimeout(() => { ws.removeEventListener("message", onMsg); res([]) }, 8000)
  })

  return {
    url: "", // 空 url: magpie 不再另开系统浏览器, 登录窗口由本插件自己拉起
    instructions: "已打开智谱清言登录窗口 —— 扫码或手机验证码登录, 完成后自动继续。(窗口没出现就检查任务栏)",
    method: "auto",
    async callback() {
      const deadline = Date.now() + BROWSER_TIMEOUT_MS()
      const poll = opts.readCookies || readCookies // 测试可注入
      try {
        if (!opts.readCookies) await start()
        while (Date.now() < deadline) {
          const cookies = await poll()
          const tok = cookies.find((c) => c.name === "chatglm_token" && /(^|\.)chatglm\.cn$/.test(c.domain))?.value
          if (tok) {
            const info = jwtIsGuest(tok)
            if (!info.guest) {
              const rt = cookies.find((c) => c.name === "chatglm_refresh_token")?.value || ""
              const device = uuid32()
              cleanup()
              return {
                type: "success",
                access: tok,
                refresh: JSON.stringify({ token: tok, refresh: rt, device, guest: false }),
                expires: info.exp || Date.now() + TOKEN_TTL,
                accountId: info.uid ? `chatglm#${String(info.uid).slice(-6)}` : undefined,
              }
            }
          }
          await sleep(POLL_MS())
        }
        cleanup()
        return { type: "failed", error: "等待登录超时(5 分钟)。可重试, 或改用「粘贴 Cookie」" }
      } catch (e) {
        cleanup()
        const msg = String(e?.message ?? e)
        log(`browser flow failed: ${msg}`)
        return { type: "failed", error: msg }
      }
    },
  }
}

// ---- OpenAI <-> 清言 ----------------------------------------------------------------

const textOf = (content) =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("")
  : ""

// 清言 SSE 不返回 usage, 网关按 0 记账会显示「还没用过」。这里估算: CJK 1 字 ≈ 1 token,
// 其余 4 字符 ≈ 1 token(粗略但够路由/统计用)。
function estimateTokens(s) {
  let cjk = 0, other = 0
  for (const ch of String(s || "")) {
    const c = ch.codePointAt(0)
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x2fa1f)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

// 会话映射: 清言 conv id → { sig: 已发出的「我方回合」指纹, ctxKey: 上下文指纹, busy: 在途 }。
// sessions: 客户端会话键(账号+会话头) → 清言 conv id, 作为复用的主隔离依据。
// 上下文由清言服务端保存; 并发/跨会话/上下文变化一律不复用(见 translateRequest)。
const convs = new Map()
const sessions = new Map()
const CONV_MAX = 48

function remember(conv, sig, meta = {}) {
  if (!conv || !Array.isArray(sig)) return
  const prev = convs.get(conv) || {}
  convs.delete(conv) // 重新插入, 保持 LRU 顺序
  convs.set(conv, { sig, ctxKey: meta.ctxKey ?? prev.ctxKey, acct: meta.acct ?? prev.acct, busy: !!meta.busy })
  if (meta.sessionKey) sessions.set(meta.sessionKey, conv)
  while (convs.size > CONV_MAX) {
    const [old] = convs.entries().next().value
    convs.delete(old)
    for (const [k, v] of sessions) if (v === old) sessions.delete(k)
  }
}

// 并发守卫: 同一清言会话在途时, 第二个请求禁止复用(避免交叉写入服务端上下文)
function setBusy(conv, on) {
  const rec = convs.get(conv)
  if (rec) rec.busy = !!on
}

// ---- 工具调用 -----------------------------------------------------------------------
// 清言协议不接收外部工具定义(messages 只认 user/assistant 文本), 所以工具走「提示词协议」:
// 工具清单与输出格式注入首条消息, 出站时再把模型吐的 JSON 抠回来翻成 OpenAI tool_calls。
// 解析额外兼容 GLM 原生的 <tool_call> 标签, 模型不守规矩时也救得回来。

const TOOL_PROTOCOL = (tools) => `# 工具调用协议(必须严格遵守)
你可以使用下面列出的工具。需要工具时, 只输出一个 JSON 对象 —— 不要解释、不要 markdown 围栏、前后不要任何文字:
{"tool_calls":[{"name":"工具名","arguments":{"参数名":值}}]}
- 一次要调用多个工具, 就把多个对象放进同一个 tool_calls 数组。
- arguments 必须是合法 JSON: 双引号、不要注释、不要尾逗号。
- 不需要工具时用自然语言正常回答, 不要输出这个 JSON。
- 工具结果会以「工具执行结果」的形式发回给你: 还需要信息就继续按协议调用, 否则给出最终回答。
- 不要臆造清单外的工具, 也不要把调用写成代码块。
- 绝对不要只写「继续/我来做/下面开始…」这类引导语就停下: 要么立刻输出上面的 JSON, 要么用完整句子给出最终回答。
- 按工具的描述选工具: 本地文件、shell 命令一律用对应的本地工具, 描述带「网页/浏览/打开链接」的工具不要拿来执行命令或读文件。
- 上一个调用报错后绝不允许原样重发: 先说清错在哪, 换参数或换工具再试。
- 调用 JSON 只出现在正式回复里 —— 思考/草稿里写的调用不会被执行, 不要把真正的调用写进思考。
- arguments 的键名逐字符照抄参数 schema(该下划线就下划线, 不要自创 camelCase 简写); required 字段一个不能少、不能留空。

## 可用工具
${tools.map((t) => `### ${t.function.name}\n${t.function.description || "(无描述)"}\n参数 schema: ${JSON.stringify(t.function.parameters)}`).join("\n\n")}

## 示例
用户: 现在几点了?
回答: {"tool_calls":[{"name":"get_time","arguments":{"timezone":"Asia/Shanghai"}}]}

用户: 你好呀
回答: 你好!有什么可以帮你的?`

// agent 循环里每一轮都提醒一次: 清言侧历史很长, 协议容易被冲淡
const TOOL_REMINDER = `# 提示
还需要工具就继续按协议输出 {"tool_calls":[...]};任务已完成就用自然语言给出最终回答。`

// 模型偶尔只写一句引导语(常以冒号结尾)就结束这一轮 —— 清言侧 status=finish, 网关侧看不到任何
// 工具调用, agent 循环就地停住, 界面上就只剩「…一次做完（加常量、替换两处、升版本）：」。
// 这一类输出既没给调用也没给结论, 判定为「空转」并补一轮续写。
const STALL_MAX_LEN = 240
const STALL_TAIL = /(?:[:：,，、]|\.{2,}|…|——|—|-)\s*$/
const SENTENCE_END = /[。！？!?~～.”』」）)]\s*$/
// 模型退化时会原地打转狂吐(实测一次 50 万字 / 上万帧), 超过这个量就没必要再收了
const MAX_OUTPUT_CHARS = 300_000

function looksStalled(text) {
  const t = String(text || "").trim()
  if (!t) return true
  if (t.length > STALL_MAX_LEN) return false
  if (TOOL_MARK.test(t)) return false // 写了一半的调用走另一条路径
  if (STALL_TAIL.test(t)) return true // 冒号/逗号/破折号收尾: 话没说完
  return !SENTENCE_END.test(t) && t.length <= 120 // 没有句末标点的短句: 多半也只是铺垫
}

// 续写轮: 把「刚才只说了半句」明确指出来, 要求这一轮给出 JSON 或完整回答
const TOOL_NUDGE = `# 注意
你上一条回复只有一句引导语就结束了, 既没有工具调用也不是完整回答。
这一轮必须二选一: 直接输出 {"tool_calls":[...]} 开始执行, 或者用完整的句子给出最终结论。不要再写引导语。`

// 调用被写坏(JSON 不合规/被截断)时的续写轮: 明确要求重发, 并强调换行必须转义
const TOOL_NUDGE_BROKEN = `# 注意
你上一条回复里的工具调用 JSON 不完整或不合法(常见原因: 字符串里直接写了换行, 或输出被截断), 无法执行。
请重新完整输出一次: 所有参数值都在同一行内, 代码里的换行写成 \\n(反斜杠 + n), 不要用真实换行。
格式: {"tool_calls":[{"name":"工具名","arguments":{...}}]}`

// 缺必填参数/键名不对时的续写轮: 点名 required 与键名纪律
const TOOL_NUDGE_ARGS = `# 注意
你上一条回复里的工具调用缺少必填参数, 或键名和参数 schema 对不上(比如该写 file_path 却写成 filePath)。
请重新完整输出: arguments 的键名逐字符照抄各工具的参数 schema(该下划线就下划线), required 字段一个不能少、不能留空。
格式: {"tool_calls":[{"name":"工具名","arguments":{...全部必填参数...}}]}`

// 工具定义归一到 OpenAI 形状(顺带吃下 Anthropic 风格的 {name, input_schema})
function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => {
      const fn = t?.function || t
      if (!fn || typeof fn.name !== "string" || !fn.name) return null
      return {
        type: "function",
        function: {
          name: fn.name,
          description: fn.description || "",
          parameters: fn.parameters || fn.input_schema || { type: "object", properties: {} },
        },
      }
    })
    .filter(Boolean)
}

// 从 key 处往前找 {, 再向后配平括号, 抠出一个完整 JSON 对象(字符串里的括号不算)
// key 可能带引号也可能是裸键(模型写 JS 对象字面量的情况)
function sliceJsonObject(str, key, from = 0) {
  let at = str.indexOf(`"${key}"`, from)
  if (at < 0) at = str.indexOf(key, from)
  if (at < 0) return null
  let start = at
  while (start > 0 && str[start] !== "{") start--
  if (str[start] !== "{") return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < str.length; i++) {
    const ch = str[i]
    if (esc) { esc = false; continue }
    if (inStr) { if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') { inStr = true; continue }
    if (ch === "{") depth++
    else if (ch === "}" && --depth === 0) return str.slice(start, i + 1)
  }
  return null
}

// 把 JS 对象字面量修成 JSON: 裸键补引号、单引号串换双引号、去尾逗号、字符串里的裸换行转义。
// 只动字符串外的字符, 免得把正文里的冒号/逗号也改了。
function repairJson(t) {
  let out = "", i = 0, inStr = false
  while (i < t.length) {
    const ch = t[i]
    if (inStr) {
      if (ch === "\\") { out += t.slice(i, i + 2); i += 2; continue }
      // 模型写多行代码时几乎不会转义换行(它是在「写代码」而不是「写 JSON」),
      // 裸换行/制表符在 JSON 字符串里非法, 不转义整段就解析失败。
      if (ch === "\n") { out += "\\n"; i++; continue }
      if (ch === "\r") { out += "\\r"; i++; continue }
      if (ch === "\t") { out += "\\t"; i++; continue }
      out += ch
      if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue }
    if (ch === "'") {
      i++
      let s = ""
      while (i < t.length && t[i] !== "'") { s += t[i] === '"' ? '\\"' : t[i]; i++ }
      i++
      out += `"${s}"`
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < t.length && /[\w$]/.test(t[j])) j++
      let k = j
      while (k < t.length && /\s/.test(t[k])) k++
      const before = out.trimEnd().slice(-1)
      if (t[k] === ":" && (before === "{" || before === "," || before === "[" || before === "")) {
        out += `"${t.slice(i, j)}"`
        i = j
        continue
      }
    }
    if (ch === ",") {
      let k = i + 1
      while (k < t.length && /\s/.test(t[k])) k++
      if (t[k] === "}" || t[k] === "]") { i++; continue }
    }
    out += ch
    i++
  }
  return out
}

// 宽松解析: 先当标准 JSON, 不行再修一遍; 救不动返回 null
function looseJson(text) {
  const t = String(text ?? "").trim()
  if (!t) return null
  try { return JSON.parse(t) } catch {}
  try { return JSON.parse(repairJson(t)) } catch {}
  return null
}

let callSeq = 0
// 单个调用 → OpenAI tool_call; 兼容 {name,arguments} / {function:{...}} / {name,parameters}
function toToolCall(c, i = 0) {
  const fn = c?.function || c || {}
  const name = fn.name || fn.tool_name || c?.tool_name || ""
  if (typeof name !== "string" || !name) return null
  let args = fn.arguments ?? fn.parameters ?? fn.args ?? c?.arguments ?? c?.parameters
  if (typeof args === "string") {
    const parsed = looseJson(args)
    if (parsed === null) return null // 参数不是合法 JSON: 不静默变成空对象
    args = parsed
  }
  if (args == null) args = {}
  if (typeof args !== "object" || Array.isArray(args)) return null // 参数必须是 JSON 对象
  return {
    id: typeof c?.id === "string" && c.id ? c.id : `call_${uuid32().slice(0, 10)}_${callSeq++}_${i}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

// GLM 原生标签体: JSON, 或「名字 + <arg_key>k</arg_key><arg_value>v</arg_value>」
function parseToolTag(inner) {
  const t = String(inner || "").trim()
  if (!t) return null
  if (t.startsWith("{")) return toToolCall(looseJson(t))
  const nl = t.indexOf("\n")
  const name = (nl < 0 ? t : t.slice(0, nl)).trim()
  if (!name || /\s/.test(name)) return null
  const args = {}
  const re = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/g
  for (let m; (m = re.exec(t)); ) {
    const v = looseJson(m[2].trim())
    args[m[1].trim()] = v === null ? m[2].trim() : v
  }
  return toToolCall({ name, arguments: args })
}

// 参数按声明 schema 对齐与校验: 键名归一(filePath→file_path)、类型检查、required 齐全。
// 返回 null 表示该调用不合法 —— 不得交给客户端(缺参数不应被静默补成 {})。
function alignCallArgs(call, tools) {
  const def = tools.find((t) => t.function.name === call.function.name)
  if (!def) return null // 只允许本轮声明过的工具
  const params = def.function.parameters || {}
  const props = params.properties || {}
  const norm = (k) => String(k).replace(/[_\s-]/g, "").toLowerCase()
  const byNorm = new Map(Object.keys(props).map((p) => [norm(p), p]))
  let args
  try { args = JSON.parse(call.function.arguments || "{}") } catch { return null }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null
  for (const k of Object.keys(args)) {
    const declared = byNorm.get(norm(k))
    if (declared && declared !== k) { args[declared] = args[k]; delete args[k] }
  }
  for (const [k, v] of Object.entries(args)) {
    const p = props[k]
    if (p && !schemaTypeOk(p.type, v)) return null
  }
  const required = Array.isArray(params.required) ? params.required : []
  for (const r of required) {
    if (args[r] == null || args[r] === "") return null
    if (props[r] && !schemaTypeOk(props[r].type, args[r])) return null
  }
  call.function.arguments = JSON.stringify(args)
  return call
}

// 轻量 JSON Schema 类型检查(只覆盖常见 type; 未知类型一律放行, 不阻断)
function schemaTypeOk(type, v) {
  if (type == null) return true
  if (Array.isArray(type)) return type.some((t) => schemaTypeOk(t, v))
  switch (type) {
    case "string": return typeof v === "string"
    case "number": return typeof v === "number" && Number.isFinite(v)
    case "integer": return Number.isInteger(v)
    case "boolean": return typeof v === "boolean"
    case "array": return Array.isArray(v)
    case "object": return !!v && typeof v === "object" && !Array.isArray(v)
    case "null": return v === null
    default: return true
  }
}

// 从模型输出里抠出工具调用 → { calls, text, invalid, complete }(text = 剥掉调用后的正文)
// 调用方传入 tools 时做严格校验: 未知工具 / 非法参数 / 缺 required 的调用会被丢弃(计入 invalid),
// 正文、调用、解析失败三者互不污染。invalid>0 时驱动层用 TOOL_NUDGE_ARGS 走续写轮补齐。
function parseToolCalls(raw, tools) {
  const s = String(raw || "")
  if (!s.trim()) return null
  const groups = [] // { at, len, calls }
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  for (let m; (m = tagRe.exec(s)); ) {
    const call = parseToolTag(m[1])
    if (call) groups.push({ at: m.index, len: m[0].length, calls: [call] })
  }
  const fence = s.match(/```[a-zA-Z]*\s*([\s\S]*?)\s*```/)
  if (!groups.length) {
    // 提示词协议要求的 {"tool_calls":[...]}(裸 JSON / 代码围栏 / 单数 tool_call 都认)
    // 从左到右把每一段都收进来: 模型常连发多段(一段更新任务清单、一段干正事),
    // 只取第一段的话, 后面的整段漏成正文
    for (const key of ["tool_calls", "tool_call"]) {
      let from = 0
      while (true) {
        const frag = sliceJsonObject(s, key, from)
        if (!frag) break
        const at = Math.max(from, s.indexOf(frag, from))
        const parsed = looseJson(frag)
        const list = parsed?.[key]
        const calls = (Array.isArray(list) ? list : list ? [list] : []).map((c) => toToolCall(c)).filter(Boolean)
        if (calls.length) {
          groups.push({ at, len: frag.length, calls })
          from = at + frag.length
        } else {
          from = at + 1 // 这段不是合法调用(多半是正文举例), 接着往后扫
        }
      }
      if (groups.length) break
    }
  }
  if (!groups.length) {
    // 兜底: 整段就是一个调用, 或就是调用数组
    const body = (fence && fence[1] || s).trim()
    if (body.startsWith("{") || body.startsWith("[")) {
      const parsed = looseJson(body)
      const list = Array.isArray(parsed) ? parsed : parsed?.name || parsed?.tool_name ? [parsed] : []
      const calls = list.map((c) => toToolCall(c)).filter(Boolean)
      if (calls.length) {
        const at = s.indexOf(body)
        groups.push({ at: at < 0 ? 0 : at, len: at < 0 ? 0 : body.length, calls })
      }
    }
  }
  if (!groups.length) return null
  let text = s
  for (const g of [...groups].sort((a, b) => b.at - a.at)) text = text.slice(0, g.at) + text.slice(g.at + g.len)
  text = text.replace(/```[a-zA-Z]*\s*```/g, "").trim() // 顺手清掉被掏空的围栏
  text = text.replace(/<invoke_app>[^<]*<\/invoke_app>/g, "").trim() // 臆造的包装标签
  const calls = []
  let invalid = 0
  for (const c of groups.flatMap((g) => g.calls)) {
    if (!tools?.length) { calls.push(c); continue } // 无声明可校验(单测/兼容路径)
    const ok = alignCallArgs(c, tools)
    if (ok) calls.push(ok)
    else invalid++ // 未知工具/非法参数/缺 required: 丢弃, 不交给客户端
  }
  return { calls, text, invalid, complete: invalid === 0 }
}

// 模型正文是不是「可能开始写工具调用」(决定要不要先缓冲不往外发)
const TOOL_OPENER = /^\s*(\{|\[|```|<tool_call)/
const TOOL_MARK = /tool_calls|<arg_key>|<tool_call|"name"\s*:\s*"[^"]*"\s*,\s*"(arguments|parameters|args)"\s*:/

// JSON 是否已经闭合(闭合了还不是工具调用, 就可以当普通正文发出去)
function jsonClosed(t) {
  let depth = 0, inStr = false, esc = false, started = false
  for (const ch of t) {
    if (esc) { esc = false; continue }
    if (inStr) { if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') { inStr = true; continue }
    if (ch === "{" || ch === "[") { depth++; started = true }
    else if (ch === "}" || ch === "]") { depth--; if (started && depth <= 0) return true }
  }
  return false
}

// 把一条消息渲染成发给清言的文本回合
function renderTurn(m) {
  const role = m?.role === "assistant" ? "assistant" : m?.role === "tool" ? "tool" : "user"
  if (role === "assistant") {
    const body = textOf(m.content)
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter((c) => c && (c.function?.name || c.name)) : []
    if (!calls.length) return { role, text: body }
    // 历史里的工具调用按协议原样回放, 让模型看到自己的格式
    const proto = JSON.stringify({
      tool_calls: calls.map((c) => {
        const a = c.function?.arguments ?? c.arguments
        return { name: c.function?.name || c.name, arguments: typeof a === "string" ? looseJson(a) ?? {} : a ?? {} }
      }),
    })
    return { role, text: body ? `${body}\n${proto}` : proto }
  }
  if (role === "tool") {
    const name = m.name || m.tool_name || "tool"
    return { role, text: `# 工具执行结果\n\`${name}\`${m.tool_call_id ? ` (${m.tool_call_id})` : ""} 返回:\n${textOf(m.content)}` }
  }
  return { role, text: textOf(m.content) }
}

// 决定 conversation_id 与要发送的清言用户文本。
// 复用: 已发出的「我方回合」(user + 工具结果) 是本次的前缀 → 只补发新增的那些;
//       中间的 assistant 回合不算 —— 那是清言服务端自己生成的。
// 兜底: 对不上(新会话 / agent 换了上下文 / 历史被压缩)→ 新会话, system+工具协议+历史 内联合并。
function translateRequest(openai, tools, ctx = {}) {
  const msgs = Array.isArray(openai.messages) ? openai.messages : []
  const sys = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).filter(Boolean).join("\n\n")
  const turns = msgs.filter((m) => m.role !== "system" && m.role !== "developer").map(renderTurn)
  const mine = turns.filter((t) => t.role !== "assistant")
  const sig = mine.map((t) => md5hex(t.text))
  // 计账用的完整上下文: 系统提示 + 工具清单 + 全部回合(含 assistant)。与实际发什么无关 ——
  // 发的是增量还是全量只是传输方式, 客户端的上下文总量是一样的。
  const fullText = [sys && `# 系统指令(必须遵循)\n${sys}`, tools.length && TOOL_PROTOCOL(tools), ...turns.map((t) => t.text)].filter(Boolean).join("\n\n")

  // 上下文指纹: 系统提示 / 工具定义 / 模型 / 档位任一变化都不复用旧会话(服务端上下文已不兼容)。
  // 调用方没给 ctx(单测/兼容) 时 ctxKey 为 undefined, 行为与旧版一致(不校验)。
  const hasCtx = !!(ctx && (ctx.model !== undefined || ctx.effort !== undefined || ctx.sessionKey || ctx.acct))
  const ctxKey = hasCtx ? md5hex([sys, JSON.stringify(tools), ctx.model || "", ctx.effort || ""].join("\u0000")) : undefined
  const skey = hasCtx && ctx.sessionKey ? `${ctx.acct || "acct"}\u0000${ctx.sessionKey}` : ""
  const usable = (sent) =>
    Array.isArray(sent) && sent.length > 0 && sent.length <= sig.length &&
    sig.length - sent.length <= 8 &&
    sent.every((h, i) => h === sig[i])

  let best = null
  if (skey) {
    // 主路径: 客户端会话头 + 账号 → 唯一 conv(上下文一致且不在途才复用)
    const conv = sessions.get(skey)
    const rec = conv && convs.get(conv)
    if (rec && !rec.busy && rec.ctxKey === ctxKey && rec.acct === ctx.acct && usable(rec.sig)) best = { conv, sent: rec.sig }
  }
  // 降级: 拿不到会话头/主路径未命中时, 按「内容前缀 + 上下文/账号指纹 + 不在途」匹配。
  // 这是无稳定会话 ID 环境的兼容方案 —— 0.3.0 曾把降级错禁成 !hasCtx 才生效, 而调用方
  // 总是带 ctx, 导致每轮全量内联、几乎不可用。现在不再仅凭前缀: 指纹/账号/在途缺一不复用。
  if (!best) {
    for (const [conv, rec] of convs) {
      if (!rec || rec.busy || rec.ctxKey !== ctxKey || rec.acct !== ctx.acct) continue
      if (!usable(rec.sig)) continue
      if (!best || rec.sig.length > best.sent.length) best = { conv, sent: rec.sig }
    }
  }
  if (best && sig.length > best.sent.length) {
    const fresh = mine.slice(best.sent.length)
    let text = fresh.map((t, i) => (t.role === "tool" && i === fresh.length - 1 ? `${t.text}\n\n${TOOL_REMINDER}` : t.text)).join("\n\n")
    setBusy(best.conv, true) // 在途标记: 并发请求不得复用同一会话
    return { conv: best.conv, text, sig, fullText, ctxKey, sessionKey: skey, acct: ctx.acct }
  }

  const hist = turns
    .slice(0, -1)
    .map((t) => `<|${t.role === "tool" ? "user" : t.role}|>\n${t.text}`)
    .join("\n\n")
  const last = turns.length ? turns[turns.length - 1].text : ""
  const parts = []
  if (sys) parts.push(`# 系统指令(必须遵循)\n${sys}`)
  if (tools.length) parts.push(TOOL_PROTOCOL(tools))
  if (hist) parts.push(`# 对话历史(接续)\n${hist}`)
  parts.push(`# 本轮用户消息\n${last || "(空)"}`)
  return { conv: "", text: parts.join("\n\n"), sig, fullText, ctxKey, sessionKey: skey, acct: ctx.acct }
}

// 清言 SSE 事件 → OpenAI chat.completion.chunk。
// 帧语义(抓包): part.content 元素 type ∈ think|text|image; part.status init=增量, finish=该 part 全量。
// 按 part 累积(不再假设只有一个 part), 末尾把漏发的正文/工具调用补齐。
class ChatglmSSE {
  constructor(model, opts = {}) {
    this.id = "chatglm-" + uuid32()
    this.model = model
    this.tools = Array.isArray(opts.tools) ? opts.tools : []
    this.onChunk = opts.onChunk || (() => {})
    this.conv = ""
    this.text = "" // 已发出的正文(工具 JSON 不在内)
    this.think = ""
    this.raw = "" // 模型吐的全部 text(含工具 JSON), 结束时用来解析
    this.parts = new Map()
    this.mode = this.tools.length ? "probe" : "text" // probe: 先缓冲, 看是不是工具调用
    this.buf = ""
    this.finished = false
    this.failed = false // 上游 status=error / 读流异常: 终止但不得报正常 finish
    this.termination = null // stop | tool_calls | length | content_filter
    this.roundDone = false
    this.holdEnd = false // 为 true 时 finish 帧只标记本回合结束, 不终结整条流(空转要续写一轮)
    this.error = null
    this.intervene = ""
    this.calls = null // 解析出的工具调用(非流式路径要用)
    this._started = false
  }

  // 同一会话内再发一轮前调用: 解析只看这一轮的输出, 已发出的正文不回滚
  beginRound() {
    if (this.buf) { const b = this.buf; this.buf = ""; this.emitContent(b) } // 上一轮末尾还押着的正文先放出去
    this.roundDone = false
    this.raw = ""
    this.mode = this.tools.length ? "probe" : "text"
  }

  emit(delta, finish) {
    if (!this._started) { this._started = true; delta = { role: "assistant", ...delta } }
    this.onChunk({
      id: this.id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    })
  }

  feed(evt) {
    if (this.finished || !evt) return
    if (evt.conversation_id) this.conv = evt.conversation_id
    if (evt.model) this.model = evt.model
    const le = evt.last_error
    if (le && (le.message || le.code)) this.error = String(le.message || le.code)
    // 上游偶尔用 status=error 收尾(实测: 模型退化时狂吐 50 万字后报错), 必须当终止信号,
    // 否则 holdEnd 下等不到 finish 帧, 空了会一直挂到连接关闭, 甚至被误判成空转再补一轮。
    if (evt.status === "error") { this.failed = true; if (!this.error) this.error = le?.intervene_text || "上游返回 error" }
    if (evt.status === "intervene") this.intervene = le?.intervene_text || this.error || "内容因合规限制被拦截"
    for (const p of evt.parts || []) this.feedPart(p)
    if (evt.status === "finish" || evt.status === "intervene" || evt.status === "error") {
      // holdEnd: 只有正常 finish 才可能续写; error/intervene 一律终结
      if (this.holdEnd && evt.status === "finish") this.roundDone = true
      else this.end()
    }
  }

  feedPart(p) {
    const key = p.logic_id || p.id || `#${this.parts.size}`
    let st = this.parts.get(key)
    if (!st) { st = { text: "", think: "", img: false }; this.parts.set(key, st) }
    const full = p.status === "finish"
    for (const c of p.content || []) {
      if (c.type === "think" && typeof c.think === "string") {
        const d = accumulate(st, "think", c.think, full)
        if (d) { this.think += d; this.emit({ reasoning_content: d }) }
      } else if (c.type === "text" && typeof c.text === "string") {
        const d = accumulate(st, "text", c.text, full)
        if (d) { this.raw += d; this.pushText(d) }
      } else if (c.type === "image" && full && !st.img) {
        // 清言画图/带图回复: finish 帧才有图, 每个 part 只收一次
        const md = (Array.isArray(c.image) ? c.image : []).filter((v) => /^https?:/.test(v?.image_url || "")).map((v) => `![图像](${v.image_url})`).join("\n")
        if (md) { st.img = true; const t = md + "\n"; st.text += t; this.raw += t; this.pushText(t) }
      }
    }
  }

  // 正文增量: 有工具声明时先判一下是不是工具调用, 免得半截 JSON 先漏给客户端
  pushText(delta) {
    if (!this.tools.length) return this.emitContent(delta)
    if (this.mode === "tool") return
    // 「正文已经流出去, 但新片段又以 { / <tool_call 开头」→ 重新起缓冲:
    // 模型常见的「我看看…」+ 调用 就是这个形态
    const restart = this.mode === "text" && !this.buf && TOOL_OPENER.test(delta)
    if (this.mode === "text" && !restart) return this.emitContent(delta)
    this.buf += delta
    const t = this.buf.replace(/^\s+/, "")
    if (TOOL_MARK.test(t) && t.length >= 12) { this.mode = "tool"; this.buf = ""; return }
    if (jsonClosed(t) || t.length > 2048 || !TOOL_OPENER.test(t)) {
      this.mode = "text"
      const b = this.buf
      this.buf = ""
      return this.emitContent(b)
    }
    this.mode = "probe"
  }

  emitContent(t) {
    if (!t) return
    this.text += t
    this.emit({ content: t })
  }

  end() {
    if (this.finished) return
    this.finished = true
    if (this.buf) { const b = this.buf; this.buf = ""; this.emitContent(b) }
    // 上游明确报错/读流异常: 不发正常 finish —— 错误对象由驱动层按 OpenAI 流内错误补发
    if (this.failed) return
    const parsed = this.tools.length ? parseToolCalls(this.raw, this.tools) : null
    if (parsed?.calls.length) {
      // 整个 tool_calls 一次性给出(与 HelloGML 同策略: 解析要等正文收完才准)
      parsed.calls.forEach((c, i) => this.emit({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } }] }))
      this.calls = parsed.calls
      this.termination = "tool_calls"
      return this.emit({}, "tool_calls")
    }
    const note = this.intervene || this.error
    if (note && !this.text) this.emitContent(`[chatglm] ${note}`)
    // OpenAI 语义: 合规拦截→content_filter, 被掐断→length, 正常收尾→stop
    this.termination = this.intervene ? "content_filter" : this.truncated ? "length" : "stop"
    this.emit({}, this.termination)
  }
}

// part 内的字段累积: finish 帧重发该 part 全量, 只补新增部分; 对不上就对齐(已发出的收不回)
function accumulate(st, field, incoming, full) {
  const cur = st[field] || ""
  if (!full) { st[field] = cur + incoming; return incoming }
  if (incoming === cur) return ""
  if (incoming.startsWith(cur)) { st[field] = incoming; return incoming.slice(cur.length) }
  st[field] = incoming
  return ""
}

// ---- 插件 ---------------------------------------------------------------------------

export async function ChatglmAuthPlugin({ client }) {
  const log = (m) => { try { client?.app?.log?.({ body: { service: "chatglm-auth", level: "error", message: m } }) } catch {} }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      const models = Object.fromEntries(
        FALLBACK_MODELS.map((m) => [
          m.id,
          { name: m.name, limit: LIMIT, tool_call: true, reasoning: true, variants: VARIANTS },
        ]),
      )
      cfg.provider[PROVIDER] = { npm: "@ai-sdk/openai-compatible", api: HOST, ...was, name: LABEL, models: { ...models, ...(was.models ?? {}) } }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: `${LABEL} 真实账号 · 浏览器授权(推荐: 自动开登录窗, 扫码即完成)`,
          authorize: () => browserFlow(log),
        },
        {
          type: "oauth",
          label: `${LABEL} 游客模式(一键登录, 免费额度较小)`,
          // 契约: authorize 返回 {url, instructions, method, callback()}; 真正的凭据在 callback 给。
          // 游客登录是即时请求, 无需浏览器, url 留空、callback 立刻完成。
          authorize: () => {
            const device = uuid32()
            return {
              url: "",
              instructions: "一键领取清言游客身份(自动完成)。",
              method: "auto",
              async callback() {
                try {
                  const r = await guestAccess(device)
                  const state = JSON.stringify({ token: r.access_token, refresh: r.refresh_token || "", device, guest: true })
                  return {
                    type: "success",
                    access: r.access_token,
                    refresh: state,
                    expires: Date.now() + TOKEN_TTL,
                    accountId: r.user_id ? `guest#${String(r.user_id).slice(-6)}` : undefined,
                  }
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e) }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: `${LABEL} 真实账号(粘贴浏览器 Cookie)`,
          placeholder: "chatglm_token=...; chatglm_refresh_token=...",
        },
      ],

      async refresh(auth) {
        const r = await apiRefresh(credsOf(auth))
        if (!r) return null
        const c = credsOf(auth)
        return {
          type: "oauth",
          access: r.access_token,
          refresh: JSON.stringify({ token: r.access_token, refresh: r.refresh_token || c.refresh, device: c.device }),
          expires: Date.now() + TOKEN_TTL,
        }
      },

      async usage(getAuth) {
        const c = credsOf(await getAuth())
        if (!c) return { error: "未登录", windows: [] }
        try {
          return await usageOf(c)
        } catch (e) {
          return { error: String(e?.message ?? e), windows: [] }
        }
      },

      async loader(getAuth) {
        const s0 = credsOf(await getAuth())
        if (!s0) return {}
        return {
          baseURL: HOST,
          apiKey: "chatglm", // 真鉴权由 fetch 注入
          async fetch(input, init) {
            const c = credsOf(await getAuth())
            if (!c) throw new Error("chatglm: 未登录")
            const opts = input instanceof Request
              ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", ...init }
              : { ...init }
            const rawBody = opts.body == null ? "{}" : typeof opts.body === "string" ? opts.body : await new Response(opts.body).text()
            let openai = {}
            try { openai = JSON.parse(rawBody) } catch {}
            if (!openai.messages) {
              // 网关偶发的非对话请求(探测/列表): 带签名透传
              const url = input instanceof Request ? input.url : String(input)
              const r = await fetch(url.startsWith("http") ? url : HOST + url, {
                method: opts.method || "GET",
                headers: signedHeaders({ device: c.device, token: c.token }),
                signal: opts.signal,
              })
              const t = await r.text().catch(() => "")
              const keep = r.status === 401 || r.status === 403 ? "expired" : "kept"
              return new Response(t, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "x-magpie-sign-in": keep } })
            }

            const tc = openai.tool_choice
            let tools = tc === "none" ? [] : normalizeTools(openai.tools)
            // OpenAI 兼容: 指定函数时只把那个函数放进协议, required 时强制本轮必须出调用
            if (tc && typeof tc === "object" && tc.function?.name) tools = tools.filter((t) => t.function.name === tc.function.name)
            // 档位来源: magpie variants 走 reasoning_effort 字段; 也认模型 id 后缀(:high/:max)
            let model = openai.model || "glm-5.3-flash"
            let effort = ""
            const suffix = model.match(/:(low|high|max)$/i)
            if (suffix) { model = model.slice(0, -suffix[0].length); effort = suffix[1].toLowerCase() }
            effort = String(openai.reasoning_effort || openai.reasoningEffort || openai.effort || effort || "").toLowerCase()
            if (effort === "minimal") effort = "low" // OpenAI 档位别名 → 清言最近档
            else if (effort === "medium") effort = "high"
            if (!EFFORTS.includes(effort)) effort = DEFAULT_EFFORT
            const mode = EFFORT_TO_META[effort]
            // 会话隔离: 客户端会话头作主键, 账号 + 模型/档位参与上下文指纹
            const hdr = (name) => {
              const h = input instanceof Request ? input.headers : (init?.headers || {})
              if (h && typeof h.get === "function") return h.get(name) || ""
              const k = Object.keys(h || {}).find((x) => x.toLowerCase() === name)
              return k ? String(h[k]) : ""
            }
            let authInfo = null
            try { authInfo = await getAuth() } catch {}
            const sessionKey = hdr("x-session-id") || hdr("x-conversation-id") || hdr("x-thread-id")
            const acct = authInfo?.accountId || `tok:${md5hex(c.token).slice(0, 12)}`
            const req = translateRequest(openai, tools, { sessionKey, acct, model, effort })
            if ((tc === "required" || (tc && typeof tc === "object")) && tools.length) {
              req.text += `\n\n# 强制\n本轮必须输出 {"tool_calls":[...]} 开始执行, 禁止纯文本回答。${tc?.function?.name ? `使用工具 ${tc.function.name}。` : ""}`
            }
            const glmBody = (text, convId) => JSON.stringify({
              assistant_id: ASSISTANT_ID,
              conversation_id: convId,
              project_id: "",
              chat_type: "user_chat",
              meta_data: {
                cogview: { rm_label_watermark: false }, is_test: false, input_question_type: "xxxx",
                channel: "", draft_id: "", if_plus_model: true,
                chat_mode: mode.chat_mode, reasoning_effort: mode.reasoning_effort,
                selected_model: model, is_networking: false, quote_log_id: "", platform: "pc",
              },
              messages: [{ role: "user", content: [{ type: "text", text }] }],
            })

            // 一轮 = 一次上游流; 空转续写会再发一轮, 复用同一 conversation_id
            const startRound = async (text, convId) => {
              let res = null
              let err = null
              for (let attempt = 0; attempt < 2; attempt++) {
                if (opts.signal?.aborted) { err = opts.signal.reason || new Error("aborted"); err.name = "AbortError"; break }
                try {
                  res = await fetch(`${HOST}/chatglm/backend-api/assistant/stream`, {
                    method: "POST",
                    headers: signedHeaders({ device: c.device, token: c.token, json: true, sse: true }),
                    body: glmBody(text, convId),
                    signal: opts.signal,
                  })
                } catch (e) {
                  err = e
                  res = null
                  if (opts.signal?.aborted || e?.name === "AbortError") break // 客户端取消不重试
                }
                // 只重试「没建起来」的请求: 流已经开始就不能重来(会双份输出)
                if (res?.ok) break
                if (res && res.status < 500) break
                if (attempt === 0) await new Promise((r) => setTimeout(r, 1200))
              }
              if (!res) {
                log(`stream fetch failed: ${err?.message ?? err}`)
                throw err
              }
              if (res.ok) return res
              const t = await res.text().catch(() => "")
              const expired = res.status === 401 || res.status === 403 || /"status"\s*:\s*400\d\d|40104|未登录/i.test(t)
              const e = new Error(`chatglm ${res.status}: ${t.slice(0, 200)}`)
              e.status = res.status
              e.signIn = expired ? "expired" : "kept"
              throw e
            }

            const errorResponse = (e) => new Response(
              JSON.stringify({ error: { message: String(e?.message ?? e), type: "server_error", param: null, code: e?.status ? String(e.status) : "upstream_error" } }),
              { status: e?.status ?? 502, headers: { "content-type": "application/json", "x-magpie-sign-in": e?.signIn || "kept" } },
            )
            const errPayload = (message, type = "server_error", code = null) => ({ error: { message: String(message), type, param: null, code } })

            let first = null
            try {
              first = await startRound(req.text, req.conv)
            } catch (e) {
              if (e?.status) return errorResponse(e)
              throw e
            }

            const keepHeaders = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-magpie-sign-in": "kept" }
            // 取消传播: 客户端断开(信号或流取消)时, 同步取消上游读取, 不再发起续写
            let aborted = false
            let curReader = null
            const onAbort = () => { aborted = true; try { curReader?.cancel() } catch {} }
            if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true })
            const sse = new ChatglmSSE(model, { tools })
            sse.holdEnd = true // finish 帧只标记回合结束; 空转时还要补一轮

            // 清言不返回 usage → 估算, 否则网关按 0 记账显示「还没用过」。
            // prompt 按客户端完整上下文估(系统提示+全部历史+工具清单), 不能按 req.text:
            // 会话复用时增量可能只有「继续」两个字, 用量页会显示 in=2, 被误读成「没消耗」。
            const promptTokens = estimateTokens(req.fullText || req.text)
            const outTokens = () => estimateTokens(sse.text) + estimateTokens(sse.think)
            const usageEstimate = () => ({
              prompt_tokens: promptTokens,
              completion_tokens: outTokens(),
              total_tokens: promptTokens + outTokens(),
              completion_tokens_details: { reasoning_tokens: estimateTokens(sse.think) },
            })

            // 一轮的 SSE 流进 sse; 返回终止原因: done | round-done | truncated | aborted | read-error
            const pump = async (res) => {
              const reader = res.body.getReader()
              curReader = reader
              const dec = new TextDecoder()
              let buf = ""
              try {
                while (true) {
                  if (opts.signal?.aborted) { reader.cancel().catch(() => {}); return "aborted" }
                  const { value, done } = await reader.read()
                  if (done) return "done"
                  buf += dec.decode(value, { stream: true })
                  let i
                  while ((i = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, i).replace(/\r$/, "")
                    buf = buf.slice(i + 1)
                    if (line.startsWith("data:")) {
                      try { sse.feed(JSON.parse(line.slice(5).trim())) } catch {}
                    }
                  }
                  // 退化输出(payload 原地打转)只收前一段就掐掉, 免得把网关和界面一起拖死
                  if (sse.raw.length + sse.think.length > MAX_OUTPUT_CHARS) {
                    sse.error = sse.error || `输出异常膨胀(${sse.raw.length + sse.think.length} 字), 已截断`
                    sse.truncated = true
                    reader.cancel().catch(() => {})
                    sse.end()
                    return "truncated"
                  }
                  if (sse.roundDone || sse.finished) { reader.cancel().catch(() => {}); return "round-done" }
                }
              } catch (e) {
                if (aborted || opts.signal?.aborted || e?.name === "AbortError") return "aborted"
                log(`stream read failed: ${e?.message ?? e}`)
                sse.failed = true // 读流中断: 不得伪装成正常完成
                return "read-error"
              } finally {
                curReader = null
              }
            }

            // 这一轮没给出工具调用、正文也只是半句引导语 → 补一轮(只补一次)
            // 注意: 不能用 sse.calls —— 它在 end() 里才赋值, 而 holdEnd 下 end() 还没跑
            let retried = false
            let nudgeKind = "stall"
            const stalledRound = () => {
              if (retried || aborted || sse.failed || (sse.error && !sse.roundDone)) return false // 取消/上游报错: 续写只会再撞一次
              const pr = parseToolCalls(sse.raw, sse.tools)
              if (pr?.calls?.length) return false // 这一轮已经拿到可执行调用(不合法的已在解析层丢弃)
              if ((sse.text || "").trim().length > STALL_MAX_LEN) return false
              // 有调用但参数不合法/缺 required → 按 schema 重写; 只写到一半 → 重写整段
              nudgeKind = pr?.invalid ? "args" : TOOL_MARK.test(sse.raw) ? "broken" : "stall"
              return nudgeKind === "stall" ? looksStalled(sse.text) : true
            }
            const retryRound = async () => {
              retried = true
              if (aborted || sse.failed || opts.signal?.aborted) return // 取消/上游报错后不再发起生成
              const nudge = nudgeKind === "args" ? TOOL_NUDGE_ARGS : nudgeKind === "broken" ? TOOL_NUDGE_BROKEN : TOOL_NUDGE
              let res = null
              try {
                res = await startRound(nudge, sse.conv || req.conv)
              } catch (e) {
                log(`nudge round failed: ${e?.message ?? e}`)
                return
              }
              sse.beginRound()
              await pump(res)
            }

            if (openai.stream !== true) {
              // 非流式(缺省与 stream=false 均走这里): 聚合后回一个 chat.completion
              await pump(first)
              if (stalledRound()) await retryRound()
              if (sse.conv) remember(sse.conv, req.sig, { ctxKey: req.ctxKey, sessionKey: req.sessionKey, acct: req.acct })
              setBusy(req.conv, false)
              if (!sse.finished) sse.end() // holdEnd 推迟了 end, 这里必须补: 否则 sse.calls 恒为空
              // 尚未向客户端输出任何内容 → 可用 HTTP 错误表达失败(OpenAI 错误体)
              if (sse.failed) return new Response(JSON.stringify(errPayload(sse.error || "上游返回错误", "upstream_error", "upstream_error")), { status: 502, headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" } })
              const msg = sse.calls
                ? { role: "assistant", content: sse.text || null, tool_calls: sse.calls }
                : { role: "assistant", content: sse.text || `[chatglm] 空回复${sse.error ? `: ${sse.error}` : ""}` }
              return new Response(JSON.stringify({
                id: sse.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, message: msg, finish_reason: sse.termination || (sse.calls ? "tool_calls" : "stop") }],
                usage: usageEstimate(),
              }), { status: 200, headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" } })
            }

            // 流式: 清言 SSE → OpenAI chunk(仅 openai.stream === true)
            const enc = new TextEncoder()
            const wantUsage = openai.stream_options?.include_usage === true
            const out = new ReadableStream({
              async start(ctrl) {
                const emitLine = (obj) => ctrl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"))
                sse.onChunk = (chunk) => emitLine(chunk)
                await pump(first)
                if (!aborted && !sse.failed && stalledRound()) await retryRound()
                if (sse.conv) remember(sse.conv, req.sig, { ctxKey: req.ctxKey, sessionKey: req.sessionKey, acct: req.acct })
                setBusy(req.conv, false) // 清理在途标记(复用分支在 translateRequest 里置位)
                if (aborted) { try { ctrl.close() } catch {} return } // 客户端已断开: 静默收尾, 不发错误也不发 finish
                if (!sse.finished) sse.end()
                if (sse.failed) {
                  // 上游明确报错/读取中断: OpenAI 流内错误对象, 不伪装成正常完成
                  emitLine(errPayload(sse.error || "上游流中断", "upstream_error", "upstream_error"))
                  ctrl.enqueue(enc.encode("data: [DONE]\n\n"))
                  ctrl.close()
                  return
                }
                if (wantUsage) {
                  // 仅 include_usage 时输出 usage 尾块(choices 空), 与官方语义一致
                  emitLine({ id: sse.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: sse.model, choices: [], usage: usageEstimate() })
                }
                ctrl.enqueue(enc.encode("data: [DONE]\n\n"))
                ctrl.close()
              },
              cancel() { onAbort() }, // 客户端取消 SSE 消费: 停止读上游并清理
            })
            return new Response(out, { status: 200, headers: keepHeaders })
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      // 这里是 OpenCode 的 Model 形状: 能力位叫 capabilities.toolcall(不是 config 里的 tool_call)
      async models(provider, { auth } = {}) {
        const c = credsOf(auth)
        if (!c) return provider.models
        const was = Object.values(provider.models)[0] || {}
        const limit = was.limit || LIMIT
        try {
          const ms = await listModels(c)
          if (!ms.length) return provider.models
          return Object.fromEntries(
            ms.map((m) => {
              const id = m.selected_model || m.id || m.model
              // 清言每个模型自带 reasoning_efforts[{am_effort,display_name}]; 映射成 magpie variants
              const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts.map((e) => e.am_effort).filter((e) => EFFORTS.includes(e)) : []
              const variants = efforts.length ? Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])) : VARIANTS
              return [id, {
                ...was,
                id,
                providerID: PROVIDER,
                name: m.display_name || id,
                api: { id, url: HOST, npm: "@ai-sdk/openai-compatible" },
                status: "active",
                cost: was.cost || { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit,
                variants,
                capabilities: {
                  ...(was.capabilities ?? {}),
                  temperature: true,
                  reasoning: true,
                  attachment: false, // 附件/图像上传还没接, 见 README
                  toolcall: true, // 提示词协议模拟出来的, 见"工具调用"段
                  input: { text: true, image: false, audio: false, video: false, pdf: false },
                  output: { text: true, image: false, audio: false, video: false, pdf: false },
                  interleaved: false,
                },
              }]
            }),
          )
        } catch (e) {
          log(`models failed: ${e?.message ?? e}`)
          return provider.models
        }
      },
    },
  }
}

// 单测入口(对象不是函数, 不会被 magpie 当作插件)
export const _internal = {
  luhnStamp, md5hex, uuid32, signedHeaders, credsOf, parseCookies, translateRequest,
  ChatglmSSE, textOf, remember, convs, findBrowser, jwtIsGuest, browserFlow,
  normalizeTools, parseToolCalls, sliceJsonObject, looseJson, jsonClosed, renderTurn, estimateTokens,
  looksStalled, repairJson, TOOL_NUDGE, TOOL_NUDGE_BROKEN, TOOL_NUDGE_ARGS, MAX_OUTPUT_CHARS,
  alignCallArgs, schemaTypeOk, sessions, setBusy,
  HOST, SIGN_SALT, ASSISTANT_ID, VARIANTS,
}
