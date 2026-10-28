# GoldenCode 客户端模型切换接入说明

状态：2026-10-23 已上线，Gateway 运行版本 `954eb3bedca6648405fa419d232cdb4a43dbe8fc`。
公网验收于 03:16 UTC 完成：14 次真实模型调用通过，包括同会话
`goldencode → goldencode-d → goldencode`、工具结果续接、流式响应和回执防重。
本文交付客户端开发；Gateway 已就绪，Desktop 选择器和交互仍需客户端实现及验收。

## 1. 模型选择器

保留三个可见选项，默认 `goldencode`：

| 显示名称建议 | 请求 `model` | 当前路由 | 上下文 / 最大输出 |
| --- | --- | --- | --- |
| GoldenCode · GLM | `goldencode` | 腾讯、天宽、TokenSwitch GLM-5.3 | 200,000 / 128,000 |
| GoldenCode · DeepSeek | `goldencode-d` | 腾讯 V4.1 Flash 1017、天宽 V4.1 Flash 260910 | 200,000 / 128,000 |
| GoldenCode · 本地 | `goldencode-local` | 原有本地服务 | 32,768 / 8,192 |

API Base：`https://goldencode.instmarket.com.au:1443/v1`。
沿用当前 Gateway Bearer Key 和现有客户端版本头，无需新增登录或换 Key。
HTTP 请求正文只传表中的公共模型 ID；如果客户端内部用 `medcode/goldencode-d`，
`medcode/` 是客户端 provider 前缀，不能一起发给 Gateway。注意正确拼写为 `goldencode-d`。

登录后从鉴权的 `GET /v1/models` 刷新模型列表和上下文、输出上限；该接口返回服务模型目录，
**不等同于当前 Key 或 Plan 对每个模型的授权清单**。标准旧双模型 Key 已随迁移扩展为三个模型，
自定义受限 Key 保持原权限。遇到 403 `model_not_allowed_for_credential` 时提示无权限，
不要轮询重试，也不要静默换模型。列表拉取失败时保留已有选择，不能悄悄切换用户模型。

云端两项支持 Chat Completions 和 Responses；local 保持现有 Chat 接入方式。
两家 DeepSeek 由 Gateway 做会话粘性分配和符合条件时的故障切换，客户端不选择供应商。
GLM 和 DeepSeek 是两个独立池，不跨模型系列自动故障切换。

## 2. 推理强度：切换云端模型时无需自动改档

两个云端公共模型统一显示三个选项：

| UI | API 值 | `goldencode` | `goldencode-d` |
| --- | --- | --- | --- |
| 低 | `low` | 支持 | 支持 |
| 高（默认） | `high` | 支持 | 支持 |
| 最高 | `max` | 支持 | 支持 |

切换 `goldencode ↔ goldencode-d` 时保留当前 `low/high/max`；没有历史设置时使用 `high`。
同一档位不保证不同模型有相同耗时、Token 消耗或输出质量；`max` 也不保证每次都更长。
不随模型切换自动提高到 max，也不自动降低到 low。

旧客户端配置按以下规则迁移，并让 UI 显示实际档位：`medium → high`、`none → low`。
**公共 Gateway 的 `none` 是兼容别名，不代表关闭思考**；不要提供标为“不思考”的 none 选项。
不要发送未经公共契约支持的 `minimal/xhigh/ultra` 或 1–100 数值档位。
local 继续使用其既有能力和参数规则，不能直接套用这两个云端模型的三档设置。

腾讯 1017 和天宽 260910 的上游直测结果相同：low/high/max 均 HTTP 200 且产生推理，
`thinking.type=disabled` 均可关闭推理，非法档位均 HTTP 400。这是**上游能力**；
当前公共 Gateway 统一开放的是上述三个思考档位。客户端无需添加上游 `thinking` 字段，
由 Gateway 转换。DeepSeek 官方接口同样区分思考开关和强度，见
[官方思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)。

Chat 正文使用顶层 `reasoning_effort`：

```json
{
  "model": "goldencode-d",
  "reasoning_effort": "high",
  "stream": true,
  "messages": [{"role": "user", "content": "请检查这段代码。"}]
}
```

Responses 使用 `reasoning.effort`：

```json
{
  "model": "goldencode-d",
  "reasoning": {"effort": "high"},
  "stream": true,
  "input": [{"type": "message", "role": "user", "content": "请检查这段代码。"}]
}
```

以上只是参数示例；实际续聊必须携带完整可见历史及工具结果。
目前 `/v1/models` 返回 ID 和长度限制，未返回推理档位或视觉能力；客户端按本文维护能力表，
不能把缺少某个能力字段解释成不支持，也不能从供应商模型名自行推断能力。

## 3. 会话内切换规则

Gateway 按每次请求正文的 `model` 路由；修改客户端选择不会改变已发出的请求。
建议客户端按以下方式实现：

