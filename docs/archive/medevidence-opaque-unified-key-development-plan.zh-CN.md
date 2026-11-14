# MedEvidence 单个 Opaque Unified Key 开发方案

Last updated: 2026-05-09

## 结论

采用 **Codex Gateway 托管的 client unified key broker** 方案。

新的外层 key 使用 Gateway 归属的格式：

```text
cgu_live_<64-char-base62-payload>
```

`cgu` 表示 Codex Gateway Unified client key。它不是 MedEvidence v2 key，也不是普通 Codex Gateway API key。

客户端只需要填写这一个 `cgu_live_*`。启动或换 key 时，客户端调用 Gateway 的 resolve 接口，把外层 key 换成两个运行时 credential：

- Codex Gateway API key：`cgw.<prefix>.<secret>`，用于调用 Codex Gateway / MedCode。
- MedEvidence v2 API key：由 MedEvidence v2 自己签发，用于调用 MedEvidence 医学问答服务。

MedEvidence v2 不需要知道 Codex Gateway，不需要解析 `cgu_live_*`，也不保存 Gateway key。Codex Gateway 不代理 MedEvidence 请求，不调用 MedEvidence API；它只在 broker 表里保存 MedEvidence key 的密文，用于 resolve 时返回给客户端。

## 为什么选这个方案

这个方案把系统复杂度控制在 Codex Gateway 仓库内，避免新增独立 resolver 服务，同时保持两个业务服务的边界：

- MedEvidence v2 继续做单纯医学问答服务，只签发和验证自己的 key。
- Codex Gateway 继续只用 `cgw.*` 作为自身 `/v1`、`/sessions` 等业务接口的 credential。
- `cgu_live_*` 只用于 Gateway 的 resolve 接口，不直接作为 Gateway 业务接口 bearer。
- 客户端配置体验变成一个 key；底层两个 key 仍可分别签发、轮换、吊销。

取舍是：Codex Gateway broker 会保存 MedEvidence key ciphertext。这是本方案唯一新增耦合点。它不是运行时业务依赖，也不要求 Gateway 理解 MedEvidence 的问答业务。

如果目标升级为“客户端永远拿不到底层 MedEvidence key”，则需要 Gateway 代理 MedEvidence 请求或新增独立 resolver/proxy 服务。本阶段不采用。

## 旧 key 兼容

当前已发放格式继续保留：

```text
cmev1.<codex-gateway-api-key>.<medevidence-v2-api-key>
```

要求：

1. 已发放的 `cmev1.*` 在底层两个 key 未过期、未 revoke 时继续可用。
2. provisioning 脚本默认仍生成 `cmev1.*`，直到 Desktop 和 Gateway resolve 方案完成联调。
3. `cgu_live_*` 不进入普通 Gateway credential auth，避免影响现有 `cgw.*` 认证路径。
4. 日志、audit、错误响应、测试输出不得泄露完整 `cmev1.*`、`cgu_live_*`、`cgw.*` 或 MedEvidence v2 key。

## Key 形态

```text
cgu_live_<64-char-base62-payload>
```

规则：

- full key 正则：`^cgu_live_[A-Za-z0-9]{64}$`
- payload 前 16 位作为公开 prefix。
- 服务端保存 `SHA-256(full_key)`，明文只在 issue 时返回一次。
- 解析时匹配固定前缀 `cgu_live_` 和固定 payload 长度，不使用下划线 split 推断结构。

示例：

```text
cgu_live_7KpQ2mN9vX4aRt6Bc8YwL3sD0fGhJkPq9UzEaVnTbR5xM1HdS7rZ2yA4C6mNp8Qz
```

## 数据模型

Codex Gateway 新增 broker 表 `unified_client_keys`：

```text
id
prefix
hash
subject_id
label
expires_at
revoked_at
codex_credential_id
codex_credential_prefix
codex_key_ciphertext
medevidence_key_ciphertext
medevidence_key_prefix
created_at
metadata_json
```

说明：

