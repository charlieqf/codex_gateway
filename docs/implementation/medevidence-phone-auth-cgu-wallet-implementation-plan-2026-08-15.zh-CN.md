# MedEvidence 手机号认证、`cgu_live_*` 核心与永久 Token 钱包 Gateway 实施方案

| 项目 | 内容 |
| --- | --- |
| 状态 | 方案已形成；尚未实施、测试或部署 |
| 建立日期 | 2026-08-15 |
| 适用仓库 | `C:\work\code\codex-gateway` |
| 运行权威 | R760 `https://goldencode.instmarket.com.au:1443` |
| T：内部过渡期 | 管理员预先准备完整内部账户；已注册内部手机号直接登录；JWT、`cgu_live_*`、现有内部 Plan；不依赖短信、钱包或支付 |
| F：公开免费期 | 真实短信验证、自动开户注册、免费永久 Token、免费图片次数、最低客户端版本 |
| P：后续付费期 | 月付/年付购买、支付专用 JWT、订单入账、付费 Doctor Research |
| 核心原则 | 一个规范化手机号对应一个 Gateway Subject 和一个当前有效的 `cgu_live_*`；JWT 负责登录会话，`cgu_live_*` 继续承载底层运行授权 |

本文把 2026-08-15 已确认的产品决定映射为可实施的 Gateway 方案。本文是代码、联调、迁移和发布的共同基线，不代表相关功能已经完成，也不授权直接修改或关闭生产环境。

Azure Gateway 将按单独的退役门禁关闭。新功能只在 R760 实现，不建设 Azure/R760 双写钱包，也不保留 `https://gw.instmarket.com.au` 作为旧客户端兼容入口。用户必须安装满足最低版本要求的新客户端。

相关讨论稿 [`medevidence-desktop-phone-jwt-login-gateway-contract-discussion-2026-08-15.zh-CN.md`](../inbox/medevidence-desktop-phone-jwt-login-gateway-contract-discussion-2026-08-15.zh-CN.md) 早于本文最终决策，其中“JWT 由收费/身份团队签发”“本阶段不做永久余额”“不把 `cgu_live_*` 返回给受信任客户端进程”等内容已被本文替代；其余关于密钥隔离、幂等开户注册和错误稳定性的原则继续有效。

## 1. 目标与非目标

### 1.1 T：内部过渡期必须交付的结果

在阿里云短信和支付均未就绪时，最新版 MedEvidence Desktop 仍可让受控内部用户完成以下闭环：

1. 管理员后台调用 Gateway 受保护 API，按手机号把内部账户、Subject、binding、credential、当前 `cgu_live_*` 和内部 Plan 一次性准备完整；
2. 用户只输入已注册的中国大陆手机号；
3. Gateway 在 `transition` 模式下直接把该内部手机号视为身份验证通过并签发 Session；
4. 客户端凭 Access JWT 取得当前 `cgu_live_*`，只放入受信任进程内存；
5. 客户端继续复用现有 resolver 和底层 Gateway/MedEvidence 凭据链；
6. 内部用户使用现有内部 Plan/额度，不进入消费钱包，也不领取免费注册赠送；
7. Windows/macOS 安装包在真实 R760 完成对话和图片联调。

该模式是明确接受风险的内部过渡能力，不是短信验证。因为只有管理员维护的内部用户，产品决定不为过渡期引入额外凭据轮换或复杂风控状态机。

### 1.2 F：公开免费期必须交付的结果

1. 同一个 `login/start` 在 `sms` 模式发送阿里云验证码；
2. 验证成功的已注册手机号关联原 Subject，未知手机号自动创建完整免费账户；
3. Gateway 签发 Access JWT 和可轮换的 Refresh Token；
4. bootstrap 幂等保证 Subject、v2 binding、backing credential、当前 `cgu_live_*`、免费 Token 和图片次数全部就绪；
5. 普通消费用户获得永久 50 万 Token、50 万 active cap 和 3 次图片；
6. 普通聊天和工具调用从永久 Token 钱包扣费，图片使用独立次数；
7. 免费用户不获得 Doctor Research；
8. 至少一个受支持图片 Provider 通过真实 E2E 即可开放图片；其他图片 Provider 未就绪不阻塞聊天或免费期上线。

公开免费期上线不等待支付系统，但必须等待短信、永久钱包、图片账本和安装包 E2E 全部通过。

### 1.3 T/F 阶段明确不做

- 不接支付页面、订单 webhook 或扫码支付结果；
- 不实现退款、拒付或部分退款；
- 不允许月付与年付在有效期内互换；
- 不向免费用户开放 Doctor Research；
- 不提供手机号自助或后台日常换绑功能；
- 不让 JWT 直接替代模型 API 的底层 Gateway credential；
- 不让 Desktop 持有 Billing Admin Token；
- 不在 Azure 实现认证或钱包功能；
- 不保留旧 Gateway 域名兼容入口；
- 不把旧周期 Token window 余额换算成永久余额。

### 1.4 P：后续支付阶段目标

支付团队接口就绪后，再交付：

- 月付、年付的 `grant_tokens` 与 `active_balance_cap`；
- 支付订单幂等入账与付费身份激活；
- 同套餐续费；
- 5 分钟、`aud=payment` 的支付专用 JWT；
- 付费 Doctor Research 的整次任务预占与统一结算。

## 2. 已冻结的产品规则

### 2.1 登录模式与阶段门禁

- Gateway 配置只有 `disabled`、`transition`、`sms` 三种登录模式；
- `transition` 只接受管理员后台已经准备完整并显式标记为内部的手机号；未注册手机号返回 `phone_not_registered`，不得自动创建；
- `sms` 对账户状态保持不可枚举的发送响应；真实验证码通过后，未知手机号允许自动创建免费账户；
- T 阶段直接使用 R760 正式 Origin，不另建远程测试权威；本地和 CI 可使用 fake SMS provider；
- fake SMS、固定验证码和万能验证码不得在 R760 公网运行；
- T 阶段结束不设固定日期，以阿里云资源、真实短信、JWT/refresh/bootstrap 及 Windows/macOS 安装包 E2E 全部通过为准；
- 支付系统不是从 `transition` 切换到 `sms` 的门禁；
- 不增加通用 `service_availability` 合同；可选能力未就绪时按各自 capability/route 降级，核心聊天保持可用。

### 2.2 身份与 Key

- 首版只支持中国大陆 `+86` 手机号；
- 手机号统一规范化为 E.164，例如 `13800138000` 归一为 `+8613800138000`；
- 一个规范化手机号只允许绑定一个 Subject；
- 一个 Subject 只允许存在一个“当前”`cgu_live_*`；
- Key 轮换会产生新 Key 并撤销旧 Key，但 Subject、钱包、权益和历史不变；
- `cgu_live_*` 与免费、月付、年付的有效期解耦，不因身份到期而失效；
- JWT 的 `sub` 使用不可变 Subject ID，不使用手机号或 `cgu_live_*`；
- 客户端持久化 JWT/Refresh Token，不持久化 `cgu_live_*`；
- 客户端每次启动后凭 JWT 取得当前 `cgu_live_*`，仅在受信任 Main/Sidecar 进程内存中使用。

### 2.3 会话

- Access JWT 有效期 15 分钟；
- Refresh Session 连续 30 天未使用即失效；
- 会话绝对最长有效期 180 天；
- 每次刷新必须轮换 Refresh Token，旧 Token 立即失效；
- 同一手机号允许多设备同时登录，每台设备拥有独立 Session；
- 普通退出只撤销当前 Session；
- Gateway 管理能力可撤销 Subject 的全部 Session。
- 普通 Access JWT 刷新不强制重新 bootstrap；只有客户端冷启动、内存无 Key、切换账户或 Key 已轮换/撤销时重新 bootstrap。

### 2.4 免费权益

