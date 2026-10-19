# 第五阶段审查报告：诊断日志 / 资源清理 / 故障测试覆盖（差距分析）

> 状态：**只读审查，未修改业务代码**。基线 = `origin/main` @ `63981cb`（0.4.2，四阶段已合并，CI 绿）。
>
> 本地实跑 `npm test` = **360 通过 / 0 失败**（111+168+72+9），与远端 CI 一致。未执行 `test:live`。
>
> 目的：对照第五阶段五项任务（诊断日志 / 故障注入 / 资源清理 / 性能退化观察 / 问题复现流程）与验收标准，找出**实际缺口**——前四阶段已解决的不重复列。所有行号对应当前 main。

## 0. 验收标准对照总览

| 验收标准 | 现状 | 差距 |
|---|---|---|
| 清晰区分：上游报错 / 传输中断 / 无结束帧 / 用户取消 / 输出截断 / 上下文变化重建 | **代码层已区分**（`ROUND.*` + `qreason` + `retired` 原因 + 错误 code），mock 测试已钉死 | **日志层未区分**：终态摘要只在 DEBUG 下输出，日常日志无结束原因/重建原因字段（§1） |
| 日志不含 Token/Cookie/完整提示词/敏感工具参数 | ✅ 现状合规（见 §1.3 审计） | 新日志设计必须维持此约束 |
| 测试以 Mock 为主，不频繁真实清言 | ✅ 360 条全 mock | 补的故障注入也全部 mock（§3） |

## 1. 诊断日志差距

### 1.1 现有日志面（全部经 `log()` → magpie 日志，L1276）

| 日志 | 触发 | 级别 | 观察期够不够 |
|---|---|---|---|
| `stream fetch failed` (L1525) | 建流 fetch 抛错 | error(硬编码) | 有，但无状态码/尝试次数 |
| `stream read failed` (L1592) | read() 抛异常 | error | 有 |
| `sse frame parse failed` (L1609) | 单帧坏 JSON | error | 有 |
| `nudge round failed` (L1664) | 续写轮建流失败 | error | 有 |
| `models failed` (L1788) / `browser flow failed` (L430) | 各自域 | error | 有 |
| `chat <-` / `chat ->` 摘要 (L1433/1689/1718) | 每请求 | **仅 DEBUG=1** | ❌ 日常不输出 |
| `sse <-` 帧样本 (L1605) | 每帧 | 仅 DEBUG=1 | 合理 |

### 1.2 缺口（任务 1 的五项遥测全部缺失）

| 要求项 | 现状 | 证据 |
|---|---|---|
| **请求耗时** | ❌ 无任何计时 | grep 全文无 elapsed/duration；`Date.now()` 只用于 Luhn 戳/记录时间戳/created |
| **上游首帧耗时** | ❌ 无 | pump 不记首帧时刻 |
| **重试次数** | ❌ 无 | `attempt` 只在 startRound 局部（L1493），失败时不进日志 |
| **结束原因** | ⚠️ 仅 DEBUG | `chat ->` 含 `round=` 但日常不可见 |
| **会话复用/重建原因** | ❌ 无 | `translateRequest` 的 conv/retire/quarantine 决策零日志；`qreason`/`retired` 字段存了但从不输出 |
| **上游 HTTP 状态** | ❌ 无 | 非 2xx 路径（L1520 `res.status < 500` break）不 log，错误体里带状态但日志无 |

**后果**：观察期（第四阶段收尾时定的「看隔离实效/内联频率/required 遵从率」）目前**只能靠开 `CHATGLM_DEBUG=1` 全量帧日志**——那个量级不适合常开。

### 1.3 敏感信息审计（现状合规，新日志必须保持）

- `log()` 全部消息：无 token/cookie/提示词正文/工具参数（只有长度、计数、conv id、错误 message）。
- `acct` 为摘要值（L948-952），`sessionKey` 为摘要（L1417）——可安全入日志。
- DEBUG 的 `sse <-` 帧样本（L1605）含模型输出内容——**仅 DEBUG 下存在，可接受但需在文档标注**。
- `x-request-id`（L88）每请求生成但**未入日志**——复现流程（任务 5）缺一个关联键。

### 1.4 建议的最小日志方案（实施阶段做，此处定形）

一条**每请求摘要**（替代现在的 DEBUG-only `chat ->`，无 DEBUG 也输出，字段化）：

```
chat done: id=<x-request-id 前8位> status=<HTTP码> conv=<复用id|new|quarantined|retired:原因>
  round=<终态> reason=<结束原因: stop|tool_calls|length|upstream_error|interrupted|incomplete|cancelled|rebuild:原因>
  ms=<总耗时> ttfb=<首帧耗时> retries=<attempt> in=<msgs> out=<chars> think=<chars> calls=<n>
```

