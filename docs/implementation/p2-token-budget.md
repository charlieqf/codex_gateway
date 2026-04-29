# P2 Token Budget 落地设计

| Field | Value |
| --- | --- |
| 状态 | Draft |
| 作者 | Charles Feng |
| 日期 | 2026-04-29 |
| 范畴 | token budget Phase 2 实施细则 |
| 关联 | `docs/implementation/medcode-api-key-token-budget.md`（前置框架）；`docs/implementation/upstream-accounts-rename.md`（同期改名）；后续 plan/entitlement 设计 |

## 1. 文档定位

`medcode-api-key-token-budget.md` 已经把 token budget 的整体框架（计数口径、policy 字段、reservation 思路、错误响应）讲清楚。本文**承接并修订**那份设计，明确以下尚未拍板或与近期演进冲突的细节：

- Window / reservation 的归属维度（credential vs subject vs entitlement）。
- Reservation 生命周期与故障恢复。
- 与现有 `InMemoryCredentialRateLimiter`、rate-limit hook、observation 的集成边界。
- 多路由（`/v1/chat/completions` / native `/sessions/:id/messages`）的统一接入策略。
- 公开 surface 的暴露范围，与 rename 设计的 `upstream_account_label` 等字段一起验证。
- 测试规范化到具体可执行项。

凡本文未提到的字段口径（`total_tokens` 计数、`missingUsageCharge` 三档语义、OpenAI 错误格式等），沿用前置文档原文。

## 2. 关键决策摘要

| 决策点 | 前置文档结论 | 本文修订 |
| --- | --- | --- |
| Policy 归属 | `access_credentials.rate_json.token`（per credential） | **沿用 per credential**，不引入新表 |
| Window 归属 | `credential_token_windows`（per credential） | **改为 per subject**：PK `(subject_id, window_kind, window_start)` |
| Reservation 归属 | `credential_token_reservations`（per credential） | **改为 per subject**，但同时保留 `credential_id` 列做审计 |
| 表名前缀 | `credential_token_*` | 改为 `token_windows` / `token_reservations`，去掉"credential"语义包袱 |
| Rate 限流位置 | 没说 | request-count limit 维持 `InMemoryCredentialRateLimiter`（in-process，preHandler）；token budget 走 SQLite，**在 handler 内、identity guard 之后、provider 调用之前 acquire**（不在 preHandler） |
| 多路由覆盖 | Phase 2 仅 `/v1/chat/completions`，Phase 3 才覆盖 native | 本期一次性覆盖 `/v1/chat/completions` + native `/sessions/:id/messages` |
| 公开 surface | 未提 | `/gateway/credentials/current` 增补 `token` 配额、`used` / `reserved` / `remaining` 三列，公式见 §10 |
| 故障 reservation 结算 | "默认按 reserve 记账" | acquire 时把 `missingUsageCharge` 快照写入 reservation 行；cleanup / abort / 进程崩溃后均按该快照结算（与正常 abort 一致） |
| 老 credential 无 policy | "不启用 token budget"（默认放行） | **保留默认放行**，但仍走统一 token charge 路径（见下行）：在 provider 调用前 snapshot 三个窗口、调用结束后写一行 `token_reservations`（`kind='soft_write'`、`reserved_tokens=0`），并按 snapshot 写入 windows |
| Overrun 标记 | "记 `limit_kind='token_request'` + `token_overrun`" | 命中前置上限时写 `limit_kind='token_request_prompt'` / `token_request_total`；**事后**发现 final usage 超 `maxTotalTokensPerRequest` 写新列 `over_request_limit=1` + audit action `token-overrun`（核心类型新增） |
| Token 账务事实表 | 未提（report 全靠 `request_events`） | **`token_reservations` 升格为账务事实表**：所有 token 扣账（reservation finalize、cleanup 过期结算、soft-write）都写入这张表。`request_events.{prompt,completion,total}_tokens` 降为"反射拷贝"，仅在 observation 能跑时由 onResponse 同步——但**它不是账务真相**。`report-usage` 的 token 维度从 `token_reservations` 聚合，避免崩溃后漏账 |
| Audit 写入纪律 | 未明确 | overrun / cleanup-expired audit 是 **best-effort post-commit**：主事务（reservation + windows）先 COMMIT，audit INSERT 在独立事务里；audit 写入失败不回滚账务，但通过 logger 记 warn |

理由：

- **Subject 维度的 window** 是为对齐近期演进。S11 例行轮换下新旧 credential 共享同一 subject，应共享同一 token 配额，避免轮换变成"刷一次额度"。S3 多 subject 互相隔离仍由 subject 维度天然满足。同时为后续 P3 plan/entitlement 接入做准备：entitlement 也是 per subject 的，policy 来源可以从 credential 平滑过渡到 entitlement，windows 不动。
- **Policy 仍 per credential** 是为本期不引入 entitlement 表；P3 之前的过渡期，credential 是唯一持有 policy 的对象。后续 P3 落地时新增 `entitlements` 表，限流 hook 读 policy 的来源切换，windows schema 不动。
- **Subject 内多 credential（如 S11 grace 期）冲突的 policy 选择**：本期采用"用当前请求的 credential 的 policy"。两个 credential 同时活跃且 policy 不同的场景仅在 24h 轮换 grace 期内出现，且运维通常用相同/更宽松 policy 轮换；若发现滥用再升级到"取最严"。该选择写入待定项 §16，便于 P3 重新评估。
- **Identity guard 优先**：identity-probing guard（`docs/implementation/medcode-identity-probing-guard.md`）明确"明显窥探问题不调用上游、不消耗订阅池额度"。token budget acquire 必须在 guard 之后；guard hit 不进入 reservation、不更新 windows。详见 §9。
- **老 credential 软写入走统一 ledger**：若 P2 期间允许同 subject 既有"有 policy"的新 credential 又有"无 policy"的老 credential，老 credential 不阻断、不做 acquire 校验，但**仍走 reservation 写入路径**——在 provider 调用前 snapshot minute/day/month windows、调用完成后写一行 `kind='soft_write'` 的 `token_reservations`（`reserved_tokens=0`），并按 snapshot 累加 windows。这与 reservation 路径共用窗口归属逻辑，避免长请求跨窗口时两条路径归账不一致。enforcement 仅对有 policy 的 credential 生效；trial-check 给出 warning 提示运维补 policy。
- **`token_reservations` 是账务真相**：crash recovery 与 cleanup 路径只更新 `token_reservations` + `token_windows` + 写一条 best-effort audit；不写 `request_events`（observation hook 此时已不在）。`report-usage` 的 token 聚合从 `token_reservations` 来，因此即便 finalize 后 / observation 前进程崩溃，token 账务也无漏。`request_events.{prompt,completion,total}_tokens` 仍由 observation 在线请求路径时填写，作为"按请求维度看 token"的视图，但不是 source of truth。详见 §7、§11。

## 3. 数据模型

### 3.1 RateLimitPolicy 扩展

`packages/core/src/types.ts` 中 `RateLimitPolicy` 增加可选 `token`：

```ts
export interface RateLimitPolicy {
  requestsPerMinute: number;
  requestsPerDay: number | null;
  concurrentRequests: number | null;
  token?: TokenLimitPolicy | null;
}

export interface TokenLimitPolicy {
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  maxPromptTokensPerRequest: number | null;
  maxTotalTokensPerRequest: number | null;
  reserveTokensPerRequest: number;
  missingUsageCharge: "none" | "estimate" | "reserve";
}
```

字段含义见前置文档。新约束：

- `reserveTokensPerRequest` 不可为 `null`（必须能反映"无估算时该扣多少"）；老 credential 缺省值在 store 层补默认。
- `missingUsageCharge` 不可缺省；若 `token` 对象存在但该字段缺省，store 层报错（避免运维静默掉到 `none`）。
- 五个上限字段（`tokensPerMinute` / `tokensPerDay` / `tokensPerMonth` / `maxPromptTokensPerRequest` / `maxTotalTokensPerRequest`）**各自独立**为 `null` 表示**该项不限**；任意一项非 `null` 则该项强制执行。
- **是否启用 token budget 仅看 `policy.token` 整个对象是否存在**（`undefined` 或 `null` ⇒ 不启用，跳过 acquire/finalize、走 §4 soft-write 路径）。三个 window 字段全 `null` 不等价于"不启用"——若 `policy.token` 存在但所有 window 都不限、单请求上限非 null，仍要走 acquire 流程做 reservation 与单请求上限校验。
- 所有上限比较一律写成 `if (limit !== null && value > limit)`，**禁止**把 `null` 当作 `0` 或 `Infinity` 隐式转换；store 层与 hook 层都必须显式 null guard。

