# 第二阶段设计报告 v3：会话隔离与状态管理（决策合并版，可直接实施）

> 状态：**仅设计，未修改业务代码；未执行真实清言请求。** 本版把三项已确认决策与九条实现边界合并进 v2，形成实施基线。
>
> 基线：`fix/round-terminal-status` (eaf1d20, v0.4.0)。第一阶段终态、取消处理、错误语义与全部回归测试（111 toolcalls + 120 terminal + 9 browserflow）**原样保留**，是本版所有改动的回归门禁。
>
> 约束声明：不假定清言有幂等键/历史查询/事务回滚（U2 不依赖）；不宣称无会话标识时可彻底消除跨任务歧义（§7）；所有结论对应源码行号或本机可复查文件（附录）。

---

## 0. 版本变更摘要

**v1 → v2**（评审九点）：交付四分类取代「发送前失败=未落库」；复用六条件（sessionKey 不豁免前缀校验）；gap>8 双上限；acct 用完整标识摘要；并发「多候选即重建」；无头降级局限成文；ctxKey 结构化；截断轮隔离；T-N1..N9。

**v2 → v3**（三项决策 + 九条边界）：

| # | 新增/修订 | 位置 |
|---|---|---|
| 1 | **选择快照**：请求开始即固定 `chosenConv`，处置目标只认快照，不读响应 | §3.3 |
| 2 | **状态转换单次提交**：`settle()` 幂等，多阶段失败只处置一次 | §3.5 |
| 3 | **隔离单向棘轮**：quarantined/retired 不被任何后续请求（含 completed 的 remember）解除或复活 | §6.4, §9.2 |
| 4 | **并发不解除他人隔离**：处置只作用于自己的 chosenConv | §6.4 |
| 5 | **增量耗时保护**：`lastUsed` 超过 STALE_MS 不复用（消息数/体积之外的第三条上限） | §4.3 |
| 6 | **dirty/quarantined/retired 三态语义分离 + 各自容量/TTL + 清理顺序**（隔离记录过期=删除，永不「解封后当正常映射」） | §9.3 |
| 7 | 测试矩阵补 T-N10..T-N15；实施计划补每步验收标准 | §10, §11 |

---

## 1. 三项已确认决策（实施基线）

### 决策 1：不确定交付按「原请求目标」隔离

- 请求开始时记录实际选用的 conversation_id（`chosenConv`，可为 `""`）。
- `delivery_unknown` 时：`chosenConv` 非空 → 隔离**该条**（与响应是否回 id 无关）；`chosenConv` 为空 → 不写成功映射，若处置前从响应帧见过 conv id → 入 `dirty` 观察集（永不参与匹配）。
- 仅当**能证明未提交**（`not_sent`）或**有经协议证据验证的拒绝**（`rejected`，默认为空集，须步骤 0 实测）才保留旧会话直接复用。
- 网络异常、超时、连接重置等结果不明确 → 一律 `delivery_unknown`（保守）。
- `dirty`/`quarantined` 有容量上限与过期清理（§9.3）。
- 并发请求不得自动解除另一请求设置的隔离（§6.4）。

### 决策 2：所有匹配路径必须满足历史前缀校验

- sessionKey 只证身份，不证历史连续。
- 有无 sessionKey 都一样：复用前必须 `isPrefix(rec.sig, req.sig)`。
- 前缀不成立 → 退出旧映射，`retired:"history-diverged"`，内联完整历史建新会话。
- **禁止**用 `mine.slice(sent.length)` 跳过与已发送历史不一致的消息。
- gap>8 可放宽，但必须同时受**消息数、请求体积、耗时**三重保护（§4.3）。

### 决策 3：多候选一律重建

- 候选过滤：acct、ctxKey、sessionKey、历史前缀、busy、quarantined、retired 全部参与。
- 唯一合格候选 → 复用；**候选 >1 → 不比较谁更长/谁更新**，直接内联完整历史新建权威会话，旧候选标 `retired:"branched"`。
- retired 记录不再参与匹配，且不被并发请求的旧完成结果重新激活（§6.4、§9.2）。