- `signup_grant_tokens = 500000`；
- `active_balance_cap = 500000`；
- `signup_image_credits = 3`；
- Token 与图片次数均永久有效、只发一次、不按日/月/年补发；
- 免费能力包含 `chat`、`tools`、`image_generation`；
- 免费能力不包含 `doctor_research`；
- 每次图片请求最多生成一张图；
- 普通历史真实用户首次完成新登录迁移时同样获得上述免费权益；
- 明确标记的员工、测试、系统账号保留内部方案，不进入商业钱包。

### 2.5 Token 消费

- 一 Token 对应一实际 Token；
- 扣减口径为 `prompt_tokens + completion_tokens`；
- 不按模型、输入/输出或价格做倍率换算；
- 普通聊天和工具循环中的每次模型请求都计费；
- 免费版不允许创建 Doctor Research，因此 F 阶段不发生 Research 钱包扣费；
- 图片生成不扣 Token，使用独立图片次数；
- 请求前预占，完成后按实际用量结算并释放差额；
- 未调用上游的失败不扣 Token；
- 上游返回可靠 `usage` 时，即使客户端断开或最终响应失败，仍按实际用量扣费；
- 上游未返回可靠 `usage` 时释放预占、不扣 Token，并记录异常审计。

### 2.6 付费规则预留

- 每个付费 Plan 分别保存 `grant_tokens` 和 `active_balance_cap`；
- 两个字段允许初始值相同，但语义不能合并；
- 每个成功订单只发放一次 `grant_tokens`，以外部订单 ID 幂等；
- 同套餐续费从 `max(now, current_period_end)` 起顺延；
- Token 永久余额累加，身份上限不累加；
- 付费身份到期后余额保留，自动回落到免费身份上限；
- 付费身份有效期内只允许续购当前套餐，暂不允许月付/年付互换；
- 第一版支付功能不支持退款。

## 3. 当前实现基线与缺口

| 领域 | 当前能力 | 与目标的差距 |
| --- | --- | --- |
| Subject 与外部身份 | `subjects` 支持名称、手机号和 `(external_provider, external_user_id)` 唯一索引 | `phone_number` 不是权威身份，也没有规范化唯一约束 |
| 自动开户注册 | Billing Admin `/subjects` 已能创建 Subject、Gateway credential、MedEvidence v2 binding 和 `cgu_live_*` | 只能由服务端 Billing Admin 调用；没有短信验证后的公开幂等编排 |
| `cgu_live_*` | `/gateway/unified-keys/resolve` 能解密并返回底层 Gateway/MedEvidence 凭据 | 当前完整 `cgu_live_*` 只显示一次，数据库只存 hash/prefix，登录后无法重新取回完整 Key |
| Key 生命周期 | 统一 Key 和 backing Gateway credential 均有强制过期时间 | 与“逻辑 Key 持续有效”冲突；需要 nullable expiry 或透明轮换 |
| Plan/Entitlement | 已支持 Plan、Entitlement、周期快照和 capability | 只有 `monthly/one_off/unlimited`；没有 baseline free profile、永久钱包策略和 `yearly` |
| Token 限制 | 已支持 minute/day/month window、请求预占和实际结算 | Window 会重置，不能表示永久可累加余额和动态身份上限 |
| 图片权限 | feature policy 已支持 `image_generation` 和 provider fallback | 没有用户级永久图片次数及预占/结算 |
| Doctor Research | 已支持独立 capability 和运行限制 | 尚无整次任务钱包预占；F 阶段通过免费 Plan capability 禁止 |
| 登录 | 无 Gateway 用户 SMS/JWT 登录实现 | 需新增短信、会话、JWT、刷新、撤销与风控模块 |
| 账户查询 | `/gateway/credentials/current` 返回 credential、Plan、Entitlement 和窗口用量 | 不返回永久余额、冻结额度、钱包预占或图片次数 |

当前可直接复用的关键入口：

- `apps/gateway/src/index.ts` 中 `/gateway/unified-keys/resolve`；
- `apps/gateway/src/index.ts` 中 `/gateway/credentials/current`；
- `apps/gateway/src/services/token-budget-hook.ts` 中请求预占与结算生命周期；
- `packages/store-sqlite/src/billing-subjects.ts` 中幂等开户注册和 Key 轮换；
- `packages/store-sqlite/src/token-budget.ts` 中 SQLite 原子预占模式；
- Billing Admin entitlement event、审计和管理 CLI。

## 4. 目标架构

```text
Admin Backend -- protected API --> complete internal account
                                      |
MedEvidence Desktop                    v
  |                             phone identity -> Subject
  | POST login/start                   |
  v                                    +-> Auth Session
R760 Gateway Auth                      +-> current cgu_live_*
  |                                    +-> internal Plan (T)
  |-- transition: registered internal phone -> JWT
  |-- sms: challenge -> login/verify -> JWT
  |
  | POST session/bootstrap
  +------------------------------> Desktop trusted memory: cgu_live_*
                                           |
                                           | existing resolve
                                           v
                              Gateway + MedEvidence credentials
                                           |
                               +-----------+------------+
                               |                        |
                               v                        v
                       chat/tools admission       image admission
                               |                        |
                               v                        v
                       permanent wallet (F/P)     image ledger (F/P)
```

### 4.1 不可破坏的系统不变量

1. R760 是手机号、Subject、Key、会话、钱包、Plan、Entitlement 和用量的唯一权威；
2. 同一手机号并发管理员注册或短信验证不能创建多个 Subject；
3. 同一 Subject 同时只能有一个当前 `cgu_live_*`；
4. 消费用户注册 Token 和图片赠送必须各自只落账一次；内部过渡用户不得获得这两项消费赠送；
5. 钱包余额只能由不可变 ledger event 推导，不能通过业务 API 直接覆盖；
6. 业务请求必须先成功预占，才允许调用上游；
7. JWT、验证码、完整手机号、完整 `cgu_live_*`、底层 API key 不得进入普通日志、错误、URL、诊断包或审计参数；
8. Plan 的商业策略必须版本化并不可变；修改额度通过新 Plan ID 完成；
9. 内部账号豁免必须显式标记，不能依靠“缺少钱包记录”隐式放行；
10. 配置存在但非法时启动失败，不能静默退回关闭认证或关闭扣费。

## 5. T/F 阶段请求流程

### 5.1 管理员准备内部过渡账户

管理员后台只调用 Gateway 受保护 API，不持有或展示完整 `cgu_live_*`。一次幂等注册必须把内部账户准备完整：

```text
admin_requested
  -> phone_identity_reserved
  -> subject_linked_or_created
  -> upstream_v2_binding_ready
  -> backing_gateway_credential_ready
  -> current_cgu_ready
  -> internal_plan_ready
  -> transition_login_enabled
  -> completed
```

重复请求返回同一账户结果；多个历史 Subject 候选时阻断，不自动合并。该流程不创建消费钱包赠送事件。第一版管理员 API 不提供删除、手机号修改或自动合并。

### 5.2 `login/start` 双模式入口

共同步骤：校验最低客户端版本、严格请求字段、规范化 `+86` 手机号，并应用手机号/IP 限流。

`transition` 模式：

1. 只查找管理员已经准备完整且显式标记为内部的 phone identity；
2. 未找到时返回 `403 phone_not_registered`，不得新建账户；
3. 找到后直接创建独立 Session，记录 `auth_method=transition_phone_only`；
4. 返回 Access JWT 和 opaque Refresh Token。

`sms` 模式：

1. 使用手机号 HMAC 和 IP HMAC 检查发送限额；
2. 生成 6 位验证码和 challenge ID；
3. 只保存验证码 HMAC、过期时间和尝试次数，不保存明文；
4. 调用阿里云短信 adapter；
5. 返回 `status=verification_required`，不暴露手机号是否已有账户。

短信默认规则：验证码 5 分钟有效、60 秒后可重发、最多验证 5 次；同手机号每小时最多 5 条/每天 10 条，同 IP 每小时最多 20 条/每天 100 条。所有值可配置，非法值必须启动失败。

### 5.3 `login/verify` 与可重试 provisioning 边界

