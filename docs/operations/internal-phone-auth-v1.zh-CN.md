# R760 双轨兼容手机号登录 v1 操作说明

> 状态（2026-08-22）：R760 additive 部署、prefix contract hotfix、Desktop
> beta.40 A/B/U live acceptance、自动关窗和权威数据不变量审计均已完成；双方
> 已签收 `contract_frozen`。生产
> `GATEWAY_PHONE_AUTH_MODE` 与 `GATEWAY_DESKTOP_VERSION_GATE` 当前均为
> `disabled`。技术合同已允许 Desktop 进入正式发布流程，但不得据本文预登记
> 真实用户；真实用户名单仍需业务 owner 明确批准。

本实现只用于 R760 权威 Gateway。权威实施规格为
[`MedEvidence R760 双轨兼容手机号免验证码登录 Gateway 实施规格 v1`](../implementation/medevidence-r760-dual-track-phone-auth-gateway-implementation-spec-2026-08-21.zh-CN.md)，
Desktop/Gateway 联调使用新的
[`medevidence-r760-dual-track-phone-auth-v1`](../contracts/medevidence-r760-dual-track-phone-auth-v1/README.md)
contract；旧 frozen contract 只提供未变化的 wire shape。

## 不变量与默认状态

- `GATEWAY_PHONE_AUTH_MODE=disabled`；
- `GATEWAY_DESKTOP_VERSION_GATE=disabled`；
- migration 25 保持原 SQL，additive schema 在开关关闭时不改变旧请求路径；
- 未登记手机号返回 `phone_not_registered`，不得自动创建 Subject、Key、Plan 或 entitlement；
- Phone identity/Session、旧 `cgu_live_*`、backing credential、Plan、entitlement、capability、额度窗口和既有用量锚定同一 `subject_id`；
- login、refresh、logout、replay、Session 过期、identity disable 和 Desktop 升级均不得撤销旧 Key 或改变 Plan/用量；
- R760 是唯一运行、控制和用量权威，不使用 Azure、CN1 或第二 Gateway 兼容、重试或回滚。

手机号免验证码登录不是强身份认证。没有业务风险签收和明确名单批准时，不得为真实用户启用。

## 启用前准备

1. 先重读实时 `docs/operations/system-status.md` 并对 R760 做只读核验；文档内的历史 release SHA 不能替代实时事实。
2. 建立并验证 current/previous release、Gateway image、完整 Compose overlay、正式配置、SQLite 备份与六个命名卷的回滚边界；不得打印 env、rendered Compose 或 secret 内容。
3. 为受控目标 Subject 核对唯一中国大陆手机号、活动 Subject、活动 Plan、`code` scope、`chat` capability 和原有用量快照。
4. 核对 backing credential 与当前 `cgu_live_*` 未撤销、未过期且可恢复；唯一 MedEvidence Origin 为 `https://goldencode.instmarket.com.au:1443`（允许末尾 `/`）。
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
    "mode": "disabled",
    "version_gate_mode": "disabled",
    "minimum_desktop_version": null
  }
}
```

health 不得包含手机号、allowlist、Session、Key prefix、secret 路径或 secret 状态。

## Additive 部署与 canary 顺序

1. 从通过全部本地门禁的 clean commit 建立不可变 release/image，保留完整 Compose base、Research overlay、private env 和 R760 override。
2. 首次 recreate 只针对 Gateway，并保持两个开关均为 `disabled`。
3. 验证 public/internal health、唯一 `127.0.0.1:18787` listener、Gateway/Research/Mihomo 健康、restart=0、SQLite integrity/FK 和 beta.38 无 Header 的 resolver/chat/tools/Research/image/Vision 路径。
4. 只创建一个受控临时 Subject/Key/entitlement/phone identity；先记录 Subject、Key、Plan、entitlement、capability、quota/usage 快照。
5. 短暂切到 `transition + auth_only`，验证 beta.40 login/bootstrap/account、低版本 426、refresh rotation/replay、logout、identity disable、三维 429 和旧 Key 路径。
6. 将两个开关恢复为 `disabled` 并 recreate Gateway；再次验证 beta.38 全路径、健康、listener 和不变量。
7. 撤销并删除所有临时 Session、Key、entitlement、Subject 和临时文件；确认无活动临时资源、无额外 listener、无非终态 Research run/unfinished reservation。

任何一步失败都应先恢复配置开关和 previous image/config 边界；保留 additive schema，不恢复旧数据库，不切换到 Azure/CN1。

## 预登记与停用

真实用户预登记必须先取得明确批准名单。批准前只能生成脱敏只读 readiness 报告，不得批量写入。单个批准 Subject 使用现有 Billing Admin 认证：

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