### 3.2 SQLite Schema（新增）

```sql
-- 滑动窗口计数（per subject）
CREATE TABLE token_windows (
  subject_id    TEXT NOT NULL,
  window_kind   TEXT NOT NULL CHECK (window_kind IN ('minute','day','month')),
  window_start  TEXT NOT NULL,             -- UTC ISO，前置文档 §"token usage window counter"
  prompt_tokens         INTEGER NOT NULL DEFAULT 0,
  completion_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  cached_prompt_tokens  INTEGER NOT NULL DEFAULT 0,
  requests              INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (subject_id, window_kind, window_start),
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE INDEX idx_token_windows_subject_kind
  ON token_windows(subject_id, window_kind, window_start DESC);

-- Token 账务事实表（per subject）
-- 既承载 reservation 生命周期，也承载 soft-write 路径；report-usage 的 token 聚合从这张表来。
CREATE TABLE token_reservations (
  id                       TEXT PRIMARY KEY,
  request_id               TEXT NOT NULL UNIQUE,
  subject_id               TEXT NOT NULL,
  credential_id            TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('reservation','soft_write')),
  reserved_tokens          INTEGER NOT NULL,         -- soft_write 时为 0
  estimated_prompt_tokens  INTEGER NOT NULL,         -- soft_write 时为 0
  estimated_total_tokens   INTEGER NOT NULL,         -- soft_write 时为 0
  minute_window_start      TEXT NOT NULL,            -- 两路径都在 provider 调用前 snapshot
  day_window_start         TEXT NOT NULL,
  month_window_start       TEXT NOT NULL,
  charge_policy_snapshot   TEXT NOT NULL,            -- 'none' | 'estimate' | 'reserve'；soft_write 时为 'none'
  max_total_tokens_per_request INTEGER,              -- 快照；soft_write 为 NULL
  scope                    TEXT NOT NULL,            -- 用于 report 维度
  provider                 TEXT NOT NULL,
  upstream_account_id      TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  expires_at               TEXT NOT NULL,            -- soft_write 时仍设默认（5min），但 cleanup 实际不会触发它
  finalized_at             TEXT,
  final_prompt_tokens      INTEGER,                  -- 新增：账务字段必须从这里聚合
  final_completion_tokens  INTEGER,
  final_total_tokens       INTEGER,
  final_cached_prompt_tokens INTEGER,
  final_usage_source       TEXT,                     -- 'provider' | 'estimate' | 'reserve' | 'none' | 'soft_write'
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (credential_id) REFERENCES access_credentials(id)
);

-- acquire 时按窗口归属过滤 active reservation 的索引：
CREATE INDEX idx_token_reservations_minute_active
  ON token_reservations(subject_id, minute_window_start, finalized_at, expires_at);
CREATE INDEX idx_token_reservations_day_active
  ON token_reservations(subject_id, day_window_start, finalized_at, expires_at);
CREATE INDEX idx_token_reservations_month_active
  ON token_reservations(subject_id, month_window_start, finalized_at, expires_at);

-- cleanup 索引：
CREATE INDEX idx_token_reservations_expiry
  ON token_reservations(finalized_at, expires_at);
```

`charge_policy_snapshot` 与 `max_total_tokens_per_request` 在 acquire 时从当前 `policy.token` 拷贝。后续 finalize / cleanup / abort 一律读这两个快照，**不**再读 credential 当下的 policy（避免 policy 在请求生命周期内被 admin 修改导致结算口径不一致）。

`scope` / `provider` / `upstream_account_id` 在 acquire / soft-write begin 时从 request context 拷贝，让 `report-usage` 能从 `token_reservations` 直接出 scope / provider / upstream_account 维度的聚合，无需 join 其它表（与 `request_events` 现有报表口径对齐）。

`kind='soft_write'` 行用于无 policy 的老 credential：`reserved_tokens=0`、`charge_policy_snapshot='none'`、`max_total_tokens_per_request=NULL`、`final_usage_source='soft_write'`；其余字段语义与 reservation 行一致。两路径共用同一张表是为：
1. `report-usage` 聚合 token 时无需区分（一次查询覆盖所有扣账）。
2. 窗口归属逻辑统一（snapshot 在 provider 调用前，写回也按 snapshot），避免长请求跨窗口的归账漂移。
3. crash recovery 不需要分支处理。

### 3.3 request_events 扩展

前置文档已经新增 `prompt_tokens` 等字段（migration 4）；本期再补：

```sql
ALTER TABLE request_events ADD COLUMN limit_kind          TEXT;            -- 命中前置限流时填写
ALTER TABLE request_events ADD COLUMN reservation_id      TEXT;            -- 关联 token_reservations.id（可空）
ALTER TABLE request_events ADD COLUMN over_request_limit  INTEGER NOT NULL DEFAULT 0;  -- final usage 超 maxTotalTokensPerRequest 时置 1
ALTER TABLE request_events ADD COLUMN identity_guard_hit  INTEGER NOT NULL DEFAULT 0;  -- guard 命中时置 1（不消耗 token，仍记观测）
```

`limit_kind` 取值（与前置文档统一规范化）：

| 值 | 含义 |
| --- | --- |
| `request_minute` | request count 分钟级限 |
| `request_day` | request count 日级限 |
| `concurrency` | 并发数限 |
| `token_minute` | token 分钟级限 |
| `token_day` | token 日级限 |
| `token_month` | token 月级限 |
| `token_request_prompt` | acquire 时 prompt 估算超 `maxPromptTokensPerRequest` |
| `token_request_total` | acquire 时 reservation 超 `maxTotalTokensPerRequest`（事前判定） |

`over_request_limit=1` 与 `limit_kind` 是不同维度：前者是事后超额（请求已通过 acquire、上游已花费），后者是事前拒绝。两者互斥不出现在同一行（事前已拒就不会进 provider）。

`identity_guard_hit=1` 时：`status='ok'`、`limit_kind=null`、`reservation_id=null`、`prompt_tokens / completion_tokens / total_tokens=0`、`usage_source='none'`。

## 4. Reservation 生命周期

