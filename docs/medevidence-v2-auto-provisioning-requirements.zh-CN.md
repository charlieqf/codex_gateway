# MedEvidence v2 内部账号自动开通接口需求说明

日期：2026-05-11

本文面向 MedEvidence v2 服务团队，只描述 v2 需要提供的内部服务端接口。v2 不需要了解调用方后续如何对外封装、签发或分发访问凭证，也不需要关心外部客户端使用的 opaque key 形态。

## 1. 目标

MedEvidence 后端需要在用户注册建账时，同步向 v2 申请一个内部 principal 和一把 v2 API key。这个 principal/key 是 MedEvidence 后端内部资源，不直接暴露给终端用户或收费系统。

v2 需要提供可在 Web 请求路径中同步调用的 service-to-service HTTP API。该能力不能依赖人工操作、运维 CLI、邮件审批或异步工单。

## 2. P0 最终决策

### 2.1 身份映射

- P0 新增稳定外部映射字段，不要求调用方指定 v2 `principal_id`。
- v2 在 `api_principals` 增加 `external_provider` 和 `external_user_id`，并对 `(external_provider, external_user_id)` 建全局唯一索引，不使用 partial unique index。
- `external_provider` 固定为 `medevidence_backend`。
- `external_user_id` 是 MedEvidence 后端传入的稳定内部用户引用。v2 只按 opaque string 保存和匹配，不解析其格式，也不把它当手机号、邮箱或展示名。
- 同一 `(external_provider, external_user_id)` 终身只绑定一个 v2 principal。即使该 principal 后续被 disabled，create 也不能再创建新的 principal。
- P0 不支持 reopen/reactivate。未来如需要恢复 disabled principal，另行设计独立接口，不能复用 create。

### 2.2 display_name

- `POST /internal/users` 的 `display_name` 必填，必须是非空字符串。
- v2 现有 `api_principals.display_name TEXT NOT NULL` 保持不变。
- 如果 MedEvidence 后端没有用户可展示名称，调用方必须传非 PII 默认值：`internal:<external_user_id>`。
- `display_name` 仅用于 v2 内部排障展示，不能作为唯一键或身份匹配字段。
- `display_name` 长度限制：trim 后 1..200 个 Unicode 字符，且 UTF-8 编码后不超过 512 bytes；不得包含控制字符。

### 2.3 phone_e164

- P0 内部开户注册 API 不传 `phone_e164`。
- v2 P0 必须新增或复用等价字段 `principal_kind`，内部开户注册创建的 principal 必须写入 `principal_kind = 'internal_backend_user'`。
- v2 需要把内部 principal 的 `phone_e164` 放宽为 nullable，但只能对 `principal_kind = 'internal_backend_user'` 放宽。
- schema 必须有约束保护该规则：只有 `principal_kind = 'internal_backend_user'` 才允许 `phone_e164 IS NULL`；其他 principal_kind 如仍代表真实用户或人工开户注册，`phone_e164` 必须继续非空。
- 现有面向真实用户或人工开户注册的 principal 类型，如当前业务仍要求手机号，可以继续保持 `phone_e164` 必填。
- P0 不使用假手机号或占位手机号，避免把非真实手机号写入身份模型。

### 2.4 scope

- P0 不把 `scope_allowlist` 传给 v2。
- scope/capability enforcement 由 MedEvidence 后端负责；v2 只签发可被后端使用的内部 key。

### 2.5 重复 create

- 同一 `Idempotency-Key` 加同一 canonical request：返回历史结果。create 成功结果在重放保留期内必须返回同一 principal 和同一把 key。
- 同一 `Idempotency-Key` 加不同 canonical request：返回 `409 idempotency_conflict`。
- 同一 `(external_provider, external_user_id)` 加新的 `Idempotency-Key` 再次调用 create：返回 `409 principal_already_exists`，不签新 key。
- `principal_already_exists` 响应需要返回已有 user 的 `id` 和 `state`，但不得返回 key。
- 如果已有 principal 是 `disabled`，仍返回 `409 principal_already_exists`，`user.state = "disabled"`。P0 create 不负责恢复 disabled principal。
- 后续如需要补签新 key，应另行设计 rotate/sign-key 接口，不能复用 create。

### 2.6 key 原文重放

