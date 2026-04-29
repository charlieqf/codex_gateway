# MedCode 按 API key 限制 token 消耗方案

Last updated: 2026-04-28

## 背景

当前 gateway 已经支持按 API key 做请求级限流：

- `requestsPerMinute`
- `requestsPerDay`
- `concurrentRequests`

这些限制存放在 `access_credentials.rate_json`，由 gateway 的 rate limit hook 在请求进入业务路由前执行。

当前已经完成 Phase 1 token usage 记录：gateway 会从上游 `completed.usage` 映射 OpenAI-compatible `usage` 字段，并持久化到 `request_events`。管理员可以通过 `events` 查看单请求 token usage，也可以通过 `report-usage` 按天聚合 token usage。

尚未完成的是 token budget 阻断：现在还不能按 API key 的 token 消耗做准入、预留或扣账。

## 当前实现状态

已落地：

- `request_events` 增加：
  - `prompt_tokens`
  - `completion_tokens`
  - `total_tokens`
  - `cached_prompt_tokens`
  - `estimated_tokens`
  - `usage_source`
- `events` 输出上述 token 字段。
- `report-usage` 汇总上述 token 字段。
- OpenAI-compatible `/v1/chat/completions` 非流式、流式、strict tools 分支会记录 provider usage。
- Native `/sessions/:id/messages` 完成事件会记录 provider usage。

未落地：

- API key token policy 配置。
- 请求开始前 token estimation/reservation。
- token minute/day/month window counter。
- token 超限 429。
- provider usage 缺失时的保守扣账。

## 目标

- 每个 API key 可以配置独立 token 额度。
- 支持按 UTC minute / day / month 统计 token 消耗。
- 支持单请求 token 上限，防止一个请求吃掉过大上下文。
- 支持并发请求下的准确准入，避免多个请求同时通过后一起超额。
- token 限流命中时返回 OpenAI-compatible `429 rate_limit_error`。
- 所有 token 消耗可通过 admin CLI 查询和报表聚合。

## 非目标

- 第一版不做真实美元成本计费。
- 第一版不引入多 provider 的统一价格表。
- 第一版不依赖客户端上报 token；只信任 gateway 和 provider usage。
- 第一版不把 token budget 当作安全鉴权边界；鉴权仍由 API key auth 负责。

## 设计原则

token 限流不能只做事后统计。原因是实际 token usage 通常在上游完成后才知道，如果多个请求并发进入，只在完成后扣账会允许短时间严重超额。

因此需要两步：

1. **请求开始时预留 token reservation**：基于 prompt 估算和默认输出预留量，先占用未来额度。
2. **请求完成后按实际 usage 结算**：用 provider 返回的真实 token usage 替换预留，释放多余预留或补扣超出的部分。

如果 provider 没有返回 usage，或者请求中断，应按保守估算结算，避免用户通过断连逃避 token budget。

## Token 计数口径

第一版建议按 `total_tokens` 限制：

```text
total_tokens = prompt_tokens + completion_tokens
```

同时持久化：

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `cached_prompt_tokens`
- `estimated_tokens`
- `usage_source`

`cached_prompt_tokens` 第一版仍计入 `total_tokens`。原因是这里的目标是保护订阅池和上游容量，而不是按 OpenAI 价格精确计费。如果未来要按成本计费，可以再引入 `billing_units`，对 cached tokens 设置不同权重。

## API Key 配置模型

保持 `rate_json` 向后兼容，在现有 request limit 字段下增加可选 `token` 对象。

示例：