```
acquire (BEGIN IMMEDIATE)
  ├── load credential.rate.token policy
  ├── if policy is undefined or null → return ok, no reservation, no DB write (soft-write path on completion)
  ├── compute window_starts (now): minute_ws, day_ws, month_ws
  ├── compute estimated_prompt_tokens
  ├── if (policy.maxPromptTokensPerRequest !== null) and estimated_prompt_tokens > policy.maxPromptTokensPerRequest
  │     → 'token_request_prompt' reject (no INSERT)
  ├── compute reserved_tokens = max(estimated_total_tokens, policy.reserveTokensPerRequest)
  ├── if (policy.maxTotalTokensPerRequest !== null) and reserved_tokens > policy.maxTotalTokensPerRequest
  │     → 'token_request_total' reject (no INSERT)
  ├── read three windows separately:
  │     used_minute = token_windows[(subject, 'minute', minute_ws)].total_tokens (default 0)
  │     used_day    = token_windows[(subject, 'day',    day_ws)].total_tokens
  │     used_month  = token_windows[(subject, 'month',  month_ws)].total_tokens
  ├── sum active reservations PER WINDOW (filtered by matching window_start):
  │     active_minute = SUM(reserved_tokens) WHERE subject=? AND minute_window_start=minute_ws AND finalized_at IS NULL AND expires_at > now
  │     active_day    = ...                                           AND day_window_start=day_ws ...
  │     active_month  = ...                                           AND month_window_start=month_ws ...
  ├── per-window check (skip if limit is null):
  │     if (policy.tokensPerMinute !== null && used_minute + active_minute + reserved_tokens > policy.tokensPerMinute)
  │           → 'token_minute' reject
  │     if (policy.tokensPerDay    !== null && used_day    + active_day    + reserved_tokens > policy.tokensPerDay)
  │           → 'token_day'    reject
  │     if (policy.tokensPerMonth  !== null && used_month  + active_month  + reserved_tokens > policy.tokensPerMonth)
  │           → 'token_month'  reject
  ├── snapshot policy.missingUsageCharge & policy.maxTotalTokensPerRequest（后者可为 null，原样保存）
  ├── INSERT INTO token_reservations (..., minute_ws, day_ws, month_ws, charge_policy_snapshot, max_total_tokens_per_request, expires_at)
  └── COMMIT

注：上面"全为 null 的 windows"情况下仍要 INSERT reservation（为后续 finalize/abort 路径与单请求上限统计提供锚点），只是没有 window-level reject 触发。

finalize (BEGIN IMMEDIATE) — 由 acquire 路径成功后的请求结束时调用
  ├── lookup reservation by request_id
  ├── if already finalized → return cached result (idempotent)
  ├── if provider usage available:
  │     final_total = usage.totalTokens; final_source = 'provider'
  │   else:
  │     按 reservation.charge_policy_snapshot 结算（none/estimate/reserve）
  ├── over_limit = (reservation.max_total_tokens_per_request !== null
  │                 && final_total > reservation.max_total_tokens_per_request)
  ├── UPDATE token_reservations SET finalized_at, final_total_tokens, final_usage_source
  ├── UPDATE token_windows[(subject, 'minute', reservation.minute_window_start)] +=
  │     prompt_tokens / completion_tokens / total_tokens / cached_prompt_tokens / requests+1
  │     注意：写入由 reservation 记录的 minute_window_start，不是 now 的 minute_ws
  ├── UPDATE token_windows[day]   同上
  ├── UPDATE token_windows[month] 同上
  ├── COMMIT
  └── return FinalizeResult { reservation_id, final_total_tokens, final_usage_source, over_request_limit }
        — gateway hook 拿到这个结果后挂到 request context，由后续 observation 单点写入 request_events

cleanup_expired (acquire 内顺手；store 启动；admin CLI)
  ├── SELECT * FROM token_reservations WHERE finalized_at IS NULL AND expires_at < now LIMIT 50
  ├── for each: finalize 按 reservation.charge_policy_snapshot 结算
  │     （与正常 abort 完全一致；用 reservation 自身的快照，不用现行 policy）
  └── 写一行 admin audit event 'token-reservation-expired'（aggregated count + sample IDs）

soft-write (老 credential 无 policy 路径) — 走统一 reservation 表，无估算/无校验
  begin (handler 内、provider 调用前):
    ├── snapshot now → minute_ws, day_ws, month_ws
    ├── INSERT INTO token_reservations (
    │     kind='soft_write', reserved_tokens=0, estimated_*=0,
    │     minute_window_start=minute_ws, day_window_start=day_ws, month_window_start=month_ws,
    │     charge_policy_snapshot='none', max_total_tokens_per_request=NULL,
    │     scope, provider, upstream_account_id, ...
    │   )
    └── 把 reservation_id 挂到 request context

  end (response 完成 / abort / error):
    ├── lookup reservation by request_id；幂等
    ├── if provider usage available:
    │     final_total = usage.totalTokens; final_source = 'provider'
    │   else:
    │     final_total = 0; final_source = 'soft_write'
    │     （soft_write 没有 estimate/reserve 兜底，缺 usage 就当 0；它本来就是无强制的观察路径）
    ├── UPDATE token_reservations SET finalized_at, final_*, final_usage_source（如缺 usage 则 'soft_write'）
    ├── UPDATE token_windows[(subject, *, snapshot ws)] += final_*
    └── COMMIT
```

要点：

- **窗口归属由 reservation 行决定**：reservation 创建时 snapshot 三个 `*_window_start`，finalize / cleanup / abort 一律写回 snapshot 指定的窗口；新窗口的 acquire 只看落在新窗口内的 active reservations。这避免了"长请求跨窗口时把上一个窗口的 active 算进新窗口"的误拒。
- **过期 reservation 与正常 abort 同语义**：均按 reservation 行的 `charge_policy_snapshot` 结算。这意味着 `missingUsageCharge='none'` 的请求即使过期也仍是不扣账；`missingUsageCharge='reserve'` 的请求过期才会被按 reserved_tokens 扣。表面上"崩溃后默认扣 reserve 保护订阅池"的效果，由运维在 issue 时把 controlled trial 的默认配成 `reserve` 来达到，**不**靠 cleanup 路径强制覆盖。
- **过期触发**：默认 `expires_at = created_at + 5 min`。HTTP 长流默认在此窗口内完成；超过 5 min 的 streaming 需要单独 heartbeat 延期机制（本期不做，超出请求将被 cleanup 错误结算；由 §16 待定项跟进）。
- **清理时机**：
  - 每次 `acquire` 进入事务前先做一次 batch cleanup（`LIMIT 50`）。
  - `SqliteGatewayStore` 启动时跑一次全量 cleanup。
  - admin CLI `cleanup-token-reservations`（手动）。
- **finalize 幂等**：HTTP 路由结束、abort、错误三种路径都可能 finalize；用 `request_id` 唯一约束 + `finalized_at IS NULL` 双重保护。
- **soft-write 走统一 reservation 路径**：老 credential 无 policy 时不做 acquire 校验，但仍在 provider 调用前 INSERT 一条 `kind='soft_write'` 的 reservation 行（snapshot 三个 windows）；调用结束按 snapshot 写回 windows + 更新 reservation。窗口归属与 reservation 路径一致，长请求跨窗口不会归账漂移。
- **request_events 与 token_reservations 的角色分离**：
  - `token_reservations` 是 **token 账务事实表**：所有扣账（reservation finalize / cleanup-expired / soft-write）都写入它。`report-usage` 的 token 聚合从这张表来。
  - `request_events` 是 **请求观察记录**：每条请求由 observation hook 在 onResponse 时一次性写入（见 §11.0）；token 列是反射拷贝，便于"按请求维度看 token + latency + scope"的报表，但**不是账务真相**。
  - **崩溃恢复的诚实**：当 finalize 后 / observation 前进程崩溃，windows 与 reservation 已 commit、`request_events` 行未写。读 `request_events` 看请求会漏一条（observation 没机会写），但读 `token_reservations` 聚合 token 会**完整**——这是有意设计：账务必须在 finalize 事务里落地，观察可以丢一条。验收 §15 显式覆盖该场景。
  - finalize / cleanup / soft-write 都**不**直接 touch `request_events`，避免与 observation 的 `INSERT ... ON CONFLICT DO UPDATE` 行为发生覆盖竞争。

## 5. Token 估算

前置文档使用 `Math.ceil(prompt.length / 3)`。本期保持，但补：

- **OpenAI 兼容路由 `/v1/chat/completions`**：
  - 估算 = `messages` 文本拼接长度 + `tools` JSON schema 长度（如有）+ `tool_choice`/`response_format` 等控制字段长度，全部 `/3` 向上取整。
  - 视为 `estimated_prompt_tokens`。
- **Native `/sessions/:id/messages`**：
  - 客户端只传一个 message string，但 provider 会带历史会话上下文进入上游。
  - 历史长度网关侧无法准确估算（thread state 在上游侧）。本期对 native 路由用 `request.message.length / 3` 作为下限估算，并用 `reserveTokensPerRequest` 兜底（默认值建议比 chat/completions 高一档）。
  - 当 finalize 拿到 provider usage 时，过/欠账由 windows update 自然修正。
- **预留输出量**：`estimated_total_tokens = estimated_prompt_tokens + reserveTokensPerRequest`；reserved_tokens = `max(estimated_total_tokens, policy.reserveTokensPerRequest)`。这层 max 防止 prompt 极短但配置 reserve 较大时的低估。
- **校验**：在 reservation 之前先校 `estimated_prompt_tokens > policy.maxPromptTokensPerRequest`，命中即拒（`limit_kind='token_request_prompt'`）；不开 reservation 也不进事务。

## 6. 准入算法（细节）

完整流程见 §4 acquire 伪代码；本节只补充：

**Active reservation 必须按窗口归属分别汇总**。同一 subject 的 active reservation 在 minute / day / month 三个维度上不一定都属于"当前"窗口（请求时间跨过窗口边界后，旧 reservation 的 `minute_window_start` 与新请求的 `minute_window_start` 不同）。SQL 例：

```sql
SELECT COALESCE(SUM(reserved_tokens), 0)
FROM token_reservations
WHERE subject_id = :subject
  AND minute_window_start = :current_minute_ws
  AND finalized_at IS NULL
  AND expires_at > :now;
-- day / month 三次独立查询，分别用 day_window_start = current_day_ws、month_window_start = current_month_ws
```

