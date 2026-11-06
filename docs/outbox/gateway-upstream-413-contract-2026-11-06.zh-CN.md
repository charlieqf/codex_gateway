# 上游请求体超限 413 Gateway 联调合同

日期：2026-11-06。

本批修复上游 HTTP 413 被映射为通用服务不可用的问题，覆盖
`POST /v1/chat/completions` 和 `POST /v1/responses` 的 JSON 与 SSE 路径。
状态：本地实现完成，构建及 720 项回归测试通过，尚未部署生产。
本地实现与测试不代表生产上线；本文件不授权部署或修改供应商 Nginx。
本批不修改图片下载 URL 超时的处理策略。

## 错误分类

OpenAI-compatible 供应商直接返回 HTTP 413，或在 HTTP 200 的 SSE 错误帧中
明确返回状态 413 时，Gateway 将其归类为 `invalid_request`，内部 HTTP 状态为 413。
不使用 `upstream_unavailable`，不自动重试或切换账号重放同一请求。
普通 400、429、5xx 及已知 token 上下文超限继续按原有协议处理。

新增独立的 `request_limit_contract_version=1` 和 `request_limit`。
现有 `image_limit_contract_version=1`、`image_limit.maximum` 的数字类型保持不变。
新的协议不需要额外请求头；视觉恢复摘要仍受现有能力请求头控制。

| 字段 | 类型与本批取值 | 含义 |
| --- | --- | --- |
| `request_limit_contract_version` | 数字 `1` | 上游请求体限制合同版本 |
| `request_limit.kind` | 字符串 `request_bytes` | 请求体字节限制，不代表 token 或图片数量限制 |
| `request_limit.origin` | 字符串 `upstream` | 拒绝来自上游链路；不指定是哪一层代理 |
| `request_limit.maximum` | 数字或 null；本批为 `null` | 未知的上游上限，不使用 Gateway 本地配置替代 |
| `request_limit.actual` | 数字或 null；本批为 `null` | 本批未记录被拒上游请求的精确字节数；null 不是零 |
| `retryable` | 布尔值 `false` | 不是可以等待后原样重发的临时错误 |
| `retry_contract_version` | 数字 `1` | 沿用严格停止合同 |
| `automatic_retry_allowed` | 布尔值 `false` | 停止 SDK、工具恢复和会话恢复的自动调用 |
| `recovery_owner` | 字符串 `client` | 内容调整由客户端负责 |
| `transformed_retry_allowed` | 布尔值 `true` | 用户明确重试且内容已调整后可以发起新请求；不覆盖严格停止字段 |
| `recommended_action` | `reduce_image_payload` 或 `reduce_request_payload` | 图片请求或纯文本请求分别缩减实际发送内容 |

图片请求的提示为“发送的内容超过上游请求大小限制，请缩小图片、减少本轮图片或分批处理后重试。”
纯文本请求的提示为“发送的内容超过上游请求大小限制，请减少本轮内容或分批处理后重试。”
客户端必须使用结构化字段分类，不能依赖提示文案匹配。

## JSON 样例

非流式响应 HTTP 413。下例使用占位请求号，不包含视觉恢复能力启用时的附加摘要。

```json
{
  "error": {
    "message": "发送的内容超过上游请求大小限制，请缩小图片、减少本轮图片或分批处理后重试。",
    "type": "invalid_request_error",
    "code": "invalid_request",
    "param": null,
    "retryable": false,
    "request_id": "req-example",
    "request_limit_contract_version": 1,
    "request_limit": {
      "kind": "request_bytes",
      "origin": "upstream",
      "maximum": null,
      "actual": null
    },
    "retry_contract_version": 1,
    "automatic_retry_allowed": false,
    "recovery_owner": "client",
    "transformed_retry_allowed": true,
    "recommended_action": "reduce_image_payload"
  }
}
```

若启用了 `x-medcode-vision-recovery-contract: 1`，无输出情况下还包含：

```json
{
  "vision_recovery_contract_version": 1,
  "vision_recovery": {
    "image_count": 4,
    "attempts": 1,
    "maximum_attempts": 2,
    "content_delivered": false,
    "stop_reason": "not_retryable"
  }
}
```

