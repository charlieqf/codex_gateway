# MedEvidence R760 双轨兼容手机号免验证码登录 Gateway 实施规格 v1

| 项目 | 内容 |
| --- | --- |
| 规范 ID | `medevidence-r760-dual-track-phone-auth-gateway-v1` |
| 文档版本 | `1.0` |
| 文档状态 | `implementation_ready` |
| 实现状态 | `not_implemented`；现有基线不能原样发布 |
| 部署状态 | `not_deployed` |
| 日期 | 2026-08-21 |
| 唯一生产权威 | R760 Gateway |
| 唯一公共 Origin | `https://goldencode.instmarket.com.au:1443` |
| Gateway 实现基线 | `feature/internal-phone-auth-v1@c528f4a8609dc88c56fc883426e54dd91ba73308` |
| 目标 Desktop | MedEvidence `2.0.0-beta.40`；若正式版本号改变，按第 13.2 节更新发布配置 |
| Wire contract | 继续使用 `contract_version=1`；本规范冻结双轨行为及一个新增稳定错误码 |

本文使用“必须”“不得”表示规范要求，使用“建议”表示不影响合同的实现选择。
本文是本轮 **R760 Gateway 双轨兼容改造的权威实施规格**。它可以直接用于拆分代码任务、编写测试、准备发布候选和执行验收，但不表示相关代码已经实现、合并或部署。

## 1. 决策摘要

本轮只做一件事：给已经存在的 Gateway 账户增加手机号 Session 登录入口，同时长期保留原 `cgu_live_*` 登录路径。

必须达到的最终体验是：

1. MedEvidence beta.38 及其他仍使用有效 `cgu_live_*` 的旧客户端继续工作，不要求增加版本 Header，不因手机号功能上线收到全局 HTTP 426。
2. MedEvidence beta.40 可以只输入已由管理员登记的手机号直接登录，不发送短信验证码。
3. 手机号登录必须落到手机号原来对应的同一个 Gateway `subject_id`；不得迁移账户、复制账户或新建第二个账户。
4. 登录方式切换不得改变原 Plan、entitlement、capability、额度窗口或历史用量。
5. 手机号登录、refresh、logout、Session 过期和客户端升级均不得自动撤销原 `cgu_live_*`。
6. 新设备没有旧 Key 时，也允许在本过渡阶段通过已登记手机号直接登录；只允许精确的管理员预登记名单，未知手机号不得自动开户。
7. Gateway 先部署并启用兼容模式，beta.40 才能发布手机号入口。

一句话架构原则是：

> 手机号 Session 给原 Subject 增加入口；它不替换原 Subject，也不切断旧 Key。

## 2. 规范效力与替代关系

### 2.1 规范优先级

发生冲突时按以下顺序处理：

1. 本规范负责双轨范围、身份不变量、版本门禁、错误分类、实现任务、测试、上线和回滚，优先级最高。
2. [`medevidence-internal-phone-auth-v1`](../contracts/medevidence-internal-phone-auth-v1/README.md) 及其 [`fixtures.json`](../contracts/medevidence-internal-phone-auth-v1/fixtures.json) 继续负责七条既有路由的请求字段、成功响应字段、JWT/Refresh 基线和通用错误 envelope，但其“全路径版本门禁”和“一次性切换”假设被本规范替代。
3. [`medevidence-desktop-gateway-phone-auth-wallet-v1.zh-CN.md`](../coordination/medevidence-desktop-gateway-phone-auth-wallet-v1.zh-CN.md) 作为历史协调记录保留；其中“切换后旧 Desktop 不再兼容”“手机号登录与全路径 426 同时开启”和单次维护窗口切断旧客户端的内容不再适用。
4. [`medevidence-phone-auth-cgu-wallet-implementation-plan-2026-08-15.zh-CN.md`](./medevidence-phone-auth-cgu-wallet-implementation-plan-2026-08-15.zh-CN.md) 继续作为 T/F/P 长期设计参考，不得把其中短信、钱包或支付范围带入本次实现。
5. 2026-08-21 的 Gateway 讨论稿和 Desktop 回复稿是本规范的决策输入，不再作为实现时的并列规范来源。

### 2.2 保持不变与正式替代的内容

保持不变：

- `contract_version=1`；
- 五条 Phone Session 路由及 resolver、`credentials/current` 的方法、路径和主体结构；
- Access JWT 15 分钟、Refresh Token 原子轮换、Refresh idle 30 天、Session absolute 180 天；
- bootstrap 返回当前 `cgu_live_*`，再通过 resolver 获得运行凭据；
- R760 固定 Origin、Subject/Key/capability/URL 跨响应一致性要求；
- 手机号只查询管理员预登记身份，不自动注册；
- `Cache-Control: no-store`、`Pragma: no-cache` 和秘密隔离要求。

正式替代：

- 旧客户端从“不再兼容”改为长期兼容；
- 版本门禁从“所有 Desktop 业务路径”改为 `auth_only`；
- 手机号登录从“单次统一切换”改为旧 Key 与 Phone Session 长期并行；
- 登录失败或 Subject 冲突不得锁死仍然有效的旧 Key 路径；
- Gateway logout 只撤销 Phone Session，不撤销旧 Key；
- 无旧 Key 新设备纳入受控手机号直登范围；
- 增加 `phone_login_disabled` 稳定错误，区分“只关闭手机号入口”和“整个账户停用”。

### 2.3 变更控制

下列任一变化必须提升本规范版本，并由 Gateway 与 Desktop 共同确认后实施：

