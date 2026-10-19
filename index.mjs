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
const SIGN_SALT = process.env.CHATGLM_SIGN_SALT || "8a1317a7468aa3ad86e997d08f3f31cb"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
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

function signedHeaders({ device, token = "", json = false, sse = false, requestId = "" }) {
  const ts = luhnStamp(Date.now())
  const nonce = uuid32()
  return {
    "app-name": "chatglm",
    "x-app-platform": "pc",
    "x-app-version": "0.0.1",
    "x-app-fr": "default",
    "x-lang": "zh",
    "x-device-id": device,
    "x-request-id": requestId || uuid32(),
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
let lastClaimDay = ""
async function claimDaily(creds) {
  const today = new Date().toISOString().slice(0, 10)
  if (today === lastClaimDay) return { status: 2, message: "今日已领(本地记录)" }
  try {
    const res = await fetch(`${API}/member-api/member/daily_login_score`, {
      method: "POST", headers: signedHeaders({ device: creds.device, token: creds.token }), body: "",
    })
    const j = await res.json().catch(() => null)
    const msg = String(j?.message || "")
    if (j?.status === 0 || /已|重复|limit|today/i.test(msg)) lastClaimDay = today
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
  const pMember = memberInfo(creds).then((m) => m?.result || m || {}).catch(() => ({}))
  const pActivity = scoreActivity(creds).catch(() => null)
  const pDaily = claimDaily(creds)
  let mi = await pMember
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
  const dl = await pDaily
  if (dl && dl.status === 0) out.windows.push({ name: "每日登录", used: 0, display: "+200 已领", aside: true })
  else if (dl && /已|重复|limit|today/i.test(String(dl.message || ""))) out.windows.push({ name: "每日登录", used: 0, display: "今日已领", aside: true })
  // 活动积分: status>0 才是真在活动(-2=无活动)
  {
    const s = (await pActivity)?.result
    if (s && s.status > 0 && s.target_score > 0) {
      out.windows.push({
        name: s.title || "活动积分",
        used: Math.max(0, 100 - Math.round(((s.target_score - (s.current_score || 0)) / s.target_score) * 100)),
        display: `${s.current_score || 0} / ${s.target_score}`,
      })
    }
  }
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
    process.off("exit", onExit) // G7: 登录结束即摘除, 不随登录次数累加全局监听器
  }
  const onExit = () => cleanup() // 宿主进程被 kill 时回收调试浏览器, 不留孤儿 Chrome
  process.on("exit", onExit)

  const start = async () => {
    if (!state.exe) throw new Error("找不到 Chrome/Edge —— 请改用「粘贴 Cookie」方式登录")
    state.profile = path.join(process.env.LOCALAPPDATA || os.homedir(), "magpie-chatglm-auth", "browser")
    fs.mkdirSync(state.profile, { recursive: true })
    let version = null
    // 随机端口可能撞上已占用服务(表现为探测一直失败): 换口重来, 最多 3 次
    for (let attempt = 0; attempt < 3 && !version; attempt++) {
      state.port = 9300 + Math.floor(Math.random() * 500)
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
      for (let i = 0; i < 40; i++) {
        await sleep(500)
        try { version = await (await fetch(`http://127.0.0.1:${state.port}/json/version`)).json(); break } catch {}
        if (state.child.exitCode != null) break
      }
      if (!version && state.child.exitCode == null) { try { state.child.kill() } catch {} }
      if (!version) await sleep(300)
    }
    if (!version) throw new Error("调试端口没起来 —— 若已开着一个同 profile 的窗口, 关掉它再重试")
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    // 握手超时: 个别环境 onerror 不触发, 不设超时会永远卡在这里
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP WebSocket 连接超时")), 10_000)
      ws.onopen = () => { clearTimeout(t); res() }
      ws.onerror = () => { clearTimeout(t); rej(new Error("CDP WebSocket 连接失败")) }
    })
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

// ---- 回合终态 -----------------------------------------------------------------------
// 一轮模型回合的权威终态, end() 时一次性判定、判定后不再改。「成功」只认 completed。
// 旧实现靠 finished/roundDone/error 布尔组合猜终态, 猜错的代价就是事故形态:
// error 也发 stop、EOF 没完成也算收完、中断的半截调用被当成功工具交给 Agent。
const ROUND = {
  COMPLETED: "completed",            // 收到事件级 status:finish, 上游正常完成本回合
  UPSTREAM_ERROR: "upstream_error",  // 上游明确失败: status:error / status:intervene / last_error
  INTERRUPTED: "interrupted",        // 读网络流抛出异常(传输故障)
  INCOMPLETE: "incomplete",          // 连接关闭(正常 EOF)但没有正常完成事件
  TRUNCATED: "truncated",            // 插件主动掐断(退化输出超上限)
  CANCELLED: "cancelled",            // 调用方取消(signal abort / 下游断开)
}
// 失败终态的人话说明(非流式错误体与流式错误帧共用)
const ROUND_UNFINISHED = {
  [ROUND.INTERRUPTED]: "与清言的连接中断, 本轮未完成",
  [ROUND.INCOMPLETE]: "清言连接已关闭, 但未收到本轮完成信号",
  [ROUND.CANCELLED]: "请求已取消",
}

// 工具调用合法校验: 名字在本次声明列表 + arguments 是合法 JSON + 参数匹配 schema。
// 返回 '' = 合法, 否则返回不合法原因(出站只放行合法调用, 不合法的丢弃并记录)。
function checkToolCall(c, tools) {
  const name = c?.function?.name
  if (typeof name !== "string" || !name) return "调用缺少工具名"
  const decl = tools.find((t) => t.function?.name === name)
  if (!decl) return `工具 ${name} 不在本次声明的工具列表里`
  let args
  try { args = JSON.parse(c.function.arguments) } catch { return `工具 ${name} 的 arguments 不是合法 JSON` }
  const errs = schemaErrors(decl.function.parameters, args, `工具 ${name} 的参数`)
  return errs.length ? errs.join("; ") : ""
}

// 轻量 JSON Schema 校验(够 OpenAI 工具参数用): type/required/properties/enum/items/
// additionalProperties:false。不认识的字段一律放行(模型爱补默认值, 误杀比漏放贵)。
const jsonTypeName = (v) =>
  Array.isArray(v) ? "array" : v === null ? "null"
  : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v
function typeOk(t, v) {
  switch (t) {
    case "object": return !!v && typeof v === "object" && !Array.isArray(v)
    case "array": return Array.isArray(v)
    case "string": return typeof v === "string"
    case "number": return typeof v === "number" && !Number.isNaN(v)
    case "integer": return Number.isInteger(v)
    case "boolean": return typeof v === "boolean"
    case "null": return v === null
    default: return true // unknown schema type: don't reject on it
  }
}
function schemaErrors(schema, v, at = "参数", out = []) {
  if (!schema || typeof schema !== "object" || out.length > 12) return out
  const ts = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (ts.length && !ts.some((t) => typeOk(t, v))) out.push(`${at}: 应为 ${ts.join("/")} 类型, 实际为 ${jsonTypeName(v)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v)))
    out.push(`${at}: 取值 ${JSON.stringify(v)} 不在枚举 ${JSON.stringify(schema.enum)} 内`)
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of Array.isArray(schema.required) ? schema.required : [])
      if (!(k in v)) out.push(`${at}.${k}: 缺少必填参数`)
    for (const [k, sub] of Object.entries(schema.properties || {}))
      if (k in v) schemaErrors(sub, v[k], `${at}.${k}`, out)
    if (schema.additionalProperties === false)
      for (const k of Object.keys(v))
        if (!(k in (schema.properties || {}))) out.push(`${at}.${k}: schema 未声明的多余参数`)
  }
  if (Array.isArray(v) && schema.items) v.slice(0, 20).forEach((x, i) => schemaErrors(schema.items, x, `${at}[${i}]`, out))
  return out
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

// 会话映射: conv id → 回合记录(record)。上下文由清言服务端保存, 这里只记「已确认发出」的前缀。
// 记录形状(设计文档 §9.1): { sig, acct, ctxKey, sessionKey, busy, quarantined, retired, ts, lastUsed }
// 三态语义分离(边界 4): quarantined=本进程选定但交付不确定; retired=本进程主动退出的映射;
// dirty=新建请求不确定交付时从响应里见过的 id(从未确认归属, 永不参与匹配)。
// SESSION_HEADER: chat.headers 钩子把宿主 sessionID 带进请求头, loader.fetch 读回即删、不发上游。
const convs = new Map()
const SESSION_HEADER = "x-magpie-chatglm-session"
const dirty = new Map() // convId -> 记入时刻
const CONV_MAX = 48
const DIRTY_MAX = 48
const DIRTY_TTL_MS = 3600_000                       // dirty 观察集 1h 过期
const QUARANTINE_TTL_MS = 24 * 3600_000             // 隔离/退役记录 24h 后整条删除(过期=删除, 不解封)
const GAP_MAX_WITH_SESSION = 64                     // 有 sessionKey: 增量消息数上限
const GAP_MAX_NO_SESSION = 8                        // 无头: 保留旧启发式
const FRESH_MAX_BYTES = 512 * 1024                  // 增量字节上限
const STALE_MS = () => Number(process.env.CHATGLM_CONV_STALE_MS || 0) || 30 * 60_000 // 耗时保护
const CTX_VERSION = 1                               // 协议文本(TOOL_PROTOCOL/渲染格式)变更时 bump

function newRecord(meta = {}) {
  return {
    sig: [],
    acct: meta.acct ?? "",
    ctxKey: meta.ctxKey ?? "",
    sessionKey: meta.sessionKey ?? "",
    busy: 0,
    quarantined: false,
    retired: null,
    ts: 0,
    lastUsed: Date.now(),
  }
}
// 兼容读: 旧用法把值直接存成 sig 数组(旧测试/旧 remember), 统一升格成 record
function readRec(v) { return Array.isArray(v) ? { ...newRecord(), sig: v } : v }
function normRec(conv) { const v = convs.get(conv); if (!v) return null; const r = readRec(v); convs.set(conv, r); return r }

function quarantine(conv, reason) {
  const r = normRec(conv)
  if (!r || r.quarantined || r.retired) return // 棘轮: 已是终局不再改, 也不被他人解除
  r.quarantined = true; r.qreason = reason; r.ts = Date.now()
}
function retire(conv, reason) {
  const r = normRec(conv)
  if (!r || r.retired) return
  r.retired = reason; r.ts = Date.now()
}
function dirtyAdd(conv) {
  if (!conv) return
  dirty.set(conv, Date.now())
  while (dirty.size > DIRTY_MAX) dirty.delete(dirty.keys().next().value)
}
function busyAdd(conv) { const r = normRec(conv); if (r) r.busy++ }
function busySub(conv) { const r = normRec(conv); if (r && r.busy > 0) r.busy-- }

// 清理顺序固定(§9.3): dirty TTL → 隔离/退役整条删除 → active 按 lastUsed LRU。
// 只产生删除, 不产生状态降级 —— 已隔离会话不存在「洗白回正常映射」的路径。
let lastSweepAt = 0
function sweepThrottled() { // 读取路径也触发清理(节流 60s): 低流量时段 24h 过期语义照样兑现
  const now = Date.now()
  if (now - lastSweepAt < 60_000) return
  lastSweepAt = now
  sweep()
}
function sweep() {
  const now = Date.now()
  for (const [k, t] of dirty) if (now - t > DIRTY_TTL_MS) dirty.delete(k)
  for (const [k, v] of convs) {
    const r = readRec(v)
    if ((r.quarantined || r.retired) && now - (r.ts || 0) > QUARANTINE_TTL_MS) convs.delete(k)
  }
  while (convs.size > CONV_MAX) {
    let oldest = null, ot = Infinity
    for (const [k, v] of convs) { const lu = readRec(v).lastUsed; if (lu < ot) { ot = lu; oldest = k } }
    if (oldest == null) break
    convs.delete(oldest)
  }
}

// 提交会话前缀。棘轮(§6.4): 目标 conv 已被隔离/退役时拒写 —— 迟到的 completed 不复活终局记录。
// meta 省略字段沿用旧记录(兼容旧测试的 remember(conv, sig) 两参调用)。
function remember(conv, sig, meta) {
  if (!conv || !Array.isArray(sig)) return
  const prev = convs.get(conv)
  if (prev) {
    const r = readRec(prev)
    if (r.quarantined || r.retired) return
    r.sig = sig
    r.lastUsed = Date.now()
    if (meta) { if (meta.acct != null) r.acct = meta.acct; if (meta.ctxKey != null) r.ctxKey = meta.ctxKey; if (meta.sessionKey != null) r.sessionKey = meta.sessionKey }
    convs.delete(conv); convs.set(conv, r)
  } else {
    convs.set(conv, { ...newRecord(meta), sig, lastUsed: Date.now() })
  }
  sweep()
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

## 可用工具
${tools.map((t) => `### ${t.function.name}\n${t.function.description || "(无描述)"}\n参数 schema: ${JSON.stringify(t.function.parameters)}`).join("\n\n")}

## 示例
用户: 现在几点了?
回答: {"tool_calls":[{"name":"get_time","arguments":{"timezone":"Asia/Shanghai"}}]}

用户: 你好呀
回答: 你好!有什么可以帮你的?`

// agent 循环里每一轮都提醒一次: 清言侧历史很长, 首条消息里的协议容易被冲淡,
// 而报错重发恰恰发生在循环中段 —— 纪律必须随工具结果每轮重钉一遍
const TOOL_REMINDER = `# 提示
还需要工具就继续按协议输出 {"tool_calls":[...]};任务已完成就用自然语言给出最终回答。
按工具描述选工具: 本地文件/shell 命令一律用对应的本地工具, 描述带「网页/浏览/打开链接」的工具不要拿来执行命令或读文件。
上一个调用报错后绝不允许原样重发: 相同的输入只会得到相同的错误, 换参数或换工具再试。`

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

// 工具结果文本像不像报错。宽松匹配: 误报的代价只是多提醒一句/多拦一次重发, 漏报则毫无防护
const TOOL_ERR_RE = /(error|failed|fatal|cannot|could not|can't|not found|no such|invalid|denied|refused|traceback|exception|ENOENT|EACCES|EPERM|EISDIR|exit code [1-9])|报错|失败|无法|权限|拒绝/i

// 报错轮的强化提醒: TOOL_PROTOCOL 只注入首条消息, 会话复用后长历史会把它冲淡,
// 所以报错发生的当轮要把「禁止原样重发」重新钉一遍
const TOOL_ERR_REMINDER = `# 注意: 上面的工具执行结果里有报错
报错的调用绝不允许原样重发 —— 相同的输入只会得到相同的错误。
修正参数、换用更合适的工具(本地文件/命令用本地工具, 网页类工具只用于打开链接), 或者向用户说明情况并给出最终回答。`

// 模型把「刚报错的调用」原样又输出一遍时的续写轮: 点名这个调用, 要求换做法
const TOOL_NUDGE_REPEAT = `# 注意: 你刚才原样重发了一个刚报错的调用
那次调用不会被执行 —— 相同的输入只会得到相同的错误。
这一轮必须换做法: 修正参数、改用更合适的工具(本地文件/命令用本地工具, 描述带「网页/浏览/打开链接」的工具不要用来读文件或执行命令),
或者不再调用工具, 用完整的句子向用户说明情况并给出最终回答。`

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
function sliceJsonObject(str, key) {
  let at = str.indexOf(`"${key}"`)
  if (at < 0) at = str.indexOf(key)
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
// 参数三态严格区分(P0-1): 缺失 arguments → "{}"(交由 schema 校验必填项);
// 合法 JSON(含规范的空对象) → 正常序列化; 非法 JSON 字符串 → 保留原文, 不静默转 {} ——
// checkToolCall 会按「arguments 不是合法 JSON」拒绝整条调用, 防止空参数调用被 Agent 执行。
function toToolCall(c, i = 0) {
  const fn = c?.function || c || {}
  const name = fn.name || fn.tool_name || c?.tool_name || ""
  if (typeof name !== "string" || !name) return null
  let args = fn.arguments ?? fn.parameters ?? fn.args ?? c?.arguments ?? c?.parameters ?? {}
  if (typeof args === "string") {
    const parsed = looseJson(args) // 字符串里还包着一层就再解一层(合法但不规范的 JSON 仍受支持)
    args = parsed === null ? args : parsed // 解不动 = 非法: 原样保留, 让校验拒绝
  }
  return {
    id: typeof c?.id === "string" && c.id ? c.id : `call_${uuid32().slice(0, 10)}_${callSeq++}_${i}`,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
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

// 从模型输出里抠出工具调用 → { calls, text }(text = 剥掉调用后的正文); 没有则 null
function parseToolCalls(raw) {
  const s = String(raw || "")
  if (!s.trim()) return null
  const groups = [] // { at, len, calls }
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  for (let m; (m = tagRe.exec(s)); ) {
    const call = parseToolTag(m[1])
    if (call) groups.push({ at: m.index, len: m[0].length, calls: [call] })
  }
  const fences = [...s.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)\s*```/g)].map((m) => m[1]) // 全部围栏: 第一个可能是示例, 真调用在后面
  if (!groups.length) {
    // 提示词协议要求的 {"tool_calls":[...]}(裸 JSON / 代码围栏 / 单数 tool_call 都认)
    for (const body of [...fences, s]) {
      if (!body) continue
      const frag = sliceJsonObject(body, "tool_calls") || sliceJsonObject(body, "tool_call")
      if (!frag) continue
      const parsed = looseJson(frag)
      const list = parsed?.tool_calls ?? parsed?.tool_call
      const calls = (Array.isArray(list) ? list : list ? [list] : []).map((c) => toToolCall(c)).filter(Boolean)
      if (!calls.length) continue
      const at = s.indexOf(frag)
      groups.push({ at: at < 0 ? 0 : at, len: at < 0 ? 0 : frag.length, calls })
      break
    }
  }
  if (!groups.length) {
    // 兜底: 整段就是一个调用, 或就是调用数组
    const body = (fences[0] || s).trim()
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
  return { calls: groups.flatMap((g) => g.calls), text }
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

// 调用指纹: 名字 + 规范化参数(键排序)。同一调用的不同写法(字符串/对象/键序不同)要判等
function canonArgs(v) {
  if (Array.isArray(v)) return v.map(canonArgs)
  if (v && typeof v === "object") {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = canonArgs(v[k])
    return o
  }
  return v
}
function callKey(name, args) {
  const a = typeof args === "string" ? looseJson(args) ?? args.trim() : args ?? {}
  let s
  try { s = JSON.stringify(canonArgs(a)) } catch { s = String(a) }
  return `${name} ${s}`
}

// 历史里「结果像报错」的调用 → 指纹集合。出站时模型又吐出同样的调用就是原样重发:
// 拦下来换成点名续写轮, 免得把客户端每轮的调用上限烧在注定失败的重复执行上(实测: 连错三次整轮报废)
function failedCallKeys(messages) {
  const out = new Set()
  const msgs = Array.isArray(messages) ? messages : []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    const calls = m?.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls.filter((c) => c?.function?.name || c?.name) : []
    if (!calls.length) continue
    const results = []
    for (let j = i + 1; j < msgs.length && msgs[j]?.role === "tool"; j++) results.push(msgs[j])
    for (const c of calls) {
      const name = c.function?.name || c.name
      const r = results.find((x) => x?.tool_call_id && x.tool_call_id === c?.id)
        || results.find((x) => (x?.name || x?.tool_name) === name)
        || results[0]
      if (r && TOOL_ERR_RE.test(textOf(r.content))) out.add(callKey(name, c.function?.arguments ?? c.arguments))
    }
  }
  return out
}

// ---- 会话身份与上下文指纹(设计文档 §5/§8) --------------------------------------------

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex")

// 账号隔离键: 完整稳定 uid 的摘要优先(换 token 不换 uid → 映射跨续期存活);
// 无 uid 退回凭据摘要(token 轮换 → acct 变 → 旧 conv 失效, 安全优先的有意取舍)。
// 禁用: uid 后 6 位(可碰撞)、api 登录每请求随机的 device。凭据本身不落日志。
function acctOf(token) {
  const uid = jwtIsGuest(token || "").uid
  return uid ? sha256hex(`uid:${uid}`).slice(0, 16) : sha256hex(`cred:${md5hex(String(token || ""))}`).slice(0, 16)
}

// 上下文指纹: 结构化规范对象做哈希输入(JSON 序列化天然带字段边界, 不拼裸字符串)。
// 进指纹: sys(有序+角色边界) / 有效工具集(按名排序+schema 键排序) / model / effort / CTX_VERSION。
// 不进指纹(单次调用设置): temperature/top_p/seed/max_tokens/stop(网页协议忽略),
// stream/stream_options(传输方式), tool_choice 模式值(每轮现拼强制文案), user/metadata(无证据影响上游)。
function ctxKeyOf({ sys, tools, model, effort }) {
  const payload = {
    v: CTX_VERSION,
    sys: (Array.isArray(sys) ? sys : []).map((m) => ({ role: m.role, text: m.text })),
    tools: (Array.isArray(tools) ? tools : [])
      .slice()
      .sort((a, b) => String(a.function.name).localeCompare(String(b.function.name)))
      .map((t) => ({ name: t.function.name, description: t.function.description ?? "", parameters: canonArgs(t.function.parameters ?? {}) })),
    model, effort,
  }
  return sha256hex(JSON.stringify(payload)).slice(0, 24)
}

const isPrefix = (sent, sig) => sent.length <= sig.length && sent.every((h, i) => h === sig[i])

// 增量三重保护(决策 2): 消息数 / 体积 / 耗时。sessionKey 在场时消息数放宽到 64。
function withinLimits(gap, freshBytes, rec, hasSession) {
  if (gap > (hasSession ? GAP_MAX_WITH_SESSION : GAP_MAX_NO_SESSION)) return false
  if (freshBytes > FRESH_MAX_BYTES) return false
  if (Date.now() - (rec.lastUsed || 0) > STALE_MS()) return false
  return true
}

// 决定 conversation_id 与要发送的清言用户文本。
// 复用(设计文档 §4): 六条件过滤候选 → 唯一候选且增量三重保护通过 → 只补发新增回合;
//   候选 >1 → 不比较谁更长谁更新, 直接重建(§4.4); 前缀不成立 → 禁止 slice, 退役重建(§4.2)。
// 兜底: 对不上(新会话 / 上下文变 / 历史被压缩)→ 新会话, system+工具协议+历史 内联合并。
// ctx 默认 {} → acct/ctxKey/sessionKey 皆空, 与旧 remember(conv,sig) 两参调用兼容。
function translateRequest(openai, tools, ctx = {}) {
  sweepThrottled()
  const msgs = Array.isArray(openai.messages) ? openai.messages : []
  const sysText = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).filter(Boolean).join("\n\n")
  const sysParts = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => ({ role: m.role === "developer" ? "developer" : "system", text: textOf(m.content) })).filter((m) => m.text)
  const turns = msgs.filter((m) => m.role !== "system" && m.role !== "developer").map(renderTurn)
  const mine = turns.filter((t) => t.role !== "assistant")
  const sig = mine.map((t) => md5hex(t.text))
  const blocked = failedCallKeys(msgs)
  // 计账用的完整上下文: 系统提示 + 工具清单 + 全部回合(含 assistant)。与实际发什么无关 ——
  // 发的是增量还是全量只是传输方式, 客户端的上下文总量是一样的。
  const fullText = [sysText && `# 系统指令(必须遵循)\n${sysText}`, tools.length && TOOL_PROTOCOL(tools), ...turns.map((t) => t.text)].filter(Boolean).join("\n\n")

  // 本请求的上下文指纹(与 conv 首条内联注入的上下文对应)。
  // ctx 整体缺省(旧两参调用/无 ctx 环境) → 指纹全空, 退化为「仅前缀+gap」的旧语义 —— 门控只约束带 ctx 的请求。
  const hasCtx = !!ctx && (ctx.acct != null || ctx.sessionKey != null || ctx.ctxKey != null || ctx.model != null)
  const reqCtxKey = ctx.ctxKey ?? (hasCtx ? ctxKeyOf({ sys: sysParts, tools, model: ctx.model ?? "", effort: ctx.effort ?? "" }) : "")
  const reqAcct = ctx.acct ?? ""
  const reqSession = ctx.sessionKey ?? ""

  // 六条件过滤(§4.1): acct / ctxKey / 未隔离未退役 / 无在途 / sessionKey 一致(有头才查) / 前缀成立
  // why: 首个被拒原因(供摘要日志区分「为什么没复用」—— 验收标准: 上下文变化重建可辨识)
  const cands = []
  let why = "new"
  for (const [conv, v] of convs) {
    const rec = readRec(v)
    if (!rec.sig.length) continue
    let r = ""
    if (rec.quarantined) r = "quarantined"
    else if (rec.retired) r = "retired"
    else if (rec.busy > 0) r = "busy"
    else if (rec.acct !== reqAcct) r = "acct-changed"
    else if (rec.ctxKey !== reqCtxKey) r = "ctx-changed"
    else if (reqSession && rec.sessionKey !== reqSession) r = "session-mismatch"
    else if (!isPrefix(rec.sig, sig)) r = "history-diverged"
    if (r) {
      if (why === "new") why = r
      // 前缀不成立是唯一「本请求与它同身份但历史分叉」的拒绝原因 → 退役(决策 2);
      // quarantine/retired/busy/身份不符的不动(棘轮/临时态/本来就属于别人)
      if (r === "history-diverged") retire(conv, "history-diverged")
      continue
    }
    cands.push([conv, rec])
  }
  // 决策 3: 多候选不比较, 直接重建; 旧分支退役
  if (cands.length > 1) {
    for (const [conv] of cands) retire(conv, "branched")
    why = "branched"
  } else if (cands.length === 1) {
    const [conv, rec] = cands[0]
    const gap = sig.length - rec.sig.length
    const fresh = mine.slice(rec.sig.length)
    const freshBytes = fresh.reduce((n, t) => n + Buffer.byteLength(t.text, "utf8"), 0)
    if (gap > 0 && withinLimits(gap, freshBytes, rec, !!reqSession)) {
      // 这轮要发的工具结果里有报错 → 把「禁止原样重发」在当轮消息里重新钉一遍
      const errored = fresh.some((t) => t.role === "tool" && TOOL_ERR_RE.test(t.text))
      let text = fresh.map((t, i) => (t.role === "tool" && i === fresh.length - 1 ? `${t.text}\n\n${TOOL_REMINDER}` : t.text)).join("\n\n")
      if (errored) text += `\n\n${TOOL_ERR_REMINDER}`
      return { conv, text, sig, fullText, blocked, ctxKey: reqCtxKey, acct: reqAcct, sessionKey: reqSession, rebuildReason: "reuse" }
    }
    // 唯一候选但增量超限(消息数/体积/耗时) → 退役重建
    retire(conv, "stale-or-oversized")
    why = "stale-or-oversized"
  } else if (convs.size === 0) {
    why = "new"
  }

  const hist = turns
    .slice(0, -1)
    .map((t) => `<|${t.role === "tool" ? "user" : t.role}|>\n${t.text}`)
    .join("\n\n")
  const last = turns.length ? turns[turns.length - 1].text : ""
  const parts = []
  if (sysText) parts.push(`# 系统指令(必须遵循)\n${sysText}`)
  if (tools.length) parts.push(TOOL_PROTOCOL(tools))
  if (hist) parts.push(`# 对话历史(接续)\n${hist}`)
  parts.push(`# 本轮用户消息\n${last || "(空)"}`)
  // 重开会话时历史全量内联, 只看最近几条工具结果, 太久的报错不再提醒
  if (turns.slice(-6).some((t) => t.role === "tool" && TOOL_ERR_RE.test(t.text))) parts.push(TOOL_ERR_REMINDER)
  return { conv: "", text: parts.join("\n\n"), sig, fullText, blocked, ctxKey: reqCtxKey, acct: reqAcct, sessionKey: reqSession, rebuildReason: why }
}

