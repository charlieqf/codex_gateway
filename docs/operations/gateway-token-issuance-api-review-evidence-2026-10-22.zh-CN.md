# Gateway Token 接口评审内部核验记录

2026-10-22。供 Gateway 维护方使用。对外使用[身份与支付后端评审清单](../outbox/gateway-token-issuance-api-review-2026-10-22.zh-CN.md)。

本记录保存外发清单的核验依据、管理功能边界及旧文档差异，不作为身份／支付正常接入流程。

## 2026-10-23 追加 Token 功能实现

本地 main 工作目录已实现独立的 gift／topup 发放、按幂等键查询、账户发放流水和追加余额查询；接口合同见[追加 Token 接入文档](../outbox/gateway-token-credits-api-2026-10-23.zh-CN.md)。本次未部署、未操作生产余额。下文 2026-10-22 核验仍为当时线上状态，不能据此认定新接口已上线。

- 用户已确认永久有效，且套餐日／月 Token 额度不足后允许使用追加余额。
- SQLite migration 43 新建 token_credit_accounts、token_credit_events、token_credit_debits，并为预留增加追加额度拆分字段和在途查询索引。只增加结构；旧 Plan、权益、Key、用量和请求快照保持。新发放不生成或替换 Plan。
- 发放与事件持久化在同一 BEGIN IMMEDIATE 事务内，金额字段不参与此接口。幂等键校验完整业务字段；provider + external_event_id 唯一；topup 再校验 provider + external_order_id 唯一。
- 请求预留按原免费／套餐顺序，然后用追加余额。实际结算、免收决策、超时暂结与补账共同保持事务原子性；校正追加消耗以独立 signed debit 记录保留证据。上游估算超出时真实消耗可形成负余额，不静默免收。
- 发放流水和追加扣费流水不依赖请求日志保留期。对账应校验账户 granted_tokens = 发放流水 SUM(tokens)，charged_tokens = 扣费流水 SUM(tokens)。额度重置不能清空此账本；有未结算追加请求时返回 quota_reset_conflict。
- 旧 gateway-usage-history-transfer.cjs 已适配新增列，但明确拒绝导入 credit-enabled 请求，因为该工具不迁移钱包账本。生产迁移／恢复须使用受控完整数据库备份和相应账本核验，不能只复制请求历史。
- 无追加账户的请求仍用原有扣费路径。现有手工 gift Plan 不转换到新钱包，注册 500 万额度统计不与新发放混计。

验证：自审修整后 `npm run build` 通过；core、SQLite store、Gateway 主接口、Billing 及 token-budget hook 合计 25 个测试文件、673 项通过。新增测试覆盖幂等与业务订单去重、入账失败回滚、跨连接预留、数据库重开、v42 升级、Free／套餐／追加拆分、套餐到期、请求保留期、超时补账、失败免收及 Chat／Responses 两种传输方式。生产发布前仍须按现行 runbook 核对当时 main、origin/main 和生产版本，部署已提交且批准的不可变版本。

### 代码自审与修整

- 已修复统计兼容问题：旧按日 Free 权益使用追加余额时，原逻辑仅取独立 free_allowance 的用量，导致 final_free_tokens 漏记。现在以免费主权益应计总量减去追加消耗计算；实际余额原本正确。专门测试验证 2500 Token 分成 2000 免费、500 追加，先复现失败再修复通过。
- HTTP 层独立解析字段并调用共享运行时校验，移除外部输入的类型强转；仅依赖 TokenCreditStore，不依赖整个身份／支付管理接口。持久化入口仍校验同一业务规则，避免内部直接调用绕过校验。
- 追加账本自行读取原扣费流水并计算校正差额，不再依赖请求层传 previousTokens；结算方法明确要求既有事务，保证与免费／套餐账本共同提交或回滚。移除写账前不必要的在途余额汇总查询。
- 合并免费与套餐的日／月余量算法，展开预留计算中的嵌套条件。事务仍由请求结算器统一管理，发放、账本持久化、HTTP 解析各自负责自身边界。
- 补充“校正写入失败时所有账本回滚，重试只校正一次”的测试；异常字段类型验证继续覆盖 HTTP 400。新功能仍未部署生产。

## 核验结果