- 改变路由、请求必填字段、成功响应必填字段或错误码含义；
- 将旧 Key 业务路径纳入强制版本门禁；
- 自动撤销或停止接受仍有效的历史 `cgu_live_*`；
- 允许未知手机号自动开户；
- 引入短信、一次性验证码、支付、钱包或赠送额度；
- 改变 Subject、Plan、entitlement 或用量归属规则。

最低 Desktop 版本号、下载 URL、限流数值和具体 allowlist 是发布配置。它们可以通过经过审核的运维变更调整，但不得改变上述行为合同。

## 3. 范围与非范围

### 3.1 本次范围

- R760 Gateway 的手机号预登记、Phone Session、JWT、Refresh、logout、bootstrap 和 account current；
- `auth_only` Desktop 版本门禁；
- beta.38 无版本 Header 的旧 Key 全业务兼容；
- beta.40 原地升级、手机号关联、新设备手机号直登和 legacy fallback 所需的 Gateway 合同；
- Subject、Plan、entitlement、capability 和用量不变量；
- 数据审计、错误分类、限流、审计、灰度、验收和回滚。

### 3.2 明确不在本次范围

- 短信验证码、语音验证码、邮件验证码或公开注册；
- 任意手机号自动创建 Subject、Key、Plan 或 entitlement；
- 免费 Token 钱包、图片赠送、充值、月付、年付、订单或支付 JWT；
- 云端同步 Desktop 本地历史会话、文件或工作区；
- 旧 Key 的批量撤销或强制迁移；
- R760 之外的 Gateway、Azure 兼容栈或 CN1 dark gateway；
- 船期工具、GoldenCode vessel 客户端、船运行业用户或其 `cgu_live_*`；这些与 MedEvidence 用户完全独立。

## 4. 目标架构

两条入口最后必须汇合到同一个 Subject 和同一套运行授权：

```text
beta.38 / 旧客户端
  cgu_live_* -> resolver -> backing cgw.* -> 现有业务接口
       |                                |
       `----------- subject_id ---------'

beta.40
  已登记手机号 -> Phone Session -> bootstrap -> current cgu_live_*
                                           -> resolver -> backing cgw.*
                                                |
                                                `-> 同一 subject_id / Plan / 用量
```

beta.40 在本机已有旧 Key 时采用双轨状态：

- 旧 Key 独立有效即可先进入应用；
- 手机号关联期间业务请求继续使用旧 Key；
- Session/bootstrap Subject 与旧 Key Subject 完全一致后才原子切换；
- Session 临时不可用时可以回退到已经验证、同 Subject 且未被用户 suppress 的旧 Key；
- Gateway 不根据 User-Agent、IP 或版本 Header 猜测凭证来源。

## 5. 不可破坏的不变量

### 5.1 身份不变量

1. Phone identity、Phone Session、current unified key、历史兼容 unified key、backing credential、Plan、entitlement 和用量必须锚定同一个不可变 `subject_id`。
2. 一个规范化手机号最多绑定一个 Subject；一个 Subject 最多有一个活动 Phone identity。
3. 手机号登录不得调用开户或 Subject 创建逻辑。
4. 一个 Subject 可以有多个仍有效的历史 `cgu_live_*`，但 Phone bootstrap 只返回一个明确的 current key。
5. 手机号、display name、Plan 名称或 Key prefix 均不能代替 `subject_id` 做两条路径的一致性判断。
6. Phone Session 与本机旧 Key Subject 不一致时，不接受新 Session、不合并账户、不修改映射；原旧 Key若仍独立有效则继续工作。

### 5.2 业务状态不变量

以下操作不得写入或重置 Plan、entitlement、capability、配额窗口、余额或历史用量：

- `login/start`；
- `token/refresh`；
- `logout`；
- `session/bootstrap`；
- `account/current`；
- Desktop 从 legacy runtime 切换到 Session runtime；
- Desktop 从 Session 临时回退 legacy runtime。

只有测试中实际发送的对话、Research、图片或其他正常计费业务请求可以产生相应的新用量。

### 5.3 Key 生命周期不变量

1. 预登记 Phone identity 不得撤销或缩短旧 Key 有效期。
2. 登录、refresh、logout、Session replay 处置和 Session 过期均不得撤销旧 Key。
3. backing credential 正常轮换时，仍有效的旧 `cgu_live_*` 应继续通过 resolver 指向有效运行凭据。
4. 如果管理员选择新的 current unified key，旧 key 只从 `is_current` 降为兼容 key，不得因此自动 revoked。
5. 只有原有控制动作才能使旧 Key 失效，例如管理员明确撤销泄露 Key、Key 到期、Subject 被停用或 entitlement 本身失效。
6. 关闭手机号功能只停止新登录和 Session 使用，不改变任何 `cgu_live_*` 状态。

## 6. 登录资格与手机号免验证码政策

### 6.1 登录资格

`login/start` 只允许同时满足以下条件的记录成功：

- 请求手机号符合 `^1[3-9][0-9]{9}$`，Gateway 规范化为 `+86` E.164；
- `phone_auth_identities` 中存在唯一且为 `active` 的 Phone identity；
- Phone identity 指向唯一且为 `active` 的既有 Subject；
- Phone identity 指向该 Subject 的 current、未撤销、未过期、可恢复 `cgu_live_*`；
- unified key 的 backing `cgw.*` 属于同一 Subject，未撤销、未过期且可恢复；
- Subject 有活动 entitlement、允许 `code` scope，并具有 `chat` capability；
- public model allowlist 允许 `goldencode`；
- 所有加密材料、JWT signing key 和必要 store 可用。

任一条件不满足时不得部分登录、不得创建新 Subject，也不得修改现有 Plan 或 Key。

### 6.2 新设备政策决定

