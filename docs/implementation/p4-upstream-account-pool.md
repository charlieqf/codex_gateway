# P4 上游 Codex 账号池开发设计

| Field | Value |
| --- | --- |
| 状态 | Draft |
| 日期 | 2026-05-11 |
| 范畴 | 多 ChatGPT/Codex 登录态配置、调度、stickiness、观测、运维 |
| 关联 | `docs/implementation/upstream-accounts-rename.md`、`docs/implementation/p3-plan-entitlement.md`、`docs/operations/operational-experience.md` |

## 1. 背景

当前 Gateway 运行时只读取一个 `CODEX_HOME`，也只创建一个 `CodexProviderAdapter`。虽然 SQLite 已有 `upstream_accounts` 表，`sessions` 和 `request_events` 也已经保存 `upstream_account_id`，但运行时代码仍是单上游账号。

下一步目标是把一个 ChatGPT Pro 登录态扩展为 2-3 个服务端托管的上游 Codex 账号。每个账号对应一个独立 `CODEX_HOME`，Gateway 在新请求进入时选择一个健康账号，并在需要时保持会话粘性。

本文档编号 `P4` 是 implementation 文档序号，对应路线图中的 `Phase 4b: 上游 Codex 账号池`，不是 `docs/implementation/roadmap.md` 里的 Phase 4。

## 2. 目标

1. 支持通过配置声明多个上游 Codex 账号，每个账号有独立 `id`、`label`、`codexHome`、权重、状态和并发上限。
2. Gateway 启动时为每个 active 账号创建独立 `CodexProviderAdapter`。
3. 新会话和 stateless OpenAI-compatible 请求由调度器选择上游账号。
4. 已有 Gateway session 必须 stick 到 `sessions.upstream_account_id` 对应的账号。
5. `request_events.upstream_account_id` 记录每个下游请求最终实际落到的上游账号。
6. 上游账号 reauth、限流、临时错误时，对单个账号做 cooldown，不影响其它账号。
7. 默认保持现有单账号配置兼容，未配置账号池时继续使用 `CODEX_HOME`。

## 3. 非目标

- 不实现后续账号池设计中的 `team_pool_id` / team seat 调度，避免和路线图 `Phase 5: Azure VM 运维固化` 混淆。
- 不按用户付费 plan 做复杂账号隔离；plan priority 与 team pool 路由留给后续设计。
- 不把真实 `upstream_account_id` 暴露给外部客户端。
- 不保存、导入或解析浏览器 HAR、Cookie、browser token。
- 不复制 `auth.json` 到仓库、文档、日志或 CLI 输出。
- 不实现跨进程共享调度状态。当前公共 Gateway 仍是单进程容器，跨进程共享留给后续阶段。

## 4. 当前实现基础

已有可复用基础：

- `upstream_accounts` 表保存上游账号元数据。
- `sessions.upstream_account_id` 记录会话所属上游账号。
- `request_events.upstream_account_id` 记录请求观测所属上游账号。
- `GatewayRequestContext` 已包含 `upstreamAccount` 和 `provider`。
- Admin CLI `events` / `report-usage` 已输出或聚合 `upstream_account_id`。
- `CodexProviderAdapter` 已支持通过构造参数传入独立 `codexHome`。

当前缺口：

- 运行时只创建一个 provider 实例。
- auth hook 固定注入同一个 `upstreamAccount`。
- 新 session / stateless request 没有调度器。
- 已有 session message 没有按 `session.upstreamAccountId` 反查 provider。
- 上游账号健康、cooldown、inflight 只存在设计字段，未参与选择。

## 5. 配置设计

### 5.1 兼容路径

如果未设置账号池配置，Gateway 保持现有行为：

```env
CODEX_HOME=/var/lib/codex-gateway/codex-home
```

启动时生成一条默认上游账号：

```text
id=sub_openai_codex_dev 或现有默认 id
provider=openai-codex
credentialRef=CODEX_HOME
codexHome=$CODEX_HOME
```

