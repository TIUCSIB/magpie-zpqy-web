# OpenAI 兼容性审查报告（第四阶段）

> 状态：**只读审查，未修改业务代码**。基线 = `origin/main` @ `966162a`（第二阶段 `ceee8d3` + 第三阶段 CI `a06d7ae` 均已合并，CI 在 main push 上实际运行 success/16s）。
>
> 审查范围 = 本项目声明的 Chat Completions 兼容面（README「OpenAI 兼容面」），不以复刻 OpenAI 全功能为目标。Responses API / 音频 / 图像不在范围内（客户端未表现出需要，仅记录为潜在额外需求）。
>
> 参考规范：[Chat Completions create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/streaming-events)。
>
> 测试证据：本地实跑 `npm test` = **111 + 120 + 72 + 9 = 312 通过 / 0 失败**（test-toolcalls / test-terminal / test-session / test-browserflow）。未执行 `test:live`，未消耗积分。

## 0. 兼容范围声明

本项目是清言网页协议的**有损代理**：上游没有 function-calling 字段、不返回 usage、不暴露采样参数。兼容目标因此是「对 magpie/OpenCode agent 循环足够正确」，而非「逐字段等价 OpenAI」。工具调用是提示词协议模拟（README 已声明），usage 是估算（已声明）。本报告核对的是：声明过的语义是否属实、未声明的行为差异是否会被客户端误读。

等级定义：**完整** = 行为符合目标语义且有测试；**部分** = 有限制/尽力而为；**不支持** = 无此能力；**未验证** = 无源码或测试证据。

## 1. 请求参数矩阵

| 参数 | OpenAI 预期 | 实际行为 | 源码 | 测试 | 等级 | Agent 影响 | 修复建议 |
|---|---|---|---|---|---|---|---|
| `model` | 必填，回显 | 解析 + `:low/:high/:max` 后缀剥离（L1395-1399）；**未知名不校验**，原样塞进 `selected_model` 由上游处置；响应回显**剥离后缀后的名字** | L1395 | T20(隐式) | 部分 | 未知模型时错误形态不可预测 | P2：响应回显请求原值 |
| `messages` | 必填 | 非数组→`[]`；**缺失/坏 JSON → 走非对话透传分支**（L1375-1388），以 GET/透传转发上游，不返回 400 | L1375-1388 | 无 | **部分（缺陷）** | 客户端发坏请求收到莫名 200/上游错误，难排障 | **P1**：`!messages` 且 method=POST 时返回 400 `invalid_request_error` |
| `stream` | 缺省=非流式 | 仅 `true`/`'true'` 走 SSE（L1653） | L1653 | T19/T20 | 完整 | — | — |
| `stream_options.include_usage` | 请求才发 usage 尾块 | 严格门控，尾块在 `[DONE]` 前（L1680/1708） | L1680 | T21 | 完整 | — | — |
| `max_tokens` / `max_completion_tokens` | 限制输出 | **完全未读取**（grep 零引用），静默忽略；README 已声明「收下忽略」 | — | 无 | 不支持（已声明） | 客户端期望截断生效→实际由模型自己定 | 无（保持声明）；可选 P2：文档区分两参数 |
| `temperature`/`top_p`/`seed`/`stop`/`n`/`response_format`/penalties/logprobs | 采样控制 | **完全未读取**，静默忽略（网页协议不暴露） | — | 无 | 不支持（已声明） | 见 §7 能力声明矛盾 | 见 P1-2 |
| `reasoning_effort` | minimal/low/medium/high | 接受 `low/high/max`（清言档位），**其他值静默降为 low**（L1399-1401）；也认模型 id 后缀 | L1399 | live[1] | 部分 | OpenAI 的 `medium`/`minimal` 会被当 low | P2：映射表补 medium→high 或文档声明 |
| `user` / `metadata` | 端用户标识 | 未读取（有意：ctxKey 设计明确排除） | L961 注释 | T-N19(反向) | 不支持（有意） | 无 | — |

### 消息角色与内容

