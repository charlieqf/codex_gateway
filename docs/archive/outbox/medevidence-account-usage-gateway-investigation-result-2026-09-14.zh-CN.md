# 用户48877 用量与额度异常：Gateway 只读调查回复

对应客户端[协查说明](../../../../medevidence-opencode-stable/docs/outbox/medevidence-account-usage-gateway-investigation-2026-09-14.zh-CN.md)。主要数据快照：2026-09-14 04:28:07.670 UTC（北京时间 12:28:07.670）；补充查询完成于北京时间 12:30:41.917。运行 release 在调查前后均为 `0bfb98589bb90ef2315e3321866d12bd21ab6fcf`。

**已确认两个独立问题：客户端模型请求继续使用旧账号凭据；年付 Billing 周期被记录为 `monthly`，使 2 亿 token 的月上限实际覆盖完整一年。** 六次请求的 Gateway 鉴权、reservation、最终结算和权益归属一致，全部消耗旧账号 Free；当前登录账号显示 0 与其账本一致。一次性 Free 的 `total` 字段在当前运行代码中正常提供。

后续 Gateway 代码修复与支付／客户端验收状态见[修复回执](./medevidence-account-usage-gateway-fix-receipt-2026-09-14.zh-CN.md)。本文保留调查时的线上事实，不代表修复已部署。

本次仅查询 R760 权威库、审计及运行容器中的编译代码，并保存本地脱敏证据和回复。未补扣、迁移用量、调整权益、撤销 Key、修改服务代码或发布客户端；未读取完整凭据、手机号或对话正文，未以用户身份发起模型请求。

**1. 六次请求的最终扣量与身份链路**

为方便核对，本文用 A 表示当前登录账号，B 表示实际模型账号：

| 项目 | A：当前登录／消息上报账号 | B：模型调用账号 |
| --- | --- | --- |
| Subject | `subj_3VcfqgbpREMwRwNJ8DEmCizz` | `subj_Z7LJIY-GDd1Qln7ysb8TkNxq` |
| Backing credential ID | `cred_welW5_bhXOq48eiszvuEOA` | `cred_4h536HYCePMny4uPc2cGsg` |
| Unified key 记录 ID（非 Key 原文） | `uck_O7ADbUNQkFA7cx0a` | `uck_tAvCdMOs1uZwtRII` |
| 一次性 Free entitlement | `ent_70479a0d23704ae4b1360386806e669d` | `ent_bbe1825ae92c4a4aa94162e237165e53` |
| Free 已用／剩余 | 0／1,000,000 | 430,024／569,976 |

两组 Phone identity、unified key 和 backing credential 各自指向自己的 Subject，没有发现 A 的 unified key 指向 B 的 backing credential。两个 Subject 均 active，模型凭据及 unified key 均未撤销、尚未到期，且无额外 token override。

北京时间的关键顺序：

| 时间 | R760 审计事实 |
| --- | --- |
| 11:28:12.744 | B unified-key resolve 成功 |
| 11:28:19.448 | B logout 成功，旧 Phone Session 已撤销 |
| 11:28:48.323 | A 开户、Key 签发、Phone identity 准备完成 |
| 11:28:50.792 | A login 成功 |
| 11:28:50.936、11:30:45.573 | A unified-key resolve 成功 |
| 11:31:17.203 | 第一条消息使用 A 的 credential 上报 |
| 11:31:17.497 | 对应模型请求使用 B 的 credential 鉴权 |
| 11:41:45.707 | A 年付购买事件 applied；随后四次模型请求仍归 B |

其余两条消息也使用 A 的 credential 上报。支持码 `T:ZNT60VDV` 对应的三条消息与客户端提供的 message/session ID 一致。

| 模型请求 ID | provider total | 最终 Free 扣量（B） | 最终付费扣量 |
| --- | ---: | ---: | ---: |
| `req-b5fe7663-6c73-469d-972f-eba451ec3a05` | 62,954 | 62,954 | 0 |
| `req-b76d2203-0668-4ce6-afd1-2a85e7fa2c11` | 70,280 | 70,280 | 0 |
| `req-f6436724-e9a0-403a-be99-72254d501ba6` | 70,339 | 70,339 | 0 |
| `req-77d1b6bd-f714-4d9e-8cef-9b638911b1b8` | 74,192 | 74,192 | 0 |
| `req-09650ed5-07bc-45b6-b9c9-0734cf138413` | 74,542 | 74,542 | 0 |
| `req-915ee62d-42d5-4f65-8261-6335e5d779ea` | 77,717 | 77,717 | 0 |
| 合计 | **430,024** | **430,024** | **0** |

六条 reservation 均已 finalized，`request.subject_id = reservation.subject_id = entitlement.subject_id = B`，credential ID 也一致。B 的 `period` 终身账本记录 430,024；A 没有 reservation，其两条权益没有用量窗口记录。minute/day/month/period 是不同窗口视图，不应跨窗口相加计算消费。

