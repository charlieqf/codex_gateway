# GoldenCode Local 桌面客户端对接联调说明

| 项目 | 当前生产契约 |
| --- | --- |
| 适用客户端 | MedEvidence Desktop、GoldenCode Desktop |
| Provider ID | `medcode` |
| SDK | `@ai-sdk/openai-compatible` |
| Base URL | `https://goldencode.instmarket.com.au:1443/v1` |
| 云端模型 | `goldencode`，客户端显示名 `GoldenCode` |
| 本地模型 | `goldencode-local`，客户端显示名 `GoldenCode Local` |
| 鉴权 | 继续使用用户现有 `cgu_live_*`；手机号登录后取得的仍是同一类统一 Key |
| 对话接口 | `POST /v1/chat/completions` |
| 模型发现 | `GET /v1/models` |
| 服务端上线状态 | 已上线并通过 R760 内部及真实公网双模型验收 |
| 客户端源码状态 | `dev` 分支 `998e21dbfe` 已包含模型项；安装包/更新源尚未发布 |

## 1. 客户端需要实现的最终效果

客户端的模型选择器应在同一个 `medcode` Provider 下显示两个并列选项：

```text
medcode/goldencode        -> GoldenCode
medcode/goldencode-local  -> GoldenCode Local
```

不要新增第二个 Provider、第二套 API Key 或第二个服务域名。选择模型后，仅改变发送给
Gateway 的 `model` 字段：

```text
客户端模型选择
  -> 本地 OpenCode sidecar
  -> https://goldencode.instmarket.com.au:1443/v1
  -> POST /v1/chat/completions
  -> model = goldencode 或 goldencode-local
```

服务器不会在两个模型之间静默回退。`goldencode-local` 不可用时，客户端应显示本次请求错误，
允许用户明确重试或手动切换到 `goldencode`，不得悄悄改变模型。

## 2. 鉴权与手机号登录

两种入口最终使用同一鉴权契约：

1. 已持有 `cgu_live_*` 的用户继续使用原 Key，不需要重新发 Key；
2. 手机号是登录身份，不是直接放入 `Authorization` 的 API 凭据；
3. 手机号登录完成后，沿用现有 bootstrap/resolve 流程取得 `cgu_live_*`，再把它作为
   OpenAI-compatible API Key；
4. 两个模型都使用同一个请求头：`Authorization: Bearer <cgu_live_*>`；
5. 不要把 Key 写入日志、错误上报、截图、分析事件或客户端明文配置。

2026-08-24 已把 155 个原本仅允许 `goldencode` 的活跃 Desktop 底层凭据逐条追加
`goldencode-local`；31 个原本不限制模型的活跃凭据保持不变。新发 Key 和手机号登录创建的
底层凭据也会同时允许两个模型。迁移后 330 个现有、底层凭据有效的统一 Key 均具备双模型
权限。另有 2 个历史统一 Key 的底层凭据早已失效，这类 Key 本来就不能正常调用，遇到时应走
现有重新登录/重新签发流程，而不是在客户端绕过鉴权。

## 3. OpenCode 配置

统一客户端源码已经在
`packages/desktop/resources/opencode-config/opencode.jsonc` 的现有 `medcode.models` 下加入：

```jsonc
"goldencode-local": {
  "name": "GoldenCode Local",
  "tool_call": true,
  "reasoning": true,
  "variants": {
    "none": { "reasoningEffort": "none" },
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" },
    "xhigh": { "reasoningEffort": "xhigh" }
  },
  "attachment": false,
  "temperature": true,
  "limit": { "context": 32768, "output": 8192 },
  "modalities": { "input": ["text"], "output": ["text"] },
  "status": "beta"
}
```

现有 Provider 配置保持不变：

```jsonc
"medcode": {
  "name": "MedCode",
  "npm": "@ai-sdk/openai-compatible",
  "api": "https://goldencode.instmarket.com.au:1443/v1",
  "env": ["MEDEVIDENCE_KEY"]
}
```

注意：`goldencode-local` 当前是纯文本模型，不接受图片或文件附件。客户端应遵守
`attachment: false` 和文本输入模态配置；`goldencode` 的现有图片能力不变。

## 4. API 请求与响应

模型发现：

```bash
curl -sS https://goldencode.instmarket.com.au:1443/v1/models \
  -H "Authorization: Bearer ${CGU_LIVE_KEY}"
```

有效凭据应至少看到以下两个精确 ID：

```json
{
  "data": [
    { "id": "goldencode", "object": "model" },
    { "id": "goldencode-local", "object": "model" }
  ]
}
```

非流式本地模型请求：

```bash
curl -sS https://goldencode.instmarket.com.au:1443/v1/chat/completions \
  -H "Authorization: Bearer ${CGU_LIVE_KEY}" \
  -H "Content-Type: application/json" \
  --data '{
    "model": "goldencode-local",
    "messages": [{"role":"user","content":"Reply with OK."}],
    "reasoning_effort": "low",
    "stream": false,
    "max_tokens": 64
  }'
```

