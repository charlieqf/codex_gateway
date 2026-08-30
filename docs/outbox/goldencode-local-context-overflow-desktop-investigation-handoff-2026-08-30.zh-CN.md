# GoldenCode Local 上下文溢出：Desktop 客户端调查与优化交接说明

日期：2026-08-30

面向团队：MedEvidence / GoldenCode Desktop 客户端团队

文档状态：调查交接；Gateway 开发分支已实现并完成案例回归，尚未部署；客户端修复待验证

关联用户反馈：杜衡反馈 GoldenCode Local 返回 `MedCode upstream rejected the request.`

## 1. 执行摘要

本次故障已定位为一条确定的上下文窗口溢出，不是账户、API Key、模型权限、GPU、容器健康、并发或 reasoning 档位故障。

GoldenCode Local 当前部署的总上下文窗口为 32,768 tokens。失败请求要求最多输出 8,192 tokens，而 vLLM 判断输入 prompt 至少为 24,577 tokens，因此最小总量为：

```text
24,577 input + 8,192 requested output = 32,769
32,769 > 32,768
```

即使只按上游给出的最低输入量计算，也已经超限 1 token。该请求同时注册了 57 个工具，工具名称、描述和 JSON Schema 都会进入 prompt，是本次输入膨胀的重要组成部分。

客户端当前已经有动态预算计算代码和 4,096-token 安全余量，但 MedCode 请求统一设置了 `effectiveLimitsVerified: false`，最终仍采用旧的完整输出预算；现有自动压缩又主要根据上一个已完成模型调用的 token 用量触发，无法在第一次发送当前大 payload 前阻止溢出。Gateway 随后把 vLLM 的明确上下文错误映射成通用 `invalid_request`，用户最终只看到 `MedCode upstream rejected the request.`。

建议优先在客户端增加“最终 payload 发送前准入检查”，对 GoldenCode Local 使用可信的 32K/8K 有效限制，在最终 system、messages、tools 全部确定后计算预算；空间不足时先压缩并重新构造 payload，最多做一次经过变换的重试。单独降低 `maxOutputTokens`、修改静态 context 数字或扩大服务端窗口都不能替代这项修复。

## 2. 用户事件与时间线

以下时间均为 2026-08-30，澳大利亚东部标准时间（AEST，UTC+10）。

| 时间 | 事件 | 结果 |
| --- | --- | --- |
| 10:27:15 | 同一用户、同一 Desktop turn 发起小型 Local 请求 | HTTP 200，成功 |
| 10:27:15 | 同一 turn 发起实际 Agent 请求，携带 57 个工具 | vLLM HTTP 400，上下文超限 |
| 约 10:47 | 完成 R760、Gateway、Qwen、GPU 和事件日志只读核查 | 服务健康，无重启、无 OOM |

关键请求记录：

| 字段 | 成功的小型请求 | 失败的 Agent 请求 |
| --- | --- | --- |
| Request ID | `req-5863eebf-b1a3-4854-8097-9abfa2f6ee14` | `req-f7bc0c2f-5842-49fb-9733-d01cb89d0a1e` |
| Desktop | `2.0.0-beta.55` | `2.0.0-beta.55` |
| Support code | `T:4Y7ER4MS` | `T:4Y7ER4MS` |
| 模型 | `goldencode-local` | `goldencode-local` |
| reasoning | `medium` | `medium` |
| 活跃工具数 | 0 | 57 |
| 最大输出预算 | 小型请求 | 8,192 |
| 状态 | `ok`，上游 HTTP 200 | `invalid_request`，上游 HTTP 400 |

Gateway 事件中记录的客户端侧估算 prompt 为 35,597 tokens；vLLM 按自身 tokenizer 和请求校验逻辑给出的权威错误为“输入至少 24,577，加 8,192 输出后至少 32,769，超过 32,768”。两者不是同一种计量口径，不能拿 Gateway 的粗略估算替代 provider tokenizer，但二者都指向同一个结论：请求没有安全空间。

## 3. 服务端原始结论

vLLM 返回的核心错误语义如下：

```text
模型最大上下文长度为 32768 tokens；请求预留了 8192 输出 tokens，
prompt 至少包含 24577 输入 tokens，总量至少为 32769。
请减少输入长度或请求的输出 tokens。
```