- v2 需要为内部 create 接口新增幂等记录表或等价持久化机制。
- 成功 create 事件必须保存加密后的 key 原文，否则无法满足“同一幂等 key 重放返回同一把 key”。
- 如果当前 `MEDEVIDENCE_API_KEY_VIEW_SECRET` 未配置，内部 create 接口应启动失败或返回 `503 service_unavailable`，不能静默降级为不可重放。
- 成功事件的完整 response 和加密 key 原文至少保留 7 天。
- 完整 response 过保留期后，可以清理加密 key 原文和 response_json，但必须永久或长期保留 idempotency tombstone，至少包含 `idempotency_key`、`request_hash`、`operation`、`external_provider`、`external_user_id`、`principal_id`、`api_key_id`、`status`、`created_at`、`response_expires_at`。
- tombstone 存在但完整 response 已过期时，同一 `Idempotency-Key` 再请求不得签新 key，返回 `409 idempotency_expired`。

### 2.7 内部接口鉴权

- 内部接口使用独立 bearer token 鉴权。
- 不复用终端用户 `X-API-Key` 或 `?api_key=` 鉴权链路。
- 建议环境变量：`MEDEVIDENCE_INTERNAL_API_TOKEN`、`MEDEVIDENCE_INTERNAL_API_TOKEN_NEXT`。
- current/next token 都使用常量时间比较，支持无中断轮换。
- 生产环境需要私网/VPC、反向代理来源限制或 IP allowlist。联调和生产 allowlist 规则需要分别验收。

### 2.8 错误体

内部接口沿用 v2 现有扁平错误体，避免调用方处理两套错误 shape：

```json
{
  "error": "Rate limit exceeded.",
  "error_code": "too_many_requests"
}
```

内部接口可以在错误体上附加结构化字段，例如 `user`，但 `error` 和 `error_code` 必须稳定存在。

### 2.9 key_prefix

- `key_prefix` 是固定长度前缀，不是完整 key。
- P0 固定为 key 原文前 24 个字符。
- 日志、审计和错误响应只能记录 `key_prefix`，不得记录完整 key。

## 3. 接口

### 3.1 创建内部 principal 并签发 key

```http
POST <v2-internal-base>/internal/users
Authorization: Bearer <internal-service-token>
Idempotency-Key: medevidence:<external_user_id>:create_user
Content-Type: application/json
```

请求体：

```json
{
  "external_provider": "medevidence_backend",
  "external_user_id": "me_user_xxx",
  "display_name": "internal:me_user_xxx",
  "metadata": {
    "source": "billing_signup"
  }
}
```

字段要求：

- `external_provider`：必填，P0 固定为 `medevidence_backend`。
- `external_user_id`：必填，稳定内部用户引用；ASCII，字符集 `[A-Za-z0-9._-]`，长度 1..128 bytes。P0 禁止冒号 `:`，因为 `Idempotency-Key` 使用冒号分隔字段。
- `display_name`：必填，非空字符串。没有真实展示名时传 `internal:<external_user_id>`。
- `metadata`：可选，只允许非敏感字段。P0 允许字段为 `source`、`signup_source`、`billing_provider`、`request_id`。总大小不超过 4KB，按 canonical JSON UTF-8 bytes 计算，不按 JavaScript/Python 字符数计算。
- 禁止在 `metadata` 传手机号、邮箱、身份证件、支付信息、地址、密码、token、完整 API key 或其他敏感字段。
- `Idempotency-Key`：ASCII，字符集 `[A-Za-z0-9._:-]`，长度 1..200 bytes。create 的 P0 格式必须是 `medevidence:<external_user_id>:create_user`。由于 `external_user_id` 禁止冒号，该格式可无歧义解析。
- v2 server 必须解析 `Idempotency-Key` 中的 `external_user_id`，并校验它与 body 中的 `external_user_id` 完全一致；不一致返回 `400 invalid_request`，不创建 principal，不写成功幂等记录。

成功响应：

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

`status` 可取：

- `created`
- `idempotent_replay`

重复 external user 且使用新 `Idempotency-Key` 时：

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

### 3.2 吊销 key

```http
POST <v2-internal-base>/internal/users/{v2_user_id}/keys/{v2_key_id}/revoke
Authorization: Bearer <internal-service-token>
Idempotency-Key: medevidence:<external_user_id>:revoke_key:<v2_key_id>
Content-Type: application/json
```

