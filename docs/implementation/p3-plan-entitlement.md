# P3 Plan / Entitlement 需求说明

| Field | Value |
| --- | --- |
| 状态 | Draft |
| 作者 | Charles Feng |
| 日期 | 2026-04-29 |
| 范畴 | 用户侧"订阅"概念：plan 模板 + entitlement 实例 |
| 关联 | `docs/implementation/upstream-accounts-rename.md`（前置改名）；`docs/implementation/p2-token-budget.md`（前置：token budget 已就绪）；后续 P4 账号池、P5 team accounts、P6 billing |

## 1. 背景

P2 完成后，token budget 由 `access_credentials.rate_json.token` 持有 policy、`token_windows` 与 `token_reservations` 按 subject 维度记账与扣账。这一安排允许 enforcement 跑起来，但有三个语义裂缝：

1. **Policy 与会计的归属错位**：扣账按 subject，policy 按 credential。S11 例行轮换时新旧 credential 同 subject 共享 windows 是对的，但每个 credential 各自带 policy 又允许"轮换换 policy"——和"用户的订阅是稳定的额度"冲突。
2. **没有"订阅"这个用户层面的实体**：你最初问题里的"订阅机制"在仓库内不存在。所有运维语义都被压扁到 credential 层（一把 key 对应一份 policy），无法表达"alice 是 pro 用户、本月 5M tokens 额度"。
3. **`subscription` 词在 rename 之后已经留给用户侧**（见 `upstream-accounts-rename.md` §1）。`subscription` 现在是一个空概念，等待具象化。

P3 的任务是把 plan / entitlement 落到 schema 与运维流程里：

- **Plan**：订阅档位的不可变模板（free / basic / pro / 自定义），定义配额规则、scope 准入、优先级。
- **Entitlement**：subject 在某个账期内对 plan 的实例，是 quota 强制点。
- **Credential**：发给终端的二级凭据，归属 subject，间接继承该 subject 当前 active entitlement 的 quota。

P3 之后 quota 强制点从 credential 迁到 entitlement；token policy 来源从 `credential.rate.token` 改读 entitlement snapshot。`access_credentials.rate_json.token` 降级为可选 override（仅用于演示/临时压低，不允许放宽）。

## 2. 目标

1. 把"用户的订阅档位"作为一等公民落到 schema 与运维流程：plan 表 + entitlement 表，admin CLI 完整管理。
2. Quota policy 来源切换到 entitlement，credential.rate.token 降级为 stricter-only override。
3. 多 credential 同 subject 自然共享同一 entitlement 的 quota（通过 `entitlement_token_windows` 实现，§5.4）；老 P2 `token_windows` 仅服务无 entitlement 的兼容路径。
4. 公开 surface：`/gateway/credentials/current` 暴露 plan 名、账期边界、剩余配额，让客户端能在 UI 显示订阅状态。
5. 老 credential（无对应 entitlement）保留软兼容窗口（与 P2 soft-write 路径一致），通过 `trial-check` 引导运维补齐。
6. 为 P4 账号池调度铺路：plan 字段中预留 `priority_class`、`team_pool_id`，P3 不启用，仅持有。

## 3. 非目标

- 不引入支付、订阅自助升级、客户端续费等任何商业化能力。
- 不实现自动续期；本期手动 `entitlement renew`，P7 再加 cron。
- 不做计费单位 / 美元换算（留给 P6 billing）。
- 不做 plan 的 grace 升级 / proration / 中途换 plan 自动结算（取消旧、新发新，由运维显式做）。
- 不做 entitlement carryover（未用 token 滚入下期），第一版禁用，留待 P3.5 评估。
- 不做 team_pool 实际调度（P5）；本期只持有字段。
- 不改 P2 现有 `token_windows` 表（subject-keyed）；entitlement 路径走新表 `entitlement_token_windows`（见 §5.4）。`token_reservations` 仅加列、不改键。
- 不重构 P2 soft-write 路径；老 credential 兼容期沿用 P2 行为。

## 4. 概念模型

| 概念 | 含义 | 持有者 |
| --- | --- | --- |
| **Plan** | 订阅档位模板（free / basic / pro / 自定义），不可变（修改 = 新版本） | 系统 |
| **Entitlement** | subject 在一个账期内对 plan 的实例；快照 plan policy；是 quota 强制点 | subject |
| **Period** | entitlement 生效的时间段，三种：`monthly` / `one_off` / `unlimited` | entitlement |
| **Credential** | 发给终端的 bearer token；归属 subject；继承 subject 当前 active entitlement 的 quota | subject |
| **Override** | credential.rate.token 中的字段；仅当**严于** entitlement snapshot 时生效；不允许放宽 | credential |

不变量：

1. 任一时刻，一个 subject 最多有一个 `state='active'` 的 entitlement。
2. Entitlement 一旦发出，`policy_snapshot_json` 锁定；后续 plan 改动不影响已发出的 entitlement。
3. 一次请求的 quota 强制以 acquire 时刻该 subject 的 active entitlement 为准；若无 active entitlement，按 §5 处理。
4. credential 不直接持有 quota；`credential.rate.token` 作为 stricter-only override（详见 §6）。
5. 同一 subject 的多个 credential 在 acquire 时看到的 effective policy 完全一致（来自同一 entitlement）。

## 5. 数据模型

### 5.1 plans 表

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,                     -- 'plan_pro_v1'，slug + 版本
  display_name TEXT NOT NULL,              -- 公开展示名 "Pro"
  policy_json TEXT NOT NULL,               -- 完整 TokenLimitPolicy + 扩展字段
  scope_allowlist_json TEXT NOT NULL,      -- '["medical","code"]'
  priority_class INTEGER NOT NULL DEFAULT 5, -- P4 用，本期不启用
  team_pool_id TEXT,                       -- P5 用，本期 NULL
  state TEXT NOT NULL CHECK (state IN ('active','deprecated')),
  created_at TEXT NOT NULL,
  metadata_json TEXT                       -- 自由扩展字段
);
```

约束：
- `id` 不可重用、不可改名；新版本走新 `id`（如 `plan_pro_v1` → `plan_pro_v2`）。
- `state='deprecated'` 的 plan 不允许新发 entitlement；已发的不动。
- `policy_json` 一旦写入也不应改（任何 policy 改动要求出新版本）；store 层强制：`UPDATE plans SET policy_json` 永远报错，只能 INSERT 新行。
- `scope_allowlist_json` 控制该 plan 允许的 scope；entitlement 发放时若 credential 已有 scope 不在 allowlist 内，应拒绝发放并 audit。

### 5.2 entitlements 表

```sql
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,                     -- 'ent_<random>'
  subject_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  policy_snapshot_json TEXT NOT NULL,      -- 发放时的 plan.policy_json 快照
  scope_allowlist_json TEXT NOT NULL,      -- 发放时的 plan.scope_allowlist_json 快照
  period_kind TEXT NOT NULL CHECK (period_kind IN ('monthly','one_off','unlimited')),
  period_start TEXT NOT NULL,              -- UTC ISO
  period_end TEXT,                         -- UTC ISO；'unlimited' 时 NULL
  state TEXT NOT NULL CHECK (state IN ('scheduled','active','paused','expired','cancelled')),
  team_seat_id TEXT,                       -- P5 用，本期 NULL
  created_at TEXT NOT NULL,
  cancelled_at TEXT,                       -- state='cancelled' 时填
  cancelled_reason TEXT,                   -- 自由文本，如 "upgraded to pro"
  notes TEXT,                              -- 运维备注
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE INDEX idx_entitlements_subject_active
  ON entitlements(subject_id, state, period_end);