Qwen 推理日志同时记录该 `POST /v1/chat/completions` 返回 HTTP 400。Gateway 当前在 `apps/gateway/src/services/openai-compatible-provider.ts` 中把此类上游 400 映射为：

```json
{
  "code": "invalid_request",
  "message": "MedCode upstream rejected the request."
}
```

因此用户界面的通用报错不是根因，只是 Gateway 对上游 400 的当前表现形式。

## 4. 已排除的原因

本次只读核查得到以下结果：

- R760 公网 `/gateway/health` 为 `ready`，本地推理状态为 `healthy`。
- `codex_gateway_r760-gateway-1` 健康，重启数 0，未发生 OOM。
- `qwen38-fp8-local` 健康，重启数 0，未发生 OOM。
- GPU 为 NVIDIA RTX 6000 Ada；核查时使用 42,552 / 49,140 MiB，利用率 0%，温度 47°C。
- 主机内存和 `/data` 容量充足。
- 同一用户同一时刻的小型 GoldenCode Local 请求成功。
- 失败请求使用 `reasoning_effort=medium`，这是 Local 已支持的档位；不是已知的 `high` 档位不兼容问题。
- 最近 24 小时该用户两条 Local 事件一条成功、一条上下文失败，不支持“Local 整体不可用”的判断。

结论：不需要重新签发 Key、重新登录、重启 Gateway、重启模型或调整用户权限。

## 5. 客户端当前实现为何没有拦住

权威客户端源码工作树为：

```text
C:\work\code\medevidence-opencode-stable
```

本次复核时 `dev` 与 `origin/dev` 均为 `bdb64f7cbfba9f9faa1e1024debe901fc324610c`。从 `v2.0.0-beta.55` 到当前 `dev`，以下相关文件的最终内容没有变化，因此升级到 beta.57 或当前 dev 本身不会解决此问题：

```text
packages/desktop/resources/opencode-config/opencode.jsonc
packages/opencode/src/session/llm/budget.ts
packages/opencode/src/session/llm/request.ts
packages/opencode/src/session/overflow.ts
```

### 5.1 模型限制配置是 32K/8K

`packages/desktop/resources/opencode-config/opencode.jsonc` 当前配置：

```json
"goldencode-local": {
  "limit": { "context": 32768, "output": 8192 }
}
```

这表示输入和最大输出共享 32,768-token 总窗口，并不是输入可以独立使用 32K 后再额外输出 8K。

### 5.2 动态预算算出来了，但没有被采用

`packages/opencode/src/session/llm/budget.ts` 已定义：

```text
DEFAULT_SAFETY_MARGIN = 4096
available = context - estimatedPrompt - safetyMargin
calculated = min(providerOutputLimit, available, workloadPolicyLimit)
```

但其最终行为是：

```text
effectiveLimitsVerified=true  -> 使用 calculated
effectiveLimitsVerified=false -> 使用 legacy
```

`packages/opencode/src/session/llm/request.ts` 对 MedCode 固定传入：

```ts
effectiveLimitsVerified: false
```

因此诊断中虽然可以看到 `calculatedMaxOutput`，真正发送给 provider 的仍可能是完整 8,192-token 旧预算。

### 5.3 自动压缩依赖上一轮用量

`packages/opencode/src/session/prompt.ts` 在调用模型前，会根据 `lastFinished.tokens` 判断上一条已完成 Assistant 消息是否溢出。这个机制适合在成功完成一轮后决定下一轮是否压缩，但不能可靠覆盖：

- 当前用户新输入突然很长；
- 当前轮新增大量 system/MCP/skills 内容；
- 当前轮最终注册了大量工具 Schema；
- 第一次 provider 调用尚未产生真实 usage。

本次请求在第一次实际 Agent 调用前已经过大，所以没有机会依靠上一轮 usage 触发保护。

### 5.4 客户端无法从通用错误中可靠恢复

`packages/opencode/src/provider/error.ts` 已能识别 `context_length_exceeded`、`context_too_large` 和特定错误文本，并进入自动压缩路径。但本次 Gateway 返回的是通用 `invalid_request` 和通用消息。客户端不能安全地把所有 `invalid_request` 都当作上下文问题，否则会把非法参数、reasoning 档位等确定性错误错误地重试为压缩请求。

