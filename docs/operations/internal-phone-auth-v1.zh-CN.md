# R760 双轨兼容手机号登录 v1 操作说明

> 状态（2026-08-22）：R760 additive 部署、prefix contract hotfix、Desktop
> beta.40 A/B/U live acceptance、自动关窗和权威数据不变量审计均已完成；双方
> 已签收 `contract_frozen`。业务 owner 随后批准为所有符合条件的现有
> MedEvidence 用户启用手机号免验证码登录，并明确排除 2 名不再纳入本次上线的
> 用户。生产当前为 `transition / auth_only / 2.0.0-beta.40`；153 个现有用户的
> Phone identity 已启用，旧 `cgu_live_*` 路径保持可用。

本实现只用于 R760 权威 Gateway。权威实施规格为
[`MedEvidence R760 双轨兼容手机号免验证码登录 Gateway 实施规格 v1`](../implementation/medevidence-r760-dual-track-phone-auth-gateway-implementation-spec-2026-08-21.zh-CN.md)，
Desktop/Gateway 联调使用新的
[`medevidence-r760-dual-track-phone-auth-v1`](../contracts/medevidence-r760-dual-track-phone-auth-v1/README.md)
contract；旧 frozen contract 只提供未变化的 wire shape。

## 不变量与生产状态

- `GATEWAY_PHONE_AUTH_MODE=transition`；
- `GATEWAY_DESKTOP_VERSION_GATE=auth_only`；
- `GATEWAY_MINIMUM_DESKTOP_VERSION=2.0.0-beta.40`；
- migration 25 保持原 SQL，additive schema 在开关关闭时不改变旧请求路径；
- 未登记手机号返回 `phone_not_registered`，不得自动创建 Subject、Key、Plan 或 entitlement；
- Phone identity/Session、旧 `cgu_live_*`、backing credential、Plan、entitlement、capability、额度窗口和既有用量锚定同一 `subject_id`；
- login、refresh、logout、replay、Session 过期、identity disable 和 Desktop 升级均不得撤销旧 Key 或改变 Plan/用量；
- R760 是唯一运行、控制和用量权威，不使用 Azure、CN1 或第二 Gateway 兼容、重试或回滚。

手机号免验证码登录不是强身份认证。2026-08-22 的业务决定已经接受该过渡风险，并把批准范围
定义为符合本文条件的全部现有 MedEvidence 用户；不属于 MedEvidence、合成测试、重复/非权威记录
以及 owner 明确排除的用户不在范围内。未知手机号仍不得自动建号。

## 启用前准备

1. 先重读实时 `docs/operations/system-status.md` 并对 R760 做只读核验；文档内的历史 release SHA 不能替代实时事实。
2. 建立并验证 current/previous release、Gateway image、完整 Compose overlay、正式配置、SQLite 备份与六个命名卷的回滚边界；不得打印 env、rendered Compose 或 secret 内容。
3. 为受控目标 Subject 核对唯一中国大陆手机号、活动 Subject、活动 Plan、`code` scope、`chat` capability 和原有用量快照。
4. 核对 backing credential 与当前 `cgu_live_*` 未撤销、未过期且可恢复；Gateway 公网 Origin 为 `https://goldencode.instmarket.com.au:1443`，统一 Key 元数据中的 MedEvidence Origin 为 `https://gw-47-116-7-37.nip.io`（均按规范化 Origin 比较）。
5. 配置稳定的 Ed25519 和加密 secret 文件。R760 继续使用现有 `gateway_state` 卷内固定目录，不增加第二 secret fallback：

   ```text
   目录（codexgw:codexgw / 0700）：
   /var/lib/codex-gateway/phone-auth-secrets

   文件（codexgw:codexgw / 0600）：
   GATEWAY_PHONE_AUTH_JWT_PRIVATE_KEY_FILE=/var/lib/codex-gateway/phone-auth-secrets/jwt-ed25519-private.pem
   GATEWAY_PHONE_LOOKUP_HMAC_SECRET_FILE=/var/lib/codex-gateway/phone-auth-secrets/phone-lookup-hmac
   GATEWAY_PHONE_DATA_ENCRYPTION_KEY_FILE=/var/lib/codex-gateway/phone-auth-secrets/phone-data-encryption
   GATEWAY_UNIFIED_KEY_RECOVERY_KEY_FILE=/var/lib/codex-gateway/phone-auth-secrets/unified-key-recovery
   ```

   secret 值不得进入 env、Git、日志、测试输出或 shell history。

