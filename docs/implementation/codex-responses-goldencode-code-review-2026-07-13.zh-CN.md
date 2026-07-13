# Codex Responses（GoldenCode）实现代码审核报告

- **日期**：2026-07-13
- **审核对象**：commit `4fe64e4` "Add Codex Responses support for GoldenCode"（`/v1/responses` 兼容层 + 统一客户端 key 认证）
- **涉及文件**：`apps/gateway/src/responses-compat.ts`、`apps/gateway/src/index.ts`、`apps/gateway/src/http/auth.ts`、`apps/gateway/src/openai-compat.ts` 及对应测试
- **审核方式**：多智能体工作流（high 级别）——4 个查错角度并行扫描出 24 个候选问题，每个问题由独立验证代理对照源码逐一核实，23 个确认、1 个驳回，去重合并后报告 10 项
- **部署状态**：该 commit 已上线（gw.instmarket.com.au），端到端实测通过（四平台、真实 Codex CLI 工具调用闭环、会话平台粘性、277 项测试）

## 总体结论

功能闭环是通的，与线上实测一致。但兼容层存在 **3 个较严重的正确性问题**，均位于短请求实测覆盖不到的路径（长回合流式、重试启发式、文本+工具调用混合回复）。建议至少修复 P0 两项后再发一版。

## 问题清单

严重程度：P0 = 线上可能直接故障；P1 = 功能/数据缺陷；P2 = 边界与可观测性；P3 = 代码质量清理。

### P0-1 流式请求全量缓冲，长回合必然超时

- **位置**：`apps/gateway/src/index.ts:1988`（根因同见 `responses-compat.ts:112` 的 `stream: false`）
- **问题**：`stream:true` 的 `/v1/responses` 请求实际以非流式调用上游，`setupSseResponse` 在 `chatCompletionsHandler` 完整返回之后才被调用。整个上游回合完成前，客户端收不到任何字节——连 SSE 响应头和心跳都没有。
- **失败场景**：GoldenCode 生成 60–120 秒的长回合时，nginx 默认 `proxy_read_timeout 60s` 或 Codex CLI 空闲超时会掐断连接。客户端报网络/超时错误，而上游调用实际成功、token 已消耗计费。`setupSseResponse` 里的心跳无济于事，因为它在上游调用完成后才启动。
- **建议**：在等待上游期间先写出 SSE 响应头并发送心跳事件；或真正透传上游流式。

### P0-2 `preserveAutoToolChoice` 未覆盖重试启发式，仍会强制 `tool_choice=required`

- **位置**：`apps/gateway/src/index.ts:2420`（同根因 `index.ts:2386`）
- **问题**：该标志只在 `initialNativeToolChoice` 一处被读取。`runNativeClientTools` 中的重试启发式（`nativeAutoToolRetryPlan` / `looksLikeSilentNativeToolNoop` / `looksLikeToolUseAcknowledgement`）不检查此标志，仍会把 Responses 兼容请求从 `auto` 升级为 `required`，或注入催促提示词重发。
- **失败场景**：Codex 回合携带 shell/apply_patch 工具、会话文本命中 `looksLikeFileGenerationTask`（如"创建一个文件"），模型给出合法的纯文本回复"我现在来创建文件。"（≤180 字符，命中 `looksLikeToolUseAcknowledgement`）。网关静默以 `tool_choice=required` 重发，强制产生多余的 function_call 顶替文本回答，上游 token 与延迟翻倍——正是这个标志本想为 Responses 路由关掉的行为。
- **建议**：让重试启发式同样尊重 `preserveAutoToolChoice`。

### P1-1 工具调用旁的助手文本被静默丢弃

- **位置**：`apps/gateway/src/responses-compat.ts:147`
- **问题**：`createResponsesResult` 在存在 `tool_calls` 时只输出 `function_call` 输出项（且 `openai-compat.ts:392` 的 `createChatCompletionResponse` 在有 toolCalls 时已把 content 置空），模型随工具调用一起给出的解释文本全部丢失。
- **失败场景**：GoldenCode（GLM）返回"测试失败是因为 X，我来修补 import"+ 一个 shell 工具调用。`/v1/responses` 响应里只有 function_call——用户在 Codex 中看不到解释；且客户端用收到的内容回放历史，该文本从后续所有轮次中永久丢失。
- **建议**：有文本时同时输出 `message` 输出项。

### P1-2 图片/文件内容部件直接 400，含图会话永久不可用

- **位置**：`apps/gateway/src/responses-compat.ts:282`（同根因 `:285`）
- **问题**：`responsesContentText` 对任何非文本部件（`input_image`、`input_file`、`refusal` 等）返回 400，整个请求失败而非跳过不支持的部件。
- **失败场景**：用户在 Codex 里贴一张截图，整个回合 400——包括用户输入的全部文字。历史轮次回放时同样失败，一旦图片进入会话历史，该会话永久不可用。
- **建议**：降级处理——丢弃或以占位文本描述不支持的部件，而非整体拒绝。

### P1-3 `previous_response_id` / `store` 被静默忽略

- **位置**：`apps/gateway/src/responses-compat.ts:109`
- **问题**：`parseResponsesRequest` 只从字面 `input` 数组构造会话，对依赖服务端状态的字段既不实现也不报错。
- **失败场景**：客户端用有状态链式调用，只发最新一条用户消息 + `previous_response_id`；网关静默丢弃引用，转发一条无上下文的会话，模型给出静默错误的回答。
- **建议**：对不支持的有状态参数显式返回 unsupported-parameter 错误。（Codex CLI 当前不用此模式，故实测未暴露。）