本规范正式记录如下产品决定，以消除实现阻塞：

- 过渡阶段允许没有旧 Key 的新设备，仅凭管理员已预登记手机号直接获得 Phone Session；
- 不发送短信验证码，也不要求用户输入旧 Key；
- 该登录方式必须记录为 `auth_method=transition_phone_only`，不得记录或展示为 SMS 已验证；
- 允许范围严格等于 R760 中状态为 `active` 的 Phone identity 集合；
- 未登记手机号、冲突手机号和未准备完整的账户均不得登录或自动开户；
- 该过渡方式的结束条件是后续强身份认证合同部署并完成单独迁移决策，不设置会自动导致旧客户端或已登记用户中断的日历失效开关。

本节即为本轮书面产品风险接受，替代 Desktop 回复稿中“另加一次性持有证明或另等一份日历截止日批准”的实现前置条件。实施团队不再等待第二份安全决策；后续复核可以收紧新登录方式，但必须作为独立、版本化且不切断旧 Key 的变更处理。

这是一个有意受限的过渡登录方式。以下控制是功能启用的组成部分，不是可选增强：

- 按 phone hash、IP risk key 和 device ID 三个维度限流；
- 所有结果写入脱敏审计；
- 管理员可以立即停用 Phone identity 并撤销其活动 Session；
- 未登记与其他不可登录状态使用稳定错误码和统一用户文案，不返回账户详情；
- 不在响应、日志或诊断中返回手机号全文；
- R760 保持单实例 Gateway；扩展到多实例前必须把登录限流迁移到共享持久化实现。

## 7. 规范性 HTTP 合同

### 7.1 路由表

| 方法 | 路径 | 授权 | `auth_only` 版本门 | 成功 |
| --- | --- | --- | --- | --- |
| `POST` | `/gateway/auth/v1/login/start` | 无 bearer | 必须 | `200` JSON |
| `POST` | `/gateway/auth/v1/token/refresh` | JSON 内 Refresh Token | 必须 | `200` JSON |
| `POST` | `/gateway/auth/v1/logout` | Access JWT | 必须 | `204` empty |
| `POST` | `/gateway/auth/v1/session/bootstrap` | Access JWT | 必须 | `200` JSON |
| `GET` | `/gateway/account/v1/current` | Access JWT | 必须 | `200` JSON |
| `POST` | `/gateway/unified-keys/resolve` | `cgu_live_*` | **不得执行** | 现有 `200` JSON |
| `GET` | `/gateway/credentials/current` | backing `cgw.*` | **不得执行** | 现有 `200` JSON |

Phone Session 五条路由以及 resolver/current 的请求与成功响应字段继续以现有 v1 fixture 为准。响应可以添加字段，Desktop 必须忽略未知响应字段；请求对象继续关闭，未知正文参数返回 `400 invalid_request`。

### 7.2 `POST /gateway/auth/v1/login/start`

请求必须包含版本 Header：

```http
X-MedEvidence-Client-Version: 2.0.0-beta.40
Content-Type: application/json
```

正文必须精确为：

```json
{
  "phone": "13800138000",
  "client": "medevidence-desktop",
  "device_id": "desktop-device-example-01",
  "contract_version": 1
}
```

成功返回现有 `login_start_authenticated` fixture，至少包含：

- `status=authenticated`；
- `auth_method=transition_phone_only`；
- `token_type=Bearer`；
- Access JWT、opaque Refresh Token 及其过期信息；
- 唯一 `subject.id` 和 `subject.state=active`。

未知手机号返回 `403 phone_not_registered`，不得自动创建任何账户数据。Phone identity 被单独停用返回 `403 phone_login_disabled`。Subject 被停用才返回 `403 account_disabled`。

### 7.3 Refresh、logout、bootstrap 和 account current

- Refresh 请求正文继续精确包含 `refresh_token`、`client`、`device_id` 和 `contract_version=1`。
- Refresh 每次成功必须在同一事务中使旧 Token 失效并返回新 Token；旧 Token replay 撤销该 Session family，返回 `401 refresh_token_invalid`。
- logout 只撤销当前 `sid`/Session family；不得撤销 Subject、Phone identity、unified key、backing credential或 entitlement。
- Desktop 无论 logout 网络结果如何，都负责清除本地 Phone Session 和内存 runtime。
- bootstrap 使用 Access JWT 返回该 Subject 当前 `cgu_live_*`；完整 Key 只存在于 HTTPS 响应和可信客户端进程内。
- account current 继续返回同一 Subject 的内部账户、Plan/capability 视图；本轮 `token_wallet` 与 `image_credits` 仍为 `null`。

### 7.4 跨响应一致性

同一 Phone Session 必须满足现有 v1 contract 的全部一致性约束，并增加以下双轨约束：

1. `login/refresh.subject.id = bootstrap.subject.id = account/current.subject.id`。
2. bootstrap key 经 resolver 得到的 `subject.id` 必须等于上述 Subject。
3. beta.40 本机旧 Key 经 resolver 得到的 `subject.id` 必须在切换前等于 Phone Session Subject。
4. 不一致时 Desktop 对新 Session执行 best-effort logout，随后删除本地新 Session；Gateway 不修改旧 Key。
5. Subject mismatch 是 Desktop 检测到的本地稳定分类 `phone_subject_mismatch`，不得把它伪装成 `account_disabled`。Gateway 通过 logout 审计与已有客户端诊断接收支持信息，不新增包含旧 Key 或手机号的报文。

### 7.5 旧业务接口兼容合同

在 `auth_only` 模式下，以下请求不得因为版本 Header 缺失、非法或过旧而返回 426：

