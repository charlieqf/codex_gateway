# 多图片请求限制与视觉有限恢复：Gateway 联调合同 v1

日期：2026-09-10。本文冻结本批 Gateway 实施字段，取代审核回复中“字段待定”的部分。
源码、部署状态和验证证据见同日运维发布记录；客户端源码和安装包由客户端团队维护。

## 接入入口与发布边界

Origin：`https://goldencode.instmarket.com.au:1443`。
沿用现有 `Authorization: Bearer <cgu_live Key>`，不新增登录流程或凭据。
适用模型请求：`POST /v1/chat/completions`、`POST /v1/responses`，包含图片的
`goldencode` 请求使用现有视觉服务。本批不涉及图片生成接口的供应商重试。

图片限制字段对所有客户端增加返回；视觉有限恢复须显式声明客户端能力：

```http
x-medcode-vision-recovery-contract: 1
```

只有包含图片且请求头值严格等于字符串 `1` 时启用。缺失、未知值或纯文本请求不启用。
客户端必须先完成下文错误解析与停止合同验收，再发送此请求头。旧安装包不自动启用。
此声明不能代替客户端整个用户轮次的重试预算；客户端仍须防止 SDK、工具恢复、会话恢复
叠加自动重发。

## 能力查询

```http
GET /gateway/vision/capabilities
Authorization: Bearer <cgu_live Key>
```

成功 HTTP 200，`Cache-Control: no-store`；沿用视觉请求的身份和权益校验。
能力查询不依赖图片资产存储当前可用。响应为：

```json
{
  "image_limit_contract_version": 1,
  "vision_recovery_contract_version": 1,
  "limits": {
    "maximum_bytes": 20971520,
    "maximum_images_per_model_request": 8,
    "maximum_inline_bytes_per_model_request": 20971520,
    "maximum_request_body_bytes": 31457280
  }
}
```

`maximum_bytes` 是单图大小限制，与现有资产上传合同同名；所有字节值均以 byte 为单位。
请求体上限读取实际运行配置，示例为默认 30 MiB，客户端应使用返回值。
已有资产接口的 8 张／20 MiB 合同保持兼容。本接口不保证资产原件永久存在。

## 图片与请求体限制错误