这是同一 `error` 对象的附加字段，不是第二个错误事件。图片数按实际请求记录。
没有声明视觉恢复能力的客户端仍获得请求大小分类和严格停止字段。

## 流式响应

不能仅凭请求中的 `stream=true` 或响应 HTTP 200 判定成功。

- Chat 尚未发出响应头时，返回 HTTP 413 和上述 JSON；客户端应检查响应类型。
- Chat 已开始 SSE 时，HTTP 状态保持 200，通过 `data: {"error": {...}}` 返回相同错误字段。
- Responses 已开始 SSE 时，HTTP 状态保持 200，通过 `event: response.failed` 返回错误，
  错误位于 `data.response.error`，包含相同的分类、恢复信息和请求号。
  Responses SSE 的错误对象不要求包含 JSON 样例中的 `type`、`param`。
- 只发送一个失败终态，不追加成功的 `response.completed` 或 `[DONE]`。
- 若已交付部分内容，保留已交付内容，停止重放；视觉摘要为
  `content_delivered=true`、`stop_reason=content_delivered`。

上游 HTTP 200 内含 413 时，诊断记录保留传输状态 200，供应商尝试的
`failure.upstreamStatus` 保留 413，避免把传输状态与业务错误混为一谈。

## 客户端接入和验收

1. 先执行严格停止合同，确保任何自动重试入口均停止；再用
   `request_limit_contract_version === 1`、`request_limit.kind === "request_bytes"`
   和 `request_limit.origin === "upstream"` 分类并展示恢复入口。
2. 本分支应在通用 HTTP 413/token 上下文分类之前识别；不能据此触发全文 token 压缩。
   既有 `image_limit` 分支保持兼容，不把 `maximum=null` 当成 0 或无限大。
3. 用户选择继续时，先缩减最终发送的 JSON、压缩或分批图片，再提交改变后的请求。
   保留原图、历史记录、已完成文件和工具步骤，不因恢复重复执行已完成操作。
4. 自动缩减并自动重试未在本批开放；`transformed_retry_allowed=true` 不覆盖
   `automatic_retry_allowed=false`。显式用户恢复也不能原样循环提交。
5. 用真实安装包验证 JSON、Chat SSE、Responses SSE 三种错误解析；验证关闭或开启
   视觉恢复请求头、带或不带工具、纯文本和图片请求均不会原样自动重试。
6. 本批仅修复映射和停止语义。恢复成功仍取决于请求实际缩减或上游限制调整；
   使用资产 URL 时仍需验证上游能下载图片。

## Gateway 验证入口

相关测试位于 `apps/gateway/src/index.test.ts`（名称包含 `upstream 413`），以及
`services/openai-compatible-provider.test.ts`、`services/provider-stream.test.ts`、
`services/vision-request-recovery.test.ts`、`http/error-response.test.ts`。
接口回归使用本地合成供应商，不调用生产模型，不消耗真实用户额度。

2026-11-06 验证通过：`npm run build`；以下 8 个测试文件合计 720 项通过，
包含完整的 Gateway 路由回归：

```bash
npx vitest run apps/gateway/src/index.test.ts apps/gateway/src/openai-compat.test.ts apps/gateway/src/responses-compat.test.ts apps/gateway/src/services/openai-compatible-provider.test.ts apps/gateway/src/services/provider-stream.test.ts apps/gateway/src/services/vision-request-recovery.test.ts apps/gateway/src/services/vision-input-policy.test.ts apps/gateway/src/http/error-response.test.ts
```

其中新增 38 个接口场景覆盖 Chat/Responses、流式/非流式、工具开关、视觉恢复开关、
HTTP 413/HTTP 200 内含 413、纯文本，以及部分上游输出。
实际客户端安装包的恢复行为与生产发布仍需后续验收。

本批提交可用以下命令定位，部署状态以实际发布记录和运行版本为准：

```bash
git log -1 --format='%H %s' -- docs/outbox/gateway-upstream-413-contract-2026-11-06.zh-CN.md
```

已有本地图片限制协议见
[多图片请求限制与视觉有限恢复合同](./medevidence-vision-limits-recovery-gateway-contract-2026-09-10.zh-CN.md)。