- `system`/`developer`：都收，进 ctxKey 指纹时保留角色边界（L941-943），内联为「# 系统指令」。✅ 测试 [6][20]。
- `user`：文本正常；**数组 content 中非文本 part（image_url/file）被 `textOf` 静默丢弃**（L507-510）——`attachment:false` 已声明，但丢弃无告警。P2。
- `assistant`：`tool_calls` 按协议 JSON 回放（L885-899），测试 [5]。✅
- `tool`：渲染为「# 工具执行结果」文本；`tool_call_id` 参与文本但匹配靠 `failedCallKeys` 的三级兜底（id→name→首条，L926-940）。✅ 测试 [5][19]。
- 顺序：不校验（透传给清言的只有我方回合序列 + 内联史按原序渲染）。✅ 足够。

## 2. 工具调用矩阵

| 项 | OpenAI 预期 | 实际 | 源码 | 测试 | 等级 |
|---|---|---|---|---|---|
| `tools` 定义 | function schema | normalizeTools 吃 OpenAI+Anthropic 形状，脏条目丢弃（L692） | L692 | [4] | 完整 |
| `tool_choice: "none"` | 必不出调用 | tools=[] → 协议不注入 → **驱动层硬保证**：`parsed` 仅在 `this.tools.length` 时解析（L1208），工具 JSON 即使被模型吐出来也只作正文流出，不出 `tool_calls` | L1390/1208 | **无** | 完整（**缺测试**） |
| `tool_choice: "auto"` | 模型自决 | 默认路径 | — | [8][9] | 完整 |
| `tool_choice: "required"` | 必出≥1 调用 | **仅提示词强制**（L1409-1411「# 强制」文案）；模型不遵守 → 正常文本返回，无重试/无报错 | L1409 | **无** | **部分**——不能保证，README 未明示 |
| `tool_choice: {function}` | 限定并强制该函数 | 工具集过滤到该函数（L1392）+ 同款提示词强制；限定=协议里只有它（可靠），强制=尽力而为 | L1392 | **无** | 部分 |
| `parallel_tool_calls` | 允许/禁止并行 | **未读取**；模型协议本身允许一数组多调用 | — | [1]多调用 | 部分（忽略参数，行为恰好=并行开） |
| 多调用/重复调用 | — | 多调用支持；报错调用原样重发有黑名单拦截 | L1211-1215 | [21][22] | 完整 |
| 未知工具名 | 客户端 schema 外 | `checkToolCall` 拒 → 原始 JSON 拼回正文按 `stop` 返回 | L458 | T10 | 完整 |
| **非法 arguments** | 应拒绝 | **`toToolCall` 把解析不了的字符串参数静默转 `{}`**（L795：`looseJson(args) ?? {}`），若该工具 schema 无必填字段则通过 `checkToolCall` → **客户端执行一个空参数调用** | L795 | **无** | **缺陷 P0** |
| 参数分块重组 | 增量 delta | 本实现**单 chunk 给完整 arguments**（L1222），客户端拼接后必为合法 JSON；示例围栏/裸调用/JS 字面量均有解析兜底 | L1222 | [8][12][23] | 完整 |
| id 配对 | tool_call_id 闭环 | `call_<uuid>_<seq>_<i>` 生成；回放/匹配三级兜底 | L791-800 | [5][19] | 完整 |

## 3. 非流式响应矩阵

| 字段 | 实际 | 源码 | 测试 | 等级 |
|---|---|---|---|---|
| `id` | `chatglm-<uuid>`，与流式同形态 | L1673 | T1 | 完整 |
| `object` | `chat.completion` | L1673 | T1 | 完整 |
| `created` | unix 秒 | L1673 | T1 | 完整 |
| `model` | 剥离后缀后的 id（见 §1 缺陷） | L1673 | 无 | 部分 P2 |
| `choices[0].index` | 0 | L1674 | T1 | 完整 |
| `choices[0].message` | `{role, content, [tool_calls]}`；**无 `reasoning` 字段——思考内容在非流式路径丢失**（流式有 `delta.reasoning_content`） | L1668-1671 | 无 | 部分 P1 |
| `finish_reason` | stop / tool_calls / length 与实际结束原因一致；上游错误**不发**成功体（502 错误体） | L1674, L1663-1666 | T1/T2/T7/T27 | 完整 |
| `usage` | **估算**（CJK 1 字≈1 token；prompt 按客户端完整上下文计）——非精确值，README/卡片已声明 | L1541-1548 | T1 | 部分（诚实声明的估算） |
| 空回复 | content 为 `[chatglm] 空回复…` 字符串 | L1670 | 无 | 部分 P2（非标准但可辨） |