- `/gateway/unified-keys/resolve`；
- `/gateway/credentials/current`；
- `/v1/*`；
- `/gateway/research/v1/*`；
- `/gateway/images/generations`；
- `POST /gateway/vision/assets`；
- `POST /gateway/vision/assets/:assetId/complete`；
- `POST /gateway/vision/assets/:assetId/read-url`；
- `DELETE /gateway/vision/assets/:assetId`。

这些路径继续执行原有 bearer、Subject、Key、Plan、capability、rate limit 和业务校验。`auth_only` 只移除版本拒绝，不放宽任何现有授权。

即使 beta.40 主动在业务请求中发送版本 Header，Gateway 在 `auth_only` 下也只能将它用于观测，不得据此改变业务授权或拒绝请求。

## 8. 版本门禁实现合同

### 8.1 配置枚举

`GATEWAY_DESKTOP_VERSION_GATE` 改为以下严格枚举：

| 值 | 行为 |
| --- | --- |
| `disabled` | 所有路径均不执行 Desktop 426 |
| `auth_only` | 只对第 7.1 节五条 Phone Session 路由执行 426 |
| `all` | 保留旧实现的全 Desktop 路径门禁，仅供未来独立迁移使用 |

旧值 `enabled` 必须在启动时被拒绝并给出不含秘密的明确配置错误，避免它被误解为 `auth_only` 后静默切断 beta.38。

`GATEWAY_PHONE_AUTH_MODE=transition` 必须同时满足：

- `GATEWAY_DESKTOP_VERSION_GATE=auth_only`；
- 严格 SemVer 的 `GATEWAY_MINIMUM_DESKTOP_VERSION`；
- 绝对 HTTPS `GATEWAY_DESKTOP_DOWNLOAD_URL`；
- 第 10.1 节全部 Session、加密和 store 前置条件。

`transition + disabled`、`transition + all` 和 `transition + enabled` 均必须启动失败。失败必须发生在监听端口之前，不得运行时自动降级。

### 8.2 唯一路由判定

实现中必须有一个可单元测试的纯函数作为唯一路由判定源，逻辑等价于：

```text
shouldGate(disabled, route)  = false
shouldGate(auth_only, route) = route 属于五条 Phone Session 路由
shouldGate(all, route)       = route 属于旧全路径集合
```

全局 `onRequest` hook、Phone route preflight 和 resolver 内部检查不得各自维护不同列表。可以保留多个调用点，但它们必须调用同一个判定函数。

检查顺序：

- Phone Session 路由先执行版本门，再解析手机号、Refresh Token 或 Access JWT；
- `auth_only` 的 legacy resolver/业务路径完全跳过版本门，继续执行原认证顺序；
- `all` 模式下才继续使用 credential class 区分 `desktop` 与明确的 `service/operator`；
- 不得使用 User-Agent、源 IP、缺失 Header 或路径历史推断 credential class。

### 8.3 SemVer 和 426

- Header 名固定为 `X-MedEvidence-Client-Version`；
- 使用严格 SemVer 比较并遵循 prerelease 优先级；
- 缺失、非法或小于最低版本均返回 HTTP 426 `client_upgrade_required`；
- 426 必须返回 `minimum_version`、`download_url` 和 `request_id`；
- 所有 426 返回 `Cache-Control: no-store` 与 `Pragma: no-cache`；
- Desktop 不解析 `message` 获取结构化信息。

## 9. 稳定错误分类与 fallback 含义

现有错误 envelope 保持：

```json
{
  "error": {
    "code": "<stable-code>",
    "message": "<human-readable-not-parsed>",
    "request_id": "req_example"
  }
}
```

`429` 继续包含 `retry_after_seconds` 和 `Retry-After`。新增 Gateway 错误码：

| HTTP | Code | 精确定义 |
| ---: | --- | --- |
| 403 | `phone_login_disabled` | 只停用了该 Subject 的 Phone identity/Phone Session 登录；Subject 和旧 Key 没有因此停用 |

实现必须把该错误加入 core 错误枚举、Phone service、route fixture 和 Desktop 联合 fixture。不得复用 `account_disabled` 表示 Phone identity 被单独停用。

| Code/事件 | Gateway 含义 | 有已验证旧 Key 时 |
| --- | --- | --- |
| `client_upgrade_required` | 仅新 auth 客户端版本不满足 | 原 legacy 路径继续工作 |
| `phone_not_registered` | 没有预登记 Phone identity | 保持 `legacy_ready` |
| `phone_login_disabled` | 只关闭手机号登录 | 保持 `legacy_ready` |
| `phone_identity_conflict` | 手机号/Subject 映射不唯一 | 拒绝新 Session，原 legacy 继续 |
| `account_migration_required` | current key/runtime bundle 未准备完整 | 不接受 Session；原 Key 若独立有效则继续 |
| `auth_rate_limited` | 登录风险桶达到上限 | 临时错误；legacy 继续，按 Retry-After 再试 |
| `service_unavailable`、网络超时、5xx | 临时服务错误 | legacy 继续，可重试 |
| `access_token_expired` | Access JWT 到期 | 先 refresh；失败后按同 Subject规则 fallback |
| `access_token_invalid` | Access JWT/Session 无效或已撤销 | 清除 Session；独立验证旧 Key 后可 fallback |
| `refresh_token_invalid` | Refresh 无效、过期、已轮换或 replay | 清除 Session；非用户退出且旧 Key 同 Subject 时可 fallback |
| `account_disabled` | 整个 Subject 被停用 | 不得通过 legacy 绕过 |
| `revoked_credential`、`expired_credential` | 对应 Key 已撤销或到期 | 不得继续使用该 Key |
| `capability_not_allowed` | 当前账户不允许该能力 | 不得通过切换凭证来源绕过 |
| `phone_subject_mismatch` | Desktop 比较两条路径后发现 Subject 不同 | 丢弃新 Session，原有效 legacy 继续并转人工处理 |
| 用户“退出本设备” | Desktop 用户意图，不是 Gateway 错误 | Desktop 必须 suppress 自动 legacy 回登 |