验证码成功后，Gateway 在本地事务中消费 challenge、保留 phone identity、创建或关联 Subject、创建 Session，并返回 JWT。唯一匹配复用原 Subject；无匹配创建新 Subject；多个候选返回冲突。

完整 v2/runtime/free provisioning 不阻塞 JWT 返回，而由 bootstrap 的幂等状态机完成。这样 provisioning 暂时失败时，客户端保留登录态并重试 bootstrap，不需要重新发送验证码。

### 5.4 bootstrap 与当前 `cgu_live_*`

受信任 Desktop 进程使用 Access JWT 调用 session bootstrap。Gateway：

1. 验证签名、`iss`、`aud`、`exp`、`nbf`、`sid` 和 Session 状态；
2. 读取 `sub` 对应 Subject；
3. 对已完整准备的内部过渡账户直接继续；
4. 对公开消费账户幂等完成 v2 binding、backing credential、当前 `cgu_live_*`、免费 Plan、50 万 Token 和 3 次图片；
5. 外部 MedEvidence v2 provisioning 使用稳定 idempotency key 和可恢复状态机，不能伪装为单 SQLite 事务；
6. 检查 Subject 有且只有一个当前 `cgu_live_*`，解密并返回完整 Key；
7. 设置 `Cache-Control: no-store`、`Pragma: no-cache`；只审计 Subject ID、Session ID、Key prefix 和结果。

Desktop 随后调用现有 `/gateway/unified-keys/resolve` 获取 Gateway/MedEvidence runtime bundle。模型 API 不增加 JWT 鉴权分支，也不让 bootstrap 绕过 `cgu_live_*` 直接返回两套底层 Key。

### 5.5 刷新、退出和多设备

- Refresh Token 使用高熵 opaque token，不使用长生命周期 JWT；
- 数据库只保存 token hash、prefix、family/generation 和有效期；
- 刷新在事务中撤销旧 Token、签发新 Token 并更新 Session；
- 已使用 Refresh Token 再次出现时视为 replay，撤销该 Session family；
- 退出当前设备撤销当前 Session；
- 管理端“撤销全部会话”按 Subject 批量撤销；
- 退出不撤销 `cgu_live_*`，客户端负责立即清空内存中的 Key 和 runtime credentials。
- Access JWT 普通刷新不要求重新 bootstrap；客户端冷启动、内存无 Key、切换账户或运行凭据失效时，refresh（如需要）后只执行一次 bootstrap/resolve 恢复，禁止无限重试。

### 5.6 客户端就绪门禁

进入主界面前，Desktop 必须完成 bootstrap 和 resolver，再分别调用：

- `/gateway/credentials/current`：使用底层 Gateway credential，确认运行 credential 和风控窗口有效；
- `/gateway/account/v1/current`：使用 Access JWT，确认 Subject、商业身份、永久余额/内部模式、图片次数和 capability。

两者均成功且账户允许 `chat` 后才进入主界面。客户端不得把旧 `token_usage.month.remaining` 当作永久余额。

### 5.7 普通聊天和工具扣费

底层 Gateway credential 已绑定 Subject，因此无需改变客户端请求鉴权。`beginTokenBudget` 在现有 minute/day/month 风控检查之外增加永久钱包检查；`finalizeTokenBudget` 同时完成窗口统计和钱包 ledger debit。

必须在同一个 SQLite 写事务中完成：

1. 解析当前商业身份及 cap；
2. 读取钱包余额；
3. 汇总该 Subject 活跃钱包预占；
4. 检查可预占额度；
5. 插入 reservation；
6. 提交后才允许上游请求开始。

内部过渡账户继续使用现有内部 Plan，不进入本节永久钱包扣费。F/P 消费账户使用下述钱包事务。

### 5.8 图片次数扣减

图片 route 在选 provider 前预占一次图片额度：

- `n` 必须为 1 或被 Gateway 固定为 1；
- provider fallback 的多个上游尝试合计只对应一次用户额度；
- 任何 provider 最终生成有效图片即扣一次；
- 全部失败且没有生成图片时释放预占；
- 客户端断开但服务端已经成功生成图片时仍扣一次；
- 图片次数与 Token 余额相互独立。
- 公开免费期只要求至少一个受支持图片 Provider 通过真实 E2E；其他 Provider 未就绪不阻塞图片能力或聊天。

## 6. v1 API 契约

Desktop-facing 路径和字段按本文进入双方 contract fixture，并在 M0、任何代码 PR 合并前冻结为 `v1`。示例中的 Token 和 Key 全部是占位符，不得替换成真实值提交。

### 6.1 `POST /gateway/auth/v1/login/start`

请求：

```json
{
  "phone": "13800138000",
  "client": "medevidence-desktop",
  "device_id": "opaque-client-generated-id",
  "contract_version": 1
}
```

`transition` 模式的成功响应：

```json
{
  "status": "authenticated",
  "auth_method": "transition_phone_only",
  "token_type": "Bearer",
  "access_token": "<access-jwt>",
  "expires_in_seconds": 900,
  "refresh_token": "<opaque-refresh-token>",
  "refresh_idle_expires_in_seconds": 2592000,
  "session_absolute_expires_at": "2027-02-11T00:00:00.000Z",
  "subject": {
    "id": "subj_example",
    "state": "active"
  }
}
```

`sms` 模式的成功响应：

```json
{
  "status": "verification_required",
  "auth_method": "sms",
  "challenge_id": "smsc_example",
  "expires_in_seconds": 300,
  "retry_after_seconds": 60
}
```

`transition` 模式只允许管理员已准备的内部手机号，未知手机号返回 `phone_not_registered`。`sms` 模式无论手机号是否已有账户都返回相同 challenge 结构。

### 6.2 `POST /gateway/auth/v1/login/verify`

请求：

```json
{
  "challenge_id": "smsc_example",
  "code": "123456",
  "client": "medevidence-desktop",
  "device_id": "opaque-client-generated-id",
  "contract_version": 1
}
```

成功响应：

```json
{
  "status": "authenticated",
  "auth_method": "sms",
  "token_type": "Bearer",
  "access_token": "<access-jwt>",
  "expires_in_seconds": 900,
  "refresh_token": "<opaque-refresh-token>",
  "refresh_idle_expires_in_seconds": 2592000,
  "session_absolute_expires_at": "2027-02-11T00:00:00.000Z",
  "subject": {
    "id": "subj_example",
    "state": "active"
  }
}
```

同一 Desktop 版本只根据 `status` 决定直接 bootstrap，还是显示验证码输入框；从 `transition` 切换到 `sms` 不要求为登录流程再发布另一套客户端实现。

### 6.3 `POST /gateway/auth/v1/token/refresh`

请求正文包含 `refresh_token`、`client`、`device_id` 和 `contract_version`。成功响应复用 6.1 的 `status=authenticated` Session 结构，`auth_method` 保持该 Session 原始登录方式，并返回新的 Access JWT 和新的 Refresh Token；旧 Refresh Token 从事务提交后立即不可用。

### 6.4 `POST /gateway/auth/v1/logout`

使用 Access JWT 撤销当前 `sid`。重复调用幂等成功。客户端无论服务端响应如何都应清除本地 Session 和内存运行凭据。

### 6.5 `POST /gateway/auth/v1/session/bootstrap`

请求头：

```http
Authorization: Bearer <access-jwt>
X-MedEvidence-Client-Version: <semver>
```

成功响应：

```json
{
  "contract_version": 1,
  "subject": {
    "id": "subj_example",
    "state": "active"
  },
  "unified_key": {
    "key": "<runtime-only-cgu-live-key>",
    "key_prefix": "cgu_live_example",
    "expires_at": null
  },
  "resolver_url": "https://goldencode.instmarket.com.au:1443/gateway/unified-keys/resolve",
  "account_url": "https://goldencode.instmarket.com.au:1443/gateway/account/v1/current"
}
```

### 6.6 `GET /gateway/account/v1/current`