---

## 2. 现有机制与缺陷（承 v1/v2，无变化）

`convs: Map<convId, md5hex[]>`（`index.mjs:525-533`）；匹配 `index.mjs:873-913`（全局扫描、仅内容前缀）；提交 `index.mjs:1459/1492`（仅 `ROUND.COMPLETED`）；api 登录 device 每请求随机（`index.mjs:128`）。

缺陷 D1（串会话）/D2（sys 不敏感）/D3（工具变更不重注入）/D4（不确定交付重发）/D5（并发无防护）/D6（多账号共享映射）；风险 R1-R4；不确定项 U1-U3；0.3.x 回滚红线（`git show ad9214d`）——均见 v2 §2，本版不再重复展开。

---

## 3. 交付状态模型（决策 1 的完整机制）

### 3.1 四态定义

| 状态 | 含义 | 判定依据 |
|---|---|---|
| `not_sent` | **能够证明**请求未提交上游 | 仅限：进入 `startRound` 前调用方已 abort（fetch 从未发出）；本地前置失败（不触网） |
| `rejected` | 有**经步骤 0 验证的**协议证据证明上游未接受本轮消息 | **默认空集**。实测前，HTTP 4xx/5xx 一律归 unknown |
| `delivery_unknown` | 可能已被接收，无法确认 | 网络层 fetch 抛错/超时/重置；HTTP 错误；非 SSE 响应；`status:error`/`intervene`；首帧前后断流；流中途取消；**截断轮** |
| `completed` | 正常完成并收到有效结束事件 | 第一阶段 `ROUND.COMPLETED` |

### 3.2 第一阶段终态 → 交付分类 → conv 处置（权威对照表）

| 触发点 | ROUND 终态 | 交付分类 | 对 chosenConv 的处置 |
|---|---|---|---|
| 正常 finish 帧 | COMPLETED | completed | `remember` 提交 sig（现状） |
| 超上限截断 | TRUNCATED | 已接收但本轮悬挂 | **quarantine** |
| `status:error`/`intervene` | UPSTREAM_ERROR | delivery_unknown | quarantine |
| read() 抛异常 | INTERRUPTED | delivery_unknown | quarantine |
| EOF 无完成帧 | INCOMPLETE | delivery_unknown | quarantine |
| fetch 前 abort | CANCELLED | not_sent | **不动**（旧 conv 完好可复用） |
| 流中途 abort/下游断开 | CANCELLED | delivery_unknown | quarantine |
| 建流 HTTP 错误/非 SSE | （未到 SSE） | delivery_unknown | quarantine |
| 建流 fetch 抛错 | （未到 SSE） | delivery_unknown | quarantine |

### 3.3 选择快照（决策 1 第 1 条）

```js
const chosenConv = req.conv            // translateRequest 返回即固定, "" = 新建
// 处置目标永远用 chosenConv; sse.conv(响应回传)只用于:
//   a) completed 时 remember 的 key(此时 sse.conv === chosenConv 或新 conv id)
//   b) 新建请求不确定交付时, 若 sse.conv 非空 → dirty.add(sse.conv)
```

复用请求即使响应一帧未回、id 未再现，chosenConv 在手 → 隔离对象确定。新建请求没有「已选会话」可隔离 → 不写映射，见过的 id 进 dirty。

### 3.4 隔离的恢复语义

quarantine 是**单向棘轮**：不存在「把隔离的 conv 解封后继续用」的路径。恢复 = 用客户端完整历史内联**新建**会话；未确认的消息不登记为已提交前缀。旧 conv 记录保留至 TTL 过期删除（§9.3），仅供 DEBUG 观察。代价声明：误隔离（实际未落库）的代价是一次全量内联；漏隔离（已落库却复用）的代价是消息在历史里重复——后者不可接受，故分类偏向保守。

### 3.5 状态转换单次提交（边界 3）

同一请求可能在多个阶段走到失败点（fetch 抛错 → retryRound 又抛 → pump 异常 → finally 收尾），处置**只允许发生一次**：

