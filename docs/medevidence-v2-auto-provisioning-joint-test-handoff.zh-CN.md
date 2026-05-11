# MedEvidence v2 自动开户注册联调交付说明

日期：2026-05-11

本文面向 v2 服务团队，用于第一轮联调“Gateway 用户注册建账 -> 调 v2 创建内部 principal/key -> Gateway 签发 opaque `cgu_live_*` key”。v2 团队不需要了解 Gateway 对外 opaque key 的组成，也不需要处理收费系统或终端用户逻辑。

完整接口要求见 `docs/medevidence-v2-auto-provisioning-requirements.zh-CN.md`。本文只列当前联调需要确认和执行的内容。

## 1. 当前 Gateway 状态

- Gateway 测试环境：`https://gw.instmarket.com.au`
- 当前运行代码版本：`e1efe72`（2026-05-11）
- Gateway Billing Admin `/gateway/admin/billing/v1/subjects` route 已部署。
- Gateway 已配置 billing admin token 和 key 加密 secret。
- Gateway 已配置 v2 internal 调用参数：
  - `GATEWAY_UPSTREAM_V2_BASE_URL`
  - `GATEWAY_UPSTREAM_V2_TOKEN`
  - `GATEWAY_UPSTREAM_V2_TIMEOUT_MS=5000`
- 2026-05-11 已完成 Gateway -> v2 端到端 smoke：create subject、v2 create principal/key、Gateway 签发 `cgu_live_*`、opaque resolve、Gateway 幂等 replay、重复 external user 冲突、disable cleanup 均通过。

## 2. v2 团队需要先提供

1. **测试 internal base URL**
   - 例如：`https://<v2-test-host>`。
   - Gateway 会在其后拼接 `/internal/users`、`/internal/users/{id}/disable` 等路径。
   - 不要在 `GATEWAY_UPSTREAM_V2_BASE_URL` 末尾重复包含 `/internal`，除非 v2 服务本身部署在更上层 base path 下且最终 URL 确实需要该前缀。
2. **测试 internal bearer token**
   - 通过安全渠道交付，不能写入文档、工单正文、截图或日志。
   - 如已支持 current/next token，请说明哪个是 current。
3. **网络访问放行**
   - 允许 Gateway 测试 VM 访问 v2 internal base URL。
   - 当前 Gateway 公网 VM IP：`4.242.58.89`。
   - 如走私网/VPC，请提供私网 base URL 和访问方式。
4. **v2 侧配置确认**
   - 内部 create 接口可用，不依赖终端用户 `X-API-Key` / `?api_key=` 鉴权。
   - key 原文加密和 7 天幂等重放能力已启用。
   - `external_provider + external_user_id` 唯一约束已启用。
   - `principal_kind = internal_backend_user` 支持 `phone_e164 IS NULL`。
   - 日志不记录完整 bearer token 或完整 v2 key。

## 3. Gateway 会如何调用 v2

Billing 侧传入：

```json
{
  "provider": "codex_gateway_v2_jointtest",
  "external_user_id": "v2_joint_20260511_001",
  "display_name": "V2 Joint Test",
  "scope_allowlist": ["code"],
  "metadata": {
    "purpose": "v2_joint_test"
  }
}
```

Gateway 会生成确定性 `subject_id`：

```text
subj_<sha256(provider + ":" + external_user_id) base64url 前 24 字符>
```

然后调用 v2：

```http
POST <v2-internal-base>/internal/users
Authorization: Bearer <v2-internal-token>
Idempotency-Key: medevidence:<gateway_subject_id>:create_user
Content-Type: application/json
```

请求体：

```json
{
  "external_provider": "medevidence_backend",
  "external_user_id": "<gateway_subject_id>",
  "display_name": "V2 Joint Test",
  "metadata": {
    "source": "billing_signup",
    "billing_provider": "codex_gateway_v2_jointtest"
  }
}
```

注意：

- Gateway 不向 v2 传 `phone_e164`。
- Gateway 不向 v2 传 `scope_allowlist`。
- Gateway 传给 v2 的 `external_user_id` 不包含冒号，符合 `[A-Za-z0-9._-]{1,128}`。
- 如果 billing 侧没有 `display_name`，Gateway 会传 `internal:<gateway_subject_id>`。

## 4. v2 期望返回

成功：

```json
{
  "status": "created",
  "user": {
    "id": "v2_principal_xxx",
    "state": "active"
  },
  "key": {
    "id": "v2_key_xxx",
    "key": "mev2_live_xxx",
    "key_prefix": "mev2_live_xxx",
    "issued_at": "2026-05-11T00:00:00.000Z",
    "expires_at": null
  }
}
```

幂等 replay：

```json
{
  "status": "idempotent_replay",
  "user": {
    "id": "v2_principal_xxx",
    "state": "active"
  },
  "key": {
    "id": "v2_key_xxx",
    "key": "mev2_live_xxx",
    "key_prefix": "mev2_live_xxx",
    "issued_at": "2026-05-11T00:00:00.000Z",
    "expires_at": null
  }
}
```

重复 external user 但新 `Idempotency-Key`：

```json
{
  "error": "Principal already exists.",
  "error_code": "principal_already_exists",
  "user": {
    "id": "v2_principal_xxx",
    "state": "active"
  }
}
```

## 5. 第一轮联调顺序

1. v2 团队先用测试 token 自测 `POST /internal/users` 成功、同 key replay、同 external user 新 key 返回 `principal_already_exists`。
2. v2 团队把测试 base URL、token、allowlist 状态通过安全渠道给 Gateway 运维。
3. Gateway 运维在测试容器配置：
   - `GATEWAY_UPSTREAM_V2_BASE_URL`
   - `GATEWAY_UPSTREAM_V2_TOKEN`
   - `GATEWAY_UPSTREAM_V2_TIMEOUT_MS=5000`
4. Gateway 重启容器后，调用 `POST /gateway/admin/billing/v1/subjects` 创建测试 subject。
5. Gateway 验证响应包含：
   - `subject.id`
   - `credential.key`，前缀为 `cgu_live_`
   - `credential.key_prefix`
6. Gateway 调 `/gateway/unified-keys/resolve` 验证 opaque key 可解析出内部 Gateway key 和 v2 key。
7. Gateway 用同一个 billing `Idempotency-Key` replay，确认：
   - `idempotent_replay = true`
   - 不再返回 `credential.key` 原文，只返回 `key_prefix`
8. Gateway 调 `/subjects/{subject_id}/disable` 清理测试 subject。该步骤会调用 v2 `POST /internal/users/{v2_user_id}/disable`，v2 侧应禁用 principal 并 revoke active key。

## 6. 第一轮验收标准

- Gateway create subject 端到端返回 `200`。
- v2 收到且只收到一条 create 成功副作用；同幂等 key replay 不签第二把 key。
- v2 返回的 key 原文只进入 Gateway 加密存储和 opaque key resolve，不出现在 Gateway 日志。
- Gateway 对外只返回 `cgu_live_*`，不把 `mev2_live_*` 返回给收费团队或终端用户。
- disable 清理后，v2 principal 为 disabled，active v2 key 已被 revoke。
- disabled principal 的 v2 auth/validate-key 返回 `disabled_principal`，并优先于 `revoked_api_key`。

## 7. 当前状态

Gateway 侧 v2 自动开户注册主链路已通过。建议 v2 团队补充确认 smoke 对应 principal 已 disabled、active key 已 revoke，且 v2 auth/validate-key 对 disabled principal 返回 `disabled_principal` 并优先于 `revoked_api_key`。
