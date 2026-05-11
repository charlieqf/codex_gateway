# MedCode Gateway 生图能力开发方案

Last updated: 2026-05-07

## 1. 背景和目标

需求来源：[MedCode Gateway 生图能力需求说明.txt](./MedCode%20Gateway%20生图能力需求说明.txt)。

目标是让 MedEvidence CLI/Desktop 用户只配置 unified key，就能在 MedCode + Research agent 中使用图片生成能力。客户端不直接调用 OpenAI，也不持有 OpenAI API key；Gateway 在服务端完成鉴权、capability 判断、额度控制、调用上游图片模型、审计和错误映射。

核心边界：

- 客户端只关心 `<medcode-key>` 是否具备 `image_generation` capability。
- 客户端使用稳定内部模型 id，例如 `medcode-image-default`；不传真实上游模型 id。
- 图片 provider、OpenAI API key、OpenAI project、上游模型映射、额度管理全部由 Gateway 后端承担。
- Gateway 返回 base64 图片数据；Desktop/CLI 客户端负责解码、保存到本地附件目录并在 UI 展示。
- MVP 只实现单 prompt 生成单张图片，不实现图片编辑、参考图、多轮图片编辑和 OpenAI-compatible `/v1/images/generations`。

OpenAI 文档当前显示 `gpt-image-2` 已存在，并推荐用于新构建；但实际接入前仍必须在我们的 OpenAI organization/project 中确认模型权限。本文档把客户端模型 id 和上游模型 id 解耦，避免上游模型名变化影响客户端和已发放 entitlement。

## 2. 当前系统约束

当前 Gateway 已具备：

- SQLite-backed credential auth。
- `GET /gateway/credentials/current`。
- plan / entitlement 基础模型。
- 通用 per-credential 请求限流。
- token usage 观测和 admin CLI 报表。
- OpenAI-compatible `/v1/chat/completions`。
- 公网 `gw.instmarket.com.au` 由 host Nginx 代理到 loopback-only container `127.0.0.1:18787`。

当前缺口：

- 现有 provider 是 Codex/ChatGPT subscription 文本 provider，不支持 Image API。
- `Scope` 只有 `medical | code`，没有 capability 模型。
- 现有 quota 主要是文本 token 维度，不能直接表达图片数量或图片 cost units。
- `request_events` 是通用请求观察记录，但缺少图片参数、prompt HMAC、image cost units 等字段。

## 3. 推荐架构

请求链路：

```text
MedEvidence CLI/Desktop
  -> POST /gateway/images/generations
  -> credentialAuthHook
  -> image request validation
  -> entitlement/capability policy check
  -> image-specific rate/quota limiter
  -> per-credential image mutex
  -> OpenAI Image API provider
  -> image event/audit recording
  -> JSON response with data[0].b64_json
  -> client decodes and saves local attachment
```

新增模块建议：

- `packages/core/src/image-generation.ts`
  - 图片 request/response 类型。
  - capability 和 image policy 类型。
  - 内部模型 id 与上游模型 id 的类型。
  - size/quality/format/cost unit 校验。
- `packages/provider-openai-image`
  - OpenAI Image API REST provider。
  - 只读取服务端环境变量，不暴露给客户端。
  - 负责内部模型 id 到上游模型 id 的映射。
- `packages/store-sqlite/src/image-generation.ts`
  - image feature policy snapshot、usage event、quota charge 的 SQLite 读写。
- `apps/gateway/src/image-generation.ts`
  - Fastify route、请求解析、错误映射、调用 provider。
- `apps/admin-cli`
  - plan feature policy 配置、image quota 查看、image events/report 命令。

实现选择：

- MVP 使用 OpenAI Image API `POST /v1/images/generations`，不是 Responses API image tool。
- Node 24 已有 `fetch`，OpenAI Image API 调用可先用 REST + `fetch` 实现，避免新增 OpenAI SDK 依赖。后续如需要 streaming 或更完整 API surface，再评估引入官方 SDK。
- 图片 route 设置 `config.skipRateLimit = true`，并显式设置 `config.skipTokenBudget = true`。图片请求不能消耗普通文本 chat 的请求限流桶或 token 额度；route 内单独执行 image limiter 和 image quota。

