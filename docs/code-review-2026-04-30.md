# 代码质量审核报告 · codex-gateway

- 审核范围：`apps/gateway`、`apps/admin-cli`、`packages/core`、`packages/provider-codex`、`packages/store-sqlite`、相关测试
- 审核日期：2026-04-30（v3.1 修订：再次吸收团队评审反馈）
- 审核人：Code Review (Claude)
- 审核口径：架构、冗余代码、冗余/职责模糊的函数、过大的函数与文件、虚假测试、其他常见质量问题

> v3.1 修订摘要（团队第三轮反馈）：
> - §8 撤回"`apps/gateway/src/index.test.ts` 间接覆盖 `CodexProviderAdapter.health` healthy 路径"的说法。该测试用的是 `FakeProvider`，不经过 `CodexProviderAdapter`；`health` 既无直接也无间接测试。
> - §3.1 对 "收窄接口至 `health + message + normalize`" 的建议补充澄清：当前运行时**没有任何** `provider.normalize(...)` 调用，`normalize` 仅在 `CodexProviderAdapter` 内部使用。两种处理方式（保留为 provider contract / 降级为 concrete adapter 内部方法）均合理，需团队权衡。
>
> v3 修订摘要（团队第二轮反馈）：
> - §0 总评的"最大 2,592 行"刷新为 2,609 行；§4 / §6.1 / §6.2 / §6.3 / §7.6 行号同步到当前工作树。
> - §7.3 撤回"`InMemoryCredentialRateLimiter` 仅影响 dev 路径"的判断——它在 `apps/gateway/src/index.ts:152` 与 `:168` 是默认实现，生产路径同样受影响。
> - §9 ROI 表的"240 → 80 行"过乐观估计已撤回，与上文 §2.1 的"约 240 → ~150 行"一致。
> - §8 "唯一覆盖空白"补全：死方法应是 `create / list / cancel / refresh` 四个；`health` 也无直接单测。
> - 附录 grep 命令收窄到 `*.test.ts` 与 `\.(skip|todo|only)\(` 等模式，避免命中 `skipObservation` / `skipRateLimit` / `skipGitRepoCheck` 这类业务字段名。
>
> v2 修订摘要（团队第一轮反馈）：
> - 重新统计了所有文件行数（v1 引用了过期快照）。
> - 撤回 `mergeAudit` 的合并建议——v1 引用的实现已被 `mergeAuditParams` 替代。
> - 修正"重复 helper"的归并位置——admin-cli 不依赖 gateway，应提到 `packages/core` 而非 import gateway 私有函数。
> - 修正 `/v1/chat/completions` SSE 骨架重复的范围——非流式分支并不重复 SSE 生命周期。
> - 修正"被迫实现 ProviderAdapter 桩"的对象——是 gateway 测试的 `FakeProvider`，不是 codex-adapter 测试的 `FakeClient`。

---

## 0. 总评

| 维度 | 现状 |
|---|---|
| 架构分层 | ✅ 清晰：核心契约在 `packages/core`，存储 / Provider / 网关分离合理 |
| 类型边界 | ✅ 严格：DB row → domain 有显式映射；StreamEvent / GatewayError 等核心类型集中 |
| 测试覆盖 | ✅ 真实集成：`":memory:"` SQLite + `execFileSync` CLI 子进程 + Fake Provider 驱动事件序列 |
| 虚假测试 | ✅ 未发现 `expect(true).toBe(true)`、`.skip` / `.todo`、空 `it()`、过度 mock 自身实现 |
| 巨型文件 | ❌ 5 个文件超 800 行，最大 2,609 行 |
| 重复实现 | ❌ 至少 7 组同名/同义 helper 跨文件复制 |
| 死代码 | ❌ `ProviderAdapter` 4 个方法 + 6 个相关类型在运行时无人调用 |
| 巨型函数 | ❌ `/v1/chat/completions` 处理器 ≈ 240 行，含两条平行分支 |

整体可发布，但**长期可维护性已经在恶化**。建议在下一轮迭代周期内按本报告的 ROI 排序逐步收敛。

---

## 1. 巨型源文件

按行数排序，下表只列 ≥ 800 行的非测试文件：