不允许做"全局 active 汇总后套到三个窗口"——会把跨窗口的旧 reservation 误算进新窗口的额度里，造成误拒。

**`retry_after_seconds`**：
- `token_minute` → 到下一 UTC 分钟
- `token_day` → 到下一 UTC 日
- `token_month` → 到下一 UTC 月
- `token_request_prompt` / `token_request_total` → **不返回** `retry_after_seconds`（永久拒；客户端必须切短 prompt 或申请提高上限）

**`request_minute` / `request_day` / `concurrency`** 由现有 `InMemoryCredentialRateLimiter` 处理，本节不重复。

## 7. 结算算法

完整流程见 §4 finalize 伪代码；核心规则：

- **provider usage 可用**：`final_total = usage.totalTokens`，`final_source = 'provider'`。
- **缺 usage（abort / streaming early close / provider error）**：按 `reservation.charge_policy_snapshot` 结算（acquire 时已快照），三档语义沿用前置文档。**所有缺 usage 路径走同一规则**（含 cleanup 路径、HTTP error 路径），不允许某条路径偷偷改为更严或更松。
- **windows 增量字段**：

```
token_windows row += {
  prompt_tokens     += usage.promptTokens     (provider) | estimated_prompt_tokens (estimate) | 0 (reserve/none)
  completion_tokens += usage.completionTokens (provider) | (reserved_tokens - estimated_prompt_tokens, ≥0) (reserve) | 0 otherwise
  total_tokens      += final_total
  cached_prompt_tokens += usage.cachedPromptTokens or 0
  requests          += 1
  updated_at        = now
}
```

`cached_prompt_tokens` 与 `total_tokens` 同记一份，本期不打折扣（前置文档已说明）。后续若做 billing_units，再按权重折算。

**事后 overrun（事前已通过 acquire、上游已花费）**：finalize 检测到 `final_total > reservation.max_total_tokens_per_request`（且后者非 null）时：
- finalize 在自身事务内：UPDATE `token_reservations` + `token_windows`（windows 仍按 `final_total` 累加，已发生的成本必须如实计入），并在返回的 `FinalizeResult` 里置 `over_request_limit = true`。
- gateway hook 把 `FinalizeResult` 挂到 request context（`request.gatewayTokenFinalizeResult`）。
- observation hook 在 onResponse 时把 `over_request_limit=1`、`reservation_id`、`final_usage_source` 一并写入 `request_events`（**单点写入**）。`limit_kind` 留空（事前没限）。
- 写一行 `admin_audit_events.action = 'token-overrun'` 由 finalize 同事务完成（详见 §11.2）。audit 不依赖 observation。
- 不阻断请求。

## 8. Streaming 与中断

`/v1/chat/completions` 流式与 native `/sessions/:id/messages` 都需要：

- `acquire` 在路由 handler 内：**identity guard 之后**（详见 §9）、写第一个 SSE 字节前。
- 流过程中遇到 client 断连：
  - 若上游已发 `completed.usage` → 用其 finalize。
  - 否则按 `reservation.charge_policy_snapshot` finalize（与 §7 一致）。
- Strict client tools 的 repair attempt（`/v1/chat/completions` 的 `runStrictClientTools`）属于同一 request，**不**单开 reservation；上游用量按 `completed.usage` 累加（如有两次 completed，取累加）。
- 心跳 SSE comment（`:ping`）不影响 reservation。
- Identity guard 命中：**不**调用 acquire / finalize；走 §3.3 描述的 `identity_guard_hit=1` 观测路径。soft-write 也不触发（guard 路径 provider usage 为 0）。

## 9. 与现有 limiter / hook 的集成

### 9.1 包边界

为避免 admin CLI 反向依赖 gateway app（破坏 workspace 边界——`apps/admin-cli` 当前只依赖 `@codex-gateway/core` 和 `@codex-gateway/store-sqlite`），token budget 拆成三层：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 接口 / 类型 | `packages/core/src/token-budget.ts`（新文件） | `TokenBudgetLimiter` 接口、`LimitKind`、`AcquireSuccess`、`LimitRejection`、`FinalizeResult`、`TokenUsageSnapshot`、`WindowSnapshot` |
| SQLite 实现 | `packages/store-sqlite/src/token-budget.ts`（新文件） | `SqliteTokenBudgetLimiter` 类，注入现有 `DatabaseSync` |
| Gateway 接线 | `apps/gateway/src/services/token-budget-hook.ts` | Fastify hook 与 handler 接线；不含业务实现 |
| Admin CLI 调用 | `apps/admin-cli/src/index.ts` | 通过 `@codex-gateway/store-sqlite` 直接构造 SQLite limiter，调 `getCurrentUsage` / `cleanupExpired` |

`apps/admin-cli/package.json` 不新增对 gateway 的依赖。token-windows / cleanup-token-reservations / token-reservations CLI 通过 `createSqliteTokenBudgetLimiter({ db })` 拿到 reader，直接调接口；不在 CLI 内拼 SQL。

### 9.2 接口

```ts
export interface TokenBudgetLimiter {
  acquire(input: AcquireInput): Promise<AcquireSuccess | LimitRejection>;
  finalize(input: FinalizeInput): Promise<FinalizeResult>;
  beginSoftWrite(input: SoftWriteBeginInput): Promise<{ reservationId: string }>;  // soft-write 入口（provider 调用前）
  finalizeSoftWrite(input: SoftWriteFinalizeInput): Promise<FinalizeResult>;       // soft-write 结尾
  cleanupExpired(now?: Date): Promise<CleanupResult>;                              // 返回清理 ids 与条数
  getCurrentUsage(input: GetUsageInput): Promise<TokenUsageSnapshot>;              // /gateway/credentials/current 与 token-windows CLI 共用
}

export interface AcquireSuccess {
  ok: true;
  reservationId: string;          // policy 路径：reservation 行 id；调用 finalize 必须用这个 id
}

export interface LimitRejection {
  ok: false;
  error: GatewayError;            // code='rate_limited'，对外 message
  limitKind: LimitKind;            // 内部观测用，不向客户端暴露
}

export type LimitKind =
  | 'request_minute' | 'request_day' | 'concurrency'
  | 'token_minute'   | 'token_day'   | 'token_month'
  | 'token_request_prompt' | 'token_request_total';

export interface FinalizeResult {
  reservationId: string;
  kind: 'reservation' | 'soft_write';
  finalTotalTokens: number;
  finalUsageSource: 'provider' | 'estimate' | 'reserve' | 'none' | 'soft_write';
  overRequestLimit: boolean;
}

export interface CleanupResult {
  count: number;
  sampleIds: string[];          // 给 audit 用
}

export interface TokenUsageSnapshot {
  minute: WindowSnapshot;
  day:    WindowSnapshot;
  month:  WindowSnapshot;
}
export interface WindowSnapshot {
  limit: number | null;
  used:  number;
  reserved: number;
  remaining: number | null;       // null 当 limit=null
  windowStart: string;             // ISO8601
}
```

由 SQLite-backed 实现注入。`getCurrentUsage` 在单一事务内读 windows + active reservations，应用 §10 公式后返回；`/gateway/credentials/current` 与 admin CLI `token-windows` 都调它，**禁止**两边各自拼 SQL。

**关键调整 vs 既有 rate-limit hook**：token-budget acquire **不在 preHandler**。原因是 identity-probing guard（输入侧拦截）在 handler 内执行；guard 命中时不调用上游、不消耗订阅池额度，因此 token reservation 必须在 guard 之后。Fastify hook 链顺序：

```
onRequest:   auth → context
preHandler:  rate-limit hook (in-mem request count)        ← 维持原位；reject 时挂 LimitKind 到 context
preHandler:  cleanup-expired-reservations (best-effort, LIMIT 50)
handler:     /v1/chat/completions or /sessions/:id/messages:
               1) parse + validate body
               2) identity guard 检查
                    ├── hit: 直接返回固定回答；标记 identity_guard_hit=1；不 acquire / 不 finalize
                    └── miss: 继续
               3) tokenBudget.acquire(...)
                    ├── LimitRejection → 挂 LimitKind 到 context；返回 'rate_limited' OpenAI 错误
                    └── AcquireSuccess → 挂 reservationId 到 context；继续
               4) provider 调用 / SSE
               5) finalize on completion / abort / error → FinalizeResult 挂到 context
onResponse:  release rate-limit + observation （observation 单点写 request_events）
```