## 4. API 设计

### 4.1 Endpoint

```http
POST /gateway/images/generations
Authorization: Bearer <medcode-key>
Content-Type: application/json
```

### 4.2 请求体

```json
{
  "prompt": "Create a clean medical mechanism diagram showing ...",
  "model": "medcode-image-default",
  "size": "auto",
  "quality": "auto",
  "output_format": "png",
  "metadata": {
    "client": "medevidence-desktop",
    "session_id": "optional",
    "message_id": "optional",
    "tool_call_id": "optional"
  }
}
```

MVP 校验规则：

- `prompt` 必填，非空字符串，默认最大长度建议 `12000` 字符，可由 `MEDCODE_IMAGE_MAX_PROMPT_CHARS` 覆盖。OpenAI GPT Image 模型可支持更长 prompt，但 Gateway 先取保守上限。
- `model` 默认 `medcode-image-default`，只允许 entitlement allowlist 内的内部模型 id；客户端不要传上游模型 id。
- `size` 默认 `auto`，只允许 entitlement allowlist 内的 `auto | 1024x1024 | 1536x1024 | 1024x1536`。
- `quality` 默认 `auto`，只允许 entitlement allowlist 内的 `auto | low | medium | high`。
- `output_format` 默认 `png`，只允许 entitlement allowlist 内的 `png | jpeg | webp`。
- `output_compression` 只允许在 `jpeg/webp` 下传入；`png` 下传入返回 `invalid_request`。
- `n` 固定为 1；收到 `n != 1` 返回 `invalid_request`。
- `background: "transparent"` 返回 `invalid_request`，message 明确说明当前内部模型不支持 transparent background。
- `metadata` 仅允许 `client`、`session_id`、`message_id`、`tool_call_id` 四个 key；每个值必须是字符串且不超过 256 字符。其余 key 返回 `invalid_request`，不得静默丢弃。

错误码映射规则：

- 字段缺失、类型错误、`output_compression` 与 `png` 冲突、`n != 1`、`background: "transparent"`、metadata 非白名单或超长：`invalid_request`。
- 字段类型正确，但取值不在 entitlement allowlist：`unsupported_model`、`unsupported_size`、`unsupported_quality`、`unsupported_format`。

### 4.3 响应体

```json
{
  "id": "imgreq_...",
  "model": "medcode-image-default",
  "created": 1778123456,
  "data": [
    {
      "b64_json": "...",
      "mime_type": "image/png",
      "size": "1024x1024",
      "quality": "auto",
      "output_format": "png"
    }
  ],
  "usage": {
    "total_tokens": 123,
    "input_tokens": 45,
    "output_tokens": 78
  }
}
```

响应约定：

- 顶层 `id` 是图片业务 id，格式 `imgreq_...`。
- `error.request_id` 始终使用 Gateway/Fastify request id，格式按现有 Gateway request id；不要与图片业务 id 混用。
- 不返回 `filename`。客户端应基于会话、消息、request id 和扩展名自行生成本地文件名。
- `usage` 是可选字段。上游缺失或字段不完整时，服务端记录 `null`，不影响成功返回。

Gateway 返回 `b64_json` 后，客户端执行：

1. base64 decode。
2. 根据 `mime_type` 和 `output_format` 写入本地会话附件目录。
3. 在消息 UI 中显示该本地附件。
4. 对 CLI，默认写入当前目录或 `--output` 指定路径。

## 5. Capability 和套餐模型

### 5.1 新增核心类型

建议新增：