## 严格配置合同

`GATEWAY_DESKTOP_VERSION_GATE` 只接受 `disabled`、`auth_only`、`all`；旧值
`enabled` 和其他值必须在监听端口前启动失败。`transition` 只允许与
`auth_only` 组合：

```text
GATEWAY_PUBLIC_BASE_URL=https://goldencode.instmarket.com.au:1443
GATEWAY_DESKTOP_VERSION_GATE=auth_only
GATEWAY_MINIMUM_DESKTOP_VERSION=2.0.0-beta.40
GATEWAY_DESKTOP_DOWNLOAD_URL=<absolute-https-url>
GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION=<fixed-desktop-strict-semver-or-empty>
GATEWAY_PHONE_AUTH_MODE=transition
GATEWAY_PHONE_AUTH_LOGIN_PHONE_RPM=5
GATEWAY_PHONE_AUTH_LOGIN_IP_RPM=20
GATEWAY_PHONE_AUTH_LOGIN_DEVICE_RPM=10
```

`auth_only` 只对 login、refresh、logout、bootstrap 和
`GET /gateway/account/v1/current` 五条 Phone Session 路由执行版本门禁。resolver、
`credentials/current`、`/v1/*`、Research、image generation 和四条 Vision Asset
Gateway 路由不得因版本 Header 缺失、非法或过旧返回 426。

`GET /gateway/health` 只公开：

```json
{
  "phone_auth": {
    "mode": "transition",
    "version_gate_mode": "auth_only",
    "minimum_desktop_version": "2.0.0-beta.40"
  }
}
```

health 不得包含手机号、allowlist、Session、Key prefix、secret 路径或 secret 状态。

## MedEvidence Origin 分版本切换

Gateway 的 MedEvidence 地址切换与 Phone Auth 最低版本是两个独立门控。新增配置
`GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION`：

- 未设置或为空时，resolver 对所有客户端继续返回
  `https://gw-47-116-7-37.nip.io`，部署新 Gateway 代码本身不会切流；
- 设置为客户端团队确认支持新地址的严格 SemVer 后，仅该版本及更高版本返回
  `https://r760.instmarket.com.au:1443`；
- Header 缺失、格式非法或版本较低时仍返回旧地址，不返回 426；
- 对已有 MedEvidence runtime key 但 `medevidence_base_url` 元数据为空的旧记录，
  resolver 也按同一规则返回受控旧/新 Origin，不要求先迁移数据库；
- Gateway 只对受控的旧、新两个 Origin 做版本选择，其他历史自定义元数据保持原行为；
- Desktop 类凭据的数据库元数据只允许这两个受控 Origin，否则仍返回
  `account_migration_required`。

本阶段不批量改写 `unified_client_keys.metadata_json`，也不轮换 MedEvidence key。
Phone identity 准备流程会保留已经是受控旧/新 Origin 的元数据；因此可先部署默认关闭的
Gateway 能力，再由客户端团队提供首个修复版本号，最后只通过环境变量开启分版本切换。
在旧客户端全部退出且准备轮换 key 之前，不要批量把元数据迁移为 R760 Origin。

`GET /gateway/health` 通过非敏感字段公开当前策略，便于部署验收：

```json
{
  "medevidence_routing": {
    "mode": "legacy_only",
    "r760_minimum_desktop_version": null
  }
}
```

开启后 `mode` 为 `versioned`，并显示配置的最低版本。该兼容策略无法修复旧客户端到
nip.io 的 TLS/SNI reset；发生该网络故障的设备仍必须升级到支持 R760 Origin 的版本。

## 首次 Additive 部署与 canary 顺序（历史验收流程）

