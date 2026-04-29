# MedCode Gateway 客户端用户消息上传方案草案

状态：MedCode Gateway 团队已评审；一期实现边界已确认  
发起方：MedEvidence Desktop  
范围：Gateway 侧接口、认证、存储、审计边界  
不包含：Desktop 端具体实现、Gateway 代码改动

## 需求背景

MedEvidence Desktop 目前在本地保存用户与 agent 的会话。为了支持后续质量追踪、用户问题复盘、医学场景使用情况分析和客服排障，我们希望将用户在 Desktop 中发出的消息同步到 MedCode Gateway 服务器。

这不是模型请求代理日志，也不是完整会话上传。需求明确限定为：

- 只上传 message metadata。
- 只上传用户本轮问题文本。
- 不上传系统 prompt、agent prompt、开发者 prompt。
- 不上传模型回答、工具调用参数、工具输出、MedEvidence 检索结果。
- 不上传附件正文、图片内容、文件内容或完整上下文历史。
- 不上传 API key、本地环境变量、本地路径或内部模型细节。

Desktop 侧会在用户消息创建后触发异步上传。Gateway 侧需要提供一个独立的客户端消息事件入口，用现有 MedCode credential 完成认证和用户归属。

## 设计目标

1. 提供一个独立于模型请求的消息事件 ingest API。
2. Gateway 根据 bearer credential 派生 `credential_id`、`subject_id`、`scope`，不信任客户端自报的用户归属。
3. 存储用户原始问题文本和有限 metadata，便于后续按用户、credential、session、时间排查。
4. 不把该事件计入模型请求次数、token usage 或并发模型请求限制。
5. 接口具备幂等能力，Desktop 重试不会产生重复事件。
6. 失败不影响 Desktop 正常对话链路。

## 非目标

- 不通过该接口转发模型请求。
- 不保存模型输入的完整 assembled prompt。
- 不保存 assistant 回复或 tool result。
- 不实现会话回放。
- 不替代现有 request observation/token usage 表。
- 不要求 Gateway 理解 Desktop 的完整 message part 结构。
- 一期不提供管理端全文查询 UI。

## Gateway 一期边界（最终）

以下为一期实现硬性边界。除“待继续确认的问题”外，本文中的接口、存储、限流和隐私约束都按一期要求执行，不再作为可选建议。

1. 接口路径采用 `POST /gateway/client-events/messages`。
2. 使用现有 MedCode credential auth，用户归属只从 bearer credential 派生。
3. `text` 最大长度固定为 64KB，按 JSON 解析后 `text` 字符串的 UTF-8 byte length 计算；超过限制返回 `413 Payload Too Large` 或 `400 invalid_request`。
4. 事件写入专用 SQLite 数据库 `client-events.db`，不写入主 `gateway.db`。
5. `client-events.db` 内使用独立 `client_message_events` 表；不复用 `request_events`，不进入 token usage 聚合。
6. Gateway 保存 `text_sha256`，用于排障、去重和安全审计。
7. 幂等唯一键按用户归属隔离，采用 `UNIQUE(subject_id, event_id)`，不使用全局 `event_id` 主键。重复提交只在 `text_sha256`、`session_id`、`message_id` 与既有记录一致时返回 `duplicate: true`；不一致必须返回 `409 conflict`，且不得覆盖既有记录。
8. 该路由必须跳过模型请求限流和 request observation，但必须使用独立 ingest 限流。
9. 一期默认 ingest 限流为每 credential 每分钟 60 条、每天 2000 条；后续可通过配置调整。
10. 附件只接受 metadata。附件对象中出现 `content`、`data`、`base64`、`text`、`path` 等正文或本地路径字段时直接拒绝，不做静默忽略。
11. 生产日志、错误日志、审计日志不得记录完整 `text`；只记录 `event_id`、用户/key 标识、长度、`text_sha256` 和错误码。
12. 一期不开放管理端全文查询；如后续需要查看全文，必须增加单独权限和审计。
13. 扩大使用前必须明确数据保留周期、删除策略和按 `subject_id` 删除能力。

### 一期交付范围

一期包含：

- `POST /gateway/client-events/messages` 写入接口。
- 独立 `client-events.db` 初始化、migration 和 `client_message_events` 写入。
- credential 派生 `credential_id`、`subject_id`、`scope`。
- 请求 schema 校验、64KB UTF-8 byte length 文本限制、附件 metadata 安全校验。
- `text_sha256` 计算和存储。
- `UNIQUE(subject_id, event_id)` 幂等写入。
- 独立 ingest rate limit。
- route 级 `skipObservation`，确保不写 `request_events`。
- 单元测试和至少一次 public smoke。