```ts
export type GatewayCapability = "chat" | "tools" | "image_generation";
export type InternalImageModelId = "medcode-image-default";

export interface ImageCostUnitPolicy {
  defaultUnits: number;
  qualityMultipliers?: Record<string, number>;
  sizeMultipliers?: Record<string, number>;
}

export interface ImageGenerationPolicy {
  enabled: boolean;
  allowedInternalModels: InternalImageModelId[];
  defaultInternalModel: InternalImageModelId;
  allowedSizes: string[];
  allowedQualities: string[];
  allowedFormats: string[];
  requestRate: {
    requestsPerMinute: number;
    requestsPerDay: number | null;
    concurrentRequests: number | null;
  };
  quota: {
    unitsPerPeriod: number | null;
  };
  costUnits: ImageCostUnitPolicy;
}

export interface FeaturePolicy {
  capabilities: GatewayCapability[];
  imageGeneration?: ImageGenerationPolicy;
}
```

Cost unit 公式固定为：

```text
final_units = defaultUnits * qualityMultiplier * sizeMultiplier
```

缺省 multiplier 为 `1`。计算结果向上取整为整数。不要在不同实现中改成取最大值或相加。

### 5.2 SQLite schema

建议增加 migration：

```sql
ALTER TABLE plans ADD COLUMN feature_policy_json TEXT NOT NULL DEFAULT '{"capabilities":["chat","tools"]}';

CREATE TRIGGER IF NOT EXISTS trg_plans_feature_policy_immutable
BEFORE UPDATE OF feature_policy_json ON plans
BEGIN
  SELECT RAISE(ABORT, 'plans.feature_policy_json is immutable');
END;

ALTER TABLE entitlements ADD COLUMN feature_policy_snapshot_json TEXT NOT NULL DEFAULT '{"capabilities":["chat","tools"]}';
```

原则：

- `plans.feature_policy_json` 必须和现有 `plans.policy_json` 一样不可变。
- 能力变化通过新 plan + 新 entitlement snapshot 生效。
- `entitlements.feature_policy_snapshot_json` 是运行时判断 capability 的来源。
- MVP 不在 credential 层做 capability override；credential 继续表达 `scope`、有效期和通用请求 rate。后续如要精细到单 key，可再加 `access_credentials.feature_policy_override_json`。

### 5.3 `/gateway/credentials/current`

扩展返回。capability 放在 entitlement feature policy 下，不嵌入 credential：

```json
{
  "valid": true,
  "credential": {
    "prefix": "abc123...",
    "scope": "medical",
    "expires_at": "2026-06-01T00:00:00.000Z"
  },
  "entitlement": {
    "state": "active",
    "feature_policy": {
      "capabilities": ["chat", "tools", "image_generation"],
      "image_generation": {
        "enabled": true,
        "allowed_models": ["medcode-image-default"],
        "allowed_sizes": ["auto", "1024x1024", "1536x1024", "1024x1536"],
        "default_model": "medcode-image-default"
      }
    }
  }
}
```

客户端必须通过 `entitlement.feature_policy.capabilities` 判断生图能力，不能通过 `scope` 推断。

## 6. 图片限流和额度

图片额度和文本 token 额度分开。

### 6.1 请求频率和并发

复用 `InMemoryCredentialRateLimiter`，但为 image route 创建独立 limiter 实例和独立 policy：

```text
credential:<id>:image_generation
```

这样图片请求不会占用普通 chat 的 RPM/RPD/concurrency。

### 6.2 In-process mutex

MVP 增加 per-credential image mutex，使同一个 credential 的以下步骤串行化：

1. 查询当前周期已用 image units。
2. 判断本次请求是否超额。
3. 调用上游。
4. 写入 `image_generation_events`。

这不能解决多进程或多 VM 场景，但能覆盖 controlled trial 下 Desktop + CLI 同时发起请求造成的本进程 TOCTOU 超发。

### 6.3 周期额度

新增 SQLite usage event 表，记录图片 cost units。MVP 不做 reservation 表；Phase 2 再做持久化 reservation。

建议表结构：