Gateway 响应只提供稳定 code；Desktop 不得按 `message`、HTTP 文案或 Provider 文案猜测是否 fallback。

## 10. 数据与服务端实现

### 10.1 复用 migration 25

双轨改造本身不需要新增数据库 migration。现有 additive migration 25 已提供：

- `access_credentials.credential_class`；
- `unified_client_keys.token_ciphertext`；
- `unified_client_keys.credential_class`；
- `unified_client_keys.is_current` 及每 Subject 一个活动 current key 的唯一索引；
- `phone_auth_identities`；
- `phone_auth_sessions`；
- `phone_auth_refresh_tokens`；
- `phone_auth_audit_events`。

不得删除、重建或回滚这些表。旧数据库副本迁移必须幂等，关闭功能时既有请求行为必须不变。

如果实现期间确实需要增加持久化字段，必须在当前最大 Gateway schema 版本之后追加新 migration，不得修改 migration 25 的已发布 SQL；相应字段、恢复和回滚测试必须先补入本规范的新版本。

### 10.2 预登记写入语义

继续使用受 Billing Admin 身份保护的接口：

```http
POST /gateway/admin/billing/v1/phone-auth-identities
Authorization: Bearer <billing-admin-token>
Content-Type: application/json

{
  "phone": "13800138000",
  "subject_id": "subj_example",
  "unified_key": "<complete-existing-cgu-live-key>"
}
```

必须满足：

- 只复用已有 Subject 和已有 unified key；
- 同一手机号、Subject、current key 的重复请求幂等成功；
- 同手机号不同 Subject、同 Subject 不同手机号或 Key/Subject 不一致返回冲突且零部分写入；
- 同手机号、同 Subject 选择新的有效 current key 时允许受控更新，但旧 key 保持原 revoked/expiry 状态；
- 成功只返回 `prepared`、`subject_id` 和 identity state，不回显手机号或 Key；
- 原始手机号只加密保存，查询索引使用 HMAC；
- 完整 unified key 使用独立恢复密钥加密；
- 请求、响应、审计参数和日志均不得包含完整 Key。

### 10.3 Phone identity 与 Subject 停用必须分离

```http
PATCH /gateway/admin/billing/v1/phone-auth-identities/<subject-id>
Content-Type: application/json

{"state":"disabled"}
```

该操作必须：

- 停止新的手机号登录；
- 在同一事务中撤销该 Phone identity 的活动 Session/Refresh Token；
- 后续登录返回 `phone_login_disabled`；
- 不停用 Subject，不撤销任何 `cgu_live_*` 或 backing credential，不改变 Plan。

管理员真正停用 Subject 时，既有 Subject 状态和 credential auth 规则负责同时拒绝 Session 与 Key 路径。两种操作不得共用含义。

### 10.4 Session 和 Token

- Access JWT 使用 Ed25519；header 必须包含活动 `kid`。
- 必填 claims：`iss`、`aud`、`sub`、`sid`、`jti`、`iat`、`nbf`、`exp`。
- `iss=https://goldencode.instmarket.com.au:1443/gateway/auth/v1`。
- `aud=codex-gateway`。
- 最大时钟偏差 60 秒。
- JWT 不包含手机号、`cgu_live_*`、backing key、Plan、余额或 capability。
- Access JWT TTL 默认 900 秒。
- Refresh idle 默认 30 天，Session absolute 默认 180 天。
- Refresh Token 只保存 hash/prefix，成功使用后原子轮换。
- replay 撤销整个 Session family；不得因此撤销旧 Key。
- Session 每次 bootstrap/account current 都重新读取 Subject、identity、current key 和 entitlement 状态，不信任 JWT 内缓存业务权限。

### 10.5 登录限流

成功或失败的 `login/start` 都进入三个独立风险桶：

| 维度 | 配置 | 默认 RPM |
| --- | --- | ---: |
| 规范化 phone hash | `GATEWAY_PHONE_AUTH_LOGIN_PHONE_RPM` | 5 |
| IP risk key 的 SHA-256 | `GATEWAY_PHONE_AUTH_LOGIN_IP_RPM` | 20 |
| `device_id` 的 SHA-256 | `GATEWAY_PHONE_AUTH_LOGIN_DEVICE_RPM` | 10 |

规则：

- 三个桶全部取得 permit 后才能查询 Phone identity；
- 任一桶拒绝即释放已经取得的 permit，返回 `429 auth_rate_limited`；
- 不在日志或 limiter key 中保存原始手机号、IP 或 device ID；
- `Retry-After` 与正文 `retry_after_seconds` 必须一致；
- 当前 R760 单 Gateway 进程可以复用现有 in-memory limiter；启用第二实例前必须先实现共享限流。

### 10.6 审计与可观测性

`phone_auth_audit_events` 至少记录：

- request ID；
- action：prepare、identity state、login、refresh、logout、bootstrap、account current；
- phone hash（适用时）；
- Subject ID、Session ID（已解析时）；
- `auth_method=transition_phone_only`；
- outcome 和稳定 reason code；
- UTC 时间。

不得记录：

- 原始手机号、IP 或 device ID；
- Access JWT、Refresh Token；
- 完整 `cgu_live_*`、`cgw.*` 或 MedEvidence key；
- secret 文件内容或解密失败正文。

