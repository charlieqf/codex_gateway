# GoldenCode 图片理解：客户端 URL-only 接入说明

日期：2026-08-08

环境：R760 生产 Gateway

Base URL：`https://goldencode.instmarket.com.au:1443`

客户端模型名：`goldencode`

## 1. 上线结论

R760 已上线 URL-only 图片理解流程：

- 所有图片先由客户端直传私有 Cloudflare R2，再把 Gateway 返回的短时签名 HTTPS URL 放入模型请求；客户端不要发送 base64 图片。
- 完整请求历史中只要包含图片，Gateway 就路由到 xAI `grok-4.5`。
- 纯文本请求仍在腾讯与 TokenSwitch 的 `glm-5.2` 双平台之间负载均衡。
- 图片请求不会静默降级到文本模型，避免模型没有读取图片却继续猜测。
- 公网模型合同保持 `200k context / 128k max output`。
- Chat Completions 与 Responses API 均已验证首问和追问。

生产 release：`abb137325bfddda7cb5621bbffb202a040f5bd12`

xAI 图片输入的上游约束可参考 [xAI Image Understanding](https://docs.x.ai/developers/model-capabilities/images/understanding) 与 [xAI Grok 4.5](https://docs.x.ai/developers/models/grok-4.5)。

## 2. 必须实现的上传流程

客户端对每张图片依次执行以下操作：

1. 在本地完成旋转、压缩和去除 EXIF，然后计算原始二进制的精确字节数及小写 SHA-256。
2. 调用 Gateway 创建 asset，取得稳定 `asset_id` 和一次性预签名 PUT URL。
3. 把图片原始二进制直接 PUT 到 R2。不要使用 JSON、base64、multipart，也不要把 Gateway API key 发给 R2。
4. 调用 complete；Gateway 会重新读取对象并校验类型、大小、PNG/JPEG 文件头和 SHA-256。
5. 使用 complete 返回的 `image_url` 发起模型请求。
6. 每次追问前用稳定 `asset_id` 换取新的 `image_url`，并替换历史中的旧签名 URL。
7. 用户删除附件、关闭会话或任务结束时调用 DELETE。

### 2.1 创建 asset

```http
POST /gateway/vision/assets
Authorization: Bearer <GATEWAY_API_KEY>
Content-Type: application/json
```

```json
{
  "content_type": "image/png",
  "size_bytes": 21151,
  "sha256": "<64 位小写十六进制>"
}
```

成功返回 `201`：

```json
{
  "asset_id": "va1.<signed-payload>.<signature>",
  "state": "pending_upload",
  "content_type": "image/png",
  "size_bytes": 21151,
  "sha256": "<sha256>",
  "upload": {
    "method": "PUT",
    "url": "https://<private-r2-presigned-url>",
    "headers": {
      "Content-Type": "image/png",
      "If-None-Match": "*"
    },
    "expires_at": "<ISO-8601>"
  },
  "asset_expires_at": "<ISO-8601>",
  "limits": {
    "maximum_bytes": 20971520,
    "maximum_images_per_model_request": 8
  }
}
```

客户端应把 `asset_id` 作为附件的稳定服务端标识保存。签名 URL 只是短期凭据，不能作为附件主键，也不要写入日志、埋点或崩溃报告。

### 2.2 直传 R2

```http
PUT <upload.url>
Content-Type: image/png
If-None-Match: *

<图片原始二进制>
```

必须原样使用 `upload.headers`；不要添加 Gateway 的 `Authorization`。成功状态为 `200`。`If-None-Match: *` 防止相同对象键被覆盖。

Desktop 第一版应在 Electron main process 或原生网络层执行 PUT。Renderer/browser 直传会受 R2 CORS 约束，目前不作为已上线合同；如果必须从 renderer 上传，请先把准确的生产 Origin 提供给 Gateway 团队，再配置最小范围 CORS，不能使用宽泛的 `*`。

### 2.3 完成校验

```http
POST /gateway/vision/assets/<asset_id>/complete
Authorization: Bearer <GATEWAY_API_KEY>
```

成功返回 `200`：

```json
{
  "asset_id": "<asset_id>",
  "state": "ready",
  "content_type": "image/png",
  "size_bytes": 21151,
  "sha256": "<sha256>",
  "image_url": "https://<private-r2-presigned-read-url>",
  "read_url_expires_at": "<ISO-8601>",
  "asset_expires_at": "<ISO-8601>"
}
```

只有 complete 成功后才能把图片交给模型。当前时效为：上传 URL 10 分钟、读取 URL 30 分钟、asset 24 小时。

### 2.4 刷新读取 URL

```http
POST /gateway/vision/assets/<asset_id>/read-url
Authorization: Bearer <GATEWAY_API_KEY>
Content-Type: application/json

{}
```

成功返回与 complete 相同结构的新 `image_url`。建议每次发送图片请求或追问前都刷新，而不是判断旧 URL 是否即将过期。

### 2.5 删除

```http
DELETE /gateway/vision/assets/<asset_id>
Authorization: Bearer <GATEWAY_API_KEY>
```

成功返回 `204`。客户端应持久化待清理的 `asset_id`，即使应用崩溃，也应在下次启动时补做 DELETE。

## 3. 图片约束与预处理

- 仅支持 `image/png` 和 `image/jpeg`；不要发送 WebP、GIF、HEIC、TIFF、SVG 或 PDF。
- 单张图片最大 `20 MiB`，完整模型请求历史最多 8 张图片。
- 每张图片都单独创建 asset；不要把多张图片拼成一个 multipart 上传。
- 截图、柱状图、表格优先使用 PNG；普通照片优先使用 JPEG，质量建议 85–90。
- 自动处理 EXIF 方向并移除不需要的 EXIF/GPS 元数据。
- 普通图片最长边可缩放到约 2,048–3,072 像素；小字号坐标、表格和医学标注不要过度缩小。
- 客户端应显示缩略图、上传进度、校验状态和失败重试入口。

## 4. 模型请求

### 4.1 Chat Completions 首问

```json
{
  "model": "goldencode",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请描述这张柱状图的数据特点，并指出最高和最低的柱。"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "<complete 返回的 image_url>",
            "detail": "high"
          }
        }
      ]
    }
  ],
  "reasoning_effort": "medium",
  "stream": true
}
```

### 4.2 Responses API 首问

```json
{
  "model": "goldencode",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "请描述这张柱状图的数据特点。"
        },
        {
          "type": "input_image",
          "image_url": "<complete 返回的 image_url>",
          "detail": "high"
        }
      ]
    }
  ],
  "reasoning": {
    "effort": "medium"
  },
  "store": false,
  "stream": true
}
```

当前 Gateway 是无状态接口：`store: true` 和 `previous_response_id` 不属于已上线合同。Responses API 应显式发送 `store: false`。

## 5. 图片追问的正确实现

Gateway 不保存模型会话，追问时不能只发送“哪个最高？”。客户端必须：

1. 用 `asset_id` 调用 read-url，取得新的签名 URL；
2. 重放原始用户问题和原图，并把历史中的旧 URL 替换为新 URL；
3. 重放上一轮 assistant 完整回答；
4. 追加本轮追问。

Chat Completions 示例：

```json
{
  "model": "goldencode",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请描述这张柱状图。"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "<read-url 刷新后的 image_url>",
            "detail": "high"
          }
        }
      ]
    },
    {
      "role": "assistant",
      "content": "<上一轮模型返回的完整文本>"
    },
    {
      "role": "user",
      "content": "其中哪一根柱最低？"
    }
  ],
  "stream": true
}
```

Responses API 使用同样原则，把原始 `input_image`、上一轮 assistant message 和新 user message 一起放入新的 `input` 数组。不要依赖旧签名 URL，也不要依赖 `previous_response_id`。

只要本次完整历史中仍有图片，Gateway 就继续路由到 xAI。若追问时省略图片，请求会按纯文本路由到 `glm-5.2`，模型无法重新观察原图。

## 6. 重试与错误处理

| 状态/错误码 | 含义 | 客户端处理 |
|---|---|---|
| `400 invalid_request` | 字段或请求结构错误 | 修正请求，不要原样重试 |
| `400 unsupported_format` | 不是 PNG/JPEG | 在本地转换后重新创建 asset |
| `400 unsupported_size` | 空文件或超过 20 MiB | 压缩或重新选择 |
| R2 PUT `412` | 相同 grant 的对象已存在，常见于“请求实际成功但客户端未收到响应” | 不要覆盖；直接调用 complete，让 Gateway 校验内容 |
| `404 vision_asset_not_found` | asset_id 不属于当前用户，或上传尚不存在 | 核对 asset_id 和 PUT 结果；不要无限重试 |
| `410 vision_asset_expired` | asset 已超过 24 小时 | 从本地源文件重新上传 |
| `422 vision_asset_invalid` | 类型、大小、文件头或 SHA-256 不一致 | 丢弃本次 asset，重新处理图片并上传 |
| `429` | Gateway 频率/额度限制 | 指数退避并限制次数 |
| `503 service_unavailable` | R2、xAI 或相关链路暂时不可用 | 保留本地图片，稍后有限次数重试 |

只有在没有取得 `asset_id` 时才重新调用 create；PUT、complete、read-url 和 DELETE 可以在网络失败后有限次数重试。图片模型请求不得自动降级为纯文本请求。

所有 Gateway 请求都应保存响应头 `X-Request-Id`；问题上报需附客户端时间、版本、接口路径和 HTTP 状态。不得记录 Gateway API key、完整 `asset_id`、完整签名 URL 或图片内容。

## 7. 隐私、删除与生命周期

R2 bucket 为私有 bucket，但预签名 URL 在有效期内属于 bearer credential，拿到 URL 的一方即可执行 URL 所允许的动作。

图片最终会由 xAI 从 R2 读取，因此医学图片上线前必须完成产品告知和合规确认，并至少做到：

- 上传前移除姓名、证件号、住院号、二维码、人脸及其他非必要身份信息；
- 未获得适当授权时，不上传可识别患者身份的原始医学影像；
- 日志、崩溃报告、剪贴板同步和分析埋点不得保存图片或签名 URL；
- 用户删除附件、关闭会话及任务结束时主动调用 DELETE。

`asset_expires_at` 表示 Gateway 不再签发读取 URL，不等同于 R2 对象已物理删除。当前对象级凭据无权修改 bucket lifecycle，因此客户端不能依赖自动删除；Gateway 团队仍需按 [Cloudflare R2 Object Lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) 在控制台为前缀 `vision-temp/` 增加“1 天后删除”的 lifecycle 兜底。该事项不影响当前上传、理解、追问和显式删除流程。

## 8. R760 生产验证记录

2026-08-08 使用程序生成的 PNG 柱状图完成了公网端到端验证：

- asset create：`req-5781a605-7129-493e-82fc-486cf6bf4226`；
- R2 PUT、完整 SHA-256 校验及 complete：`req-c2d8b10d-f9e4-407a-847a-eda0da570eac`；
- Chat 首问：`req-4abd0a8e-b815-447f-bd5d-e714b97dab9e`；
- Chat 追问：`req-eef87e32-f1a1-49e6-b232-f8062b22c78f`；
- Responses 首问：`req-8ce7066d-da17-42b5-8c0d-846dc68bdfab`；
- Responses 追问：`req-94d8f6e7-f651-488f-ae5b-07089bd9e16c`；
- 纯文本对照：`req-c42646f6-d2b6-47e0-bc2b-cf079957f5cc`。

四次图片模型请求的数据库归因均为 `provider=xai`、`upstream_runtime=xai`、`upstream_model=grok-4.5`、`upstream_account_id=xai-vision-main`。纯文本对照为腾讯 `glm-5.2`。追问前均刷新了读取 URL 并重放原图；模型正确回答图表差值和指定数值对应类别。

验证还覆盖了不可覆盖 PUT（`412`）、删除（`204`）、删除后 read-url（`404`）、临时用户/API key 清理和未完成 reservation 归零。最终 Gateway 健康且重启计数为 0；测试遗留的 4 个未完成对象已按内容哈希精确清理，bucket 对象审计为 0。

## 9. 客户端联调验收项

- PNG 和 JPEG；
- 1 张及多张图片，完整历史不超过 8 张；
- 每张图片统一走 create → PUT → complete；
- Chat 与 Responses 的首问；
- 刷新 URL、重放原图及连续追问；
- 上传响应丢失后 PUT `412` → complete 恢复；
- URL/asset 过期后重新上传；
- WebP、超过 20 MiB、错误 SHA-256 的拒绝路径；
- 删除附件、关闭会话、应用崩溃后的补偿 DELETE；
- R2/xAI 暂时不可用、取消请求及有限重试；
- 日志和崩溃报告中不出现 API key、asset_id、签名 URL 或图片内容。
