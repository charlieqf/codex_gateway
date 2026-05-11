# MedEvidence Opaque Unified Key 跨仓库实施说明

Last updated: 2026-05-09

## 架构结论

本阶段采用 Gateway 托管的 broker 方案，外层 key 为：

```text
cgu_live_<64-char-base62-payload>
```

调用原则：

1. 客户端只持久保存 `cgu_live_*`。
2. 客户端调用 Codex Gateway 的 resolve 接口。
3. resolve 返回 Gateway API key 和 MedEvidence v2 API key。
4. 客户端继续分别调用 Codex Gateway 和 MedEvidence v2。

MedEvidence v2 不解析 `cgu_live_*`，不保存 Gateway key，也不需要知道 Codex Gateway。Codex Gateway 不代理 MedEvidence 请求，只保存 MedEvidence key ciphertext 以便 resolve。

## Resolve 接口契约

### Auth 边界

Gateway 必须按路由边界区分认证逻辑：

- `cgu_live_*` 仅允许用于 `POST /gateway/unified-keys/resolve`。
- `cgw.*` 仅允许用于 Gateway 业务接口，例如 `/v1/*`、`/sessions/*`、`/gateway/status`、`/gateway/credentials/current`。
- 跨边界一律返回 `401 invalid_credential`。
- 跨边界时不查表、不解析、不做兼容回退。
- resolve 路由使用独立 unified key resolver auth；Gateway 业务接口继续使用现有 `cgw.*` credential auth。不要把两类 key 放进同一个 bearer 校验中间件。

请求：

```http
POST /gateway/unified-keys/resolve
Authorization: Bearer cgu_live_...
```

响应：

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

客户端不得把 `cgu_live_*` 当成 Codex Gateway `/v1` 的 bearer，也不得发给 MedEvidence v2 服务端。

## 客户端实现合同

### 1. Resolve URL 怎么确定

优先级：

1. 如果 handoff/config 明确提供 `unified_key_resolve.url`，使用它。
2. 否则从当前 MedCode / Gateway provider API base 推导：把末尾 `/v1` 去掉，再拼 `/gateway/unified-keys/resolve`。
   - 例如 `https://gw.instmarket.com.au/v1` -> `https://gw.instmarket.com.au/gateway/unified-keys/resolve`。
3. 不建议在客户端硬编码单一生产域名；测试、灰度、区域化部署都应能通过配置切换。

近期发给 Desktop 的 `cgu_live_*` handoff 不保证一定包含 `unified_key_resolve.url`，因为当前 Gateway CLI 只输出 stdout，还没有固定 handoff 文件写入器。客户端必须实现第 2 条 fallback。联调和正式发放时建议运营尽量显式带上 `unified_key_resolve.url`，减少环境推导错误。

### 2. `codex_gateway.endpoint_base_url` 是否覆盖本地 provider API

`codex_gateway.endpoint_base_url` 是 resolve 后这组 runtime Gateway credential 的推荐调用地址。

- 如果返回非空，客户端本次运行应使用它调用 Gateway `/v1/*`。
- 不要把它永久写回用户配置；它是 runtime 结果，不是配置迁移。
- 如果为空，客户端继续使用本地已配置的 Gateway provider API base。

### 3. `medevidence.base_url` 是否覆盖当前 MedEvidence endpoint

`medevidence.base_url` 是 resolve 后这组 MedEvidence credential 的推荐调用地址。

- 如果返回非空，所有 MedEvidence v2 请求都使用这个 base，包括 `/validate-key`、`/ask/async`、`/request/:id`、PubMed 相关接口等同一 MedEvidence v2 服务下的路径。
- 如果为空，客户端继续使用当前本地配置或硬编码的 MedEvidence endpoint。
- 不要把它永久写回用户配置。

### 4. Resolve 成功响应的必填字段

HTTP 200 表示 resolve 成功，且必须是：

```json
{
  "valid": true,
  "codex_gateway": {
    "api_key": "cgw..."
  },
  "medevidence": {
    "api_key": "..."
  }
}
```

客户端必填校验：

- `valid === true`
- `codex_gateway.api_key` 为非空字符串
- `medevidence.api_key` 为非空字符串
- `unified_key.expires_at` 为可解析时间，缺失时按 resolver 响应异常处理

可空/可 fallback 字段：

- `codex_gateway.endpoint_base_url`：为空时使用本地 Gateway provider API base。
- `codex_gateway.credential_validation_url`：为空时从 Gateway base 推导 `/gateway/credentials/current`。
- `medevidence.base_url`：为空时使用本地 MedEvidence endpoint。
- `key_prefix` 类字段只用于诊断展示，不参与认证。

缺少必填字段时，不应提示“用户 key 无效”；应按 resolver 服务异常或响应格式异常处理。