业务 `request_events` 继续作为请求次数、耗时和 token 用量权威。Gateway 不得仅凭相同 backing credential 猜测请求是 Session 主路径还是 legacy fallback；如需展示 fallback，beta.40 通过既有脱敏客户端诊断事件明确上报 `auth_path=session|legacy|legacy_fallback`，该字段只用于观测，不参与授权。

## 11. 代码改造清单

### 11.1 Gateway runtime

| 文件/模块 | 必须改造 |
| --- | --- |
| `apps/gateway/src/desktop-version-gate.ts` | 将 boolean gate 改为 `disabled|auth_only|all`；增加唯一 route-policy 函数；拒绝旧 `enabled` 值 |
| `apps/gateway/src/index.ts` | `transition` 只允许配合 `auth_only`；所有全局和 resolver gate 调用使用同一路由策略；health 返回 mode |
| `apps/gateway/src/phone-auth-routes.ts` | 保持 auth route 版本门；增加 device risk bucket；保持 no-store 和稳定错误 envelope |
| `apps/gateway/src/services/phone-auth-service.ts` | Phone identity disabled 返回 `phone_login_disabled`；确认 logout/replay 不修改 unified key |
| `packages/core/src/errors.ts` | 增加 `phone_login_disabled` |
| `packages/core/src/phone-auth.ts` | 如实现需要，补充不泄密的审计/限流类型；不得改变现有 Token 形状 |
| `packages/store-sqlite/src/phone-auth.ts` | 保持事务和幂等准备；验证 identity disable 只撤 Session，不撤 Key |
| `config/gateway.example.env` | 记录新 gate 枚举和 device RPM |
| `config/gateway.container.example.env` | 同上，并保持 secret 仅使用 `_FILE` |

### 11.2 合同与运维资料

实现 PR 必须新增一个不覆盖旧冻结目录的联合 fixture 目录：

```text
docs/contracts/medevidence-r760-dual-track-phone-auth-v1/
  README.md
  fixtures.json
  SHA256SUMS
```

新 fixture 复用现有 v1 成功响应，并至少增加：

- `phone_login_disabled`；
- `auth_only` 下 beta.38 无 Header 的允许矩阵；
- Phone auth 路由缺失/低版本 Header 的 426；
- Subject mismatch 的 Desktop 本地分类说明；
- logout 不撤 Key 的状态快照；
- 登录前后 Plan/usage 不变量快照字段。

不得原地修改旧冻结目录并继续沿用其 SHA attestation。新目录提交后由 Gateway/Desktop 对同一完整 commit 签收。

同时必须更新：

- `docs/operations/internal-phone-auth-v1.zh-CN.md`：从 `enabled` 改为 `auth_only`，改写灰度和回滚；
- `docs/coordination/medevidence-desktop-gateway-phone-auth-wallet-v1.zh-CN.md`：在顶部声明旧一次性切换模型已被本规范替代；
- `docs/operations/system-status.md`：只在真实实现/部署完成后更新状态，不提前声称已上线。

### 11.3 Desktop 联调边界

Desktop 实现不在本仓库，但 Gateway 验收依赖以下约定：

- 有效旧 Key 不被 PhoneAuthGate 阻塞；
- `legacy_ready -> linking_phone -> session_ready` 原子切换；
- 切换前比较 resolver Subject 与 Session/bootstrap Subject；
- 临时错误允许符合条件的 legacy fallback；
- Subject/account disabled 不允许 fallback；
- “退出本设备”写入本地 suppression，重启后不能因保留旧 Key 自动回登；
- logout 不删除 beta.38 兼容 Key；删除本机旧授权是另一个明确操作；
- Renderer、UI、日志和诊断只接触 safe prefix，不接触完整 Token/Key。

## 12. 测试与验收矩阵

### 12.1 Gateway 单元与集成测试

必须增加或修改以下自动化测试：

1. 配置解析接受 `disabled|auth_only|all`，拒绝 `enabled` 和未知值。
2. `transition + auth_only` 启动；`transition + disabled/all/enabled` 启动失败。
3. `auth_only` 只覆盖五条 Phone Session 路由。
4. beta.38 无 Header 调 resolver、`credentials/current`、`/v1/*`、Research、图片和四条 Vision Asset 路由，不返回 426。
5. beta.40 合法 Header 可以调用全部 Phone Session 路由。
6. Phone auth 路由缺 Header、非法 SemVer、低版本分别返回结构化 426。
7. Phone identity disabled 返回 `phone_login_disabled`；Subject disabled 返回 `account_disabled`。
8. 登录、refresh、logout、Refresh replay 和 identity disable 均不改变 unified/backing key 的 revoked/expiry 状态。
9. 同 Phone/Subject/current key 预登记幂等；三类映射冲突均零部分写入。
10. phone、IP、device 三个风险桶分别可以触发 429，Retry-After 一致且审计不含原值。
11. bootstrap/resolve/current/account 的 Subject、prefix、expiry、capability 和 URL 一致性继续通过。
12. login/bootstrap/refresh/logout 前后 Plan、entitlement 和既有用量行不变。
13. 功能关闭后 legacy 测试仍全部通过，additive schema 保留。
14. 日志和 fixture secret scan 不出现完整手机号、JWT、Refresh Token 或真实 Key。

### 12.2 beta.38 兼容矩阵

