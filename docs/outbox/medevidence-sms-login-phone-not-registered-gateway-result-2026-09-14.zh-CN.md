# 短信登录后 phone_not_registered：Gateway 调查回执

后续代码状态：历史账号补登记分支已修复，构建及 459 项回归通过，尚未部署。见[修复回执](./medevidence-sms-login-phone-enrollment-fix-receipt-2026-09-14.zh-CN.md)。下文保留调查时线上版本的证据和结论。

2026-09-14。对应[客户端联合核查单](../../../medevidence-opencode-stable/docs/outbox/medevidence-sms-login-phone-not-registered-2026-09-14.zh-CN.md)。本文时间说明使用北京时间，证据 JSON 使用 UTC。

## 结论

**本案已确认停在 Gateway Phone identity 查询阶段。** 请求 `req-c16a568d-b565-4e59-81dd-2ec8bdca11d2` 于 13:36:08 返回 HTTP 403、`phone_not_registered`。截至 15:18:24，目标号码仍无 Phone identity，也未在当前 Subject 手机号、外部身份登记和已保留管理审计的手机号字段中匹配到账号。

**13:34:09–13:47:33 的连续登录失败期间，R760 容器 HTTP 日志未收到任何 `POST /gateway/admin/billing/v1/subjects` 或 `POST /gateway/admin/billing/v1/subjects/resolve`。** 因此，没有证据表明该时段内存在一个已经到达 R760、携带该手机号并成功完成的开户请求。仍不能区分身份后台未调用、调用了其他地址、请求到达 Gateway 前失败，或更早已创建了不含手机号的账号。

**另发现并在本地复现 Gateway 的历史账号补登记缺口：已有 external identity 的 Subject 缺少手机号时，`resolve` 返回 `linked`，再次带 phone 开户返回 `409 subject_already_exists`，但不会补齐 Phone identity。** 这是确定的代码行为；目前无法确认本案对应这一分支，不能把它直接认定为本案根因。

用户已确认只有一个环境。本轮不以 prod/test 划分或环境切换作为解释，也不要求提供环境信息。现有材料没有本案外部 user_id 或开户回执；外部 ID 应按身份后台实际保存值核对，不能猜测或另造一个 ID。

## 线上证据

R760 当前容器版本 `0bfb98589bb90ef2315e3321866d12bd21ab6fcf`，启动于 9 月 12 日 10:38:28，检查时 healthy。本轮没有部署或重启。

| 检查项 | 结果 |
| --- | --- |
| 截图请求 HTTP | 13:36:08.208 入站，403，耗时约 2.35 ms |
| Phone Auth 审计 | 13:36:08.209，login/error，phone_not_registered，subject_id=null |
| 9 月 14 日同号登录审计 | 20 条：18 条未登记、2 条限流；13:34:09.621–13:47:33.142 |
| 更早的同号审计 | 8 月 24 日 10:53:34、11:14:30、11:14:43，共 3 条 phone_not_registered |
| 截至 15:18:24 的同号 Phone identity | 0 |
| 当前 Subject 手机号匹配 | 0；检查 969 条，包含停用/归档记录 |
| 外部身份登记手机号匹配 | 0；检查 37 条 external_subject_registrations |
| 发放 external_user_id 中的手机号匹配 | 0 |
| 管理审计中的手机号/外部 ID 字段匹配 | 0；检查 19,309 条已保留审计 |
| 截图 request ID 对应模型请求 | 0 |
| 对应客户端诊断记录 | 0 |

匹配在 R760 内存中使用已部署的手机号规范化和 HMAC 逻辑；没有导出手机号、手机号哈希或凭据。8 月 24 日记录证明该号码此前出现过相同错误，不证明期间一直没有登记，也不证明当天使用短信登录。

HTTP 日志检查范围为北京时间 08:00:00–15:19:43，解析 47,657 条 JSON 日志，非 JSON 行为 0，最早记录在 08:00:00.045。该范围内：

- `/subjects` 的 POST 共 3 次：11:28:48 返回 200、13:06:54 返回 409、13:49:30 返回 200。
- `/subjects/resolve` 的 POST 为 0。该接口可选，单独没有 resolve 请求不构成异常；本案连续失败期间连直接 `/subjects` POST 也没有。
- 日志没有记录开户请求体，不能把上述其他时段的请求自动归给本案。13:49:30 的 200 也不能作为本案已恢复的依据。
- 截至 15:21:17，当天 `medevidence_billing` 两条成功新开户事件均有手机号、active Phone identity 和 active 一次性 Free 权益。这说明系统当天存在成功开户实例，不代表本案已完成开户或客户端验收。

## 代码链路与历史账号缺口

已先核对真实发 Key 流程：`real-user-issue.ts` 包含 `prepare_phone_login`，在 Key 与权益验证后准备 Phone identity。不能把旧式 Billing Subject 存在等同于已经执行该步骤。

线上版本的 `PhoneAuthService.login()` 先按手机号哈希查 Phone identity；查不到时直接记录 `phone_not_registered` 并返回 403，尚未检查模型 Key、套餐或免费额度。因此，本案这条错误发生在额度判定之前。公开 v1 登录不会自动创建未知手机号账号。

