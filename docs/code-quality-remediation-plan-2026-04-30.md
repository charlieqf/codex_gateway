# 代码质量修复方案 · codex-gateway

- 日期：2026-04-30
- 适用范围：`apps/gateway`、`apps/admin-cli`、`packages/core`、`packages/provider-codex`、`packages/store-sqlite`
- 输入依据：`docs/code-review-2026-04-30.md`
- 目标：用小步、可回归的 PR 降低维护成本，先清理错误抽象和重复实现，再做大文件拆分。

---

## 1. 修复原则

1. **先降风险，再拆大件**：优先删除死接口、合并低风险 helper、补关键测试；大型拆分放到后面。
2. **每个 PR 只解决一类问题**：避免把纯搬迁、行为修复、重命名混在同一次变更里。
3. **保持行为可验证**：所有用户可见输出、API payload、CLI JSON 输出、SQLite schema 兼容性必须由测试覆盖。
4. **不引入 app-to-app 依赖**：`admin-cli` 不反向依赖 `apps/gateway`，共享逻辑应放到 `packages/core`、`packages/store-sqlite` 内部模块或新的共享包。
5. **大文件拆分优先搬迁，不顺手重构**：先建立模块边界，再在后续 PR 中做语义重构。

---

## 2. 总体路线

| 顺序 | PR | 前置 PR | 主要范围 | 预期收益 | 风险 |
|---:|---|---|---|---|---|
| 0 | 建立基线 | - | 全仓测试、构建、单文件测试命令验证 | 明确当前可回归状态 | 低 |
| 1a | 删除 `ProviderAdapter` 死方法 | 0 | `packages/core`、`packages/provider-codex`、gateway 测试 | 删除死接口与测试桩 | 低 |
| 1b | 补 `CodexProviderAdapter.health` 单测 | 0，可与 1a 并行 | `packages/provider-codex` | 补齐真实 provider 健康检查覆盖 | 低 |
| 2a | 合并 store-sqlite 内部 helper | 0 | `packages/store-sqlite` | 先消除同包重复 | 低 |
| 2b | 合并跨包共享 helper | 2a | `packages/core`、gateway、admin-cli | 减少跨 app 重复实现 | 中低 |
| 3 | 修复 rate limiter 状态回收 | 0 | `apps/gateway/src/services/rate-limiter.ts` | 避免默认路径长期内存增长 | 中低 |
| 4 | 可读性与 OpenAI compat 小修 | 0 | observation、OpenAI compat、subject upsert | 降低语义误读，必要时补 schema 编译基准 | 低到中 |
| 5 | 抽 SSE 生命周期骨架 | 0 | gateway HTTP 层 | 消除流式响应生命周期重复 | 中 |
| 6 | 统一 provider 事件流水线 | 5 | gateway service 层、OpenAI compat | 降低 streaming/non-streaming 分支重复 | 中 |
| 7 | 拆 `store-sqlite` | 2a | `packages/store-sqlite/src` | 降低 2,400+ 行文件维护成本 | 中 |
| 8 | 拆 `admin-cli` | 2b；如共享 store helper 则 7 | `apps/admin-cli/src` | 降低 2,600+ 行文件维护成本 | 中低 |
| 9 | 收敛敏感业务逻辑 | 8；必要时 7 | admin-cli 凭据查找、entitlement 决策 | 清晰化授权与回退规则 | 中 |

审核报告漏项闭环：

| 审核项 | 修复归属 |
|---|---|
| `selectToolSchemaValidator` 重复编译 | PR 4：先做 schema compile 基准；确认热点后再另开优化 |
| SQL 列名串重复 | PR 7：抽 `accessCredentialColumns()`、`entitlementColumns()`、`requestEventColumns()` 等 |
| `parseAdminAuditAction` 等 `||` 串 | PR 8：抽 `parsers.ts` 时改为 `Set.has` |
| `chatMessagesToPrompt` 与 `appendMessages` 重复 | PR 6：统一 OpenAI compat 消息拼装 |
| `subjectFromOptions` 单一调用点 | PR 8：拆 `commands/issue.ts` 时内联或合并 |

---

## 3. 分阶段计划

### PR 0：建立基线

目的：在任何修复前记录当前状态，避免把既有失败误判为新引入回归，并确认后续文档中的单文件测试命令可复用。