CREATE INDEX idx_entitlements_plan
  ON entitlements(plan_id);
```

约束：
- **唯一性**（store 层在 INSERT / UPDATE 时校验）：
  - 每个 subject 最多一个 `state IN ('active','paused')` 当前 entitlement（合称"当前档位"，paused 是暂停中的占位）。
  - 每个 subject 最多一个 `state='scheduled'` 行。
  - `state='expired'` / `'cancelled'` 不限数量（历史归档）。
- `period_kind='monthly'`：`period_start` 必须是 UTC 月初 00:00:00；`period_end` = 下一月初 00:00:00。
- `period_kind='one_off'`：`period_start` = 发放时刻或指定时刻；`period_end` 必填。
- `period_kind='unlimited'`：`period_end` = NULL；`period_start` 强制 = 现在；用于内部测试 / admin 自身。
- **state 语义**：
  - `scheduled`：`period_start > now`，未到生效时刻；不进 quota 路径。
  - `active`：`period_start <= now`，且（`period_end` 为 NULL 或 `period_end > now`）；quota 强制点。
  - `paused`：曾经 active，被运维暂停；不进 quota 路径，视同 `plan_inactive` 拒绝；但仍占用 subject 的"当前档位"。
  - `expired`：`period_end <= now`，且未被 cancel；quota 路径返回 `plan_expired`。
  - `cancelled`：运维显式取消（升降级、合规吊销）；quota 路径返回 `plan_inactive`。
- **state 转换**（store 层强制，非法转换抛错）：
  - `scheduled → active`（period_start <= now，懒触发：access 时检查 + scheduler/cron 时整理）
  - `scheduled → cancelled`（取消未生效的预约）
  - `active → paused`（运维显式 pause）
  - `active → cancelled`（升降级、合规吊销；写 `cancelled_reason`）
  - `active → expired`（`period_end <= now` 时懒触发，下次 access / trial-check 同步）
  - `paused → active`（resume）
  - `paused → cancelled`
  - 其它转换不允许。
- **懒触发顺序**（关键，避免 renew 空档误判）：
  - access 路径调 `activeEntitlementForSubject(subject_id, now)` 时，必须在**单一 SQLite 事务**内按以下顺序执行，否则 E1 自然过期 + E2 scheduled→active 的同时刻请求会拿到 plan_expired：
    1. **先 expire 到期的 active**：找 `state='active' AND period_end <= now` 行，UPDATE 到 `expired`。这一步先释放当前档位。
    2. **再 activate 到期的 scheduled**：找 `state='scheduled' AND period_start <= now` 行，UPDATE 到 `active`。第 1 步已腾空档位，唯一性约束不冲突。
    3. **最后查 active**：返回 `state='active' AND period_start <= now AND (period_end IS NULL OR period_end > now)` 行，没有则返回 null。
  - 每次状态推进都写一行 audit（`entitlement-expire` / `entitlement-activate`）。
  - `trial-check` 执行时也跑一遍这个顺序（管理员主动同步用）。
  - P7 加 cron 定期跑（不依赖 access 流量）。
- `policy_snapshot_json` 不可改；entitlement 出现 quota 调整需求 = 取消旧的 + 新发一条。

### 5.3 token_reservations 增加 entitlement_id

```sql
ALTER TABLE token_reservations ADD COLUMN entitlement_id TEXT REFERENCES entitlements(id);
```

约束：
- 当 acquire / beginSoftWrite 触发时，filling 当时的 active entitlement.id；soft_write 路径下若无 active entitlement，填 `NULL`。
- 用于 P6 月结账期对账：按 entitlement 聚合 token 用量。
- 列加完不立即强 NOT NULL（兼容期内允许 NULL 老行）。

### 5.4 entitlement_token_windows（新表，enforcement 热路径）

P2 的 `token_windows` 是 `(subject_id, window_kind, window_start)` 主键。这在 entitlement 出现后不够用：subject 在同一窗口内可能换 entitlement（cancel + grant、replace 升降级、one_off entitlement 中途启用），新 entitlement 的 acquire 不应该被旧 entitlement 的扣账污染。

P3 不改 `token_windows` 的 schema（避免重大 migration），新增一张：

```sql
CREATE TABLE entitlement_token_windows (
  entitlement_id TEXT NOT NULL,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('minute','day','month')),
  window_start TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entitlement_id, window_kind, window_start),
  FOREIGN KEY (entitlement_id) REFERENCES entitlements(id)
);

CREATE INDEX idx_entitlement_token_windows_kind
  ON entitlement_token_windows(entitlement_id, window_kind, window_start DESC);