1. 空闲时允许切换，保留会话 ID、可见消息、工具结果和当前推理强度。
2. 一轮执行期间锁定该轮模型和强度，包括该轮的工具调用后续步骤。选择新模型时显示
   “下一轮使用”，待当前轮结束再生效；不要让同一轮的工具循环因下拉框变化而意外换模型。
3. 每个新模型步骤生成新调用 ID，并将本次模型、推理强度、正文和执行相关头保存为不可变快照。
   若要立即切换，先停止当前轮并核对旧调用状态、已接收结果及已执行工具，再显式启动新步骤。
4. 将新模型用于下一次请求，继续回传完整历史。已执行的文件写入、命令等工具不能因切换重复执行。
5. 持久化会话当前选择；历史消息记录当时请求的模型，不因后续切换改写旧消息标签。

保持 `X-MedCode-Client-Session-Id` 不变，有助于每个模型池内部保持会话亲和性。
跨模型或跨供应商不共享隐式记忆、私有推理过程或缓存；续聊依赖客户端提交的历史。
使用同一个用户额度账户，切换不会重置额度；历史重新输入可能再次计入输入 Token。
不得自行重置 deadline、重试次数或工具执行状态来绕过原任务预算。

## 4. 回执恢复与模型切换的边界

Chat Completions 使用现有回执协议：

```text
X-MedCode-Call-Id: <13位Unix毫秒时间戳>_<UUID>
X-MedCode-Client-Session-Id: <当前会话ID>
```

新调用 ID 在实际发送前创建并持久化；同一 ID 恢复时必须保持模型、推理强度、历史、工具、
执行相关头等指纹输入一致。查询 `GET /gateway/model-calls/:id`：

- `completed/failed`：读取原响应，按结果和原错误契约处理；重复消费需由客户端去重。
- `running`：在原任务预算内继续等待，不同时发起换模型重试。
- `unknown/expired`：不能据此认为旧调用未执行；核对已有输出和工具状态，避免自动重复任务。

同 ID 改 `model` 或推理强度会返回 409 `model_call_conflict`。**换模型是新逻辑调用，必须新 ID；
恢复旧调用必须旧模型和旧参数。** 断开连接并不保证得到可恢复的失败终态。

Responses 当前不提供该持久化回执协议；附带同名头也不获得同等幂等保证。
它不支持 `previous_response_id`，必须重放完整 `input`，包括 `function_call` 和
匹配 `call_id` 的 `function_call_output`。Chat 使用原有 assistant `tool_calls` 和 tool 消息格式。
完整回执契约见[模型调用恢复 v1](../coordination/model-call-recovery-v1.zh-CN.md)。

两种 API 的流式 HTTP 200 都不等于成功：必须处理错误帧和最终完成事件，
不能把中间输出或断流当成完整终态。收到维护/限流响应时沿用现有错误契约、`Retry-After`
及总 deadline，不因切换模型无限重试。

## 5. 图片和上下文

2026-10-28 视觉修订上线后（以当日发布记录为准），`goldencode` 和 `goldencode-d`
均接受图片并路由到 xAI；纯文本仍分别进入 GLM／DeepSeek。两个云模型间切换应完整保留图片历史。
客户端应移除 D 的硬编码图片拦截。此能力来自 Gateway 视觉路由，不代表 DeepSeek 原生视觉支持。
公共档位默认 high，none→low、medium→high；图片请求的 max 映射为当前视觉模型支持的 high。
local 保持现有能力；不能静默丢图或伪装成模型已看过图片。
切换时重新校验目标模型上下文上限和输出预留；尤其切到 local 时不能沿用云端 200K 上限。

## 6. 客户端验收清单

| 场景 | 通过标准 |
| --- | --- |
| 登录、刷新列表、重启客户端 | 三项可见；默认 GLM；会话选择可恢复 |
| 两个云端模型来回切换 | 保留历史、会话 ID、low/high/max，下一轮使用所选模型 |
| 生成或执行工具时切换 | 本轮模型保持一致，下轮生效；工具不重复执行 |
| 切换后的 Chat/Responses 与流式输出 | 正确组装消息、工具参数及终态；错误帧不当成功 |
| 旧 medium/none 配置 | 分别迁为 high/low，UI 显示实际值，不声称关闭思考 |
| 旧调用恢复 | 保留旧模型和指纹；新模型使用新 ID；unknown 不自动重做 |
| 图片历史在两个云模型间切换 | 完整保留图片并成功走 xAI，包括 max 档 |
| 长历史或图片切到 local | 按 local 能力与长度限制处理，无静默丢失 |
| 受限 Key、限流或短暂维护 | 明确错误，按原契约处理，不静默换模型或无限重试 |

Gateway 公网已验证三次切换步骤均可查询/原样重放，重放不新增额度预留；
三次复用 ID 改模型均返回 409。客户端还需回传安装包版本、上述 UI 场景结果、
对应 `x-request-id`、call ID 和时间（含时区）；无需提供 Key 或完整对话内容。

上线记录见[DeepSeek 发布验收](../operations/goldencode-d-release-2026-10-23.zh-CN.md)。