## 4. SSE 流式矩阵

| 项 | 实际 | 源码 | 测试 | 等级 |
|---|---|---|---|---|
| chunk 结构 | `id/object/created/model/choices[{index,delta,finish_reason}]` | L1131-1140 | T22 | 完整 |
| 同请求 chunk `id` 一致 | 是（实例固定） | L1122 | 无显式 | 完整（结构保证） |
| 首 chunk 带 `role` | 是（`_started`） | L1132 | T7 隐式 | 完整 |
| `delta.content` 累积 | 正常；工具 JSON 缓冲不漏半截 | L1186-1203 | [8][9][10] | 完整 |
| 工具调用增量形态 | 单 chunk 完整 arguments + index/id/type/name 齐全 | L1222 | [8]T23 | 完整 |
| `finish_reason` 位置 | 仅末 chunk 一次；错误路径**不发** | L1210/1214 | T24 | 完整 |
| `[DONE]` | 仅正常完成/截断路径；错误/取消不发 | L1710 | T2/T24/T25/T26 | 完整 |
| usage 尾块 | 门控 + 顺序正确 | L1708 | T21 | 完整 |
| 取消/上游错误/EOF/断流/截断 五态区分 | 各有专属终态与错误 code | L1198-1215, §3.2 表 | T4-T9/T24-T27 | 完整 |
| 流内错误策略 | HTTP 200 后 `data:{error}` + 关闭；**字面「[DONE]=成功」型客户端可能把断开当异常结束**（不会当成功）——已知限制成文 | L1700-1705, README | T24 | 部分（限制已声明） |
| 心跳 `: ping` 注释帧 | SSE 规范允许，注释帧应被忽略；未在真实 ZCode/magpie 长等待场景实测 | L1688 | 无 | 未验证 P2 |

## 5. HTTP 错误语义矩阵

| 情况 | 预期 | 实际 | 源码 | 测试 | 等级 |
|---|---|---|---|---|---|
| 请求体坏 JSON / messages 缺失 | 400 invalid_request | **透传分支转发上游**（形态不可预测） | L1375-1388 | 无 | **P1 缺陷** |
| 未知模型 | 400/404 model_not_found | 交给上游处置（实测行为未验证） | L1395 | 无 | 未验证 P2 |
| 上游 401/403 | 401 + 登录过期信号 | 透传状态码 + `x-magpie-sign-in: expired` | L1508-1513 | T2(形态) | 完整 |
| 上游 5xx | 502 | 一次重试后 502 错误体 | L1472-1496 | T4 | 完整 |
| 发送前取消 | 499 | 499 `code:cancelled` | L1529 | T13/T-N16 | 完整 |
| 读取中断 | 502 | `stream_interrupted` | L1560-1573 | T4/T26 | 完整 |
| 无完成帧 EOF | 502 | `stream_incomplete` | L1594-1597 | T5/T25 | 完整 |
| 输出截断 | 200 + length | 200/`length`（有效回答语义） | L1208/1674 | T27 | 完整 |
| 非法工具调用 | — | 200 + stop，原始 JSON 留在正文 | L1211-1217 | T10/T11 | 完整 |
| 内部异常 | 500 | 未捕获→抛出给网关兜底 | — | 无 | 部分 P2 |
| 错误体结构 | `{error:{message,type,param,code}}` | 一致；但 `type` 恒为 `server_error`（4xx 场景不精确） | L1516-1518 | T2/T3 | 部分 P2 |

## 6. 模型列表与能力声明核对