```js
let settled = false
const settle = (cls) => {              // cls: 'completed' | 'not_sent' | 'delivery_unknown'
  if (settled) return
  settled = true
  if (cls === 'completed') { if (sse.round === ROUND.COMPLETED && sse.conv) remember(sse.conv, req.sig, meta); return }
  if (cls === 'not_sent') return
  if (chosenConv) quarantine(chosenConv)
  else if (sse.conv) dirtyAdd(sse.conv)
}
// busy 释放同样幂等: releaseBusy() 带 released 标志, finally 与 cancel() 都调, 只减一次
```

`settle` 与 `releaseBusy` 由请求闭包持有；非流式在 pump+retry+end 后调用，流式在 `ReadableStream.start()` 的 finally 与 `cancel()` 中调用——两条路径共用同一对幂等原语。

---

## 4. 会话匹配算法（决策 2 的完整机制）

### 4.1 候选过滤六条件

```
合格(rec, req) ⟺
  1. rec.acct       === req.acct
  2. rec.ctxKey     === req.ctxKey
  3. !rec.quarantined && !rec.retired
  4. rec.busy       === 0
  5. req.sessionKey === "" ? true : rec.sessionKey === req.sessionKey
  6. isPrefix(rec.sig, req.sig)          // 对所有路径强制, sessionKey 不豁免
```

### 4.2 前缀不成立 → 全史重建

`sent` 不是 `sig` 的前缀（含压缩/裁剪致 sent 比 sig 长或中段分叉）：**禁止 `mine.slice(sent.length)`**；`retire(conv,"history-diverged")`；走现有内联兜底以客户端完整消息数组新建会话。

### 4.3 增量三重保护（决策 2 末条：消息数 + 体积 + 耗时）

| 保护 | 有 sessionKey | 无 sessionKey |
|---|---|---|
| 前缀 | 强制（4.1 条件 6） | 强制 |
| 消息数 | `fresh.length ≤ 64` | `gap ≤ 8`（保留 v1 启发式） |
| 体积 | `fresh 总字节 ≤ 512KB` | 同左 |
| 耗时 | `now - rec.lastUsed ≤ STALE_MS`（建议 30min，实施时以真实 agent 循环日志校准，可配置） | 同左 |

任一超限 → 不复用该 conv（重建，retire 原因按触发条件记）。长工具循环本身不再无条件丢弃有效映射（修订 v1 一刀切），但陈旧的映射（半小时没动过）也不被当作可信续点——上游 conv 可能已被清理，任务大概率已切换。

### 4.4 匹配主流程（伪代码）

```js
function match(req) {
  const cands = [...convs].filter(([id, rec]) => eligible(rec, req))
  if (cands.length === 0) return { conv: "", inline: true }
  if (cands.length > 1) {                       // 决策 3: 不比较, 直接重建
    cands.forEach(([id]) => retire(id, "branched"))
    return { conv: "", inline: true }
  }
  const [id, rec] = cands[0]
  const gap = req.sig.length - rec.sig.length
  if (!withinLimits(gap, rec, req)) { retire(id, "stale-or-oversized"); return { conv: "", inline: true } }
  return { conv: id, fresh: req.mine.slice(rec.sig.length) }   // 前缀已验证才允许 slice
}
```

---

## 5. 认证账号标识（承 v2 §5，无变化）

`acct = uid ? sha256("uid:"+uid).slice(0,16) : sha256("cred:"+md5hex(token)).slice(0,16)`。完整 uid 优先（`jwtIsGuest` 的 `p.uid || p.sub`，`index.mjs:313-321`）；**不用后 6 位**（1600 万空间可碰撞，T-N7）；退回凭据时 token 轮换 → acct 变 → 旧 conv 失效（安全优先的声明性取舍）；**禁用每请求随机 device**（`index.mjs:128`）；token/Cookie/完整认证字段不落任何日志。

---

## 6. 并发与分支收敛（决策 3 + 边界 1、2、4）

### 6.1 busy 覆盖整条上游流生命周期（边界 1）