要求：

- 必须先校验 `v2_key_id` 属于 `v2_user_id`。
- 如果 key 不存在，或 key 不属于该 user，返回 `404 key_not_found`。服务端日志中可记录 `ownership_mismatch`，但不能静默吊销错 key。
- 如果 key 已经吊销，再次调用返回成功或 no-op，且必须保留首次吊销的 `revoked_at` 不变。
- server 必须解析 `Idempotency-Key` 中的 `external_user_id`，并校验它与 path 指向的 principal 绑定关系一致；不一致返回 `400 invalid_request`。
- 如果请求体或其他 header 中重复携带 external user 信息，也必须校验它与 path 指向的 principal 归属一致。

成功响应：

```json
{
  "revoked": true,
  "key": {
    "id": "v2_key_xxx",
    "state": "revoked"
  }
}
```

### 3.3 停用 user

```http
POST <v2-internal-base>/internal/users/{v2_user_id}/disable
Authorization: Bearer <internal-service-token>
Idempotency-Key: medevidence:<external_user_id>:disable_user
Content-Type: application/json
```

要求：

- 必须幂等。已停用时再次调用返回成功或 no-op。
- 停用语义为：把 principal 状态改为 `disabled`，并在同一事务内 revoke 该 principal 下所有 active key。
- 停用后，任何使用该 principal key 的 v2 auth/validate-key 路径都必须失败。
- 错误码复用现有 `disabled_principal`，不要新增 `principal_disabled`。
- disable 后即使 key 已被级联 revoke，auth/validate-key 对该 principal 的既有 key 也必须优先返回 `disabled_principal`，不能因为 key 已 revoked 而返回 `revoked_api_key`。
- v2 auth/validate-key 的判定顺序必须调整为：先确认 key hash/prefix 能匹配到某个 key 和 principal，再检查 principal 是否 `disabled`；如果 principal disabled，直接返回 `disabled_principal`；只有 principal 非 disabled 时才检查 key 是否 revoked/expired。
- server 必须解析 `Idempotency-Key` 中的 `external_user_id`，并校验它与 path 指向的 principal 绑定关系一致；不一致返回 `400 invalid_request`。

validate-key 或 auth 失败响应：

```json
{
  "error": "Principal is disabled.",
  "error_code": "disabled_principal"
}
```

成功响应：

```json
{
  "disabled": true,
  "user": {
    "id": "v2_principal_xxx",
    "state": "disabled"
  },
  "revoked_key_count": 1
}
```

## 4. 幂等与并发

### 4.1 canonical request hash

`request_hash` 不能只包含 JSON body。P0 定义如下：

```text
sha256(
  method + "\n" +
  operation + "\n" +
  normalized_route_template + "\n" +
  canonical_path_params + "\n" +
  canonical_json_body
)
```

要求：

- `method` 使用大写 HTTP method。
- `operation` 使用稳定操作名，例如 `create_user`、`revoke_key`、`disable_user`。
- `normalized_route_template` 使用路由模板，例如 `/internal/users/{v2_user_id}/disable`。
- `canonical_path_params` 使用字段名排序后的 JSON。
- `canonical_json_body` 使用字段名排序后的 JSON；无 body 时使用 `{}`。
- `Idempotency-Key` 不进入 hash。它是幂等记录 key，不是请求语义的一部分。
- 同一 `Idempotency-Key` 命中已有记录时，先比较 `request_hash`。hash 不一致返回 `409 idempotency_conflict`。
- 虽然 `Idempotency-Key` 不进入 `request_hash`，server 仍必须解析 key 中的 `external_user_id`，并在 create/revoke/disable 中校验它与 body 或 path 归属一致。该校验是请求归属校验，不是 hash 输入。
- `Idempotency-Key` 归属不一致返回 `400 invalid_request`；同一 `Idempotency-Key` 已有记录但 `request_hash` 不一致返回 `409 idempotency_conflict`。

### 4.2 建议表结构

建议新增表，例如 `internal_idempotency_events`：