该接口使用 Access JWT，不使用底层 Gateway API key。建议响应：

```json
{
  "subject": {
    "id": "subj_example",
    "state": "active"
  },
  "identity": {
    "kind": "free",
    "plan_id": "plan_consumer_free_v1",
    "period_end": null
  },
  "token_wallet": {
    "permanent_balance": 500000,
    "active_balance_cap": 500000,
    "reserved": 0,
    "available": 500000,
    "frozen": 0
  },
  "image_credits": {
    "balance": 3,
    "reserved": 0,
    "available": 3
  },
  "capabilities": ["chat", "tools", "image_generation"]
}
```

`/gateway/credentials/current` 继续返回底层 credential、Plan/Entitlement 和风控窗口。客户端需要同时使用 account current 与 credential current，不能把旧 `token_usage.month.remaining` 当永久余额。

T 阶段内部账户沿用同一响应 envelope：`identity.kind=internal`，`plan_id` 为其显式内部 Plan，`token_wallet` 和独立 `image_credits` 为 `null`，capabilities 由内部 Plan 实时返回。内部运行额度继续以 `/gateway/credentials/current` 为准，不能因为钱包字段为空而隐式放行。

### 6.7 受保护的管理员开户注册 API

管理员后台调用 Gateway 受保护 API；Desktop 不调用。建议首版提供：

- `POST /gateway/admin/phone-auth/v1/accounts`：以 `Idempotency-Key` 幂等准备完整内部账户；
- `POST /gateway/admin/phone-auth/v1/accounts/lookup`：在请求正文中按手机号查询，避免手机号出现在 URL；
- `POST /gateway/admin/phone-auth/v1/accounts/:identity_id/enable`；
- `POST /gateway/admin/phone-auth/v1/accounts/:identity_id/disable`。

注册请求至少包含手机号、内部 profile/Plan 和非敏感操作备注。响应只返回 identity ID、Subject ID、脱敏手机号、Plan、状态及 `cgu_live_*` safe prefix，不返回完整 unified/backing key。第一版不提供删除、换绑或自动合并 API。

### 6.8 错误码

| HTTP | code | 语义 |
| --- | --- | --- |
| 400 | `invalid_request` | 字段、contract version 或手机号格式错误 |
| 401 | `sms_code_invalid` | 验证码错误；响应不泄露账户状态 |
| 401 | `sms_code_expired` | challenge 已过期 |
| 401 | `access_token_invalid` | Access JWT 无效 |
| 401 | `access_token_expired` | Access JWT 到期，可尝试 refresh |
| 401 | `refresh_token_invalid` | Refresh Token 无效、过期或已轮换 |
| 403 | `phone_not_registered` | `transition` 模式下手机号未由管理员准备；不得自动创建 |
| 403 | `account_disabled` | Subject 已停用 |
| 403 | `capability_not_allowed` | 当前身份不允许目标功能 |
| 409 | `phone_identity_conflict` | 历史数据存在多个候选，禁止自动合并 |
| 409 | `account_migration_required` | 当前 `cgu_live_*` 尚未完成可恢复迁移 |
| 426 | `client_upgrade_required` | 客户端版本低于强制最低版本 |
| 429 | `sms_rate_limited` | 短信发送或验证触发限制 |
| 429 | `token_balance_insufficient` | 永久余额不足以完成预占；允许展示购买入口 |
| 429 | `active_balance_cap_exceeded` | 余额足够但当前身份 cap/活跃预占不足；不能误导购买 |
| 503 | `account_provisioning_unavailable` | 短信依赖、开户或 v2 provisioning 暂时失败，可按当前步骤幂等重试 |

现有 RPM、并发、请求大小和 provider 限流错误保持独立，不得折叠为余额不足。

## 7. 数据模型与 SQLite 迁移

所有迁移必须 additive-first：先允许旧字段/旧行存在，完成数据回填和校验后再启用应用层强约束。每次生产迁移前必须创建 SQLite online backup，并执行 `quick_check` 和 foreign-key 检查。

### 7.1 `auth_phone_identities`

建议字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 随机稳定身份 ID，不包含手机号 |
| `phone_hash` | `HMAC-SHA256(secret, e164)`；唯一索引和登录查询键 |
| `phone_ciphertext` | E.164 手机号加密值 |
| `phone_last4` | 仅用于受控后台掩码展示 |
| `subject_id` | 唯一关联 Subject；provisioning 初期可为空 |
| `state` | `provisioning/active/blocked` |
| `account_class` | `consumer/internal/test/system`；决定过渡登录和商业钱包规则 |
| `registration_method` | `admin/sms/migration`；不得把管理员直登记录伪装成短信验证 |
| `transition_login_enabled` | 只有管理员准备完整的内部账号可为 true |
| `sms_verified_at` | 真实短信首次验证时间；管理员注册时必须为空 |
| `created_at/updated_at` | 审计时间 |

`subjects.phone_number` 降级为历史/展示字段，不再用于登录唯一判断。T/F/P 均不提供修改 `auth_phone_identities` 的公开或日常管理接口；受保护管理员 API 首版也不提供换绑。

### 7.2 `auth_sms_challenges` 与 rate bucket

保存 challenge ID、phone hash、code HMAC、过期时间、失败次数、消费时间、发送状态和安全的 provider request reference。IP 只保存 HMAC 或截断后的风险键，不保存可直接还原的地址正文。

发送限额可以使用单独的 `auth_rate_buckets`，不得复用 Token window，以免认证风控与模型配额相互污染。

### 7.3 `auth_sessions` 与 `auth_refresh_tokens`

`auth_sessions` 保存 Subject、device hash、`auth_method=transition_phone_only|sms`、创建/最后使用/idle/absolute expiry、撤销原因和 token generation。`auth_refresh_tokens` 保存 hash、prefix、family、generation、issued/used/revoked 时间，用于轮换和 replay 检测。

Refresh Token 原文只在签发响应中出现一次。数据库、日志、审计和管理查询只显示安全 prefix。

### 7.4 `phone_registration_events`

以 `phone_identity_id + registration_version` 唯一，保存注册来源和 provisioning saga 当前步骤、Subject、v2 binding、backing credential、当前 unified key、内部 Plan 或消费 Token/image grant event。管理员内部注册必须完成全部 runtime/Plan 步骤后才返回成功；短信注册允许先返回 Session，再由 bootstrap 从持久化步骤恢复。它是跨 Gateway SQLite 与 MedEvidence v2 调用的恢复依据。

### 7.5 `unified_client_keys` 改造

当前表只保存 Key hash/prefix，无法满足登录后自动返回完整 `cgu_live_*`。需要新增：

- `token_ciphertext`：完整 `cgu_live_*` 的 envelope encryption；
- `encryption_key_id`：支持密钥轮换；
- `is_current` 或等价状态字段；
- `expires_at` 改为 nullable；
- Subject 当前 Key 的部分唯一索引。

新增真实用户 Key 时必须同时保存 hash 和密文。完整 Key 仍不得通过管理列表、日志或审计返回。

历史 Key 迁移规则：

1. 若受控 handoff 中仍有完整 Key，必须先验证 hash、prefix、Subject 和 resolver 结果一致，再加密写入；
2. 若完整 Key 无法恢复，则在发布前受控轮换为新 Key，保留 Subject、v2 binding、钱包和历史，撤销旧 Key；
3. 不允许在普通登录请求中根据 prefix 猜测或重建 Key；
4. F 发布迁移结束后，每个消费用户必须恰好有一个 `is_current=1` 且 `token_ciphertext` 可解密的 Key；T 发布前只要求所有启用过渡登录的内部账户满足该条件；
5. 因为产品要求强制最新版客户端，本次受控迁移允许必要的历史 Key 轮换，不建设旧客户端兼容链。

backing Gateway credential 和 MedEvidence v2 key 也不能继续与付费周期绑定。若底层存储仍要求有效期，应实现到期前透明轮换并原子更新 unified record；不能让用户重新登录来修复正常到期。