### 5. 是否会 `200 valid:false`

不会。当前合同是：

- 成功：HTTP 200，`valid: true`
- 缺失、格式错误、hash 不匹配、过期、吊销：HTTP 401
- resolver 配置或服务异常：HTTP 503

客户端不需要支持 `200 valid:false` 作为正常分支。

### 6. Runtime credential 缓存策略

客户端可以缓存 resolve 返回的 runtime credentials，但建议只缓存到内存或系统安全凭据存储。

建议策略：

- App 启动时对 `cgu_live_*` resolve 一次。
- 内存缓存可用到 `unified_key.expires_at` 前，建议预留 5 分钟过期余量。
- 不要把 `codex_gateway.api_key` 或 `medevidence.api_key` 写普通日志。
- `cgu_live_*` revoke 只阻止后续 resolve；已经缓存的底层 runtime credentials 是否还能继续用，由对应底层服务自己的 key 状态决定。
- 运营如果要立即切断访问，应同时处理外层 `cgu_live_*` 和底层 Gateway / MedEvidence key。

底层 `cgw.*` 或 MedEvidence key 未来可能提前 revoke、expire 或轮换；客户端必须用 401 后重新 resolve 的流程兜底。

resolve 会校验底层 Gateway `cgw.*` credential 是否仍有效；不会预检 MedEvidence key。Gateway 不调用 MedEvidence，也不感知 MedEvidence key 是否 revoked、expired 或服务是否可用。MedEvidence key 的有效性由客户端调用 MedEvidence `/validate-key` 或实际业务接口时发现。

### 7. 底层请求 401 后的流程

仅对 `cgu_live_*` 模式适用：

1. 某个底层服务请求返回 401。
2. 清掉当前缓存的 runtime credentials。
3. 用原始 `cgu_live_*` 重新调用 resolve 一次。
4. 如果 resolve 成功，使用新返回的 runtime credential 重试原请求一次。
5. 如果重试仍为 401，提示用户 key 已失效或需要更换。
6. 如果 resolve 返回 401，提示用户更换 unified key。
7. 如果 resolve 返回 503，按服务暂不可用处理，允许稍后重试。

不要无限重试。MedCode / Gateway 和 MedEvidence 请求都适用这套流程。

### 8. Resolve 错误响应格式

非 200 响应格式：

```json
{
  "error": {
    "code": "invalid_credential",
    "message": "Invalid unified key.",
    "retry_after_seconds": 60
  }
}
```

`retry_after_seconds` 可缺省。

客户端应主要依赖 HTTP status 和 `error.code`：

- `401 missing_credential`
- `401 invalid_credential`
- `401 revoked_credential`
- `401 expired_credential`
- `503 service_unavailable`

当前 resolve 不返回 403。当前也没有 resolve 专用 429；如果未来加限流，会使用 `429 rate_limited` 和同样 JSON shape。

### 9. `credential_validation_url` 是否权威

如果 `codex_gateway.credential_validation_url` 非空，客户端应使用它验证返回的 `codex_gateway.api_key`。

调用时使用：

```http
GET <credential_validation_url>
Authorization: Bearer <codex_gateway.api_key>
```

如果该字段为空，从 Gateway base 推导 `/gateway/credentials/current`。

### 10. 新 key 格式

当前只支持：

```text
cgu_live_[A-Za-z0-9]{64}
```

没有 `cgu_test_`、`cgu_staging_`、变长 payload 或其他前缀。测试/灰度环境也使用同一 key 格式，通过 resolve URL / Gateway base 区分环境。

客户端遇到未知 `cgu_*` 前缀应按不支持的 key 格式处理，不要猜测。

### 11. 诊断和消息上传

`/gateway/client-events/*` 属于 Codex Gateway。

在 `cgu_live_*` 模式下：

- bearer 使用 `codex_gateway.api_key`
- host 使用本次运行选定的 Gateway base
  - 优先 `codex_gateway.endpoint_base_url` 去掉末尾 `/v1`
  - 否则使用本地 Gateway provider API base 去掉末尾 `/v1`

不要用 `cgu_live_*` 上传诊断；不要发到 MedEvidence host。

## 给 MedEvidence v2 仓库的说明

本方案不要求 MedEvidence v2 服务端改动。

请保持：

- 继续签发 MedEvidence v2 自己的 API key。
- 继续用 MedEvidence v2 自己的 key 认证医学问答请求。
- 不新增 Codex Gateway 依赖。
- 不解析、不存储、不验证 `cgu_live_*`。

如果需要配合运营发放，请提供或确认以下信息能进入交付 JSON 或人工交接：