| 文件 | 行数 | 关注点 |
|---|---:|---|
| `apps/admin-cli/src/index.ts` | 2,609 | 命令注册、业务逻辑、加解密、序列化、参数解析全部混在一个文件 |
| `packages/store-sqlite/src/index.ts` | 2,436 | `SqliteGatewayStore` + `SqliteClientEventsStore` + 全部 row→domain 映射 + 迁移 SQL + 工具函数 |
| `apps/gateway/src/index.ts` | 1,538 | `buildGateway` 内联了所有路由、流式与非流式两条分支、运行时引导 |
| `packages/store-sqlite/src/token-budget.ts` | 931 | 限额计算 + 预留 + 软写 + 清理 + 列表，单文件单类 |
| `apps/gateway/src/openai-compat.ts` | 869 | OpenAI 解析、严格工具校验、SSE chunk 构造、JSON Schema 多 draft 选择全在一处 |

> 行数为 2026-04-30 当前工作树统计：`find apps packages -name "*.ts" -not -path "*/dist/*" | xargs wc -l | sort -rn`

### 建议拆分方案

- **admin-cli**：每个命令一个文件（`commands/issue.ts`、`commands/rotate.ts`…），共享 `audit-runner.ts`、`serializers.ts`、`parsers.ts`、`crypto.ts`。
- **store-sqlite**：`subjects.ts`、`access-credentials.ts`、`entitlements.ts`、`plans.ts`、`request-events.ts`、`sessions.ts`、`migrations.ts`、`row-mappers.ts`、`base-store.ts`。
- **gateway/index.ts**：`routes/` 目录拆每条路由（health/status/credentials/client-events/v1/sessions），把流式响应公共骨架抽成 `sse.ts`。

---

## 2. 巨型函数

### 2.1 `/v1/chat/completions` 处理器（约 240 行）
位置：`apps/gateway/src/index.ts:498-736`

问题（已根据团队反馈修正）：

- 处理器分**两条分支**：流式与非流式。
  - **流式分支**（`apps/gateway/src/index.ts:529-666`）自带 SSE 生命周期：心跳定时器、`abort`、`close` 监听、显式 `releaseRateLimit` / `recordObservation` / `finalizeTokenBudget`（因为 `reply.hijack()` 后 Fastify 的 `onResponse` 不会再跑）。
  - **非流式分支**（`apps/gateway/src/index.ts:668-735`）只有 `try / finally { finalizeTokenBudget }`，**不**重复 SSE 生命周期；释放速率限制与上报观测由 `apps/gateway/src/index.ts:241` 的 `onResponse` 钩子统一处理。
- 真正存在 SSE 骨架重复的是另两处：
  - 流式 chat completion (`538-549`)
  - `/sessions/:id/messages`（`761-859`）

  这两段心跳 / abort / close / releaseRateLimit / recordObservation / finalizeTokenBudget 的拼装代码近乎逐字相同。
- 流式 chat completion 内部对 provider 事件的循环（`message_delta` / `tool_call` / `error` / `completed`）与非流式分支等价但分别书写，是更小粒度的重复。

### 建议

抽出 2 个工具：

```ts
// apps/gateway/src/http/sse.ts
function setupSseResponse(reply: FastifyReply, opts: { onClose: () => void }): SseHandle;

// apps/gateway/src/services/provider-stream.ts
async function* runProviderMessage(...): AsyncIterable<StreamEvent>;
```

主要收益是消除 chat-completion 流式分支与 `/sessions/:id/messages` 之间的 SSE 骨架重复，以及让流式 / 非流式分支共用一份 provider 事件循环。处理器整体行数会下降，但**不会从 240 → 80** —— 那个估算建立在"两条分支完全对称"的错误前提上，实际更可能落在 240 → ~150。

### 2.2 `runStrictClientTools`（约 80 行）
位置：`apps/gateway/src/index.ts:888-970`

含两次 provider 调用 + 两次 `parseStrictToolDecision` + 三段几乎一致的 log 输出。重复读起来吃力。
建议提一个内联 helper 把"调用 + 解析 + log"合成一次。

### 2.3 `SqliteGatewayStore.reportRequestUsage` + `tokenUsageRows`
位置：`packages/store-sqlite/src/index.ts:789-982`

合计约 200 行：拼 SQL clause、跑 3 条不同的 GROUP BY 聚合、合并去重、再排序。建议抽出一个 `buildTokenUsageQuery(input)` 与一个 `mergeRows(...)` 纯函数，主方法只做编排。

---

## 3. 死代码与冗余抽象