**LimitKind 传播契约**（解决既有 limiter 只返回 `rate_limited` 不带分类的问题）：

- 既有 `InMemoryCredentialRateLimiter.acquire` 返回类型从 `RateLimitPermit | GatewayError` 改为 `RateLimitPermit | LimitRejection`，`LimitRejection` 形态与上面相同。
- `apps/gateway/src/http/rate-limit.ts` rejection 路径调用新 helper `markLimitKind(request, kind)`，把 `LimitKind` 挂到 `request.gatewayLimitKind`。
- token-budget hook 同样调 `markLimitKind`。
- observation hook 在 onResponse 时把 `request.gatewayLimitKind` 写入 `request_events.limit_kind`。
- `GatewayError` **不**新增字段（避免 LimitKind 通过 OpenAI 错误响应泄露给客户端）；分类信息只走 internal context。
- 客户端可见错误仍只含 `code: 'rate_limited'` 与可选 `retry_after_seconds`，与现有合同一致。

context 新字段（`apps/gateway/src/http/context.ts` 扩展 `FastifyRequest` 声明）：

```ts
declare module "fastify" {
  interface FastifyRequest {
    gatewayLimitKind?: LimitKind;                    // 命中限流的具体分类
    gatewayTokenReservationId?: string | null;       // acquire 成功时的 reservation id
    gatewayTokenFinalizeResult?: FinalizeResult;     // finalize 完成后的结果，由 observation 落库
    gatewayIdentityGuardHit?: boolean;
  }
}
```

要点：

- 现有 `rate-limit hook` 不动 hook 顺序；只把 limiter 与 hook 的 reject 路径补上 `LimitKind`。request count 限流照旧在 identity guard 之前生效（guard hit 仍然消耗一次 request count；理由：guard 是廉价 CPU 操作，但仍属于"网关流量"，限流口径要稳定。token 才是订阅池资源，这才是 guard 要保护的）。
- **soft-write**（老 credential 无 policy）走 `onResponse` 钩子调用 `recordObservedUsage`，不进入 acquire/finalize。
- token-budget finalize 必须在 observation 之前完成（保证 `FinalizeResult` 已挂到 context）。
- **observation 是 `request_events` 唯一写入点**：通过读取 context 上的 `gatewayLimitKind` / `gatewayTokenReservationId` / `gatewayTokenFinalizeResult` / `gatewayIdentityGuardHit` 把 §11.1 列出的所有新字段在一次 INSERT/UPSERT 中写入。finalize/limiter/guard 都不直接 touch `request_events`。
- `skipRateLimit: true` 路由（如 `/gateway/credentials/current`）默认同时跳过 token-budget acquire（这些路由不进入 handler 内 token-budget 流程）。
- 新增 route config `skipTokenBudget` 占位，留给后续与 `skipRateLimit` 解耦的需要（默认随 `skipRateLimit`）。

**Identity guard 与 token-budget 的边界**测试案例（§13.2 验证）：
- guard 命中：`token_windows` 无变化、`token_reservations` 无新行；`request_events.identity_guard_hit=1`、`prompt_tokens=0`、`reservation_id=NULL`；返回 `chat.completion` 正常 OpenAI 形态。
- guard miss：与 §4 acquire 一致。

## 10. 公开 surface

### 10.1 `/gateway/credentials/current` 增加 `token` 字段

```jsonc
{
  "valid": true,
  "subject": { ... },
  "credential": {
    "prefix": "...",
    "scope": "code",
    "expires_at": "...",
    "rate": {
      // 既有公开合同：rate 内字段保持 camelCase，本期不改
      "requestsPerMinute": 30,
      "requestsPerDay": 500,
      "concurrentRequests": 1,
      // 新增 token 子对象：保持 rate 内既有 camelCase 风格
      "token": {
        "tokensPerMinute": 100000,
        "tokensPerDay":  1000000,
        "tokensPerMonth": 10000000,
        "maxPromptTokensPerRequest": 200000,
        "maxTotalTokensPerRequest":  300000
        // reserveTokensPerRequest / missingUsageCharge 不暴露
      }
    },
    // token_usage 是 credential 顶层新字段，与 expires_at 同级；与 credential 顶层既有 snake_case 风格一致
    "token_usage": {
      "minute": { "limit": 100000,    "used": 1234,    "reserved": 5000,    "remaining": 93766,     "window_start": "2026-04-29T03:14:00Z" },
      "day":    { "limit": 1000000,   "used": 45678,   "reserved": 5000,    "remaining": 949322,    "window_start": "2026-04-29T00:00:00Z" },
      "month":  { "limit": 10000000,  "used": 567890,  "reserved": 5000,    "remaining": 9427110,   "window_start": "2026-04-01T00:00:00Z" }
    }
  }
}
```

**字段命名约定**（明确分层避免混乱）：

| 位置 | 风格 | 理由 |
| --- | --- | --- |
| `credential.rate.*`（含 `rate.token.*`） | camelCase | 既有公开合同（见 `docs/consumer-technical-guide.md`），本期不改 |
| `credential` 顶层新增字段（如 `token_usage`） | snake_case | 与现有 `expires_at` 等 credential 顶层字段一致 |
| `token_usage.<kind>.*` | snake_case（`window_start`） | 与 token_usage 整体风格一致 |
| Admin CLI JSON 输出 | snake_case | 与现有 CLI 约定一致 |

不存在跨域改动既有 camelCase 字段的情况，本期对老客户端零破坏。

`token_usage` 字段闭环定义：

| 字段 | 含义 | 计算 |
| --- | --- | --- |
| `limit` | 该窗口配置上限 | 来自 credential 的 `policy.token.tokensPer{Minute,Day,Month}`；为 `null` 时该档不限 |
| `used` | 该窗口已结算用量 | `token_windows[(subject, kind, window_start)].total_tokens` |
| `reserved` | 该窗口当前活跃未 finalize 的预留 | 按 §6 SQL 形式 per-window 汇总 |
| `remaining` | 客户端可用配额 | **`max(0, limit - used - reserved)`**；`limit=null` 时本字段为 `null` |
| `window_start` | 窗口起点 | UTC ISO8601 |

公式必须在 consumer guide 内一字不差地写出。客户端不能假设 `remaining = limit - used`——active reservation 的存在意味着真实可用比"已结算"更少；这是 active 请求并发产生的"软占用"，会随 finalize 收敛或释放。

其他规则：
- `token_usage` 只读、瞬态值；不保证两次连续读取一致（reservation 在变）。
- 不暴露 `reserveTokensPerRequest` / `missingUsageCharge`（运维内部细节）。
- 不暴露 reservation 内部 ID。
- 老 credential 无 policy 时 `token` 字段缺省、`token_usage` 字段也整体缺省（避免客户端误以为有限制）。
- 端点本身仍 `skipRateLimit + skipTokenBudget`，不消耗额度。

### 10.2 错误响应

公开错误码继续用 `rate_limited`，不引入新公开码。`error.message` 区分场景：

```
"Token minute budget exceeded."
"Token day budget exceeded."
"Token month budget exceeded."
"Prompt exceeds maxPromptTokensPerRequest."
"Single request would exceed maxTotalTokensPerRequest."
```

`retry_after_seconds` 按 §6 设置；request 级硬上限不返回 retry。

OpenAI 兼容路由用 `openAIErrorPayload`，该函数已支持 `code='rate_limited'` + `retry_after_seconds`。

## 11. Observation 与 Admin CLI

### 11.0 写入纪律

`request_events` 只由 observation hook 一次性写入。所有 token-budget 字段都从 `request` context 读取（见 §9 context 字段）：

| request_events 字段 | 来源 context 字段 | 写入路径 |
| --- | --- | --- |
| `limit_kind` | `request.gatewayLimitKind` | observation onResponse |
| `reservation_id` | `request.gatewayTokenReservationId` 或 `request.gatewayTokenFinalizeResult.reservationId` | observation onResponse |
| `over_request_limit` | `request.gatewayTokenFinalizeResult.overRequestLimit ? 1 : 0` | observation onResponse |
| `usage_source` | `request.gatewayTokenFinalizeResult.finalUsageSource` | observation onResponse（与既有 token usage 字段同行） |
| `identity_guard_hit` | `request.gatewayIdentityGuardHit ? 1 : 0` | observation onResponse |

