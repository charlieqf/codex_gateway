# R760 内部手机号登录 v1 操作说明

> **暂勿按本文启用生产。** 现有启用步骤仍基于旧的全路径版本门禁，不能满足
> beta.38 旧 Key 长期兼容。新的权威实现目标见
> [`MedEvidence R760 双轨兼容手机号免验证码登录 Gateway 实施规格 v1`](../implementation/medevidence-r760-dual-track-phone-auth-gateway-implementation-spec-2026-08-21.zh-CN.md)。
> 在相应代码、fixtures 和本运维说明完成更新前，两个功能开关必须保持 `disabled`。

本实现只用于 R760 权威 Gateway，wire contract 以
[`medevidence-internal-phone-auth-v1`](../contracts/medevidence-internal-phone-auth-v1/README.md)
为准。手机号直登不是强身份认证；没有业务风险签收时不得启用。

## 默认状态

- `GATEWAY_PHONE_AUTH_MODE=disabled`；
- `GATEWAY_DESKTOP_VERSION_GATE=disabled`；
- migration 25 只增加列和表，关闭功能时不改变现有请求路径；
- 不会根据手机号自动创建 Subject、Key、Plan 或 entitlement。

## 启用前准备

1. 为每个目标 Subject 填写唯一的中国大陆手机号。
2. 确认其现有 backing credential 为 `code` scope，且完整 key 可由 `GATEWAY_API_KEY_ENCRYPTION_SECRET` 解密并通过 hash 校验。显式 model allowlist 必须包含 `goldencode`；历史 unrestricted (`null`) 会在绑定时收窄为 `goldencode`。
3. 确认现有 `cgu_live_*` 未撤销、未过期且 MedEvidence key 可解密。显式 `medevidence_base_url` 必须是唯一批准的 Origin `https://gw-47-116-7-37.nip.io`（允许末尾 `/`）；历史缺失值会在绑定时补齐。
4. 确认 Subject 有活动 Plan、`code` scope 和 `chat` capability。
5. 将不应受 Desktop 426 影响的凭据显式分类；不得依赖 User-Agent：

   ```text
   npm run dev:admin -- --db <gateway.db> update-key <prefix> --credential-class service
   npm run dev:admin -- --db <gateway.db> update-key <prefix> --credential-class operator
   ```

   `update-key` 会在同一事务中同步所有由该 `cgw.*` 支撑的 unified key class，避免 class 不一致时被按 `unknown` 执行 426。

6. 配置稳定的 secret 文件和 Ed25519 JWT 私钥；Linux 上文件权限必须为 `0600`。变量清单见
   [`config/gateway.container.example.env`](../../config/gateway.container.example.env)。

   R760 使用现有 `gateway_state` 持久卷中的固定容器路径，不增加新的挂载或 secret fallback：

   ```text
   目录（codexgw:codexgw / 0700）：
   /var/lib/codex-gateway/phone-auth-secrets

   文件（codexgw:codexgw / 0600）：
   GATEWAY_PHONE_AUTH_JWT_PRIVATE_KEY_FILE=/var/lib/codex-gateway/phone-auth-secrets/jwt-ed25519-private.pem
   GATEWAY_PHONE_LOOKUP_HMAC_SECRET_FILE=/var/lib/codex-gateway/phone-auth-secrets/phone-lookup-hmac
   GATEWAY_PHONE_DATA_ENCRYPTION_KEY_FILE=/var/lib/codex-gateway/phone-auth-secrets/phone-data-encryption
   GATEWAY_UNIFIED_KEY_RECOVERY_KEY_FILE=/var/lib/codex-gateway/phone-auth-secrets/unified-key-recovery
   ```

   先在维护窗口内把文件写入该持久卷并核对 owner、mode 和容器内可读性，再填写上述 `_FILE` 变量。不得把 secret 值写入 env、Git、日志或命令输出；路径尚未就绪时保持变量为空并保持功能关闭。

手机号绑定使用现有 Billing Admin 认证：

```http
POST /gateway/admin/billing/v1/phone-auth-identities
Authorization: Bearer <billing-admin-token>
Content-Type: application/json

{
  "phone": "13800138000",
  "subject_id": "subj_example",
  "unified_key": "<complete-cgu_live_key>"
}
```

成功只返回 Subject 和状态，不回显手机号或 key。Gateway 会重新验证上述全部账户条件，将手机号和完整 unified key 分别加密保存，补齐缺失的固定 Origin 和 `goldencode` allowlist，并把 unified/backing credential class 设为 `desktop`。显式冲突不会被覆盖。不要把完整 key 放入 URL、日志或 shell 命令历史。

## 维护窗口启用

同时满足以下配置后才允许启动 `transition`：

```text
GATEWAY_PUBLIC_BASE_URL=https://goldencode.instmarket.com.au:1443
GATEWAY_DESKTOP_VERSION_GATE=enabled
GATEWAY_MINIMUM_DESKTOP_VERSION=<strict-semver>
GATEWAY_DESKTOP_DOWNLOAD_URL=<absolute-https-url>
GATEWAY_PHONE_AUTH_MODE=transition
```

缺少有效版本门禁、R760 origin、JWT、加密 secret 或必要 store 时，Gateway 会拒绝启动，不会自动降级。`GET /gateway/health` 公开显示 phone auth mode、426 开关和最低版本，供部署核对。

只执行一次最终客户端 E2E：登录、bootstrap、resolver、`credentials/current`、`account/current`、客户端重启后的 Session 恢复和真实对话。

Refresh Token 每次成功使用后立即轮换。若响应丢失、safeStorage 写入失败或客户端无法证明新 token pair 已持久化，客户端必须删除本地 Session 并重新登录；不得重发旧 Refresh Token。旧 token replay 会撤销整个 Session。

## 停用与回滚

身份停用接口会在同一事务中撤销该手机号的所有活动 Session：

```http
PATCH /gateway/admin/billing/v1/phone-auth-identities/<subject-id>
Authorization: Bearer <billing-admin-token>
Content-Type: application/json

{"state":"disabled"}
```

整体回滚时将 `GATEWAY_PHONE_AUTH_MODE` 和 `GATEWAY_DESKTOP_VERSION_GATE` 都改为 `disabled` 并重启，按需停用身份或撤销 key。保留 additive schema，不恢复旧数据库。