### 3.1 `ProviderAdapter` 4 个未使用方法 ⛔
位置：`packages/core/src/provider-adapter.ts:19-29`

通过对整个仓库 grep `provider\.(create|list|cancel|refresh)\(`，**运行时无任何调用**，只有以下被实际使用：

- `provider.health(...)` — `apps/gateway/src/index.ts:266`
- `provider.message(...)` — gateway 多处

死代码副作用：

| 死代码 | 位置 |
|---|---|
| `CodexProviderAdapter.create` (约 30 行) | `packages/provider-codex/src/codex-adapter.ts:90-119` |
| `CodexProviderAdapter.list` | 同上，第 121-125 行（仅返回 `[]`） |
| `CodexProviderAdapter.cancel` | 同上，第 203-205 行（空体） |
| `RefreshResult / CreateSessionInput / CreateSessionResult / ListSessionInput / ProviderSession / CancelInput` 6 个类型 | `packages/core/src/types.ts`、`provider-adapter.ts` |
| `apps/gateway/src/index.test.ts` 中的 `FakeProvider` 被迫实现 `refresh / create / list / cancel` 4 个空桩 | `apps/gateway/src/index.test.ts:28` 起的类定义 |

> 注：`packages/provider-codex/src/codex-adapter.test.ts:29` 的 `FakeClient` 只实现 `CodexClientLike`（`startThread / resumeThread`），不受这些死方法牵连。v1 文档曾误把它列入受害者，已更正。

**强烈建议**：删掉这 4 个死方法及关联类型，等真正需要时再加。一次性删除，预估清理约 60 行代码。

> 关于 `normalize` 的归属（团队反馈）：
>
> 当前运行时**没有任何** `provider.normalize(...)` 调用——grep `\.normalize\(` 仅返回 `CodexProviderAdapter` 内部的 `this.normalize(...)`（`packages/provider-codex/src/codex-adapter.ts` 中 7 处）和 `codex-adapter.test.ts` 中针对 concrete adapter 的直接断言。换句话说，`normalize` 在 gateway 层并不是被消费的契约。
>
> 因此收窄接口时有两种合理选择：
>
> - **保留派**：把 `normalize` 视为 provider contract 的一部分（约定每个 provider 都必须暴露错误规范化），即便目前 gateway 不调用，未来若加入"Provider 异常上抛后由 gateway 统一映射"这种模式时无需再扩接口。此时收窄到 `health + message + normalize`。
> - **最小化派**：按"接口最小化"原则，目前没人调用就不该出现在公共契约里。把 `normalize` 降级为 `CodexProviderAdapter` 的 internal method（仍由单测直接覆盖），`ProviderAdapter` 接口收窄到 `health + message`。
>
> 本报告倾向最小化派，但这是设计决定，需团队权衡。

---

## 4. 重复实现（同名 / 同义 helper）

| 函数 | 位置 1 | 位置 2 | 备注 |
|---|---|---|---|
| `publicTokenPolicy` | `apps/admin-cli/src/index.ts:2185` | `apps/gateway/src/services/token-budget-hook.ts:205` | 几乎逐字相同 |
| `publicTokenUsage` | admin-cli:2195 | token-budget-hook.ts:228 | 同义 |
| `publicTokenWindow` ↔ `publicWindowUsage` | admin-cli:2204 | token-budget-hook.ts:247 | 内容一致，仅命名不同 |
| `runInTransaction<T>` | `packages/store-sqlite/src/index.ts:2078` | `packages/store-sqlite/src/token-budget.ts:852` | **同包**内两份完全相同实现 |
| `nonNegativeInteger` | `packages/store-sqlite/src/token-budget.ts:828` | `packages/core/src/token-budget.ts:155` | 同义 |
| `isRecord` | `apps/gateway/src/openai-compat.ts:854` | `apps/gateway/src/client-events.ts:276` | 完全一致 |
| `parsePositiveInteger` 系列 | `apps/admin-cli/src/index.ts:2522+` | `apps/gateway/src/index.ts:1361` (`parsePositiveIntegerEnv`) | 略有差异但可统一 |

**建议**（已根据团队反馈修正）：