- `hash` 用于验证 `cgu_live_*`。
- `codex_key_ciphertext` 保存可恢复的 Gateway API key 密文。
- `medevidence_key_ciphertext` 保存 MedEvidence v2 API key 密文。
- `medevidence_key_prefix` 只用于客服和运营定位。
- `metadata_json` 可保存 `medevidence_base_url` 等客户端 resolve 后需要的非敏感信息。
- 密文使用现有 `GATEWAY_API_KEY_ENCRYPTION_SECRET` 派生密钥加密；生产环境必须保持该 secret 稳定。

## Gateway 接口

### Auth 边界

这条边界必须作为实现约束写死，不能只作为调用约定：

- `cgu_live_*` 仅允许用于 `POST /gateway/unified-keys/resolve`。
- `cgw.*` 仅允许用于 Gateway 业务接口，例如 `/v1/*`、`/sessions/*`、`/gateway/status`、`/gateway/credentials/current`。
- 跨边界一律返回 `401 invalid_credential`。
- 跨边界时不查表、不解析、不做兼容回退。例如业务接口收到 `cgu_live_*` 时应在格式层直接拒绝，resolve 接口收到 `cgw.*` 时也应在格式层直接拒绝。
- 中间件按路由分组挂载：业务接口使用现有 Gateway credential auth，resolve 接口使用独立 unified key resolver auth。不要共用一个“查 hash 即通过”的 bearer 校验函数。

新增公开 resolve 接口：

```http
POST /gateway/unified-keys/resolve
Authorization: Bearer cgu_live_...
```

成功响应：

```json
{
  "valid": true,
  "unified_key": {
    "prefix": "7KpQ2mN9vX4aRt6B",
    "label": "Desktop unified key",
    "expires_at": "2026-07-01T00:00:00.000Z"
  },
  "subject": {
    "id": "user_123",
    "label": "User 123"
  },
  "codex_gateway": {
    "endpoint_base_url": "https://gateway.example/v1",
    "credential_validation_url": "https://gateway.example/gateway/credentials/current",
    "key_prefix": "abcd123456",
    "api_key": "cgw.abcd123456..."
  },
  "medevidence": {
    "base_url": "https://medevidence.example",
    "key_prefix": "mev2_live_abcd...",
    "api_key": "mev2_live_..."
  }
}
```

错误语义：

- 缺少 bearer：`401 missing_credential`
- 格式错误、hash 不匹配、用户不可用：`401 invalid_credential`
- 已吊销：`401 revoked_credential`
- 已过期：`401 expired_credential`
- broker store 或加密 secret 未配置：`503 service_unavailable`

## Admin CLI

新增命令组：

```powershell
codex-gateway-admin unified-key issue `
  --user <user-id> `
  --codex-credential-prefix <cgw-prefix> `
  --medevidence-key-env <env-name> `
  --medevidence-base-url <url> `
  --label "Desktop unified key" `
  --expires-days 56
```

当前实现只在 stdout 输出 `unified_key`、公开 metadata 和 resolve 路径；还没有 `--write-handoff` 文件写入能力。若运营需要交付 JSON，现阶段应由发放流程从 stdout 生成文件，或后续再给 CLI 增加 `--write-handoff <path>`。

输出只返回完整 `cgu_live_*` 一次，不返回底层 `cgw.*` 或 MedEvidence 明文 key。

辅助命令：

```powershell
codex-gateway-admin unified-key list --user <user-id> --active-only
codex-gateway-admin unified-key show <prefix>
codex-gateway-admin unified-key revoke <prefix>
```

audit action：

- `unified-key-issue`
- `unified-key-resolve`
- `unified-key-revoke`

resolve 成功会写一条轻量 `unified-key-resolve` audit，便于排查外层 key 被重复 resolve 或客户端启动行为。

audit params 只允许保存 prefix、label、expiry、base URL 等非敏感字段。

## Desktop 调用流程

客户端配置可能来自用户粘贴、handoff JSON 或环境变量。

1. 如果 key 是 `cmev1.*`，沿用旧逻辑拆分成 Gateway key 和 MedEvidence key。
2. 如果 key 是 `cgu_live_*`：
   - 不在客户端拆分。
   - 调用 `POST /gateway/unified-keys/resolve`。
   - 将返回的 `codex_gateway.api_key` 用于 Codex Gateway 请求。
   - 将返回的 `medevidence.api_key` 用于 MedEvidence v2 请求。