```sql
CREATE TABLE image_generation_events (
  id TEXT PRIMARY KEY,                         -- imgreq_...
  request_id TEXT NOT NULL UNIQUE,             -- Gateway/Fastify request id
  endpoint TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  entitlement_id TEXT,
  plan_id TEXT,
  scope TEXT NOT NULL,
  provider TEXT NOT NULL,
  internal_model TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  size TEXT NOT NULL,
  quality TEXT NOT NULL,
  output_format TEXT NOT NULL,
  output_compression INTEGER,
  prompt_hmac_sha256 TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  image_count INTEGER NOT NULL DEFAULT 1,
  cost_units INTEGER NOT NULL,
  charged_units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_code TEXT,
  http_status INTEGER,
  duration_ms INTEGER,
  upstream_response_id TEXT,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_image_events_subject_created
  ON image_generation_events(subject_id, created_at);

CREATE INDEX idx_image_events_credential_created
  ON image_generation_events(credential_id, created_at);

CREATE INDEX idx_image_events_entitlement_created
  ON image_generation_events(entitlement_id, created_at);
```

事实表职责：

- `image_generation_events` 是图片请求、计费、报表的事实表。
- `request_events` 只作为通用 request trace，记录请求状态、延迟、错误码等。
- admin CLI 的 `image-report` 一律读 `image_generation_events`，避免从 `request_events` 重复统计。

MVP 额度算法：

1. 从 active entitlement 的 `feature_policy_snapshot_json` 读取 `imageGeneration.quota.unitsPerPeriod`。
2. 根据内部 model id、size、quality 计算本次 `cost_units`。
3. 进入 per-credential image mutex。
4. 查询当前 entitlement 周期内 `SUM(charged_units)`。
5. 如果超过额度，返回 `429 rate_limited`，limit kind 为 `image_period_units`。
6. 调用上游。
7. 插入 `image_generation_events`。
8. 成功请求 `charged_units = cost_units`；上游内容政策拒绝、上游超时、用户取消是否计费先按产品待确认项处理，MVP 默认不计费但记录事件。

注意：扩展到多进程或多 VM 前，需要 image quota reservation 表或事务级预留，避免跨进程并发超发。

## 7. OpenAI Image Provider

### 7.1 环境变量

新增：

```text
MEDCODE_IMAGE_GENERATION_ENABLED=1
MEDCODE_IMAGE_OPENAI_API_KEY=<secret>
MEDCODE_IMAGE_OPENAI_BASE_URL=https://api.openai.com
MEDCODE_IMAGE_OPENAI_DEFAULT_UPSTREAM_MODEL=gpt-image-2
MEDCODE_IMAGE_MODEL_MAP_JSON={"medcode-image-default":"gpt-image-2"}
MEDCODE_IMAGE_TIMEOUT_MS=180000
MEDCODE_IMAGE_MAX_PROMPT_CHARS=12000
MEDCODE_IMAGE_PROMPT_HASH_SECRET=<secret>
```

约定：

- `MEDCODE_IMAGE_OPENAI_BASE_URL` 不包含 `/v1`。
- 代码固定拼接 `/v1/images/generations`。
- 如果目标 organization 未开通 `gpt-image-2`，只需调整 `MEDCODE_IMAGE_MODEL_MAP_JSON` 或 default upstream model，不改客户端契约。

生产启动校验：

- 如果 `MEDCODE_IMAGE_GENERATION_ENABLED=1`，必须设置 `MEDCODE_IMAGE_OPENAI_API_KEY`。
- 如果 `MEDCODE_IMAGE_GENERATION_ENABLED=1`，必须设置 `MEDCODE_IMAGE_PROMPT_HASH_SECRET`。
- 不要把 key 写入日志、docs、smoke 输出或 admin audit。
- `CODEX_HOME` 仍用于现有文本 provider；image provider 使用独立 OpenAI API key，二者不要混用。
- 部署前确认 OpenAI organization/project 已完成必要 verification，并确认目标上游模型可用。

### 7.2 上游请求

调用：

```http
POST <MEDCODE_IMAGE_OPENAI_BASE_URL>/v1/images/generations
Authorization: Bearer <MEDCODE_IMAGE_OPENAI_API_KEY>
Content-Type: application/json
```