- 复用/重建原因在 `translateRequest` 决策处记入 `req.rebuildReason`（`branched`/`history-diverged`/`stale-or-oversized`/`ctx-changed`/`new`），摘要行输出——**这直接满足验收标准「日志上能区分六类情况」**。
- 级别问题：`log()` 硬编码 `level:"error"`（L1276）——正常完成的摘要也是 error 级会污染日志面板。建议 `log(m, level)` 加参数，正常=info。
- 频率：每请求一行，与现有 `chat <-` 同量级，可常开。
- 隐私：全部字段为计数/时长/id 摘要/枚举原因，零正文零凭据。

## 2. 资源清理审查（任务 3）

逐项核对，**大部分路径已经干净**（前两阶段修过），残留 4 个真实缺口：

| 资源 | 获取点 | 释放点 | 判定 |
|---|---|---|---|
| 心跳 ping | L1709 | finally L1714 + cancel L1737 + 入队失败自清 | ✅ 完整 |
| reader | pump 各出口 cancel（L1595/1620/1624） | EOF 路径无需 cancel | ✅ 完整 |
| busy 标记 | L1485 busyAdd | 4 个出口全有 releaseBusy（L1550/1552/1683/1717/1738），幂等 | ✅ 完整 |
| AbortController/ctrl.signal | L1453 | GC 回收 | ✅ |
| 会话记录增长 | convs 48 + dirty 48 + quarantine/retired 24h 删除 | 见下 ⚠️ | 部分 |
| **`opts.signal` 监听器** | L1463 `addEventListener("abort", onCancel)` | ❌ **从不 removeEventListener** | **缺口 A** |
| **sweep 触发** | 只在 `remember()`（L609） | ❌ 无定时器、无读取路径触发 | **缺口 B** |
| **非流式异常路径的 settle/releaseBusy** | L1678-1683 顺序执行 | ❌ 无 try/finally：pump/retryRound 若抛意外异常，settle/releaseBusy 被跳过 | **缺口 C** |
| **流式 start() 的 releaseBusy** | finally 只清 ping（L1714），settle/releaseBusy 在 finally **之后**（L1716-1717） | ❌ pump 若抛意外异常，start 拒绝，releaseBusy 不执行（cancel 回调只在下游断开时来） | **缺口 D** |
| browserFlow `process.on("exit")` | L339 | ❌ 每次登录调用**累加一个全局监听器**，cleanup 后不移除 | 缺口 E（低频：登录次数级，非泄漏级） |

**缺口详解**：

- **A（监听器）**：长驻 magpie 进程中，每个带 signal 的请求给该 signal 挂一个闭包（含 sse/ctrl/chosenConv 引用）。signal 生命周期若比请求长（网关复用 AbortController），引用链拖住整请求状态。修复：`settle`/`releaseBusy` 时 `removeEventListener`，或 `AbortSignal.any`。一行级改动 + 无测试可达性（监听器不可观测）→ 修复时以代码审查为准，不强造测试。
- **B（sweep 惰性）**：低流量时段无 `remember` → 隔离/退役记录超 24h 仍在表里（不匹配、无正确性问题，纯内存驻留）；LRU 也只记 `lastUsed` 不淘汰——48 上限仍守住，**无增长风险**，但「24h 过期」的语义在无人写表时不兑现。修复：`translateRequest` 开头或每请求节流 `sweep()`（如 60s 一次），不引入定时器。
- **C/D（异常路径的 settle/releaseBusy）**：pump 内部已全捕获，正常不会抛；但 `retryRound`→`startRound` 的**非 cancel 异常**（如 glmBody 序列化）会冒出来。后果：busy 永久 +1（该 conv 从此不可复用，直到 24h sweep 删除——而 sweep 又因 B 惰性）+ 流式 start 拒绝→下游拿到 broken stream。**这是 A-D 组合里唯一可能影响功能的**：优先级最高。修复：两条路径的收尾包 `try { … } finally { settle(异常分类); releaseBusy() }`。
- **E（exit 监听器）**：每次登录 +1 个 no-op 闭包，量级无害。修复：cleanup 里 `process.off`，一行。

## 3. 故障注入测试覆盖（任务 2）

### 3.1 六类故障对照

| 故障 | 现有测试 | 判定 |
|---|---|---|
| 网络断开（read 抛异常） | T4/T26（非流式/流式 interrupted） | ✅ |
| 异常 EOF（无完成帧） | T5/T9/T25/T-N3/T-N15 | ✅ |
| 用户取消 | T13/T14/T15/T16/T-N16 | ✅ |
| 上游报错（status:error/intervene） | T2/T3/T8/T24 | ✅ |
| 流式输出截断 | T27（含流式 length+[DONE]） | ✅ |
| **长时间无响应（挂起）** | ❌ **零覆盖**——T14/T15 的 hang 是「取消驱动」的，不是「超时驱动」；**且实现里根本没有读空闲超时**（§2 缺口 F：deep_thinking 首字 70s+ 有 ping 保活下游，但上游半开连接无帧无断时 pump 永远 await） | **双缺口：代码无超时 + 测试无注入** |
| **上游 5xx** | ⚠️ 半覆盖——T30 测了 4xx 不重试；500→重试一次→仍 500→502 的**成功重试路径**（第一次 500 第二次 200）无测试 | 缺口 |