- `admin-cli` 当前依赖只有 `@codex-gateway/core` 与 `@codex-gateway/store-sqlite`（见 `apps/admin-cli/package.json`），**不应**反向 import `apps/gateway` 的私有 helper。共享的 DTO 序列化函数（`publicTokenPolicy` / `publicTokenUsage` / `publicTokenWindow` 等）应统一提到 `packages/core` 或新建一个 `packages/serializers` 这类共享模块，再由 gateway 与 admin-cli 各自 import。
- `runInTransaction` 是 `store-sqlite` 内部基础设施，提到 `packages/store-sqlite/src/sql.ts` 即可，不必跨包。
- `nonNegativeInteger`、`isRecord` 适合放 `packages/core/src/utils/`。

---

## 5. 引导样板重复 — store-sqlite 双类

`SqliteGatewayStore` 与 `SqliteClientEventsStore` 各自持有一份完全相同的引导代码：

| 代码段 | SqliteGatewayStore | SqliteClientEventsStore |
|---|---|---|
| 构造函数文件权限保护 | `packages/store-sqlite/src/index.ts:69-78` | `1690-1701` |
| `configure()`（PRAGMA） | `1323-1326` | `1756-1759` |
| `applyMigration` | `1608-1632` | `1810-1829` |
| `tightenFilePermissions` | `1660-1670` | `1831-1841` |

合计约 50 行可消除。建议抽 `class BaseSqliteStore` 或 `function openManagedSqlite(opts)`。

---

## 6. 职责模糊的函数

### 6.1 admin-cli 凭据查找的多个变体

`apps/admin-cli/src/index.ts` 中存在 4 个互相调用的查找函数：

| 函数 | 行 | 行为 |
|---|---:|---|
| `resolveTokenPolicyCredential` | 2235 | 必须有 token policy 才返回 |
| `resolveTokenWindowPolicy` | 2308 | 顶层入口；先 entitlement，再回退 token policy 凭据 |
| `firstActiveCredential` | 2339 | 任意 active 凭据 |
| `resolveCredentialForUser` | 2352 | 按 prefix 取且必须属于该 user |

读 `resolveTokenWindowPolicy` 时要追到上面三个才能理解 entitlement vs legacy 的回退顺序。

**建议**：合并成一个返回 `{credential, entitlementId, policy}` 的入口函数，把分支收拢到一处。

### 6.2 `assertCanIssueCredentialForEntitlement` 双 throw 难读
位置：`apps/admin-cli/src/index.ts:1828-1850`

```ts
if (access.status !== "legacy" && !bypass) { throw ... }
if (process.env.GATEWAY_REQUIRE_ENTITLEMENT === "1" && !bypass) { throw ... }
```

第一段已覆盖大多数非 legacy 情况；第二段只在 legacy + 环境变量打开时生效。建议改为决策表 / Result 返回，再决定是否抛错。

### 6.3 `resolveUserId` 的隐式默认耦合
位置：`apps/admin-cli/src/index.ts:1853-1860`

通过比较 `options.subjectId !== defaultSubjectId` 判断是否冲突——这意味着用户**无法**显式 `--subject-id subj_dev` 与 `--user` 同时使用。
建议借助 commander 的 `option.source` 或维护"用户是否显式传入"的 sentinel。

### 6.4 `markTokenFinalizeResult` 把 finalTotalTokens 当估算
位置：`apps/gateway/src/http/observation.ts:67-71`

```ts
if (!request.gatewayTokenUsage && result.finalTotalTokens > 0) {
  request.gatewayEstimatedTokens = result.finalTotalTokens;
  request.gatewayTokenUsageSource = ... ;
}
```

"final"（含 reserve 收费）写入 `estimatedTokens` 字段，再以 `provider`/`reserve` 作为 source 上报，把"实际计费"与"估算"两类语义糅在一起。建议拆成两个字段或加注释。

### 6.5 `recordObservation` 的 `usageSource` 三元难读
位置：`apps/gateway/src/http/observation.ts:133-136`

```ts
usageSource: tokenUsage || request.gatewayTokenUsageSource
  ? request.gatewayTokenUsageSource ?? "provider"
  : null
```

应改成显式 if/else 或工具函数，并补注释说明"usage 来自 provider 时为何还要回退 'provider'"。

### 6.6 `SqliteGatewayStore.upsertSubject` 不更新 state
位置：`packages/store-sqlite/src/index.ts:85-103`

`ON CONFLICT` 故意不更新 state（被测试 `does not reactivate disabled subjects during credential bootstrap` 覆盖），但 INSERT 时仍 bind 了 `subject.state` 与 `created_at`，第一眼看不出意图。
建议改名 `upsertSubjectIdentity` 或拆成 `bootstrapSubjectIfMissing` + `updateSubjectMetadata`。