## 6. 历史复现提供的额外信息

2026-08-24 的云端/Local 对比测试已经复现过相同边界：

- `24,577 + 8,192 = 32,769`，失败；
- 把输出静态改成 4,096 后，prompt 选择扩展到至少 28,673，仍然得到 `28,673 + 4,096 = 32,769`；
- 把静态 context 改成 32,767 也没有改变最终有效预算，运行时模型信息覆盖了该测试改动。

这说明不能只做以下任一修改：

- 把 `output` 从 8,192 固定改为 4,096；
- 把静态 `context` 改成 32,767 或另一个接近值；
- 只在历史消息选择前调整预算，但发送最终 payload 前不再校验；
- 只修正“多 1 token”，不保留 tokenizer 差异和工具序列化余量。

相关历史证据见 `docs/outbox/goldencode-glm53-vs-goldencode-local-qwen-comparison-2026-08-24.zh-CN.md`。

## 7. 建议的客户端修复方案

### P0：最终 payload 发送前准入检查

准入检查必须发生在以下内容全部确定之后：

- 最终 system prompt；
- 经过消息转换的历史和当前用户消息；
- 本轮预算/时间提示；
- 最终 `activeTools`；
- 所有工具描述和 JSON Schema；
- 当前模型、reasoning 变体和输出上限。

建议只对具有可信静态限制的模型启用 verified policy，首个对象是：

```text
providerID = medcode
modelID    = goldencode-local
context    = 32768
output max = 8192
```

不要把所有 MedCode 模型统一改成 `effectiveLimitsVerified: true`，因为云端模型的有效限制可能由 Gateway 或上游动态调整。

建议算法：

```ts
const estimatedPrompt = estimateFinalProviderPayload({ system, messages, tools })
const availableOutput = contextLimit - estimatedPrompt - safetyMargin
const plannedOutput = Math.min(providerOutputLimit, workloadLimit, Math.max(0, availableOutput))

if (plannedOutput >= minimumUsefulOutput) {
  send({ maxOutputTokens: plannedOutput })
} else if (historyCanBeCompacted && compactionGeneration === 0) {
  compactHistory()
  rebuildFinalPayload()
  replanOnce()
} else {
  failLocallyWithActionableContextError()
}
```

初始参数建议：

- `safetyMargin = 4096`，相当于 32K 窗口的 12.5%；
- `minimumUsefulOutput = 2048` 作为首轮实验值；
- 长 Artifact 继续采用分块写入，而不是依赖一次超长最终输出。

`minimumUsefulOutput` 是需要测试验证的产品参数，不应被写死为未经验证的长期契约。若动态缩减输出导致大量 `finish_reason=length`，应优先压缩或分块，而不是继续下调该下限。

### P0：准入失败时先压缩，再重新构造

压缩不能只删除几条消息后沿用旧估算。正确顺序应为：

1. 判断最终 payload 不可安全发送；
2. 压缩较早的对话历史和非保护性工具输出；
3. 重新生成 model messages、system 内容和最终工具集合；
4. 重新执行 provider transform；
5. 重新估算完整 payload；
6. 重新计算输出预算；
7. 满足安全不变量后才发送。

安全不变量应是：

```text
estimated_final_provider_input
+ requested_output_tokens
+ safety_margin
<= effective_context_limit
```

如果当前单条用户输入、必要 system 内容和必要工具本身已经过大，历史压缩无法解决，应在本地停止并提示用户新建更小任务、减少附件/工具范围或切换云端 GoldenCode。

### P0：限制自动恢复次数和重放条件

上下文恢复最多允许一次经过变换的重试，并同时满足：

- 尚未收到可见文本、reasoning 或工具调用；
- 没有产生可能带副作用的工具执行；
- 第二次请求的消息、工具集合或输出预算确实发生变化；
- 同一个 `clientTurnID` 和 compaction generation 可被诊断追踪。

禁止原样重放确定性 400，也禁止在用户选择 Local 后静默切换到云端 GoldenCode。

### P1：使用更接近 provider 的 token 口径