### 5.2 账号池配置

新增环境变量：

```env
GATEWAY_UPSTREAM_ACCOUNTS_JSON=/var/lib/codex-gateway/upstream-accounts.json
```

文件内容：

```json
{
  "accounts": [
    {
      "id": "codex-pro-1",
      "label": "Codex Pro 1",
      "provider": "openai-codex",
      "codexHome": "/var/lib/codex-gateway/codex-home-pro-1",
      "enabled": true,
      "initialState": "active",
      "weight": 1,
      "maxConcurrent": 1
    },
    {
      "id": "codex-pro-2",
      "label": "Codex Pro 2",
      "provider": "openai-codex",
      "codexHome": "/var/lib/codex-gateway/codex-home-pro-2",
      "enabled": true,
      "initialState": "active",
      "weight": 1,
      "maxConcurrent": 1
    }
  ],
  "selection": {
    "strategy": "least_inflight",
    "softAffinity": "credential"
  },
  "cooldown": {
    "rateLimitSeconds": 120,
    "reauthSeconds": 900,
    "serviceErrorSeconds": 30
  }
}
```

规则：

- `id` is the internal stable key stored in `sessions.upstream_account_id` and `request_events.upstream_account_id`.
- `label` is operator-facing only. Public `/gateway/status` may continue to expose the service-level public label from `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL`.
- `codexHome` must be an absolute path in production.
- `credentialRef` stored in `upstream_accounts` should be a non-secret reference such as `CODEX_HOME:codex-pro-1`, not the auth file content.
- `provider` is initially only `openai-codex`.
- `maxConcurrent` is intentionally explicit in the config. Omitting it is a config error. For ChatGPT Pro accounts, start with `1` until measured evidence supports higher per-account concurrency.
- `enabled=false` is a config-level selection gate. Such accounts may be loaded and seeded, but the router must never select them.
- `initialState` is used only when the account row does not already exist in `upstream_accounts`.
- Once an account exists in DB, `upstream_accounts.state` is the runtime state source of truth. Config reload or process restart must not overwrite an existing row from `reauth_required` or `disabled` back to `active`.
- `last_used_at` and `cooldown_until` are runtime fields in the schema. PR 3 persists them through a dedicated runtime-state update path and hydrates them from DB on startup; config bootstrap must not clear existing DB values.
- The current `upsertUpstreamAccount` implementation only updates `provider` / `label` / `credential_ref` / `updated_at` on conflict. PR 1 should either preserve that behavior intentionally or add an explicit partial update API; it must not make config `initialState` overwrite existing runtime state by accident.
- `cooldown` controls PR 3 runtime backoff after provider outcomes. `provider_reauth_required` uses `reauthSeconds`, `rate_limited` uses `rateLimitSeconds`, and transient service errors use `serviceErrorSeconds`.
- **Forward-compatible 字段**：未来 P4c 会在同一账号 schema 上加 `imageApiKeyEnv` / `imageBaseUrlEnv` / `imageTimeoutMs`（详见 [P4c 上游账号 OpenAI 生图 Key 绑定设计](./p4c-upstream-account-image-binding.md)）。**P4 PR 1 的 config parser 必须容忍这些字段已经出现在 JSON 中**——遇到时记一条 info 级别 "image-binding field ignored in P4 parser" 日志后跳过即可，不报错。这样 P4 与 P4c 可以独立 ship，且部署侧可以先把字段加上等 P4c 上线。

## 6. Auth And Context Model

P4 should stop binding one upstream account inside `credentialAuthHook`. Instead:

1. Auth hook validates the API key and injects subject, scope, and credential.
2. Route-level orchestration asks an `UpstreamAccountRouter` for the account and provider.
3. The chosen account/provider is written into `request.gatewayContext` before provider calls, token budget acquire, and observation finalization.

This avoids selecting an account for routes that do not call the provider, such as `GET /gateway/credentials/current`.