```sql
CREATE TABLE internal_idempotency_events (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  external_provider TEXT,
  external_user_id TEXT,
  principal_id TEXT,
  api_key_id TEXT,
  api_key_ciphertext TEXT,
  api_key_ciphertext_version TEXT,
  api_key_ciphertext_kid TEXT,
  status TEXT NOT NULL,
  response_json TEXT,
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  response_expires_at TEXT,
  tombstone_retained_at TEXT
);

CREATE INDEX idx_internal_idempotency_external_user
  ON internal_idempotency_events(external_provider, external_user_id, created_at DESC);
```

`status` 建议至少支持：

- `in_progress`
- `succeeded`
- `failed`
- `expired`

`failed` 必须结合 `error_code` 和 `retryable` 判定重试语义：

- `retryable = 0` 是终态失败。同一 `Idempotency-Key` + 同一 `request_hash` 后续请求必须稳定 replay 原错误，不重新执行副作用。示例：`principal_already_exists`、`key_not_found`、`invalid_request`、`idempotency_expired`。
- `retryable = 1` 是可重试失败。同一 `Idempotency-Key` + 同一 `request_hash` 后续请求可以在事务内把记录重新置为 `in_progress` 并重试。示例：`service_unavailable`、存储暂不可用、崩溃恢复后无法确认结果但确认没有成功 response。
- 无论 `retryable` 如何，同一 `Idempotency-Key` + 不同 `request_hash` 都返回 `409 idempotency_conflict`。
- 鉴权失败不应写入幂等记录；缺少或错误 bearer token 直接返回 401。

key 原文加密要求：

- `api_key_ciphertext_version` 必填，P0 建议值如 `v1:aes-256-gcm`，用于说明密文格式和算法。
- `api_key_ciphertext_kid` 可选但强烈建议填写，表示加密密钥版本或 KMS key id。
- v2 必须支持解密当前密钥和至少一个旧密钥；密钥轮换后，旧解密密钥必须至少保留到所有成功 create 幂等 response 过 7 天重放窗口。
- 轮换 `MEDEVIDENCE_API_KEY_VIEW_SECRET` 或 KMS key 时，不要求立即重加密历史幂等记录，但必须保证 `api_key_ciphertext_kid` 指向的旧 key 在重放窗口内可用。
- 如果密文因密钥轮换配置错误无法解密，重放请求返回 `503 service_unavailable`，不得签发新 key。

### 4.3 create 并发顺序

同一 external user 并发 create 必须保证最多只签一把 key。

建议事务顺序：

1. 开启写事务，或获取等价的数据库锁。
2. 插入或读取 `internal_idempotency_events`。
3. 如果同一 `Idempotency-Key` 已是 `in_progress`，返回 `409 idempotency_in_progress`，并带 `Retry-After: 1`。
4. 如果同一 `Idempotency-Key` 已 `succeeded` 且 `request_hash` 一致，在保留期内返回同一 response；过保留期返回 `409 idempotency_expired`。
5. 如果同一 `Idempotency-Key` 的 `request_hash` 不一致，返回 `409 idempotency_conflict`。
6. 对新 `Idempotency-Key`，先写入 `in_progress` 记录。
7. 插入 principal，依赖 `(external_provider, external_user_id)` 唯一约束。
8. 如果唯一约束冲突，更新幂等记录为 `failed`、`error_code = 'principal_already_exists'`、`retryable = 0`，返回 `409 principal_already_exists`，附已有 user 的 `id` 和 `state`，不签 key。
9. 只有 principal 创建成功后，才创建 key、保存加密 key 原文、保存 response_json，并把幂等记录更新为 `succeeded`。
10. 提交事务后返回成功。

异常恢复：

- `in_progress` 记录需要有服务端超时策略，建议 60 秒后可标记为 `failed` 或由后台清理任务接管。
- 超时清理如无法确认副作用是否已经成功，必须标记为 `failed`、`retryable = 1` 或继续返回 `idempotency_in_progress`；不能标记为终态失败后又允许重新执行会产生第二把 key 的副作用。
- 如果进程崩溃后 principal/key 已落库但幂等记录未完成，恢复逻辑必须按已有 principal/key 修正记录或返回 `service_unavailable`，不能再签第二把 key。

## 5. 错误码