```
busy++ : 选定 chosenConv 后、startRound 之前
busy-- : releaseBusy() 幂等(released 标志), 触发点 =
   非流式: pump + retry + settle 全部结束的 finally
   流式:   ReadableStream.start() 内 pump+retry+settle 的 finally
           ∪ cancel() 回调(下游断开)
```

v2「fetch 进出计数」作废——流式路径的 pump/retry/end 全部发生在 `ReadableStream.start()` 内（`index.mjs:1482-1508`），远晚于 `loader.fetch` 返回 Response。busy 归零必须晚于 `settle()`。

### 6.2 重叠请求的权威收敛（边界 2）

同一 sessionKey 出现重叠（A 复用 C0 在途、B 见 busy 重建 C1）后，**最后完成的请求无权指定权威会话**：A 的 completed 只把 sig 提交到 C0 的记录上（且受 §6.4 棘轮约束），不触碰 C1、不清除任何隔离/退役。下一条请求 C2 按 §4.4 执行——两条候选 → 重建 C2'，C0/C1 `retired:"branched"`。收敛靠「多候选即重建」这一确定性规则，不靠完成顺序。

### 6.3 拒绝复用而非排队（承 v2）

busy 语义 = 「该 conv 暂不可复用」，不等待、不加锁；方案 A（排队，428s 挂起预演）与方案 C（每请求新 conv，0.3.x 全量内联事故）仍被否决。跨 sessionKey 的匹配空间本就隔离，互不阻塞。

### 6.4 隔离棘轮与不复活（决策 1 末条 + 决策 3 末条 + 边界 4）

三条不变量，全部可测试：

1. **处置只作用于自己的 chosenConv**——请求的 `settle` 不遍历、不清除其他记录的任何状态；并发请求 A 的 completed 不会解除 B 刚对 C0 设置的 quarantine。
2. **`remember` 永不复活**：

```js
function remember(conv, sig, meta) {
  const prev = convs.get(conv)
  if (prev && (prev.quarantined || prev.retired)) return   // 棘轮: 隔离/退役是终局, 旧完成的写回被丢弃
  convs.set(conv, { ...freshRecord(meta), sig, lastUsed: Date.now() })
  sweep()
}
```

   场景：A 在 C0 上失败被隔离，同一 C0 上更早发出的重试请求随后 completed 并尝试 remember → 被拒。C0 保持隔离直至 TTL 清理。
3. **三态语义分离**（边界 4）：`dirty`（从未被本进程确认为己有的 id，仅观察，永不匹配）≠ `quarantined`（本进程曾选定的 conv，交付不确定，冻结复用）≠ `retired`（本进程主动退出的映射：历史分叉/分支/超限，终局退役）。三者都不可被匹配命中，但**来源、写入者、清理时钟不同**，实现上不得合并成一个布尔。

---

## 7. 无会话头降级的语义边界（边界 7，承 v2 §7）

**明确记录：无稳定 sessionKey 时，两个独立 Agent 任务共享相同用户消息前缀，本设计无法区分它们。acct + ctxKey 只保证同账号同环境，不保证同任务。跨任务串用风险只能收窄（quarantine/busy/多候选重建/gap 上限），不能根除。不存在「加指纹门控就彻底解决」的方案。**

无法区分的残留场景：任务 B 启动时 A 已 completed 且未隔离、B 前缀是 A 的 sig 的前缀延伸、B 增量 ≤8 条且 lastUsed 新鲜 → B 复用 A 的 conv。这是降级路径固有极限，README 必须成文。

T-S2 定位：断言**降级匹配始终可达**（0.3.0 红线）；T-N9 为**局限特征测试**（characterization）——断言复用确实发生并注明「非安全保证」。需要强隔离的环境应运行在 `chat.headers` 可用的宿主上（U1 实测通过后由 sessionKey 根除）。

---

## 8. ctxKey 结构化规范（边界 6，承 v2 §8）