```json
{
  "requestsPerMinute": 10,
  "requestsPerDay": 200,
  "concurrentRequests": 4,
  "token": {
    "tokensPerMinute": 100000,
    "tokensPerDay": 1000000,
    "tokensPerMonth": 10000000,
    "maxPromptTokensPerRequest": 200000,
    "maxTotalTokensPerRequest": 300000,
    "reserveTokensPerRequest": 50000,
    "missingUsageCharge": "reserve"
  }
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `tokensPerMinute` | 每 UTC minute 可消耗的 total tokens；`null` 表示不限 |
| `tokensPerDay` | 每 UTC day 可消耗的 total tokens；`null` 表示不限 |
| `tokensPerMonth` | 每 UTC month 可消耗的 total tokens；`null` 表示不限 |
| `maxPromptTokensPerRequest` | 单请求 prompt 估算 token 上限 |
| `maxTotalTokensPerRequest` | 单请求最终 total token 上限 |
| `reserveTokensPerRequest` | 无法可靠估算输出时的默认预留量 |
| `missingUsageCharge` | provider 未返回 usage 时的扣账策略：`none`、`estimate`、`reserve` |

TypeScript 建议：

```ts
export interface RateLimitPolicy {
  requestsPerMinute: number;
  requestsPerDay: number | null;
  concurrentRequests: number | null;
  token?: TokenLimitPolicy;
}

export interface TokenLimitPolicy {
  tokensPerMinute?: number | null;
  tokensPerDay?: number | null;
  tokensPerMonth?: number | null;
  maxPromptTokensPerRequest?: number | null;
  maxTotalTokensPerRequest?: number | null;
  reserveTokensPerRequest?: number | null;
  missingUsageCharge?: "none" | "estimate" | "reserve";
}
```

缺省行为：

- 老 API key 没有 `token` 字段时，不启用 token budget。
- 新 API key 可以由 admin CLI 指定 token 限额。
- controlled trial key 建议同时配置 request limit 和 token limit。

## SQLite Schema

### request_events 增加 token 字段

用于审计和报表：

```sql
ALTER TABLE request_events ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE request_events ADD COLUMN completion_tokens INTEGER;
ALTER TABLE request_events ADD COLUMN total_tokens INTEGER;
ALTER TABLE request_events ADD COLUMN cached_prompt_tokens INTEGER;
ALTER TABLE request_events ADD COLUMN estimated_tokens INTEGER;
ALTER TABLE request_events ADD COLUMN usage_source TEXT;
ALTER TABLE request_events ADD COLUMN limit_kind TEXT;
```

`usage_source` 建议值：

- `provider`
- `estimate`
- `reserve`
- `none`

`limit_kind` 建议值：

- `request_minute`
- `request_day`
- `concurrency`
- `token_minute`
- `token_day`
- `token_month`
- `token_request`

### token usage window counter

用于快速准入判断，避免每次扫描 `request_events`。

```sql
CREATE TABLE credential_token_windows (
  credential_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_start TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, window_kind, window_start)
);

CREATE INDEX idx_credential_token_windows_updated
  ON credential_token_windows(updated_at);
```

`window_kind`：

- `minute`
- `day`
- `month`

`window_start` 使用 UTC ISO 字符串：

- minute: `2026-04-28T10:34:00.000Z`
- day: `2026-04-28T00:00:00.000Z`
- month: `2026-04-01T00:00:00.000Z`

### active token reservation

用于并发准入。

```sql
CREATE TABLE credential_token_reservations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  estimated_prompt_tokens INTEGER NOT NULL,
  estimated_total_tokens INTEGER NOT NULL,
  minute_window_start TEXT NOT NULL,
  day_window_start TEXT NOT NULL,
  month_window_start TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finalized_at TEXT,
  final_total_tokens INTEGER,
  final_usage_source TEXT
);

CREATE INDEX idx_token_reservations_credential_active
  ON credential_token_reservations(credential_id, finalized_at, expires_at);
```

如果进程崩溃导致 reservation 未 finalize，cleanup 时应按 `missingUsageCharge` 策略结算。建议默认 `reserve`，即把过期 reservation 当作已消耗预留 token 记账，保护上游额度。

## 准入算法

新增 `CredentialQuotaLimiter`，合并现有 request limit 和 token budget。

输入：

```ts
interface QuotaAcquireInput {
  requestId: string;
  credentialId: string;
  policy: RateLimitPolicy;
  estimatedPromptTokens?: number;
  estimatedTotalTokens?: number;
  now?: Date;
}
```

输出：

```ts
type QuotaAcquireResult =
  | { ok: true; requestPermit: RateLimitPermit; tokenReservation?: TokenReservationPermit }
  | GatewayError;