| HTTP | error_code | 场景 |
| --- | --- | --- |
| 400 | `invalid_request` | 字段缺失、格式错误、metadata 非法 |
| 401 | `missing_internal_token` | 缺少内部 bearer token |
| 401 | `invalid_internal_token` | 内部 bearer token 错误 |
| 404 | `principal_not_found` | user 不存在 |
| 404 | `key_not_found` | key 不存在或不属于该 user |
| 409 | `idempotency_conflict` | 同幂等 key canonical request 不一致 |
| 409 | `idempotency_in_progress` | 同幂等 key 请求仍在处理中，响应带 `Retry-After` |
| 409 | `principal_already_exists` | 同 external user 用新幂等 key 重复 create |
| 409 | `idempotency_expired` | 幂等 tombstone 存在，但完整 response 已过保留期 |
| 429 | `too_many_requests` | v2 内部接口限流，响应带 `Retry-After` |
| 503 | `service_unavailable` | key 加密配置缺失、存储不可用或依赖不可用 |

现有 auth/validate-key 遇到 disabled principal 时继续使用：

| HTTP | error_code | 场景 |
| --- | --- | --- |
| 401/403 | `disabled_principal` | principal 已停用 |

## 6. 运维与安全要求

- v2 需要提供测试和生产两个 internal base URL。
- internal token 通过安全渠道交付，不能写入代码、文档样例或工单明文。
- token 轮换必须支持 current/next 双 token 验收：新 token 加入后两者都可用，切换完成后旧 token 被拒绝。
- 生产入口需要私网/VPC、反向代理来源限制或 IP allowlist。测试和生产 allowlist 分开配置。
- create 接口客户端超时按 5 秒设计。v2 P95 建议不超过 1 秒。
- v2 需要定义内部接口限流额度；触发限流时返回 `429 too_many_requests` 和 `Retry-After`。
- v2 日志不得记录完整 bearer token、完整 v2 key、加密前 key 原文或敏感 metadata。
- 审计日志至少记录 operation、principal_id、api_key_id、key_prefix、external_provider、external_user_id、status、error_code、request_id、created_at。

## 7. 联调验收

1. create 成功返回 principal 和 key。
2. create 请求不需要 `phone_e164`，v2 内部 principal 可落库且 `phone_e164` 为 null。
3. 内部 principal 必须写入 `principal_kind = 'internal_backend_user'`，且 schema 约束只允许该 kind 的 `phone_e164` 为空。
4. create 请求必须带非空 `display_name`；缺失时返回 `400 invalid_request`。
5. `external_user_id` 包含冒号或超过 128 bytes 时返回 `400 invalid_request`。
6. `Idempotency-Key` 中的 `external_user_id` 与 body 或 path 归属不一致时返回 `400 invalid_request`。
7. 同一 `Idempotency-Key` 重放返回同一 principal、同一 key，`status = idempotent_replay`。
8. 同一 `Idempotency-Key` 改 method、path、path params 或 body，返回 `409 idempotency_conflict`。
9. 同一 `external_user_id` 用新 `Idempotency-Key` create，返回 `409 principal_already_exists`，响应包含已有 user id/state，不返回 key；同一 key 后续重放稳定返回同一终态错误。
10. 成功事件完整 response 过期后，同一 `Idempotency-Key` 返回 `409 idempotency_expired`，不会签新 key。
11. 两个不同 `Idempotency-Key` 并发 create 同一 `external_user_id`，最多只有一个成功并签 key，另一个稳定返回 `409 principal_already_exists` 或在同幂等 key 场景返回 `409 idempotency_in_progress`。
12. 可重试失败记录使用同一 `Idempotency-Key` + 同一 `request_hash` 可重试；终态失败记录必须 replay 原错误。
13. 加密 key 原文必须记录 ciphertext version，密钥轮换后旧解密密钥至少保留 7 天重放窗口。
14. 未配置 key 原文加密 secret 时 create 不可用，并返回明确配置错误。
15. revoke 校验 user/key 归属，不会吊销其他 user 的 key；重复 revoke 保持首次 `revoked_at` 不变。
16. disable 会禁用 principal 并 revoke 所有 active key。
17. disabled principal 的 key 无法通过 v2 auth/validate-key，错误码为 `disabled_principal`；该错误优先于 `revoked_api_key`。
18. 日志和审计中只能看到 `key_prefix`，不能看到完整 key 或 bearer token。