最小 context 变化示意：

```ts
interface GatewayRequestContext {
  subject: Subject;
  upstreamAccount?: UpstreamAccount;
  provider?: ProviderAdapter;
  scope: Scope;
  credential: CredentialContext;
}
```

`CredentialContext` 是建议新增的命名类型，用来替代当前 `GatewayRequestContext.credential` 的 inline object。若第一版希望缩小改动，也可以继续沿用现有 inline object，不把该命名类型作为必须重构项。

Routes that need provider access must call a helper:

```ts
const route = selectUpstreamForRequest(request, {
  kind: "stateless" | "new_session" | "existing_session",
  session
});
```

For smaller first PRs, the existing required fields can stay required and selection can still happen before route handler for business routes. The cleaner route-level selection is preferred because it prevents useless scheduling on non-provider routes.

## 7. 调度规则

### 7.1 New Gateway Session

`POST /sessions` 还没有 provider 侧历史。

规则：

1. Select a healthy active account.
2. Create the session with that `upstreamAccount.id`.
3. Return public session metadata as before.

从这个点开始，该 session 必须保持 sticky。

### 7.2 Existing Gateway Session

`POST /sessions/:id/messages` 必须使用 session 中记录的账号。

规则：

1. Load session by id.
2. Verify `session.subjectId === subject.id`.
3. Resolve `session.upstreamAccountId` to an active configured account.
4. Use that account's provider.
5. Do not silently move the session to another account.

Reason: `providerSessionRef` belongs to the original upstream account. The Codex adapter resumes a provider thread with that ref, so moving it to another login state can fail or fork behavior.

If the sticky account is unavailable:

- `reauth_required`: return `provider_reauth_required`.
- config `enabled=false` or DB/runtime `state=disabled`: return `subscription_unavailable`.
- `cooldown` due to rate limit or temporary failure: return `rate_limited` or `service_unavailable` with retry guidance.

No automatic failover for existing sessions in P4.

### 7.3 OpenAI-Compatible Stateless Chat

`POST /v1/chat/completions` receives complete `messages` each time. The current code creates a transient stateless session with `providerSessionRef=null`.

Rule:

1. Select a healthy active account for every request.
2. Use optional soft affinity to prefer the same account for the same credential or subject.
3. If the preferred account is cooling down or at concurrency cap, select another account.
4. Record the final account in `request_events.upstream_account_id`.

默认 soft affinity:

```text
rendezvous_hash(credential_id, eligible_account_ids)
```

默认使用 rendezvous hashing / HRW，而不是 `hash % active_account_count`。这样新增账号、账号 cooldown 或账号恢复时，只会让一部分 credential 的偏好账号漂移；soft affinity 仍然允许在偏好账号不可用、冷却中或达到并发上限时切到其它账号。对于 2-3 个账号的小池子，也可以先用简单 hash，但文档和测试必须明确这会在容量变化时产生更大范围的重映射。

### 7.4 Streaming Failover Boundary

自动切换到另一个账号只允许发生在业务输出边界之前。这里的边界不是任意 wire byte，而是客户端可见的 assistant 业务内容，包括文本 delta、tool call、最终非流式 body，或任何会让客户端状态前进的 OpenAI-compatible chunk。

允许 retry 的条件：

- no client-visible assistant content or `tool_calls` chunk has been sent;
- no non-stream response body has been committed;
- `providerSessionRef` has not been persisted;
- token reservation has not been finalized.

不阻止 retry 的情况：

- streaming 路径已经发送了仅用于建立响应形态的 initial SSE frame，但尚未发送任何 assistant content、tool call 或 finish chunk。retry 后客户端看到的 chat completion `id`、`model`、`created` 和已发送 initial chunk 必须一致，不能因为换上游账号而出现两个逻辑响应。

一旦业务输出边界越过，不再静默切换账号。返回或继续 stream 当前 attempt 的归一化错误。

### 7.5 Strict Client-Defined Tools Retry Boundary