`TokenBudgetLimiter.finalize` 与 `recordObservedUsage` 与 `markLimitKind` 都**不**直接 touch `request_events`，避免与 observation 的 `INSERT ... ON CONFLICT DO UPDATE` 行为发生覆盖竞争。

`admin_audit_events` 由 finalize（overrun）和 cleanup（reservation expired）直接写入；audit 表与 `request_events` 解耦，不存在覆盖问题。

### 11.1 request_events 新字段

| 字段 | 说明 |
| --- | --- |
| `limit_kind` | 事前命中的限流类型；可为空（未限流） |
| `reservation_id` | 关联 reservation；可为空（guard 命中、或事前失败路径）；soft-write 路径也填（指向对应 `kind='soft_write'` 行） |
| `over_request_limit` | 0/1；事后发现 final usage 超 `maxTotalTokensPerRequest`；与 `limit_kind` 互斥 |
| `identity_guard_hit` | 0/1；guard 命中；该行 prompt/completion/total tokens 应为 0、`reservation_id=NULL`、`limit_kind=NULL` |

注：`request_events.{prompt,completion,total}_tokens` 由 observation hook 在 onResponse 时按 `gatewayTokenUsage` 反射拷贝；这是"按请求维度看 token + latency + scope"的视图。**token 账务真相在 `token_reservations`**（见 §2 决策）。

### 11.1a `report-usage` 数据来源

`report-usage` 输出是两个数据源的合并：

| 维度 | 数据源 | 字段 |
| --- | --- | --- |
| 请求计数、错误率、限流计数、延迟 | `request_events` | `requests`、`ok`、`errors`、`avg_duration_ms`、`avg_first_byte_ms`、`rate_limited_by`、`identity_guard_hit_count` |
| Token 账务（prompt/completion/total/cached） | `token_reservations`（finalized 行） | `prompt_tokens`、`completion_tokens`、`total_tokens`、`cached_prompt_tokens` |
| 事后 overrun 计数 | `token_reservations` WHERE `final_total_tokens > max_total_tokens_per_request` | `over_request_limit_count` |
| Charge 类型分布 | `token_reservations.kind` + `final_usage_source` | `charges_by_kind`（`reservation` / `soft_write`）、`charges_by_source`（`provider` / `estimate` / `reserve` / `none` / `soft_write`） |

`rate_limited_by` 子对象按 `limit_kind` 分桶计数：含 `request_minute`/`request_day`/`concurrency`/`token_minute`/`token_day`/`token_month`/`token_request_prompt`/`token_request_total`。这要求 §9 中既有 `InMemoryCredentialRateLimiter` 也升级到返回 `LimitRejection`，不只是 token 维度。

**为什么 token 维度走 reservations 而不是 request_events**：crash recovery / cleanup 路径不写 `request_events`（observation hook 此时已不在），但 `token_reservations` 已 commit。如果 `report-usage` 的 token 列从 `request_events` 来，崩溃后会少算一笔账，对后续 billing/subscription ledger 是硬伤。

### 11.2 Admin CLI 扩展（仅本期范围）

**core 类型联动**（`packages/core/src/types.ts`）：`AdminAuditAction` 增加两个值——

```ts
export type AdminAuditAction =
  | "issue"
  | "update-key"
  | ...
  | "token-overrun"             // ← 新增
  | "token-reservation-expired" // ← 新增
  | ...
```

新增/修改命令：

- `issue` / `update-key`：增加 `--tokens-per-minute` / `--tokens-per-day` / `--tokens-per-month` / `--max-prompt-tokens-per-request` / `--max-total-tokens-per-request` / `--reserve-tokens-per-request` / `--missing-usage-charge none|estimate|reserve`。每个值除 `--missing-usage-charge` 都接受 `none` 关键字表示不限；`--missing-usage-charge` 必须显式给值（store 层不允许默认）。
- `report-usage`：输出已包含 token 字段，本期补 `rate_limited_by`（按 `limit_kind` 分桶）+ `over_request_limit_count`（事后 overrun 计数）+ `identity_guard_hit_count`。
- `events`：输出新增 §11.1 四个字段。
- `audit`：自然支持新 action 过滤（`--action token-overrun` / `--action token-reservation-expired`）。
- `token-windows`（新）：`--user <id>` 列出该 subject 当前三档 windows 行（minute/day/month）的 `limit` / `used` / `reserved` / `remaining` / `window_start`。仅查询，不阻塞。
- `token-reservations`（新）：`--user <id>` 列出当前未 finalize 的 reservation；`--include-finalized` 列出最近 N 条。仅查询。
- `cleanup-token-reservations`（新）：手动触发 §4 的清理流程；输出清理条数 + 涉及 subject ID 列表（不含详情）。
- `trial-check`：新增检查项"active credential 中 `token` policy 缺失数量"，warning 不 block。

JSON 输出字段：用 snake_case 与现有约定一致。

输出洁净要求沿用 rename 设计：store 构造期默认静默；`--verbose` 打开 stderr logger；CLI stdout 仅 JSON。

**audit 写入约束**（best-effort post-commit）：

token-overrun 与 token-reservation-expired audit 必须**在 reservation/windows 主事务 COMMIT 之后**单独 INSERT，**不与主事务同事务**：

```
finalize() / cleanupExpired():
  BEGIN IMMEDIATE
    UPDATE token_reservations ...
    UPDATE token_windows ...
  COMMIT                                      ← 账务真相落地
  try:
    INSERT INTO admin_audit_events (...)      ← 独立事务，best-effort
  catch (err):
    logger.warn({err, action, ...}, "audit write failed; reservation/windows already committed")
    // 不抛、不回滚
```

理由：
- 主事务里塞 audit 会让 audit 表故障（如磁盘满、约束冲突）反向阻断扣账；这破坏文档其它处"不阻塞"承诺，也违反"账务必须先落地"原则。
- audit 是观测，丢一两行可接受（reservations 自身已是事实）。logger 留痕给运维定位。
- 极端场景（commit 后、audit 写入前进程崩溃）：reservations 已落、audit 缺一行；与"observation 漏写 request_events"同类降级，验收 §15 一并覆盖。

具体内容：
- `token-overrun`：finalize 检测 overrun 时写一行；`params` 含 `request_id`、`reservation_id`、`final_total_tokens`、`max_total_tokens_per_request`、`subject_id`、`credential_id`、`scope`、`upstream_account_id`。
- `token-reservation-expired`：cleanup 路径写一行**汇总**记录（`params` 含 `count` + `sample_ids[]`，避免 audit 表爆炸）。每次 `cleanupExpired` 触发最多写一行 audit。

## 12. 部署与迁移

- 新增 SQLite migration（编号紧随 rename 之后），包含 §3.2 / §3.3 的 DDL。
- 老 credential 的 `rate_json` 不带 `token` 字段时，runtime 视为"无 token 限"，行为不变。
- 新发的 controlled trial credential 强烈建议带 token policy（`trial-check` 给出 warning）。
- token_windows 和 token_reservations 不在现有 retention 策略内，本期单独说明：
  - `token_windows.minute` 行可在窗口结束 + 24h 后清理（节省存储）。
  - `token_reservations` finalize 后保留 30 天用于审计，之后 prune。
  - `prune-events` 命令本期不扩展，留一个 `prune-token-windows` / `prune-token-reservations` 占位。

## 13. 测试规范（验收前提）

### 13.1 store 单元测试

