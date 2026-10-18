<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="智谱清言 magpie/OpenCode 供应商插件: chatglm.cn 网页协议反代, 签名逆向、SSE 翻译、多轮会话映射、积分用量">
</p>

把 **智谱清言 (chatglm.cn) 网页版** 接入 [magpie](https://usemagpie.ai) / OpenCode 的供应商插件。逆向网页端协议,让任意 OpenAI/Anthropic 客户端通过本地网关用上清言的 GLM 模型,并显示积分余额、自动领取每日登录积分。

> ℹ️ 工具调用: 清言网页协议**没有 function calling 字段**,插件用「提示词协议 + 出站解析」把它模拟出来(见下),因此 ZCode / OpenCode 这类编码 agent 也能用;但可靠性取决于模型是否守协议,复杂任务仍建议用官方 [GLM Coding Plan](https://github.com/magpie-community/plugins)(社区插件 `@magpie-community/opencode-zcode-auth`)。

## 快速开始

```bash
magpie plugin add github:TIUCSIB/magpie-zpqy-web   # 或本地: magpie plugin add ./magpie-zpqy-web
magpie plugin login chatglm                         # 选一种登录方式(见下)
magpie provider test chatglm                        # 最小请求验证
```

登录后即可通过本地网关调用 `chatglm/glm-5.3`、`chatglm/glm-5.3-flash`:

```bash
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "authorization: Bearer magpie" -H "content-type: application/json" \
  -d '{"model":"chatglm/glm-5.3-flash","messages":[{"role":"user","content":"你好"}]}'
```

## 三种登录方式

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="登录与请求链路: 浏览器授权/游客一键/粘贴 Cookie 三种方式汇入同一账号体系, 请求经 magpie 网关统一转 OpenAI 格式后由插件签名转发到清言">
</p>

| 方式 | 体验 | 适合 |
|---|---|---|
| **浏览器授权**(推荐) | 插件自动拉起专属 Chrome/Edge 窗口,扫码登录后自动完成 | 真实账号积分 |
| **游客一键** | 零输入,秒登录 | 尝鲜(免费额度小) |
| **粘贴 Cookie** | F12 复制 `chatglm_token` 整串 | 无浏览器环境的兜底 |

浏览器授权的技术要点:Chrome 运行时 cookie 数据库被独占锁(实测连 `cp` 都读不动),且新版有 DPAPI/AES 加密——插件改为**自启一个带调试端口的专属 profile**,经 CDP `Storage.getCookies` 直接读浏览器内存,绕开文件锁与加密;判定登录成功的依据是 token JWT 里 `is_guest !== true`。不碰你日常浏览器的任何数据。

## 工作原理

插件的 `loader.fetch` 拦截 magpie 网关发出的 OpenAI Chat Completions 请求,翻译成清言协议,再把清言 SSE 流转回 OpenAI chunk:

| 项 | 值 |
|---|---|
| 对话端点 | `POST https://chatglm.cn/chatglm/backend-api/assistant/stream`(SSE) |
| 游客登录 | `POST /chatglm/user-api/guest/access` → token(约 2h;游客不可 refresh) |
| 真实登录 | 浏览器授权(CDP 读 cookie)或粘贴 cookie;`user/refresh` 自动续期 |
| 模型列表 | `GET /chatglm/agent-api/operation/detail?tag=available_models` |
| 积分用量 | `GET /chatglm/member-api/member/member_info`(`left_score` 以「分」计,÷100 显示) |
| 每日积分 | `POST /chatglm/member-api/member/daily_login_score`(usage 刷新时静默领取 +200) |
| **会话** | `conversation_id` 增量复用(实测完整历史内联会被忽略);首轮从响应提取新 conv id,历史断裂时回落为内联合并 |
| **工具调用** | 提示词协议模拟: 工具定义注入首条消息 → 出站解析成 OpenAI `tool_calls`(做法参考 [HelloGML](https://github.com/Hello-Application-XH/HelloGML)) |
| **签名** | `x-sign = md5("${x-timestamp}-${x-nonce}-<前端公开盐值>")` |
| 时间戳 | `Date.now()` 的 Luhn 校验位变换(倒数第 2 位 = 其余数字和 %10) |
| nonce | uuidv4 去横杠 |
| 必要头 | `app-name: chatglm`、`x-app-platform: pc`、`x-device-id`、`x-request-id`、`authorization: Bearer <token>` |
| SSE 语义 | `parts[].content[]` 的 `type: think\|text` 为增量,finish 事件重发该 part 全量;结束以 `status:"finish"` 为准,无 `[DONE]` |

**推理档位**:GLM-5.3 / GLM-Flash 各带三档 `low / high / max`(对应网页的 快速/深度/极致),声明为 magpie `variants`,在模型设置里勾选启用;请求时按 `reasoning_effort` 字段或模型 id 后缀(`chatglm/glm-5.3-flash:max`)映射到清言的 `chat_mode` + `reasoning_effort`。

## 工具调用

清言网页协议**没有接收外部工具定义的字段**(`messages` 只认 user / assistant 文本),所以插件用「提示词协议 + 出站解析」把它模拟出来 —— 这也是 [HelloGML](https://github.com/Hello-Application-XH/HelloGML) 等 2API 项目的通行做法:

```mermaid
sequenceDiagram
    participant A as ZCode / OpenCode
    participant P as 本插件
    participant Q as 清言
    A->>P: OpenAI 请求(带 tools)
    P->>Q: 工具清单与输出格式注入首条消息
    Q-->>P: 只吐一个 JSON(tool_calls 数组)
    Note over P: 流式缓冲 —— 判定是调用就整段吞掉,<br/>不让半截 JSON 漏进正文
    P-->>A: tool_calls 增量 + finish_reason 置为 tool_calls
    A->>P: 下一轮回填 role=tool 的执行结果
    P->>Q: 结果转成 user 文本, 复用同一 conversation_id
```

具体做法:

| 环节 | 处理 |
|---|---|
| 工具清单 | 注入到首条消息的「工具调用协议」段(名字 / 描述 / 参数 schema) |
| 历史回放 | assistant 的 `tool_calls` 按同样 JSON 格式回放,让模型看到自己该用的格式 |
| 工具结果 | `role: "tool"` 转成 `# 工具执行结果 … 返回:` 的 user 文本(清言只认 user/assistant) |
| 流式防漏 | 正文以 `{` / `[` / 围栏 / `<tool_call` 开头时先进缓冲,确认是调用就整段吞掉,否则原样放行 |
| 解析 | 主认 `{"tool_calls":[…]}`;顺带兼容代码围栏、JS 对象字面量(裸键/单引号/尾逗号)、裸单个调用、GLM 原生的 `<tool_call>` 标签 |
| 多行参数 | 模型把代码直接写进参数时常常不转义换行(那段 JSON 严格来说是非法的),解析前会把字符串里的裸换行/制表符补成 `\n` / `\t` |
| 空转续写 | 这一轮既没有工具调用、正文又只是「…一次做完：」这类半句引导语时,自动带上「你刚才只说了半句」的提示再发一轮(每请求最多一次),避免 agent 循环停在冒号上 |
| 选型纪律 | 协议写明: 按工具描述选型(本地操作别抓网页类工具)、调用报错后禁止原样重发、调用只写正文 —— 针对实测出现过的「连错三次 open_url 烧光每轮 3 次上限、整轮报废」 |
| 能力声明 | `tool_call: true`(config)/ `capabilities.toolcall: true`(provider)—— 否则客户端根本不会把工具发过来 |

**速度档位**:`低 / 高 / 最高` 对应清言的 快速 / 深度 / 极致(`chat_mode` + `reasoning_effort`)。客户端没选档位时按「低(快速)」发,想要更深的思考在模型设置里挑 `高` / `最高`(实测最慢能到 70s+ 才出正文)。

## 已知限制

- **工具调用是模拟的**: 可靠性取决于模型守不守协议。实测 GLM-5.3 / GLM-Flash 在 agent 循环里能稳定给出调用,但参数很复杂或描述含糊时仍可能解析失败;模型偶尔会把自己的调用"演"成文本。
- **引导语空转**: 模型有时只写一句「继续,三处编辑一次做完:」就结束这一轮,既不给调用也不给结论。插件会判定为空转并自动续写一轮(注入 `TOOL_NUDGE` 提示),仍不奏效时这一轮就只剩那句引导语 —— 再点一次「继续」通常就好了。
- **模型退化时会狂吐**: 实测出现过一次输出原地打转(上万帧、五十多万字)后上游直接报 `status: error`。插件会在 30 万字处截断并当错误收尾,不会再无限收下去。
- **会话映射是进程内内存态**: magpie 重启后历史会被"内联兜底"重放一次(质量略降但可用)。指纹按发出去的回合算,同一会话内复用;换了系统提示或历史被压缩会重开会话。
- **专属 profile 每次都要登录**: 浏览器授权用的是插件自己的干净 profile,不共享你日常浏览器的登录态——这是安全设计。
- **风控**: 请求过密会被清言返回滑块 HTML,usage 卡片会显示"风控限流中";建议保持 `maxConcurrency ≤ 2`。
- **附件/图像上传没接**: 图片消息的 `image_url` 会被忽略(声明里 `attachment: false`),HelloGML 那套文件上传还没搬过来。
- **协议会变**: 网页接口无稳定性承诺,盐值是前端硬编码;清言改版需重新抓包(方法见下)。
- **无签到按钮**: magpie 没有给社区插件渲染操作按钮的钩子,每日积分改为 usage 刷新时静默领取。

## 重新抓包 / 调试

1. Chrome 开 `chatglm.cn` → F12 Network → 发消息 → 找 `assistant/stream`。
2. 对照上表核对端点/头/请求体/SSE。
3. 签名函数在页面 `main.*.js` 里(搜 `x-nonce`),等价实现已在 `_internal.luhnStamp`。

## 测试

```bash
npm test              # 纯逻辑, 不联网: 工具调用解析/流式组装/会话复用 + 登录流程判定
npm run test:live     # 联网冒烟(用本机 magpie 已登录的账号, 会消耗少量积分)
```

`npm run test:live` 会走一遍: 带工具的请求 → 应回 `tool_calls`(不能漏 JSON 到正文)→ 回填工具结果 → 应复用会话并给出最终回答 → 普通对话回归。

```bash
# 端到端冒烟(游客身份, 需联网)
magpie provider test chatglm
```

## 发布

- npm: `npm publish`(建议加 scope 防重名),keywords 已含 `opencode auth plugin provider` 便于检索。
- 社区收录: 向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `registry.json` 提 PR。
- GitHub topic: 本仓库已可加 `magpie-plugin` 标签进入"非官方插件"页。

## 合规提示

本插件逆向的是清言**公开网页端**协议,用于个人自动化;请遵守智谱服务条款,勿用于转售 API 或高频滥用。

## License

[MIT](./LICENSE)