执行：

```sh
npm run typecheck
npm run build
npm test
npm test -- apps/gateway/src/services/rate-limiter.test.ts
```

产出：

- 记录命令是否通过。
- 若存在既有失败，记录失败测试名、失败原因和是否与本轮修复相关。
- 确认 `npm test -- <single-file>` 在根目录 Vitest 配置下可用；若不可用，后续所有 scoped test 命令统一改为仓库实际支持的形式。
- 当前仓库没有 lint 脚本；若后续引入 ESLint/Biome，则把 `npm run lint` 加入基线与最终验收。
- 后续 PR 均以该基线作为对照。

验收：

- 基线结果已写入 PR 描述或修复任务记录。

---

### PR 1a：删除 `ProviderAdapter` 死方法

问题：

- `ProviderAdapter.refresh/create/list/cancel` 在运行时无人调用。
- `CodexProviderAdapter.create/list/cancel/refresh` 与相关类型增加接口噪音。
- `apps/gateway/src/index.test.ts` 的 `FakeProvider` 被迫实现空桩。

修改范围：

- `packages/core/src/provider-adapter.ts`
- `packages/core/src/types.ts`
- `packages/core/src/index.ts`
- `packages/provider-codex/src/codex-adapter.ts`
- `packages/provider-codex/src/codex-adapter.test.ts`
- `apps/gateway/src/index.test.ts`

建议做法：

1. 删除 `ProviderAdapter.refresh/create/list/cancel`。
2. 删除 `RefreshResult / CreateSessionInput / CreateSessionResult / ListSessionInput / ProviderSession / CancelInput` 等仅服务死方法的类型。
3. 删除 `CodexProviderAdapter.create/list/cancel/refresh`。
4. 删除 `FakeProvider` 中对应空桩。
5. 对 `normalize` 做团队决策：
   - 若按最小接口原则，移出 `ProviderAdapter`，保留为 `CodexProviderAdapter` 内部方法。
   - 若作为 provider contract 保留，需要在接口注释中说明 gateway 当前未消费它。

验收：

```sh
npm --workspace @codex-gateway/core run typecheck
npm --workspace @codex-gateway/provider-codex run typecheck
npm --workspace @codex-gateway/gateway run typecheck
npm test -- packages/provider-codex/src/codex-adapter.test.ts apps/gateway/src/index.test.ts
```

注意：

- 不改变 gateway 的 provider message 行为。
- 不在本 PR 引入 session list/create/cancel 的替代实现。

---

### PR 1b：补 `CodexProviderAdapter.health` 单测

问题：

- `CodexProviderAdapter.health` 仅按 `auth.json` 文件存在性判断健康，但当前既没有直接测试，也没有通过 gateway 测试间接覆盖真实实现。

修改范围：

- `packages/provider-codex/src/codex-adapter.test.ts`
- 必要时 `packages/provider-codex/src/codex-adapter.ts`

建议做法：

1. 新增 `auth.json` 存在时返回 `healthy` 的测试。
2. 新增 `auth.json` 缺失时返回 `reauth_required` 的测试。
3. 若短期仍只做文件存在性检查，在实现处补注释说明这是 phase 1 近似健康检查，不代表凭据有效。

验收：

```sh
npm test -- packages/provider-codex/src/codex-adapter.test.ts
npm run typecheck
```

---

### PR 2a：合并 store-sqlite 内部 helper

问题：

- `runInTransaction` 在 `store-sqlite` 内重复。

修改范围：

- `packages/store-sqlite/src/sql.ts`（新增）
- `packages/store-sqlite/src/index.ts`
- `packages/store-sqlite/src/token-budget.ts`

建议做法：

1. `runInTransaction` 提到 `packages/store-sqlite/src/sql.ts`，仅供 `store-sqlite` 包内部使用。
2. 两处调用改为 import 同一个内部 helper。
3. 不在本 PR 改动 gateway/admin-cli。

验收：

```sh
npm test -- packages/store-sqlite/src/index.test.ts
npm run typecheck
```

注意：

- 这是纯内部机械重构，避免同时调整 SQL 查询或 schema migration。

---

### PR 2b：合并跨包共享 helper

问题：