保留 HTTP `413`、`error.code="invalid_request"`。12 张完整有效图片的示例：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "本次请求包含 12 张图片，单次最多允许 8 张。请减少本轮图片或分批分析。",
    "request_id": "req-example",
    "image_limit_contract_version": 1,
    "image_limit": { "kind": "image_count", "maximum": 8, "actual": 12 },
    "recovery_owner": "client",
    "transformed_retry_allowed": true,
    "recommended_action": "reduce_images_or_batch"
  }
}
```

示例省略通用 `type`、`param`、`retryable` 字段。

| image_limit.kind | maximum / actual 的含义 | 建议恢复 |
| --- | --- | --- |
| image_count | 模型输入的图片条目数 | 选择本轮必要图片或明确分批 |
| image_bytes | 单张内联图片解码后字节数 | 缩图后重建请求 |
| inline_image_bytes | 全部内联图片解码后字节总和 | 使用资产上传或分批 |
| request_bytes | HTTP JSON 请求体字节数；actual=null | 减小请求体，必要时将内联图片改为资产引用 |

后 3 类 `recommended_action="reduce_image_payload"`。`request_bytes` 也可能由文本
或其他 JSON 字段造成，不能据此认定图片数量超限，更不能当成模型 token 上下文超限。
HTTP 层提前拒绝请求体时尚未解析图片，因此 `actual` 为 `null`。

数量校验以解析成功后的完整图片列表为准，重复 URL 每次出现均计数，涵盖用户消息和
工具输出。若先遇到格式错误或单图超限，先返回该错误，不能保证同时得到完整图片数。
Gateway 不删除图片、不静默裁剪用户内容，也不获取任意远程 URL 来统计其文件大小。
这些拒绝发生在模型调用之前，实际供应商调用数为 0。

客户端解析顺序必须是：严格停止合同 → 图片专用分类 → 已有 token 上下文分类 → 通用错误。
图片恢复须改变本轮实际请求内容，不能原样重发；不得因此重复执行已完成的生图或写文件。

## 视觉有限恢复与最终失败

启用后，同一 Gateway 请求最多两次实际模型调用，包含首次生成、工具参数纠错和故障重试。
首跳可恢复失败后，重试同一视觉服务；不切换到纯文本服务，不排除唯一视觉账号。
两次调用及等待使用同一总期限。现有服务端期限与 `x-medcode-request-timeout-ms` 的规则
继续适用；若最终解析的期限为 0，本能力使用 600,000 ms 总期限。第二次不会重新计时。

仅在没有输出或工具调用、没有取消且期限足够时，考虑下列内部分类：

- 上游 HTTP 408、429、500、502、503、504；上游 401/403 即使公开错误码相同也不重试。
- 响应头之前的连接失败、连接重置、等待响应头超时；DNS、TLS 及流中断不泛化为可恢复。
- 普通故障至少等待 250 ms；429 必须有有效 `Retry-After` 秒数或标准 HTTP 日期，并遵守
  其等待时间。缺失或无效值不自动重试，不能把兼容错误中的默认等待值当成供应商明确要求。
- 等待后至少保留 1 秒调用时间；内容已交付、已收取语义输出／工具调用、取消或期限到期即停止。

最终供应商失败沿用现有 HTTP 状态和错误码，增加严格类型字段：

```json
{
  "error": {
    "code": "upstream_unavailable",
    "request_id": "req-example",
    "retry_contract_version": 1,
    "automatic_retry_allowed": false,
    "vision_recovery_contract_version": 1,
    "vision_recovery": {
      "image_count": 4,
      "attempts": 2,
      "maximum_attempts": 2,
      "content_delivered": false,
      "stop_reason": "calls_exhausted"
    }
  }
}
```

示例省略 message 等通用字段。`retry_contract_version` 为数字，`automatic_retry_allowed`
为布尔值，不接受把字符串 `"false"` 当成布尔值。严格停止指令优先于通用 `retryable`、
`transformed_retry_allowed`、`recommended_action` 及 SDK 默认重试策略。
工具参数校验失败、工具输出截断和输出长度错误，在此能力下也遵守这一最终停止合同。
客户端可以保留用户明确点击重试的入口；不自动开启下一轮相同调用。

| stop_reason | 含义 |
| --- | --- |
| calls_exhausted | 两次模型调用预算已用完 |
| deadline_exhausted / deadline_insufficient | 总期限已到／不足以等待并完成下一次调用 |
| content_delivered | 已向客户端交付内容 |
| response_started | 已收到语义内容或工具调用，不能透明重放 |
| cancelled | 用户取消或连接已断开 |
| not_retryable | 不在本次可恢复分类内 |
| retry_after_missing | 429 未提供有效且支持的等待要求 |
| no_available_service | 初始阶段没有可用视觉服务，模型调用数为 0 |

普通 JSON、Chat SSE `error`、Responses SSE 的最终错误均保留上述字段和请求编号。
每次请求只返回一个失败终态，不再跟成功完成事件或 `[DONE]`。断连时不保证客户端还能
收到错误帧，应以 Gateway 诊断记录为准。SSE 创建事件和心跳不是业务输出。
成功响应不携带停止重试标记。

## 诊断、验收与客户端责任

Gateway 继续按 request ID 记录一次请求终态和结算；每次供应商尝试单独记录，并保留
failure_retry 与工具 recovery 的用途区别。最后一次尝试增加 `vision_recovery` 诊断，
含图片数、实际调用数、交付状态和停止原因。管理端会话查询可查看，数据库无需迁移。
模型调用前的图片／请求体限制拒绝另以 request ID、限制分类和数值写入结构化日志，调用数为 0。
不记录原始图片、带签名 URL 或完整材料；本批不修改任何已有权益或计费规则。

客户端团队实施并用真实安装包验收：

1. 在最终模型输入处统一选择图片，先选图再刷新 URL；保留用户原图、工具结果与文件引用。
2. 8 张历史图加 4 张工具图不会发送 12 张；点名旧图、超过 8 张的比较任务需要选图／分批策略。
3. 图片超限优先减图／分批，不直接触发全文压缩；4 张后可在原会话继续。
4. 所有 JSON/SSE 解析和工具恢复路径保留严格停止字段，确认不会叠加 SDK 或会话自动重试后，
   才启用请求头。验收首跳 500 后成功、两次失败、429、取消、部分输出和工具纠错耗尽预算。
5. 验收 URL 到期、资产到期和图片版本变化；原件缺失须明确提示。
6. 完成原 PPT 会话并验证实际 pptx 存在、可打开且应检查页面全部验收。

Gateway 故障注入成功不等于真实客户端恢复或 PPT 交付验收完成。本文不宣称客户端已实施。
