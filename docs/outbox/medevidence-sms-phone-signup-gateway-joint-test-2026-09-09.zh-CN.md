# MedEvidence 短信／临时登录：Gateway 联调说明

2026-09-09。兼容修订已部署 R760，提交 27f10d9：取消 resolve 强制前置，兼容 5 月原样开户，公网验收通过。见[兼容修订上线记录](../operations/r760-billing-create-compatibility-release-2026-09-09.zh-CN.md)。先前 63c818f 的两步开户验收见[历史上线记录](../operations/r760-phone-signup-release-2026-09-09.zh-CN.md)。

本文是本轮联调入口。先前 medevidence-sms-runtime-v2 外部 token 换 Key 候选合同已撤回，客户端使用现有手机号 v1 合同。

2026-09-10 测试期额度调整：之后新开户默认使用 `plan_free_daily_10k_v1`，每日 10,000 token。
此前已发放的 `plan_free_daily_1m_v1` 和其他既有权益、Key、用量保持不变；首次使用短信登录的老账户仍按老账户关联。
这是 Gateway 发放默认值的调整，客户端和身份后端请求格式不变。

## 流程与地址

统一 Origin：https://goldencode.instmarket.com.au:1443，原路径不变。

1. Desktop 调用身份后端真实短信登录接口，保存手机号及外部 access/refresh token，即完成外部短信登录。
2. 身份后端用既有 Billing Admin 凭据调用 POST /subjects 并传 phone；Gateway 内部关联或开户。新手机号账户自动获得免费权益并准备手机号登录，旧账户保留原 Subject、Key 和权益。原样不带 phone 且无 resolve 记录的 5 月 Billing 请求仍可开户，沿用原付费事件流程。
3. Desktop 以手机号调用 Gateway login/start，取得独立 Phone Session，再通过 bootstrap 领取 cgu_live Key，沿用 resolver/current 和模型调用流程。
4. 支付页使用外部短信会话，无需先取得模型 Key。外部 token 不发送给 Gateway 领取 Key。

临时登录供已登记用户直接执行第 3 步，不依赖短信／支付后端，也不产生外部支付 token。未知手机号仍返回 403 phone_not_registered，不通过此公开接口自动开户。

## Desktop 接口

完整既有合同：[手机号 v1](../contracts/medevidence-internal-phone-auth-v1/README.md)、[R760 双轨兼容说明及 fixture](../contracts/medevidence-r760-dual-track-phone-auth-v1/README.md)。字段和版本不变。

POST /gateway/auth/v1/login/start，请求头 Content-Type: application/json、X-MedEvidence-Client-Version: 实际版本，请求体：

```json
{
  "phone": "13800138000",
  "client": "medevidence-desktop",
  "device_id": "desktop-device-example-01",
  "contract_version": 1
}
```

使用此响应的 Gateway access_token，以 Authorization: Bearer 形式调用：

- POST /gateway/auth/v1/session/bootstrap，请求体 {}，读取 unified_key.key。
- GET /gateway/account/v1/current，读取 subject.id、identity.plan_id 和权益能力。
- 用 cgu_live 调用 POST /gateway/unified-keys/resolve，随后使用返回的模型凭据调用模型及 GET /gateway/credentials/current。

Phone Session 的 auth_method 仍为 transition_phone_only；Desktop 可记录 UI 登录来源 sms，但不表示 Gateway 校验过短信。外部 access/refresh token 与 Gateway Phone Session 必须分开保存、刷新和退出。

后台开户尚未完成时，Desktop 保留外部“已登录”状态，展示模型暂未就绪并允许重试，不能安装上一个账户的 Key。沿用 phone_not_registered、phone_login_disabled、account_disabled、capability_not_allowed、account_migration_required 错误，不使用已撤回的 v2 account_ready/runtime:null。

既有登录版本门槛为 2.0.0-beta.40；MedEvidence 上游切换至 R760 的版本门槛为 2.0.0-beta.47。客户端发送实际版本，不伪造版本绕过门槛。

## 身份／支付后端：直接开户，resolve 可选

以下接口仅供服务端使用，复用既有 Authorization: Bearer <Billing Admin 凭据>。管理凭据不分发给 Desktop。

映射约定：provider=medevidence_billing；APP_ENV=prod 时 external_user_id=str(user_id)，其他环境为 medevidence_test_{user_id}。

推荐：直接 POST /gateway/admin/billing/v1/subjects，沿用 Authorization、Content-Type 和 Idempotency-Key，请求体：

```json
{
  "provider": "medevidence_billing",
  "external_user_id": "medevidence_test_21",
  "phone": "13800138000",
  "scope_allowlist": ["code"]
}
```

Gateway 内部完成手机号关联和新开户准备。若匹配到既有账户，建立外部关联后沿用旧合同返回 409 subject_already_exists；使用 GET /subjects?provider=...&external_user_id=... 取回 subject.id。保留旧账户、Key、权益及用量，不重复开户。

phone 是向后兼容的可选扩展。5 月原样请求不带 phone 且无 resolve 记录时，仍创建原 Billing Subject 和 Key，不自动赋予手机号登录和免费权益；响应继续为 subject.id、credential.key、credential.issued_at、credential.expires_at，不返回顶层 subject_id/key/expired_at。该路径的原付费事件流程保持可用。

