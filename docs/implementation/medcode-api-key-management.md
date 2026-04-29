# MedCode API key 管理方案

Last updated: 2026-04-28

## 目标

- 每个 API key 的发放、吊销、轮换、查看完整 key 都有审计记录。
- 管理员可以查询当前有效 API key，以及每个 key 对应的用户姓名和手机号。
- 未来签发的完整 API key 可以再次查询；默认列表不打印完整 key，避免误进日志。
- 管理员可以按 API key 或用户查询 request events 和 token usage 聚合。

## 当前实现状态

已实现：

- `issue --user --name --phone` 支持在签发 API key 时记录用户姓名和手机号。
- `update-user` 支持补录或修改用户姓名、手机号。
- `list-active-keys` 和 `list --active-only` 会按“未吊销、未过期、用户 active”过滤当前有效 key。
- 新签发和新轮换的 API key 会保存 `token_ciphertext`，管理员可通过 `reveal-key` / `reveal-keys` 查询完整 key。
- `events` 会输出每个请求的 token usage 字段。
- `report-usage` 会按天聚合 token usage。
- `admin_audit_events` 记录 key 发放、管理、reveal、吊销、轮换和用户状态变更。

当前限制：

- 历史 hash-only API key 无法从数据库反推出完整 key；如需“所有 key 始终可查完整值”，必须对历史有效 key 做 rotate，或在安全来源仍保存旧完整 key 时补录密文。
- 当前 CLI 支持 `--name` / `--phone`，但尚未在代码层强制缺失时拒绝签发；运维流程必须要求签发时填写。
- 目前只记录 token usage，不执行 token budget 阻断。

## 数据模型

`subjects` 保存用户档案：

- `id`
- `label`
- `name`
- `phone_number`
- `state`
- `created_at`

`access_credentials` 保存 API key：

- `prefix`
- `hash`
- `token_ciphertext`
- `subject_id`
- `label`
- `scope`
- `expires_at`
- `revoked_at`
- `rate_json`

`hash` 继续用于鉴权。`token_ciphertext` 用 `GATEWAY_API_KEY_ENCRYPTION_SECRET` 派生出的密钥加密完整 API key，只用于管理员 reveal。

历史 hash-only API key 不能从数据库反推完整 key；只有启用 `token_ciphertext` 后新签发或轮换的 key 可恢复。

## 管理命令

签发：

```bash
export GATEWAY_API_KEY_ENCRYPTION_SECRET="<operator-managed-secret>"
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" issue \
  --user alice \
  --name "Alice Zhang" \
  --phone "+15551234567" \
  --label "Alice laptop" \
  --scope code \
  --rpm 10 \
  --rpd 200 \
  --concurrent 4
```

查询用户和有效 key：

```bash
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" list-users
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" list-active-keys
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" list --user alice --active-only
```

更新用户姓名/手机号：

```bash
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" update-user alice \
  --name "Alice Chen" \
  --phone "+15557654321"
```

查询完整 API key：

```bash
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" reveal-key <credential-prefix>
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" reveal-keys --active-only
```

查询请求和 token usage：

```bash
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" events --user alice --limit 50
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" report-usage --user alice --days 7
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" report-usage --credential-id <credential-id> --days 7
```

`events` 输出：

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `cached_prompt_tokens`
- `estimated_tokens`
- `usage_source`

`report-usage` 聚合：

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `cached_prompt_tokens`
- `estimated_tokens`

吊销和轮换：

```bash
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" revoke <credential-prefix>
node apps/admin-cli/dist/index.js --db "$GATEWAY_SQLITE_PATH" rotate <credential-prefix> --grace-hours 24
```

## 有效 key 定义

`list-active-keys` 和 `list --active-only` 只返回同时满足以下条件的 key：

- `revoked_at` 为空。
- `expires_at` 晚于当前时间。
- 对应用户存在且 `state = active`。

## 审计

以下操作写入 `admin_audit_events`：

- `issue`
- `update-user`
- `update-key`
- `reveal-key`
- `revoke`
- `rotate`
- `disable-user`
- `enable-user`
- `prune-events`

审计行只记录用户 id、credential id、credential prefix、参数摘要、状态和错误信息，不记录完整 API key。