上游 body：

```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "size": "1024x1024",
  "quality": "auto",
  "output_format": "png"
}
```

仅在 `jpeg/webp` 下透传 `output_compression`。

### 7.3 取消和超时

- 每次上游请求使用 `AbortController`。
- 监听 `request.raw.aborted`；客户端断开时 abort 上游 fetch。
- abort 后写入 `image_generation_events.status = 'aborted'`，`charged_units = 0`。
- timeout 后 abort 上游 fetch，返回 `upstream_timeout`，写事件但 MVP 默认不计费。

### 7.4 错误映射

建议映射：

- OpenAI 400 参数错误 -> `invalid_request` 或对应 `unsupported_*`
- OpenAI 内容政策拒绝 -> `content_policy_violation`
- OpenAI 401/403 -> `upstream_unavailable`，日志仅记录状态和 request id，不输出 key
- OpenAI 429 -> `rate_limited`
- OpenAI 5xx -> `upstream_unavailable`
- 本地超时 -> `upstream_timeout`
- JSON shape 缺少 `data[0].b64_json` -> `upstream_unavailable`
- usage 缺失或字段不全 -> 成功返回，usage 记 `null`

## 8. Gateway route 实现

新增 route：

```ts
app.post(
  "/gateway/images/generations",
  { config: { skipRateLimit: true, skipTokenBudget: true } },
  async (request, reply) => {
    // parse and validate request
    // resolve entitlement feature policy
    // check image_generation capability
    // acquire image rate limiter
    // enter per-credential image mutex
    // check image quota
    // call provider with AbortController
    // record image_generation_events
    // return response
  }
);
```

实现细节：

- 必须复用 `getGatewayContext(request)` 获取 `subject`、`credential`、`scope`。
- `planEntitlementStore` 不存在或无 active entitlement 时，按现有 `GATEWAY_REQUIRE_ENTITLEMENT` 语义处理；controlled trial 应要求 active entitlement。
- `markFirstByte(request)` 在拿到上游首个可返回结果后调用。
- `recordObservation` 仍记录一条通用 request event；图片细节写入 `image_generation_events`。
- 所有错误通过现有 Gateway error payload shape 返回，`error.request_id` 使用 Gateway/Fastify request id。
- 不在日志中输出完整 prompt、base64、API key 或完整 bearer token。
- prompt 只记录 HMAC：`HMAC-SHA256(MEDCODE_IMAGE_PROMPT_HASH_SECRET, prompt)`。
- MVP 不做 server-side PHI / 患者姓名 / MRN 预扫描，依赖客户端约束、日志最小化和上游内容策略。

## 9. Admin CLI

新增或扩展命令：

### 9.1 Plan feature policy

扩展 `plan create`：

```powershell
npm run dev:admin -- plan create `
  --id medcode_image_trial_v1 `
  --display-name "MedCode Image Trial" `
  --policy-file .\plans\token-policy.json `
  --feature-policy-file .\plans\image-feature-policy.json `
  --scope medical