### 7.6 永久 Token 账本

建议新增：

#### `token_wallet_balances`

- `subject_id` 主键；
- `balance_tokens`；
- `version`；
- `updated_at`。

余额是 ledger 的物化结果，必须能从 ledger 重建并核对。

#### `token_wallet_events`

- `id`；
- `subject_id`；
- `event_id`，Subject 内唯一；
- `event_type`：F 阶段至少 `signup_grant`、`usage_debit`、`admin_adjustment`；
- `delta_tokens`，赠送为正、消费为负；
- `request_id/reservation_id/external_order_id` 等可空关联；
- `created_at`；
- 经过 schema 限制的非敏感 metadata。

为未来退款预留 `reversal` 类型不会使 T/F 阶段暴露退款接口。

#### reservation

优先扩展现有 `token_reservations`，增加钱包计费模式、cap snapshot 和钱包结算 event reference，而不是建立第二套与请求生命周期竞争的 reservation。风控窗口检查与钱包检查必须由同一个 SQLite coordinator 在一个写事务中完成。

### 7.7 图片次数账本

新增 `image_credit_balances`、`image_credit_events` 和 `image_credit_reservations`。事件以 Subject + event ID 幂等；`signup_image_grant:<registration_id>` 和 `image_usage:<request_id>` 均不得包含手机号。

### 7.8 商业 Plan 策略

在现有不可变 Plan 上增加版本化 `commercial_policy_json`，至少支持：

```json
{
  "billing_mode": "wallet",
  "signup_grant_tokens": 500000,
  "grant_tokens": 0,
  "active_balance_cap": 500000,
  "signup_image_credits": 3
}
```

建议 F 阶段创建 `plan_consumer_free_v1`，并新增 Subject baseline commercial profile：

- `free`：默认使用 free Plan；
- `paid`：存在 active paid entitlement 时覆盖 baseline；
- `internal_exempt`：显式绕过商业钱包，但保留请求风控和用量记录。

T 阶段管理员创建的内部账号必须使用显式 `internal_exempt`/内部 Plan 并具有可用额度；不得因为缺少钱包行而隐式放行，也不得触发 `signup_grant` 或 `signup_image_grant`。

付费 entitlement 到期后 resolver 自动回落 baseline free Plan，不创建新的 Token grant。

P 阶段需要把 `PeriodKind` 扩展为 `yearly`，同步修改类型、SQLite CHECK、Billing Admin 校验、续费算法、API 序列化和测试。不能把年付伪装成 `one_off`。

## 8. 永久钱包算法

### 8.1 可预占额度

```text
spendable_window = min(permanent_balance, active_balance_cap)
available_to_reserve = max(0, spendable_window - active_reserved_tokens)
frozen_tokens = max(0, permanent_balance - active_balance_cap)
```

算法示例（不是已确定的月付/年付套餐数值）：余额 120 万、身份上限 100 万时，冻结 20 万、可用窗口 100 万。消费 10 万后余额为 110 万，释放 reservation 后可用窗口再次回到 100 万；继续消费会逐步解冻，因此最终仍能用完整个 120 万。

身份上限不是“本周期累计最多消费多少”，而是任一时点可进入消费流程的余额窗口。

### 8.2 预占值

预占必须是该请求的安全上界：

- 已估算 prompt tokens；
- 客户端声明或 Gateway 强制的最大 completion tokens；
- 模型和单请求上限；
- 工具循环中的每个上游模型请求分别预占。

若生产中出现 `actual > reserved`，这是 admission invariant 违规，必须记录高优先级审计和指标，不能静默忽略实际用量。发布门禁应证明所有支持路径的实际用量不超过预占。

### 8.3 结算矩阵

| 场景 | 钱包行为 |
| --- | --- |
| Gateway 本地校验失败，未调用上游 | 释放预占，扣 0 |
| 上游成功并返回 usage | 扣实际 `prompt + completion`，释放差额 |
| 上游失败但返回可靠 usage | 扣实际用量，释放差额 |
| 客户端断开，上游仍返回可靠 usage | 扣实际用量 |
| 上游失败且没有可靠 usage | 释放全部预占，扣 0，记录异常 |
| reservation 超时且请求终态未知 | 不自动猜测收费；进入异常审计与人工核对 |

### 8.4 身份在请求中的变化

请求 admission 时保存 `active_balance_cap` 和身份快照。请求执行期间即使付费身份到期，该请求仍按入场快照完成；新请求立即使用免费 cap。钱包实际 debit 始终记入同一个 Subject 永久余额。

## 9. 认证与安全设计

### 9.1 JWT

Access JWT 采用 RS256 和版本化 `kid`，以便 Gateway 自验和未来支付服务通过 JWKS 验签。必填 claims：

- `iss`：`https://goldencode.instmarket.com.au:1443/gateway/auth/v1`；
- `aud`：`codex-gateway`；
- `sub`：Subject ID；
- `sid`：Session ID；
- `jti`；
- `iat`、`nbf`、`exp`。

Access JWT 固定 15 分钟，允许的时钟偏差不超过 60 秒。JWT 不包含手机号、`cgu_live_*`、Plan、余额或 capability；所有业务状态实时查询。Refresh Token 是高熵 opaque token，不是 JWT。

### 9.2 密钥与敏感数据

至少分离以下 secret：

- JWT private signing key；
- OTP HMAC secret；
- phone lookup HMAC secret；
- phone ciphertext encryption key；
- unified key recovery encryption key；
- 阿里云 RAM credential。

生产 secret 只通过 R760 root-owned `0600` secret file 或等价受控挂载提供。示例 env 只记录变量名，不放值。不得复用 JWT private key 进行 HMAC 或数据加密。

### 9.3 返回长期 `cgu_live_*` 的已接受边界

T/F 阶段为了复用现有客户端与 resolver，会把长期 `cgu_live_*` 返回给持有有效 Access JWT 的受信任 Desktop 进程。这意味着 Access JWT 在有效期内被窃取后，攻击者可能进一步取得长期 Key；15 分钟 Access TTL 不能消除这一风险。

T/F 阶段必须采用以下缓解：

- bootstrap 仅接受有效、未撤销 Session 的 Access JWT；
- 响应禁止缓存；
- Desktop Renderer 不可见，磁盘不保存；
- 日志和诊断红线扫描；
- Subject/credential 风控和钱包限制始终生效；
- 支持快速轮换当前 `cgu_live_*`；
- 后续可用短期 session credential 替代直接返回长期 Key，但不纳入 T/F 阶段。

`transition_phone_only` 不是强身份认证：知道已注册内部手机号的人可能取得该账户 Session 和长期 runtime bundle。产品明确接受该风险，原因是 T 阶段只有管理员维护的内部用户，并要求保持实现简单；本方案不增加结束过渡期时的强制 unified/backing credential 轮换。审计必须如实记录 `transition_phone_only`，不得写成 SMS 已验证。

### 9.4 最低客户端版本

新增可配置 `minimum_desktop_version` 和官方下载地址。Desktop 的 auth、bootstrap、account 及业务请求需要携带 `X-MedEvidence-Client-Version`。缺失、非法或低于最低版本时返回 HTTP 426 `client_upgrade_required`。

内部服务和明确标记的非 Desktop credential 通过显式 credential class 豁免，不能因缺少版本头被误伤；豁免列表不得靠 user-agent 猜测。

## 10. 代码组织建议

避免继续扩大 `apps/gateway/src/index.ts`，按领域拆分：

### `packages/core`

- `phone-auth.ts`：E.164、challenge/session 类型和校验；
- `token-wallet.ts`：ledger、balance、reservation、cap 计算接口；
- `image-credits.ts`：图片余额与 reservation 接口；
- `commercial-plan.ts`：baseline、wallet/internal 模式和商业策略；
- 扩展 unified key、credential、Plan/PeriodKind 类型。

### `packages/store-sqlite`

