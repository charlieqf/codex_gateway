# 用户48877：Gateway 年付额度结论与修复回执

2026-09-14。关联[完整只读调查](./medevidence-account-usage-gateway-investigation-result-2026-09-14.zh-CN.md)。客户端团队已反馈“凭据修复已推送”；本回执不据此宣称新安装包已发布或联合验收完成。

**当前状态：Gateway 代码修复已完成，构建及 409 项相关回归通过；尚未部署，也未修改存量权益。年付窗口问题不能因客户端凭据修复而关闭。**

**年付问题的完整结论**

- 对象：`subj_3VcfqgbpREMwRwNJ8DEmCizz`，订单 `MEDWX20260914000008529071`，权益 `ent_25dcefc0bfcb489ebafefa7860e52421`。
- Billing 事件和权益均记录 `plan_paid_yearly_v1 + period_kind=monthly`，期限为 `2026-09-14T03:41:27.867Z` 至 `2027-09-14T03:41:27.867Z`。
- 调查时运行版本 `0bfb98589bb90ef2315e3321866d12bd21ab6fcf` 对 `monthly` 使用完整权益周期作为月窗口，故 **2 亿 token 实际按整年累计，10 月不会重置**；600 万日限额仍独立执行。这与年付商品约定不一致。
- 正确合同是 `period_kind=one_off` 加一年起止时间，付费月上限按 **UTC 自然月** 重置，无额外年度总量上限。不是将月限额提高为 24 亿或将年付设为 `unlimited`。
- 当前两套身份不同是另一个问题。六次请求的 430,024 token 全部结算到旧账号 Free；当前登录账号用量 0 符合当时账本。年付窗口错误不解释这次的 0 用量，但会影响恢复正确凭据后的长期计费。

**Gateway 本次代码变化**

| 修复 | 新行为 | 边界 |
| --- | --- | --- |
| Billing 公开月／年付周期校验 | 月付必须 `monthly`，年付必须 `one_off`；拒绝年付 30 天、月付一年、多年合并成单期等明显异常，返回 HTTP 400 `invalid_period` | 新的 `purchase`、`renew` 执行时检查；已应用事件的幂等重放保留，`log_only` 和内部其他 Plan 不受公开商品规则影响 |
| 当前 Desktop Key 有效期覆盖 | 成功购买／续费时，在同一事务内将该 Subject 当前有效 Desktop unified key 及匹配 backing credential 的不足到期时间延至权益结束，并在权益审计中记录旧值 | 保留原 Key；不缩短较长期限，不恢复已撤销 Key，不延长非 current、非 Desktop 或其他 Subject 的凭据。2026-09-23 评审后修订：到期 90 天以内的当前 Desktop Key 会随付款恢复，审计记录 `revived_after_expiry`；已撤销或到期超过 90 天的，仍需原有凭据恢复流程 |
| 管理端跨 Subject 诊断 | 消息查询新增 `identity_mismatch`，按 session + message + 完整版本匹配其他 Subject 请求，页面显示“账号可能不一致”及实际请求 Subject | 仅管理端排障；其他账号请求不计入消息所属账号的用量，不改变模型鉴权、登录状态或账本归属 |

周期长度检查为月付 28–31 天、年付 365–366 天，各允许一小时夏令时偏移；这是合理性边界，不替支付端计算日历锚点。月末顺延、月底续期、闰年和支付周期仍由支付端确定，Gateway 原样保留传入日期。公开年付不再作为 30 天试用载体，内部试用应使用明确的内部 Plan。

Key 延期与购买／续费事务一起提交，审计失败会回滚权益和延期；相同事件重放不会重复发权益或再执行延期。此次仅覆盖 Gateway 的当前 unified key／backing credential，不改变外部身份服务凭据或后续独立换 Key 接口的有效期契约。

**支付团队接入与存量处理**

建议顺序：支付端先修正年付 `one_off` 映射（现有 Gateway 已支持正确请求），再部署 Gateway 校验／诊断修复，随后受控修正存量记录。这样可避免部署校验后仍发送错误 `monthly` 而导致新的年付开通返回 400。

1. 新年付购买及续费均向现有 `POST /gateway/admin/billing/v1/entitlement-events` 发送 `plan_id=plan_paid_yearly_v1`、`period_kind=one_off` 和真实一年起止。月付仍是 `monthly`。新代码部署后错误周期会返回 400，支付端需保留原始 `error.code`、`error.message` 与 request ID。
2. 对尚未 applied 且因 `invalid_period` 被拒绝的请求，Gateway 未落 Billing 事件或新权益；修正后可重试。对已经 applied 的原事件，必须保持原请求体和幂等键进行重放，不能修改 body 后强行复用同一 key。
3. **本次已经 applied 的订单不能靠重新 purchase 修复。** 不应换幂等键重复开通，也不应取消重买以清零用量。需对原 entitlement 制定受控修正：保留 Subject、Key、权益 ID、起止时间、策略快照和真实用量，将错误周期改为 `one_off`；如届时已有请求／预留或月窗口用量，须核对并保留正确归属后再迁移。
4. 另两条 active 年付记录仅 30 天，先核对订单或测试用途，不能直接批量延长为一年。现有 Key 期限也需逐笔检查；本账号当前已知 Key 比年付结束早 12 分 39.544 秒，本次代码不会自动回溯更新这笔历史订单。

**关闭问题的验收条件**

- Gateway 修复版本部署完成，并由支付／Gateway 联调确认错误年付请求返回 400、正确 `one_off` 购买及幂等重放成功。
- 本账号原权益受控修正后，在 9 月查询应返回付费月窗口 `2026-09-01T00:00:00Z` 至 `2026-10-01T00:00:00Z`；10 月使用新 UTC 月窗口，600 万日额度及 2 亿月额度独立，真实历史用量保留。
- 当前 Gateway Key 的到期时间覆盖完整付费期。先过期、90 天内付款的，同一把 Key 自动恢复，Desktop 和手机号登录都无需人工处理；已撤销或过期超过 90 天的，按原凭据恢复流程处理。
- 用已发布安装包验证切号后消息、模型请求、reservation 与额度查询的 Subject 一致；Free 用量从 `free_allowance.total` 展示。不能将其他 Subject 的历史消费复制到当前账号作为通过依据。

**验证结果**

- `npm run build` 通过（TypeScript 全工作区构建）。
- 以下 8 个文件共 409 项测试通过：Store `billing-retail-periods.test.ts`、`free-paid-quota.test.ts`、`index.test.ts`；Gateway `billing-retail-periods.test.ts`、`admin-client-messages.test.ts`、`billing-identity-coordination.test.ts`、`http/auth.test.ts`、`index.test.ts`。
- 新增测试覆盖错误周期拒绝且不落库、HTTP 400 后修正重试、正确订单幂等重放、月末／闰年／时区偏移、提前续费、Key 与权益同事务回滚、已撤销／到期超过 90 天／非 current 凭据排除、90 天内到期的当前 Key 恢复、同 Subject 链路、年付 UTC 跨月实际记账、跨 Subject 诊断与本人统计分离、合法切号、缺失字段和详情截断。
- 管理页通过实际生成的脚本函数验证提示与 Subject 展示，并检查脚本语法；不作为真实浏览器或安装包 UI 验收。
- 修改的跟踪文件 `git diff --check` 通过。没有运行生产收款、用户模型请求或存量权益迁移测试。

代码：[Billing 校验与 Key 覆盖](../../../packages/store-sqlite/src/billing-events.ts)、[管理端诊断](../../../apps/gateway/src/admin-client-messages.ts)。上线和存量修正尚未执行。
