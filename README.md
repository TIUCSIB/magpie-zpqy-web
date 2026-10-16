# opencode-chatglm-auth

magpie / OpenCode 供应商插件: **智谱清言 (chatglm.cn) 网页版**。
通过逆向清言网页端协议实现 —— 已接入 magpie 网关(实测 `magpie provider test chatglm` 通过)。

## 安装与使用

```bash
magpie plugin add ./opencode-chatglm-auth     # 本地目录; 发布后 @you/opencode-chatglm-auth 或 github:user/repo
magpie plugin login chatglm                   # 选登录方式(见下)
magpie provider test chatglm                  # 最小请求验证
```

登录后模型为 `chatglm/glm-5.3`、`chatglm/glm-5.3-flash`(动态拉取,登录账号不同可能更多)。

## 三种登录方式

1. **真实账号 · 浏览器授权(推荐)** —— 插件自动拉起一个 Chrome/Edge 登录窗口(用插件专属的 profile,不碰你日常浏览器),你在窗口里扫码/手机验证码登录,插件通过 CDP 读到登录后的 `chatglm_token` 即完成。消耗你清言账号的真实积分。
   - 原理:浏览器运行时 cookie 数据库是独占锁的(实测连 `cp` 都读不动),所以不走文件,而是经 Chrome DevTools Protocol 的 `Storage.getCookies` 直接读浏览器内存里的 cookie —— 绕开文件锁与加密。判定"登录成功"的依据是 token 的 JWT payload 里 `is_guest !== true`,游客态会被继续等待。
   - 找不到浏览器、或调试端口被占用时会报错并提示改用方式 3。
2. **游客模式(一键)** —— 直接领一个 guest token,零输入,但免费额度很小、且不能 refresh。
3. **真实账号 · 粘贴 Cookie** —— 手动贴浏览器 `chatglm.cn` 的 cookie 整串(或其中的 `chatglm_token`)。当方式 1 不可用时的兜底。

> 真实账号 token 约 2 小时过期,插件的 `auth.refresh` 会用 `user/refresh` 自动续期(游客不能续)。清言没有对第三方开放的 OAuth 端点,所以无法像 WorkBuddy/zcode 那样走标准设备码授权 —— 浏览器授权是本插件自造的等价流程。

## 实现要点(逆向协议, 2026-10 实测)

| 项 | 值 |
|---|---|
| 对话端点 | `POST https://chatglm.cn/chatglm/backend-api/assistant/stream`(SSE) |
| 游客登录 | `POST /chatglm/user-api/guest/access` → `access_token`(约 2h; 游客不可 refresh) |
| 真实登录 | 浏览器授权(CDP 读 cookie)或粘贴 cookie;`user/refresh` 续期 |
| 模型列表 | `GET /chatglm/agent-api/operation/detail?tag=available_models` |
| 会话 | 请求体 `conversation_id`;**多轮只能增量复用会话**(实测把完整历史内联会被忽略), 首轮服务端返回新 conv id |
| **签名** | `x-sign = md5("${x-timestamp}-${x-nonce}-8a1317a7468aa3ad86e997d08f3f31cb")` |
| 时间戳 | `x-timestamp` = `Date.now()` 的 Luhn 校验位变换(倒数第 2 位 = 其余数字和 %10) |
| nonce | `x-nonce` = uuidv4 去横杠 |
| 必要头 | `app-name: chatglm`、`x-app-platform: pc`、`x-device-id`、`x-request-id`、`authorization: Bearer <token>` |
| SSE 语义 | 每事件一个 JSON;`parts[].content[]` 的 `type: think|text`(**都是增量**,finish 事件重发该 part 全量);结束以 `status:"finish"` 为准,无 `[DONE]` |

插件内部: `loader.fetch` 拦截 magpie 网关发出的 OpenAI Chat Completions 请求 → 翻译为清言请求(签名+会话映射)→ 把清言 SSE 转回 OpenAI `chat.completion.chunk` 流(推理内容放 `delta.reasoning_content`)。非流式(`stream:false`)自动聚合。

## 已知限制

- **不支持工具调用**: 清言网页协议没有"接收外部工具定义"的字段(实测带 `tools` 的请求, 工具被无视)。插件对带工具的请求**不做拦截、照常透传**: 普通聊天客户端顺带附的界面工具不影响使用; 但编码 agent(Claude Code 等)的系统提示会诱导模型用文本"演"假 tool_call, 输出无意义 —— 要 function calling 请用官方 API 或 GLM Coding Plan(社区已有 `@magpie-community/opencode-zcode-auth`)。
- **会话映射是进程内内存态**: magpie 重启后历史会被"内联兜底"重放一次(质量略降但可用)。
- **积分**: 游客额度小;真实账号(浏览器授权/粘贴 cookie)消耗清言积分。`auth.usage` 会读 `member_info` 显示积分余额,并顺带领取"每日登录 +200 积分"。
- **模型档位**: GLM-5.3 / GLM-Flash 各带三档推理 `low/high/max`(对应网页的 快速/深度/极致),在 magpie 模型设置里勾选启用;请求时按 `reasoning_effort` 或模型 id 后缀(`:high`/`:max`)映射到清言的 `chat_mode`+`reasoning_effort`。
- **自动签到按钮**: magpie 没有给插件渲染按钮的钩子(截图里 MiniMax 的"自动签到"是 magpie 对内置订阅自带的),社区插件做不到;本插件改为在 usage 刷新时静默领取每日登录积分。
- **风控**: 请求过密会被清言返回滑块 HTML(非 JSON),usage 会显示"风控限流中";保持 `maxConcurrency ≤ 2`。
- **协议会变**: 网页接口无稳定性承诺;`x-sign` 盐值是前端硬编码,清言改版需重新抓包(方法见下)。

## 重新抓包/调试指引

1. Chrome 开 `chatglm.cn` → F12 Network → 发消息 → 找 `assistant/stream`。
2. 对照 `index.mjs` 顶部注释的协议表核对端点/头/请求体/SSE。
3. 签名函数在页面 `main.*.js` 里(搜 `x-nonce`),等价实现已在 `_internal.luhnStamp`。

## 本地测试

```bash
# 纯函数 + 模拟网关端到端(需要联网, 游客身份)
node --input-type=module -e "
import { ChatglmAuthPlugin } from './index.mjs'
const p = await ChatglmAuthPlugin({ client: {} })
const a = await (await p.auth.methods[1].authorize()).callback() // methods[1] = 游客模式
const auth = { type:'oauth', access:a.access, refresh:a.refresh, expires:a.expires }
const L = await p.auth.loader(async () => auth)
const r = await L.fetch(L.baseURL+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'glm-5.3-flash',stream:true,messages:[{role:'user',content:'只回复两个字：收到'}]})})
console.log(r.status, (await r.text()).slice(0,300))
"
# 真实网关
magpie provider test chatglm
```

## 发布

- npm: `npm publish`(建议改名加 scope), keywords 保持 `opencode auth/plugin/provider` 便于检索。
- 社区收录: 向 <https://github.com/magpie-community/plugins> 的 `registry.json` 提 PR。
- GitHub: 仓库设置加 `magpie-plugin` topic 自动出现在"非官方插件"页。

## 合规提示

本插件逆向的是清言**公开网页端**协议, 用于个人自动化; 请遵守智谱服务条款, 勿用于转售 API 或高频滥用(建议保持 `maxConcurrency` ≤ 2)。