`/v1/chat/completions` 在 strict client-defined tools 模式下可能在一次下游请求内多次调用 `provider.message()`：第一次要求模型产出严格 JSON tool envelope，后续可能做 schema repair 或处理 tool result history。

P4 retry 规则：

- 第一次 provider 调用在没有产出任何客户端可见业务 chunk 前返回 `provider_reauth_required`、`rate_limited`、网络错误或 5xx，stateless 请求可以切到另一个账号重试。
- strict-tools 内部 repair 是模型输出验证失败后的业务流程，不属于账号 failover。repair prompt 默认继续使用同一个已选账号。
- P4 第一版只允许在第一次 provider 调用产出客户端可见业务 chunk 之前 failover；一旦进入 strict-tools repair 或 tool-result 循环，不再切账号。
- 一旦 gateway 已经向客户端输出 tool call、assistant content 或 final chunk，不再切账号；后续错误按当前 attempt 返回。
- 已有 Gateway session 即使处于 strict-tools 路径，也不自动 failover，仍遵守 `session.upstreamAccountId` sticky。

## 8. Selection Algorithm

第一版策略：`least_inflight` with soft affinity。

输入：

- account state: active / disabled / reauth_required / unhealthy
- cooldownUntil
- inflight count
- maxConcurrent
- weight
- optional affinity key

算法：

1. Filter accounts where config `enabled !== false`.
2. Filter accounts where DB/runtime `state === "active"`.
3. Exclude accounts with `cooldownUntil > now`.
4. Exclude accounts with `inflight >= maxConcurrent` when maxConcurrent is set.
5. If soft-affinity is configured, build an HRW ranking for the affinity key and choose the first eligible account.
6. Otherwise choose the eligible account with the lowest `inflight / weight`.
7. If no account is eligible, return `subscription_unavailable` or `rate_limited` depending on the dominant reason.

Pseudo-code:

```ts
select(input) {
  const candidates = configuredAccounts
    .filter(enabledByConfig)
    .filter(activeInRuntimeState)
    .filter(notCoolingDown)
    .filter(notAtConcurrencyCap);

  const affinity = highestRankedEligibleByHrw(input.affinityKey, candidates);
  if (affinity) return affinity;

  return minBy(candidates, account => inflight(account.id) / account.weight);
}
```

Router 在 provider call 前递增 inflight，并在 `finally` 中递减。达到 `maxConcurrent` 的账号会被排除，第一版不在 router 内排队；由现有下游限流或客户端重试承担 backpressure。

## 9. Health And Cooldown

Health 分两层：

1. 启动校验：逐个检查配置启用账号的 `codexHome` 目录和 `auth.json`。
2. 运行时结果处理：provider error 后更新单账号 cooldown。

启动校验不能因为某一个账号失效就让整个 Gateway 不可用。规则：

- 单个启用账号缺目录或缺 `auth.json` 时，将该账号标记为 runtime `reauth_required` 或 `unhealthy`，并从可选候选集中排除。
- 只要至少还有一个启用且可选的账号，Gateway 继续启动。
- production 下如果没有任何账号可选，启动应失败，除非显式设置 `GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL=1` 作为诊断/维护开关。空池启动后 provider 路由统一返回 `subscription_unavailable`。
- 启动校验不得打印 `auth.json` 内容、token、device code 或浏览器登录态。

运行时映射：

| Provider outcome | Account action | Client outcome |
| --- | --- | --- |
| success | clear transient error state, update `lastUsedAt` | normal response |
| `provider_reauth_required` | mark account `reauth_required`, cooldown `reauthSeconds` | same error |
| `rate_limited` | cooldown `rateLimitSeconds` | retry if safe; otherwise same error |
| network / 5xx service error | cooldown `serviceErrorSeconds` | retry if safe; otherwise same error |
| config `enabled=false` or DB `state=disabled` | never select | `subscription_unavailable` |

DB 持久化：

