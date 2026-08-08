# GoldenCode 图片理解能力：客户端接入说明

日期：2026-08-08  
适用环境：R760 生产 Gateway  
公网地址：`https://goldencode.instmarket.com.au:1443`  
客户端模型名：`goldencode`

## 1. 上线结论

R760 已上线 GoldenCode 图片理解能力，客户端不需要新增模型名或切换 API 地址：

- 请求历史中包含图片时，Gateway 自动路由到 xAI `grok-4.5`。
- 请求中没有图片时，仍按原规则在腾讯与 TokenSwitch 的 `glm-5.2` 之间负载均衡。
- 图片上游失败时不会静默降级到文本模型，避免模型在看不到图片的情况下猜测。
- 公网模型合同保持 `200k context / 128k max output`。
- Research Worker、Research LLM 和其他 R760 服务没有随本次发布变更。

xAI 官方当前声明 `grok-4.5` 支持文本和图片输入；图片格式为 JPEG、PNG，单张上限为 20 MiB。参见 [xAI Image Understanding](https://docs.x.ai/developers/model-capabilities/images/understanding) 和 [xAI Grok 4.5](https://docs.x.ai/developers/models/grok-4.5)。

## 2. 客户端必须遵守的输入合同

### 2.1 格式

第一版只支持：

- PNG：`data:image/png;base64,...`
- JPEG：`data:image/jpeg;base64,...`
- 可由 xAI 公网访问的 HTTPS 图片 URL

暂不支持 WebP、GIF、HEIC、TIFF、SVG、PDF 页面、`file_id` 或 `multipart/form-data` 上传。`image/jpg` 也不要使用，应统一为 `image/jpeg`。

HTTPS URL 不得带 `user:password@host` 形式的嵌入凭据，URL 总长度不得超过 16,384 字符。允许使用短时有效的签名 URL，但 xAI 必须能够从公网读取该 URL。

### 2.2 数量与大小

- 一个请求的完整历史中最多 8 张图片。
- 单张 base64 图片解码后不得超过 20 MiB。
- 同一请求中所有 base64 图片解码后的合计不得超过 20 MiB。
- Gateway 的 JSON body 上限为 30 MiB。
- 当前 R760 公网 Nginx 入口仍为 20 MiB body 上限。base64 会增加约三分之一体积，因此客户端当前应将“所有原始图片合计”硬限制为 **14 MiB**，给 JSON 和 base64 开销留出余量。

如果确实需要发送 14–20 MiB 的单张图片，优先使用短时 HTTPS 签名 URL；如必须使用 base64，需要 Gateway 团队另行批准并把公网 Nginx 上限提高到至少 30 MiB。

### 2.3 图片预处理建议

以下是客户端体验建议，不是协议硬限制：

- 截图、柱状图、表格优先使用 PNG，避免压缩造成小字模糊。
- 普通照片优先使用 JPEG，质量建议 85–90。
- 自动处理 EXIF 方向，上传前把图片旋转到正确方向。
- 普通图片可把最长边压缩到约 2,048–3,072 像素；包含小字号坐标、表格或医学标注时不要过度缩小。
- 上传前移除不需要的 EXIF/GPS 元数据。
- 客户端应展示缩略图、文件大小、上传/分析状态，并允许用户在发送前删除图片。

## 3. Chat Completions 请求

首轮图片请求使用现有 `POST /v1/chat/completions`。推荐图表使用 `detail: "high"`；可选值为 `auto`、`low`、`high`。

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
            "url": "data:image/png;base64,<BASE64_DATA>",
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

使用 HTTPS URL 时只需替换 `url`：

```json
{
  "type": "image_url",
  "image_url": {
    "url": "https://example.com/temporary/chart.png?signature=...",
    "detail": "high"
  }
}
```

## 4. Responses API 请求

也可使用 `POST /v1/responses`：

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
          "image_url": "data:image/png;base64,<BASE64_DATA>",
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

当前 Gateway 是无状态接口：

- `store: true` 不支持。
- `previous_response_id` 不支持。
- 客户端应显式发送 `store: false`，并在每次请求中重放所需的完整对话历史。

## 5. 针对图片继续追问

图片追问不能只发送一句“哪个最高？”。Gateway 不保存图片，也不会通过上一条 response ID 恢复图片。每次需要模型继续观察原图时，客户端必须同时重放：

1. 原始用户问题；
2. 原始图片内容或同一可访问 URL；
3. 上一轮 assistant 回答；
4. 本轮追问。

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
            "url": "data:image/png;base64,<BASE64_DATA>",
            "detail": "high"
          }
        }
      ]
    },
    {
      "role": "assistant",
      "content": "上一轮模型返回的完整文本"
    },
    {
      "role": "user",
      "content": "其中哪一根柱最低？"
    }
  ],
  "stream": true
}
```

只要完整请求历史的任意位置仍包含图片，整次请求就会继续路由到 xAI。若客户端追问时省略原图，请求会被视为纯文本并回到 `glm-5.2`，模型将无法重新查看图片。

对于 HTTPS 签名 URL，客户端必须确保该 URL 在所有追问完成前仍然有效；否则应重新生成 URL 并在重放历史时替换。

## 6. 错误处理

客户端不要自动把图片请求改成纯文本重试。建议按以下方式展示：

| HTTP 状态 | 含义 | 客户端建议 |
|---|---|---|
| `400` | base64、URL、格式、`detail` 或请求结构无效 | 指明不支持的文件或字段，让用户重新选择 |
| `413` | 图片数量或体积超限；也可能由公网 Nginx 提前拒绝 | 压缩图片、减少数量，或改用 HTTPS URL |
| `401/403` | 凭据或权限问题 | 重新校验 API key，不要重复上传 |
| `429` | 频率或额度限制 | 延迟后有限次数重试 |
| `502/503/504` | xAI、代理或上游暂时不可用 | 保留用户输入，提示稍后重试；不得降级到文本模型 |

每次请求都应记录响应头 `X-Request-Id`。发生问题时，请把该值、客户端时间、版本号、接口路径和 HTTP 状态一并提供给 Gateway 团队；不要在日志中记录完整 base64、签名 URL 或 API key。

## 7. 隐私与合规

图片请求会从 R760 经出海代理发送给 xAI。Gateway 对 xAI 请求显式设置 `store: false`，但这不等于图片未离开本地环境。

客户端在开放医学图片上传前应确认产品和合规要求，至少做到：

- 明确告知用户图片将交由第三方模型处理；
- 上传前去除姓名、证件号、住院号、二维码、人脸及其他非必要身份信息；
- 未获得适当授权时，不上传可识别患者身份的原始医学影像；
- 客户端日志、崩溃报告和埋点不得保存图片 base64 或完整签名 URL。

## 8. R760 验证记录

上线 release：`aa9a0ec88a5cc6911a933f16c5337be90c77604a`

2026-08-08 已在公网完成以下验证：

- Chat Completions：上传程序生成的 PNG 三色柱状图，正确识别红、蓝、绿及最高柱。
- Responses API：重放原图和历史后追问最低柱，正确回答红色。
- 数据库归因：两次图片请求均为 `provider=xai`、`upstream_runtime=xai`、`upstream_model=grok-4.5`、`upstream_account_id=xai-vision-main`。
- 纯文本对照：仍路由到 `glm-5.2`；本次命中 TokenSwitch。
- 所有 R760 服务健康，重启计数均为 0；测试结束后未留下临时凭据或未结算 reservation。

客户端联调建议至少覆盖：PNG、JPEG、两张图片、追问重放、URL 过期、WebP 拒绝、超过 8 张、413、xAI 暂时不可用和取消请求。
