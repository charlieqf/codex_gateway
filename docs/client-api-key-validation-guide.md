# 客户端 API Key 填写与校验

版本日期：2026-08-31。

本文面向 Desktop、CLI、IDE 插件和内部 Web 客户端。生产 Gateway 为：

```text
origin: https://goldencode.instmarket.com.au:1443
base:   https://goldencode.instmarket.com.au:1443/v1
```

请求使用标准 Bearer 认证：

```http
Authorization: Bearer <API_KEY>
```

## 保存前校验

用户输入 key 后调用：

```http
GET /gateway/credentials/current
```

```bash
curl -sS https://goldencode.instmarket.com.au:1443/gateway/credentials/current \
  -H "Authorization: Bearer $GOLDENCODE_API_KEY"
```

该接口不调用模型、不创建会话，也不消耗普通模型请求限额。成功响应包含：

- `subject.id` 和显示名称；
- `credential.prefix`、scope、过期时间和速率限制；
- 当前 entitlement、能力和 token 用量字段（如果适用）。

只展示服务端返回的安全 prefix，不要自行回显完整 key。

## 推荐客户端流程

1. 在受保护的设置界面接收 key；
2. 调用 `/gateway/credentials/current`；
3. `200` 时保存到系统凭据存储，并显示 prefix/到期时间；
4. `401` 时不保存，提示 key 缺失、错误、过期、吊销或用户停用；
5. `426` 时提示升级客户端；
6. `429`、`5xx` 或网络错误时不要判定 key 无效，按响应建议重试；
7. 调用 `GET /v1/models` 获取当前模型，不硬编码历史模型列表。

当前公共文本模型是：

- `goldencode`：云端模型；
- `goldencode-local`：R760 本地模型，32,768 token context。

## 最小调用示例

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GOLDENCODE_API_KEY,
  baseURL: "https://goldencode.instmarket.com.au:1443/v1"
});

const completion = await client.chat.completions.create({
  model: "goldencode",
  messages: [{ role: "user", content: "Reply with: ok" }]
});
```

## 错误处理

| HTTP | 典型错误 | 客户端动作 |
| --- | --- | --- |
| 401 | credential 无效/过期/吊销 | 重新输入或联系管理员 |
| 413 | `context_compaction_required` | 压缩历史、重建请求，最多重试一次 |
| 426 | 客户端版本过低 | 升级客户端 |
| 429 | `rate_limited` | 遵守 `Retry-After`/`retry_after_seconds` |
| 5xx | 服务或上游暂不可用 | 保留 request ID，稍后重试 |

不要把非 401 错误解释为 key 无效。

## 隐私与排障

不要把完整 key 放入源码、普通配置、URL query、日志、埋点、截图、工单
或聊天。排障只提供：

- 时间与时区；
- endpoint、model 和 HTTP 状态；
- `X-Request-Id` 与 `error.code`；
- `credential.prefix`；
- 必要的 app version/session/message ID。

不要提供完整 Authorization header、用户私有正文或本地文件内容。