```js
const ctxPayload = {
  v: CTX_VERSION,                    // 协议文本(TOOL_PROTOCOL/TOOL_REMINDER/renderTurn)变更时 bump
  sys: [{ role, text }, ...],        // system/developer 有序 + 角色边界
  tools: [{ name, description, parameters: canonArgs(schema) }, ...]  // 按名排序 + 键排序(canonArgs 复用 index.mjs:831)
  model, effort,                     // 影响上游上下文的生成配置
}
ctxKey = sha256(JSON.stringify(ctxPayload)).slice(0, 24)
```

JSON 序列化提供字段边界与顺序，**不做无边界字符串拼接**。不进指纹的单次参数：temperature/top_p/seed/max_tokens/stop/penalties（网页协议忽略）、stream/stream_options（传输方式）、tool_choice 模式值（每轮现拼强制文案，持久上下文由有效工具集表达）、user/metadata（无证据影响上游）。

---

## 9. 数据结构与生命周期（决策 1 清理条款 + 边界 9）

### 9.1 记录形状

```js
convs: Map<convId, {
  sig: string[], acct: string, ctxKey: string, sessionKey: string,
  busy: number,                    // §6.1
  quarantined: boolean,            // §3: 交付不确定冻结
  retired: string | null,          // "history-diverged" | "branched" | "stale-or-oversized"
  lastUsed: number,
  ts: number,                      // 进入 quarantined/retired 的时刻, 供 TTL
}>
dirty: Map<convId, number>         // id → 记入时刻; 观察集, 永不匹配
```

### 9.2 状态机（conv 记录级）

```
active ──settle(unknown)──▶ quarantined ──TTL──▶ 删除
  │                             ▲
  │──retire(原因)──▶ retired ────TTL────▶ 删除
  │                    （quarantined/retired 均为终局:
  ▼                    remember/任何请求不得复活, §6.4）
completed 提交 sig (仅 active 记录可被 remember 写)
```

### 9.3 清理策略与 LRU 顺序（边界 9：隔离记录不会被「洗白」回正常映射）

`sweep()` 在每次 `remember` 后与每 10 分钟定时执行，顺序固定：

1. **dirty**：删 `now - ts > 1h` 的条目；仍超 `DIRTY_MAX(48)` 按记入序淘汰。
2. **quarantined/retired**：删 `now - ts > QUARANTINE_TTL(24h)` 的**整条记录**——过期即删除，**不存在「到期解封变回可匹配」**。
3. **active**：按 `lastUsed` LRU 淘汰至 `CONV_MAX(48)`。

关键防线：淘汰与过期都只产生**删除**，不产生状态降级；新映射只能经 `remember` 以新 convId 进入（清言 id 唯一），而 `remember` 对同 id 的 quarantined/retired 记录直接拒写（§6.4 不变量 2）——「已隔离会话被重新插入为正常映射」在两条入口上都被封死。

---

## 10. 回归测试矩阵（合并版，全部 mock 确定性，不联网）

承 v2 的 T-S1..T-S14（T-S2/T-S7 定义见 §7/§5）与 T-N1..T-N9，本版新增 T-N10..T-N15：