```

流程：

1. 鉴权通过，拿到 API key record 和 `rate_json`。
2. request limit 检查：
   - minute request count；
   - day request count；
   - concurrency。
3. 如果没有 `policy.token`，直接放行。
4. 根据实际发给上游的 prompt string 做 token 估算。
5. 计算 reservation：

```text
reserved_tokens = max(estimatedTotalTokens, reserveTokensPerRequest)
```

6. 在 SQLite transaction 中检查：

```text
current_window_used + active_window_reservations + reserved_tokens <= configured_limit
```

7. 如果超限，返回 `429 rate_limited`，`retry_after_seconds` 指向下一个可用窗口。
8. 如果通过，插入 `credential_token_reservations`。
9. provider 完成后 finalize reservation，写入实际 token usage。

SQLite 准入必须使用 `BEGIN IMMEDIATE` 事务，保证多 gateway 进程时也不会并发超卖。

## Token 估算

第一版可以不引入 tokenizer 依赖，使用保守估算：

```ts
estimatedPromptTokens = Math.ceil(prompt.length / 3);
```

对中文和 JSON/tool schema 较多的请求，这个估算偏保守是可以接受的，因为 reservation 只是准入占用，最终会用 provider usage 结算。

更准确的后续方案：

- 引入 tokenizer；
- 按模型族选择 tokenizer；
- 对 strict client tools 的 tool schema 单独计入；
- 对 native session route 的原始 message 和历史上下文分别估算。

## 完成后结算

provider 返回 `completed.usage` 时：

```ts
finalPromptTokens = usage.promptTokens;
finalCompletionTokens = usage.completionTokens;
finalTotalTokens = usage.totalTokens;
finalCachedPromptTokens = usage.cachedPromptTokens ?? 0;
usageSource = "provider";
```

如果没有 provider usage：

- `missingUsageCharge = "none"`：不扣 token，只记录 `usage_source = "none"`。
- `missingUsageCharge = "estimate"`：扣 `estimatedTotalTokens`。
- `missingUsageCharge = "reserve"`：扣 `reservedTokens`。

建议 controlled trial 使用 `reserve`，因为订阅池比单个用户余额更需要保护。

如果实际 `finalTotalTokens` 超过 `maxTotalTokensPerRequest`：

- 当前请求已经完成，不能撤回上游消耗；
- 仍返回正常结果；
- 记录 `limit_kind = "token_request"` 和 `token_overrun`；
- 后续请求会因为余额不足被拒绝。

如果未来 SDK 支持 max output tokens，应在调用上游时同步设置输出上限，真正阻止单请求 runaway completion。

## 错误响应

对外继续使用已有错误 code：`rate_limited`，避免破坏客户端兼容性。

OpenAI-compatible 响应：

```json
{
  "error": {
    "message": "Token budget exceeded.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "retry_after_seconds": 3600
  }
}
```

内部观测用 `limit_kind` 区分是 request limit 还是 token limit。

## Admin CLI

`issue` 增加：

```text
--tokens-per-minute <n|none>
--tokens-per-day <n|none>
--tokens-per-month <n|none>
--max-prompt-tokens-per-request <n|none>
--max-total-tokens-per-request <n|none>
--reserve-tokens-per-request <n>
--missing-usage-charge <none|estimate|reserve>
```

`update-key` 增加同样参数。

`list` 和 `GET /gateway/credentials/current` 返回 token policy。

`report-usage` 增加 token 汇总字段：

```json
{
  "requests": 10,
  "ok": 9,
  "errors": 1,
  "rate_limited": 1,
  "prompt_tokens": 120000,
  "completion_tokens": 18000,
  "total_tokens": 138000,
  "cached_prompt_tokens": 60000
}
```

建议新增只读命令：

```text
token-usage --user <id> --days 7
token-usage --credential-prefix <prefix> --days 7
token-windows --credential-prefix <prefix>
```

## 路由行为

需要覆盖：

- `/v1/chat/completions`
- native `/sessions/:id/messages`

不需要 token budget 的路由：

- `/gateway/health`
- `/gateway/credentials/current`
- `/v1/models`
- `/v1/models/:id`

`/gateway/credentials/current` 仍应跳过普通请求限流和 token 限流，方便客户端验证 API key。

## Streaming 注意事项

streaming 请求也必须有 reservation。

完成时：

- 如果收到 `completed.usage`，按 provider usage finalize。
- 如果客户端断连导致 abort 且没有 usage，按 `missingUsageCharge` 结算。
- 如果 response 已开始但后续发生 provider error，仍应按已预留策略 finalize，避免长流断连免费消耗。

## 多进程与部署

当前 request count limiter 是 in-process，文档中已标记多进程共享限流尚未完成。token budget 第一版建议直接做 SQLite-backed limiter，不要再做纯内存版本，否则多进程会超卖。

要求：

- token reservation 和 token window update 必须在 SQLite transaction 中完成；
- gateway 多实例共享同一个 SQLite DB 时仍能正确限流；
- 未来迁移到 Redis/Postgres 时，接口保持 `TokenBudgetStore` 不变。

## 实施阶段

### Phase 1：只记录 token usage

- 给 `request_events` 增加 token 字段。
- 在 OpenAI-compatible 和 native routes 完成后记录 usage。
- `events` 和 `report-usage` 输出 token 字段。
- 不做阻断。

价值：先确认 usage 覆盖率和真实消耗分布。

### Phase 2：单请求上限和日/月 token budget

- 扩展 `RateLimitPolicy.token`。
- Admin CLI 支持 token limit 参数。
- 加 SQLite-backed token reservation 和 token windows。
- `/v1/chat/completions` 先接入。
- token 超限返回 `429 rate_limited`。

价值：真正限制具体 API key 的 token 消耗。

### Phase 3：覆盖 native session 和 streaming 边界

- native `/sessions/:id/messages` 接入同一套 token budget。
- streaming 断连按策略结算。
- strict client tools 的 repair attempt 也纳入同一个 request 的 token 结算。

### Phase 4：运营报表和自动化

- token-usage / token-windows CLI。
- trial-check 检查 active key 是否有 token cap。
- retention 策略覆盖 token windows 和 reservations。
- 如需要，再加入 billing_units 和成本报表。

## 推荐 controlled trial 默认值

当前 1-2 个受信用户试用，建议保守配置：

```json
{
  "requestsPerMinute": 10,
  "requestsPerDay": 200,
  "concurrentRequests": 4,
  "token": {
    "tokensPerMinute": 250000,
    "tokensPerDay": 2000000,
    "tokensPerMonth": 30000000,
    "maxPromptTokensPerRequest": 250000,
    "maxTotalTokensPerRequest": 350000,
    "reserveTokensPerRequest": 100000,
    "missingUsageCharge": "reserve"
  }
}
```

这些值需要用真实 `report-usage` 数据校准。`gpt-5.5 high` 的长上下文请求可能 token 消耗较高，第一周应每天看 token usage report。

## 测试用例

单元测试：

- 老 `rate_json` 没有 `token` 字段时不启用 token budget。
- `tokensPerDay = 1000` 时，已用 900、reservation 200 应拒绝。
- 并发两个 reservation 时，第二个不能超卖。
- finalize 后使用实际 provider usage 替换 reservation。
- provider usage 缺失时按 `missingUsageCharge` 扣账。
- UTC day/month window rollover 正确。

路由测试：

- token budget 充足时 `/v1/chat/completions` 正常返回 usage。
- token budget 不足时返回 OpenAI-compatible 429。
- `/gateway/credentials/current` 不消耗 token。
- streaming 正常完成后 token windows 增加。
- streaming 断连后 reservation 被按策略结算。

Admin CLI 测试：

- `issue` 能设置 token policy。
- `update-key` 能修改 token policy。
- `list` 不暴露 raw token，但展示 token policy。
- `report-usage` 聚合 token 字段。
- `trial-check` 能提示 active key 没有 token cap。

## 验收标准

1. 每个 API key 可配置 token minute/day/month 和单请求上限。
2. token 超限请求在调用上游前被拒绝。
3. 并发请求不会突破同一个 API key 的 token budget。
4. provider usage 返回后会准确写入 request event 和 token window。
5. provider usage 缺失或 streaming 断连时按配置保守扣账。
6. Admin CLI 可以签发、更新、查看和汇总 token limit。
7. 现有 request limit、concurrency limit、credential auth、public smoke 和 strict tools smoke 不回归。