可选两步流程的第一步：POST /gateway/admin/billing/v1/subjects/resolve，JSON：

```json
{
  "provider": "medevidence_billing",
  "external_user_id": "medevidence_test_21",
  "phone": "13800138000"
}
```

| 返回 status | 后续处理 |
| --- | --- |
| linked | 保存 subject.id，复用该账户，不再 create；原姓名、Key、权益和用量不变 |
| create_ready | 调用下述开户接口 |
| account_pending | 继续原开户事件，同 Idempotency-Key、完全相同请求体 |

该接口只返回状态、Subject 标识和 request_id，不返回完整 Key。手机号冲突返回 409 identity_conflict，账户停用返回 403 account_disabled；不自动改绑、复活账户或删除历史。稳定外部身份关联后，不因请求中的手机号变化而自动迁移到另一 Subject；换绑单独处理。

可选两步流程的第二步：POST /gateway/admin/billing/v1/subjects，增加请求头（直接开户也使用此固定业务事件规则）：

```http
Idempotency-Key: medevidence_billing:medevidence_test_21:create_subject
Content-Type: application/json
```

请求体：

```json
{
  "provider": "medevidence_billing",
  "external_user_id": "medevidence_test_21",
  "scope_allowlist": ["code"]
}
```

姓名可空：name=null，手机号独立保存，display_name 可省略。不使用“姓名=手机号”；人工发 Key 工具的姓名必填不适用于此接口。

对于直接提供 phone 或沿用 resolve 的手机号新开户，Gateway 在同一数据库事务中保存 Subject、模型凭据、可恢复的当前 cgu_live Key、免费权益和 Phone identity。200 返回时，新用户即可走 Desktop v1，无需再人工登记或另调 phone-auth-identities。

订单归属使用 subject.id（subj_...），不能使用 credential.id（uck_...）、Key 或 prefix。首次响应含 credential.key；相同业务事件重试返回 idempotent_replay=true，不再次返回完整 Key、不重复发额度。Desktop 可通过手机号 bootstrap 取回当前 Key，不依赖收费侧保存了首次响应。收费侧若仍需恢复完整 Key，沿用既有受控轮换流程。

不再因跳过 resolve 拒绝开户。身份后端等待所选开户请求成功；仅身份后端数据库创建成功不等于 Gateway 已准备完毕。手机号开户失败重试保持原 Idempotency-Key 和请求体；不要增删 phone 字段来重试同一事件。

## 免费额度与首次付费

- 新账户 Plan：plan_free_daily_10k_v1，每日累计 10,000 token，月累计不额外设限。这是 2026-09-10 起的临时测试默认值；已发放的每日 1,000,000 token 权益保持不变。
- 沿用 UTC 00:00 日窗口，即北京时间 08:00。重复登录、换设备、重复开户和轮换 Key 不重置用量。
- 保留服务端限制：20 次／分钟、200 次／天、4 并发；token 每分钟上限 300,000。
- 免费 Plan 开放文本聊天和工具调用。本次未开放免费图像、医生研究等独立能力。
- 免费权益无期末；Key 沿用现有 365 天有效期和受控轮换机制。旧账户不自动改成免费 Plan。
- 免费版首次购买现有付费套餐：event_type=purchase，replace_current=true，指定付费 Plan 和明确起止时间；不要对无期末的免费权益使用 renew。升级保留 Subject 和 Key。
- 付费期满自动退回免费版、199 元月付／1999 元年付 token 不限量均不在本次发布中，既有付费套餐规则保持现状。

## 配置与验收边界

本次新增启用配置仅为 GATEWAY_BILLING_IDENTITY_PROVIDER=medevidence_billing，用于后台开户关联。复用既有 Phone Auth、API Key 加密和完整 Key 恢复配置，不需要外部 JWT 密钥或 token 校验接口。

Migration 28 增加关联／开户状态表。免费 Plan 在首次新手机号开户事务中创建，之后复用，不批量修改历史账户。

兼容修订增加 5 月原样请求、直接手机号开户、旧账户关联、错误输入和并发重试的回归覆盖。本地及固定提交的 Linux 镜像内类型检查与 344 项相关测试通过；三种开户方式、公网手机号登录、Key、免费权益及真实模型验证通过，见[本轮验收](../operations/r760-billing-create-compatibility-release-2026-09-09.zh-CN.md)。先前 63c818f 的 338 项测试及两步流程上线证据见[历史发布记录](../operations/r760-phone-signup-release-2026-09-09.zh-CN.md)。

公网验收使用临时测试账户与真实模型调用，不代替真实 captcha／短信／支付验收。身份后端可直接发送带 phone 的开户请求，也可沿用可选 resolve 流程；客户端继续 SMS→v1 适配。

正式用户协议和隐私政策链接仍由产品提供，分别配置 MEDEVIDENCE_AUTH_TERMS_URL、MEDEVIDENCE_AUTH_PRIVACY_URL；本轮不编造或发布这些协议。当前客户端表单仍会受链接缺失影响。