切换到云端模型时只需改成：

```json
{ "model": "goldencode" }
```

成功响应的顶层 `model` 会回显公开模型 ID，即 `goldencode` 或 `goldencode-local`。客户端埋点、
会话元数据和故障上报也应记录这个公开 ID，不能记录内部上游模型名。

流式请求继续使用 OpenAI Chat Completions SSE 契约，终止帧为：

```text
data: [DONE]
```

`goldencode-local` 已验证 OpenAI 工具调用的 `required`、指定函数、`none` 以及 assistant
`tool_calls` + `tool` 回填续聊；存在工具调用时公开 `finish_reason` 为 `tool_calls`。

## 5. 能力差异

| 能力 | `goldencode` | `goldencode-local` |
| --- | --- | --- |
| 实际推理 | 现有云端 GLM-5.3 路由 | R760 本地 Qwen3.8-27B-FP8 |
| 文本对话 | 支持 | 支持 |
| 图片输入 | 保持现有支持 | 不支持 |
| 工具调用 | 保持现有支持 | 支持，已验收 required/named/none/回填 |
| 上下文声明 | 保持现有配置 | 32,768 tokens |
| 最大输出声明 | 保持现有配置 | 8,192 tokens |
| reasoning effort | 保持现有行为 | none/low/medium/high/xhigh |
| 服务故障域 | 云端 Provider | R760 本地 GPU/vLLM |

Gateway 的混合健康策略会隔离本地推理故障：Qwen 不健康时，现有 Gateway 和
`goldencode` 仍保持服务；只有 `goldencode-local` 请求返回明确错误。

## 6. 客户端错误处理

| HTTP | 常见含义 | 客户端处理 |
| --- | --- | --- |
| 401 | Key 缺失、无效、撤销或已过期 | 进入现有重新登录/重新签发流程；不要自动换模型 |
| 402/403 | Plan、Scope 或账户状态不允许 | 显示账户/权限提示并保留 request ID |
| 404 `model_not_found` | 模型 ID 拼写错误或服务端未发布 | 不重试；检查是否精确发送两个约定 ID |
| 429 | 用户 RPM、Token 或并发配额触发 | 按现有退避策略重试，避免并发风暴 |
| 502/503 | 所选上游暂时不可用 | 显示所选模型不可用；用户可明确切换另一模型 |

所有失败都应保留响应中的 `x-request-id`（若有）用于服务端排查，但不得连同 Bearer Key 或
完整敏感提示词上报。

## 7. 客户端团队联调清单

- [ ] MedEvidence 与 GoldenCode 的模型选择器均显示 `GoldenCode`、`GoldenCode Local` 两项；
- [ ] 两项都属于 `medcode` Provider，Base URL 完全相同；
- [ ] 旧的有效 `cgu_live_*` 不重新登录即可分别完成两个模型的一次非流式请求；
- [ ] 手机号登录取得统一 Key 后可分别完成两个模型的一次非流式请求；
- [ ] `goldencode-local` 流式请求正常收到内容、usage 和 `[DONE]`；
- [ ] `goldencode-local` 的 required/named/none 工具选择和工具结果回填正常；
- [ ] 选择本地模型时附件入口被禁用或给出明确不支持提示；
- [ ] 客户端不会把 `goldencode-local` 静默替换为 `goldencode`；
- [ ] 401、404、429、502/503 均按上表处理并保留 `x-request-id`；
- [ ] 打包后的安装资源实际包含新模型项，而不只是源码目录已修改；
- [ ] 两个桌面产品各完成一次安装包级真实公网验收。

## 8. 已完成的服务端验收

2026-08-24 已完成：

- R760 loopback 双模型完整烟测：鉴权、models、非流式、SSE、usage、工具调用、限流、撤销；
- 同一生产 Origin 的完整公网烟测，请求
  `req-d925ad1a-da5e-4158-b9c8-a879cb497adf` 对应本地模型成功事件；
- 从独立 Windows 工作机使用同一枚临时 `cgu_live_*`，先发现两个模型，再分别调用
  `goldencode` 和 `goldencode-local`，两次均成功且响应回显正确公开模型 ID；
- 临时统一 Key、底层 Gateway Key 和测试用户已撤销/禁用并删除临时明文；
- Gateway 日志未检出临时 Key 或烟测提示词。

客户端源码变更位于 MedEvidence/GoldenCode 统一仓库 `dev` 分支提交 `998e21dbfe`。该提交已通过
OpenCode 配置准备测试和 Desktop TypeScript 类型检查。尚未得到安装包构建、签名和更新源发布
授权，因此服务端上线不等于客户端二进制已经发布；客户端团队应基于该提交完成安装包级联调，
再按现有发布流程推进。
