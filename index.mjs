// opencode-chatglm-auth —— 智谱清言 (chatglm.cn) magpie/OpenCode 供应商插件
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

// 清言的推理档位(抓包 available_models + 网页选择器): 快速/深度/极致 = ""/thinking/deep_thinking
// magpie 的 variants 键即档位名, 会渲染成模型设置里"不思考/低/高/最高"那排勾选框。
const EFFORTS = ["low", "high", "max"]
const VARIANTS = { low: {}, high: {}, max: {} }
// magpie 档位 → 清言请求 meta_data 映射(网页端实测: 极致=deep_thinking+max)
const EFFORT_TO_META = {
  low: { chat_mode: "fast", reasoning_effort: "" },
  high: { chat_mode: "deep_thinking", reasoning_effort: "high" },
  max: { chat_mode: "deep_thinking", reasoning_effort: "max" },
}

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
async function apiRefresh(creds) {
  if (!creds?.token || creds.guest) return null
  const res = await fetch(`${HOST}/chatglm/user-api/user/refresh`, {
    method: "POST", headers: signedHeaders({ device: creds.device, token: creds.token }), body: "",
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
    state.profile = path.join(process.env.LOCALAPPDATA || os.homedir(), "opencode-chatglm-auth", "browser")
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

// 会话映射: conv id → 已发送的用户消息文本序列(上下文由清言服务端保存)
const convs = new Map()
const CONV_MAX = 48

function remember(conv, userTexts) {
  if (!conv) return
  convs.set(conv, userTexts)
  while (convs.size > CONV_MAX) convs.delete(convs.keys().next().value)
}

// 决定 conversation_id 与要发送的清言用户文本。
// 增量: 除最后一条 user 外的前缀与某已知会话一致 → 复用会话只发最后一条。
// 兜底: 无匹配(新会话/历史被压缩)→ 新会话, system+历史合并成一条用户消息内联。
function translateRequest(openai) {
  const msgs = Array.isArray(openai.messages) ? openai.messages : []
  const sys = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).filter(Boolean).join("\n\n")
  const users = msgs.filter((m) => m.role === "user").map((m) => textOf(m.content))
  const lastUser = users.length ? users[users.length - 1] : ""
  const prefix = users.slice(0, -1)
  for (const [conv, sent] of convs) {
    if (sent.length === prefix.length && sent.every((t, i) => t === prefix[i])) {
      return { conv, text: lastUser, users }
    }
  }
  let text = lastUser
  if (prefix.length) {
    const hist = msgs.map((m) => `${m.role}: ${textOf(m.content)}`).join("\n\n")
    text = `# 对话历史(接续)\n${hist}\n\n# 本轮用户消息\n${lastUser}`
  } else if (sys) {
    text = `# 系统指令(遵循)\n${sys}\n\n# 用户消息\n${lastUser}`
  }
  return { conv: "", text, users }
}

// 清言 SSE 事件 → OpenAI chat.completion.chunk。
// 帧语义(抓包): part.content 元素 type ∈ think|text; part.status init=增量帧, finish=全量帧。
class ChatglmSSE {
  constructor(model, onChunk) {
    this.id = "chatglm-" + uuid32()
    this.model = model
    this.onChunk = onChunk || (() => {})
    this.conv = ""
    this.think = ""
    this.text = ""
    this.finished = false
    this.error = null
    this._started = false
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
    for (const p of evt.parts || []) {
      const full = p.status === "finish"
      for (const c of p.content || []) {
        if (c.type === "think" && c.think) {
          const d = full ? (c.think.startsWith(this.think) ? c.think.slice(this.think.length) : null) : c.think
          if (d) { this.think += d; this.emit({ reasoning_content: d }) }
          else if (full) this.think = c.think
        } else if (c.type === "text" && c.text) {
          const d = full ? (c.text.startsWith(this.text) ? c.text.slice(this.text.length) : null) : c.text
          if (d) { this.text += d; this.emit({ content: d }) }
          else if (full) this.text = c.text
        }
      }
    }
    const le = evt.last_error
    if (le && (le.message || le.code)) this.error = String(le.message || le.code)
    if (evt.status === "finish") this.end()
  }

  end() {
    if (this.finished) return
    this.finished = true
    if (this.error && !this.text) this.emit({ content: `[chatglm] ${this.error}` }, "stop")
    else this.emit({}, "stop")
  }
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
          { name: m.name, limit: { context: 200000, output: 32000 }, tool_call: false, reasoning: true, variants: VARIANTS },
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

            const req = translateRequest(openai)
            // 清言网页协议不接受外部工具定义: 带 tools 的请求照发, 工具被清言无视,
            // 由模型自行决定怎么回答(不做任何拦截)。
            // 档位来源: magpie variants 可能走 reasoning_effort 字段或模型 id 后缀(:high/:max)
            let model = openai.model || "glm-5.3-flash"
            let effort = ""
            const suffix = model.match(/:(low|high|max)$/i)
            if (suffix) { model = model.slice(0, -suffix[0].length); effort = suffix[1].toLowerCase() }
            effort = String(openai.reasoning_effort || openai.reasoningEffort || openai.effort || effort || "").toLowerCase()
            if (!["low", "high", "max"].includes(effort)) effort = "max" // 默认极致(与网页默认一致)
            const mode = EFFORT_TO_META[effort]
            const glmBody = JSON.stringify({
              assistant_id: ASSISTANT_ID,
              conversation_id: req.conv,
              project_id: "",
              chat_type: "user_chat",
              meta_data: {
                cogview: { rm_label_watermark: false }, is_test: false, input_question_type: "xxxx",
                channel: "", draft_id: "",
                chat_mode: mode.chat_mode, reasoning_effort: mode.reasoning_effort,
                selected_model: model, is_networking: false, quote_log_id: "", platform: "pc",
              },
              messages: [{ role: "user", content: [{ type: "text", text: req.text }] }],
            })

            let res
            try {
              res = await fetch(`${HOST}/chatglm/backend-api/assistant/stream`, {
                method: "POST",
                headers: signedHeaders({ device: c.device, token: c.token, json: true, sse: true }),
                body: glmBody,
                signal: opts.signal,
              })
            } catch (e) {
              log(`stream fetch failed: ${e?.message ?? e}`)
              throw e
            }

            if (!res.ok) {
              const t = await res.text().catch(() => "")
              const expired = res.status === 401 || res.status === 403 || /"status"\s*:\s*400\d\d|40104|未登录/i.test(t)
              return new Response(JSON.stringify({ error: { message: `chatglm ${res.status}: ${t.slice(0, 200)}`, type: "server_error" } }), {
                status: res.status,
                headers: { "content-type": "application/json", "x-magpie-sign-in": expired ? "expired" : "kept" },
              })
            }

            const keepHeaders = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-magpie-sign-in": "kept" }

            // 本轮的用户消息序列, 会话建立后记账(下一轮据此判断增量)
            const nextUsers = (m) => {
              const users = Array.isArray(m) ? m.filter((x) => x.role === "user").map((x) => textOf(x.content)) : []
              return users.length ? users : [req.text]
            }
            // 清言不返回 usage → 估算, 否则网关按 0 记账显示「还没用过」
            const usageEstimate = () => {
              const prompt = estimateTokens((Array.isArray(openai.messages) ? openai.messages : []).map((m) => textOf(m.content)).join("\n"))
              const completion = estimateTokens(sse.text) + estimateTokens(sse.think)
              return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
            }

            const sse = new ChatglmSSE(model)
            if (openai.stream === false) {
              // 非流式: 聚合后回一个 chat.completion
              const text = await res.text()
              for (const line of text.split("\n")) {
                if (!line.startsWith("data:")) continue
                try { sse.feed(JSON.parse(line.slice(5).trim())) } catch {}
                if (sse.finished) break
              }
              if (sse.conv) remember(sse.conv, nextUsers(openai.messages))
              return new Response(JSON.stringify({
                id: sse.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, message: { role: "assistant", content: sse.text || `[chatglm] 空回复${sse.error ? `: ${sse.error}` : ""}` }, finish_reason: "stop" }],
                usage: usageEstimate(),
              }), { status: 200, headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" } })
            }

            // 流式: 清言 SSE → OpenAI chunk
            const enc = new TextEncoder()
            const out = new ReadableStream({
              async start(ctrl) {
                sse.onChunk = (chunk) => ctrl.enqueue(enc.encode("data: " + JSON.stringify(chunk) + "\n\n"))
                const dec = new TextDecoder()
                const reader = res.body.getReader()
                let buf = ""
                const finish = () => {
                  if (sse.conv) remember(sse.conv, nextUsers(openai.messages))
                  if (!sse.finished) sse.end()
                  // 标准 OpenAI 流式 usage 尾块(choices 空)
                  ctrl.enqueue(enc.encode("data: " + JSON.stringify({ id: sse.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: sse.model, choices: [], usage: usageEstimate() }) + "\n\n"))
                  ctrl.enqueue(enc.encode("data: [DONE]\n\n"))
                  ctrl.close()
                }
                try {
                  while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    buf += dec.decode(value, { stream: true })
                    let i
                    while ((i = buf.indexOf("\n")) >= 0) {
                      const line = buf.slice(0, i).replace(/\r$/, "")
                      buf = buf.slice(i + 1)
                      if (line.startsWith("data:")) {
                        try { sse.feed(JSON.parse(line.slice(5).trim())) } catch {}
                      }
                    }
                    if (sse.finished) { reader.cancel().catch(() => {}); break }
                  }
                  finish()
                } catch (e) {
                  log(`stream failed: ${e?.message ?? e}`)
                  try { finish() } catch {}
                }
              },
            })
            return new Response(out, { status: 200, headers: keepHeaders })
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const c = credsOf(auth)
        if (!c) return provider.models
        try {
          const ms = await listModels(c)
          if (!ms.length) return provider.models
          const base = Object.values(provider.models)[0] || { limit: { context: 200000, output: 32000 }, tool_call: false }
          return Object.fromEntries(
            ms.map((m) => {
              const id = m.selected_model || m.id || m.model
              // 清言每个模型自带 reasoning_efforts[{am_effort,display_name}]; 映射成 magpie variants
              const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts.map((e) => e.am_effort).filter((e) => ["low", "high", "max"].includes(e)) : []
              const variants = efforts.length ? Object.fromEntries(efforts.map((e) => [e, {}])) : VARIANTS
              return [id, { ...base, id, name: m.display_name || id, tool_call: false, reasoning: true, variants }]
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
  HOST, SIGN_SALT, ASSISTANT_ID,
}