- `isRecord` 在 gateway 多处重复。
- `publicTokenPolicy/publicTokenUsage/publicTokenWindow` 在 admin-cli 与 gateway 重复。
- `nonNegativeInteger` 与 `parsePositiveInteger` 系列是否统一需要明确边界。

修改范围：

- `packages/core/src/utils.ts` 或 `packages/core/src/utils/*`（可新增）
- `apps/gateway/src/openai-compat.ts`
- `apps/gateway/src/client-events.ts`
- `apps/gateway/src/services/token-budget-hook.ts`
- `apps/admin-cli/src/index.ts`

建议做法：

1. `isRecord` 提到 `packages/core` 的轻量工具模块。
2. token public DTO 序列化函数放到 `packages/core` 或新共享模块，不允许 `admin-cli` import `apps/gateway`。
3. 明确保留项：
   - `nonNegativeInteger` 很小，若公开会污染 core API，可接受保留局部副本。
   - `parsePositiveInteger` 系列存在 commander 参数校验与 env 校验签名差异，可暂不统一。
4. 若新增共享包，需同步 workspace、tsconfig、package-lock；优先考虑放在现有 `packages/core`。

验收：

```sh
npm test -- apps/gateway/src/index.test.ts apps/admin-cli/src/index.test.ts
npm run typecheck
```

---

### PR 3：修复 `InMemoryCredentialRateLimiter` 状态回收

问题：

- `states` Map 只增不减。
- 默认运行路径会使用 `InMemoryCredentialRateLimiter`，包括生产环境，除非显式注入替代 limiter。

修改范围：

- `apps/gateway/src/services/rate-limiter.ts`
- `apps/gateway/src/services/rate-limiter.test.ts`

建议做法：

1. 在 `CredentialRateState` 增加 `lastSeenMs`。
2. 每次 `acquire` 或 `release` 更新当前 credential 的访问时间。
3. 优先采用 release-time pruning，避免 timer 或后台任务：
   - `release()` 时如果 `state.active === 0`，且 minute/day window 已过期，直接 `states.delete(credentialId)`。
   - 新请求到来时由 `state(credentialId, now)` 自动重建窗口。
   - 这样无 timer、无 `unref` 风险，常见空闲凭据能自然回收。
4. 暂不加入 acquire-time 惰性扫描：
   - 正常 Fastify 路径会通过 `onResponse` 或流式响应 `finally` 释放 permit。
   - 进程崩溃时 Map 本身会消失。
   - 若未来出现实际泄漏告警，再基于观测数据补 cap 或惰性扫描。
5. 测试覆盖：
   - 未释放的 active state 不被清理。
   - 已释放且窗口过期的 credential state 被清理。
   - 现有 minute/day/concurrency 限制行为不变。

验收：

```sh
npm test -- apps/gateway/src/services/rate-limiter.test.ts
npm run typecheck
```

---

### PR 4：可读性与语义小修

问题：

- `stableJson` 实际只是安全 stringify，命名误导。
- `selectToolSchemaValidator` / `compileSchema` 可能重复编译 inline schema，但 WeakMap 以对象身份为 key，对请求体 JSON parse 出来的新对象命中率预计很低。
- `recordObservation` 的 `usageSource` 三元表达式难读。
- `markTokenFinalizeResult` 将 final total 写入 estimated 字段，语义容易混淆。
- `upsertSubject` 故意不更新 state，但函数名和 INSERT 参数不易看出意图。

修改范围：

- `apps/gateway/src/openai-compat.ts`
- `apps/gateway/src/http/observation.ts`
- `packages/store-sqlite/src/index.ts`
- 对应测试

建议做法：

1. `stableJson` 改名为 `safeJson`，或实现真正稳定 key 排序。优先改名，风险更低。
2. 撤回 WeakMap 缓存作为默认修复项：
   - OpenAI tools schema 来自每次请求的 inline JSON object，对象身份通常不同。
   - 内容哈希缓存需要遍历 schema，可能比 Ajv 编译节省更少。
   - 若性能确有疑虑，先新增 `scripts/bench-schema-compile.ts` 或测试内微基准，循环 1000 次验证它是否是热点。
   - 基准证明是热点后，再另开 PR 评估内容哈希、schema `$id` 或 Ajv `addSchema` 方案。