### 3.2 建议新增（全部 mock，对齐任务 2 清单）

| 测试 | 注入 | 断言 |
|---|---|---|
| F1 上游 5xx 重试成功 | script=[500, ok] | 两次 glmCalls、200 正常返回、日志 retries=1（§4 后） |
| F2 上游 5xx 重试耗尽 | script=[500, 500] | 502、不第三次请求 |
| F3 读空闲超时（随缺口 F 实现） | 首帧后挂起 N 秒 | interrupted、reader cancel、错误 code |
| F4 异常路径资源收尾（缺口 C/D） | retryRound 内注入意外抛错 | busy 归零、settle 生效（隔离）、响应为 502 非 broken stream |
| F5 sweep 节流（缺口 B） | 造过期隔离记录 → 走一次纯读取请求 | 记录被清 |

### 3.3 已确认无需补的

截断/取消/EOF/报错的**会话侧**（quarantine/dirty/棘轮/多候选）已由 test-session 72 条覆盖；错误态工具 JSON 由 T8/P0-1 覆盖。不重复。

## 4. 性能退化观察（任务 4）——现状不可观察

「频繁隔离→反复全史内联→上下文变长/延迟/积分」这条链，**当前没有任何日志或计数能回答**。需要两个低成本信号（随 §1.4 摘要行落地）：

1. 摘要行的 `reason=rebuild:<原因>` + `in=<字符数>`：内联重建次数与上下文规模趋势直接可读（重建时 `fullText` 长度即计费口径）。
2. 可选：进程内累计计数（quarantine 次数、rebuild 次数），随摘要行输出 `rebuilds=<n>`——不引入外部存储。

判定基线留给观察期：若 `rebuild:` 行占比 > 每请求 ~10% 或 `in=` 持续走高，再回头调 STALE_MS/TTL 或做 rejected 实测——**先测量后调参，不预先放宽隔离**（隔离保守是第二阶段的有意决策）。

## 5. 问题复现流程（任务 5）——缺关联键

现状：错误 message 无请求关联，同一请求的多条日志（fetch failed → read failed → parse failed）无法串起来。最小方案：

- `signedHeaders` 已生成 `x-request-id`（L88）但每请求体只生成一次在 header 构造处——把它提升到请求作用域变量，**摘要行与所有该请求的 log 带同一 `id=` 前缀**。
- 故障分类 ↔ 日志字段 ↔ 测试编号 的映射表写进本报告 §0/§3（已完成），未来 issue 按 `reason=` 值直接定位到测试用例与代码路径。

## 6. 差距清单与优先级（实施阶段按此顺序）

| # | 项 | 位置 | 优先级 | 类型 |
|---|---|---|---|---|
| G1 | 异常路径收尾包 try/finally（settle+releaseBusy 必达） | L1678-1683, L1714-1717 | **P0**（busy 卡死+broken stream） | 代码 |
| G2 | 每请求摘要日志（耗时/首帧/重试/结束原因/重建原因/HTTP 状态）+ `log` 级别参数 + `x-request-id` 关联 | L1276, pump, translateRequest | **P1**（验收标准主体） | 代码 |
| G3 | 读空闲超时（可配 `CHATGLM_IDLE_TIMEOUT_MS`，默认建议 180s，deep_thinking 首帧前有 ping 不代表上游活着） | pump read | **P1**（挂起=无界等待，T14 事故形态的超时版） | 代码+测试 F3 |
| G4 | signal 监听器释放（缺口 A） | L1463 | P1（长驻进程引用链） | 代码 |
| G5 | sweep 节流触发（缺口 B） | translateRequest 入口 | P2（无正确性影响） | 代码+测试 F5 |
| G6 | 5xx 重试路径测试 F1/F2 | 仅测试 | P2 | 测试 |
| G7 | browserFlow exit 监听器去重（缺口 E） | L339 | P2 | 代码 |
| G8 | README/文档：日志字段字典 + 复现流程说明 | docs | P2 | 文档 |

**明确不做**（避免过度工程）：外部 metrics、结构化日志库、日志级别配置系统、真实清言故障注入（积分成本）、per-account 遥测。

## 7. 未验证/不宣称项

- 挂起场景的**真实**上游行为（半开连接清言侧多久断）未实测——G3 的超时值以 mock 测试定行为、以观察期数据定参数。
- 监听器泄漏（G4）在 Node 层的实际影响程度未做堆测量——按正确性修复，不宣称性能收益。
- 摘要日志在 magpie 日志面板的呈现效果未验证（级别参数依赖宿主行为）。