| # | 场景 | 输入 | 预期 | 验证的风险 |
|---|---|---|---|---|
| T-N10 | 隔离不被他人解除 | A 复用 C0 → 失败隔离；B 随后在新 conv 上 completed | C0 仍 quarantined；C1 正常；C2 不复用 C0 | 决策 1「并发不得自动解除他人隔离」 |
| T-N11 | remember 不复活 | C0 隔离后，携带 C0 的旧请求迟到 completed 尝试提交 | sig 未写入；C0 保持隔离；该请求响应仍正常返回 | §6.4 棘轮 / 决策 3 末条 |
| T-N12 | 状态转换单次提交 | 构造 fetch 抛错 + retryRound 再抛 + finally 收尾的多阶段失败 | `settle` 生效一次（C0 只被隔离一次、ts 不被刷新）；`busy` 只减一次（不出现负数） | 边界 3 |
| T-N13 | 清理与淘汰顺序 | 灌入混合 active/quarantined/retired/dirty 超容量 | sweep 顺序正确；quarantined 过期=整条删除而非「解封保留」；未删除前同 id remember 被拒（§6.4 棘轮）；删除后同 id 可作**新记录**重入（清言 id 唯一，新条目≠解封） | 边界 9 |
| T-N14 | 耗时保护 | C0 前缀完全匹配但 lastUsed = now - 31min | 不复用；retire:"stale-or-oversized"；重建 | 决策 2「耗时保护」 |
| T-N15 | 快照与响应 id 不一致 | 复用请求（chosenConv=C0）断流前响应回了新 id C9 | 隔离对象是 C0；C9 入 dirty 不入映射；后续请求不匹配 C9 | 决策 1「不依赖响应」/ §3.3 |
| T-N16 | not_sent 保留复用 | C0 正常提交后，下一次复用请求在 fetch 发出前被 abort | C0 状态不变（不隔离不退役）；再下一次请求仍正常增量复用 C0 | 决策 1「可证明未提交才保留」 |
| T-N17 | 无头前缀不匹配 | 无 sessionKey，同 acct/ctxKey，sig 中段分叉 | 不复用；retire:"history-diverged"；重建（与 T-N1 对照：门控与 sessionKey 无关） | 决策 2「所有路径」 |
| T-N18 | 消息数/体积超限 | 有 sessionKey，前缀成立，fresh=65 条（或字节 >512KB） | 不复用；retire:"stale-or-oversized"；重建 | 决策 2「消息数+体积保护」 |
| T-N19 | ctxKey 规范化确定性 | 单元断言：同输入两次同 key；tools 数组乱序同 key；schema 键序不同同 key；sys 文本相同但角色边界不同（sys+developer vs 全 system）→ 不同 key；CTX_VERSION bump → 不同 key | 结构化输入生效，无拼接歧义 | 边界 6 |

覆盖对照（评审点八九项 → 用例）：有头前缀不匹配→T-N1；复用+fetch 错无新 id→T-N2；首帧前断流→T-N3；并发双完成后第三请求→T-N4；历史压缩→T-N1/N5；多候选同 sig→T-N6；uid 后 6 位碰撞→T-N7；流未结束 busy 不归零→T-N8；无头降级可达+局限→T-S2/T-N9。

### 10.1 决策/边界 → 用例追溯表（实现阶段的不变量清单）

| 不变量 | 来源 | 用例 |
|---|---|---|
| 隔离对象 = chosenConv 快照，与响应无关 | 决策 1 | T-N2, T-N15 |
| 新建不确定 → 不写映射，id 入 dirty 永不匹配 | 决策 1 | T-N3, T-N15 |
| 仅 not_sent/已验证 rejected 保留旧会话复用 | 决策 1 | T-N16 |
| 网络异常/超时/重置 → delivery_unknown | 决策 1 | T-N2, T4/T26(一阶段) |
| dirty/quarantined 有容量+TTL | 决策 1 | T-N13 |
| 并发不解除他人隔离 | 决策 1 | T-N10 |
| 前缀校验对一切路径强制（sessionKey 不豁免） | 决策 2 | T-N1, T-N17 |
| 禁止 slice 跳过不一致历史 | 决策 2 | T-N1, T-N5 |
| 增量三重保护：消息数/体积/耗时 | 决策 2 | T-N18, T-N14 |
| 候选 >1 不比较直接重建 | 决策 3 | T-N4, T-N6 |
| retired 不再匹配、不被旧 completed 复活 | 决策 3 | T-N11 |
| busy 覆盖整条上游流 | 边界 1 | T-N8 |
| 重叠请求不由最后完成者定权威 | 边界 2 | T-N4 |
| 状态转换单次提交 | 边界 3 | T-N12 |
| dirty/quarantined/retired 语义分离 | 边界 4 | T-N3, T-N13 |
| acct 用完整标识摘要 | 边界 5 | T-N7 |
| ctxKey 结构化无拼接歧义 | 边界 6 | T-N19 |
| 无头歧义如实记录不夸大 | 边界 7 | T-S2, T-N9 |
| 第一阶段测试原样保留 | 边界 8 | 全量门禁 |
| 隔离记录过期=删除，不被洗白回正常映射 | 边界 9 | T-N13 |