一期不包含：

- 管理端全文查询 UI。
- 全文搜索、会话回放、模型回答/工具结果上传。
- 把 client events 计入 request usage、token usage 或模型请求限额。
- 把用户原文写入主 `gateway.db`。
- Postgres/独立 ingest 服务迁移。
- 批量导出。

一期上线前必须配置：

- `GATEWAY_CLIENT_EVENTS_SQLITE_PATH`
- ingest rate limit 阈值
- `text` 最大长度 64KB，按 UTF-8 byte length 计算
- 附件数量上限 20

## 接口

```http
POST /gateway/client-events/messages
Authorization: Bearer <medcode-api-key>
Content-Type: application/json
```

该接口沿用 Gateway 当前 credential auth 机制。统一 key 场景下，Desktop 会从 `cmev1.<medcode-key>.<medevidence-key>` 中提取 MedCode half 作为 bearer token。

### 客户端调用示例

#### 从统一 key 提取 MedCode bearer token

统一 key 格式：

```text
cmev1.<medcode-key>.<medevidence-key>
```

解析规则：

- 必须以 `cmev1.` 开头。
- 去掉 `cmev1.` 后，最后一个 `.` 之前的全部内容是 MedCode key。
- 最后一个 `.` 后面的内容是 MedEvidence key。
- MedCode key 必须以 `cgw.` 开头。

TypeScript 示例：

```ts
export function parseUnifiedKey(unifiedKey: string): {
  medcodeKey: string;
  medevidenceKey: string;
} {
  const prefix = "cmev1.";
  if (!unifiedKey.startsWith(prefix)) {
    throw new Error("Unified key must start with cmev1.");
  }

  const body = unifiedKey.slice(prefix.length);
  const splitAt = body.lastIndexOf(".");
  if (splitAt <= 0 || splitAt === body.length - 1) {
    throw new Error("Unified key is malformed.");
  }

  const medcodeKey = body.slice(0, splitAt);
  const medevidenceKey = body.slice(splitAt + 1);
  if (!medcodeKey.startsWith("cgw.")) {
    throw new Error("MedCode key must start with cgw.");
  }

  return { medcodeKey, medevidenceKey };
}
```

#### curl 示例

```bash
curl -sS https://gw.instmarket.com.au/gateway/client-events/messages \
  -H "Authorization: Bearer $MEDCODE_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "schema": "client_message.v1",
    "event_id": "01JZEXAMPLE000000000000000",
    "session_id": "ses_01JZEXAMPLE",
    "message_id": "msg_01JZEXAMPLE",
    "created_at": "2026-04-29T10:00:00.000Z",
    "app": {
      "name": "medevidence-desktop",
      "version": "1.4.6"
    },
    "agent": "research",
    "provider_id": "medcode",
    "model_id": "medcode",
    "engine": "agent",
    "text": "系统性红斑狼疮最新研究进展",
    "attachments": [
      {
        "type": "file",
        "filename": "report.pdf",
        "mime": "application/pdf",
        "size": 123456
      }
    ]
  }'
```

#### TypeScript fetch 示例