// 清言 SSE 事件 → OpenAI chat.completion.chunk。
// 帧语义(抓包): part.content 元素 type ∈ think|text|image; part.status init=增量, finish=该 part 全量。
// 按 part 累积(不再假设只有一个 part), 末尾把漏发的正文/工具调用补齐。
class ChatglmSSE {
  constructor(model, opts = {}) {
    this.id = "chatglm-" + uuid32()
    this.model = model
    this.tools = Array.isArray(opts.tools) ? opts.tools : []
    // 报错过的调用指纹(translateRequest 从历史提取): 出站时防「原样重发刚报错的调用」
    this.blocked = opts.blockedCalls instanceof Set ? opts.blockedCalls : new Set()
    this.repeatNudged = false
    this.onChunk = opts.onChunk || (() => {})
    this.conv = ""
    this.text = "" // 已发出的正文(工具 JSON 不在内)
    this.think = ""
    this.raw = "" // 模型吐的全部 text(含工具 JSON), 结束时用来解析
    this.parts = new Map()
    this.mode = this.tools.length ? "probe" : "text" // probe: 先缓冲, 看是不是工具调用
    this.buf = ""
    this.finished = false
    this.roundDone = false
    this.holdEnd = false // 为 true 时 finish 帧只标记本回合结束, 不终结整条流(空转要续写一轮)
    this.error = null
    this.intervene = ""
    this.calls = null // 解析出的工具调用(非流式路径要用)
    this._started = false
    // ---- 终态 ----
    this.round = null // ROUND.*, end() 时一次性判定(权威); 判定后不再改
    this.finishReason = null // stop/tool_calls/length —— 摘要日志的 reason 字段
    this.upstreamFinish = false // 收到过事件级 status:finish(上游正常完成的唯一信号)
    this.outError = null // end() 判定为失败终态时, 由调用方翻成 HTTP 错误体或流内错误帧
    this.parseErrors = 0 // 单帧 JSON.parse 失败计数(与传输错误分开统计)
    this.idleTimeout = false // pump 读空闲超时标记(区分 AbortError 来源: 超时 vs 用户取消)
  }