| 声明 | 位置 | 真实情况 | 判定 |
|---|---|---|---|
| `capabilities.temperature: true` | L1755 | temperature **完全未读取**，不生效 | **虚报 P1**（OpenCode 见 true 会暴露该设置项） |
| `capabilities.reasoning: true` | L1756 | think 帧透传为 `delta.reasoning_content` | 属实（非流式丢失见 §3） |
| `capabilities.toolcall: true` | L1758 | 提示词协议模拟，README 已声明 | 属实（带声明） |
| `attachment: false` / `input.image: false` | L1757/1759 | 与 `textOf` 丢图行为一致 | 属实 |
| `limit.output: 131072` | L46 | 上游不强制；插件侧保护是 **300k 字符**（≈超 131k tokens 的 CJK 量），二者不同源 | 语义混放 P2——字符守卫未被宣传为 token 限制（正确），但列表里 131072 只是路由元数据 |
| 模型 id `glm-5.3`/`glm-5.3-flash` | L38-41 | live 实测可调用（test:live 历史 14/14） | 属实 |
| 无独立 `/v1/models` 插件端点 | — | 列表由 `config`/`provider.models` 供网关；如实记录，未新增接口 | — |

## 7. 缺陷 / 风险 / 未验证汇总 + 修复清单

### P0（可能导致工具误执行）
- **P0-1 `toToolCall` 静默吞参数**（L795）：`arguments` 为非法 JSON 字符串时 → `{}`，schema 无必填字段即放行 → 客户端执行空参数调用（如 `bash {}`）。**修复**：coercion 失败时让该调用整体不合法（进 `checkToolCall` 的拒收路径），并补测试（输入 `{"name":"x","arguments":"{坏"}` → 不出 tool_calls）。

### P1（影响正常 agent 使用的兼容缺口）
- **P1-1 坏请求体不返 400**（L1375-1388）：POST 对话请求缺 `messages`/坏 JSON 被当「非对话探测」透传。**修复**：仅 GET/无 body 走透传；POST+坏 body → 400 `invalid_request_error`。测试：3 例（坏 JSON、messages 非数组、messages 缺失）。
- **P1-2 `temperature:true` 虚报**（L1755）：改 `false` 或在注释/README 对齐；与 §6 表一致化。测试：能力声明快照断言。
- **P1-3 `tool_choice:"required"` 无保证也无测试**：至少补测试钉死当前语义（强制文案已注入、模型未遵守时返回 stop 而非报错），README「OpenAI 兼容面」行加一句「required=尽力而为」。
- **P1-4 非流式丢思考**：`message` 无 reasoning 字段。修复可选（OpenAI 亦无标准字段）：至少文档声明「思考仅流式可见」。

### P2（低频/完善性）
- P2-1 响应 `model` 回显请求原值（含 `:max` 后缀）。
- P2-2 `reasoning_effort` 的 OpenAI 值（minimal/medium）映射表显式化。
- P2-3 非文本 content part 丢弃时 DEBUG 日志计数。
- P2-4 错误体 `type` 按状态码区分 `invalid_request_error`/`server_error`。
- P2-5 心跳帧在真实宿主的长等待实测（一次 live 观察即可）。
- P2-6 `limit.output` 与 `MAX_OUTPUT_CHARS` 的关系在 README 一句话说明。

### 未验证项（不宣称）
- 未知模型的上游实际行为；magpie GUI 内 `: ping` 心跳兼容性；`parallel_tool_calls:false` 需求场景（当前客户端未发送）。

## 8. 测试差距 → 最小回归测试（对应修复时补，全部 mock）

| 修复 | 最小新测试 |
|---|---|
| P0-1 | 非法 arguments 字符串 → 不出 tool_calls、正文含原文（并入 test-terminal 工具组） |
| P1-1 | 坏 JSON / messages 缺失 / messages 非数组 → 400 + `invalid_request_error` |
| P1-2 | provider.models 能力快照：temperature=false |
| P1-3 | tool_choice=required：上游给纯文本 → stop（非报错）；上游给调用 → tool_calls；`none`：模型吐调用 JSON → 只作正文 |
| P1-4 | 非流式含 think 帧 → 文档行为钉死（content 不含思考，或按修复方案断言） |

现有 312 条全部保持为回归门禁；本报告未修改任何测试与业务代码。