2026-10-22 只读确认 R760 发布目录为 `a259d29d378a6748d2227ce8a0cb8680a5373c87`；核验时本地 main 为 `c532861`，相关 Billing、身份、权益和扣费源文件无差异。

03:33 UTC 公网 `GET /gateway/admin/billing/v1/plans` 返回 HTTP 200。注册 Free 实际为 500 万，Plan ID 仍为 `plan_free_once_1m_v1`；月付日 500 万、计费月 1.5 亿；年付日 600 万、UTC 自然月 2 亿。三个模板均为每分钟 60 万。旧权益保留自己的策略快照。

以下四个文件共 131 项测试通过，覆盖手机号关联开户、月年付周期、凭据有效期覆盖以及 Free／付费扣费：

- `apps/gateway/src/billing-retail-periods.test.ts`
- `apps/gateway/src/billing-identity-coordination.test.ts`
- `packages/store-sqlite/src/billing-retail-periods.test.ts`
- `packages/store-sqlite/src/free-paid-quota.test.ts`

上述为本次接口调查的验证记录；随后的文档整理没有重新执行生产发放、额度重置、支付或服务部署。

## 管理接口与工具边界

`POST /gateway/admin/billing/v1/users/{subject_id}/quota-reset`：

- request_windows 支持 minute/day，token_windows 支持 minute/day/month；两者省略时均默认 day。
- 不支持注册免费额度的 period 终身账本，不改变 Token 上限或 requests/day 上限。
- 当前不校验或持久化 Idempotency-Key；重复执行可能再次清掉两次调用间的新用量，不可使用支付事件式自动重试。

人工赠送遵循[保留现有权益的一次性赠送](extra-gift-preserve-entitlements.zh-CN.md)。通用 purchase 虽能选择已有赠送 Plan，仍遵循新建／替换规则，不能代替保证净追加且保留原权益的赠送操作。免费终身额度重置、Plan 策略调整和请求上限调整遵循[控制面操作规范](r760-control-plane-authority.md)。

`/phone-auth-identities`、`/real-user-issues` 和注册补偿接口属于身份准备或人工开户运维流程，不列为正常发放 Token 的对接入口。套餐目录还含内部高额度、Desktop 测试、会议试用、赠送及历史模板；active 状态不等于可销售。

## 对外合同需要避免的误解

- Billing HTTP 的套餐替换路径没有通用已用量结转参数，也没有调用管理 CLI 的 carryCurrentUsage 逻辑。不能承诺同周期升级自动保留已用量；Free 与零售付费并存、先 Free 后付费是另一个已实现规则。
- `GET /users/{subject_id}/entitlements` 的 publicEntitlement 序列化不返回 Token 策略快照或 used/reserved/remaining。账户详情路径为 `/subjects/{subject_id}`，没有通用 `GET /users/{subject_id}`。
- `GET /usage` 是消耗报表，不能替代各权益账本余额。客户端 `GET /gateway/credentials/current` 的 token_usage 含窗口用量；free_allowance.total 是一次性免费／赠送终身账本。它使用用户模型凭据，不能充当管理侧按 Subject 查询接口。
- Phone Session `GET /gateway/account/v1/current` 当前 token_wallet 为 null，不是钱包余额查询接口。
- Billing Admin 认证当前未按 provider、Plan 或路由细分权限；独立 token 本身不提供这些权限边界。

## 源码及历史依据

- [HTTP 路由与字段解析](../../apps/gateway/src/billing-admin.ts)
- [事件处理和周期校验](../../packages/store-sqlite/src/billing-events.ts)
- [注册免费与零售共存规则](../../packages/store-sqlite/src/free-allowance.ts)
- [管理端权益发放与用量结转](../../packages/store-sqlite/src/entitlements.ts)
- [客户端凭据与额度查询](../../apps/gateway/src/index.ts)
- [手机号账户服务](../../apps/gateway/src/services/phone-auth-service.ts)
- [免费额度升级至 500 万](free-plan-5m-2026-09-24.zh-CN.md)

旧[收费充值外发指南](../medevidence-billing-integration-guide.external.zh-CN.md)仍可追溯字段合同，但免费 100 万、早期三档套餐和“全部写接口幂等”等表述不能整体作为当前线上行为。已将相关差异用业务规则写入外发清单，内部源码路径和发布／测试记录保留在此。