3. 抽出 `requestUsageSource(request, tokenUsage)` 之类的 helper，替代三元表达式。
4. 对 `markTokenFinalizeResult` 加注释，说明没有 provider usage 时用最终收费量作为 observation 的 estimated fallback；若要拆字段，另开 PR。
5. `upsertSubject` 可先补注释；若改名为 `upsertSubjectIdentity`，需同步接口与调用方，风险略高。

提交组织：

- 该 PR 包含多个互不相关的小修，建议用单独 commit 划分；合并时可 squash，但 PR 描述要保留每个 commit 的意图，方便未来 bisect。

验收：

```sh
npm test -- apps/gateway/src/index.test.ts packages/store-sqlite/src/index.test.ts
npm run typecheck
```

---

### PR 5：抽 SSE 生命周期骨架

问题：

- 流式 chat completion 与 `/sessions/:id/messages` 重复设置 SSE header、heartbeat、abort、close、end、observation finalize。

修改范围：

- `apps/gateway/src/http/sse.ts`（新增）
- `apps/gateway/src/index.ts`
- `apps/gateway/src/index.test.ts`

建议做法：

1. 采用"helper 只管 setup/write，调用方继续负责 teardown"的契约：
   - 真正重复的是 SSE header、heartbeat、close listener、AbortController 创建。
   - `finalizeTokenBudget`、`releaseRateLimit`、`recordObservation` 保留在调用方的 `finally` 中。
   - 不引入 `bindTeardown`、时序约束、幂等 teardown 或 async teardown 等待语义。
   - 调用方仍能在路由处理器里直接看到完整生命周期。
2. 建议 API 形态：

```ts
interface SseHandle {
  readonly signal: AbortSignal;
  isClosed(): boolean;
  writeComment(comment: string): boolean;
  writeData(data: unknown): boolean;
  writeDone(): boolean;
  end(): void;
}
```

3. 生命周期约定：
   - `setupSseResponse(reply)` 设置 header 并调用 `reply.hijack()`。
   - socket `close` 事件只负责标记 closed 并 abort signal。
   - 正常路径或错误路径仍由调用方 `finally` 执行业务 teardown，然后调用 `handle.end()`。
   - helper 不知道 token budget、rate limit、observation store，也不接管这些资源。
4. 新增 `setupSseResponse(reply)`：
   - 设置 `content-type/cache-control/connection`。
   - 调用 `reply.hijack()`。
   - 创建 `AbortController`。
   - 注册 `close` listener。
   - 创建 heartbeat。
5. 第一版只抽生命周期，不改 provider event 转换逻辑。

验收：

```sh
npm test -- apps/gateway/src/index.test.ts
npm run typecheck
```

重点回归：

- OpenAI streaming chunk。
- `/sessions/:id/messages` SSE。
- 客户端断开时 abort。
- hijack 后 observation 仍记录。
- token budget finalize 仍执行。

---

### PR 6：统一 provider 事件流水线

问题：

- streaming 与 non-streaming 对 `message_delta/tool_call/error/completed` 的处理规则分别书写。
- strict client tools 也有两次 collect/parse/log 的重复流程。

修改范围：

- `apps/gateway/src/services/provider-stream.ts`（新增）
- `apps/gateway/src/index.ts`
- `apps/gateway/src/openai-compat.ts`（必要时）

建议做法：

1. 抽 provider event collector：
   - 输入 provider message 参数。
   - 输出统一结果：content、tool calls、usage、error、provider session ref。
2. streaming 分支复用同一套 event filtering 规则：
   - `tool_choice=none` 抑制 tool call。
   - tool call 后抑制 assistant text delta。
3. `runStrictClientTools` 内提取一次 "collect + parse + log" helper。
4. 让 `chatMessagesToPrompt` 复用 `appendMessages`，消除 OpenAI compat 中的消息拼装重复。

验收：

```sh
npm test -- apps/gateway/src/index.test.ts
npm run typecheck
```

注意：

- 不改变 OpenAI-compatible payload。
- 不改变 strict tools 的错误码和修复流程。

---

### PR 7：拆分 `packages/store-sqlite/src/index.ts`

问题：

- `index.ts` 超 2,400 行，混合 store 类、client events store、migrations、row mappers、SQL helpers。

设计选择：