- `auth-phone-identities.ts`；
- `auth-sms-challenges.ts`；
- `auth-sessions.ts`；
- `phone-registration-events.ts`；
- `token-wallet.ts`；
- `image-credits.ts`；
- `usage-admission.ts`：统一风控窗口与钱包事务；
- migrations、row mappers、完整重建/一致性检查。

### `apps/gateway`

- `auth-routes.ts`；
- `admin-phone-auth-routes.ts`：受 Billing Admin 身份保护的内部账户准备、查询、启停；
- `account-routes.ts`；
- `services/aliyun-sms-provider.ts`；
- `services/jwt-session-service.ts`；
- `services/phone-registration-service.ts`；
- `services/session-bootstrap-service.ts`；
- `services/commercial-access-resolver.ts`；
- 扩展 chat/image admission hook、错误映射和审计。

### `apps/admin-cli`

- 手机身份脱敏盘点与冲突查询；
- 历史 `cgu_live_*` recoverability 检查和受控迁移；
- Session 列表、撤销当前/全部；
- 钱包和图片 ledger 查询；
- 幂等人工调整；
- wallet/ledger 重建一致性检查；
- 免费/内部 profile 迁移与验收报告。

### `scripts` 与配置

- 历史手机号和 Key 迁移 dry-run/apply 工具；
- R760 上线前预检；
- 最新客户端版本和 auth/wallet smoke；
- Azure 最终 usage merge 与退役门禁沿用现有受控脚本；
- 示例配置、runbook 和错误合同文档。

## 11. 实施里程碑与 PR 拆分

### M0：契约与基线

- 冻结 auth v1 路径、字段、错误码和 headers；
- 冻结 Plan ID、JWT issuer/audience、版本比较规则；
- 固定现有测试、SQLite schema、R760 只读数据盘点；
- 建立 secret/PII 日志扫描测试；
- 不改生产。

验收：接口 fixture 获 Desktop 团队确认；所有现有测试基线记录完整。

### M1：T 阶段最小 Schema 与 core domain

- 新增 phone identity、session 和 registration schema；
- 扩展 unified key recoverability 和 nullable expiry；
- 实现 T 阶段身份、Session 和 Key 所需的 core/store 原子事务；
- wallet 和 image schema 分别留到 M5、M6 的 additive migration，不作为 T 阶段前置；
- 不开放公网 route，所有 feature flag 默认关闭。

验收：迁移可在旧数据库副本上执行；旧 Gateway 行为不变；T 阶段相关唯一约束和恢复状态可验证。

### M2：历史身份、管理员 API 与 `cgu_live_*` 迁移

- 生成不含 PII 的 dry-run；
- 分类普通、内部、测试、系统 Subject；
- 对选定 T 阶段内部账户解决手机号重复、缺失和多当前 Key；其他消费账户冲突进入 F 阶段待办清单；
- 对选定内部账户的历史 Key 执行验证后加密导入或受控轮换；
- 实现受保护管理员开户注册、查询、启用和停用 API；
- 用管理员 API 把选定内部手机号、Subject、binding、credential、current cgu 和内部 Plan 准备完整；
- T 目标账户的 dry-run 二次执行必须为零变更。

验收：每个 T 目标内部用户恰好一个 phone identity、一个 Subject、一个可恢复 current `cgu_live_*`；重复管理员注册零重复行、零重复权益；未处理的消费账户不允许 transition 登录。

### M3：JWT、Session 与内部手机号直登过渡期

- 实现 `login/start` 的 `transition` 分支、JWT、refresh rotation、logout 和 bootstrap；
- 只接受 M2 管理员已准备完整的内部手机号；
- 未注册手机号稳定返回 `phone_not_registered`，不得创建账户；
- 实现 credentials current + account current 的客户端就绪门禁；
- 在 R760 正式 Origin 与最新版内部 Desktop 安装包完成真实联调；
- 不启用公开消费用户、短信发送或消费钱包。

验收：内部已注册手机号只输入手机号即可登录、refresh、bootstrap、resolve、查询状态并完成真实对话/图片；未知手机号拒绝；多设备、撤销、重放和秘密扫描全部通过。

### M4：SMS adapter 与公开开户注册

- 完成 `login/start` 的 `sms` 分支、`login/verify`、challenge、限流和 fake provider 自动测试；
- 验证成功后创建/关联 phone identity、Subject 和 Session，先返回 JWT；
- bootstrap 幂等完成公开账户 provisioning，并支持中断后重试且不重发验证码；
- 阿里云资源就绪后完成真实短信 smoke；
- 仍不开放公众，等待 M5/M6/M7。

验收：新用户、既有用户、并发首次登录、验证码错误/过期/重放、外部 provisioning 中断恢复及冲突用户全部符合合同；响应不泄露注册状态。

### M5：永久钱包与错误合同

- 新增永久 Token balance/event/reservation schema 和可重建 core；
- 将钱包检查并入 chat/tools admission；
- 实现注册赠送、cap、冻结、预占、实际结算和账户展示；
- 保留 minute/day/month 风控，但从商业余额 UI 中分离；
- 实现 `token_balance_insufficient` 与 `active_balance_cap_exceeded`。

验收：永久不清零、重复赠送阻断、并发不透支、任意“余额高于 cap”场景均可随消费逐步解冻、失败结算矩阵全部通过。

### M6：图片额度与免费 capability

- 新增图片 balance/event/reservation schema 和可重建 core；
- 创建 free Plan/profile；
- 开放 chat/tools/image，禁止 Research；
- 实现三次图片赠送和图片预占/结算；
- 验证 provider fallback 只扣一次；
- 至少一个受支持图片 Provider 通过 R760 真实 E2E，其他 Provider 不作为发布门禁。

验收：三次成功后第四次拒绝；失败返还；Research 在创建 run 前拒绝。

### M7：公开短信模式、客户端版本门禁与联合 E2E

- 关闭 F 目标普通用户的手机号冲突、缺失和历史 current Key recoverability 清单；
- 配置最低版本和下载地址；
- 把登录模式从 `transition` 切换到 `sms`，支付仍可未就绪；
- Desktop 安全存储 JWT、bootstrap 内存 Key、resolver、account UI 联调；
- Windows/macOS 安装包重启、刷新、退出、切换账号和升级门禁测试；
- 诊断包和日志 secret scan。

验收：真实新手机号和既有手机号均能短信登录；只有最新客户端能完成真实 R760 对话和图片生成，旧版本稳定返回 426；免费钱包和图片次数正确。

### M8：R760 分阶段发布

- 从已提交 commit 构建 R760 release；
- 创建 R760 数据库和配置备份；
- 运行 schema、完整性、权限、health 和业务 smoke；
- T 阶段可在 M3 后独立发布给内部用户；F 阶段必须等待 M4-M7 全部通过；
- 验证代表性内部、历史和新用户；
- 归档 R760 release、数据库备份和校验凭据。

验收：对应阶段的 R760 登录、账户、运行授权和业务闭环通过；不依赖旧域名或 Azure 回退。

### M9：Azure 独立退役门禁

- 冻结 Azure 写入；
- 执行最终 Azure -> R760 usage merge；
- 第二次 dry-run 必须零变更；
- 归档 Azure/R760 最终数据库与校验凭据；
- 再执行 Azure Gateway 关闭。

验收：R760 是唯一入口和唯一可写权威；Azure 退役证据完整。该门禁独立于 T/F 功能完成状态，不得因开发手机号登录而省略数据合并与归档。

## 12. 当前数据迁移基线

2026-08-15 对 R760 的脱敏只读盘点得到：

- 650 个 Subject，其中 115 个处于 active；
- 191 个 Subject 存在可规范化手机号；
- 49 个 active Subject 缺少手机号，其中包含内部/测试/系统账号；
- 规范化后有 6 组重复手机号；
- 1 个 Subject 同时存在多个当前仍有效的 `cgu_live_*`；
- 58 个 `manual_trial` Subject 中有 2 个缺少手机号。