### P2-1 统一 key 的 revoked/expired 401 缺少凭证归因

- **位置**：`apps/gateway/src/http/auth.ts:204`（同根因 `:209-210`）
- **问题**：`authenticateUnifiedClientKey` 直接返回 `verifyUnifiedClientKeyToken` 的 `revoked_credential`/`expired_credential` 错误，未像常规凭证路径（`auth.ts:147-153`）那样设置 `request.gatewayObservedCredential`。
- **失败场景**：客户端持续用已吊销/过期的 `cgu_` key 调用，每次 401 在观察存储中记录的 credentialId/subjectId 为 null，运营侧无法把失败/滥用流量归因到主体——而同文件 222-245 行对关联 codex 凭证的同类失败是有归因的。
- **建议**：统一 key 路径同样设置 `gatewayObservedCredential`。

### P2-2 无工具请求向提示词注入误导性的空 `[]` 工具块

- **位置**：`apps/gateway/src/responses-compat.ts:113`
- **问题**：`chatBody` 恒包含 `tools`（可能为空数组），无工具的 Responses 请求走纯提示词路径时，`chatMessagesToPrompt` 的 `request.tools !== undefined` 判断会注入 "The client supplied OpenAI-style tool definitions..." 加上 JSON 文本 `[]`。
- **失败场景**：无工具请求、或只带非 function 内置工具（如 `tools:[{type:"web_search"}]`，被 `parseResponsesTools` 过滤为 `[]`）的请求，模型每次都收到自相矛盾的上下文（声称提供了工具定义却是空块），可能引用不存在的工具，且每次浪费提示词 token。
- **建议**：工具为空时省略 `tools` 键（`undefined`），完全绕开该分支。

### P3-1 WeakSet + body 换入换出的 handler 复用方式脆弱

- **位置**：`apps/gateway/src/index.ts:1964`（相关 `:1965`、`responses-compat.ts:353`）
- **问题**：`/v1/responses` 路由通过模块级 `WeakSet` 加临时改写 `request.body`/header 再 try/finally 还原的方式，把 `preserveAutoToolChoice` 偷运进共享 chat handler；handler 内部还会对已验证的 body 二次 parse、重复校验（如 `tool_choice` 引用未知函数在两处以不同文案各查一遍）。
- **风险**：任何未来复用 `chatCompletionsHandler` 的路径（或 Fastify 克隆 request 对象的变更）会静默丢失标志，重新启用强制 `tool_choice=required` 逻辑。
- **建议**：抽出 `runChatCompletion(parsedRequest, request, reply)`，直接接收已解析的请求对象，消除 WeakSet、body 换入换出和重复校验。

### P3-2 统一 key 认证路径复制粘贴了核心凭证状态检查

- **位置**：`apps/gateway/src/http/auth.ts:222`（相关 `:247`、`:129`）
- **问题**：`authenticateUnifiedClientKey` 重新实现了 `packages/core/src/credentials.ts:82-96` `verifyAccessCredentialToken` 中已有的 revoked/expired 状态检查（连错误文案都一样）；247-259 行的成功上下文构造与 171-183 行逐字符相同。
- **风险**：凭证状态语义变更（宽限期、新错误码）只改 core 不会作用于统一 key 登录，已吊销的 codex 凭证可能仍能通过 `cgu_live` key 认证。
- **建议**：在 core 抽出共享 helper（如 `checkAccessCredentialState(record, now)`），两条路径共用。

### P3-3 `ParsedResponsesRequest` 数据双重所有权

- **位置**：`apps/gateway/src/responses-compat.ts:120`
- **问题**：`model`/`tools`/`toolChoice` 既作为顶层字段返回，又嵌在 `chatBody` 里；`createResponsesResult` 回显的是顶层副本，实际上游调用用的是 `chatBody` 副本。
- **风险**：只规范化其中一份（如在 chatBody 里过滤 tools）会导致响应元数据与实际执行不一致。
- **建议**：单处派生 `chatBody`，或只暴露 `chatBody` 加少数 Responses 专属字段。

## 被驳回的候选问题（1 项）

- **`auth.ts:122` — cgu_live key 在全部凭证路由获得完整 scope**：验证者确认机制描述属实（统一 key 前缀在全局凭证钩子中被识别，授予关联凭证的完整 scope），但候选问题声称的失败场景基于错误前提，不构成缺陷。机制本身如需收窄到 `/v1/responses` 专用，属产品决策而非 bug。

## 建议的修复顺序

1. **P0-1 流式缓冲** + **P0-2 重试强制 required**——两者都会在真实长回合中造成用户可见故障且额外消耗上游 token，建议修复后立即发版。
2. **P1-1 文本丢失** + **P1-2 图片 400**——影响日常使用体验，随下一个常规版本。
3. **P1-3 / P2-x**——低成本防御性修复，可与上一批同车。
4. **P3-x**——重构清理，安排在功能稳定后。

## 审核过程数据

| 项 | 数值 |
|---|---|
| 审核级别 | high |
| 子代理总数 | 27（1 scope + 4 finder + 21 verifier + 1 synthesize） |
| 候选问题 | 24 |
| 验证确认 / 驳回 | 23 / 1 |
| 去重后报告 | 10 |
| Token 消耗 | ~98.6 万 |