```

**enforcement 路径分流**：

| 请求场景 | enforcement 计数表 | 写入键 |
| --- | --- | --- |
| 有 active entitlement | `entitlement_token_windows` | `(entitlement_id, kind, start)` |
| 无 entitlement（兼容模式 P2 路径） | `token_windows`（沿用 P2） | `(subject_id, kind, start)` |
| Soft-write（P2 路径，无 entitlement） | `token_windows` | `(subject_id, kind, start)` |

`token_reservations` 仍统一存所有扣账记录（带 `entitlement_id` 字段，可为 NULL）；它是账务真相。两张 windows 表只是热路径计数器：

- 有 entitlement 的 acquire 检查只看 `entitlement_token_windows[ent.id, ...]`。
- 没 entitlement 的 acquire 检查只看 `token_windows[subject, ...]`。
- 两条路径的 windows 互不污染。

**语义后果**：
- `entitlement renew --replace` / `entitlement cancel + grant`：新 entitlement 的 windows 自动从 0 开始（行不存在），而旧 entitlement 的 windows 行作为历史归档保留。
- 同月内 upgrade / downgrade：用户在新 plan 下立即获得"新窗口的全额 quota"，符合直觉。
- one_off entitlement 中途到期 → 用户回落到无 entitlement 状态（兼容模式 fallback）→ 那时 quota 检查切回 `token_windows[subject, ...]`，从该 subject 在那张表里的累计读起。

**对 `report-usage` 影响**：
- token 维度聚合源仍是 `token_reservations`（`final_*_tokens`），不动。
- 不读 windows 表做 report，避免双源问题。

**对 `getCurrentUsage`（`/gateway/credentials/current` 与 `token-windows` CLI）影响**：
- 接口签名扩展：除了 `subjectId` 还需要 `entitlementId | null`。
- 有 entitlement 时读 `entitlement_token_windows`；没 entitlement 时读 `token_windows`。
- 公开响应中标识来源（`source: "entitlement" | "subject"`）便于客户端理解。

### 5.5 token policy 字段位置

token policy 在三处出现，优先级从高到低：

1. **`credential.rate.token`**（override，仅当严于 entitlement 时生效；详见 §6）
2. **entitlement.policy_snapshot_json**（主要来源，以发放时锁定的 policy 为准）
3. **plan.policy_json**（仅作为发放 entitlement 时的输入，运行时不读）

acquire 时的 effective policy 计算：

```
effective_policy = entitlement.policy_snapshot

for field in [tokensPerMinute, tokensPerDay, tokensPerMonth,
              maxPromptTokensPerRequest, maxTotalTokensPerRequest,
              reserveTokensPerRequest]:
  if credential.rate.token has stricter value (smaller non-null):
    effective_policy[field] = credential.rate.token[field]

missingUsageCharge: 始终来自 entitlement（不允许 credential 覆盖）
```

"严于"定义：

| 字段 | 严于含义 |
| --- | --- |
| `tokensPerMinute` / `tokensPerDay` / `tokensPerMonth` | 非 null 且小于 entitlement 值；entitlement 是 null（不限）则任意非 null override 都算严 |
| `maxPromptTokensPerRequest` / `maxTotalTokensPerRequest` | 同上 |
| `reserveTokensPerRequest` | 大于 entitlement 值视为更保守（更严，因为预留更多） |
| `missingUsageCharge` | 不允许 override |

## 6. Quota 来源切换（关键 behavior change）

P2 中 `beginTokenBudget` 直接读 `credential.rate?.token`。P3 改为：

```
preHandler-level entitlement check (新增):
  ent = activeEntitlementForSubject(subject_id, now)   # 含 §5.2 懒触发
  if ent:
    if !ent.scope_allowlist.includes(credential.scope):
      return 'forbidden_scope' (403)
    # 走 entitlement 路径
  else:
    # 没 active entitlement：分类决策
    expired_or_inactive = lastNonActiveEntitlementForSubject(subject_id)
    if expired_or_inactive == 'expired':
      return 'plan_expired' (402)              # 不允许 fallback
    if expired_or_inactive == 'paused' or 'cancelled':
      return 'plan_inactive' (402)              # 不允许 fallback
    # 真正的 legacy：subject 历史上从未有过任何 entitlement
    if GATEWAY_REQUIRE_ENTITLEMENT == 0:
      继续走 P2 路径（rate.token 在 → reservation；rate.token 不在 → soft-write fail-open）
    else:
      return 'plan_inactive' (402)

handler-level acquire (调整):
  effective_policy = mergePolicy(ent.policy_snapshot, credential.rate?.token)
  acquire(effective_policy, ...)  // 同 P2