```

示例 `image-feature-policy.json`：

```json
{
  "capabilities": ["chat", "tools", "image_generation"],
  "imageGeneration": {
    "enabled": true,
    "allowedInternalModels": ["medcode-image-default"],
    "defaultInternalModel": "medcode-image-default",
    "allowedSizes": ["auto", "1024x1024", "1536x1024", "1024x1536"],
    "allowedQualities": ["auto", "low", "medium", "high"],
    "allowedFormats": ["png", "jpeg", "webp"],
    "requestRate": {
      "requestsPerMinute": 2,
      "requestsPerDay": 20,
      "concurrentRequests": 1
    },
    "quota": {
      "unitsPerPeriod": 50
    },
    "costUnits": {
      "defaultUnits": 1,
      "qualityMultipliers": {
        "low": 1,
        "auto": 1,
        "medium": 2,
        "high": 3
      },
      "sizeMultipliers": {
        "auto": 1,
        "1024x1024": 1,
        "1536x1024": 1,
        "1024x1536": 1
      }
    }
  }
}
```

### 9.2 Image usage inspection

新增：

```powershell
npm run dev:admin -- image-events --user <id> --limit 50
npm run dev:admin -- image-report --user <id> --days 30
```

输出字段：

- image request id
- Gateway request id
- endpoint
- user/credential prefix
- entitlement id
- internal model / upstream model
- size/quality/format
- status/error code
- cost units / charged units
- usage tokens if available
- duration

## 10. 客户端集成约定

Desktop/CLI 侧不需要知道 OpenAI key、provider 或上游 model id。

客户端流程：

1. 从 unified key `cmev1.<medcode-key>.<medevidence-key>` 解析 `<medcode-key>`。
2. 调 `GET /gateway/credentials/current` 检查 `entitlement.feature_policy.capabilities` 是否包含 `image_generation`。
3. Research agent 调 `POST /gateway/images/generations`，使用内部模型 id `medcode-image-default`。
4. 收到 `data[0].b64_json` 后解码为二进制图片。
5. 保存到本地会话附件目录，例如：
   - Desktop: app data / conversation attachments 目录。
   - CLI: `--output` 指定路径；未指定时写入当前目录的 `generated-image.<ext>`。
6. UI 展示本地附件，并保留 Gateway `error.request_id` 或成功响应 `id` 供报错。

Gateway 不直接写用户电脑文件系统，也不负责触发浏览器下载。

## 11. 测试方案

### 11.1 单元测试

新增覆盖：

- image request parser。
- `size/quality/format/output_compression/n/background/metadata` 校验。
- unsupported vs invalid_request 映射。
- feature policy validator。
- cost units 计算公式。
- internal model -> upstream model 映射。
- capability 不存在时返回 `plan_capability_required`。
- OpenAI provider fetch 成功响应解析。
- OpenAI provider 错误映射和日志脱敏。
- AbortController timeout / request aborted。
- image event row mapper 和 SQLite migration。
- `plans.feature_policy_json` immutable trigger。

### 11.2 Gateway 集成测试

使用 fake image provider：

- 缺 credential -> `401 missing_credential`，error.request_id 为 Gateway request id。
- 错 credential -> `401 invalid_credential`。
- 无 image capability -> `403 plan_capability_required`。
- 有 capability -> 返回 `id + b64_json + mime_type`。
- 图片 route 不消耗普通 chat limiter，也跳过 token budget。
- image RPM/RPD/concurrency 生效。
- image quota units 超限返回 `429 rate_limited`。
- 同一 credential 并发请求通过 image mutex 串行化。
- `GET /gateway/credentials/current` 返回 entitlement feature policy。
- `image_generation_events` 是 image-report 事实来源。
- observation 和 image_generation_events 都写入，且不含 prompt 原文和 base64。

### 11.3 本地命令

```powershell
npm run build
npm test
```

Smoke 分两类：

- 默认 smoke 走 fake image provider，验证 Gateway 契约、权限、quota、审计，不调用真实 OpenAI。
- 真实上游调用走人工 canary，使用 controlled trial 临时 MedCode key 发起一次成功生图，确认 admin image-report 有记录，然后撤销临时 MedCode key。不要在 smoke 中切换 Gateway 全局 OpenAI key。

smoke/canary 必须：

- 使用临时用户和临时 MedCode API key。
- 不打印完整 MedCode API key。
- 不打印 OpenAI API key。
- 不打印完整 base64。
- 测完撤销临时 key、disable 临时用户。

## 12. 部署方案

部署前置：

- OpenAI organization/project 已具备 GPT Image 模型访问和必要 organization verification。
- 确认目标上游模型可用；如果 `gpt-image-2` 未开通，调整 `MEDCODE_IMAGE_MODEL_MAP_JSON`。
- 生产 secret 中配置 `MEDCODE_IMAGE_OPENAI_API_KEY`。
- 生产 secret 中配置 `MEDCODE_IMAGE_PROMPT_HASH_SECRET`。
- gateway container 可出站访问 `api.openai.com`。
- controlled trial 的 plan/entitlement 已包含 `image_generation` feature policy。
- host Nginx `proxy_buffers`、`proxy_busy_buffers_size`、`client_max_body_size` 或相关响应 buffering 设置能容纳 MVP 最大预期 base64 响应，并留至少 1.5x 余量。

VM 部署约束：

- Gateway container 继续只发布 `127.0.0.1:18787->8787`。
- 不改 Nginx 默认 vhost，不改 firewall，不让 Docker 绑定公网 `80/443`。
- 继续由 `gw.instmarket.com.au` 的现有 Nginx vhost 转发到 loopback gateway。

部署步骤：

1. 本地 `npm run build && npm test`。
2. 在 VM checkout 更新代码。
3. VM 上 `npm run build && npm test`。
4. 配置 image OpenAI secret 和 prompt hash secret。
5. 验证 container 出站到 `api.openai.com`。
6. 验证 Nginx response buffer/body size 配置。
7. 创建或更新 image-enabled plan/entitlement。
8. 重建 gateway image。
9. 重启 gateway container。
10. 只读验证：
    - `curl http://127.0.0.1:18787/gateway/health`
    - `GET /gateway/credentials/current`
