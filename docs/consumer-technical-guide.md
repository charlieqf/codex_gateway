# GoldenCode Gateway 消费者技术说明

版本日期：2026-11-15。

本文是客户端接入的当前最小合同。历史 MedCode/Azure 试用细节保留在
Git 历史和设计文档中，不再作为接入依据。

## 接入信息

```text
origin: https://goldencode.instmarket.com.au:1443
baseURL: https://goldencode.instmarket.com.au:1443/v1
```

除公开健康检查外，请求使用：

```http
Authorization: Bearer <API_KEY>
```

模型列表以 `GET /v1/models` 为准。当前公共文本模型：

| model | 用途 | context/output |
| --- | --- | --- |
| `goldencode` | Tencent GLM-5.3 云端路由 | 以 `/v1/models` 返回值为准 |
| `goldencode-d` | DeepSeek 云端池 | 以 `/v1/models` 返回值为准 |
| `goldencode-d-long` | 长文档文本，固定 Tencent `deepseek-v4.1-flash-1017` | 1,024,000 / 最多 128,000 tokens；以账号实际模型目录为准 |
| `goldencode-local` | R760 Qwen3.8-27B-FP8 | 32,768 / 最多 8,192 tokens |

公共图片模型名是 `medcode-image-default`，通过
`POST /gateway/images/generations` 调用。

### 长文档入口

`goldencode-d-long` 使用独立配置，不改变两个旧云端 ID 的路由、额度或截断处理。
它支持 Chat Completions 和 Responses；当前仅支持文本输入，不继承旧 ID 的视觉路由。
合计上下文不是纯正文容量：系统提示、历史、工具定义和输出（包括推理）都需要预算。
预留 128,000 token 输出时，输入理论预算为 896,000 token；调用方应再留出估算余量。
生成上限通过 `max_tokens` / `max_output_tokens` 指定，超过 128,000 时 Gateway 拒绝请求。
Gateway 不会自动裁剪云端文本输入或保证满窗口仍有完整输出额度；上游超限会返回错误。
达到生成长度限制也不能当作完整提取成功，调用方必须检查终态。

标准 Desktop 凭据及后续签发的凭据包含新 ID；自定义受限凭据和服务 Key 继续遵守各自的 allowlist。
已有标准三模型白名单的未撤销 Desktop／旧版凭据升级为四模型，不改变套餐、余额和限流策略。
已安装 MedEvidence 仍只发现既有三个 ID；
开放客户端选择还需客户端注册新模型、同步输入/输出预算及压缩阈值，并验证工具调用。
服务端增加该 ID 不会自动替换客户端默认模型，也不改变套餐余额。
长窗口只扩大原文容量；字段的页码、行号、原文引用和预览跳转仍需文档解析与证据定位流程提供。

## 在线分析技能权限

AIPAL、PanEcho 分别通过 `GET /gateway/aipal/v1/capabilities`、
`GET /gateway/panecho/v1/capabilities` 返回可选 `entitled` 字段，`available` 保持原义。
客户端仅在 `entitled === false` 时显示“未开通”；已开通但 `available === false` 表示服务暂不可用，
字段缺失或请求失败不能判定账号未开通。该权限与任务提交的账号准入一致，不等同于付费套餐。
其他分析服务逐项确认；离线报告技能不受此限制。
完整状态表及准入规则见 [AIPAL / PanEcho 客户端契约](./operations/clinical-models-v1.md#账号权限与服务可用性)。

## OpenAI 兼容接口

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Chat Completions 支持非流式/流式文本、`system`/`developer`/`user`/
`assistant`/`tool` 历史，以及客户端声明的 function tools。工具在客户端执行；
下一轮按 OpenAI 约定回传 assistant `tool_calls` 和 `role=tool` 结果。

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GOLDENCODE_API_KEY,
  baseURL: "https://goldencode.instmarket.com.au:1443/v1"
});

const response = await client.chat.completions.create({
  model: "goldencode",
  messages: [{ role: "user", content: "Reply with: ok" }]
});
```

多轮兼容调用由客户端携带所需历史。服务端原生 session API 仍提供
`POST /sessions`、`GET /sessions` 和
`POST /sessions/{id}/messages`，仅在确实需要服务端 session 时使用。

## Local 上下文恢复合同

`goldencode-local` 在生成前精确计算 prompt 与请求输出空间。超过
32,768 token 时返回 HTTP 413：

```json
{
  "error": {
    "code": "context_compaction_required"
  }
}
```

客户端应：

1. 非阻塞提示正在整理上下文；
2. 保留当前任务、关键进度和待办，压缩历史；
3. 重建并重新计算请求；
4. 最多自动重试一次；
5. 仍无法留出最低输出空间时，提示新建会话、缩短任务或切换模型。

不要在 413 后无界重试。

## Credential 与版本

保存 key 前调用：

```http
GET /gateway/credentials/current
```

详见 [客户端 API Key 填写与校验](./client-api-key-validation-guide.md)。
Desktop 请求应按当前客户端合同发送 app version、session/message id 等
诊断 header；服务端可能用 HTTP 426 要求升级。

## Desktop 消息上传

Desktop 可向 `POST /gateway/client-events/messages` 上传必要的用户消息和
诊断关联字段。上传与查询的隐私边界见
[Desktop 用户消息查询](./operations/client-message-query-support.zh-CN.md)。
Gateway 消息记录不包含完整 assistant 输出，也不能证明本地 PPTX/HTML 等产物
存在或有效。

## 错误和重试

| HTTP | 含义 | 动作 |
| --- | --- | --- |
| 400 | 请求/工具 schema 无效 | 修正请求，不重试相同内容 |
| 401 | credential 无效 | 重新校验 key |
| 404 | model/resource 不存在 | 刷新 `/v1/models` 或检查资源归属 |
| 413 | Local context 超限 | 按上文压缩并最多重试一次 |
| 426 | Desktop 版本过低 | 升级客户端 |
| 429 | 速率/容量限制 | 遵守 `Retry-After` 后有限重试 |
| 5xx | Gateway/provider 暂不可用 | 保留 request ID，指数退避 |

始终记录响应 `X-Request-Id`，但不得记录 Authorization header、完整 key、
provider body、私有源码、PHI 或不必要的本地文件内容。

## 接入验收

至少验证：

1. credential 校验和 `/v1/models`；
2. `goldencode` 非流式与流式文本；
3. function call、客户端工具执行和 follow-up；
4. request ID 与错误展示；
5. Local 413 压缩/单次重试（如果启用 Local）；
6. key、用户、Plan 和速率限制错误；
7. 客户端日志和反馈材料无敏感信息。

当前生产状态与专项 runbook 以
[System Status](./operations/system-status.md) 和
[Runbook Index](./operations/runbook-index.md) 为准。