当前 `Token.estimate(JSON.stringify(...))` 适合作为保守诊断，但客户端团队应确认它是否覆盖了 AI SDK/provider transform 后的实际 wire payload，包括：

- system 消息合并；
- tool definition 包装；
- provider-specific message transform；
- Unicode、转义和 JSON Schema；
- reasoning 或工具协议增加的字段。

优先级建议：

1. 如可行，使用 Qwen 对应 tokenizer 对最终 wire payload 计数；
2. 若不适合在 Desktop 分发 tokenizer，则使用经过实测校准的保守估算和 4K 安全余量；
3. 中长期由 Gateway 暴露有效模型限制或只读 preflight/token-count 合约，客户端仍保留本地保护。

不能把 Gateway 的粗略 `estimated_tokens` 当成与 vLLM 完全等价的 tokenizer 结果。

### P1：提前压缩阈值也纳入安全余量

`packages/opencode/src/session/overflow.ts` 当前主要保留最大输出空间。建议 GoldenCode Local 的早期阈值至少保留：

```text
requested_output + safety_margin
```

这能让普通多轮会话更早压缩，但它只是提前预警；最终 payload 准入仍然必须保留，因为当前轮 system/tools 可能突然增长。

### P1：改进错误展示

建议用户提示：

```text
GoldenCode Local 的本次上下文超过 32K。客户端已尝试压缩，但仍无法安全发送。
请新建会话、缩小任务范围，或切换到 GoldenCode。请求标识：<request_id>
```

压缩过程中可显示“正在为 GoldenCode Local 压缩上下文…”。不要先展示通用上游错误，再静默恢复。

日志和诊断可以记录：

- model/provider；
- effective context/output limit；
- 客户端估算 prompt；
- safety margin 和 planned output；
- 工具数量及序列化总字节数；
- admission action；
- compaction generation；
- Gateway request ID。

不得记录 API Key、完整 prompt、工具实参、用户文件内容或其他敏感正文。

### P2：减少工具 Schema 的固定成本

57 个工具并不等于 57 个工具都会在本轮使用。可在不破坏 Agent 能力的前提下调查：

- 是否有与当前 Agent、权限或工作区无关的工具仍被注册；
- MCP 工具能否按服务器或任务类型延迟激活；
- 是否可以先使用工具搜索/选择，再注入低频工具 Schema；
- 重复描述、冗长枚举和可派生字段是否可以精简；
- native runtime 与 AI SDK runtime 的工具集合和预算行为是否一致。

工具裁剪可能改变模型能力，不能作为 P0 热修复，也不能仅为了通过单一测试而禁用必要工具。

## 8. Gateway 配合项与当前开发状态

客户端仍必须做发送前保护。Gateway 本地开发分支已经实现两层保护，尚未部署：

1. 仅针对 `local_openai`，可通过 `MEDCODE_LOCAL_CONTEXT_ADMISSION_MODE=disabled|shadow|enforce`
   启用 vLLM `/tokenize` 精确预检；默认 `disabled`，建议先 `shadow` 观测再切换 `enforce`。
2. 无论预检模式是否启用，vLLM 明确返回上下文超限 400 时，Gateway 都会把它分类为
   `context_compaction_required`，不再退化成通用 `MedCode upstream rejected the request.`。

精确预检使用最终的 `messages + tools`，并取 Gateway registry 与 vLLM `max_model_len` 中较小者
作为有效窗口。`/tokenize` 暂时失败时 Gateway fail-open，继续调用生成接口，避免预检故障扩大为
Local 全量不可用；随后仍由上游 400 分类兜底。Gateway 不自动压缩、不缩小客户端请求的
`max_tokens`、不静默切换云端模型。

结构化错误当前为：

```json
{
  "error": {
    "code": "context_compaction_required",
    "message": "The request exceeds the effective model context window. Compact earlier context and retry once.",
    "contract_version": 1,
    "failure_kind": "model_context_overflow",
    "transformed_retry_allowed": true,
    "recommended_action": "compact_and_retry_once",
    "recovery_owner": "client",
    "context_limit": 32768,
    "prompt_tokens": 24577,
    "requested_output_tokens": 8192,
    "total_tokens": 32769,
    "overflow_tokens": 1,
    "token_count_source": "provider_tokenizer",
    "retryable": false,
    "request_id": "req-..."
  }
}
```

