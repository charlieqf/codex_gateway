# Gateway 429 限流错误响应合同

日期：2026-07-15
合同版本：`rate_limit_contract_version = 1`
状态：代码与测试已实现，待生产部署后补充上线 commit 和部署时间。

## 1. 背景

Desktop 当前显示的“当前额度或频率已受限，请稍后再试或联系管理员”不是 Gateway 返回的原始文案，而是客户端对所有 `429 rate_limited` 使用的统一中文映射。旧 Gateway 响应没有公开 `limit_kind`，因此客户端无法区分每分钟请求频率、每日请求额度、并发、token 窗口额度和上游模型限流。

本合同保持 `error.code = "rate_limited"` 不变，在所有 Gateway 429 JSON 错误以及 OpenAI-compatible SSE 错误中增加稳定的分类字段。

## 2. 响应字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `error.code` | string | 继续为 `rate_limited`，兼容旧客户端。 |
| `error.request_id` | string | 本次 Gateway 请求 ID，用于客户端诊断和服务端追查。 |
| `error.rate_limit_contract_version` | number | 当前固定为 `1`。 |
| `error.limit_kind` | string 或 null | Gateway 本地限流的准确口径；上游或无法确认来源时为 `null`。 |
| `error.rate_limit_origin` | string | `gateway`、`upstream` 或 `unknown`。 |
| `error.retry_after_seconds` | number 或 null | 建议等待秒数；单请求 token 上限没有自动恢复时间时为 `null`。 |
| `error.limit.scope` | string | `credential`、`subject`、`entitlement` 或 `request`。 |
| `error.limit.window` | string | `minute`、`day`、`month`、`concurrency` 或 `request`。 |
| `error.limit.maximum` | number | 当前口径的上限。 |
| `error.limit.used` | number | 拒绝前已使用或预留的量。 |
| `error.limit.requested` | number | 本次请求准备新增的量。 |

非流式响应在可用时同时返回：

- `Retry-After: <seconds>`
- `X-Gateway-Limit-Kind: <limit_kind>`，仅 Gateway 本地分类存在时返回
- `X-Gateway-Rate-Limit-Origin: gateway|upstream|unknown`
- 既有 `X-Request-Id` 保持不变

SSE 已经开始输出后 HTTP 状态通常是 200，且不能再可靠修改响应头；客户端必须解析 SSE `data:` 内的 `error` 对象。

## 3. Gateway 本地请求限流示例

### 3.1 每分钟请求频率：`request_minute`

```json
{
  "error": {
    "message": "Request frequency limit reached: 10 of 10 requests used in the current minute. Retry in 5 seconds.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-minute",
    "retry_after_seconds": 5,
    "rate_limit_contract_version": 1,
    "limit_kind": "request_minute",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "credential",
      "window": "minute",
      "maximum": 10,
      "used": 10,
      "requested": 1
    }
  }
}
```

### 3.2 每日请求额度：`request_day`

```json
{
  "error": {
    "message": "Daily request quota reached: 500 of 500 requests used in the current UTC day. Retry in 28800 seconds.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-day",
    "retry_after_seconds": 28800,
    "rate_limit_contract_version": 1,
    "limit_kind": "request_day",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "credential",
      "window": "day",
      "maximum": 500,
      "used": 500,
      "requested": 1
    }
  }
}
```

`request_day` 按 UTC 自然日重置；客户端应使用 `retry_after_seconds` 显示准确恢复时间，不应自行假定本地午夜。

### 3.3 并发请求：`concurrency`

```json
{
  "error": {
    "message": "Concurrent request limit reached: 4 of 4 requests are active.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-concurrency",
    "retry_after_seconds": 1,
    "rate_limit_contract_version": 1,
    "limit_kind": "concurrency",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "credential",
      "window": "concurrency",
      "maximum": 4,
      "used": 4,
      "requested": 1
    }
  }
}
```

## 4. Gateway 本地 token 限流示例

### 4.1 单请求输入 token：`token_request_prompt`

```json
{
  "error": {
    "message": "Prompt token limit exceeded: this request needs 230000 tokens; the maximum is 200000.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-prompt",
    "retry_after_seconds": null,
    "rate_limit_contract_version": 1,
    "limit_kind": "token_request_prompt",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "request",
      "window": "request",
      "maximum": 200000,
      "used": 0,
      "requested": 230000
    }
  }
}
```

### 4.2 单请求总 token：`token_request_total`

```json
{
  "error": {
    "message": "Total token limit exceeded: this request needs 260000 tokens; the maximum is 250000.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-total",
    "retry_after_seconds": null,
    "rate_limit_contract_version": 1,
    "limit_kind": "token_request_total",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "request",
      "window": "request",
      "maximum": 250000,
      "used": 0,
      "requested": 260000
    }
  }
}
```