```

边界：

**关键决议——兼容 fallback 只保护 legacy**：

兼容 fallback（`GATEWAY_REQUIRE_ENTITLEMENT=0` + 走 P2 路径）只对**从未有过任何 entitlement 行的 subject** 生效。一旦 subject 历史上有过 entitlement（任意 state，含 expired/cancelled），就视为"已进入 P3"，此后无 active entitlement 一律严格拒绝（`plan_expired` / `plan_inactive`）。

理由：fallback 的意图是保护"P3 上线前发的 credential、运维还没来得及 grant entitlement"的存量用户。对"已经被 grant 过 entitlement 的 subject"，过期/暂停/取消必须有强制力，否则订阅过期后用户用 P2 老路径继续白嫖，订阅机制等于无效。

实现要点：
- store 层暴露 `subjectHasEntitlementHistory(subject_id): boolean` —— 查 `entitlements` 表是否存在任意 subject_id 行（含 expired / cancelled）。结果可缓存（subject 一旦有过就永远有过）。
- 决策路径在拿不到 active entitlement 时走这个查询。

**详细分类**：

| 场景 | 兼容模式（`=0`） | 严格模式（`=1`） |
| --- | --- | --- |
| Active entitlement 存在 | 走 entitlement 路径 | 同 |
| Active entitlement，scope 不匹配 | `forbidden_scope` 403 | 同 |
| 无 active，subject **从未有过** entitlement（legacy） + credential 有 `rate.token` | 走 P2 reservation | `plan_inactive` 402 |
| 无 active，subject **从未有过** entitlement（legacy） + credential 无 `rate.token` | 走 P2 soft-write | `plan_inactive` 402 |
| 无 active，subject 有 expired 历史 | `plan_expired` 402 | 同 |
| 无 active，subject 当前 paused | `plan_inactive` 402 | 同 |
| 无 active，subject 当前 cancelled（曾有过 active 后被 cancel） | `plan_inactive` 402 | 同 |
| 无 active，subject 仅有 scheduled（未到生效时刻） | `plan_inactive` 402 | 同 |

**关键约束**：
- 兼容模式不是"有 entitlement 就检查、没 entitlement 就放过"——而是"曾经在 P3 内的 subject 不能掉回 P2"。
- 严格模式只是把"legacy subject 不再放过"这条切到拒绝。
- `admin CLI issue` 在兼容模式下给出 warning（提醒运维 grant entitlement）但**允许签发**；严格模式下若 subject 没 active entitlement 直接拒。

新错误码（添加到 `gatewayErrorCodes`）：

| code | http | 含义 |
| --- | --- | --- |
| `plan_inactive` | 402 | subject 无 active entitlement（缺失 / paused） |
| `plan_expired` | 402 | active entitlement 已过期（period_end < now），尚未被显式更新 state |

不复用 `subscription_unavailable`：那是上游账号不可用错误，本期保留原语义不变。详见 `upstream-accounts-rename.md` §6。

## 7. Plan / Entitlement 生命周期

### 7.1 Plan

```
admin plan create --id plan_pro_v1 --policy-file pro.json [--display-name Pro] [--scope code,medical]
admin plan list [--state active|deprecated]
admin plan show <plan_id>
admin plan deprecate <plan_id>             # 不允许新发 entitlement，已有的不动
```

不提供 `plan update`：要改 policy = 新版本（如 `plan_pro_v2`）。

### 7.2 Entitlement

```
admin entitlement grant --user alice --plan plan_pro_v1 --period monthly [--start 2026-05-01]
admin entitlement grant --user trial-1 --plan plan_demo --period one_off --duration 1h
admin entitlement renew --user alice [--plan plan_pro_v2]   # 当前 plan 续下期，可换 plan
admin entitlement pause <ent_id> [--reason ...]
admin entitlement resume <ent_id>
admin entitlement cancel <ent_id> [--reason ...]
admin entitlement show --user alice
admin entitlement list [--user] [--plan] [--state] [--period-active-at <iso>]
admin entitlement bulk-grant --plan plan_demo --period one_off --duration 1h --users alice,bob,charlie
```

`grant` 行为：
- `--start` 决定 INSERT 时的初始 state：
  - `--start <= now`（或缺省）→ state='active'，period_start = now。
  - `--start > now` → state='scheduled'，period_start = 指定时刻。
- 唯一性校验：
  - 若 `--start <= now` 且 subject 已有 `state='active'` 或 `state='paused'` 行 → 默认报错。`--replace` 允许原子 cancel old + grant new active。
  - 若 `--start > now` 且 subject 已有 `state='scheduled'` 行 → 默认报错。`--replace` 允许原子 cancel old scheduled + grant new scheduled。
- monthly：`period_end` 自动 = 下一月 UTC 月初；不接受 `--duration`。
- one_off：必须给 `--duration` 或 `--end`。
- unlimited：不接受 `--start` / `--duration` / `--end`，period_start 强制 = 现在，state 必为 'active'。

`renew` 行为：
- 找到 user 的当前 active entitlement E1，**不立即 cancel**；新发一条 monthly entitlement E2 with `state='scheduled'`、`period_start = E1.period_end`、`period_end = E1.period_end + 1 month`。
- 这样 E1 在自然过期前正常工作；E1 expired 之后 E2 lazy 转 active，零空档。
- `--plan` 可换 plan（升降级）；不给则沿用 E1 的 plan。
- 若 user 已有 scheduled E2，`renew` 默认报错；`--replace` 替换。

`cancel` 行为：
- 直接把指定 entitlement 推到 `state='cancelled'`，写 `cancelled_at` / `cancelled_reason`。
- 若 cancel 的是 active 行：subject 立即失去 quota（兼容模式 fallback 到 P2，严格模式 402）。
- 若 cancel 的是 scheduled 行：用户当前 active 不受影响。

### 7.3 状态转换的 store 层校验

- INSERT entitlement state='active' 时：验 subject 当前不能已有另一条 `state IN ('active','paused')` 行（除非走 `--replace` 原子替换路径）。
- INSERT entitlement state='scheduled' 时：验 subject 当前不能已有另一条 `state='scheduled'` 行（除非走 `--replace`）。
- UPDATE state：只允许 §5.2 列出的合法转换；其它转换报错。
- 懒触发的 state 推进（scheduled→active、active→expired）也走同一 UPDATE 校验路径。
- audit 行：每个状态转换写一行 admin_audit_events，新 action：`plan-create` / `plan-deprecate` / `entitlement-grant` / `entitlement-renew` / `entitlement-cancel` / `entitlement-pause` / `entitlement-resume` / `entitlement-activate`（懒触发 scheduled→active）/ `entitlement-expire`（懒触发 active→expired）。

## 8. 公开 surface 变化

### 8.1 `/gateway/credentials/current` 增补

```jsonc
{
  "valid": true,
  "subject": { "id": "...", "label": "..." },
  "credential": {
    "prefix": "...",
    "scope": "code",
    "expires_at": "...",
    "rate": { /* 由 publicRatePolicy 过滤后的 P2 形态：rate.token 内部已 sanitize */ },
    "token": { /* 由 publicTokenPolicy 过滤后的 effective policy，与 rate.token 字段集一致 */ }
  },
  "plan": {
    "display_name": "Pro",
    "scope_allowlist": ["medical", "code"]
  },
  "entitlement": {
    "period_kind": "monthly",
    "period_start": "2026-04-01T00:00:00Z",
    "period_end": "2026-05-01T00:00:00Z",
    "state": "active"
  },
  "token_usage": { /* 沿用 P2，但有 entitlement 时来自 entitlement_token_windows，详见 §5.4 */ }
}
```

字段命名约定（沿用 rename + P2 决议）：
- 顶层 `plan` / `entitlement` 与 `credential` 同级，使用 snake_case key。
- `plan.id` / `entitlement.id` **不暴露**（内部 ID）。
- `plan.policy_json` 不暴露（公开侧用 `credential.token` 反映 effective policy 即可）。
- 老 credential（无 entitlement）：`plan` 与 `entitlement` 字段缺省整个对象（不返回 null），与 `token_usage` 缺省策略一致。

**字段过滤强制**（P2 已修过的泄露问题不能在 P3 复现）：

P2 修过的 leak 是 `credential.rate.token` 中 `reserveTokensPerRequest` / `missingUsageCharge` 通过 `credential.rate` 直接序列化外泄；P2 fix 是用 `publicRatePolicy(credential.rate)` 替换。P3 引入 entitlement 后必须**至少**保持 P2 同等过滤强度，并扩展到新增的 `effective policy`：

- `/gateway/credentials/current` / `/gateway/status` 中 `credential.rate` 必须经过 `publicRatePolicy`（沿用 P2 helper）。
- `credential.token` 必须经过 `publicTokenPolicy`（沿用 P2 helper）；P3 把 `credential.token` 的语义从"credential 单独的 token policy"改成"effective merged policy"，但字段集和过滤规则一致。
- `entitlement.policy_snapshot_json` 内容**不**直接暴露；要给客户端看 quota 上限就走 `credential.token`（已过滤）。
- 不允许任何路径暴露 `reserveTokensPerRequest` / `missingUsageCharge`：
  - `credential.rate.token` 内部不得出现。
  - `credential.token` 顶层不得出现。
  - `entitlement` 对象内不得出现（snapshot 不出）。
  - `plan` 对象内不得出现（policy_json 不出）。
- 验收强约束：`JSON.stringify(response)` 不应包含字符串 `"reserveTokensPerRequest"` 或 `"missingUsageCharge"`，无论 response 来自 `/gateway/credentials/current`、`/gateway/status` 还是 admin CLI 的公开命令（admin CLI 内部命令如 `plan show` 可见，但仅限 stdout JSON 给运维，不算公开 surface）。

### 8.2 `/gateway/status` 不变

`/gateway/status` 反映的是 service / upstream account 状态，不是 user 订阅状态。本期不在该接口加 plan 字段。

### 8.3 `/v1/*` OpenAI 兼容路由

- 不暴露 plan / entitlement 字段。
- token quota 错误返回沿用 `rate_limited`。
- 新增的 `plan_inactive` / `plan_expired` 通过 OpenAI 错误响应输出，`error.type` 沿用现有映射；`error.code` 直接是新值（`plan_inactive` / `plan_expired`），不向客户端隐藏（客户端需要区分"超额"vs"无订阅"）。

## 8a. 客户端变更合同（集中说明）

P3 落地后，下游客户端（含 MedCode 集成方）需要知道的全部公开变化：

### 8a.1 不变的部分

- `/v1/*`（OpenAI 兼容）请求/响应主体形态完全不变。
- `/v1/chat/completions` 流式 / 非流式 / strict tools 路径不变。
- `/sessions/:id/messages` 请求格式不变。
- 已有错误码（`rate_limited` / `invalid_credential` / `forbidden_scope` / `subscription_unavailable` 等）语义不变。
- `Authorization: Bearer <token>` 鉴权流程不变。

### 8a.2 新增字段（可选读，向后兼容）

`/gateway/credentials/current` 响应在该 subject 拥有 active entitlement 时**新增两段顶层对象**（详见 §8.1）：

```json
{
  "plan": { "display_name": "Pro", "scope_allowlist": ["medical","code"] },
  "entitlement": { "period_kind": "monthly", "period_start": "...", "period_end": "...", "state": "active" }
}
```

老 credential（兼容模式 + legacy subject）这两段缺省，整个对象不出现（不返回 null）。客户端：
- 严格 schema 校验的客户端必须放宽，允许这两个字段出现/缺失。
- 不需要这两段的客户端可以忽略。
- 不要假设字段一定存在或一定缺失——它们的存在与运维 grant 时机相关。

`token_usage`（P2 已有）行为不变；`/gateway/credentials/current` 响应 token_usage 字段是否存在的语义沿用 P2，不区分来源是 entitlement 还是 subject windows——客户端无需感知。

### 8a.3 新增错误码

| code | http | 客户端处理建议 |
| --- | --- | --- |
| `plan_inactive` | 402 | 提示用户订阅不可用（缺失 / 暂停 / 取消），引导联系运维 |
| `plan_expired` | 402 | 提示用户订阅已过期，引导续期 |

客户端如果对未知 402 错误码 fallback 到通用错误页，行为可接受；建议逐步适配显式提示。OpenAI 兼容路由透传 `error.code` 字段，python `openai` / ts `openai` SDK 按 `status_code` 抛 `BadRequestError` 或 `APIStatusError`，不会因为新 code 崩溃。

### 8a.4 兼容期切换日期

部署节奏（具体日期由运维落 changelog）：

| 阶段 | 描述 | 对客户端 |
| --- | --- | --- |
| **R1** | P3 上线，`GATEWAY_REQUIRE_ENTITLEMENT=0`（默认） | 完全无感；老 credential 行为不变；新 credential 在 grant entitlement 后开始返回新字段 |
| **R2** | 运维 bulk-grant 全量 active subject | 被 grant 的客户端开始看到 plan / entitlement 字段，可能出现 quota 收紧（如 entitlement 严于 credential override） |
| **R3** | 切 `GATEWAY_REQUIRE_ENTITLEMENT=1` | legacy 模式关闭；任何无 entitlement 的 subject 收到 `plan_inactive` 402 |

切换日期会在 R3 前 14 天写入 `docs/consumer-technical-guide.md` 字段切换时间表通告下游。

### 8a.5 本期不包含

- 自助购买 / 升级 / 续期界面或 API。
- 按量付费（usage-based billing）。
- 公开的 plan 列表 API（plan 创建仅运维 CLI 可见）。
- 客户端余额查询（`token_usage` 已能反映剩余 quota，无单独 endpoint）。
- 跨 subject 共享配额（团队池留 P5）。

P3 不暴露任何"购买"路径——所有 entitlement 由运维通过 admin CLI grant，客户端只能查询自己当前状态，不能修改。

## 9. Admin CLI 全量

### 9.1 新命令组：`plan`

```
admin plan create --id <plan_id> --policy-file <path> [--display-name <name>] [--scope <list>] [--priority-class <n>] [--team-pool-id <id>]
admin plan list [--state active|deprecated]
admin plan show <plan_id>
admin plan deprecate <plan_id>
```

policy-file 格式（JSON）：

```json
{
  "tokensPerMinute": 100000,
  "tokensPerDay": 5000000,
  "tokensPerMonth": 100000000,
  "maxPromptTokensPerRequest": 200000,
  "maxTotalTokensPerRequest": 300000,
  "reserveTokensPerRequest": 50000,
  "missingUsageCharge": "reserve"
}
```

CLI 加载并 `validateTokenPolicy`（详见 §9.5 前置 refactor）；不合法直接拒绝。

### 9.2 新命令组：`entitlement`

见 §7.2。

### 9.3 已有命令的修改

- `issue` / `update-key`：保留 `--tokens-per-*`、`--missing-usage-charge` 等 flag（作为 override）。新增 `--no-entitlement-check` flag 用于兼容期签发无 entitlement 的 credential（带 deprecation 警告）。
- `trial-check`：新增三项检查
  - "active credential without active entitlement"（warning）
  - "active entitlement period_end < now + 7 days"（warning，运营提醒续期）
  - "plan with state='active' but no entitlements granted in 90 days"（info）
- `report-usage`：sub-aggregate 维度新增可选 `--group-by entitlement`，按账期出账。
- `audit`：自然支持新 action 过滤。

### 9.4 core 类型联动

`packages/core/src/types.ts`:

```ts
export type AdminAuditAction =
  | "issue"
  | "update-key"
  | ...
  | "token-overrun"
  | "token-reservation-expired"
  | "plan-create"             // 新增
  | "plan-deprecate"          // 新增
  | "entitlement-grant"       // 新增
  | "entitlement-renew"       // 新增
  | "entitlement-cancel"      // 新增
  | "entitlement-pause"       // 新增
  | "entitlement-resume"      // 新增
  | "entitlement-activate"    // 新增（懒触发 scheduled→active）
  | "entitlement-expire";     // 新增（懒触发 active→expired）

export const gatewayErrorCodes = [
  ...,
  "plan_inactive",            // 新增
  "plan_expired",             // 新增
] as const;
```

新文件 `packages/core/src/plan-entitlement.ts`：导出 `Plan`、`Entitlement`、`PlanState`、`EntitlementState`、`PeriodKind` 类型 + `PlanEntitlementStore` 接口（CRUD + 状态转换）。

新文件 `packages/store-sqlite/src/plan-entitlement.ts`：SqliteBacked 实现，与 `SqliteTokenBudgetLimiter` 共享同一 `DatabaseSync`。

### 9.5 前置 refactor：把 token policy 校验提到 core

P3 让 token policy 在三个地方需要同一套校验：
- `packages/store-sqlite/src/token-budget.ts` 里的 `acquire` / `getCurrentUsage`（已存在）。
- `packages/core` 里的 entitlement.policy_snapshot 与 plan.policy_json 校验（新增）。
- `apps/admin-cli` 里 `plan create --policy-file` 加载后的校验（新增）。

避免 admin CLI 反向依赖 store 内部、避免三处复制校验逻辑：

| 步骤 | 内容 | 边界 |
| --- | --- | --- |
| **9.5.1**（前置） | 把 `validateTokenPolicy` 与 `TokenLimitPolicy` 类型本身一起留在 `packages/core/src/token-budget.ts`（类型已在 core 里 export，校验函数当前在 store-sqlite 里）。把 store-sqlite 现在的 `validateTokenPolicy` 函数原样搬过去；store-sqlite 改为 `import` 并复用。 | 单独 PR，零行为变化 |
| **9.5.2** | core 新增 `validatePlanPolicy(json: unknown): TokenLimitPolicy`，封装 `validateTokenPolicy` + 任何 plan-specific 字段（如 `priority_class` 范围、`scope_allowlist` 非空）。 | P3 主 PR 内 |
| **9.5.3** | admin CLI `plan create` 通过 `validatePlanPolicy` 验证 policy-file 内容；不直接 import store-sqlite 的内部函数。 | P3 主 PR 内 |

这一步在 P3 主体开始前先落地（独立 PR），把 P2 已经存在的 `validateTokenPolicy` 提到 core，不动语义。这个 refactor 也让 P3 主 PR 体积小一些。

## 10. 与现有系统的集成

### 10.1 与 P2 token budget 的关系

- `TokenBudgetLimiter` 接口扩展（不破坏既有接口）：
  - `AcquireInput` / `SoftWriteBeginInput` 增加 `entitlementId: string | null`。
  - 实现内部按 `entitlementId` 是否非 null 选择 windows 表：`entitlement_token_windows`（非 null）或 `token_windows`（null，兼容路径）。
  - `getCurrentUsage` 输入增加 `entitlementId: string | null`，相应选表。
  - 现有签名（不带 `entitlementId`）必须仍能编译/运行——P2 在线代码先升级到带显式 null 的新签名再切；本期不留兼容默认值，由调用方显式传 null。
- 调用方（`beginTokenBudget` in `apps/gateway/src/services/token-budget-hook.ts`）改为先取 active entitlement、merge override，再传 effective policy 给 limiter。
- `token_reservations.entitlement_id` 列由 limiter 填入；带 entitlement 路径必填，soft-write 兼容路径填 NULL。
- soft-write 路径（无 entitlement）在 P3 行为不变：仍走 `token_windows` 计数 + `kind='soft_write'` reservation。
- 已发出但未 finalize 的 P2 reservation（升 P3 时正在飞行）：`entitlement_id` 为 NULL；finalize 仍写 `token_windows`（按 reservation 行的 windows snapshot）。这与升级前行为一致。

### 10.2 与 rename 的关系

- 本期 entitlement 概念用 `subscription` 这个词向用户呈现（display_name 可以叫 "Subscription"），但 schema/代码里全用 `plan` / `entitlement`。
- rename 完成的兼容字段 `subscription` 在 `/gateway/status` 仍然指上游账号，不混。
- 公开错误码 `subscription_unavailable` 仍指上游账号问题；plan_inactive 是新 code，专指用户订阅状态。

### 10.3 与 identity guard 的关系

- guard 在 handler 内执行，位置：parse → entitlement check → identity guard → tokenBudget.acquire → provider。
- entitlement check 行为按 §6 决议：
  - 拿到 active entitlement / 走 entitlement 路径 → 继续 guard。
  - 进入兼容 fallback（legacy subject + 兼容模式）→ 继续 guard，guard hit 走 P2 行为（identity_guard_hit=1，不消耗 token）。
  - 拒绝（plan_inactive / plan_expired / forbidden_scope）→ 直接返回错误，**不进 guard**。
- 关键：guard 是"在 entitlement 决议放行后再执行"，而不是"绕过 entitlement 检查"。兼容模式下 legacy subject 也是被 entitlement check **放行**（不是绕过）才进 guard，行为与 P2 完全一致。
- guard hit 不走 token acquire / 不消耗 token，沿用 P2 设计；兼容路径与 entitlement 路径在 guard 这层无差异。

### 10.4 与 P4 账号池的关系

- `plan.priority_class` 字段本期落库但**不读**。
- P4 调度器接入时按 priority + plan + scope 选 upstream account。
- `plan.team_pool_id` 同上，P5 接入。

## 11. 部署与迁移

### 11.1 SQLite migration

新增一条 migration（编号紧随 P2 之后），单事务内：

```sql
CREATE TABLE plans (
  -- 见 §5.1
);
CREATE INDEX idx_plans_state ON plans(state);

CREATE TABLE entitlements (
  -- 见 §5.2
);
CREATE INDEX idx_entitlements_subject_active ON entitlements(subject_id, state, period_end);
CREATE INDEX idx_entitlements_plan ON entitlements(plan_id);

CREATE TABLE entitlement_token_windows (
  -- 见 §5.4
);
CREATE INDEX idx_entitlement_token_windows_kind
  ON entitlement_token_windows(entitlement_id, window_kind, window_start DESC);

ALTER TABLE token_reservations ADD COLUMN entitlement_id TEXT REFERENCES entitlements(id);
```

要点：
- `entitlement_token_windows` 必须在本 migration 内一并建，否则 acquire 路径在 entitlement 落地后立刻 panic。
- `token_reservations.entitlement_id` 列允许 NULL（兼容期老行 + soft-write 路径）。
- 索引与 §5.x 各表定义同步落地，不留二次 migration。

### 11.2 兼容窗口

- 第一个 release：`GATEWAY_REQUIRE_ENTITLEMENT=0`（默认）。无 active entitlement 的 credential 行为按 §6 边界表分流：
  - subject 从未有过任何 entitlement（legacy）：有 `rate.token` 走 P2 reservation；无 `rate.token` 走 P2 soft-write；**默认不 402**。
  - subject 曾有 entitlement 但当前过期/暂停/取消：直接 `plan_expired` / `plan_inactive` 402，不 fallback。
  - trial-check 给出 warning，提醒运维补 entitlement。
- 第二个 release：`GATEWAY_REQUIRE_ENTITLEMENT=1` 默认；无 entitlement 的 credential 拒绝。
- 兼容期长度建议绑定一个具体日期（trial 启动 + 14 天），写入 consumer-technical-guide 的字段切换时间表。

### 11.3 老 credential 迁移

不自动创建 entitlement。运维流程：

1. `admin plan create` 定义至少一个 active plan（如 `plan_trial_v1`）。
2. `admin entitlement bulk-grant --plan plan_trial_v1 --period monthly --users <list>` 给现有 active credential 的 subject 批量发 entitlement。
3. 验证：`trial-check` 不再有 "active credential without active entitlement" warning。
4. 切 `GATEWAY_REQUIRE_ENTITLEMENT=1`。

### 11.4 retention

- entitlement 表：finalized（state='expired' / 'cancelled'）行保留至 P6 billing 完成对账后再清。本期不加 prune 命令。
- plans 表：deprecated plan 行不删（历史 entitlement 还引用）。

## 12. 测试规范

### 12.1 store 单元测试

- INSERT plan 后 `UPDATE plans SET policy_json` 应抛错（plan 不可改）。
- INSERT entitlement 时若 subject 已有 active 且 period 重叠应抛错。
- INSERT entitlement state='scheduled' 时若 subject 已有另一条 scheduled 应抛错；带 `--replace` 时原子替换。
- 状态转换：scheduled→active→paused→active→cancelled OK；cancelled→active 抛错；active→scheduled 抛错。
- 懒激活：插入 `state='scheduled'` + `period_start = now-1s`，调 `activeEntitlementForSubject(now)` 应触发 scheduled→active 转换并返回这条 entitlement。
- 懒过期：active + `period_end < now`，调 `activeEntitlementForSubject(now)` 应触发 active→expired 并返回 null。
- monthly entitlement period_start 必须是 UTC 月初（其它值抛错）。
- one_off 必须有 period_end（缺则抛错）。
- 请求时 active entitlement 查询：包含 period_start <= now < period_end 的过滤；预约的 future entitlement 不会被选中（state='scheduled'）。
- `entitlement-grant --replace` 在同一事务内 cancel old + insert new。
- token policy validator 校验：`plan create --policy-file` 加载非法 policy（如 `missingUsageCharge='bad'`、负数上限）应在 CLI 拒绝；validator 来自 core 而非 store-sqlite。

### 12.2 token budget 集成

- 有 active entitlement 的 subject：acquire 用 entitlement.policy_snapshot；credential 无 override 时与 entitlement policy 完全一致；windows 写入 `entitlement_token_windows[ent.id, ...]`。
- credential override 严于 entitlement：用 override 值。
- credential override 宽于 entitlement：用 entitlement 值（override 被忽略）。
- credential 试图 override `missingUsageCharge`：被忽略（用 entitlement 值）。
- 同 subject 多 credential 共享同一 entitlement：写同一张 `entitlement_token_windows` 行；acquire 看到的 used 一致。
- token_reservations.entitlement_id 在 acquire 时正确填入；soft-write 时 entitlement 缺失则 NULL。
- **跨 entitlement 边界 quota 重置**：subject 在 plan_basic（tokensPerDay=100k）下用掉 80k → 同一天内 `entitlement renew --replace --plan plan_pro`（tokensPerDay=500k）→ 同一 minute/day 窗口内的下一个请求看到 used=0、reserved 仅含本次（新 entitlement 的 windows 行不存在）。旧 entitlement 的 windows 行作为历史保留。
- **one_off entitlement 中途过期**：用户在 one_off entitlement（剩余 30 分钟）下用掉 50k → entitlement period_end 到达 → 兼容模式下回落到 `token_windows[subject, ...]`，从 P2 路径继续；严格模式下后续请求 `plan_expired`。
- **混合路径累计正确**：subject 先在无 entitlement 下用 P2 路径累计 30k 到 `token_windows`；运维 grant entitlement → 后续请求走 `entitlement_token_windows`，不与 P2 累计互相污染。
- **report-usage 不读 windows 表**：token 维度聚合只来自 `token_reservations`，验证两路径下都能正确出账。

### 12.3 路由集成测试

- 兼容模式（`GATEWAY_REQUIRE_ENTITLEMENT=0`）+ 无 entitlement + 有 `rate.token` 的 credential：走 P2 reservation 路径；不返回 plan / entitlement 字段。
- 兼容模式 + 无 entitlement + **无 `rate.token`** 的老 credential（P2 落地前发的）：**不**返回 402，走 P2 soft-write 路径；不返回 plan / entitlement 字段。这是默认模式"零行为变化"的核心保护点。
- 严格模式（`GATEWAY_REQUIRE_ENTITLEMENT=1`）+ 无 entitlement：返回 `plan_inactive` 402，无论有无 `rate.token`。
- entitlement state='paused'：返回 `plan_inactive` 402。
- entitlement state='scheduled'（period_start > now）：视同无 active entitlement，走兼容 / 严格分支。
- entitlement period_end < now：返回 `plan_expired` 402，且后续读该 entitlement 显示 state='expired'（store 层同步推 state）。
- credential.scope 不在 entitlement.scope_allowlist：返回 `forbidden_scope` 403。
- `/gateway/credentials/current` 在有 entitlement 时含 plan + entitlement 字段；无 entitlement 时整个对象缺省。
- `/gateway/credentials/current` 不暴露 plan.id / entitlement.id。
- **公开字段不泄露内部 token policy 字段**：对四种 credential 形态（无 policy / 有 rate.token / 有 entitlement 无 override / 有 entitlement 有 override）调 `/gateway/credentials/current` 与 `/gateway/status`，断言 `JSON.stringify(response)` 不含 `"reserveTokensPerRequest"` / `"missingUsageCharge"`。

### 12.4 CLI 集成测试

- `plan create` 后 `plan show` 能读出 policy_json 的全部字段。
- `plan deprecate` 后再 `entitlement grant --plan <deprecated>` 抛错。
- `entitlement grant` 在 subject 已有 active 时报错；带 `--replace` 时原子替换。
- `entitlement renew` 接续到当前 entitlement.period_end，不空档。
- `entitlement bulk-grant` 在 N 个 subject 上原子 / 逐个 grant；中间失败时已 grant 的不回滚（best-effort），输出失败列表。
- `trial-check` 在 active credential 无 entitlement 时给 warning 而不 block；切到严格模式后该 warning 升级为 error（trial-check 同时检查 `GATEWAY_REQUIRE_ENTITLEMENT` 环境）。
- audit 行能用 `audit --action entitlement-grant` 等过滤。

## 13. 验收标准

- [ ] core 新增 `Plan` / `Entitlement` / `EntitlementState` 含 `'scheduled'` / 相关枚举类型；`gatewayErrorCodes` 含 `plan_inactive` / `plan_expired`；`AdminAuditAction` 含 9 个新 action（含 `entitlement-activate` / `entitlement-expire` 两个懒触发 action）。
- [ ] **前置 refactor 完成**：`validateTokenPolicy` 从 store-sqlite 提到 `packages/core`；store-sqlite 通过 import 复用；admin CLI `plan create` 通过 core 暴露的校验函数验证 policy-file，不依赖 store 内部。
- [ ] SQLite migration 幂等执行；新 schema 通过 `SELECT * FROM plans` / `SELECT * FROM entitlements` / `SELECT * FROM entitlement_token_windows` 验证。
- [ ] `token_reservations.entitlement_id` 列存在；老行 NULL 兼容。
- [ ] effective policy merge 测试通过（§12.2 全部）。
- [ ] **跨 entitlement 边界 quota 重置**测试通过：renew/replace 后新 entitlement 的 windows 从 0 开始（行不存在）；旧 entitlement 行作为历史保留。
- [ ] **enforcement 路径分流**测试通过：有 entitlement 的请求只读写 `entitlement_token_windows`；无 entitlement 的请求只读写 `token_windows`；两表互不污染。
- [ ] **scheduled 状态机**测试通过：grant `--start <future>` 创建 scheduled；懒激活把它推到 active；scheduled→cancelled 合法；scheduled→active 唯一性校验。
- [ ] `GATEWAY_REQUIRE_ENTITLEMENT` 在 0/1 两档下行为正确；切换通过环境变量不需要重建数据。
- [ ] **兼容模式默认零行为变化**测试通过：无 entitlement + 无 rate.token 的老 credential 在 `GATEWAY_REQUIRE_ENTITLEMENT=0` 下走 P2 soft-write，不返回 402、不返回 plan/entitlement 字段。
- [ ] `/gateway/credentials/current` 字段命名遵守 §8.1；老 credential 无 entitlement 时不返回 plan / entitlement 字段；不泄露内部 ID。
- [ ] **公开 surface 字段过滤强制**：`/gateway/credentials/current` 与 `/gateway/status` 在四种 credential 形态下均不在响应任意层级出现 `reserveTokensPerRequest` / `missingUsageCharge`（字符串扫描断言）。
- [ ] OpenAI 兼容路由对 `plan_inactive` / `plan_expired` 错误返回结构化错误，含 `error.code` 与 message。
- [ ] Admin CLI 新命令完整；stdout 仅 JSON；spy `process.stdout.write` 在 store 公共方法 0 调用（沿用 rename 纪律）。
- [ ] `trial-check` 三项新检查全部输出预期 warning。
- [ ] `report-usage --group-by entitlement` 按 entitlement 聚合 token；账期边界正确；token 维度聚合源是 `token_reservations`、不依赖 windows 表。
- [ ] 现有 P2 / rename / credential auth / strict tools / public smoke 测试不回归。
- [ ] consumer-technical-guide 增补 plan / entitlement 字段说明、`plan_inactive` / `plan_expired` 错误处理建议、兼容期切换日期。

## 14. 风险与待定

### 风险

- **风险 1**：plan_snapshot 锁定后运维想"全员涨配额"会很麻烦——必须 `entitlement renew --plan <new>` 给每个用户。
  - 缓解：`bulk-grant --replace` 支持批量。trial 阶段用户少（< 10），手动可接受。后续若需要可加 `entitlement migrate-all --from plan_v1 --to plan_v2`。
- **风险 2**：entitlement 状态推到 'expired' 的责任：access 路径检查 OR cron job？
  - 缓解：本期采用"惰性推 expired"——下次访问时若 period_end < now 且 state='active'，store 层把它推到 'expired' 后再决定 plan_expired。`trial-check` 也顺手清。P7 加 cron。
- **风险 3**：未来 plan 改动如何兼容已发出的 entitlement。
  - 缓解：snapshot 锁定保证已发的不受影响；新发的需要新 plan 版本；运维需要主动 renew 才生效。已是设计的一部分。
- **风险 4**：override 机制可能让运维误判（"我把 key 的 token 配高了为啥还限"）。
  - 缓解：`/gateway/credentials/current` 暴露 effective policy（filtered），不暴露 entitlement.policy_snapshot 与 credential.rate.token 的差，但 admin CLI `update-key` / `entitlement show` 输出 effective + 各来源原始值；audit `update-key` 中 params 含 entitlement_id。

### 待定

- **carryover**：第一版禁用未用 token 滚入下期。是否在 P3.5 做？
- **plan upgrade/downgrade 中途结算**：当前是 cancel + new，old 的剩余 token 直接归零；新的从 0 开始。是否要在 cancel 时把已用 token 拷贝到新 entitlement 的 carryover？
- **entitlement 数量上限**：理论上一个 subject 可以有多条 'expired' / 'cancelled' 历史 entitlement。要不要加分页 / prune？暂不做，trial 阶段量小。
- **Plan policy 字段是否要扩展超出 TokenLimitPolicy**：例如限定可用 model、是否允许工具调用 scope 等。本期 policy 仅含 token 字段；其它能力维度由 scope_allowlist 间接控制。
- **公开 surface 是否要暴露 entitlement 剩余天数**：如 `entitlement.days_remaining`。客户端 UI 如果要显示倒计时，可以基于 `period_end` 自己算。本期不主动出。
- **Admin CLI `--missing-usage-charge` 是否应该禁用 override**：现有 `update-key` 接受这个 flag。entitlement 上线后该 flag 形同虚设（merge 时被 ignore）。是否在 CLI 直接拒绝？倾向保留兼容、加 deprecation 警告。

---

附：本期完成后，"用户的订阅档位"在仓库内成为一等公民。后续：
- P4 调度器读 `plan.priority_class` 选上游账号。
- P5 team accounts 读 `plan.team_pool_id` + `entitlement.team_seat_id`。
- P6 billing 按 `token_reservations.entitlement_id` 聚合月结。
- P7 自动化 entitlement 续期、过期推送、报表。

`subscription` 这个词到此承担它在 `upstream-accounts-rename.md` §1 中保留的位置：plan / entitlement 是它的具象形态。