  // 同一会话内再发一轮前调用: 解析只看这一轮的输出, 已发出的正文不回滚
  beginRound() {
    if (this.buf) { const b = this.buf; this.buf = ""; this.emitContent(b) } // 上一轮末尾还押着的正文先放出去
    this.roundDone = false
    this.raw = ""
    this.mode = this.tools.length ? "probe" : "text"
    this.upstreamFinish = false
    this.error = null
    this.intervene = ""
    this.round = null
    this.outError = null
    this.idleTimeout = false
  }

  // 外部(pump/handler)记终态: 只在尚未定局时生效, 已定局的失败不被后来的 EOF「洗白」
  markRound(status, detail) {
    if (this.round) return
    this.round = status
    if (status === ROUND.UPSTREAM_ERROR) this.error = detail || this.error || "上游返回错误"
    if (status === ROUND.INTERRUPTED) this.outError = { message: detail || ROUND_UNFINISHED[status], code: "stream_interrupted" }
    if (status === ROUND.INCOMPLETE) this.outError = { message: ROUND_UNFINISHED[status], code: "stream_incomplete" }
    if (status === ROUND.CANCELLED) this.outError = { message: ROUND_UNFINISHED[status], code: "cancelled" }
  }

  emit(delta, finish) {
    if (finish) this.finishReason = finish
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
    if (evt.status === "error" && !this.error) this.error = le?.intervene_text || "上游返回 error"
    if (evt.status === "intervene") this.intervene = le?.intervene_text || this.error || "内容因合规限制被拦截"
    // 事件级 status:finish 是「上游回合完成」的信号; 别和 part 的 status:finish(单 part 全量)
    // 以及下游 OpenAI 流结束标记混为一谈 —— 只有事件级的才算。
    if (evt.status === "finish") this.upstreamFinish = true
    for (const p of evt.parts || []) this.feedPart(p)
    if (evt.status === "finish" || evt.status === "intervene" || evt.status === "error") {
      // 上游明确错误/拦截: 先记终态再终结, error 帧里的内容不算成功回合
      if (evt.status === "error" || evt.status === "intervene")
        this.markRound(ROUND.UPSTREAM_ERROR, evt.status === "intervene" ? this.intervene : this.error)
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
    // 一次性定终态: 已记的失败优先; 否则见到过 finish 帧 = 完成; 什么都没有 = 不完整
    if (!this.round) {
      if (this.truncated) this.markRound(ROUND.TRUNCATED)
      else if (this.error || this.intervene) this.markRound(ROUND.UPSTREAM_ERROR, this.intervene || this.error)
      else if (this.upstreamFinish) this.markRound(ROUND.COMPLETED)
      else this.markRound(ROUND.INCOMPLETE)
    }
    const ok = this.round === ROUND.COMPLETED || this.round === ROUND.TRUNCATED
    // 上游错误/中断/不完整: 绝不当成功工具调用返回。只在完全没正文时补一句错误说明,
    // 已有正文(半截输出)就保留原样 —— 终态判定看 round, 不是搜正文里有没有「错误」。
    if (this.round === ROUND.UPSTREAM_ERROR) {
      const note = this.intervene || this.error
      if (note && !this.text) this.emitContent(`[chatglm] ${note}`)
      this.outError = { message: note || "上游返回错误", code: this.intervene ? "content_intervene" : "upstream_error" }
      return // 不发 finish_reason、不发 [DONE: 由调用方按 outError 收尾
    }
    if (!ok) {
      if (!this.text && !this.think) this.emitContent(`[chatglm] ${ROUND_UNFINISHED[this.round] || "本轮未完成"}`)
      return
    }
    // 只有正常完成才走工具调用路径; 截断/错误/中断/不完整的输出绝不伪装成合法调用
    const parsed = this.tools.length && this.round === ROUND.COMPLETED ? parseToolCalls(this.raw) : null
    let calls = parsed?.calls ?? []
    // 原样重发刚报错的调用: 混在新调用里就只丢重发的, 新调用照常执行;
    // 整轮都是重发则放行(续写轮只有一次, 已在 handler 里给过机会, 客户端每轮上限兜底)
    if (calls.length && this.blocked.size) {
      const kept = calls.filter((c) => !this.blocked.has(callKey(c.function?.name || c?.name, c.function?.arguments)))
      if (kept.length) calls = kept
    }
    if (calls.length) {
      // 校验: 名字在声明列表内、arguments 合法 JSON、参数过 schema。
      // 不合法的调用不能塞给 Agent(执行侧必炸), 把原始 JSON 当正文放行、按普通文本回答收尾。
      const bad = calls.map((c) => checkToolCall(c, this.tools)).find(Boolean)
      if (bad) {
        // 把「没被放行的原始调用」拼回正文, 让用户/Agent 看得见发生了什么, 而不是凭空少一段
        const rest = this.raw.startsWith(this.text) ? this.raw.slice(this.text.length).trim() : this.raw.trim()
        if (rest) this.emitContent((this.text ? '\n' : '') + rest)
        return this.emit({}, "stop")
      }
      // 整个 tool_calls 一次性给出(与 HelloGML 同策略: 解析要等正文收完才准)
      calls.forEach((c, i) => this.emit({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } }] }))
      this.calls = calls
      return this.emit({}, "tool_calls")
    }
    // 正常完成没有调用: 普通文本路径。被截断的报 length, 自然收尾报 stop。
    const note = this.intervene || this.error
    if (note && !this.text) this.emitContent(`[chatglm] ${note}`)
    this.emit({}, this.truncated ? "length" : "stop")
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
  // 级别参数: 正常摘要用 info, 故障路径保持 error(宿主面板按级别过滤)
  const log = (m, level = "error") => { try { client?.app?.log?.({ body: { service: "chatglm-auth", level, message: m } }) } catch {} }
  const DEBUG = !!process.env.CHATGLM_DEBUG // 排障: 打请求摘要与上游 SSE 帧样本(协议漂移时对照抓包用)

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

    // 宿主会话头: magpie/OpenCode 在每次对话前调用本钩子(input.sessionID 实测存在, 见设计文档 §11.1)。
    // 把 sessionID 注进请求头, loader.fetch 读回后立即删除 —— 头不出本机, 更不发清言。
    // 判 provider 用 providerID(modelID 实测为 undefined)。
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER || !input?.sessionID) return
      output.headers[SESSION_HEADER] = String(input.sessionID).slice(0, 128)
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
            const reqUrl = input instanceof Request ? input.url : String(input)
            const reqMethod = String(opts.method || (input instanceof Request && input.method) || "POST").toUpperCase()
            let openai = null
            let bodyParseError = null
            try { openai = JSON.parse(rawBody) } catch (e) { bodyParseError = e }
            // Chat Completions 的 POST 请求严格校验(P1-1): 坏 JSON / 缺 messages / 非数组 → 400。
            // 按路径+方法识别, 其他请求(GET 探测、非聊天端点)保持原有签名透传不变。
            const isChatPost = reqMethod === "POST" && /\/chat\/completions\/?$/.test(reqUrl.split("?")[0])
            const invalidRequest = (message, param) => new Response(
              JSON.stringify({ error: { message, type: "invalid_request_error", param: param ?? null, code: null } }),
              { status: 400, headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" } },
            )
            if (isChatPost) {
              if (bodyParseError || openai === null || typeof openai !== "object" || Array.isArray(openai))
                return invalidRequest("请求体不是合法的 JSON 对象", null)
              if (!Array.isArray(openai.messages))
                return invalidRequest(openai.messages === undefined ? "缺少必填参数 messages" : "messages 必须是数组", "messages")
            }
            if (!openai || !openai.messages) {
              // 网关偶发的非对话请求(探测/列表): 带签名透传
              const r = await fetch(reqUrl.startsWith("http") ? reqUrl : HOST + reqUrl, {
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
            // (先解析 model/effort: ctxKey 要含这两项, 必须在 translateRequest 之前)
            let model = openai.model || "glm-5.3-flash"
            let effort = ""
            const suffix = model.match(/:(low|high|max)$/i)
            if (suffix) { model = model.slice(0, -suffix[0].length); effort = suffix[1].toLowerCase() }
            effort = String(openai.reasoning_effort || openai.reasoningEffort || openai.effort || effort || "").toLowerCase()
            if (!EFFORTS.includes(effort)) effort = DEFAULT_EFFORT
            const mode = EFFORT_TO_META[effort]
            // 会话身份: acct=账号摘要; sessionKey=chat.headers 注进来的宿主会话头(读回即删, 不发上游)
            const acct = acctOf(c.token)
            const reqHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            const hostSession = String(reqHeaders.get(SESSION_HEADER) ?? "").trim()
            reqHeaders.delete(SESSION_HEADER)
            const sessionKey = hostSession ? sha256hex(`session:${hostSession}`).slice(0, 24) : ""
            const req = translateRequest(openai, tools, { acct, sessionKey, model, effort })
            if ((tc === "required" || (tc && typeof tc === "object")) && tools.length) {
              req.text += `\n\n# 强制\n本轮必须输出 {"tool_calls":[...]} 开始执行, 禁止纯文本回答。${tc?.function?.name ? `使用工具 ${tc.function.name}。` : ""}`
            }
            if (DEBUG) log(`chat <- msgs=${openai.messages?.length ?? 0} tools=${tools.length} effort=${effort} model=${model} conv=${req.conv || "(new)"} text=${req.text.length}ch`)
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

            // 取消状态: 调用方 abort(signal) 与下游断开(cancel()) 都收敛到这里。
            // 一旦置位, 延迟重试、空转续写、会话提交全部停止; 上游 fetch/reader/定时器随之释放。
            // sse 要先于取消桥接创建(同步 abort 路径会立刻调 onCancel)。
            const sse = new ChatglmSSE(model, { tools, blockedCalls: req.blocked })
            sse.holdEnd = true // finish 帧只标记回合结束; 空转/重发时还要补一轮
            // 请求遥测(第五阶段 G2): 关联键 + 计时; 全部字段为计数/时长/枚举, 无正文无凭据
            const reqId = uuid32().slice(0, 8)
            const t0 = Date.now()
            const tm = { firstFrameAt: 0, attempts: 0, upstreamStatus: 0 }
            const ctrl = new AbortController()
            let cancelled = false
            const onCancel = () => {
              if (cancelled) return
              cancelled = true
              sse.markRound(ROUND.CANCELLED)
              try { ctrl.abort() } catch {}
            }
            let detachSignal = () => {}
            if (opts.signal) {
              if (opts.signal.aborted) onCancel()
              else {
                opts.signal.addEventListener("abort", onCancel, { once: true })
                detachSignal = () => { try { opts.signal.removeEventListener("abort", onCancel) } catch {} } // G4: 收尾摘除, 不拖住请求闭包
              }
            }

            // 交付状态机(设计文档 §3): chosenConv 是请求开始就固定的隔离目标快照, 不依赖响应是否回 id。
            // settle 幂等 —— 一个请求在多阶段失败只处置一次(边界 3)。fetchIssued 区分 not_sent 与 delivery_unknown。
            const chosenConv = req.conv // "" = 新建
            let fetchIssued = false
            let settled = false
            const settle = (cls) => {
              if (settled) return
              settled = true
              if (cls === "completed") {
                if (sse.round === ROUND.COMPLETED && sse.conv) remember(sse.conv, req.sig, { acct, ctxKey: req.ctxKey, sessionKey: req.sessionKey })
                return
              }
              if (cls === "not_sent") return // 可证明未提交: 旧 conv 完好, 什么都不动
              // delivery_unknown: 复用请求隔离快照; 新建请求不写映射, 见过的 id 入 dirty
              if (chosenConv) quarantine(chosenConv, "delivery-unknown")
              else if (sse.conv) dirtyAdd(sse.conv)
            }
            // busy 覆盖整条上游流(§6.1): 选定复用即占用, settle 定局后/下游断开时幂等释放。
            // 语义是「拒绝复用」而非排队 —— 其他请求见 busy>0 走重建, 永不互相阻塞。
            if (chosenConv) busyAdd(chosenConv)
            let busyReleased = false
            const releaseBusy = () => {
              if (busyReleased) return
              busyReleased = true
              if (chosenConv) busySub(chosenConv)
              detachSignal() // G4: 请求生命周期到此为止
            }
            // 每请求摘要(第五阶段 G2): 一条 info 级结构化行, 区分六类终态与重建原因。
            // 字段全为 计数/时长/id/枚举 —— 零正文、零凭据(验收红线)。
            let summaryDone = false
            const summary = (status) => {
              if (summaryDone) return
              summaryDone = true
              const reason = sse.round === ROUND.COMPLETED || sse.round === ROUND.TRUNCATED
                ? (sse.finishReason || (sse.round === ROUND.TRUNCATED ? "length" : "stop"))
                : sse.round || "unknown"
              const rebuild = req.rebuildReason || "new"
              const ttfb = tm.firstFrameAt ? tm.firstFrameAt - t0 : -1
              log(`chat done id=${reqId} status=${status} conv=${chosenConv || "new"} reason=${reason} rebuild=${rebuild} ms=${Date.now() - t0} ttfb=${ttfb} retries=${Math.max(0, tm.attempts - 1)} upstream=${tm.upstreamStatus || "-"} in=${(req.fullText || req.text).length} out=${sse.text.length} think=${sse.think.length} calls=${sse.calls?.length ?? 0}`, "info")
            }

            // 一轮 = 一次上游流; 空转续写会再发一轮, 复用同一 conversation_id
            const startRound = async (text, convId) => {
              let res = null
              let err = null
              for (let attempt = 0; attempt < 2; attempt++) {
                if (cancelled) { const e = new Error("请求已取消"); e.cancelled = true; throw e }
                try {
                  fetchIssued = true // 一旦置位, 本请求至少提交过一次 → 之后取消不再算 not_sent
                  tm.attempts++
                  res = await fetch(`${HOST}/chatglm/backend-api/assistant/stream`, {
                    method: "POST",
                    headers: signedHeaders({ device: c.device, token: c.token, json: true, sse: true, requestId: reqId + uuid32().slice(8) }), // 前 8 位=日志关联键, 整体仍 32hex
                    body: glmBody(text, convId),
                    signal: ctrl.signal,
                  })
                  if (res?.status) tm.upstreamStatus = res.status
                } catch (e) {
                  err = e
                  res = null
                }
                if (cancelled) { const e = new Error("请求已取消"); e.cancelled = true; throw e }
                // 只重试「没建起来」的请求: 流已经开始就不能重来(会双份输出)
                if (res?.ok) {
                  // 风控/改版页也是 200: content-type 不是 SSE 就别当流收, 否则零输出会被误判成空转、白烧一轮续写
                  const ct = res.headers.get("content-type") || ""
                  if (ct && !/text\/event-stream/i.test(ct)) {
                    const t = await res.text().catch(() => "")
                    const e = new Error(/verify|captcha|slider|安全验证|滑块/i.test(t) ? "清言风控限流(返回人机验证页), 请降低请求频率后重试" : `清言返回非 SSE 响应(${ct}), 协议可能已改版`)
                    e.status = 502
                    e.signIn = "kept"
                    throw e
                  }
                  break
                }
                if (res && res.status < 500) break
                if (attempt === 0 && !cancelled) await sleep(1200)
              }
              if (!res) {
                log(`[${reqId}] stream fetch failed: ${err?.message ?? err}`)
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
              JSON.stringify({ error: { message: String(e?.message ?? e), type: "server_error", param: null, code: e?.code || (e?.status ? String(e.status) : "upstream_error") } }),
              { status: e?.status ?? 502, headers: { "content-type": "application/json", "x-magpie-sign-in": e?.signIn || "kept" } },
            )

            let first = null
            try {
              first = await startRound(req.text, req.conv)
            } catch (e) {
              // 建流阶段的失败(HTTP/网络/取消)统一成 OpenAI 风格错误体: 抛出去只能落到网关的兜底文案,
              // 客户端无法区分「被取消」与「服务端炸了」
              // 交付分类: 取消且从未发出 fetch → not_sent(旧 conv 不动); 其余(网络抛错/HTTP 错误/
              // 发出后才取消) → delivery_unknown(rejected 未实测, 保持空集)
              if (e?.cancelled) { settle(!fetchIssued ? "not_sent" : "delivery_unknown"); releaseBusy(); summary(499); return errorResponse({ status: 499, message: "请求已取消", code: "cancelled" }) }
              settle("delivery_unknown")
              releaseBusy()
              summary(e?.status || 502)
              if (e?.status || e?.message) return errorResponse(e)
              throw e
            }

            const keepHeaders = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-magpie-sign-in": "kept" }

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

            // 交付分类(§3.2): completed 提交; 取消且从未发出 fetch = not_sent; 其余一律 delivery_unknown
            // (rejected 集未实测保持空; TRUNCATED 也算 unknown —— 消息确定已接收但本轮悬挂, §3.4)
            const deliveryClass = () => {
              if (sse.round === ROUND.COMPLETED) return "completed"
              if (sse.round === ROUND.CANCELLED && !fetchIssued) return "not_sent"
              return "delivery_unknown"
            }

            // 一轮的 SSE 流进 sse; 回合结束(roundDone)就停, 不等连接关闭。
            // 读流异常记 interrupted、正常 EOF 但没完成事件记 incomplete —— 不再静默收尾。
            // G3: 读空闲超时 —— 半开连接(无帧无断)不再让 pump 无界等待; 0 = 禁用。
            const IDLE_MS = () => { const v = Number(process.env.CHATGLM_IDLE_TIMEOUT_MS || 0); return v > 0 ? v : 180_000 }
            const pump = async (res) => {
              const reader = res.body.getReader()
              const dec = new TextDecoder()
              let buf = ""
              while (true) {
                let value, done
                let timer = null
                try {
                  const read = reader.read()
                  timer = setTimeout(() => {
                    log(`[${reqId}] upstream read idle ${IDLE_MS()}ms, aborting stream`, "warn")
                    sse.idleTimeout = true
                    sse.markRound(ROUND.INTERRUPTED, `上游 ${IDLE_MS()}ms 无响应, 连接判死`) // 先定局: 之后 read 以 reject/EOF 结束都不改终态(markRound 先到先得)
                    try { ctrl.abort() } catch {} // 掐上游; read() 将以 reject/EOF 结束
                  }, IDLE_MS())
                  ;({ value, done } = await read)
                } catch (e) {
                  if (sse.idleTimeout) { /* 终态已由 timer 定为 interrupted, 这里只释放 */ }
                  else if (cancelled || e?.name === "AbortError") { sse.markRound(ROUND.CANCELLED) }
                  else {
                    log(`[${reqId}] stream read failed: ${e?.message ?? e}`)
                    sse.markRound(ROUND.INTERRUPTED, `读取上游流失败: ${e?.message ?? e}`)
                  }
                  try { reader.cancel().catch(() => {}) } catch {} // 尽力释放, 不 await(已损坏的 reader cancel 可能挂起/拒绝)
                  return
                } finally {
                  if (timer) clearTimeout(timer)
                }
                if (!tm.firstFrameAt && value) tm.firstFrameAt = Date.now() // G2: 首帧耗时
                if (done) break
                buf += dec.decode(value, { stream: true })
                let i
                while ((i = buf.indexOf("\n")) >= 0) {
                  const line = buf.slice(0, i).replace(/\r$/, "")
                  buf = buf.slice(i + 1)
                  if (line.startsWith("data:")) {
                    if (DEBUG) log(`sse <- ${line.slice(5, 410)}`)
                    let evt = null
                    try { evt = JSON.parse(line.slice(5).trim()) } catch (e) {
                      // 单帧解析失败 ≠ 网络失败: 计数并留样本, 继续读后面的帧
                      if (sse.parseErrors++ < 3) log(`[${reqId}] sse frame parse failed x${sse.parseErrors}: ${line.slice(5, 160)}`)
                      continue
                    }
                    sse.feed(evt)
                  }
                }
                if (cancelled) break
                // 退化输出(payload 原地打转)只收前一段就掐掉, 免得把网关和界面一起拖死
                if (sse.raw.length + sse.think.length > MAX_OUTPUT_CHARS) {
                  sse.truncated = true
                  sse.markRound(ROUND.TRUNCATED)
                  try { await reader.cancel() } catch {}
                  sse.end()
                  return
                }
                if (sse.roundDone || sse.finished) { try { await reader.cancel() } catch {} ; return }
              }
              // EOF(连接正常关闭): 没有正常完成事件就是 incomplete, 不当成功收尾
              if (!sse.finished) {
                if (!cancelled) sse.markRound(ROUND.INCOMPLETE)
                sse.end()
              }
            }

            // 这一轮没给出工具调用、正文也只是半句引导语 → 补一轮(只补一次)
            // 注意: 不能用 sse.calls —— 它在 end() 里才赋值, 而 holdEnd 下 end() 还没跑
            let retried = false
            const stalledRound = () => {
              if (retried || cancelled) return false
              // 已出终态(上游报错/中断/截断/不完整)就不自动续写 —— 错误轮续写只会再撞一次,
              // 还可能把半截输出重放成整轮双份
              if (sse.finished || (sse.round && sse.round !== ROUND.COMPLETED)) return false
              if (parseToolCalls(sse.raw)?.calls?.length) return false // 这一轮已经拿到调用, 不算空转
              if ((sse.text || "").trim().length > STALL_MAX_LEN) return false
              // 工具 JSON 写到一半: 原文里已经有调用痕迹, 解析却没成 → 让它重写一遍
              return TOOL_MARK.test(sse.raw) ? true : looksStalled(sse.text)
            }
            // 整轮都是「原样重发刚报错的调用」→ 补一轮点名提醒(与空转共用每请求一次的预算),
            // 续写后仍重发就放行, 由客户端的每轮调用上限兜底
            const repeatStalled = () => {
              if (retried || sse.repeatNudged || cancelled) return false
              if (sse.finished || (sse.round && sse.round !== ROUND.COMPLETED)) return false
              if (!req.blocked?.size) return false
              const calls = parseToolCalls(sse.raw)?.calls ?? []
              if (!calls.length || !calls.every((c) => req.blocked.has(callKey(c.function?.name || c?.name, c.function?.arguments)))) return false
              sse.repeatNudged = true
              return true
            }
            const retryRound = async (nudgeOverride) => {
              retried = true
              const nudge = nudgeOverride || (TOOL_MARK.test(sse.raw) ? TOOL_NUDGE_BROKEN : TOOL_NUDGE)
              let res = null
              try {
                res = await startRound(nudge, sse.conv || req.conv)
              } catch (e) {
                log(`[${reqId}] nudge round failed: ${e?.message ?? e}`)
                // 续写轮没发出去: 保留首轮结果由 end() 定终态
                // (首轮已收到 finish 帧就是完成回合, 不能被续写失败倒扣成 interrupted)
                return
              }
              sse.beginRound()
              await pump(res)
            }

            // OpenAI 语义: 默认非流式, 只有显式 stream===true 才流式(个别网关会传字符串 'true')
            const isStream = openai.stream === true || openai.stream === 'true'
            if (!isStream) {
              // 非流式: 聚合后回一个 chat.completion
              // G1: 收尾(settle/releaseBusy/summary)放 finally 必达 —— 意外异常不再泄漏 busy
              let httpStatus = 0
              try {
                await pump(first)
                if (stalledRound()) await retryRound()
                else if (repeatStalled()) await retryRound(TOOL_NUDGE_REPEAT)
                if (!sse.finished) sse.end()
                // 交付状态机: completed 提交前缀; 截断/错误/中断/不完整/流中取消 → 隔离快照; 未发出取消 → 不动
                settle(deliveryClass())
                // 失败终态不能伪装成成功的 chat.completion: 返回 OpenAI 风格错误体
                if (sse.outError) {
                  httpStatus = sse.round === ROUND.CANCELLED ? 499 : 502
                  return errorResponse({ status: httpStatus, message: sse.outError.message, code: sse.outError.code, signIn: "kept" })
                }
                const msg = sse.calls
                  ? { role: "assistant", content: sse.text || null, tool_calls: sse.calls }
                  : { role: "assistant", content: sse.text || `[chatglm] 空回复${sse.error ? `: ${sse.error}` : ""}` }
                httpStatus = 200
                return new Response(JSON.stringify({
                  id: sse.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, message: msg, finish_reason: sse.calls ? "tool_calls" : sse.truncated ? "length" : "stop" }],
                  usage: usageEstimate(),
                }), { status: 200, headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" } })
              } catch (e) {
                // 插件内部异常: 保守分类(已发出过 fetch → 交付不确定, 隔离快照), 降级为 500 错误体而非抛出
                log(`[${reqId}] internal error: ${e?.stack ?? e?.message ?? e}`)
                if (!sse.finished) { sse.markRound(ROUND.INTERRUPTED, `插件内部异常: ${e?.message ?? e}`); try { sse.end() } catch {} }
                settle(deliveryClass())
                httpStatus = 500
                return errorResponse({ status: 500, message: `chatglm 插件内部异常: ${e?.message ?? e}`, code: "internal_error" })
              } finally {
                releaseBusy()
                summary(httpStatus)
              }
            }

            // 流式: 清言 SSE → OpenAI chunk
            const wantUsage = openai.stream_options?.include_usage === true
            const enc = new TextEncoder()
            const sseData = (obj) => enc.encode("data: " + JSON.stringify(obj) + "\n\n")
            let ping = null
            const out = new ReadableStream({
              async start(sink) {
                sse.onChunk = (chunk) => { try { sink.enqueue(sseData(chunk)) } catch {} }
                // 心跳: deep_thinking 首字可 70s+, 中间层普遍 60-120s 空闲就掐; SSE 注释帧按规范被客户端忽略
                ping = setInterval(() => { try { sink.enqueue(enc.encode(": ping\n\n")) } catch { clearInterval(ping) } }, 15000)
                try {
                  try {
                    await pump(first)
                    if (stalledRound()) await retryRound()
                    else if (repeatStalled()) await retryRound(TOOL_NUDGE_REPEAT)
                  } finally { clearInterval(ping); ping = null }
                  if (!sse.finished) sse.end()
                  settle(deliveryClass())
                  try {
                    // 失败终态: 流内错误帧 + 关闭, 不发 [DONE] —— OpenAI 官方流式错误同此形态(HTTP 200 后 data 里带 error)。
                    // 已知限制: 个别只做「[DONE]=成功」字面判断的客户端可能仍把这次断开当结束; 但无 finish_reason + error 帧 + 无 [DONE],
                    // 已是纯 SSE 通道下能选的最可区分的方案(见 README「流内错误」)。
                    if (sse.outError) {
                      sink.enqueue(sseData({ error: { message: sse.outError.message, type: "server_error", param: null, code: sse.outError.code } }))
                      sink.close()
                      return
                    }
                    // 标准 OpenAI 流式 usage 尾块(choices 空), 仅客户端显式 stream_options.include_usage 时输出
                    if (wantUsage) sink.enqueue(sseData({ id: sse.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: sse.model, choices: [], usage: usageEstimate() }))
                    sink.enqueue(enc.encode("data: [DONE]\n\n"))
                    sink.close()
                  } catch {} // 下游已断开: cancel() 已记终态, 这里静默收尾
                } catch (e) {
                  // G1: 意外内部异常 —— 不裸抛成 broken stream; 保守分类 + 尽力发流内错误帧
                  log(`[${reqId}] internal error(stream): ${e?.stack ?? e?.message ?? e}`)
                  if (!sse.finished) { sse.markRound(ROUND.INTERRUPTED, `插件内部异常: ${e?.message ?? e}`); try { sse.end() } catch {} }
                  settle(deliveryClass())
                  try {
                    sink.enqueue(sseData({ error: { message: `chatglm 插件内部异常: ${e?.message ?? e}`, type: "server_error", param: null, code: "internal_error" } }))
                    sink.close()
                  } catch {}
                } finally {
                  releaseBusy() // 流式: 上游流生命周期到此为止(正常/异常/取消都经这里)
                  summary(200) // 流式 HTTP 状态固定 200, 结果由 reason 字段表达
                }
              },
              // 下游取消/断开: 记 cancelled、掐上游 fetch 与心跳, 不再重试与续写
              cancel() {
                onCancel()
                if (ping) { clearInterval(ping); ping = null }
                releaseBusy() // 幂等: 与 start 的释放二选一生效(下游先断开时 start 可能还挂在 pump)
              },
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
                  temperature: false, // 网页协议不暴露采样参数, 请求里的 temperature 被忽略 —— 不虚报
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
  ChatglmSSE, textOf, findBrowser, jwtIsGuest, browserFlow,
  normalizeTools, parseToolCalls, sliceJsonObject, looseJson, jsonClosed, renderTurn, estimateTokens,
  looksStalled, repairJson, TOOL_NUDGE, TOOL_NUDGE_BROKEN, MAX_OUTPUT_CHARS,
  callKey, failedCallKeys, TOOL_ERR_RE, TOOL_ERR_REMINDER, TOOL_NUDGE_REPEAT,
  ROUND, ROUND_UNFINISHED, checkToolCall, schemaErrors,
  convs, dirty, remember, quarantine, retire, dirtyAdd, newRecord, acctOf, ctxKeyOf, isPrefix, withinLimits, sweep,
  setLastSweepAt: (t) => { lastSweepAt = t }, // 测试钩子: 重置 sweep 节流窗口
  SESSION_HEADER, CTX_VERSION, GAP_MAX_WITH_SESSION, GAP_MAX_NO_SESSION, FRESH_MAX_BYTES,
  HOST, SIGN_SALT, ASSISTANT_ID, VARIANTS,
}