第一阶段 240 条测试为每步回归门禁；新增用例沿用 `test-terminal.mjs` 的 mock fetch/背压流/`glmCalls` 模式。

---

## 11. 实施步骤与验收标准

| 步 | 内容 | 版本 | 验收标准（全满足才可推 main） |
|---|---|---|---|
| 0 | 实测 U1（`chat.headers` 头是否转发到 fetch 侧 `init.headers`）+ 实测 rejected 语义（无效 token/风控错误后查会话列表是否产生新 conv） | — | 结论写入设计文档附录；头不可得 → 主路径降级为「acct+ctxKey+busy+quarantine 门控的前缀匹配」，§4.1 条件 5 恒真；rejected 未证实 → 保持空集 |
| 1 | 数据结构 record 化 + acct 摘要(§5) + ctxKey 结构化(§8) + 六条件匹配(§4.1) + 前缀强制与重建(§4.2) + sweep 框架(§9.3) | 0.4.1 | 第一阶段 240 条全绿；T-S3/S4/S5/S7 + T-N1/N5/N7/N13 绿；`translateRequest`/`remember` 默认参不破旧调用签名（旧测试零修改通过）；`test:live` 14/14 |
| 2 | `chat.headers` 钩子 + sessionKey 主路径 + 头不透传 + gap 三重保护(§4.3) | 0.4.2 | T-S1/S6/S14 + T-N1/N14 绿；上游 mock 断言收到的 headers 无会话头（T-S14）；live 冒烟无回归 |
| 3 | 交付四分类 + chosenConv 快照 + settle 单次提交 + quarantine/dirty + 截断轮隔离(§3) | 0.5.0 | T-S8/S9 + T-N2/N3/N10/N11/N12/N15 绿；第一阶段 T2/T4/T5/T9/T18/T24/T25/T26/T27（终态与不提交断言）全绿 |
| 4 | busy 全生命周期(§6.1) + 多候选重建(§4.4/§6.2) + retired 终局(§6.4) | 0.5.1 | T-S10 + T-N4/N6/N8 绿；并发用例中无请求互相阻塞（计时断言）；live 冒烟 |
| 5 | 文档收口：README 会话章节 + 无头局限成文(§7) + 已知限制清单更新 | — | T-S2/T-N9 特征测试入库；README 含「无法区分同前缀独立任务」原文级表述；不新增业务代码 |

每步独立可发布、可回滚；mock 测试先行；真实清言 `test:live` 验证后才推 main——延续第一阶段方法论，规避 0.3.x 大爆炸回滚。

### 11.1 步骤 0 实测结论（U1 已证实，2026-10-19）

用一次性探针插件（假 provider，`loader.fetch` 返回伪造响应，**不发任何真实上游请求**）经真实 magpie 网关验证，探针已卸载、日志已清理。原始记录：

```jsonc
{"ev":"chat.headers","inputKeys":["sessionID","agent","model","provider","message"],
 "sessionID":"da2795cd-2a1f-4e20-938d-b280d60318a5","model":"qoder-cn/undefined"}   // 经 magpie 内部 agent 触发
{"ev":"chat.headers", "sessionID":"magpie-931343f6fd83d1d18d77a18f","model":"probe/undefined"} // 经 /v1/chat/completions 触发
{"ev":"fetch","url":"http://127.0.0.1:9/chat/completions","probeHeader":"magpie-931343f6fd83d1d18d77a18f",
 "headerKeys":["accept","authorization","content-type","user-agent","x-probe-session"], ...}
```

结论：

1. **U1 成立**——`chat.headers` 钩子被 magpie 调用，`input.sessionID` 真实存在；插件在钩子里注入的 `x-probe-session` **确实出现在 `loader.fetch` 收到的 `init.headers` 中**（值等于 sessionID）。**会话头主路径可启用**（§4.1 条件 5 生效）。
2. **sessionKey 稳定且区分入口**：同一 ZCode 会话内多轮 `sessionID` 恒为 `da2795cd-…`；外部 HTTP 客户端则由网关分配 `magpie-<hex>`。两者都可直接作 sessionKey，无需二次派生（仍建议 `sha256` 摘要后存，避免原始 id 进日志）。
3. **`input.model.modelID` 为 `undefined`**，但 `input.model.providerID` 有值——`chat.headers` 里判断「是不是本 provider 的请求」要用 `providerID`（与 minimax/workbuddy 源码一致），不能依赖 modelID。
4. **rejected 语义未实测**（需真实清言请求，本轮约定不执行）→ §3.1 的 `rejected` 集**保持空**，一切非 completed 保守归 `delivery_unknown`。步骤 3 实施时如需启用 rejected，另做一次性实测并回写本节。