- P4 first PR must preserve DB `state` during bootstrap upsert; config `initialState` applies only when inserting a new account row.
- PR 3 persists `last_used_at` and `cooldown_until` into `upstream_accounts` through a runtime update API, separate from bootstrap `upsertUpstreamAccount`.
- Startup hydrates existing `last_used_at` / `cooldown_until` from DB and config reload must not clear existing DB values.
- Operator-side manual edits to DB `state` require a Gateway restart before the in-memory router observes them.

## 10. Observation And Reporting

Existing `request_events.upstream_account_id` remains the primary request-level record.

Required behavior:

- For successful requests, record final account id.
- For provider errors after an account was selected, record that selected account id.
- For auth failures before selection, `upstream_account_id` can remain null.
- For gateway preflight failures before selection, `upstream_account_id` can remain null.
- `report-usage` continues grouping by `upstream_account_id`.

Optional follow-up for failover analysis:

```sql
CREATE TABLE upstream_attempt_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  upstream_account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  first_byte_sent INTEGER NOT NULL DEFAULT 0
);
```

不建议在这张表上加 `FOREIGN KEY(request_id) REFERENCES request_events(request_id)`。`request_events` 是 observation hook 在响应结束时 best-effort 写入的请求摘要；进程崩溃或 observation 失败时，attempt 事件可能已经存在而 request summary 缺失。`upstream_attempt_events` 如果后续实现，应当是 append-only / best-effort 调试事实表，用 `request_id` 做相关键，但不依赖 FK 约束。

Do not add this table in the first P4 PR unless real failover behavior needs debugging immediately. The first PR can log structured attempt data with request id and keep `request_events` as the durable summary.

## 11. Admin And Operations

### 11.1 Device Login

Each upstream account logs in on the same VM but uses a different `CODEX_HOME`:

```bash
CODEX_HOME=/var/lib/codex-gateway/codex-home-pro-1 codex login --device-auth
CODEX_HOME=/var/lib/codex-gateway/codex-home-pro-2 codex login --device-auth
CODEX_HOME=/var/lib/codex-gateway/codex-home-pro-3 codex login --device-auth
```

Rules:

- Do not use HAR files for login state backup.
- Do not paste device codes, browser cookies, `auth.json`, or tokens into chat or docs.
- Parent directories should be `700`; `auth.json` should be `600`.
- Probe each account independently before enabling it in the pool.

### 11.2 Probe

Use the existing provider probe against each `codexHome`:

```bash
npm run probe:codex -- --codex-home /var/lib/codex-gateway/codex-home-pro-2 --run --timeout-ms 180000
```

### 11.3 Disable Account

P4 first version can disable accounts through config:

```json
{
  "id": "codex-pro-2",
  "enabled": false
}
```

`enabled=false` 是配置层 gate，不等同于 DB `upstream_accounts.state=disabled`。第一版需要重启生效；hot reload 可以后续再做。

## 12. Public API Compatibility

No OpenAI-compatible response shape changes.

No new public upstream account id exposure.

`GET /gateway/status` should remain service-level:

- It may add pool summary fields later, but first P4 PR should avoid exposing per-account ids.
- Existing `upstream_account.label` can continue to return the public label such as `medcode`.
- Detailed pool health belongs in admin/operator surfaces, not client-facing status.

## 13. Implementation Plan

### PR 1: Runtime Pool Foundation

- Add config parser for `GATEWAY_UPSTREAM_ACCOUNTS_JSON`.
- Add `UpstreamAccountRuntime` type holding account metadata, provider, inflight, and hydrated `cooldownUntil`.
- Add `UpstreamAccountRouter` with `selectForNewSession`, `selectForStateless`, and `resolveForExistingSession`.
- Seed every configured account into `upstream_accounts`, but treat DB `state` / `last_used_at` / `cooldown_until` as runtime source of truth once the row exists.
- Use config `enabled=false` as a selection gate; do not rely on config `state=disabled` overwriting DB state on restart.
- Keep single-account fallback using `CODEX_HOME`.
- Add unit tests for config parsing and selection.