- MedEvidence v2 明文 API key，仅一次性交给发放流程。
- MedEvidence key prefix，用于客服定位。
- MedEvidence base URL。
- key 过期时间、状态、用户标识等非敏感 metadata。

## 给 Desktop / 客户端仓库的说明

客户端需要同时支持旧格式和新格式。

旧格式：

```text
cmev1.<codex-gateway-api-key>.<medevidence-v2-api-key>
```

旧逻辑保持不变：拆分后分别调用两个服务。

新格式：

```text
cgu_live_<64-char-base62-payload>
```

客户端流程：

1. 识别 `cgu_live_*`。
2. 调用 `POST /gateway/unified-keys/resolve`，bearer 使用完整 `cgu_live_*`。
3. 保存或缓存返回的 `codex_gateway.api_key` 和 `medevidence.api_key`。
4. Codex Gateway / MedCode 请求使用 `codex_gateway.api_key`。
5. MedEvidence 医学问答请求使用 `medevidence.api_key`。
6. 当底层服务返回 401 时，可重新 resolve 一次；如果 resolve 也返回 401，则提示用户换 key。

升级兼容要求：

- 旧客户端 + 旧 `cmev1.*` 继续按现有逻辑工作。
- 新客户端 + 用户已保存的旧 `cmev1.*` 也必须继续按旧逻辑工作，不要求用户重新填写。
- 新客户端必须按固定前缀分支：`cmev1.` 走拆分逻辑，`cgu_live_` 走 resolve 逻辑。
- 新客户端升级时不要自动覆盖、删除或迁移用户已保存的 `cmev1.*`。
- 旧客户端不能使用 `cgu_live_*`，所以发放系统只能把新格式发给已支持 resolve 的客户端。

安全要求：

- 持久配置优先保存 `cgu_live_*`，不要把 resolve 出来的底层 key 写入普通日志。
- 日志、诊断、崩溃报告、UI 错误信息必须脱敏：
  - `cgu_live_[A-Za-z0-9]{64}`
  - `cmev1.*`
  - `cgw.<prefix>.<secret>`
  - MedEvidence v2 key

## 给 Codex Gateway 仓库的说明

Gateway 需要实现并维护：

- `cgu_live_*` issue/hash/verify。
- `unified_client_keys` SQLite 表。
- `codex_key_ciphertext` 和 `medevidence_key_ciphertext` 加密保存。
- Admin CLI：
  - `unified-key issue`
  - `unified-key list`
  - `unified-key show`
  - `unified-key revoke`
- `POST /gateway/unified-keys/resolve`。
- audit action：
  - `unified-key-issue`
  - `unified-key-resolve`
  - `unified-key-revoke`

Gateway 普通 credential auth 仍只接受 `cgw.*`。`cgu_live_*` 只允许用于 resolve 接口。resolve 成功会写轻量 `unified-key-resolve` audit；resolve 时还必须校验底层 Gateway `cgw.*` credential 未 revoked、未 expired。

## Handoff JSON 建议

当前 Codex Gateway CLI 的 `unified-key issue` 只输出 stdout，还没有直接写 handoff JSON 文件的 `--write-handoff` 能力。本节是交付 JSON 模板，供当前发放流程从 CLI stdout 组装；后续也可以把它固化成 CLI 文件输出选项。

新发放文件建议包含：

```json
{
  "unified_key_version": "cgu_live",
  "unified_key": "cgu_live_...",
  "unified_key_resolve": {
    "method": "POST",
    "url": "https://gateway.example/gateway/unified-keys/resolve"
  }
}
```

可选保留非敏感定位字段：

```json
{
  "codex_gateway": {
    "key_prefix": "abcd123456",
    "base_url": "https://gateway.example"
  },
  "medevidence": {
    "key_prefix": "mev2_live_abcd...",
    "base_url": "https://medevidence.example"
  }
}
```

不要在新 handoff JSON 中长期保留底层明文 key，除非是兼容旧 Desktop 的临时发放文件。

## 联调验收

1. Desktop 填入 `cgu_live_*` 后能完成 resolve。
2. Desktop 用 resolve 返回的 Gateway key 调通 Codex Gateway `/gateway/credentials/current`。
3. Desktop 用 resolve 返回的 MedEvidence key 调通医学问答服务。
4. MedEvidence v2 服务端没有新增 Gateway 配置或 Gateway API 调用。
5. Gateway `/v1` 直接使用 `cgu_live_*` 返回 401。
6. revoke 外层 `cgu_live_*` 后 resolve 返回 401。
7. 旧 `cmev1.*` 在旧客户端和升级后的新客户端里都仍可用，用户不需要重新填写 key。

补充验收：Gateway 底层 `cgw.*` revoked/expired 后，对应 `cgu_live_*` resolve 返回 401，而不是继续返回已失效的 Gateway key。