### 6.7 `chatMessagesToPrompt` 的消息附加逻辑重复
位置：`apps/gateway/src/openai-compat.ts:181-194` vs `651-666` 的 `appendMessages`。两处实现等价。让 `chatMessagesToPrompt` 也走 `appendMessages` 即可。

---

## 7. 设计 / 性能 / 可读性

### 7.1 `selectToolSchemaValidator` 重复编译
`apps/gateway/src/openai-compat.ts:629` 在 `parseToolDefinitions` 里调用 `compileSchema` 校验一次（编译丢弃），紧接着每次工具调用又调用 `validateAgainstToolSchema`（再 compile 一次）。
Ajv 的 `compile` 对**已添加过的 schema** 才会复用编译；对内联匿名 schema 仍会重复构建 AST。
建议加 `WeakMap<schema, ValidateFunction>` 缓存。

### 7.2 `stableJson` 名称误导
`apps/gateway/src/openai-compat.ts:846` 命名 `stableJson` 但只是 try/catch 包装的 `JSON.stringify`，并未对 key 排序。给 LLM prompt 用，会让人误以为已规范化。改名 `safeJson` 或真正实现稳定序列化。

### 7.3 `InMemoryCredentialRateLimiter` 状态永不回收
`apps/gateway/src/services/rate-limiter.ts:29` 的 `states` Map 只增不减；长期运行会留住已撤销/过期凭据的窗口状态。

修正 v1 误述：这并非"dev 路径"专属问题。`apps/gateway/src/index.ts:152` 与 `apps/gateway/src/index.ts:168` 都默认实例化 `InMemoryCredentialRateLimiter`（用于请求级与 client-events 速率限制），生产环境**不会**自动切到 SQLite 实现——只有显式注入 `options.rateLimiter` / `options.clientEventsRateLimiter` 才会绕开它。因此**默认运行路径（含生产）也受影响**。
建议加 LRU 或在 release 时清理已过 1 天未访问的 state。

### 7.4 `CodexProviderAdapter.health` 仅看文件存在性
`packages/provider-codex/src/codex-adapter.ts:60-74` 仅检查文件存在性即返回 healthy。
这与"凭据有效"完全不是一回事。短期不改的话，至少加注释 `// phase 1: approximate healthy by auth.json existence`。

### 7.5 SQL 列名串重复 3+ 次
`packages/store-sqlite/src/index.ts` 中 `access_credentials / entitlements / request_events / token_reservations` 的 `SELECT` 列名各重复多份。
`packages/store-sqlite/src/token-budget.ts:868` 已抽出 `reservationColumns()`，其他表照办即可。

### 7.6 状态枚举的 `||` 串
`apps/admin-cli/src/index.ts:2485-2513` 中 `parseAdminAuditAction` 用 19 个 `value === "..."` 串联校验。
同样反模式见 `parseScope / parsePeriodKind / parseEntitlementState / parseSubjectState / parsePlanState`。
建议改 `const ACTIONS = new Set<AdminAuditAction>([...])` + `Set.has`。

### 7.7 `subjectFromOptions` 仅一处调用
`apps/admin-cli/src/index.ts:1758-1784` 仅被 `issueSubject` 调用一次。可以内联或合并。

### 7.8 `mergeAudit` —— 撤回（v1 误判）

> v1 报告基于过期快照，建议"删除显式 `params` 字段"。当前实现已是：
>
> ```ts
> // apps/admin-cli/src/index.ts:1681-1697
> function mergeAudit(base: AuditInput, extra: Partial<AuditInput> | undefined): AuditInput {
>   return {
>     ...base,
>     ...extra,
>     params: mergeAuditParams(base.params, extra?.params)
>   };
> }
>
> function mergeAuditParams(
>   base: Record<string, unknown> | null | undefined,
>   extra: Record<string, unknown> | null | undefined
> ): Record<string, unknown> | null {
>   if (base && extra) {
>     return { ...base, ...extra };
>   }
>   return extra ?? base ?? null;
> }
> ```
>
> 显式 `params:` 字段是为了**字段级合并** `base.params` 与 `extra.params`（默认 spread 会让 extra 整体替换 base）。若按 v1 建议删除，会丢失合并语义。**保留现状**。

---

## 8. 测试质量评估