语义要求：

- `retryable: false` 表示相同 payload 不得重试；
- `recovery_owner: client` 表示客户端可以压缩、分块或调整输出后重试；
- 保留 request ID 便于跨团队排查；
- 不在公开响应中返回内部 provider URL、账户或敏感请求正文。

`/v1/models` 对 Local 额外返回：

```json
{
  "context_error_contract_version": 1,
  "context_overflow_recovery": "compact_and_retry_once"
}
```

`token_count_source` 在发送前精确预检时为 `provider_tokenizer`，在上游拒绝兜底分类时为
`upstream_validation`。

### 8.1 杜衡案例的 Gateway 开发验证

2026-08-30 的 Gateway 开发分支增加了显式依赖外部 fixture 的命名回归。验证过程没有把
材料正文复制进测试源码，而是先检查两份材料的固定身份：

| 文件 | UTF-8 bytes | SHA-256 |
|---|---:|---|
| `长任务.txt` | 5,978 | `a31d10e15104a608a193f9ad12e320e7e3590c422c67e06e4ab64420401d1019` |
| `教授_科研方向检索.md` | 43,479 | `b454e08debbf2aaccf68bdb6d53f744cb58bc12635d2d0319e80dd25afddd5c4` |

随后按本次事件构造 `goldencode-local + medium + 57 tools + max_tokens=8192`，并验证两层：

1. 本地 Gateway 回归：最终 `/tokenize` payload 中确实存在固定 hash 材料和 57 个工具；
   tokenizer 返回事件权威值 `24,577/32,768` 后，Gateway 返回
   `context_compaction_required`，且生成接口调用次数为 0。
2. R760 真实 Qwen tokenizer：通过临时 SSH loopback 隧道直接调用私有 vLLM `/tokenize`，
   不调用生成接口、不使用用户 Key、不修改配置。固定材料加最小合成工具定义最初得到
   `20,870` prompt tokens，证明“材料 + 工具数量”本身不能冒充原始请求；再把 Gateway
   出于隐私没有保留的 Desktop system/tool schema/history 固定开销，以确定性合成 schema
   文本补在同一 payload 位置，真实 vLLM 0.27.1 得到：

```text
prompt_tokens             = 24,577
requested_output_tokens   = 8,192
total_tokens              = 32,769
max_model_len             = 32,768
overflow_tokens           = 1
```

该 replay profile 为 `duheng_fixture_plus_synthetic_client_overhead_v1`。它保留真实 fixture、
真实工具数量、真实模型 tokenizer 和事件计量边界，但不是原始 wire payload 的逐字节副本；
原始 Desktop system/tool schema/history 按隐私设计没有被 Gateway 持久化。验证结束后 SSH
隧道已关闭，Qwen 容器仍为 `healthy`、重启数 0。

可重复命令（只能通过受控 loopback/tunnel 指向私有 vLLM）：

```powershell
node scripts/validate-duheng-local-context.mjs `
  --base-url http://127.0.0.1:<temporary-tunnel-port> `
  --fixture-dir 'C:\work\code\codex-gateway\issues\长任务测试'