1. 从通过全部本地门禁的 clean commit 建立不可变 release/image，保留完整 Compose base、Research overlay、private env 和 R760 override。
2. 首次 recreate 只针对 Gateway，并保持两个开关均为 `disabled`。
3. 验证 public/internal health、唯一 `127.0.0.1:18787` listener、Gateway/Research/Mihomo 健康、restart=0、SQLite integrity/FK 和 beta.38 无 Header 的 resolver/chat/tools/Research/image/Vision 路径。
4. 只创建一个受控临时 Subject/Key/entitlement/phone identity；先记录 Subject、Key、Plan、entitlement、capability、quota/usage 快照。
5. 短暂切到 `transition + auth_only`，验证 beta.40 login/bootstrap/account、低版本 426、refresh rotation/replay、logout、identity disable、三维 429 和旧 Key 路径。
6. 将两个开关恢复为 `disabled` 并 recreate Gateway；再次验证 beta.38 全路径、健康、listener 和不变量。
7. 撤销并删除所有临时 Session、Key、entitlement、Subject 和临时文件；确认无活动临时资源、无额外 listener、无非终态 Research run/unfinished reservation。

任何一步失败都应先恢复配置开关和 previous image/config 边界；保留 additive schema，不恢复旧数据库，不切换到 Azure/CN1。

## 批量启用、后续发放与停用

2026-08-22 的生产批次以现有有效 `manual_trial` MedEvidence 用户为权威范围：161 个目标中排除
8 个诊断、船期、合成测试、重复/非权威或 owner 明确排除的 Subject，最终启用 153 个 Phone
identity。批量准备为每个目标复用同一 Subject、Plan、entitlement 和 backing credential；无法恢复
旧明文统一 Key 时增发一个可恢复的兼容 current Key，但不撤销或缩短任何旧 Key。迁移结果、备份和
不变量见
[`生产双轨 Phone Auth 上线结果`](../implementation/medevidence-r760-global-dual-track-phone-auth-rollout-result-2026-08-22.zh-CN.md)。

以后通过正式 real-user issuance 流程发放、且提供有效唯一手机号的新用户，会在同一事务流程后自动
准备 Phone identity。未知手机号仍返回 `403 phone_not_registered`，不得在登录请求中自动创建
Subject、Key、Plan 或 entitlement。

需要对单个既有 Subject 补登记时，使用现有 Billing Admin 认证：

```http
POST /gateway/admin/billing/v1/phone-auth-identities
Authorization: Bearer <billing-admin-token>
Content-Type: application/json

{
  "phone": "<approved-phone>",
  "subject_id": "<approved-subject-id>",
  "unified_key": "<complete-approved-cgu-key>"
}
```

成功响应不回显手机号或 Key。完整 Key 不得放入 URL、日志或命令行参数。

Phone identity 单独停用：

```http
PATCH /gateway/admin/billing/v1/phone-auth-identities/<subject-id>
Authorization: Bearer <billing-admin-token>
Content-Type: application/json

{"state":"disabled"}
```

该操作只撤销 Phone Session/Refresh；后续登录返回
`403 phone_login_disabled`。它不停用 Subject、不撤销旧 Key、不改变 Plan。
只有 Subject 本身停用时才返回 `403 account_disabled`。

## Session 与回滚语义

Refresh Token 每次成功使用后原子轮换。响应丢失、safeStorage 写入失败或持久化结果不确定时，Desktop 必须清除本地 Session 并重新登录，不得重发旧 Refresh Token；replay 会撤销该 Session family。

Gateway logout 只撤销当前 Phone Session family，不撤销旧 Key。Desktop 的“退出此设备”还必须写入本地 legacy logout suppression，避免旧 Key 在同一设备上自动回填登录；这是 Desktop 集成责任，不是 Gateway Key 撤销。

配置回滚只需恢复：

```text
GATEWAY_PHONE_AUTH_MODE=disabled
GATEWAY_DESKTOP_VERSION_GATE=disabled
```

然后以完整正式 Compose overlay recreate Gateway 并复验旧路径。不得为配置回滚停用真实 Subject、撤销真实 Key、改变 Plan/entitlement 或删除 migration 25 schema。