- 采用"自由函数 + `SqliteGatewayStore` facade 委托"。
- 原因：
  - 外部已有 `sessions instanceof SqliteGatewayStore` 判断，必须保留具体类作为对外形态。
  - 自由函数 `getSubject(db, id)` / `insertAccessCredential(db, input)` 等最容易测试和移动。
  - 避免 TS mixin 带来的类型与构造复杂度。
  - 避免子模块对象改变 `GatewayStore` 单一接口实现形态。

建议拆分顺序：

1. 抽基础设施：
   - `sqlite-managed.ts` 或 `base-store.ts`
   - `migrations.ts`
   - `row-mappers.ts`
   - `columns.ts`，集中 `accessCredentialColumns()`、`entitlementColumns()`、`requestEventColumns()`、`tokenReservationColumns()` 等 SELECT 列名串。
2. 按领域抽方法：
   - `subjects.ts`
   - `access-credentials.ts`
   - `sessions.ts`
   - `plans.ts`
   - `entitlements.ts`
   - `request-events.ts`
   - `client-events.ts`
3. `SqliteGatewayStore` 保持为 facade：
   - `readonly kind = "sqlite"` 与 `database` getter 留在类上。
   - public method 签名保持不变。
   - 方法体委托到 domain 自由函数。
4. 保持 `src/index.ts` 作为公开导出入口。

验收：

```sh
npm test -- packages/store-sqlite/src/index.test.ts
npm run typecheck
```

注意：

- 第一批拆分尽量只移动代码。
- SQLite migration SQL 不要与文件拆分混改。
- 保持 legacy schema migration 测试通过。

---

### PR 8：拆分 `apps/admin-cli/src/index.ts`

问题：

- `index.ts` 超 2,600 行，混合命令注册、业务逻辑、加解密、序列化、参数解析。

建议拆分结构：

```text
apps/admin-cli/src/
  index.ts
  command-context.ts
  audit.ts
  crypto.ts
  parsers.ts
  serializers.ts
  commands/
    issue.ts
    update-key.ts
    rotate.ts
    revoke.ts
    reveal-key.ts
    users.ts
    plans.ts
    entitlements.ts
    token-usage.ts
    audit.ts
    trial-check.ts
```

执行顺序：

1. 先抽纯 helper：`parsers.ts`、`serializers.ts`、`crypto.ts`、`audit.ts`。
   - `parseAdminAuditAction / parseScope / parsePeriodKind / parseEntitlementState / parseSubjectState / parsePlanState` 改为 `Set.has` 风格。
   - 对 commander parser 与 env parser 保持独立签名，不为了统一而引入绕路 wrapper。
2. 再按命令拆 command handler。
   - 拆 `commands/issue.ts` 时处理 `subjectFromOptions` 单一调用点，可内联到 issue flow 或合并到更清晰的 issue subject builder。
3. 最后压缩 `index.ts` 为命令注册与依赖注入入口。

验收：

```sh
npm test -- apps/admin-cli/src/index.test.ts
npm run typecheck
```

注意：

- CLI stdout/stderr 必须保持兼容。
- JSON 字段顺序不应作为契约，但现有测试若依赖快照，应避免无意义重排。
- 命令拆分 PR 不要同时调整 entitlement 业务规则。

---

### PR 9：收敛 admin-cli 凭据查找与 entitlement 决策

问题：

- `resolveTokenPolicyCredential/resolveTokenWindowPolicy/firstActiveCredential/resolveCredentialForUser` 互相调用，回退顺序不直观。
- `assertCanIssueCredentialForEntitlement` 双 throw 表达隐含业务规则。
- `resolveUserId` 通过默认值判断用户是否显式传入 `--subject-id`，语义脆弱。

建议做法：

1. 引入单一入口：

```ts
interface ResolvedTokenPolicyContext {
  credential: AccessCredentialRecord | null;
  entitlementId: string | null;
  policy: TokenLimitPolicy;
  source: "entitlement" | "legacy_credential";
}
```

2. 把 entitlement active、inactive、legacy fallback 的顺序集中到一个函数。
3. 将 `assertCanIssueCredentialForEntitlement` 改为 decision/result：

```ts
type IssueCredentialDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "no_active_entitlement" | "scope_not_allowed" | "strict_mode_required";
      message: string;
    };
```

