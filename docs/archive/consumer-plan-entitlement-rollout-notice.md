# MedCode Gateway 客户端说明：Plan / Entitlement 兼容上线

发布日期：2026-04-30

本文面向接入 MedCode Gateway 的客户端和后端消费方团队，说明 P3 Plan / Entitlement 第一阶段上线后，客户端需要知道的行为变化、字段变化和后续适配要求。

## 结论

本轮上线是兼容发布，目标是先建立用户权益与 token 用量记录能力。

第一阶段不会对现有用户收费，也不会要求现有用户更换 API key。

现有业务调用整体保持兼容：

- 现有 API key 继续可用。
- `/v1/*` OpenAI-compatible API 的请求体、响应体和鉴权方式不变。
- 从未进入 entitlement 体系的 legacy 用户，不会因为缺少 plan / entitlement 在第一阶段被拦截。
- 已经进入 entitlement 体系但权益状态不是 active 的用户，会按真实状态返回 `plan_expired` 或 `plan_inactive`。
- 当前阶段不会产生收费或扣款；已配置的请求限流和 token quota 仍会生效，token 用量会用于后续报表、对账和计费系统准备。
- 当前阶段不包含支付、扣费、账单、发票、自助购买或客户端续费。

## 上线模式

第一阶段服务端会保持：

```text
GATEWAY_REQUIRE_ENTITLEMENT=0
```

这表示从未进入 entitlement 体系的老 API key 继续走兼容路径：

- 如果老 key 已有 token policy，继续按现有 token budget 逻辑记录和限流。
- 如果老 key 没有 token policy，继续走 soft-write 记录路径，不因为缺少 entitlement 返回 402。

如果某个用户历史上已经拥有过 entitlement，但当前没有 active entitlement，则不再按 legacy 路径放行：

- 已过期会返回 `plan_expired`。
- 已暂停、已取消或尚未生效会返回 `plan_inactive`。

严格 entitlement 校验不是本轮默认行为。切换到严格模式前，会另行通知客户端团队明确日期和适配要求。

## 不变的接口