旧 Phone Session 撤销后，旧模型 Key 仍有效，符合现行 v1 契约：[logout 只撤销 Phone Session family，不撤销旧 Key](../../operations/internal-phone-auth-v1.zh-CN.md#L192)。Gateway 模型入口按每次请求携带的 Bearer 凭据确定 Subject；不会用 client message/session ID 将其改写成当前登录账号。运行代码同时校验 unified key 和 backing credential 的 Subject 一致性。

因此这里是“客户端继续发送另一个仍有效账号的模型凭据”，不能解释为已撤销凭据被绕过，也没有证据支持 Gateway 把 A 的扣量重映射到 B。request_events 保存 backing credential ID，不能据此区分请求原始 Bearer 使用的是 unified key 还是底层模型 Key。客户端报告的 `provider.options.apiKey`／旧 Authorization 覆盖路径与这些证据一致；该客户端根因复现及源码修复由客户端团队提供，本轮未重复其客户端测试。

**2. 同类不一致的范围**

检查窗口为 `2026-09-10T00:00:00Z` 至主快照时刻。读取 680 条消息元数据及 2,178 条带客户端版本号的请求记录，按 **session ID + message ID + 完整版本号** 精确关联，并要求消息侧 Subject 唯一；2,118 条请求可关联，60 条未匹配，不纳入一致性结论。关联中没有多 Subject 歧义记录。

| 完整客户端版本 | 可关联请求 | Subject 不一致请求 | 涉及消息 | 成功请求 | 最终消费 token |
| --- | ---: | ---: | ---: | ---: | ---: |
| `2.0.0-beta.70.sms.20260910.5` | 22 | 11 | 11 | 0 | 0 |
| `2.0.0-beta.70.sms.20260910.6` | 50 | 30 | 17 | 22 | 1,264,307 |
| `2.0.0-beta.71` | 72 | 0 | 0 | 0 | 0 |

表中成功请求／消费仅统计不一致记录。其他已匹配版本也未发现不一致。41 条异常请求中，19 条为 `rate_limited`，22 条成功；成功结算合计 Free 1,114,917、付费 149,390。

**41 条全部位于客户端提供的同一个 `ses_f75abe4a4ffe44zN6FWQVPfmQz` 会话。** `.6` 内存在 7 组模型／消息 Subject 组合，涉及 5 个模型 Subject、6 个消息 Subject；本次 A/B 六次请求是最后一组。该会话历史上多次更换账号，异常最早可追溯至北京时间 9 月 10 日 17:38。Subject 数不是自然人数，客户端 session ID 也不能单独证明设备数；当前证据不能外推为多个独立用户或全量安装受影响。其他组合在汇总证据中使用 Subject 哈希引用。

beta.71 样本未出现异常，只是此时间窗的观察，不能作为修复已发布或旧 SDK 覆盖路径已消失的验收证据。

**3. 年付周期错误已确认，需支付与 Gateway 两侧修正**

A 的购买记录：

| 字段 | 值 |
| --- | --- |
| Billing event | `bevt_bbaa01ae9ff24cbb971bff0ec517ab57` |
| provider / event_type / status | `medevidence_billing` / `purchase` / `applied` |
| external_order_id | `MEDWX20260914000008529071` |
| entitlement_id | `ent_25dcefc0bfcb489ebafefa7860e52421` |
| plan_id | `plan_paid_yearly_v1` |
| Billing event 与 entitlement 的 period_kind | **`monthly`** |
| period_start / period_end | `2026-09-14T03:41:27.867Z` / `2027-09-14T03:41:27.867Z` |
| 日／月限额快照 | 6,000,000／200,000,000 |

在运行容器内直接调用当前编译版 `SqliteTokenBudgetLimiter.getCurrentUsage`，数据库连接为 readOnly + query_only，再经实际 `publicTokenUsage` 序列化，返回：

```json
{
  "month": {
    "limit": 200000000,
    "used": 0,
    "window_start": "2026-09-14T03:41:27.867Z",
    "window_end": "2027-09-14T03:41:27.867Z"
  }
}
```

将只读投影的 `now` 改为 `2026-10-01T00:00:00Z`，窗口起止完全不变。额度预留和查询共同调用 `paidWindowBoundaries`：`monthly` 锚定传入的完整权益周期，`one_off` 使用 UTC 自然月。因此该记录实际会按整年累计限制 2 亿；600 万日限额仍独立执行。当前 A 尚未产生消费，故这不是其“用量 0”的成因，但后续会影响每月额度恢复。

现行年付接入约定是 `period_kind=one_off` 加明确一年起止时间，见[购买接口说明](../../outbox/medevidence-monthly-yearly-purchase-api-2026-09-10.zh-CN.md)。Billing 事件与权益均保存 `monthly`；运行代码 `normalizePeriod` 只检查结束晚于开始等通用条件，原样保留 kind，没有按 Plan 校验类型或月／年长度，也不存在将 `one_off` 转为 `monthly` 的该路径。此证据支持 Billing 调用链提供了错误周期；没有留存原始 HTTP body，支付团队应按上述订单核对请求构造与发送日志。

全年付记录分组还发现：active Subject 下有 3 条 active 年付权益，全部 `monthly`。其中本次为 365 天／日 600 万月 2 亿；另两条仅 30 天，一条沿用不限日月额度旧快照，一条为新日月上限。另有 4 条已停用合成账户的 cancelled 年付记录为正确的 `one_off`／365 天。后两条 active 短期记录需核对订单或测试用途，不能直接作为两个真实年付销售错误，也不能据 Plan 名称自动延长。

建议修复范围：支付端将年付商品明确映射为 `one_off`，按订单传入一年起止；Gateway 为公开月／年付 Plan 增加类型与计费周期校验，错误组合返回明确的 400，防止一年 `monthly` 和年付 30 天被无提示接受。期限规则应覆盖月末、闰年和提前续费，不用固定 30／365 天代替约定的日历月／年；内部试用需明确渠道，避免被公开商品规则误伤。历史权益修复应另行形成保留用量的受控迁移方案，本轮未修改。

附带发现：A 当前 unified key 和 backing credential 到期为 `2027-09-14T03:28:48.323Z`，早于年付权益结束 **12 分 39.544 秒**。这属于既有 Key 生命周期覆盖问题，不导致本次 0 用量；后续购买／续费验收应一并检查凭据期限。

**4. 一次性 Free 响应与客户端展示**

同一份运行代码及只读账本投影确认：

| 字段 | A | B |
| --- | ---: | ---: |
| `free_allowance.total.limit` | 1,000,000 | 1,000,000 |
| `free_allowance.total.used` | 0 | 430,024 |
| `free_allowance.total.remaining` | 1,000,000 | 569,976 |
| `free_allowance.day.limit` | null | null |
| `free_allowance.day.used` | 0 | 0 |

`day.limit=null` 表示不另设日限额，免费总额度应从 `total` 读取；B 的真实非零消费证明旧版只读 day 会显示错误。旧每日字段继续保留兼容，不能据其 null 宣称免费总额度无限。相关实现：[用量读取](../../../packages/store-sqlite/src/token-budget.ts#L395)、[公共字段序列化](../../../packages/core/src/public-token.ts#L14)。

这次验证使用实际运行的 limiter 与公共 serializer，没有重新调用用户凭据的公网 `/gateway/credentials/current`；不把内部只读投影描述为新的公网 HTTP 验收。接口路由使用相同读取／序列化路径，两账号均无 token override。

**建议交接与验收顺序**

1. 客户端先发布当前凭据唯一来源修复：覆盖保存的 SDK apiKey/baseURL 和最终 Authorization，轮换更新、退出／切换账号失效旧 SDK，图片请求同步。保留其 `free_allowance.total` 展示修复。不能仅更新余额轮询或以 beta.71 版本名作为完成标志。
2. 支付端修正年付周期映射；Gateway 增加公开套餐周期校验，并制定上述存量异常记录的逐笔处理方案。将 Key 有效期覆盖完整购买／续费期限纳入验收。
3. Gateway 支持查询增加“同 message/session 的跨 Subject 不一致”诊断或告警。消息接口的 Subject 来自该请求鉴权，可作为排障证据；客户端上传的会话标识不是模型鉴权授权依据。任何防错机制应拒绝不一致或提示重新登录，不应自动将模型请求或历史消费改记到另一个 Subject，也不能把会话永久锁死而误伤合法切号。
4. 安装包联合验收：旧账号登录并使用 → 退出 → 新账号登录 → 对话／工具多次请求／图片 → 购买年付 → 继续使用 → 同账号轮换。对每次新请求核对最终 Authorization 的账号、消息 Subject、request/reservation Subject 与查询 Subject 一致；Free 总量真实增加，付费只在 Free 耗尽后增加。旧 SDK 在退出后不能继续发请求，年付跨 UTC 月边界须恢复新月窗口。使用隔离或明确授权的测试账户，不对本次用户补扣来做验收。

本地证据：[主查询 JSON](../../../artifacts/account-usage-20260914/gateway-readonly.json)、[范围／运行代码补查](../../../artifacts/account-usage-20260914/gateway-followup.json)、[Phone 登录退出审计](../../../artifacts/account-usage-20260914/gateway-phone-audit.json)、[可复查的只读脚本](../../../artifacts/account-usage-20260914/audit-readonly.mjs)。查询不包含完整 Key、手机号、消息正文或附件。