### 4.3 每分钟 token：`token_minute`

```json
{
  "error": {
    "message": "Token minute quota exceeded: 95000 tokens used or reserved, 10000 requested, maximum 100000.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-token-minute",
    "retry_after_seconds": 42,
    "rate_limit_contract_version": 1,
    "limit_kind": "token_minute",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "entitlement",
      "window": "minute",
      "maximum": 100000,
      "used": 95000,
      "requested": 10000
    }
  }
}
```

### 4.4 每日 token：`token_day`

```json
{
  "error": {
    "message": "Token day quota exceeded: 1950000 tokens used or reserved, 100000 requested, maximum 2000000.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-token-day",
    "retry_after_seconds": 28800,
    "rate_limit_contract_version": 1,
    "limit_kind": "token_day",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "entitlement",
      "window": "day",
      "maximum": 2000000,
      "used": 1950000,
      "requested": 100000
    }
  }
}
```

### 4.5 每月 token：`token_month`

```json
{
  "error": {
    "message": "Token month quota exceeded: 19950000 tokens used or reserved, 100000 requested, maximum 20000000.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-token-month",
    "retry_after_seconds": 1209600,
    "rate_limit_contract_version": 1,
    "limit_kind": "token_month",
    "rate_limit_origin": "gateway",
    "limit": {
      "scope": "entitlement",
      "window": "month",
      "maximum": 20000000,
      "used": 19950000,
      "requested": 100000
    }
  }
}
```

## 5. 上游模型限流示例

Gateway 已确认是上游模型或上游provider返回的限流时：

```json
{
  "error": {
    "message": "Upstream model rate limited.",
    "type": "rate_limit_error",
    "code": "rate_limited",
    "param": null,
    "request_id": "req-example-upstream",
    "retry_after_seconds": 60,
    "rate_limit_contract_version": 1,
    "limit_kind": null,
    "rate_limit_origin": "upstream"
  }
}
```

这里不能显示为“您的每日额度已用尽”。推荐文案是“上游模型当前繁忙或受到限流，请在 60 秒后重试”。如果 Gateway 只能确认收到 `rate_limited`，但没有本地 `limit_kind` 或可靠上游证据，则返回 `rate_limit_origin = "unknown"`，避免错误归因。

## 6. SSE 流式错误示例

```text
data: {"error":{"message":"Upstream model rate limited.","type":"rate_limit_error","code":"rate_limited","param":null,"request_id":"req-example-stream","retry_after_seconds":60,"rate_limit_contract_version":1,"limit_kind":null,"rate_limit_origin":"upstream"}}
```

客户端解析到带 `error.code = "rate_limited"` 的 SSE `data:` 后应终止当前模型步骤，不应继续等待 `[DONE]`，也不应把该帧当作助手正文。

## 7. 客户端展示建议

| `rate_limit_origin` / `limit_kind` | 建议展示 |
|---|---|
| `gateway / request_minute` | 请求过于频繁；显示每分钟上限和恢复秒数。 |
| `gateway / request_day` | 当日请求次数额度已用尽；显示 UTC 窗口恢复秒数。 |
| `gateway / concurrency` | 同时运行的任务过多；提示等待已有任务完成。 |
| `gateway / token_request_prompt` | 本次输入或上下文过大；提示缩短历史、附件或新建会话。 |
| `gateway / token_request_total` | 本次请求预计总 token 过大；提示减少输入或输出规模。 |
| `gateway / token_minute` | 短时间 token 使用过快；按恢复秒数重试。 |
| `gateway / token_day` | 当日 token 额度已用尽。 |
| `gateway / token_month` | 当月 token 额度已用尽；提示联系管理员或等待周期重置。 |
| `upstream / null` | 上游模型繁忙或限流；不要显示为用户自身额度耗尽。 |
| `unknown / null` | 暂时无法确认限流来源；显示 request ID 并按建议时间重试。 |

客户端退避必须优先读取响应体 `retry_after_seconds`，其次读取 `Retry-After` header，并增加随机抖动。相同用户turn内不得为每条遥测或模型步骤分别创建独立的立即重试循环。

## 8. 上线识别

客户端可用以下条件判断新合同已经上线：

```text
HTTP 429
error.code == "rate_limited"
error.rate_limit_contract_version >= 1
error.request_id 为非空字符串
error.rate_limit_origin in ["gateway", "upstream", "unknown"]
```

生产部署完成后，本节需要补充：

- Gateway Git commit
- Docker镜像构建时间
- Azure部署时间
- 公网smoke request ID