以下接口对业务调用方保持兼容：

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/chat/completions`

客户端继续使用：

```http
Authorization: Bearer <API_KEY>
```

OpenAI-compatible 请求和响应结构不新增 plan / entitlement 字段。

## 新增账户字段

`GET /gateway/credentials/current` 后续可能返回 plan / entitlement 信息，用于账户页或额度页展示。

示例：

```json
{
  "valid": true,
  "credential": {
    "prefix": "abc123def4",
    "scope": "code",
    "expires_at": "2026-05-31T00:00:00Z",
    "token": {
      "tokensPerMinute": 100000,
      "tokensPerDay": 5000000,
      "tokensPerMonth": 100000000,
      "maxPromptTokensPerRequest": 200000,
      "maxTotalTokensPerRequest": 300000
    }
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
  "token_usage": {
    "source": "entitlement",
    "minute": {
      "limit": 100000,
      "used": 1200,
      "reserved": 0,
      "remaining": 98800,
      "window_start": "2026-04-30T05:42:00.000Z"
    },
    "day": {
      "limit": 5000000,
      "used": 250000,
      "reserved": 0,
      "remaining": 4750000,
      "window_start": "2026-04-30T00:00:00.000Z"
    },
    "month": {
      "limit": 100000000,
      "used": 1200000,
      "reserved": 0,
      "remaining": 98800000,
      "window_start": "2026-04-01T00:00:00.000Z"
    }
  }
}
```

字段说明：

| 字段 | 含义 | 客户端处理 |
| --- | --- | --- |
| `plan.display_name` | 用户当前套餐展示名 | 可展示在账户页 |
| `plan.scope_allowlist` | 当前套餐允许的 scope | 可用于展示能力范围 |
| `entitlement.period_kind` | 权益周期类型，可能是 `monthly` / `one_off` / `unlimited` | 可用于 UI 展示 |
| `entitlement.period_start` | 当前权益开始时间 | 可展示 |
| `entitlement.period_end` | 当前权益结束时间，`unlimited` 时可能为空 | 可展示或用于计算剩余时间 |
| `entitlement.state` | 当前权益状态 | 可用于状态提示 |
| `credential.token` | 过滤后的有效 token quota | 用于额度展示 |
| `token_usage` | 当前 token 使用情况 | 用于额度展示 |
| `token_usage.source` | 用量来源，可能是 `entitlement` 或 `subject` | 可用于区分新权益路径和兼容路径 |

`plan` 和 `entitlement` 是可选字段。第一阶段兼容模式下，没有这两个字段通常表示用户仍在兼容路径；客户端不应把它展示为订阅异常。

如果用户已经进入 P3 entitlement 体系，但权益状态不是 active，`/gateway/credentials/current` 仍会返回 `plan` 和 `entitlement`，并通过 `entitlement.state` 表示真实状态：

- `expired`：权益已过期，业务请求会返回 `plan_expired`。
- `paused`：权益被暂停，业务请求会返回 `plan_inactive`。
- `cancelled`：权益被取消，业务请求会返回 `plan_inactive`。
- `scheduled`：权益尚未生效，业务请求会返回 `plan_inactive`。

这些状态下，客户端不应把用户判定为 legacy / compat。`credential.token` 和 `token_usage` 只代表当前可用的有效额度；当 entitlement 非 active 时可能缺省。

## 不应依赖的字段

客户端不要读取或依赖以下内部字段：

- `plan.id`
- `entitlement.id`
- `plan.policy_json`
- `entitlement.policy_snapshot_json`
- `reserveTokensPerRequest`
- `missingUsageCharge`

客户端展示额度时，应使用 `credential.token` 和 `token_usage`。

`credential.rate.token` 不应作为客户端额度展示的主要来源。服务端会继续过滤公开响应，内部运维字段不会对客户端公开。

## 新增错误码

兼容期内，从未进入 entitlement 体系的 legacy API key 正常情况下不会因为缺少 entitlement 被拦截。但客户端应提前支持以下错误码；已经进入 entitlement 体系的用户如果权益不可用，也会在兼容期内收到这些错误。

| HTTP | `error.code` | 含义 | 建议客户端提示 |
| --- | --- | --- | --- |
| 429 | `rate_limited` | 请求限流、并发限流、单次请求 token 上限或 token quota 超限 | 先按 `retry_after_seconds` 控制重试；如需显示额度用尽，按下节读取 `/gateway/credentials/current` |
| 402 | `plan_inactive` | 用户没有可用权益，或权益被暂停 | 提示用户联系管理员或检查订阅状态 |
| 402 | `plan_expired` | 用户权益已过期 | 提示用户续期或联系管理员 |
| 403 | `forbidden_scope` | 当前 API key 的 scope 不在权益允许范围内 | 提示当前 key 无权访问该能力 |

OpenAI-compatible 路由会通过标准错误结构返回这些错误。客户端应读取 `error.code`，不要只按 HTTP status 判断原因。

示例：

```json
{
  "error": {
    "message": "Plan is inactive.",
    "type": "invalid_request_error",
    "code": "plan_inactive"
  }
}
```

## 额度用尽提示判断

`rate_limited` 不只代表日额度或月额度耗尽，也可能是请求过快、并发超限、单次请求太大，或服务端为本次请求预留的 token 超过当前窗口。因此客户端不要只看到 `429 rate_limited` 就显示“额度用尽”。

推荐流程：

1. 调用 `/v1/chat/completions` 收到 HTTP `429` 且 `error.code === "rate_limited"`。
2. 使用同一个 API key 调用 `GET /gateway/credentials/current`。
3. 读取 `token_usage.minute.remaining`、`token_usage.day.remaining`、`token_usage.month.remaining`。
4. 如果某个窗口 `remaining === 0`，再展示对应的额度提示：
   - `minute.remaining === 0`：请求过快，请稍后重试。
   - `day.remaining === 0`：今日额度已用尽。
   - `month.remaining === 0`：本月额度已用尽。
5. 如果三个窗口都大于 0，或某个窗口为 `null`，不要展示“日/月额度用尽”；应显示请求过快、请求过大或稍后重试，并优先使用错误响应里的 `message` 和 `retry_after_seconds`。

`GET /gateway/credentials/current` 不消耗普通请求限流和 token quota，适合在错误处理、账户页和额度页调用。客户端不需要在每次模型请求前预查额度。

## `/gateway/status` 注意事项

`/gateway/status` 反映的是服务状态和上游账号状态，不是用户订阅状态。

如果响应中仍有 `subscription` 字段，它沿用前一阶段兼容语义，表示上游账号，不表示用户 plan / entitlement。

客户端不要用 `/gateway/status.subscription` 判断用户是否已订阅。

用户订阅状态只应从 `/gateway/credentials/current` 的 `plan` 和 `entitlement` 字段读取。

## 客户端建议改动

第一阶段没有强制改动，但建议客户端团队提前完成以下适配：

1. 账户页支持展示 `plan.display_name`、`entitlement.period_start`、`entitlement.period_end` 和 `entitlement.state`。
2. 额度展示改为读取 `credential.token` 和 `token_usage`。
3. 缺少 `plan` / `entitlement` 时，显示为兼容账户或隐藏订阅模块，不显示错误。
4. 新增 `plan_inactive`、`plan_expired`、`forbidden_scope` 的错误处理。
5. 对 `429 rate_limited` 增加一次 `/gateway/credentials/current` 查询，用 `token_usage.*.remaining` 区分请求过快、今日额度用尽和本月额度用尽。
6. 不要把 `/gateway/status.subscription` 当作用户订阅状态。
7. 不要依赖内部 token policy 字段。

## 后续严格模式

后续阶段服务端可能切换到：

```text
GATEWAY_REQUIRE_ENTITLEMENT=1
```

切换后，没有 active entitlement 的 API key 会返回 `plan_inactive`，不再走兼容路径。

严格模式切换前会另行通知，通知内容会包括：

- 计划切换日期
- 客户端必须完成的错误码适配
- 账户页字段展示要求
- 仍处于 legacy / compat 状态的用户处理方式

## 本阶段不包含的能力

P3 第一阶段不是完整商业化计费系统，不包含：

- 用户自助购买
- 支付 checkout
- 按量付费扣款
- 发票
- 账单
- 欠费处理
- 自动续费
- 退款

本阶段只建立 plan / entitlement 数据结构、token 用量记录和后续计费所需的基础账务数据。