| 场景 | 必须结果 |
| --- | --- |
| beta.38 无版本 Header + 有效旧 Key | resolver、聊天、工具、Research、图片、Vision 按原规则工作 |
| 只部署 additive release、功能关闭 | beta.38 行为与部署前一致 |
| 开启 `transition + auth_only` | beta.38 不收到全局 426 |
| 预登记其手机号 | 旧 Key revoked/expiry/Plan 不变 |
| 同 Subject 在其他设备手机号登录 | 原 beta.38 Key 不被撤销 |
| Gateway logout Phone Session | beta.38 Key 继续工作 |
| 关闭手机号功能回滚 | beta.38 无需任何客户端动作继续工作 |

### 12.3 beta.40 双轨矩阵

| 场景 | 必须结果 |
| --- | --- |
| beta.38 原地升级，旧 Key 有效 | 不登录即可进入原主界面并完成业务请求 |
| 用户输入已登记手机号 | 不显示验证码，直接取得 Session |
| Subject 完全一致 | 原子切换到 Session runtime |
| Subject 不一致 | 丢弃新 Session，原 legacy 继续，提供 request ID/支持码 |
| 手机号未登记/Phone identity disabled | 有旧 Key时保持 legacy；无旧 Key时留在登录页 |
| 429、超时或 5xx | 保留 Session和旧 Key，符合条件时 fallback |
| Refresh replay | 撤销 Session family；不撤旧 Key |
| Subject disabled | Session 与旧 Key都不能绕过账户状态 |
| 用户退出本设备并重启 | 保持 `phone_signed_out`，不自动 legacy 回登 |
| 新设备无旧 Key、手机号已登记 | 直接取得 Session并进入原 Subject |
| 新设备手机号未知 | 不开户，留在登录页 |
| 登录前后快照 | Subject/Plan/entitlement/capability/既有用量不变 |

### 12.4 真实 R760 E2E

发布前至少使用受控测试账户完成两条链路。不得读取或导出真实用户消息正文。

链路 A：

```text
正式 beta.38 安装包 + 有效测试旧 Key
-> 原地安装 beta.40 candidate
-> 不登录完成一次真实对话
-> 输入已登记手机号
-> login/bootstrap/resolver/credentials current/account current
-> 验证同 Subject/Plan/entitlement
-> Session 路径完成一次真实对话
-> 重启并恢复 Session
-> 退出本设备
-> 再次重启仍保持退出
```

链路 B：

```text
无旧 Key 的新设备
-> 输入已登记测试手机号
-> login/bootstrap/resolver/current
-> 验证原 Subject/Plan/entitlement
-> 完成一次真实对话
-> 停用 Phone identity
-> Session失效但旧 Key服务器状态不变
-> 重新启用后可再次手机号登录
```

E2E 结束后撤销测试 Session、清理测试凭证/entitlement/用户及临时文件。真实 Key 不进入命令输出、日志、截图或文档。

## 13. 配置合同

### 13.1 默认关闭配置

代码合并和 additive 部署时使用：

```text
GATEWAY_PHONE_AUTH_MODE=disabled
GATEWAY_DESKTOP_VERSION_GATE=disabled
GATEWAY_MINIMUM_DESKTOP_VERSION=
GATEWAY_DESKTOP_DOWNLOAD_URL=
GATEWAY_PHONE_AUTH_LOGIN_PHONE_RPM=5
GATEWAY_PHONE_AUTH_LOGIN_IP_RPM=20
GATEWAY_PHONE_AUTH_LOGIN_DEVICE_RPM=10
```

schema、secret 文件和预登记数据可以提前准备，但默认配置不得改变旧客户端请求路径。

### 13.2 生产启用配置

beta.40 目标版本的生产配置是：

```text
GATEWAY_PUBLIC_BASE_URL=https://goldencode.instmarket.com.au:1443
GATEWAY_PHONE_AUTH_MODE=transition
GATEWAY_DESKTOP_VERSION_GATE=auth_only
GATEWAY_MINIMUM_DESKTOP_VERSION=2.0.0-beta.40
GATEWAY_DESKTOP_DOWNLOAD_URL=https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe
GATEWAY_PHONE_AUTH_LOGIN_PHONE_RPM=5
GATEWAY_PHONE_AUTH_LOGIN_IP_RPM=20
GATEWAY_PHONE_AUTH_LOGIN_DEVICE_RPM=10
```

同时必须配置现有 JWT、phone lookup HMAC、phone encryption 和 unified-key recovery `_FILE` 变量。secret 值不得进入 env 或 Git。

如果 Desktop 最终版本不是 `2.0.0-beta.40`：

1. 在候选安装包冻结后把 `GATEWAY_MINIMUM_DESKTOP_VERSION` 改为实际严格 SemVer；
2. 确认 R2 公开安装包已指向该版本并通过 hash/Range/feed 校验；
3. 先部署 Gateway 配置并验证 426 响应，再开放客户端更新；
4. 该操作不改变 `contract_version=1`，也不得扩大版本门到 legacy 路径。

### 13.3 Health

`GET /gateway/health` 的 `phone_auth` 至少返回：

```json
{
  "phone_auth": {
    "mode": "transition",
    "version_gate_mode": "auth_only",
    "minimum_desktop_version": "2.0.0-beta.40"
  }
}
```

不得在 health 中返回手机号、allowlist、Session、Key prefix、secret 路径或 secret 状态细节。

## 14. 上线顺序

### 阶段 A：代码和合同

1. 按第 11 节完成 Gateway 改造。
2. 新建双轨 fixture 目录并由 Gateway/Desktop 签收同一 commit。
3. 本地运行 build、完整测试、secret scan 和 diff check。
4. 手机号功能与版本门保持 `disabled`。

### 阶段 B：只读数据审计

对目标名单生成不含秘密的映射：

```text
masked phone / phone hash
-> subject_id
-> current cgu safe prefix
-> backing credential safe prefix
-> plan_id / entitlement state / capability
-> readiness result
```