这些是迁移规划快照，不是发布时固定数字。M2 必须重新运行同类盘点，且不能输出手机号、姓名、Subject ID、Key prefix 或其他身份明细到提交文档。

迁移分类：

| 类别 | 处理 |
| --- | --- |
| 普通真实用户 | 绑定原 Subject；首次 F 阶段 bootstrap 发 50 万 Token 和 3 次图片；不迁移旧周期余额 |
| 内部/员工/系统 | 显式 `internal_exempt`；保留内部能力和用量审计 |
| 唯一手机号匹配 | 自动迁移 |
| 多个手机号候选 | 阻断自动迁移，进入人工清单 |
| 无手机号历史真实用户 | 发布前补齐并验证；不得用假手机号 |
| 多个当前 Key | 确认正确 Key，迁移/轮换后只留一个 current |

## 13. 测试与验收矩阵

### 13.1 单元与 store 测试

- 手机号 E.164 正反例；
- phone HMAC 唯一性和 ciphertext round-trip；
- `disabled|transition|sms` 模式配置、启动校验和分支选择；
- 管理员完整开户注册的幂等性、冲突阻断和内部 Plan 显式性；
- 内部过渡账户不得创建消费钱包或注册赠送事件；
- 验证码 TTL、尝试次数、消费一次性；
- 手机号/IP 限流边界；
- JWT claim、签名、时钟偏差、kid rotation；
- Refresh rotation/replay/idle/absolute expiry；
- 同手机号并发开户注册；
- signup Token 与图片事件幂等；
- ledger 重建与 balance 一致；
- reservation 并发和超时；
- cap/frozen/available 公式；
- Plan 到期回落 free；
- internal exemption 显式性；
- current `cgu_live_*` 唯一和轮换。

### 13.2 Gateway 集成测试

- `login/start` 在 `transition` 模式直接返回 `authenticated`，并如实记录 `transition_phone_only`；
- `transition` 模式只接受管理员已准备的内部手机号，未知手机号返回 `403 phone_not_registered` 且零副作用；
- `login/start` 在 `sms` 模式返回不可枚举的 `verification_required`；
- `login/verify` 的验证码错误、过期、限流和重放矩阵；
- 短信验证成功先返回 JWT；后续 bootstrap provisioning 失败可用同一 Session 重试且不重发验证码；
- 新消费用户的 bootstrap 全链路 provisioning；
- 已有用户复用原 Subject；
- 冲突用户返回 409；
- bootstrap 返回可解析且只在响应出现的 `cgu_live_*`；
- `/gateway/unified-keys/resolve` 和 `/gateway/credentials/current` 回归；
- 非流式、SSE、工具调用的预占与结算；
- client disconnect 和 upstream failure；
- 图片成功、失败、fallback、disconnect；
- 免费 Research fail-before-create；
- 426 最低版本门禁；
- 日志、错误和审计无敏感值。

### 13.3 必跑仓库门禁

```powershell
npm run typecheck
npm run build
npm test
python -m unittest discover -s tests -p "test_*.py"
```

如果仓库当时存在已知基线失败，必须单独记录；不能把无关修复混入认证/钱包 PR。

### 13.4 T 阶段真实 R760 E2E

至少覆盖：

1. 管理员 API 幂等准备一个内部账户；
2. 已注册手机号直接登录，同手机号重复登录和第二设备登录；
3. 未注册手机号稳定拒绝且不创建任何账户数据；
4. 客户端重启后 refresh + bootstrap；
5. 真实 `goldencode` 非流式、流式、工具对话和至少一个图片 Provider；
6. 内部 Plan 生效且不存在消费注册赠送；
7. 旧版本 426；
8. 退出后 Session 失效和内存凭据清除；
9. 全链路日志与诊断包 secret scan。

### 13.5 F 阶段真实 R760 E2E

至少覆盖：

1. 新手机号真实短信登录、自动建立免费账户；
2. 既有手机号真实短信登录并复用原 Subject；
3. 验证成功后外部 provisioning 暂时失败，保留 Session 并重试 bootstrap；
4. 50 万 Token 和 3 次图片只发一次；
5. 普通聊天、流式、工具对话的永久钱包预占与实际结算；
6. 至少一个真实图片 Provider 成功并正确扣减次数；
7. 免费 Research 在创建 run 前拒绝；
8. `token_balance_insufficient` 与 `active_balance_cap_exceeded` 区分正确；
9. Windows/macOS 安装包从登录到主界面完整通过。

测试手机号、验证码、JWT、完整 Key 和 provider credential 不得写入 PR、文档或聊天。

## 14. 可观测性与审计

建议指标：

- 按 `transition_phone_only|sms` 区分的登录成功/失败次数；
- SMS start/verify 成功率、provider latency、rate-limit 次数；
- 管理员开户注册成功、幂等重放、冲突和停用次数；
- provisioning 每一步成功/失败/恢复次数；
- JWT refresh、replay、Session revoke；
- bootstrap 成功、Key migration required、identity conflict；
- wallet acquire/finalize、余额不足、cap 不足、reservation timeout；
- missing usage、actual/reserved 比率和 invariant violation；
- image reserve/success/refund；
- 426 拒绝次数和客户端版本分布；
- ledger/balance reconciliation drift。

审计只保存不可逆或受控 ID、safe prefix、动作、状态、原因码和时间。不得保存完整手机号、验证码、JWT、Refresh Token、`cgu_live_*`、底层 API key、支付 JWT 或带 Token 的 URL。

## 15. 配置项建议

最终变量名在 M0 冻结。建议类别：

```text
GATEWAY_PHONE_AUTH_MODE=disabled|transition|sms
GATEWAY_PHONE_AUTH_ISSUER=https://goldencode.instmarket.com.au:1443/gateway/auth/v1
GATEWAY_PHONE_AUTH_AUDIENCE=codex-gateway
GATEWAY_PHONE_AUTH_JWT_PRIVATE_KEY_FILE=
GATEWAY_PHONE_AUTH_JWT_ACTIVE_KID=
GATEWAY_PHONE_AUTH_ACCESS_TTL_SECONDS=900
GATEWAY_PHONE_AUTH_REFRESH_IDLE_DAYS=30
GATEWAY_PHONE_AUTH_SESSION_ABSOLUTE_DAYS=180

GATEWAY_PHONE_LOOKUP_HMAC_SECRET_FILE=
GATEWAY_PHONE_DATA_ENCRYPTION_KEY_FILE=
GATEWAY_OTP_HMAC_SECRET_FILE=
GATEWAY_UNIFIED_KEY_RECOVERY_KEY_FILE=

GATEWAY_SMS_PROVIDER=fake|aliyun
GATEWAY_ALIYUN_SMS_ACCESS_KEY_ID_FILE=
GATEWAY_ALIYUN_SMS_ACCESS_KEY_SECRET_FILE=
GATEWAY_ALIYUN_SMS_SIGN_NAME=
GATEWAY_ALIYUN_SMS_TEMPLATE_CODE=

GATEWAY_WALLET_ENFORCEMENT=off|shadow|on
GATEWAY_IMAGE_CREDIT_ENFORCEMENT=off|shadow|on
GATEWAY_FREE_PLAN_ID=plan_consumer_free_v1

GATEWAY_MINIMUM_DESKTOP_VERSION=
GATEWAY_DESKTOP_DOWNLOAD_URL=
```

`transition` 和 `sms` 模式都必须具备有效 JWT 签名、手机号 HMAC/加密及 unified key recovery 配置；`sms` 模式还必须具备完整阿里云短信配置。R760 不允许 `fake` provider，也不得因短信配置缺失自动从 `sms` 切回 `transition` 或 `fake`。钱包 shadow 模式只能用于受控 Subject 或计算对比，不得制造不可对账的部分扣费。

## 16. 发布、回滚与数据安全

### 16.1 发布