新用户通过后台直接 `/subjects` 传顶层 `phone`，或先完成可选 resolve 后开户，正常路径会在同一数据库事务中创建 Subject、模型凭据、可恢复当前 Key、Free 和 Phone identity。仅正常新开户成功可据此判断这些记录同时提交；旧事件幂等重放和旧账号关联不是这个新开户分支。

本地隔离复现使用内存 SQLite、Fastify HTTP 注入和无网络的上游桩，结果如下：

| 步骤 | 返回 | Phone identity |
| --- | --- | --- |
| 旧式 `/subjects`，不带 phone，首次创建 | 200 | 无 |
| 同 provider/external_user_id 调 `/subjects/resolve`，携带 phone | 200，status=linked | 仍无，Subject.phone_number 仍为空 |
| 同 external identity 另发带 phone 的开户事件 | 409，subject_already_exists | 仍无 |
| PhoneAuthService.login | phone_not_registered | 无法登录 |

复现中原 Key 未变化，上游创建仅发生一次。相关分支已与线上 release 对应源码核对；本地复现不代表已对真实账号执行任何登录或修改。

原因是 `external-identities.ts` 命中既有 external identity 后直接返回 `linked`；`billing-admin.ts` 随后发现 Subject 已存在便返回 409，均不执行新的 `phoneSignup` 准备。故 **`linked` 或查回 Subject 只能证明身份关联，不能证明手机号登录已就绪**。同一原幂等键增加 phone 重试还会导致请求体冲突，不能用这种方式补登记。

15:21:17 的补充统计显示：当前 35 条 active、primary provider 为 `medevidence_billing` 的 Subject 中，25 条有手机号及 Phone identity，另 10 条两者都没有。这 10 条尚未按业务用途分类，不能计作 10 位受影响真实用户，也不能确认本案属于其中之一。

## 后续处理

1. **身份后台交接核查**：按 9 月 14 日 13:34–13:47 的 Desktop 短信成功日志反查后台开户流程，核对 `source: pc` 分支是否执行、目标是否为 `https://goldencode.instmarket.com.au:1443`、是否发送顶层 `phone`，以及 Gateway 返回。现有 Gateway request ID 用于核对客户端登录失败，不会自动出现在外部短信请求中。后台可从自己保留的时间与登录记录定位，不以终端用户补交这些信息为前提。
2. **确认新用户时**：恢复带手机号的后台开户流程，等待 Gateway 成功回执再让客户端申请 v1 授权。免费资格不依赖购买；当前新用户 Free 是 `plan_free_once_1m_v1`，一次性 1,000,000 token。
3. **确认历史 Subject 时**：保留原 Subject、Key、权益和用量，补齐正确手机号关联及 Phone identity；不得另换 external_user_id 重复开户。Gateway 需要补全历史账号准备分支，并验证绑定冲突、当前 Key 可恢复性、停用状态及原权益。现有 `resolve=linked`/`subject_already_exists` 不足以完成这项恢复。
4. **客户端验收**：后台确认账号已就绪且外部短信会话仍有效后，在现有授权待完成页面重试一次，检查 login/start、bootstrap、进入主页和后续真实请求；再核对实际账户用量。无需靠重新收验证码或购买套餐绕过登记问题。

本轮完成调查与本地复现，未修改生产账号、手机号映射、Key、权益或服务代码，未发送短信、使用用户凭据或发起模型请求。线上根因仍需身份后台交接证据才能最终归因；不能把调查回执当成修复完成或恢复验收。

## 证据与源码

- [Phone identity / Subject / 审计查询](../../artifacts/sms-login-pending-20260914/gateway-readonly.json)，[只读脚本](../../artifacts/sms-login-pending-20260914/audit-readonly.mjs)。
- [HTTP 入站与响应核对](../../artifacts/sms-login-pending-20260914/gateway-http-readonly.json)，[只读脚本](../../artifacts/sms-login-pending-20260914/audit-http-readonly.py)。
- [当前开户样本与 Free 配置统计](../../artifacts/sms-login-pending-20260914/gateway-signup-context.json)。
- [历史账号缺口复现结果](../../artifacts/sms-login-pending-20260914/legacy-link-reproduction.json)，[本地复现脚本](../../artifacts/sms-login-pending-20260914/reproduce-legacy-link.mjs)。
- [真实发 Key 流程](../../apps/gateway/src/real-user-issue.ts)、[PhoneAuthService](../../apps/gateway/src/services/phone-auth-service.ts)、[Billing 路由](../../apps/gateway/src/billing-admin.ts)、[external identity 关联](../../packages/store-sqlite/src/external-identities.ts)、[原子开户事务](../../packages/store-sqlite/src/billing-subjects.ts)。
- [既有联调合同](./medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md)、[当前一次性免费额度合同](./medevidence-free-once-quota-contract-2026-09-11.zh-CN.md)。前者早期每日 Free 描述按后者修订。