3. 客户端应只把 `cgu_live_*` 作为持久配置保存；resolve 得到的底层 key 尽量只保存在内存或系统安全凭据存储中。
4. 当 resolve 返回 401 时，提示用户换 key；当底层服务返回 401 时，可重新 resolve 一次以支持服务端轮换。

客户端升级兼容要求：

- 旧客户端 + 已填写的 `cmev1.*` 必须继续工作。
- 新客户端 + 已保存的 `cmev1.*` 必须继续工作，且不要求用户重新填写 key。
- 新客户端不能把所有 unified key 都当成 `cgu_live_*`；必须先按固定前缀分支。
- 新客户端不要在升级时自动删除、覆盖或迁移用户已保存的 `cmev1.*`。
- 旧客户端无法使用新发的 `cgu_live_*`；运营发放新格式前必须确认客户端版本支持 resolve。

## 其他仓库需要做什么

### MedEvidence v2

不需要支持 `cgu_live_*`，不需要知道 Codex Gateway。

需要继续提供或保持：

- 自己的 API key 签发能力。
- 可交给运营或 Gateway CLI 的明文 key 一次性输出渠道。
- key prefix、base URL、过期时间等非敏感 metadata。
- 自己服务端对 MedEvidence key 的验证、吊销、过期逻辑。

### Desktop / 客户端

需要支持：

- 识别 `cgu_live_*`。
- 调用 Gateway resolve 接口。
- resolve 后分别使用两个返回 credential 调两个服务。
- 保留 `cmev1.*` 兼容逻辑。
- 日志和错误上报脱敏 `cgu_live_*`、`cmev1.*`、`cgw.*`、MedEvidence key。

### Codex Gateway

需要完成：

- `cgu_live_*` issue/hash/verify core。
- SQLite broker 表和迁移。
- Admin CLI `unified-key` 命令组。
- `POST /gateway/unified-keys/resolve`。
- resolve 时校验底层 Gateway `cgw.*` credential 未 revoked、未 expired。
- build/test 覆盖。
- 更新 provisioning 文档，说明当前脚本仍只发 `cmev1.*`；`cgu_live_*` 由新的 CLI 路径签发。

## 发布顺序

1. Gateway 完成 broker 表、CLI、resolve 接口和测试。
2. Gateway 先手动给测试用户签发 `cgu_live_*`，不影响现有 `cmev1.*`。
3. Desktop 加入 `cgu_live_*` resolve 支持，并继续兼容 `cmev1.*`。
4. 联调：同一用户同时验证医学问答和 Gateway / MedCode 请求。
5. 新发用户逐步改用 `cgu_live_*`，保留旧格式回滚能力。

## 验收条件

1. `cgu_live_*` 可以 resolve 出 Gateway 和 MedEvidence 两个 runtime credential。
2. resolve 后客户端能分别调用 Codex Gateway 和 MedEvidence v2。
3. MedEvidence v2 服务端没有新增 Gateway 依赖。
4. Gateway 普通业务接口不接受 `cgu_live_*` 作为 `cgw.*` 替代品。
5. revoke `cgu_live_*` 后 resolve 失败，但不自动 revoke 底层两个 key。
6. 已发放 `cmev1.*` 在旧客户端和升级后的新客户端里都继续可用，用户不需要重新填写 key。
7. 旧客户端不会收到 `cgu_live_*`，除非已经确认该客户端版本支持 resolve。
8. 日志、audit、错误响应、后台输出没有完整底层 key 泄露。

补充验收：resolve 时必须校验底层 Gateway `cgw.*` credential 仍然有效；底层 Gateway credential revoked/expired 时，resolve 也返回对应 401，而不是继续返回已失效的 Gateway key。

## 回滚

如果 `cgu_live_*` 上线后出现问题：

1. 停止新发 `cgu_live_*`。
2. Desktop 配置回退到 `cmev1.*`。
3. 对已发 `cgu_live_*` 执行 revoke。
4. 底层 `cgw.*` 和 MedEvidence key 不会因为 revoke 外层 key 自动失效，可继续用于重新生成 `cmev1.*` 或重新签发新的 `cgu_live_*`。