```ts
type ClientMessageUpload = {
  schema: "client_message.v1";
  event_id: string;
  session_id: string;
  message_id: string;
  created_at: string;
  app: {
    name: "medevidence-desktop";
    version?: string;
  };
  agent?: string;
  provider_id?: string;
  model_id?: string;
  engine?: "agent" | "medevidence-direct";
  text: string;
  attachments?: Array<{
    type: "file" | "image" | string;
    filename?: string | null;
    mime?: string | null;
    size?: number | null;
  }>;
};

export async function uploadClientMessage(input: {
  baseUrl: string;
  medcodeApiKey: string;
  event: ClientMessageUpload;
}): Promise<{ ok: true; event_id: string; duplicate: boolean; received_at?: string }> {
  if (new TextEncoder().encode(input.event.text).length > 64 * 1024) {
    throw new Error("Client message text exceeds 64KB UTF-8 byte length.");
  }

  const response = await fetch(`${input.baseUrl}/gateway/client-events/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.medcodeApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input.event)
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Upload failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}
```

客户端调用约束：

- `medcodeApiKey` 使用统一 key 中解析出的 MedCode key，不要把完整统一 key 作为 bearer token。
- `text` 只放用户本轮输入的 text parts。
- `text` 上限按 JSON 解析后字符串的 UTF-8 byte length 计算，不能按 JavaScript string length 计算。
- `attachments` 只放 metadata，不得包含文件正文、base64、OCR 文本、本地路径或检索结果。
- 上传失败不得阻塞用户对话；Desktop 应作为后台队列重试。

### 请求体

```json
{
  "schema": "client_message.v1",
  "event_id": "01JZEXAMPLE000000000000000",
  "session_id": "ses_01JZEXAMPLE",
  "message_id": "msg_01JZEXAMPLE",
  "created_at": "2026-04-29T10:00:00.000Z",
  "app": {
    "name": "medevidence-desktop",
    "version": "1.4.6"
  },
  "agent": "research",
  "provider_id": "medcode",
  "model_id": "medcode",
  "engine": "agent",
  "text": "系统性红斑狼疮最新研究进展",
  "attachments": [
    {
      "type": "file",
      "filename": "report.pdf",
      "mime": "application/pdf",
      "size": 123456
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema` | string | 是 | 固定为 `client_message.v1`，用于后续版本演进。 |
| `event_id` | string | 是 | Desktop 生成的幂等事件 ID，建议 ULID 或 UUID。 |
| `session_id` | string | 是 | Desktop 本地 session ID。 |
| `message_id` | string | 是 | Desktop 本地 user message ID。 |
| `created_at` | ISO datetime | 是 | 用户消息在 Desktop 创建的时间。 |
| `app.name` | string | 是 | 固定为 `medevidence-desktop`。 |
| `app.version` | string | 否 | Desktop 应用版本。 |
| `agent` | string | 否 | 例如 `research`、`build`、`plan`、`medevidence-direct`。 |
| `provider_id` | string | 否 | Desktop 侧 provider 公共 ID，例如 `medcode`。 |
| `model_id` | string | 否 | 只允许公共模型 ID，例如 `medcode`，不要上传内部 upstream model。 |
| `engine` | string | 否 | `agent` 或 `medevidence-direct`。 |
| `text` | string | 是 | 用户本轮原始问题文本。 |
| `attachments` | array | 否 | 只包含附件 metadata，不包含内容。 |

附件 metadata 字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | `file`、`image` 等。 |
| `filename` | string or null | 否 | 文件名，不包含完整本地路径。 |
| `mime` | string or null | 否 | MIME type。 |
| `size` | number or null | 否 | 字节数；无法获得时为 null。 |

## 服务端校验要求

Gateway 应校验：

- `schema` 必须为 `client_message.v1`。
- `event_id`、`session_id`、`message_id` 非空且长度合理。
- `created_at` 必须是合法 ISO datetime。
- `text` 必须是非空字符串。
- `text` 最大长度一期固定为 64KB，按 JSON 解析后 `text` 字符串的 UTF-8 byte length 计算。
- `attachments` 限制数量，一期最多 20 个。
- `filename` 不应包含路径分隔符；服务端应归一化为 basename。
- `attachments[]` 中不得出现 `content`、`data`、`base64`、`text`、`path` 等正文或本地路径字段；出现时直接返回 `400 invalid_request`。
- `provider_id`、`model_id` 只作为客户端 metadata，不用于认证或路由判断。

Gateway 不应信任客户端传入任何用户 ID、credential ID、subject ID 或 scope。上述字段应由 bearer credential 的认证结果派生。

## 响应

首次写入成功：

```http
201 Created
```

```json
{
  "ok": true,
  "event_id": "01JZEXAMPLE000000000000000",
  "duplicate": false,
  "received_at": "2026-04-29T10:00:01.000Z"
}
```

重复 `event_id`：

```http
200 OK
```

```json
{
  "ok": true,
  "event_id": "01JZEXAMPLE000000000000000",
  "duplicate": true
}
```

重复 `event_id` 但 payload 不一致：

```http
409 Conflict
```

```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "event_id already exists for this user with different content."
  }
}
```

判定规则：

- 幂等范围是 `subject_id + event_id`。
- 同一 `subject_id + event_id` 已存在，且 `text_sha256`、`session_id`、`message_id` 都一致时，返回 `200 OK` 和 `duplicate: true`。
- 同一 `subject_id + event_id` 已存在，但 `text_sha256`、`session_id`、`message_id` 任一不一致时，返回 `409 idempotency_conflict`。
- 409 时不得覆盖或修改既有 `client_message_events` 行，避免隐藏客户端 bug 或破坏审计不可变性。

认证失败沿用现有 Gateway 错误格式和状态码，例如 `401 missing_credential`、`401 invalid_credential`、`401 expired_credential`。

参数错误：

```http
400 Bad Request
```

```json
{
  "error": {
    "code": "invalid_request",
    "message": "text must be a non-empty string."
  }
}
```

## 存储方案

一期采用独立 SQLite 数据库保存客户端消息事件，避免用户原文写入主业务库：

```bash
GATEWAY_CLIENT_EVENTS_SQLITE_PATH=/var/lib/codex-gateway/client-events.db
```

数据库职责边界：

| 数据库 | 职责 | 不保存 |
| --- | --- | --- |
| `gateway.db` | API key、用户、session、request_events、token usage、admin audit | 客户端上传的用户问题原文 |
| `client-events.db` | `client_message_events` 和后续 client ingest 专用索引 | API key 密文、session 状态、模型 request usage、token usage |

如果 `GATEWAY_CLIENT_EVENTS_SQLITE_PATH` 未配置，`POST /gateway/client-events/messages` 固定返回 `503 service_unavailable`。这表示当前 Gateway 版本支持该功能，但运行环境未启用 client events 存储。不要 fallback 到主 `gateway.db`，避免误把敏感原文写入主库。只有老版本 Gateway 完全没有该路由时，客户端才会看到自然的 `404`。

独立数据库能隔离主库锁竞争、文件增长、备份策略、保留周期、prune/vacuum 操作和未来迁移路径。但它不能完全隔离同一台机器上的磁盘 I/O，也不能消除 Node 同步 SQLite 写入的 event loop 占用。因此一期仍然必须保留独立 ingest 限流。

`client-events.db` 内新增独立表，不复用 request usage 或 token usage 表：

```text
client_message_events
- id TEXT PRIMARY KEY
- event_id TEXT NOT NULL
- request_id TEXT NOT NULL
- credential_id TEXT NOT NULL
- subject_id TEXT NOT NULL
- scope TEXT NOT NULL
- session_id TEXT NOT NULL
- message_id TEXT NOT NULL
- agent TEXT NULL
- provider_id TEXT NULL
- model_id TEXT NULL
- engine TEXT NULL
- text TEXT NOT NULL
- text_sha256 TEXT NOT NULL
- attachments_json TEXT NOT NULL
- app_name TEXT NULL
- app_version TEXT NULL
- created_at TEXT NOT NULL
- received_at TEXT NOT NULL
- UNIQUE(subject_id, event_id)
```

一期索引：

```text
idx_client_message_events_received_at(received_at)
idx_client_message_events_subject_received(subject_id, received_at)
idx_client_message_events_credential_received(credential_id, received_at)
idx_client_message_events_session_received(session_id, received_at)
idx_client_message_events_text_sha256(text_sha256)
```

`request_id` 保存本次 ingest HTTP request 的 Gateway request id，便于关联 HTTP 访问日志。该字段不应理解为模型请求 ID。

## 限流和计费边界

该接口是客户端事件上传，不是模型调用：

- 不计入模型请求次数。
- 不计入 token usage。
- 不占用模型并发请求额度。
- 必须有独立轻量 ingest 限流，防止客户端 bug 或恶意刷入。
- 必须跳过现有 request observation 写入，避免污染 `request_events`、`events`、`report-usage` 和 token usage 统计。
- 写入目标是 `client-events.db`，不应打开主 `gateway.db` 事务，也不应阻塞 API key/session/request usage 主库写入。

一期默认限流策略：

```text
每 credential 每分钟最多 60 条 client_message_events
每 credential 每天最多 2000 条 client_message_events
单条 text 最大 64KB，按 UTF-8 byte length 计算
每次最多 20 个 attachments
```

上述阈值应做成 Gateway 配置项；扩大使用前根据真实 ingest 成功率、重复率和 SQLite 增长调整。

## 安全和隐私边界

用户问题文本在医学场景下可能包含 PHI/PII，因此 Gateway 侧应按敏感数据处理：

- `client-events.db` 数据库文件和备份应纳入敏感数据保护策略，并可采用不同于主 `gateway.db` 的保留周期和备份策略。
- 主 `gateway.db` 备份不应包含客户端上传的用户问题原文。
- 生产日志不应打印完整 `text`。
- 错误日志可记录 `event_id`、`credential_id`、`subject_id`、长度、hash，但不要记录完整文本。
- 管理端读取该表应有权限控制和审计。
- 需要明确保留周期、删除策略和用户数据请求处理方式。
- 一期不开放管理端全文查询；最多提供受控的摘要查询能力，例如事件时间、用户、credential、长度、`text_sha256`、截断预览。

一期必做：

- 服务端保存 `text_sha256`，用于排障和去重。
- 生产日志、错误日志、审计日志不得记录完整 `text`。
- Gateway route config 应明确跳过 request observation，例如 `skipObservation`，防止消息上传事件进入模型请求统计。
- `client-events.db` 应支持独立 prune/vacuum；执行保留周期清理时不得影响主 `gateway.db`。

后续增强：

- 管理端默认只展示截断文本，查看全文需要更高权限和额外审计。
- 后续支持按 `subject_id` 删除 client message events。
- 如果 client events 规模扩大到多用户高频写入，应把 `client-events.db` 迁移到 Postgres 或独立 ingest 服务，而不是继续扩大主 gateway 进程内 SQLite 写入。

## Desktop 侧配合预期

Desktop 将保证只上传以下内容：

- 用户本轮输入的 text parts。
- message metadata：`session_id`、`message_id`、`agent`、`provider_id`、`model_id`、`engine`、`created_at`、app version。
- 附件 metadata：`type`、`filename`、`mime`、`size`。

Desktop 不会上传：

- synthetic text part。
- system reminder。
- 文件读取后的正文。
- tool call/tool result。
- assistant message。
- 完整聊天历史。

Desktop 上传会采用 fire-and-forget 或后台队列方式。上传失败不会阻塞用户对话。

## 兼容性和上线计划

分阶段上线：

1. Gateway 按本文一期边界实现接口、schema、字段长度限制和存储策略。
2. Gateway 在 staging 或 trial 环境上线 endpoint。
3. Desktop 端实现默认关闭的上传客户端，通过配置开启。
4. 使用测试 credential 做联调，验证 Gateway 只收到用户问题文本和 metadata。
5. 小范围开启，观察 ingest 成功率、重复率、存储增长和错误率。
6. 确认隐私、保留周期、删除策略和管理端访问策略后扩大使用。

## 验收标准

Gateway 侧必须至少覆盖以下测试：

- 无 bearer token 返回 401。
- 无效 bearer token 返回 401。
- 有效 credential 可写入事件。
- 相同 `subject_id + event_id`、相同 `text_sha256`、相同 `session_id`、相同 `message_id` 的重复提交返回 `200 duplicate: true`，不会重复落库。
- 相同 `subject_id + event_id` 但 `text_sha256`、`session_id`、`message_id` 任一不一致时返回 `409 idempotency_conflict`，且不覆盖既有记录。
- `text` 为空返回 400。
- `text` 按 UTF-8 byte length 超过 64KB 时返回 400 或 413。
- `attachments` 不接受正文、本地路径或 base64 内容字段。
- 事件落库后的 `credential_id`、`subject_id`、`scope` 来自认证上下文，而不是客户端 payload。
- 写入 client message event 不影响现有 request usage/token usage 统计。
- 写入 client message event 不产生 `request_events` 行。
- 写入 client message event 只修改 `client-events.db`，不修改主 `gateway.db`。
- 未配置 `GATEWAY_CLIENT_EVENTS_SQLITE_PATH` 时 endpoint 固定返回 `503 service_unavailable`，且不会 fallback 到主库。
- 相同 `event_id` 在不同 `subject_id` 下互不影响；幂等范围按 `subject_id` 隔离。
- 独立 ingest rate limit 命中后返回 429，且不占用模型请求限额。
- 生产日志不包含完整用户问题文本。

## 待继续确认的问题

1. 数据保留周期采用 30 天、90 天，还是其他值。
2. 删除策略是否一期就实现 `subject_id` 级删除，还是先保留 schema/索引能力。
3. 管理端是否需要查询 client message events；如果需要，哪些角色可查摘要，哪些角色可看全文。
4. 响应中是否需要返回 Gateway 派生的 `subject_id`；一期默认只返回 `event_id`、`duplicate`、`received_at`。
