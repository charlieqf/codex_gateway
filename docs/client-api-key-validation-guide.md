# 客户端开发者说明：API key 填写与校验

版本日期：2026-04-24

本文面向需要让用户填写 MedCode API key 的客户端开发者。典型场景包括 IDE 插件、CLI、桌面端设置页、内部 Web 控制台或后端管理页面。

## 接入地址

生产试用网关：

```text
https://gw.instmarket.com.au
```

API key 使用标准 Bearer 认证：

```http
Authorization: Bearer <API_KEY>
```

不要在日志、埋点、错误上报、URL query、截图或公开配置文件里记录完整 API key。界面上如需展示已保存的 key，只展示前后少量字符或服务端返回的 `credential.prefix`。

## 校验 API key

用户填写 API key 后，客户端应调用：

```http
GET /gateway/credentials/current
```

curl 示例：

```bash
curl -sS https://gw.instmarket.com.au/gateway/credentials/current \
  -H "Authorization: Bearer $MEDCODE_API_KEY"
```

这个接口只做 API key 校验并返回公开元信息：

- 不调用 MedCode 上游模型服务。
- 不创建会话。
- 不消耗普通请求限额。
- 缺少、错误、过期、吊销或所属用户被停用时返回 `401`。

成功响应：

```json
{
  "valid": true,
  "subject": {
    "id": "trial-user-1",
    "label": "Trial User 1"
  },
  "credential": {
    "prefix": "cgw_xxxxxxxx",
    "scope": "code",
    "expires_at": "2026-05-06T10:00:00.000Z",
    "rate": {
      "requestsPerMinute": 10,
      "requestsPerDay": 200,
      "concurrentRequests": 1
    }
  }
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `valid` | 固定为 `true`，表示当前 API key 可用。 |
| `subject.id` | API key 所属用户或接入方的内部 ID。 |
| `subject.label` | API key 所属用户或接入方的显示名称。 |
| `credential.prefix` | API key 前缀，可用于界面展示和问题排查；不是完整 key。 |
| `credential.scope` | 当前权限范围，试用阶段通常是 `code`。 |
| `credential.expires_at` | 过期时间；`null` 表示未设置过期时间。 |
| `credential.rate.requestsPerMinute` | 每分钟请求上限。 |
| `credential.rate.requestsPerDay` | 每日请求上限；`null` 表示未设置日上限。 |
| `credential.rate.concurrentRequests` | 同一个 API key 的并发请求上限。 |

## 推荐交互流程

1. 用户在设置页输入 API key。
2. 客户端调用 `GET /gateway/credentials/current`。
3. 如果返回 `200`，保存 API key，并在界面展示 `credential.prefix`、过期时间和限额信息。
4. 如果返回 `401`，不要保存 API key，提示用户检查 key 是否正确、是否过期、是否已被吊销。
5. 如果返回 `429`、`5xx` 或网络错误，不要判断 key 一定无效，提示用户稍后重试或联系管理员。
6. 后续模型调用使用 `https://gw.instmarket.com.au/v1` 和模型 ID `medcode`。

## TypeScript 示例

```ts
type CredentialInfo = {
  valid: true;
  subject: {
    id: string;
    label: string | null;
  };
  credential: {
    prefix: string;
    scope: string;
    expires_at: string | null;
    rate: {
      requestsPerMinute: number;
      requestsPerDay: number | null;
      concurrentRequests: number;
    };
  };
};

type ValidationResult =
  | { ok: true; data: CredentialInfo }
  | { ok: false; status: number; code?: string; message: string };

export async function validateMedCodeApiKey(apiKey: string): Promise<ValidationResult> {
  const res = await fetch("https://gw.instmarket.com.au/gateway/credentials/current", {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });

  if (res.ok) {
    return { ok: true, data: (await res.json()) as CredentialInfo };
  }

  let code: string | undefined;
  let message = `API key validation failed with HTTP ${res.status}.`;

  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code;
    message = body.error?.message ?? message;
  } catch {
    // Keep the generic message when the response is not JSON.
  }

  return { ok: false, status: res.status, code, message };
}
```

## 错误处理建议

| HTTP | `error.code` | 客户端建议 |
| --- | --- | --- |
| 401 | `missing_credential` | 提示用户输入 API key。 |
| 401 | `invalid_credential` | 提示用户检查 API key 是否复制完整。 |
| 401 | `revoked_credential` | 提示用户联系管理员重新发放 key。 |
| 401 | `expired_credential` | 提示用户 key 已过期，需要换新 key。 |
| 429 | `rate_limited` | 按 `retry_after_seconds` 延迟后重试。 |
| 503 | `service_unavailable` | 提示服务暂不可用，稍后重试或联系管理员。 |

客户端不要把 `401` 之外的错误直接解释成 API key 无效。网络错误、`429` 和 `5xx` 更可能是临时状态。

## 校验通过后的模型调用

OpenAI SDK 配置：

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.MEDCODE_API_KEY,
  baseURL: "https://gw.instmarket.com.au/v1"
});

const completion = await client.chat.completions.create({
  model: "medcode",
  messages: [{ role: "user", content: "Explain this TypeScript error." }]
});

console.log(completion.choices[0]?.message?.content);
```

当前兼容入口是 OpenAI Chat Completions beta：

- `GET /v1/models`
- `GET /v1/models/medcode`
- `POST /v1/chat/completions`

模型 ID 必须是 `medcode`。其他模型 ID 会返回 `404` 和 `model_not_found`。

## 排查信息

向服务管理员反馈问题时，请提供：

- 出错时间和时区。
- 调用的 endpoint。
- HTTP 状态码。
- 响应 header 里的 `X-Request-Id`。
- 响应体里的 `error.code`。
- `credential.prefix`，不要提供完整 API key。

不要发送完整 API key、完整 `Authorization` header、用户私有代码或本地文件内容。