至少阻止以下问题进入预登记：重复手机号、缺失结构化手机号、Subject inactive、没有唯一 current key、key 不可恢复、Key/Subject 不一致、backing credential 无效、Plan/entitlement 无效、缺少 `chat` 或缺少 `goldencode`。

审计失败只阻止该 Phone identity 启用，不得修改或停用其现有旧 Key。

### 阶段 C：additive R760 部署

1. 从干净 release 构建候选并通过完整本地/候选环境验证。
2. 建立一致的 R760 SQLite/config/image 回滚边界。
3. 部署 migration 25 和新代码，保持两个功能开关关闭。
4. 验证 R760 health、单 `goldencode` 模型面及既有 chat/tools/Research/image/Vision。
5. 使用正式 beta.38 安装包完成无 Header 兼容回归。

### 阶段 D：预登记和开启 Gateway

1. 只为审计为 ready 的既有 Subject调用预登记接口。
2. 对每一条记录保存脱敏结果和 request ID。
3. 配置 `transition + auth_only`，只 recreate Gateway；不改 Nginx、DNS、Research 路由或其他服务。
4. 验证 health 明确返回 `transition/auth_only`。
5. 再次执行 beta.38 全路径 smoke，确认没有 426。
6. 执行 beta.40 Phone Session smoke 和 logout/key 不变量检查。

### 阶段 E：Desktop 候选和灰度

1. Gateway 验证完成后，Desktop 才启用普通用户可见的手机号入口。
2. 从包含双轨状态机的正式 Desktop 集成分支构建候选，不从临时功能分支直接发布。
3. 完成第 12.4 节两条安装包级 R760 E2E。
4. 先向少量已确认用户灰度，再扩展到预登记名单。
5. 观察登录成功、429/5xx、Subject mismatch、Phone identity disabled、fallback 和 logout suppression。
6. 不以手机号登录率或关联完成率作为撤销旧 Key 的条件。

## 15. 回滚

### 15.1 配置回滚

手机号路径异常但 legacy 路径正常时：

```text
GATEWAY_PHONE_AUTH_MODE=disabled
GATEWAY_DESKTOP_VERSION_GATE=disabled
```

只 recreate Gateway 并验证：

- beta.38 resolver 和业务路径继续工作；
- beta.40 已有旧 Key 的 legacy fallback 继续工作；
- Phone 登录/refresh/bootstrap 不再可用；
- 现有 `cgu_live_*` revoked/expiry 未变化；
- migration 25、Phone identity、Session 和审计记录保留，不恢复旧数据库。

### 15.2 二进制回滚

如果新代码本身影响 legacy 请求：

1. 停止客户端灰度；
2. 使用发布窗口前已验证的 R760 previous image/release；
3. 保持当前 SQLite，除非出现经验证的不可恢复数据库损坏；additive migration 不要求数据库倒退；
4. 恢复关闭配置；
5. 先验证 beta.38，再恢复业务流量；
6. 保留失败请求、审计和新数据库行用于前向修复，不通过删除事件伪造回滚。

### 15.3 不允许的回滚动作

- 不批量 revoke 旧 Key；
- 不删除 Phone identity、Session 或审计表；
- 不用旧 SQLite 覆盖包含新业务用量的当前数据库；
- 不把用户引导到第二 Gateway Origin；
- 不修改 R760 Nginx/DNS、Research Worker 或 provider pool 来处理本功能问题。

## 16. Definition of Done

只有全部满足时，本实现才可以从 `not_implemented` 更新为 `ready_for_desktop_release`：

- [ ] 第 11 节代码改造全部完成；
- [ ] 新双轨 contract/fixtures/SHA256SUMS 已提交，Gateway 与 Desktop 签收同一完整 commit；
- [ ] `npm run build`、`npm test`、`git diff --check` 和 secret scan 通过；
- [ ] migration 25 在旧数据库副本上幂等，功能关闭时 legacy 行为不变；
- [ ] beta.38 无 Header 全业务自动化与真实安装包回归通过；
- [ ] beta.40 双轨、Subject mismatch、refresh replay、logout suppression 和新设备场景通过；
- [ ] 登录前后 Subject/Plan/entitlement/capability/既有用量不变量通过；
- [ ] phone/IP/device 三维限流和脱敏审计通过；
- [ ] R760 additive 部署具备一致数据库、配置、image 和 previous release 回滚边界；
- [ ] `transition + auth_only` 的 R760 health 与两条真实 E2E 通过；
- [ ] 所有临时测试 Session、Key、entitlement、用户和文件完成清理；
- [ ] `docs/operations/system-status.md` 和手机号运维说明按真实状态更新；
- [ ] 在上述证据完成前，没有向普通用户发布 beta.40 手机号入口。

完成上述条件只表示双轨手机号登录可以发布，不表示短信、注册、钱包或支付已经完成。

## 17. 实施交付顺序

建议按以下 PR/commit 边界交付，便于审查和回滚：

1. `contract`: 本规范、新双轨 fixtures、错误分类和运维文档更新；
2. `gateway-policy`: `auth_only` gate、startup validation、health；
3. `gateway-auth`: `phone_login_disabled`、device limiter、审计与不变量测试；
4. `compat-tests`: beta.38 无 Header 全路径回归和状态快照测试；
5. `release`: 干净候选、R760 additive 部署、预登记、开关启用和 smoke 证据；
6. `desktop-integration`: beta.40 安装包联合 E2E 及最终签收。

每个边界都必须保持旧 Key 路径可用；不得把“后续 PR 会修复”作为合并一个会切断 beta.38 的中间状态的理由。