### PR 2: Gateway Route Wiring

- Move provider selection from auth hook into route orchestration or a provider-required pre-handler.
- `POST /sessions` selects and stores account id.
- `/sessions/:id/messages` resolves from `session.upstreamAccountId`.
- `/v1/chat/completions` selects stateless account per request.
- Ensure observation records the actual selected account.
- Add tests for session stickiness and stateless distribution.

### PR 3: Error Handling And Cooldown

- Map provider errors to account cooldown.
- Retry stateless/new-session attempts only before client-visible business output.
- Do not fail over existing sessions.
- Add tests for cooldown exclusion, all-accounts-unavailable, and no retry after client-visible business output.

### PR 4: Operations Docs And Smoke

- Update container env example.
- Add VM login/probe/account disable runbook.
- Add smoke plan showing requests landing on two different `upstream_account_id` values.
- Update `docs/operations/system-status.md` after deployment.

## 14. Test Plan

Unit tests:

- Config parser rejects duplicate ids.
- Config parser rejects relative `codexHome` in production.
- `enabled=false` accounts are seeded or loaded but not selected.
- Existing DB state is not overwritten by config `initialState` on restart.
- `least_inflight` respects `maxConcurrent`.
- `maxConcurrent=2` excludes the third concurrent request from that account instead of queueing inside the router.
- Soft affinity chooses preferred account when eligible.
- Cooldown excludes an account until expiry.
- Cooldown expiry makes the account eligible again.
- HRW soft affinity has limited remapping when the active account set changes.

Gateway tests:

- `POST /sessions` persists selected `upstreamAccountId`.
- Existing session uses its stored account even if another account has lower inflight.
- Existing session returns a provider error if its sticky account is unavailable; no failover.
- Stateless chat can use different accounts across credentials.
- Stateless path may retry another account after selected-account failure before client-visible business output.
- Stateless path must not retry another account after client-visible business output.
- Strict client-defined tools can retry only before first provider-call business output; repair and tool-result loops do not retry another account in P4.
- `request_events.upstream_account_id` matches the selected runtime account.
- Auth failure before selection writes null upstream account.
- Single-account fallback without `GATEWAY_UPSTREAM_ACCOUNTS_JSON` preserves current behavior.

Smoke tests:

- Login/probe `codex-home-pro-1` and `codex-home-pro-2`.
- Run temporary API key non-stream requests until both accounts appear in `events`.
- Run one native Gateway session for two turns and verify both request events use the same account.
- Set one account to `enabled=false`, restart, verify traffic only uses the remaining account.

## 15. Rollout Plan

1. Merge and deploy code with single-account fallback; production behavior unchanged.
2. Add second `CODEX_HOME` on VM and complete device login.
3. Probe second account.
4. Write `upstream-accounts.json` with account 2 set to `enabled=false`.
5. Restart Gateway and verify startup.
6. Enable account 2 during a maintenance window.
7. Run public smoke with a temporary key.
8. Query `events` and confirm `upstream_account_id` distribution.
9. Monitor provider errors, rate limits, and first-byte latency for at least one trial day.

Rollback:

- Set all added accounts to `enabled=false`, or remove `GATEWAY_UPSTREAM_ACCOUNTS_JSON`.
- Restart Gateway.
- Existing sessions bound to accounts gated by `enabled=false` will not continue; if rollback must preserve existing sessions, keep the original account id enabled and only disable newly added accounts.

## 16. Open Questions

- Should soft affinity key be `credential_id`, `subject_id`, or configurable per plan?
- Do we need a protected admin endpoint for pool health, or is admin CLI enough for the first rollout?
- Should successful requests clear only transient cooldown, or also reset some future `unhealthy` reason metadata when added?
- Should `report-usage` add a first-class `--group-by upstream-account` option, or is the existing row shape enough?