```

此验证证明 Gateway 的精确计数和 413 准入可以覆盖本次已知边界；它仍不等于 Desktop
“压缩、重建、重新计数、最多重试一次”完整流程通过。客户端实现后仍需用同一两条长任务
运行 `goldencode-local` 安装包 Live E2E。

客户端可以识别明确的 `context_compaction_required`、`context_length_exceeded` 和 `context_too_large`，但不应把所有通用 `invalid_request` 猜测为上下文错误。

## 9. 建议测试矩阵

### 9.1 单元测试

- 32,768 context、8,192 provider output、24,577 prompt 的边界用例不会生成超限请求。
- 4,096 安全余量真实参与最终决策，而不只是出现在诊断元数据中。
- 57 个工具的完整 Schema 被纳入最终 payload 估算。
- Unicode、转义字符和大型 JSON Schema 不会明显低估。
- `plannedOutput < minimumUsefulOutput` 时返回压缩准入结果，而不是发送 0/负数/极小输出预算。
- `goldencode-local` 使用 verified limits；其他 MedCode 模型保持原有策略，除非其限制也被单独验证。
- 静态降低 output 导致历史选择扩展后，最终二次准入仍能发现超限。

### 9.2 集成测试

- 第一次当前 payload 已超限时，在任何 provider HTTP 调用前触发压缩。
- 压缩后重新构造并重新计数，不沿用旧预算。
- 最多一次 transformed retry；相同请求体不会被再次发送。
- 已有可见输出或工具副作用时不做自动重放。
- 明确的上下文错误进入压缩路径；通用 `invalid_request` 不被误判。
- Local 失败时不静默切换云端模型。
- AI SDK 和 native runtime 都满足同一准入不变量。

### 9.3 安装包 Live E2E

使用仓库 `docs/长任务测试` 下杜衡反馈对应的两个长任务场景作为发布门槛：

- `completes the reported long Research task`；
- `completes the reported long HTML artifact with bounded verifiable writes`。

要求：

- 使用真实安装后的公开候选 EXE，而不只验证开发浏览器或 `win-unpacked`；
- 明确选择 `goldencode-local`，云端只作为独立对照，不作为自动 fallback；
- 记录 Desktop version/commit、session ID、support code、Gateway request IDs、耗时、完成工具数和 Assistant 错误；
- HTML 场景记录最终字节数、SHA-256、UI 截图和渲染页截图；
- 检查进度是否卡住、错误是否被错误隐藏、是否重复写入、是否泄漏内部协议文本；
- 断言所有发往 Local 的请求满足最终上下文安全不变量。

## 10. 客户端团队需要进一步确认的问题

1. `Token.estimate` 与 Qwen tokenizer 在包含 57 个工具 Schema 时的误差分布是多少？
2. 当前估算是在 provider transform 前还是后；最终 wire payload 是否还会新增字段？
3. 历史复测中 output 从 8,192 改为 4,096 后，哪一层把 prompt 从至少 24,577 扩展到了至少 28,673？
4. 发送前压缩如何避免留下空 Assistant 消息、短暂错误提示或重复 compaction 事件？
5. compaction summary 本身若使用 Local，是否也可能在 32K 边界失败；是否需要更小的固定工具集？
6. `minimumUsefulOutput` 对普通工具轮、最终长回答和 Artifact 分块分别应设多少？
7. AI SDK 和 experimental native runtime 是否构造完全相同的 system/messages/tools 预算口径？
8. Gateway 返回结构化错误后，现有 retry budget 和 replay-safe 判断是否可以直接复用？

## 11. 推荐实施顺序

1. 先提交可稳定复现当前 32,769 边界的失败测试。
2. 为 `goldencode-local` 建立可信的有效限制策略，不扩大到全部 MedCode 模型。
3. 在最终 payload 后增加准入计算，并让 4K 安全余量真正影响发送参数。
4. 增加“压缩、重建、重新计数、最多重试一次”的流程。
5. 增加明确 UI 状态、诊断字段和本地不可恢复提示。
6. 与 Gateway 协作上线结构化 `context_compaction_required`。
7. 完成两条杜衡长任务的安装包 Live E2E 后再发布。
8. 工具按需激活和 64K Local 容量评估作为后续独立优化；Gateway 精确 tokenizer 先按
   `disabled → shadow → enforce` 独立灰度。

## 12. 变更与验证边界

本交接基于 2026-08-30 的真实事件、Gateway/vLLM 日志、R760 只读健康检查以及当前 Desktop 源码检查形成。

- 初始调查轮只新增本说明文档；随后 Gateway 本地开发分支已实现本节所述错误协议、精确
  tokenizer 预检、灰度开关、模型能力字段、观测日志和自动化测试。
- Gateway 代码改动尚未部署，生产仍保持原行为，需完成评审、shadow 观测和发布审批。
- 未修改 Desktop 代码、数据库或线上配置。
- 未部署或发布 Desktop。
- 未重启 Gateway、Qwen 或其他服务。
- 未执行新的模型请求或 Live E2E；文中请求 ID 来自已发生的用户事件。
- Gateway 和 Desktop 工作树中的既有未跟踪/未提交内容均未触碰。