11. 使用临时 key 运行 fake-provider public smoke。
12. 由人工运行一次真实上游 canary。
13. 检查 active keys、image events、audit、logs。
14. 确认 Nginx、MedEvidence、PostgreSQL、SSH 仍正常。

## 13. 分阶段实施

### Phase 1: MVP 生图闭环

- OpenAI Image provider。
- 内部模型 id 到上游模型 id 映射。
- `/gateway/images/generations`。
- entitlement feature policy snapshot。
- `/gateway/credentials/current` capability 暴露。
- image-specific in-memory RPM/RPD/concurrency。
- per-credential image mutex。
- `image_generation_events` 审计事实表。
- 单图 base64 返回。
- fake provider smoke + 人工真实上游 canary。

### Phase 2: 额度和运营增强

- SQLite image quota reservation，减少跨进程超发风险。
- admin CLI `image-events` / `image-report`。
- quota dashboard 增加 image usage。
- trial-check 增加 image capability/key 配置检查。
- 更细 cost table。

### Phase 3: 扩展能力

- 可选 `/v1/images/generations` OpenAI-compatible endpoint。
- streaming partial images。
- 2K/4K 尺寸开放。
- 图片编辑、参考图、多轮编辑。
- 多进程/多 VM 下的持久化限流。

## 14. OpenAI 文档依据

官方文档当前显示：

- Image API 适合单 prompt 图片生成/编辑；Responses API 更适合对话式可编辑体验。
- `gpt-image-2` 是当前 GPT Image 模型之一，但实际可用性取决于 organization/project 权限。
- Image API 返回 base64，也支持 streaming partial images。

官方链接：

- Image generation guide：
  https://developers.openai.com/api/docs/guides/image-generation
- Image API reference：
  https://developers.openai.com/api/reference/resources/images
- GPT Image prompting/model guide：
  https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide

说明：`platform.openai.com/docs/...` 当前会重定向到 `developers.openai.com/api/docs/...`，本文档引用重定向后的官方文档页面。

## 15. 待确认

- 上游实际使用 `gpt-image-2` 还是其他已开通 GPT Image 模型；确认后只调整 provider 映射，不影响客户端内部 model id。
- MVP 图片套餐 quota 采用固定张数还是 cost units；建议用 cost units。
- `medium/high` 的默认 cost unit multipliers。
- 上游失败、内容政策拒绝、用户取消时是否计费；MVP 建议默认不计费但记录事件。
- 是否需要在第一版就实现 OpenAI-compatible `/v1/images/generations`。
- 是否允许受控排障模式短期保留 prompt 原文；默认不保留。