| 测试文件 | 行数 | 评价 |
|---|---:|---|
| `apps/gateway/src/index.test.ts` | 3,155 | ✅ 高质量集成：`":memory:"` SQLite + `FakeProvider` 注入流事件序列；断言精确（状态码 / payload 结构 / token 使用 / SSE 帧解析） |
| `apps/admin-cli/src/index.test.ts` | 1,173 | ✅ 通过 `execFileSync` 真实运行 CLI 子进程，端到端 |
| `packages/store-sqlite/src/index.test.ts` | 1,246 | ✅ 覆盖迁移幂等、legacy schema 改名、限额边界、过期清理 |
| `packages/provider-codex/src/codex-adapter.test.ts` | 365 | ✅ 用 `FakeClient`/`FakeThread` 驱动事件序列；断言事件映射、敏感词清洗、错误规范化 |

### 未发现以下"虚假测试"反模式

- `expect(true).toBe(true)` / `expect(undefined).toBeFalsy()`
- `.skip` / `.todo` / 空 `it()`
- 仅 `toBeDefined()` / `not.toBeNull()` 的弱断言（仅 1 处合理使用：`store-sqlite/index.test.ts:1022`）
- 过度 mock 自身实现

### 唯一的覆盖空白

`CodexProviderAdapter` 上的 4 个死方法 `create / list / cancel / refresh` 都没有直接测试。`packages/provider-codex/src/codex-adapter.test.ts` 仅测 `message` 与 `normalize` 两项；**`health` 既没有直接也没有间接测试**——`apps/gateway/src/index.test.ts` 全程使用自定义的 `FakeProvider`（`apps/gateway/src/index.test.ts:28`）而不是 `CodexProviderAdapter`（grep `CodexProviderAdapter` 在该测试文件中无匹配），所以那条 healthy 路径仅由 `FakeProvider` 的桩兜底，并未走真实实现。

鉴于 §3 建议把 4 个死方法整体删掉，这反而印证了它们是死代码；`health` 则建议在 `codex-adapter.test.ts` 里补一组针对 auth 文件存在 / 缺失两种状态的单测。

---

## 9. 推荐的 ROI 排序

按"代价 / 收益"从高到低：

| 顺序 | 任务 | 预期变更量 | 风险 |
|---:|---|---|---|
| 1 | 删除 `ProviderAdapter` 4 个死方法及关联类型 | 删除约 60 行；测试 Fake 同步简化 | 低 — 删除多于新增 |
| 2 | 合并 / 删除重复 helper（`publicTokenPolicy`、`isRecord`、`runInTransaction`、`nonNegativeInteger` 等） | 一次小 PR | 低 |
| 3 | 抽 SSE 流式骨架（heartbeat/abort/close/finalize），与 `/sessions/:id/messages` 共享 | 中：`/v1/chat/completions` 处理器约 240 → ~150 行（下降 30–40%） | 中 — 需回归 SSE 测试 |
| 4 | `store-sqlite` 拆分（Base 类 + 按表拆文件 + `runInTransaction` 公共化） | 大 | 中 — 需回归 SQLite 测试 |
| 5 | `admin-cli` 拆命令文件 | 大 | 低 — 命令彼此独立 |
| 6 | 收敛凭据查找 4 函数；`assertCanIssueCredentialForEntitlement` 改决策表 | 中 | 中 — 业务逻辑敏感 |
| 7 | 其他 7.x 小改（命名、SQL 列复用、状态枚举 Set 化） | 小 | 低 |

---

## 附录 A：本次审核的检索证据

- 文件大小：`find apps packages -name "*.ts" -not -path "*/dist/*" -not -path "*/node_modules/*" | xargs wc -l | sort -rn`
- 重复 helper 检索：`grep -rn 'function publicTokenPolicy\|function isRecord\|function runInTransaction\|function nonNegativeInteger' --include='*.ts'`
- 死方法检索：`grep -rn 'provider\.\(create\|list\|cancel\|refresh\)(' --include='*.ts'`（无匹配）
- 虚假测试检索（仅扫测试文件，避免命中 `.skipObservation` / `.skipRateLimit` / `skipGitRepoCheck` 等业务字段名）：

  ```sh
  grep -rnE '\.(skip|todo|only)\(|expect\(true\)\.toBe\(true\)|xit\(|xdescribe\(|expect\([^)]*\)\.toBeDefined\(\)$' \
    --include='*.test.ts'
  ```

  （无可疑命中）