- `BEGIN IMMEDIATE` 串行化：起 N 个 promise 同时调用 `acquire`，断言总扣账 ≤ limit；不依赖时序，应稳定。
- 跨 minute/day/month 窗口翻转：人为推进 `now`，断言新窗口从 0 开始计，老窗口数据不被破坏。
- 同 subject 多 credential 共享 windows：注册 credential A、B（同 subject），先 A 扣 70k，再 B 检查应看到 70k 已用。
- **跨窗口 active reservation 不污染新窗口**：在 11:59 创建 reservation R1（minute_window_start=11:59），不 finalize；时钟推进到 12:00:30 创建 R2，断言 R2 的 acquire 检查时 minute 维度 active reservation 不含 R1（day/month 仍含，因为同一天/同一月）。
- **过期 reservation 按 snapshot 结算（非强制 reserve）**：插入三个 reservation，`charge_policy_snapshot` 分别为 `'none'` / `'estimate'` / `'reserve'`，全部过期；调用 `cleanupExpired`；断言三者 `final_usage_source` 与 snapshot 一致；断言 windows 增量分别为 `0` / `estimated_total_tokens` / `reserved_tokens`。
- finalize 幂等：连续两次 finalize 同一 reservation，windows 只加一次；两次返回同一 `FinalizeResult`。
- 老 credential（`rate_json` 无 `token` 字段）：acquire 不进入 SQLite 事务（用 spy 验证），直接 ok；但 `recordObservedUsage` 调用后 windows 正确增加（soft-write 路径）。
- **Null guard 全量覆盖**：构造一个 `policy.token` 中所有上限字段全为 `null` 的 credential（仅有 `reserveTokensPerRequest` / `missingUsageCharge` 必填），断言 acquire 走完整流程、INSERT reservation、不触发任何 reject；构造同一 policy 但 `tokensPerDay=0` 的 credential，断言任何非零请求都被拒为 `token_day`。
- **getCurrentUsage 单点读**：调用 `getCurrentUsage` 与 `/gateway/credentials/current` 与 admin CLI `token-windows` 三处，断言三者读到的 `limit/used/reserved/remaining/window_start` 完全一致；不允许 route/CLI 直接拼 SQL。
- **LimitRejection 携带 LimitKind**：分别用 `InMemoryCredentialRateLimiter` 和 `TokenBudgetLimiter` 触发各类 reject，断言返回的 `LimitRejection.limitKind` 与 `request_minute` / `request_day` / `concurrency` / `token_*` 一一对应。
- spy `process.stdout.write` 在 store 构造与所有公共方法调用期间为 0。

### 13.2 路由集成测试

- `/v1/chat/completions` 流式与非流式：token policy 充足时正常返回，token_windows 增加。
- `/v1/chat/completions` token 超限：返回 `{ error.code: "rate_limited", retry_after_seconds: <到下一窗口> }`，OpenAI 兼容格式。
- `/v1/chat/completions` 流断连：reservation 按 `charge_policy_snapshot='reserve'` 结算；windows 增量等于 reserved_tokens。
- `/sessions/:id/messages` 同上覆盖。
- `/gateway/credentials/current` 返回 `token_usage`，且自身不消耗 windows（连续调用 100 次 windows 计数不变）；返回字段含 `limit` / `used` / `reserved` / `remaining`，并满足 `remaining = max(0, limit - used - reserved)`。
- Strict client tools 的 repair attempt：单 reservation；windows 增量等于两次 provider usage 累加。
- 同 subject 两 credential 同时打满：第二个 credential 的请求被拒（subject 维度共享）。
- **Identity guard 命中不消耗 token**：发一个明显窥探问题（如 `"你是什么模型？"`）；断言 `token_windows` 无任何变化、`token_reservations` 无新行、`request_events.identity_guard_hit=1`、`reservation_id IS NULL`、HTTP 返回 `chat.completion` 正常 OpenAI 形态。
- **Identity guard miss 后正常 acquire**：发一个普通医学编码问题；断言走完整 acquire/finalize 路径，`identity_guard_hit=0`、`reservation_id` 非空。
- **Soft-write（无 policy 老 credential）走统一 ledger**：用一把不带 token policy 的 credential 调 `/v1/chat/completions`；断言（a）`beginSoftWrite` 在 provider 调用前 INSERT 一行 `kind='soft_write'`、`reserved_tokens=0` 的 reservation 行（snapshot 三个 windows）；（b）`acquire` 路径**不**被调用（因为没 policy）；（c）上游返回 usage 后该行 finalize、windows 按 snapshot 增加。
- **Soft-write 长请求跨窗口归账一致**：构造 soft-write 请求在 11:59:30 begin（snapshot minute_window=11:59）、12:00:30 end；断言 windows 增量计入 11:59 的 minute window（不计入 12:00），与 reservation 路径行为一致；新 credential 在 12:00 发请求看到的 minute window 用量不含此次。
- **同 subject 混用有/无 policy credential**：先用无 policy 的老 credential 消耗 80k（soft-write 行 finalize、windows +80k），再用有 policy（`tokensPerDay=100k`）的新 credential 发请求估算 30k；断言被拒（80k+30k > 100k），windows 反映完整 used。
- **事后 overrun 不阻断**：构造 prompt 估算 100k、实际 provider usage 返回 250k、policy.maxTotalTokensPerRequest=200k；断言请求 `status='ok'`、`over_request_limit=1`、windows 累加 250k、`token_reservations.final_total_tokens=250000`、`admin_audit_events` 多一行 `action='token-overrun'`（注意 audit 在 reservation/windows COMMIT 之后单独写入）。
- **Audit 失败不回滚账务**：mock 让 audit insert 抛错；触发 overrun；断言 reservation 与 windows 已 commit、HTTP 响应正常、logger 有 warn；audit 表无新行。
- **多 finalize 路径一致性**：三种触发（正常完成 / client abort / provider error）下 finalize 都使用 `reservation.charge_policy_snapshot`；用相同 reservation 模板、不同触发路径，断言 windows 增量一致、`final_usage_source` 与 snapshot 一致。
- **崩溃恢复账务无漏**：在 finalize commit 之后、observation 写 request_events 之前 kill -9 进程；重启；断言（a）`token_reservations` 该行已 finalized；（b）`token_windows` 已累加；（c）`request_events` 缺该行（观察漏一笔）；（d）`report-usage` 的 token 列从 `token_reservations` 聚合，仍准确——request 级 `requests` 计数会少一条，但 token 账务零漏。
- 老 credential（无 token policy）正常通过；新 credential（有 policy）受限。

### 13.3 CLI 集成测试

- `issue --tokens-per-day 1000000 --missing-usage-charge reserve` 写入正确的 `rate_json`。
- `update-key --tokens-per-day none` 清掉 `tokensPerDay` 字段。
- `token-windows --user alice` 输出三档 windows，stdout 可 `JSON.parse`。
- `token-reservations --user alice` 在并发请求期间能列出 active reservation。
- `cleanup-token-reservations` 在有过期 reservation 时返回非零计数；无则返回 0。
- `trial-check` 在 active credential 缺少 token policy 时给出 warning 但 `ready_for_controlled_trial=true`（不 block）。

### 13.4 Stress 用例（手动）

- 单 subject 100 并发，limit 1M，每请求 reserve 50k：所有请求要么通过要么拒绝；通过的累计扣账 ≤ 1M；拒绝的 `retry_after_seconds` 与 windows 一致。
- gateway 进程 kill -9 后重启：active reservation 在重启 30s 内被 cleanup（startup hook）；windows 状态一致。

## 14. 实施阶段

| 子阶段 | 内容 |
| --- | --- |
| **P2a** | core 类型扩展（`TokenLimitPolicy`、`limit_kind`）；store schema migration；token_windows / token_reservations 表与查询；store 单元测试 |
| **P2b** | `TokenBudgetLimiter` 服务、token-budget hook、`/v1/chat/completions` 接入；OpenAI 错误返回；observation 联动 |
| **P2c** | native `/sessions/:id/messages` 接入；streaming abort 路径；strict client tools 累加 |
| **P2d** | Admin CLI `issue` / `update-key` / `token-windows` / `token-reservations` / `cleanup-token-reservations`；`trial-check` warning |
| **P2e** | `/gateway/credentials/current` 增补 `token` + `token_usage`；consumer guide 更新；retention 占位命令 |

P2a–P2c 建议合并到一个 PR（schema + 限流核心 + 主路由），避免半态。P2d / P2e 可拆。

## 15. 验收标准