影响：步骤 2 的前置门（U1）通过；步骤 1 可立即开工（不依赖 U1）。

---

## 12. 设计决策摘要（一页版）

1. **交付状态**：`not_sent/rejected/delivery_unknown/completed` 四态；默认一切非 completed 皆 `delivery_unknown`（rejected 需实测证明后才启用）；网络异常/超时/重置一律保守归 unknown。
2. **隔离目标**：请求开始即快照 `chosenConv`；unknown 时隔离快照（复用）或不写映射+id 入 dirty（新建）；恢复永远走「完整历史内联新建」，不复用、不重发、不依赖上游幂等/回滚。
3. **匹配**：六条件（acct/ctxKey/未隔离未退役/无在途/sessionKey 一致/前缀成立）缺一不可，sessionKey 不豁免前缀校验；增量受消息数(≤64)、体积(≤512KB)、耗时(STALE_MS≈30min)三重保护；无头保留 gap≤8。
4. **并发**：busy 覆盖整条上游流（含 pump/retry/end/cancel，幂等释放）；拒绝复用而非排队；重叠后「最后完成者不定权威」，下一请求见多候选 → 不比较、直接重建，旧分支 `retired:"branched"`。
5. **状态纪律**：`settle` 每请求只提交一次；quarantined/retired 是终局棘轮——remember 不复活、他人不解除、过期只删除不解封；dirty/quarantined/retired 三态语义与清理时钟分离。
6. **身份**：acct = 完整 uid 的 SHA-256 摘要（refresh 换 token 映射存活），退回凭据摘要时声明轮换失效；禁 6 位截断、禁随机 device；凭据不落日志。
7. **ctxKey**：结构化规范对象（版本+角色边界+排序工具+model/effort）做哈希输入；单次参数（采样/stream/tool_choice 模式/user）明确排除。
8. **降级极限**：无 sessionKey 时同前缀跨任务串用不可根除，只能收窄；文档与特征测试如实记录。
9. **范围**：第一阶段终态/取消/测试原样保留；`translateRequest`/`remember` 加默认参渐进迁移；六步小步发布，每步带回归门。

---

## 附：证据索引

| 结论 | 证据 |
|---|---|
| 匹配仅内容前缀/无隔离 | `index.mjs:884-890` |
| sys 不进 sig | `index.mjs:875, 878` |
| 复用路径不重发工具协议 | `index.mjs:891-897` |
| remember 仅 completed 提交 | `index.mjs:1459, 1492` |
| convs 全局无账号作用域 | `index.mjs:525` |
| api 登录 device 每请求随机 | `index.mjs:128` |
| uid 完整提取可用 | `index.mjs:313-321`（`p.uid \|\| p.sub`） |
| schema 键排序可复用 | `index.mjs:831-838`（`canonArgs`） |
| tool_choice 过滤有效工具集 | `index.mjs:1233` |
| 流式 pump 在 ReadableStream.start 内（busy 依据） | `index.mjs:1482-1508` |
| 截断不提交映射（与 §3.4 隔离互补） | `index.mjs:1459/1492` + test-terminal T27 |
| 0.3.x 回滚红线 | `git show ad9214d` 提交信息 |
| chat.headers + sessionID 宿主契约 | 本机 `~/.config/magpie/plugins/node_modules/`：minimax L677-681 / workbuddy L1555-1558（"It goes no further"）/ trae L2781-2784 / zen-freex L476-495, 965-975 |
| maxConcurrency=2 | `package.json` magpie 段 |