4. 把 `GATEWAY_REQUIRE_ENTITLEMENT === "1"` 判断收敛到 decision 函数内部：
   - legacy 用户在非严格模式可走 legacy fallback。
   - legacy 用户在严格模式返回 `strict_mode_required`。
   - inactive/no entitlement 返回 `no_active_entitlement`。
   - active entitlement 但 scope 不允许返回 `scope_not_allowed`。
5. 对 `resolveUserId` 引入显式 sentinel 或 commander option source，区分默认值与用户显式传入。

验收：

```sh
npm test -- apps/admin-cli/src/index.test.ts apps/gateway/src/index.test.ts packages/store-sqlite/src/index.test.ts
npm run typecheck
```

注意：

- 这是业务敏感 PR，应放在拆分之后。
- PR 描述必须列出 legacy fallback 与 entitlement enforcement 的行为矩阵。

---

## 4. 回归矩阵

统一命令口径：

- 全量类型检查：`npm run typecheck`
- 全量构建：`npm run build`
- 全量测试：`npm test`
- scoped 测试：`npm test -- <test-file> [<test-file>...]`
- lint：当前仓库没有 lint 脚本；若后续新增，则所有合并前检查加入 `npm run lint`

| 变更类型 | 必跑测试 |
|---|---|
| ProviderAdapter / Codex adapter | `packages/provider-codex/src/codex-adapter.test.ts`、`apps/gateway/src/index.test.ts` |
| rate limiter | `apps/gateway/src/services/rate-limiter.test.ts`、`apps/gateway/src/index.test.ts` |
| SSE / OpenAI compat | `apps/gateway/src/index.test.ts` |
| token budget / observation | `apps/gateway/src/index.test.ts`、`packages/store-sqlite/src/index.test.ts` |
| store-sqlite 拆分 | `packages/store-sqlite/src/index.test.ts` |
| admin-cli 拆分 | `apps/admin-cli/src/index.test.ts` |
| entitlement / credential 逻辑 | `apps/admin-cli/src/index.test.ts`、`apps/gateway/src/index.test.ts`、`packages/store-sqlite/src/index.test.ts` |

全量合并前：

```sh
npm run typecheck
npm run build
npm test
```

需要外部服务或真实凭据的 smoke 不作为每个 PR 的硬性门禁，但在发布前按需执行：

```sh
scripts/public-openai-smoke.sh
scripts/public-strict-tools-smoke.sh
```

---

## 5. 完成标准

阶段性完成标准：

- `ProviderAdapter` 不再暴露运行时无人调用的方法。
- gateway 测试不再需要实现 provider 空桩。
- 重复 helper 收敛口径明确：
  - 必须收敛：`runInTransaction`、`isRecord`、`publicTokenPolicy/publicTokenUsage/publicTokenWindow` 三件套。
  - 可选收敛：`nonNegativeInteger`，因为实现极小，若公开会污染 core API，可保留局部副本。
  - 可选收敛：`parsePositiveInteger` 系列，因为 commander parser 与 env parser 签名不同，强行统一可能引入不必要 wrapper。
- `InMemoryCredentialRateLimiter` 有状态回收机制和测试。
- SSE 生命周期只有一套公共实现。
- `store-sqlite/src/index.ts` 与 `admin-cli/src/index.ts` 明显缩小，职责按模块分离。

最终完成标准：

- 全量 `npm run typecheck` 通过。
- 全量 `npm run build` 通过。
- 全量 `npm test` 通过，或已记录与本轮无关的既有失败。
- 每个行为敏感 PR 都有对应测试覆盖。
- 发布前已按需执行 public smoke，或明确记录未执行原因。
- `docs/code-review-2026-04-30.md` 中 ROI 前三项已关闭或有明确后续任务。

---

## 6. 建议启动项

建议第一个实施 PR 为 **PR 1a：删除 `ProviderAdapter` 死方法**；**PR 1b：补 `CodexProviderAdapter.health` 单测** 可以并行准备。

理由：

- 删除多于新增，风险最低。
- 直接解决文档中最高 ROI 的死代码问题。
- 能同步简化 gateway 测试桩。
- `health` 单测与删接口互不依赖，拆开后类型遗漏和测试新增问题更容易定位。