- [ ] core 新增 `TokenLimitPolicy`；老 credential 的 `rate_json` 无 token 字段时反序列化兼容。
- [ ] core `AdminAuditAction` 新增 `'token-overrun'` 与 `'token-reservation-expired'`。
- [ ] 新 SQLite migration 在已有库上幂等执行；`schema_migrations` 表多一行；`SELECT * FROM token_windows` 可执行；`token_reservations` 含 `kind` / `charge_policy_snapshot` / `max_total_tokens_per_request` / `scope` / `provider` / `upstream_account_id` / `final_prompt_tokens` / `final_completion_tokens` / `final_total_tokens` / `final_cached_prompt_tokens` 列；`request_events` 含 `over_request_limit` 与 `identity_guard_hit` 列。
- [ ] `BEGIN IMMEDIATE` 串行化测试通过（§13.1）；并发不超卖。
- [ ] 同 subject 多 credential 共享 windows 测试通过。
- [ ] **跨窗口 active reservation 不污染新窗口**测试通过（§13.1）。
- [ ] **过期 reservation 按 snapshot 结算**测试通过（三档 charge policy 各验证一次）。
- [ ] **Identity guard 命中不开 reservation、不更新 windows** 测试通过；guard miss 走完整路径测试通过。
- [ ] **Soft-write 走统一 ledger**：beginSoftWrite 在 provider 调用前 INSERT `kind='soft_write'` 行（snapshot 三个 windows），finalize 后 windows 与 reservation 一致；acquire 不被调用（spy 验证）。
- [ ] **Soft-write 长请求跨窗口归账一致**：snapshot windows 决定归账目的窗口，与 reservation 路径行为一致；新 credential 在跨窗后看到的 used 不含旧请求。
- [ ] **同 subject 混用有/无 policy credential**：windows 体现完整用量（含 soft_write 行）、enforcement 仅针对有 policy 的 credential。
- [ ] **多 finalize 路径一致性**（正常/abort/error）：均使用 reservation 的 `charge_policy_snapshot`，windows 增量一致。
- [ ] **崩溃恢复账务无漏**：finalize 后、observation 前 kill -9，重启后 `report-usage` 的 token 列从 `token_reservations` 聚合仍准确；`request_events` 缺该行属可接受降级。
- [ ] **Audit best-effort post-commit**：mock audit insert 抛错，主事务（reservation/windows）已 commit 不回滚；logger 有 warn 一行；后续请求正常。
- [ ] **事后 overrun**：写 `over_request_limit=1`、写 audit `token-overrun`、不阻断请求；`request_events` 由 observation 单点写入（finalize 不直接 touch）。
- [ ] **request_events 单点写入**：grep `apps/gateway` 确认仅 observation hook 调用 `insertRequestEvent`；`TokenBudgetLimiter` / `markLimitKind` / identity guard 都不触碰 `request_events`。
- [ ] **null guard 全量覆盖**：所有上限字段比较都形如 `if (limit !== null && value > limit)`；任意单个上限为 null 时该项跳过、不退化为 0/Infinity。
- [ ] **getCurrentUsage 单点读**：`/gateway/credentials/current` 与 admin CLI `token-windows` 都通过 `TokenBudgetLimiter.getCurrentUsage`；route/CLI 不直接拼 SQL；三处读取数据完全一致。
- [ ] **LimitKind 传播**：`InMemoryCredentialRateLimiter` 与 `TokenBudgetLimiter` 的 reject 都返回 `LimitRejection`，hook 通过 `markLimitKind` 挂到 context；`GatewayError` **不**包含 `limitKind` 字段（不向客户端泄露）；observation 在 onResponse 时写入 `request_events.limit_kind`。
- [ ] **rate_limited_by 桶完整**：`report-usage` 输出 8 个 `limit_kind` 桶（含 `request_minute`/`request_day`/`concurrency`/`token_*`）。
- [ ] **`report-usage` token 维度从 `token_reservations` 聚合**：测试在崩溃恢复场景下（`request_events` 漏一行、`token_reservations` 不漏），token 列与真实扣账一致；`request_events` 漏行通过 `requests` 计数差体现。
- [ ] **包边界纪律**：`apps/admin-cli/package.json` 不依赖 `@codex-gateway/gateway`；`token-windows` / `cleanup-token-reservations` / `token-reservations` 通过 `@codex-gateway/store-sqlite` 构造 limiter；`TokenBudgetLimiter` 接口 export 自 `@codex-gateway/core`。
- [ ] **公开字段命名兼容**：`/gateway/credentials/current` 内 `credential.rate.*`（含 `rate.token.*`）保持 camelCase；`credential.token_usage.*` 保持 snake_case；既有 `requestsPerMinute` 等不被改名。
- [ ] `/v1/chat/completions` 流式 / 非流式 / strict tools / 断连四种路径 token windows 与 reservations 数据正确。
- [ ] native `/sessions/:id/messages` 同上四种路径覆盖。
- [ ] token 超限返回 OpenAI 兼容 `rate_limited` + `retry_after_seconds`；request 级硬上限不返回 retry。
- [ ] `/gateway/credentials/current` 含 `token_usage` 且自身不计费；`remaining = max(0, limit - used - reserved)` 公式与字段语义对齐；老 credential 无 policy 时 `token` 与 `token_usage` 都缺省。
- [ ] Admin CLI 全部新命令的 stdout 是合法 JSON；spy `process.stdout.write` 在 store 公共方法 0 调用。
- [ ] `audit --action token-overrun` 与 `audit --action token-reservation-expired` 能正常过滤。
- [ ] `trial-check` 在 active credential 缺 token policy 时 warning 而不 block。
- [ ] 进程 kill -9 重启后 30s 内过期 reservation 自动 finalize；windows 一致；reservation 行 `final_usage_source` 与各自 `charge_policy_snapshot` 一致。
- [ ] 现有 request limit / concurrency / credential auth / strict tools / identity guard / public smoke 测试不回归。
- [ ] consumer technical guide 增补 `token_usage` 字段说明（含 `remaining` 公式）与限流错误处理建议。

## 16. 风险与待定

- **风险 1**：subject 维度 windows 在多 subject + 高并发下事务热点。
  - 缓解：单实例下 `BEGIN IMMEDIATE` 微秒级，可接受；多实例（v2+）再评估迁 PG 或加 Redis layer。同前文"是否升 PG"判断一致。
- **风险 2**：估算保守 `length/3` 在中文/JSON 重场景下偏低，导致 finalize 后 windows 突然超额。
  - 缓解：`reserveTokensPerRequest` 在 trial 期建议拉高（前置文档默认 100k）；后续接 tokenizer 时再细化。trial 第一周每天看 windows vs request_events 对账。
- **风险 3**：reservation 表无界增长（finalize 后保留 30 天）。
  - 缓解：retention 命令占位，trial 末尾手动 prune；下版加 cron。
- **风险 4**：客户端读 `token_usage` 的瞬态值。
  - 缓解：§10 已定义 `remaining` 公式并在 consumer guide 显式标注"截止读取时刻、含 active reservation"。
- **风险 5**：长流（> 5 min）会被 cleanup 误结算。
  - 缓解：本期 streaming 通常 < 5min，遇到长流再加 heartbeat 延期；监控 `token-reservation-expired` audit 频率，超阈值再做 §16 待定项。
- **风险 6**：老 credential 软写入引入"无阻断的额度蒸发"。
  - 缓解：`trial-check` warning + 运维流程要求 trial 启动前所有 active credential 必须有 token policy。warning 期内 windows 仍为新 credential 提供准确 used 视图。

待定：

- 同 subject 多 credential 不同 policy 时的取舍策略（本期"用当前请求的 credential policy"，待 P3 entitlement 上线时统一改为"取 entitlement 的策略"）。
- `token_usage` 是否暴露给 OpenAI 兼容路由的 `headers`（如 `X-RateLimit-*` 风格）？本期不做，后续按客户端反馈决定。
- `prune-token-*` 是否进入 `trial-check` 巡检；本期暂不。
- **P2 启用前置条件**：是否在启用 P2 enforcement 前要求"所有 active credential 都有 token policy"作为硬性 gating（trial-check 由 warning 升级为 error）？倾向"是"，但需要等迁移期老 credential 全量补 policy 后再切。本期先 warning。
- **Streaming 长请求 expires_at 延期**：是否在 streaming heartbeat（25s `:ping`）时同步延长 reservation `expires_at`（如延 5min）？需要权衡复杂度与误清概率，本期不做。
- **Soft-write 路径是否要 audit**：老 credential 用量虽然记入 windows，但没有 reservation 行；是否需要在 audit 留痕"soft-write subject X tokens Y"？本期不做（量大、价值有限）。

---

附：本期完成后，新发 controlled trial credential 应同时配置 request limit 与 token limit；老 credential 行为不变，但 admin CLI 在 `trial-check` 输出 warning 提示运维补 policy。