- 检查并保留工作区无关改动；
- 从已提交 HEAD 构建 release，不从 dirty tree 部署；
- R760 写前 online backup；
- 先执行 schema/secret/配置预检；
- 启动后验证 commit marker、健康、数据库完整性和 feature flags；
- T 发布顺序执行管理员开户注册、手机号直登、refresh、bootstrap、resolve、account、chat 和 image smoke；
- F 发布前再执行真实 SMS、消费钱包、免费图片次数和 Research 拒绝 smoke；
- 从 `transition` 切换为 `sms` 是显式管理员配置变更，不依赖支付，也不得自动切换；
- 临时 Subject、Session、Key 和 ledger 测试数据按审计方式清理或明确保留为测试账户。

### 16.2 回滚

- Schema 采用 additive migration，使上一版二进制可忽略新表/新列；
- feature flag 可关闭新注册和新钱包 admission，但不能删除已经发生的 ledger event；
- T 阶段可关闭手机号直登并回滚到 R760 上一个兼容 release；已经签发的 Session 由回滚步骤显式撤销或保留，不能含糊处理；
- 从 T 切换到 F 时不强制轮换内部用户的 unified/backing credential；后续若发现泄露迹象，仍使用现有受控轮换能力；
- 钱包开始真实扣费后，不允许通过恢复旧数据库回滚代码，否则会丢失不可变消费事件；
- 必须以前向修复或 ledger reconciliation 处理计费问题；
- Key 迁移/轮换完成后，不能假设旧 Key 仍可恢复；
- 产品已决定不保留 Azure 回退，回滚目标只能是 R760 上一个兼容 release。

## 17. 外部依赖与当前阻塞项

| 依赖 | 当前状态 | 解除条件 |
| --- | --- | --- |
| 阿里云短信签名 | 未准备；不阻塞 T，阻塞 F | 企业账号持有方完成审核 |
| 阿里云验证码模板 | 未准备；不阻塞 T，阻塞 F | 模板审核通过并提供 template code |
| 最小权限 RAM 凭据 | 未准备；不阻塞 T，阻塞 F | 提供仅短信发送权限的受控凭据 |
| 最低 Desktop 版本 | 待发布时确定 | Desktop 给出正式 semver |
| Desktop 下载地址 | 待确认 | R2 正式下载/更新地址冻结 |
| 历史手机号冲突处理 | 待迁移执行 | M2 dry-run 清单全部关闭 |
| 历史完整 `cgu_live_*` recoverability | 待盘点 | T 前完成所有过渡内部账户；F 前完成所有目标消费账户的验证导入或受控轮换 |
| 月付/年付正式数值 | 支付阶段待定 | 产品提供各自 grant、cap、期限和 SKU |

阿里云资源由持有企业账号和资质的一方申请；Gateway 团队提供模板变量要求、最小权限策略、接入代码、配置预检和 R760 部署。

## 18. P 阶段支付扩展

P 阶段复用 F 阶段 Subject、钱包、Plan 和 JWT 基础，不另建账户。

### 18.1 订单入账

一个成功订单在同一幂等业务操作中：

1. 验证支付服务身份和请求签名；
2. 以 `provider + external_order_id` 判重；
3. 向 Token ledger 追加 `purchase_grant`；
4. 创建或续期对应 Plan entitlement；
5. 保存 grant/cap/period 的不可变快照；
6. 返回同一订单重放结果。

钱包 grant 和 entitlement 不能一个成功、一个失败后返回普通成功；跨表写入在同一 SQLite 事务中完成。

### 18.2 支付跳转 JWT

- Desktop 使用 Access JWT 请求 Gateway 签发支付专用 JWT；
- `aud=payment`；
- 5 分钟过期；
- 只包含 `sub`、`jti`、`iss/aud/iat/exp`；
- 不包含完整手机号、`cgu_live_*`、Access/Refresh Token、余额或 Gateway API 权限；
- 支付服务通过 JWKS 直接验签；
- 第一版支付流程不建设一次性 code exchange。

### 18.3 Doctor Research

付费开放前必须设计 run-level reservation：创建 run 前预占整次安全上界，Worker 各阶段上报实际用量，终态统一结算。不能只对创建 run 的 HTTP 请求收取少量 Token，也不能让中途余额耗尽后发布不完整研究产物。

## 19. 完成定义

### 19.1 T 阶段完成

- [ ] API contract 已冻结并由 Gateway/Desktop 共同确认；
- [ ] 受保护管理员 API 可幂等准备、查询、启用和停用完整内部账户；
- [ ] 已注册内部手机号可直接登录，未知手机号稳定返回 `phone_not_registered` 且不创建账户；
- [ ] Access/Refresh、多设备、撤销、replay、bootstrap 和 resolver 测试通过；
- [ ] 内部账户继续使用明确的内部 Plan，且没有消费钱包或免费赠送事件；
- [ ] account current、credentials current、稳定错误码和最低客户端版本 426 门禁通过；
- [ ] Windows/macOS 安装包在 R760 完成真实聊天、工具和至少一个图片 Provider E2E；
- [ ] 日志、审计、诊断包无手机号、Token 或 Key 等敏感值；
- [ ] R760 备份、部署、健康和真实 smoke 通过。

T 阶段不以阿里云短信、永久消费钱包、免费图片账本或支付系统就绪为完成条件。

### 19.2 F 阶段完成

- [ ] 阿里云正式短信签名、模板和最小权限 RAM 凭据就绪；
- [ ] 真实短信登录对已存在和未知手机号均通过，未知手机号可自动创建免费账户；
- [ ] 历史普通消费用户的手机号、Subject 和 current `cgu_live_*` 迁移零冲突；
- [ ] 免费 Plan、50 万 Token 和 3 次图片幂等发放；
- [ ] 普通聊天/工具钱包预占和实际结算通过；
- [ ] 图片独立次数通过，且至少一个受支持 Provider 完成真实 E2E；
- [ ] 免费 Doctor Research fail-before-create；
- [ ] provisioning 中断后可保留 Session 并通过 bootstrap 幂等恢复；
- [ ] Windows/macOS 公开安装包联合 E2E 通过；
- [ ] 登录模式经显式发布操作从 `transition` 切换到 `sms`。

F 阶段不以支付系统就绪为完成条件。

### 19.3 Azure 退役独立门禁

- [ ] Azure 最终 usage merge 二次 dry-run 为零变更；
- [ ] R760 已验证为唯一入口和唯一可写权威；
- [ ] Azure 退役证据单独记录并完成。

## 20. 参考资料

- [`r760-control-plane-authority.md`](../operations/r760-control-plane-authority.md)
- [`medevidence-codex-key-provisioning.md`](../operations/medevidence-codex-key-provisioning.md)
- [`p2-token-budget.md`](./p2-token-budget.md)
- [`p3-plan-entitlement.md`](./p3-plan-entitlement.md)
- [`registration-payment-integration-spec.md`](./registration-payment-integration-spec.md)
- [`billing-admin-api-design.zh-CN.md`](../billing-admin-api-design.zh-CN.md)
- [`medevidence-v2-auto-provisioning-requirements.zh-CN.md`](../medevidence-v2-auto-provisioning-requirements.zh-CN.md)
- [`medevidence-desktop-phone-jwt-login-gateway-contract-response-2026-08-15.zh-CN.md`](../outbox/medevidence-desktop-phone-jwt-login-gateway-contract-response-2026-08-15.zh-CN.md)
- MedEvidence 原始需求：`C:\work\code\medevidence-opencode-stable\docs\MedEvidence新需求.txt`

## 21. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-15 | 根据与 Desktop 团队逐项确认补充 T/F/P 三阶段；以 `login/start` 的 `transition|sms` 双响应替代旧 send/verify 假设；明确内部手机号直登、管理员完整准备、公开免费期 bootstrap 边界和各阶段独立门禁 |
| 2026-08-15 | 根据逐项确认结果建立第一版正式实施方案；明确 Gateway 暂时负责阿里云短信与 JWT、`cgu_live_*` 保持底层核心、免费 50 万 Token/3 次图片、免费禁用 Research、R760 单一权威、强制最新版客户端及支付阶段边界 |
