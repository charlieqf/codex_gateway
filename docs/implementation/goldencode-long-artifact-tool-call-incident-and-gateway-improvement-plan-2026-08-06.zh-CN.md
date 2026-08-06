# GoldenCode 长上下文文件生成失败事件：排查结论与 Gateway 改进方案

> 日期：2026-08-06
>
> 状态：已按阶段 0 首轮审核及 Desktop 团队条件批准意见修订；Gateway P0 分类/错误/审计已在本地实现并通过测试；尚未部署，主动 chunk 保持 0%
>
> 范围：R760 公网 Codex Gateway、MedEvidence Desktop、腾讯 GLM-5.2
> 原生客户端工具调用链路
>
> 时区：除非明确写 UTC，本文时间均为 Australia/Sydney
>
> 隐私：本文不记录用户姓名、手机号、credential、API key、subject/session id、
> 完整问题正文或工具返回正文，仅保留排障所需的 request id、聚合指标和脱敏后的
> 任务类型

## 1. 审核结论摘要

一名 MedEvidence beta 用户在同一会话中先执行 Research 检索，再要求 Build Agent
生成 Markdown、完整 HTML 和摘要。用户观察到：

- Research 检索结束后长时间没有可见进展；
- 暂停后继续发送提示词，仍出现长时间“思考中”；
- 完整 HTML 任务两次返回
  `server_error: Expected valid JSON object output.`；
- UI 中同时出现 `terminated` 和 `server_error`，两者含义不清；
- 用户无法判断请求仍在运行、正在自动恢复，还是已经最终失败。

排查结论如下：

1. 目标业务请求全部到达 **R760 公网 Gateway**，并单路路由到
   **腾讯 GLM-5.2**。没有经过 Azure，也不是 Doctor Research 四容器服务的任务。
2. R760 Gateway 没有排队或整体故障证据。关键长请求的 Gateway admission
   约为 `47–278 ms`，容器持续健康；主要等待发生在腾讯模型生成阶段。
3. 用户点击暂停时，客户端、Gateway 和 provider 取消链路工作正常。对应请求记录为
   `client_aborted`，`cancel_requested=1`、`cancel_observed=1`。后续提示词能够开始
   新 turn，没有发现 PubMed/MedEvidence 工具被自动重放。
4. Markdown 文件实际上生成成功。模型先在单个 `write` 工具参数中生成了
   `25,481` completion tokens，Gateway 必须等完整工具 JSON 到达并校验通过后才能
   把工具调用交给客户端，所以 UI 约 4.5 分钟没有可见产物；客户端随后在毫秒级完成
   本地文件写入。
5. 完整 HTML 失败的直接原因是：模型尝试把完整 HTML 放入一个 `write` 工具调用，
   而 Desktop 对本次普通 MedCode 请求发送的有效输出预算为 `32,000` tokens；其中
   一次明确以 `finish_reason=length` 结束，工具 JSON 被截断，另一次及其修复尝试也
   返回无效 `write` 参数，最终由 Gateway 返回 `tool_call_validation_failed`。约
   `101k` estimated Prompt tokens 放大了生成时延、重试成本和模型稳定性风险，但在
   当前 `200k` context 配置下不是已确认的 context overflow。32k 是 Desktop 遗留硬
   预算，不是 R760/GLM-5.2 已确认的模型上限；R760 registry 为 128k，但固定提升到
   128k 也不能替代动态预算和 artifact 分块事务。
6. 当前 Gateway 把“普通 JSON 格式错误”“工具 Schema 不匹配”和“输出上限导致的
   长工具参数截断”都归入同一个通用校验失败路径，并盲目做一次通用重试。这会重复
   生成大段内容，既不能可靠修复截断，也可能让用户额外等待数分钟。
7. 当前 tool-loop/context 保护只运行在 `shadow` 模式。超过 `100k` Prompt token
   只记录告警，明确不改变请求；即使达到 hard 条件也没有生产阻断动作。
8. 最新的“小范围摘要”任务在一次失败恢复后触发客户端自动上下文压缩，随后成功
   `read`、`write` 并于 10:04:21 完成。这证明“更小产物 + 后续压缩 + 客户端继续
   编排”的组合路径能够恢复，但没有单独证明只压缩上下文即可完成原始完整 HTML。
   该组合路径不应成为要求用户长期手工操作的最终方案。

因此，建议同时推进两条修复线：

- **Gateway P0**：在工具调用是否通过 JSON/Schema 校验之前识别
  `finish_reason=length`，停止通用盲重试，补齐所有 attempt/usage 观测；生产默认先
  返回专用、可操作的错误，主动分块保持 `shadow` 或关闭。
- **Gateway + Client P0/P1**：先建立版本化 capability、单一恢复责任方和客户端文件
  事务/最终完整性协议，再允许一次有边界的主动分块；同时建立
  `context_compaction_required` 协议，让客户端自动压缩或派生精简 Build 会话，并在
  UI 明确显示“整理上下文、校验输出、自动修复、分段写入”等阶段。

用户当前的“新建 Build 会话、只读取已有 Markdown、先生成短摘要、完整 HTML 分块
写入”仅是恢复工作的临时规避，不是最终产品责任边界。

### 1.1 本地实施状态（不代表生产已生效）

截至 2026-08-06，本仓库已完成 Gateway P0 的 completion assessment、UTF-8 工具参数
byte 观测、`legacy|shadow|error|chunk` 配置骨架（`chunk` 实际退化为 `error`）、专用
length 错误、validation subtype、streaming/non-streaming 错误 metadata，以及多次
provider attempt 的 duration/usage/校验结果无损聚合。默认模式为 `shadow`，未修改生产
配置，也未部署到 R760。

本地验证结果：

- `npm run typecheck`：通过；
- `npm run build`：通过；
- `npm test`：41 个 test files、655 项测试通过，外部 fixture 的 2 项测试因默认不读取
  问题材料而跳过；
- 显式设置 `MEDCODE_LONG_TASK_FIXTURE_DIR=issues/长任务测试` 后，杜衡长任务的 2 项精确
  fixture replay 均通过。

尚未实现或启用：`artifact-write-v1` 主动 chunk、accepted-capability 首事件/响应头、
artifact/recovery ID 校验与跨请求持久化计数、有效模型预算协商、Desktop artifact
transaction 和真实 R760/Desktop 长任务 E2E。这些边界关闭前，生产只能进入
`shadow/error`，不能进入主动 chunk。

## 2. 事件范围与取证方法

### 2.1 运行环境

| 项目 | 取证结论 |
| --- | --- |
| 公网入口 | R760 GoldenCode 公网入口 |
| Gateway | R760 `codex_gateway_r760-gateway-1` |
| public model | `goldencode` |
| provider / upstream model | `tencent` / `glm-5.2` |
| Desktop | MedEvidence `2.0.0-beta.25`，beta channel |
| Agent | 首次为 Research；后续提示词均为 Build |
| Doctor Research | 没有对应 run；不在本次故障链路内 |
| Azure | 没有承载目标业务请求 |

客户端事件顶层 `app_version` 显示为 `local`，但同一 Desktop instance 在 Electron
updater 诊断事件中携带了真实版本 `2.0.0-beta.25`。这是独立的遥测归因缺陷，不是
本次生成失败根因。

### 2.2 数据来源

本次排查使用以下只读证据：

- R760 `gateway.db` 中的 `request_events`；
- R760 `client-events.db` 中的 Desktop agent、provider stream、工具执行、文件系统
  和用户停止事件；
- R760 Gateway Docker 日志；
- R760 Nginx access log；
- Desktop 当前源代码中的暂停、run state、processor、todo 和会话恢复逻辑；
- Gateway 当前源代码中的 native client tools、provider stream、工具 JSON 校验、
  validation retry 和 tool-loop shadow 实现。

客户端侧定向测试：

```text
bun test --conditions=browser --preload ./happydom.ts \
  src/pages/session/composer/session-composer-state.test.ts \
  src/pages/session/session-model-helpers.test.ts

20 pass, 0 fail
```

该测试证明被覆盖的 composer/session helper 行为没有回归，但不等同于对真实腾讯长
输出的端到端复现。Desktop 源码不在本仓库，因此上述命令及 `20 pass` 不能在本仓库内
独立复核；它只能作为外部客户端仓库的补充证据，不能替代 Gateway 或跨仓端到端验收。
另一次 opencode 定向测试运行超时、没有形成有效结果，本文不把它列为通过证据。

本轮排查和本文编写均未修改生产配置、容器、数据库、用户状态或请求状态。

### 2.3 证据限制

- 未取得受影响工作站的完整本地 session DB/export，因此不能重现 UI 每一个瞬时状态；
- Gateway 的 SSE HTTP 响应头可能已经是 200，后续流内仍可以发送错误，不能把 Nginx
  `200` 单独视为业务成功；
- `prompt_tokens` 在包含 Gateway provider retry 时可能是多次上游尝试的累计 usage，
  本文用 `gateway_estimated_prompt_tokens` 描述单次上下文规模，用累计 usage 描述成本；
- 当前错误/取消出口不能始终保留所有 provider attempts。特别是第二次 collection
  直接报错时，第一次 attempt summary 会丢失；最终工具校验失败时，provider usage
  也可能为空。因此本文会分别标注“已确认发生的 attempt”和“当前 request event
  实际保留的 attempt”，不把缺失 usage 当成零消耗；
- 当前 attempt summary 只保留工具名、finish reason、聚合长度/hash 等脱敏信息，不
  保留工具参数正文，也不始终保留每次 validation failure 的具体子类。因此
  `req-8c3d...` 第二次 `read` 的原始参数不能被重放，本文只确认它仍未通过 Gateway
  校验，不推断被拒绝参数正文；
- 本文没有使用或保存模型生成的完整医学正文及工具参数内容。

## 3. 关键时间线

### 3.1 Research 与用户暂停

| 本地时间 | request id | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 08:53:43 起 | 多次 | 成功 | Research 完成 2 次 MedEvidence、15 次 PubMed，以及 read/todo 工具调用；未观察到工具 4xx/5xx、鉴权或限流错误 |
| 08:58:15 | `req-9115ff42-f044-4cdd-86f8-7c2de98edd46` | `client_aborted` | 最终综述生成等待 `300,431 ms`；09:03:16 用户停止；取消请求和 provider 观察均为 1 |
| 09:03:33 | `req-314026d1-b2a6-40ab-a80b-01573fdc9037` | `client_aborted` | Build 要求整理证据到 Markdown；等待 `238,162 ms` 后用户停止；取消链路正常 |

Research 检索工具本身已经完成。第一次“没有进展”的主要含义是：模型正在生成最终
长输出，但 native tool 参数在完整到达和通过 JSON/Schema 校验之前不会交给客户端，
因此用户看不到渐进式文件内容。

### 3.2 Markdown 实际成功

| 本地时间 | request id | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 09:08:04 | `req-03781920-da76-43da-9ed1-87eabcd5fff1` | `ok` | provider-reported Prompt `57,304` tokens；Gateway 单次估算 `62,065` tokens；completion `25,481` tokens；`271,209 ms` 后返回合法 `write` |
| 09:12:37 | 客户端工具事件 | `ok` | `.md` 文件在客户端 worktree 中成功写入，文件系统操作为毫秒级 |
| 09:12:43–09:12:51 | 后续请求 | `ok` | `todowrite` 和最终 `stop` 完成；整个 Build turn 记录为 completed |

这一步证明：

- 客户端写文件功能没有失效；
- Gateway 可以正确转发合法的大型 `write` 工具调用；
- 主要体验问题是模型生成与 Gateway 校验期间缺少可见进度，而不是本地磁盘写入慢。

### 3.3 首次完整 HTML：用户停止

在 Markdown 已成功后，用户继续在同一会话要求生成完整 HTML。客户端先成功读取
Markdown 文件及其多个分块，随后发起最终生成请求：

| 本地时间 | request id | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 09:13:47 | `req-2efdb619-3958-4339-9542-7eaf67e0299c` | `client_aborted` | Prompt 约 `100,862` estimated tokens；约 329 秒后第一次 provider attempt 已返回无效工具 JSON，Gateway 随即进入 `validation_failed_to_same`；总等待 `500,736 ms` 后，用户在第二次 provider attempt 期间停止 |

Gateway admission 为约 60 ms，说明该 8 分钟等待不是 Gateway 排队。

该请求的当前 `request_events` 只保留一条
`kind=validation_failed_to_same / error_code=client_aborted` attempt，第一次无效输出的
attempt summary 和两次 provider usage 均未保留。Gateway 日志中的
`native_tools_retry=validation_failed_to_same` 证明第一次 attempt 已经结束并触发重试。
因此，这不是“模型在第一次尝试中一直没有任何结果，随后用户停止”，而是“第一次
无效输出耗时约 329 秒，通用修复又继续运行约 172 秒后被用户停止”。这是当前
Gateway attempt 聚合缺口的真实样本。

### 3.4 两次完整 HTML：确定的 Gateway 工具校验错误

第一轮重试：

1. `req-5b06bef8-5f3c-4e29-aa24-30f5c065c6f5` 先返回
   `export_document`；
2. `req-8c3d030d-3194-4e1c-81bc-72673bfece9c` 的单次上下文约
   `101,136` estimated tokens，持续 `213,962 ms`；
3. 腾讯第一次尝试返回 `write`，但 `finish_reason=length`，工具参数 JSON 被截断；
4. Gateway 使用通用 validation retry；第二次尝试的 summary 显示 `read`，但该 completion
   没有被 Gateway 接受。按现行代码，一个已声明且参数合法的 `read` 本应通过；因此这里
   必然还存在参数 invalid JSON/Schema、附带未声明工具、tool-choice/native completion
   约束等至少一种失败条件。当前脱敏 attempt summary 没有保存 failure subtype，也不能
   重放原始参数，所以无法再把原因收窄到其中一种；
5. 最终状态为 `tool_call_validation_failed`。

这里不能把失败解释为 Gateway 判断 `read` “不满足生成 HTML 的原任务”。当前
`tool_choice=auto` 下，只要 `read` 是客户端已声明且参数满足 Schema 的工具调用，
Gateway 就会接受；它不判断该工具是否在业务语义上完成了用户任务。

第二轮重试：

1. `req-99d5fc87-cbdf-4b45-ba14-4544e239fc3c` 的单次上下文约
   `101,145` estimated tokens；
2. 请求总耗时 `614,790 ms`，约 10 分 15 秒；
3. 第一次和 validation retry 都返回 `write`；
4. 两次工具参数均未通过 JSON 校验；
5. 最终状态仍为 `tool_call_validation_failed`。

这两次请求是截图中
`server_error: Expected valid JSON object output.` 的直接来源。

### 3.5 最新摘要任务：自动压缩后成功

09:55:40，用户将任务缩小为生成摘要，但仍沿用原会话：

1. `req-cdfaf017-da24-4175-b6ab-60c32a93d844` 的上下文约
   `101,156` estimated tokens；第一次仍产生无效 `write`，Gateway 通用重试后得到
   参数合法的 `read`，该 HTTP 请求最终记为 `ok`；这里的 `ok` 只表示返回了客户端
   可执行的合法工具调用，不表示摘要产物已在该 HTTP 请求内完成；
2. 客户端在 10:01:53–10:02:04 执行约 11 秒的自动上下文压缩；
3. 压缩后的模型请求降至约 `33k–48k` Prompt tokens；
4. 客户端随后成功执行 `read` 和 `write`，本地 `write_file` 用时约 33 ms；
5. 最后一个模型请求 `req-210f2548-37a8-42d7-86fc-f9a008c827ac`
   以 `finish_reason=stop` 完成；
6. 整个最新 Build turn 于 10:04:21 记录为 `completed / ok`，总耗时约
   `520,046 ms`。

`req-8c3d...` 与 `req-cdfa...` 的第二次 attempt 都记录了工具名 `read`，但结局不同。
能够确认的是前者 completion 未通过 native validation、后者通过并交给客户端执行；
无法确认的是前者究竟命中了哪一个 validation subtype。原因不是 Gateway 对原任务作了
不同语义判断。新增观测必须把每次 attempt 的 `validation_failure_kind` 保留下来，避免
以后只能从最终状态反推。

如果用户在 10:04:21 之后仍看到该 turn 为 `server_error`，则还存在客户端 UI 最终状态
没有覆盖历史错误/中间错误的状态同步问题；服务端和客户端诊断事件的最终 turn 状态
本身是成功。

## 4. 故障分类

### 4.1 `terminated`

本次 `terminated` 对应用户主动停止或 runtime abort：

- Desktop 发送 session abort；
- 当前 runner 和 background jobs 被取消；
- in-flight tool part 被标记 interrupted；
- Gateway 请求记录 `client_aborted`；
- provider 取消已被观察；
- 后续提示词可以启动新 turn。

已完成的历史工具结果和文件仍保留，但 aborted assistant 的无有效输出部分不会被当成
新的完成答复。没有证据表明暂停后自动重放旧 PubMed/MedEvidence 调用。

### 4.2 `server_error`

本次 `server_error` 不是服务器宕机，而是 OpenAI-compatible SSE 中的 Gateway 业务错误：

```text
code = tool_call_validation_failed
message = Expected valid JSON object output.
```

其底层是腾讯 GLM-5.2 返回的 native client-defined tool call 参数无法解析为完整 JSON，
或无法满足客户端声明的 JSON Schema。完整 HTML 场景中，`req-8c3d...` 的第一次
attempt 明确伴随 `finish_reason=length`，因此该 attempt 不是可通过补一个括号安全
修复的普通语法问题，而是内容已经被截断。`req-99d5...` 的两个 attempts 均以
`finish_reason=tool_calls` 结束，只能确认其参数无效，不能把它们也标成已确认的
output-limit 截断。

### 4.3 Gateway request `ok`、工具执行成功与 turn 完成

三种状态必须分开：

1. **Gateway request `ok`**：本次 HTTP/SSE 返回了可接受的文本或客户端可执行的合法
   工具调用；
2. **客户端工具执行成功**：本地 `read/write/edit` 已执行并返回结果；
3. **turn `completed / ok`**：agent loop 已完成后续模型轮次，最终 assistant 没有
   terminal error。

因此，`req-cdfa...` 返回合法 `read` 后记为 Gateway request `ok`，并不表示摘要已经
生成；后续客户端压缩、`read`、`write` 和最终 `stop` 才共同构成 turn 成功。反过来，
Gateway 也不会因为一个合法 `read` 没有直接生成 HTML 而拒绝它。主动分块方案必须
在客户端增加 artifact 完整性状态，不能把单次 Gateway `ok` 当成最终产物完成信号。

## 5. 根因分析

### 5.1 主根因

本次故障的已确认直接链路是：

1. **完整成品通过单个工具参数传输**：模型把整个 HTML 放进一个 `write.content`
   JSON string；
2. **Desktop 请求的有效输出预算为 32k tokens**：当前 Desktop MedCode 普通请求路径
   会把 `maxOutputTokens` 限制为 `32,000`。R760 同时记录的 Gateway model registry
   上限是 `128,000`，context 是 `200,000`；三者不能混称“模型最大输出”；
3. **至少一次单体 HTML `write` 明确触达本次请求输出预算**：`req-8c3d...` 第一次
   attempt 以 `finish_reason=length` 结束，JSON string 在中间被截断；
4. **native tool 参数必须终态校验后才能交付客户端**：无法像普通文本一样一边生成
   一边逐段显示或写盘；
5. **Gateway 没有区分截断和普通格式错误**：继续使用相同通用修复提示，可能再次
   生成完整文件。

以下是已确认的放大因素，而不是本次已证明的硬 context overflow：

- 同一会话累积了大量 Research 和 Build 历史，最终 HTML 请求约为 101k estimated
  Prompt tokens，显著增加首个结果等待时间和每次重试成本；
- 当前 `101k` 输入加 `32k` 请求输出预算仍低于配置的 `200k` context。没有证据证明
  这些请求因总 context 超限而结束；
- 客户端没有提前派生精简 Build 会话，也没有已发布的分块文件事务协议；
- `req-99d5...` 在没有 `finish_reason=length` 的情况下也产生大型无效 JSON，说明除
  明确 output-limit 截断外，还存在长工具参数生成稳定性问题；
- 后续成功样本同时缩小了任务产物并发生了 compaction，不能从该样本单独归因“只要
  compaction 就能完成原始完整 HTML”。

#### 5.1.1 32k 的来源、含义与处置边界

`32,000` 不是 R760/GLM-5.2 已确认的物理输出上限，也不是从本次事故样本反推出来的
安全阈值。代码历史显示：

1. OpenCode 在 2025-09 的会话重构提交 `9bb25a9260` 中引入全局
   `OUTPUT_TOKEN_MAX = 32_000`；该提交没有记录为什么选择 32k 的基准实验或供应商约束。
2. 上游 2025-12 的 [PR #5679](https://github.com/anomalyco/opencode/pull/5679)
   明确指出新一代 GPT、Gemini、Claude 已支持超过 64k，32k 默认值“不再适合”，并增加
   `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` 覆盖能力。
3. Desktop/MedCode 在 2026-07 的提交 `290b6be3be` 又于
   `packages/opencode/src/session/llm/request.ts:61-65` 对普通、非 `small`、非
   `json_schema` 的 MedCode 请求执行 `Math.min(..., 32_000)`。这层硬限制意味着即使上游
   runtime flag 或模型注册值更高，普通 MedCode 请求仍不能超过 32k。
4. R760 本次取证值是 `model_max_output_tokens=128000`、context `200000`。前者是 Gateway
   model registry 公布值，仍需通过受控 provider smoke 验证真实可用档位；它不等于要求
   每个请求都申请 128k。

因此，准确结论是：32k 是沿用并再次固化的客户端产品预算，不是供应商上限。它对普通
对话已经很大，但对“完整 HTML/CSS/JS + JSON 转义一次性塞进 `write.content`”可能不足；
tokens 也不等于字符数或 UTF-8 bytes，不能用 32k 直接推导工具参数 hard limit。

阶段 0 应把两类问题分开决策：

- **请求输出预算**：移除 MedCode 独立硬编码，改为模型能力、当前 estimated prompt、
  context safety margin 和任务类型共同决定的动态预算；
- **长 artifact 交付协议**：即使动态预算允许更大输出，也不鼓励继续生成单体原子工具
  JSON，仍应使用可校验、可续传、最终原子提交的分块事务。

以本次约 101k prompt 为例，直接把请求预算从 32k 提到 128k 会使“输入 + 最大输出”达到
约 229k，超过注册的 200k context；所以“取消 32k 硬限制”是合理的独立客户端改进，
“所有请求固定改成 128k”则不是安全方案。

### 5.2 Gateway 放大因素

#### A. `finish_reason=length` 下的工具截断没有专门分类

`apps/gateway/src/services/provider-stream.ts:441` 中现有
`providerTruncatedWithoutOutputError()` 只在以下条件同时满足时返回截断错误：

- `finishReason === "length"`；
- `semanticOutputChars === 0`；
- `toolCallCount === 0`。

被截断的 `write` 已经有 tool call 和大量 semantic output，所以不会进入该分支，随后
仅在工具参数 JSON 解析时落入 `tool_call_validation_failed`。

还有一个必须由 P0 覆盖的邻接缺口：如果 provider 以 `finish_reason=length` 结束，但
工具参数碰巧仍是 JSON/Schema 合法的对象，当前 `validateNativeCompletion()` 看到存在
tool call 就会返回成功。对于文件工具，这可能把语法合法但语义不完整的文件交给
客户端。因此 length 分类必须发生在“是否接受工具调用”之前，而不是只发生在
validation failure 之后。

#### B. native validation retry 不读取截断语义

`apps/gateway/src/index.ts` 中：

- `runNativeClientTools()`（约第 2894 行）在第一次工具校验失败后调用
  `nativeValidationRetryPlan()`；
- `nativeValidationRetryPlan()`（约第 3198 行）只判断
  `error.code === "tool_call_validation_failed"`；
- 对 GLM-5.2，retry tool choice 会切回 `auto`；
- `nativeToolValidationRetryPrompt()`（约第 3345 行）只要求工具名和参数满足 Schema，
  没有说明上一次已因输出上限截断，也没有要求缩小本次 `write`。

因此，“输出已被截断”和“字段类型偶然错误”采用相同的重试方式。

#### C. Prompt/tool-loop guard 仅观察、不执行

`apps/gateway/src/services/tool-loop-shadow.ts:89` 当前默认值为：

| 阈值 | 默认值 |
| --- | ---: |
| warning calls | 8 |
| hard calls | 12 |
| max elapsed | 600,000 ms |
| Prompt warning | 100,000 tokens |
| Prompt hard | 120,000 tokens |

但 mode 只有 `disabled` 和 `shadow`。本次约 101k 的 HTML/摘要请求命中 warning，日志
明确记录 `request is not altered`，不会要求客户端压缩，也不会改变模型生成策略。

#### D. 错误契约过于笼统

客户端只收到 `tool_call_validation_failed` 和
`Expected valid JSON object output.`，无法区分：

- 非 JSON 普通文本；
- JSON 语法错误；
- Schema 字段错误；
- 未声明工具名；
- `finish_reason=length` 导致的截断；
- 大型文件工具参数超过安全预算。

UI 因而只能显示泛化的 `server_error`，无法自动选择“重试、压缩、分块或停止”。

#### E. 第二次失败/取消时 attempt 与 usage 聚合不完整

`runNativeClientTools()` 在第二次 `collectNativeClientTools()` 直接返回 `GatewayError`
时会立即返回该错误，没有合并第一次 provider summary。第二次完成但仍校验失败时，
可以合并 summary，却没有把两次 provider usage 附着到最终错误路径。

本事件中：

- `req-2efd...` 实际发生“第一次 invalid JSON + 第二次 client abort”，但 request event
  只保留第二次 abort attempt；
- `req-8c3d...` 和 `req-99d5...` 均有两次 provider attempts，但最终 provider token
  usage 为空；
- 当前 `UpstreamAttemptSummary` 也没有每次 attempt 的 duration 和 token usage 字段。

这不会证明配额一定少计，因为 reservation/estimate 仍可能生效；但它会让 provider
成本归因、重试审计和本文 §11 的 attempt 级验收无法完成。该缺口必须纳入 P0，而不是
等到 UI/phase P1。

### 5.3 客户端放大因素

- Research 到 Build 沿用同一 session，完整检索历史继续进入文件生成请求；
- Desktop 对普通 MedCode 请求统一限制 `32,000` output tokens，没有针对长 artifact
  的协议化分块或动态预算策略；
- 自动 compaction 在多次长请求之后才触发，且 UI 没有明显展示；
- 大型文件生成没有已发布的分块事务、顺序、幂等和最终完成规则；
- 中间修复错误和 turn 最终状态可能同时残留在 UI；
- 顶层 app version 记录为 `local`，降低版本归因效率。

### 5.4 已排除的原因

| 假设 | 结论 |
| --- | --- |
| R760 CPU/内存或容器故障 | 无证据；容器健康，请求正常进入 |
| Gateway 排队 | 无证据；关键 admission 低于约 0.3 秒 |
| Azure 与 R760 重复路由 | 已排除；目标业务请求均在 R760 |
| Doctor Research Worker 故障 | 已排除；没有 Doctor Research run |
| 腾讯账号/key 问题 | 未观察到鉴权失败；按既定要求不作为本次阻断项 |
| PubMed/MedEvidence 工具失败 | 目标检索工具执行成功，不是 HTML JSON 失败原因 |
| 暂停后任务自动恢复错误 | 取消链路正确；没有旧检索工具自动重放证据 |
| 客户端本地文件写入慢 | 已排除；实际写盘为毫秒级 |
| 当前请求发生 200k context hard overflow | 未观察到；约 101k 输入与 32k 请求输出预算低于当前 200k context 配置 |
| Gateway/腾讯模型注册上限只有 32k | 已排除这种表述；R760 `model_max_output_tokens=128000`，32k 是本次 Desktop 请求的有效输出预算；真实 provider 更高档位能力仍需单独验证 |

## 6. Gateway 改进目标

改进后的 Gateway 应满足：

1. 能区分确认截断、疑似超预算、普通解析错误、Schema 错误和未声明工具；
2. 对任何 `finish_reason=length` 的工具完成先作安全判定，即使参数 JSON/Schema 合法，
   也不得把潜在不完整文件静默当成普通成功；
3. 对明确截断的文件工具调用，不得盲目重新生成完整产物；
4. 生产默认返回稳定、可操作的专用错误；只有客户端声明版本化文件事务 capability、
   明确恢复责任方且命中受控 canary 时，才最多尝试一次有上限的分块恢复；
5. 同一 turn 的跨 HTTP 请求恢复有累计上限，不能每个请求重新获得一次恢复机会；
6. 不把不完整 HTML 通过补括号、仅写骨架或提前 `stop` 伪装成成功文件；
7. 不破坏现有小工具调用和已验证的大型但合法 Markdown `write`；
8. Prompt 接近策略危险区间时，可以向支持 capability 的客户端发出模型感知的压缩
   信号，但不得把固定 120k policy threshold 描述为 200k 模型 context hard limit；
9. 所有 attempts、usage、判断和恢复动作可在 `request_events` 中审计，不记录正文或
   工具参数内容；
10. 通过 feature flag、capability 和 credential canary 灰度，能够快速回退到
    `error` 或 `shadow` 行为。

## 7. Gateway 侧改进方案

### 7.1 P0-A：在接受工具调用之前完成分类

分类不能只挂在 validation failure 后面，因为 `finish_reason=length` 下可能出现
JSON/Schema 恰好合法、但文件正文语义不完整的工具调用。应在 native tool collection
完成后、任何工具调用交付客户端之前构造脱敏 assessment：

```ts
interface NativeToolCompletionAssessment {
  finishReason: string | null;
  toolNames: string[];
  toolCallCount: number;
  maxToolArgumentBytes: number | null;
  totalToolArgumentBytes: number | null;
  maxToolArgumentCodeUnits: number | null;
  validationKind:
    | "none"
    | "invalid_json"
    | "schema_mismatch"
    | "undeclared_tool"
    | "tool_choice_mismatch";
  outputLimitHit: boolean;
  streamIncomplete: boolean;
  argumentBudgetCandidate: boolean;
  argumentBudgetExceeded: boolean;
  truncationConfidence: "confirmed" | "suspected" | "none";
}
```

统一分类规则为：

| 条件 | 内部分类 | 默认动作 |
| --- | --- | --- |
| `finishReason=length` 且存在工具调用/参数，不论 JSON 是否合法 | `confirmed_truncated` | 不交付为普通成功；文件工具默认返回 `tool_call_output_truncated`，只有满足 §7.2 全部条件时才允许一次 recovery |
| provider 明确报告不完整流/异常终止 | `upstream_incomplete` | 返回现有 upstream incomplete error；不进入工具 repair |
| 无 length，但 invalid JSON 且达到参数预算 | `suspected_incomplete` / `argument_budget_exceeded` | 不标成确认截断，也不做同形态完整文件重试；返回带 failure kind 的终态错误或客户端压缩信号 |
| 完整终态、参数较小、JSON 语法错误 | `invalid_json` | 最多一次针对 JSON 的 repair |
| JSON 合法但 Schema 不匹配 | `schema_mismatch` | 最多一次针对 Schema 的 repair |
| 工具未声明或违反 named/required choice | 对应 validation kind | 最多一次约束 repair，失败后停止 |
| 第二次仍截断或无效 | 对应终态错误 | 不再发起第三次 provider attempt |

参数达到 hard budget 是策略性“超预算”信号，不是 provider 截断证明。只有
`finish_reason=length` 或明确的不完整上游流可以设置
`truncationConfidence=confirmed`。

在 `packages/core/src/errors.ts` 增加：

```text
tool_call_output_truncated
output_length_exceeded
context_compaction_required
```

`tool_call_output_truncated` 只用于确认截断；`tool_call_validation_failed` 继续用于非
截断校验问题，并通过 `failure_kind` 区分普通 invalid JSON 与疑似参数超预算；普通文本
以 `finish_reason=length` 结束时使用 `output_length_exceeded`。任何
`finish_reason=length` 均不得进入 generic validation retry。

### 7.2 P0-B：默认专用错误，主动分块以 artifact 事务为前置条件

P0 首次生产行为应是：确认截断后停止通用 validation retry，返回专用错误。仅声明了
`write/edit/patch` 工具名或被正则识别为“文件工具”不足以证明可以安全恢复。首版主动
分块只适用于精确协商并通过 Schema 审核的 `artifact-write-v1`；不得从名称、description
或参数相似性推断 capability，明确排除通用 `edit`、`apply_patch` 和任意覆盖式 patch。
Gateway
只有在以下条件全部满足时，才可以进行一次主动分块 recovery：

- provider summary 明确为 `finish_reason=length`；
- 客户端声明 `artifact-write-v1` capability，且实际工具 Schema 与该版本完全匹配；
- Gateway 必须在任何工具调用交付客户端之前确认 capability：优先在初始 HTTP 响应头返回
  `X-MedCode-Accepted-Capabilities`；如果目标客户端运行时无法在消费 body 前取得响应头，
  则必须把版本化 control event 作为第一个 SSE event，且仍先于所有 tool-call delta；到
  finish-step 才确认属于无效协商；
- 客户端声明本次 `recovery_owner=gateway`；如果 owner 是 `client`，Gateway 只返回
  信号，不进行第二次 provider attempt；
- 请求携带稳定 `client_turn_id`、`artifact_id` 和 `recovery_id`：`client_turn_id` 必须是
  客户端稳定的 user-message id；`artifact_id/recovery_id` 由客户端创建并持久化，Gateway
  只校验并原样回显，不自行替换；
- 当前 turn 尚未发生过截断 recovery，且 credential/session 命中受控 canary；
- Gateway 已按 `credential_id + session_id + client_turn_id + recovery_id` 持久化并校验累计
  次数；客户端携带的次数与 Gateway 记录不一致时，任一方都必须拒绝继续恢复；
- `artifact-write-v1` 可以生成非最终分块，而不会覆盖已存在的权威文件。

`artifact-write-v1` 的最低客户端语义为：

1. 每个分块带不含正文的 opaque `artifact_id`、`recovery_id`、单调递增
   `chunk.index`，以及 `chunk.final`；`chunk.total` 可在总数已知时提供；
2. 追加调用带 `expected_previous_offset` 或 `expected_previous_hash`，客户端拒绝乱序；
3. 相同 `recovery_id + chunk.index` 重放必须幂等，不能重复追加；
4. 非最终分块写入 staging/partial artifact，或在 UI/metadata 中明确标为 incomplete，
   不得成为后续导出、医学交付或权威 Build 输入；
5. 只有收到 `chunk.final=true`、分块序列连续并通过文件类型基础校验后，Desktop 才将
   artifact 原子提交为 completed；原子提交完全属于 Desktop，Gateway 只校验协议字段与
   turn/recovery 状态；
6. 模型在首块后直接 `stop`、客户端取消、工具失败或 turn 达到上限时，artifact 保持
   incomplete，不能把 turn 标成成功交付。

Gateway 的一次 recovery prompt 必须明确：

```text
The previous file tool call was truncated at the request output limit.
Do not regenerate the complete artifact in one tool call.
Return exactly one bounded, non-final artifact chunk using the negotiated
artifact-write-v1 schema and the supplied recovery id.
Keep the serialized tool arguments below the configured byte budget.
Do not claim that the artifact is complete.
```

该 prompt 只能生成一个普通、Schema 合法且有界的工具调用，不能修补原始截断 JSON，
也不能由 Gateway 伪造多段工具调用。客户端执行后，现有 agent loop 可以进入下一次
HTTP 请求，但后续请求必须携带同一个 recovery id 和 turn 累计恢复计数。

“每个 HTTP 请求最多一次”不足以阻止慢速循环。Gateway/客户端必须共同保证：同一
turn 最多一次 output-truncation recovery；如果下一请求再次尝试整文件或再次截断，
直接返回终态错误或触发一次客户端 compaction，不重新获得 recovery 配额。Gateway
与客户端不得同时把同一个失败各自自动重试一次。

在上述 capability 和客户端 E2E 发布前，`chunk` 模式不得进入生产 canary；可先完成
代码但只能运行 `shadow`，生产行为使用 `error`。当前已发布 Desktop 基线没有满足该
协议；仅增加 `append` 参数和可选 `chunk` metadata 的草稿也不构成完整性保证。

### 7.3 P0-C：大型文件工具参数预算与 feature flags

以 UTF-8 serialized argument bytes 作为执行预算单位；JavaScript string `.length` 是
UTF-16 code units，只能作为辅助诊断，不能与 KiB 混用。建议配置为：

```text
MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE=legacy|shadow|error|chunk
MEDCODE_NATIVE_FILE_TOOL_SOFT_ARGUMENT_BYTES=<reviewed value>
MEDCODE_NATIVE_FILE_TOOL_HARD_ARGUMENT_BYTES=<reviewed value>
MEDCODE_NATIVE_FILE_TOOL_RECOVERY_CANARY_PERCENT=0
```

建议语义：

- `legacy`：完全保留当前行为，只作为兼容性紧急回滚选项；
- `shadow`：记录若启用时的分类、拒绝或 recovery 决策，不改变响应；
- `error`：确认截断时停止 provider retry，直接返回专用错误；这是 shadow 验证后的
  首个生产目标行为；
- `chunk`：只有 §7.2 capability、recovery owner、turn 上限和 canary 同时满足时才允许
  一次 recovery；否则自动退化为 `error`，不能退化为按工具名猜测分块。

credential allowlist 或基于 credential id 的确定性 canary selector 还需作为单独配置
实现；仅有全局 mode 和 percentage 不能完成指定测试 credential/session 的受控灰度。

预算阈值不应从“32k tokens”等比换算。32k 是本次 Desktop 请求预算，工具 JSON 还
包含转义、路径和 Schema 字段，bytes、code units 与 tokens 不一一对应。首轮可把
64 KiB 作为仅观测的 soft candidate，但在脱敏 replay 和成功 Markdown 样本校准前不
设置生产 hard 值。达到 soft candidate 只设置 `argumentBudgetCandidate=true` 并记录
bytes，不改变响应或 retry；达到 hard budget 才设置 `argumentBudgetExceeded=true`。如果没有
length/不完整流证据，不得外部标成 `tool_call_output_truncated`。

后续可以在 `NativeToolCallAccumulator` 中按增量 UTF-8 bytes 主动终止明显超预算的
provider stream，但这属于 Gateway 主动取消，必须先解决 usage 结算、partial attempt
持久化和 provider cancellation 语义，放入 P1。

### 7.4 P0-D：稳定、可协商的错误契约

错误响应至少包含稳定 code、契约版本、内部脱敏分类和可本地化推荐动作：

```json
{
  "error": {
    "contract_version": 1,
    "code": "tool_call_output_truncated",
    "type": "server_error",
    "message": "The generated file exceeded the safe size of one tool call and was not delivered.",
    "failure_kind": "confirmed_output_limit",
    "retryable": false,
    "transformed_retry_allowed": true,
    "recommended_action": "compact_and_generate_in_chunks",
    "recovery_owner": "client",
    "request_id": "req-..."
  }
}
```

建议固定外部语义：

| code | non-stream HTTP / OpenAI type | 原样重试 | 变换后重试 |
| --- | --- | --- | --- |
| `tool_call_output_truncated` | `502 / server_error` | 否 | 支持 capability 时可压缩或按事务分块 |
| `output_length_exceeded` | `502 / server_error` | 否 | 可继续生成、缩小范围或在有效模型预算内调整输出预算 |
| `context_compaction_required` | `413 / invalid_request_error` | 否 | 客户端完成一次 compaction/fork 后可重试 |
| `tool_call_validation_failed` | `502 / server_error` | 仅由 Gateway 内部针对性 repair 一次；客户端不得再原样重试 | 根据 `failure_kind` 决定 |

这里的 `retryable=false` 表示同一 payload 不得自动重放；不与
`transformed_retry_allowed=true` 冲突。实现不能只在 `packages/core/src/errors.ts` 增加
枚举，还必须扩展 `GatewayError`/response context、OpenAI payload、SSE error writer 和
相应类型测试，使 `recommended_action` 等字段有真实承载路径。

其他要求：

- 不返回工具正文、参数片段、路径、provider 原始响应或用户身份；
- streaming 和 non-streaming 使用相同业务 code 和 metadata；如果尚未发送 headers，按表中
  HTTP status 返回普通 JSON error；
- streaming 已发送 headers 时 HTTP 保持 200，必须发送携带相同 `code`、`contract_version`、
  `failure_kind`、`retryable`、`recommended_action` 和 `request_id` 的规范 SSE error/control
  终态，随后结束流；不得再发送成功 finish-step 或把 `finish_reason=length` 当成成功；
- 旧客户端即使不认识新增字段，仍能显示安全 message；
- 只有客户端实际开始自动恢复后，UI 才显示“正在改用分段写入”。收到错误但尚未开始
  恢复时应显示“内容超过单次文件生成上限，未写入不完整文件”。

自动恢复最终失败时建议显示：

```text
文件内容过长，未能完成分段写入。已保留现有检索结果；未完成文件不会作为最终产物。
可以先整理对话再继续，不需要重新检索。
```

### 7.5 P1-A：双向 capability 与模型感知的 context/tool-loop guard

Gateway 不能安全地自行删除 Desktop 的 system、assistant、tool history，也不知道哪些
本地 artifact 已成为权威输入。客户端通过请求头声明能力，Gateway 必须回显实际接受
的能力：

```text
X-MedCode-Client-Capabilities: context-compaction-v1,artifact-write-v1
X-MedCode-Recovery-Owner: client

X-MedCode-Accepted-Capabilities: context-compaction-v1,artifact-write-v1
```

协议要求：

- capability token 精确版本匹配；未知 token 忽略并且不回显；
- 客户端声明不等于服务端接受，active behavior 只按 accepted capabilities 决定；
- accepted capability 必须在首个 tool call 之前对客户端可见；HTTP header 是首选，只有经
  Desktop parser E2E 证明无法及时读取 header 时才使用首个版本化 SSE control event；
- `recovery_owner` 每个 turn 只能是 `client` 或 `gateway` 之一；缺省为 `client`/仅返回
  错误，不允许双方同时自动恢复；
- compaction 后携带稳定 generation/id；同一 generation 不得重复压缩；
- `client_turn_id` 使用客户端稳定 user-message id；`artifact_id/recovery_id` 由客户端创建、
  持久化并在重试时原样携带；Gateway 校验格式与连续性后原样回显；
- chunk recovery 携带 recovery id 和 turn 累计次数，跨 HTTP 请求保持一致；Gateway 以
  `credential/session/turn/recovery` 为键持久化权威累计次数，任一方发现计数不一致即拒绝；
- capability 与受控 credential canary 同时满足后才能启用 hard/action 行为；不能
  依赖当前有缺陷的顶层 `app_version=local`。

Gateway 还必须提供并确认当前请求的有效模型预算，Desktop 的估算只能用于提前规划，不能
替代 Gateway 最终校验。建议在模型发现接口中发布，并在请求初始响应头或首个 control
event 中确认以下值：

```text
effective_context_tokens
effective_max_output_tokens
gateway_estimated_prompt_tokens
tokenizer_id_or_version
```

Gateway 使用与实际 upstream model 对应的 tokenizer/经校准估算器完成最终 admission，拒绝
`estimated_prompt + requested_output + safety_margin` 超出有效 context 的请求。Desktop
不得把遗留 32k 直接改为全局 128k；它应依据已发现的模型能力提出请求预算，最终有效值和
是否可执行由 Gateway 确认。

context guard 需要区分模型硬预算与产品策略阈值：

```text
estimated_prompt_tokens + requested_output_tokens + safety_margin
  >= effective_model_context_tokens
```

上式用于真正的 context-risk 判定。现有 100k/120k 可以继续作为长 turn 的 warning/
policy threshold，但必须记录为 policy reason，不能称为 200k 模型 context hard limit。

分阶段行为：

| 条件 | 无 accepted capability 的旧客户端 | 支持 capability 的新客户端 |
| --- | --- | --- |
| 达 policy warning，普通问答 | 继续 + shadow | advisory，客户端可提前压缩 |
| 达 policy warning，文件/HTML 任务 | 只注入有界输出提示并记录，不主动分块 | 客户端压缩或派生精简 Build 会话 |
| 命中模型感知 hard context risk | 保持兼容错误路径，记录原因 | 返回 `context_compaction_required`，不消费 provider attempt |
| 已压缩后的重试 | 正常处理 | 校验 compaction generation/id，防止循环 |
| 确认工具输出截断 | 返回兼容 message/专用 code | 按 recovery owner 返回信号或执行一次 gated recovery |

### 7.6 P1-B：Gateway 长响应心跳和阶段可观测性

Gateway 可以做：

- 在经真实 parser 验证后发送 SSE comment keepalive；
- 记录 provider 首个 semantic event、当前 attempt、validation/recovery phase；
- 在诊断事件中记录“第一次输出被截断、正在执行一次受控恢复”；
- 为支持 capability 的客户端提供稳定阶段枚举。

在 provider 完成前发送第一个 keepalive 会提前提交 HTTP 200 headers，后续错误只能在
SSE 内表达。上线前必须验证 Desktop 当前 parser、OpenAI SDK、R760 Nginx buffering、
断线取消和旧客户端行为。SSE comment 可能只保持连接，不会变成应用事件；阶段枚举应
使用已协商的扩展事件或独立诊断通道，不能未经验证向标准 chunk 流插入未知 data。

客户端可以把阶段映射为：

- 正在等待模型；
- 正在校验文件内容；
- 输出过长，正在准备分段恢复；
- 正在整理较长对话；
- 正在写入第 N 个分块；
- 正在验证并提交最终文件；
- 已完成或需要用户操作。

不建议在标准 assistant content 中伪造进度文本，因为这会污染模型会话历史和最终医学
正文。

### 7.7 P0-E / P1-C：无损 attempt 观测与阶段诊断

P0 必须先补齐每次 provider attempt 的持久化；P1 再增加 UI phase。建议在
`request_events` 的 attempt diagnostics 中增加：

```text
attempt_index
attempt_kind
attempt_duration_ms
attempt_prompt_tokens
attempt_completion_tokens
attempt_total_tokens
upstream_max_tool_argument_bytes
upstream_total_tool_argument_bytes
upstream_max_tool_argument_code_units
tool_validation_failure_kind
output_limit_hit
stream_incomplete
argument_budget_exceeded
truncation_confidence
gateway_recovery_id
gateway_recovery_owner
gateway_recovery_action
gateway_recovery_result
turn_recovery_count
```

实现要求：

- 每次 attempt 一结束就形成不可变的脱敏记录，再决定是否发起下一次；
- 所有 success、validation error、provider error 和 client abort 出口都合并此前 attempts；
- 顶层 usage 是已知 attempt usage 之和；provider 未返回 usage 时记为 `null/unknown`，
  不得记成零；
- duration、usage、长度、枚举、工具名和 hash 可以记录，正文、参数、路径、API key、
  subject/credential 身份不得进入诊断字段；
- 新字段必须为 additive/nullable，并验证旧 release 可以忽略后重新打开数据库。

这些字段必须能够回答：

- 有多少 `tool_call_validation_failed` 是确认截断、疑似超预算或普通 JSON/Schema 错误；
- `req-8c3d...` 式无效 `read` 与 `req-cdfa...` 式合法 `read` 的具体差异；
- 初始、repair、recovery attempts 各自的 duration、token 和取消结果；
- 同一 turn 是否跨 HTTP 请求重复获得 recovery；
- recovery 是否缩短盲重试，以及是否产生未完成 artifact。

## 8. Gateway 不能单独安全完成的部分

Gateway 看得到 provider stream 和工具声明，但看不到本地文件事务，也不能仅凭一个合法
tool call 判断用户要求的医学 artifact 已完整交付。责任必须按以下边界拆分：

| 责任方 | 必须负责 | 不得据此宣告的状态 |
| --- | --- | --- |
| Gateway | 截断/不完整流分类、attempt 上限、错误与 capability 协商、恢复 owner、按 credential/session/turn/recovery 持久化累计次数、脱敏审计 | 单个 tool call 合法、HTTP `ok` 或模型 `stop` 均不等于 artifact 完整 |
| Desktop/agent runtime | 创建并持久化 turn/artifact/recovery ID、携带并核对累计次数、语义 compaction/fork、本地 staging、顺序/幂等/hash、最终校验与原子 commit | 首块或骨架写入不等于成功；只有 Desktop 能提交本地产物 |
| 模型 | 按协商协议生成有界 chunk，并在最后一块明确声明 final | 模型自称“完成”不能替代客户端校验与 commit |
| UI | 展示阶段、partial/incomplete 状态，并以 turn terminal state 对账 | 中间 attempt error 或 Gateway HTTP `ok` 不能单独决定最终红/绿状态 |

客户端至少需要实现以下 artifact 状态机：

```text
pending -> staging/chunking -> ready-to-commit -> complete
                 |                    |
                 +-> cancelled/error -+-> incomplete/rollback
```

只有同时满足以下条件，artifact 才能从 `ready-to-commit` 进入 `complete`：

1. 收到同一 `artifact_id` 的单调 chunk 序列以及显式 `final=true`；
2. offset、前序 hash、最终 hash/长度和客户端允许的目标路径校验通过；
3. 最终内容通过文件类型所需的结构校验；
4. staging 文件原子提交成功；
5. turn terminal state 为 completed，且没有未决 recovery。

“先写骨架/第一段，下一轮模型直接停止或宣告完成”必须落到 `incomplete`，不能把 partial
文件静默暴露为最终结果。取消、断线、超时或第二次失败同样不得 commit。

此外，以下工作只能由客户端完成：

- 基于完整 session、system prompt、tool result、todo 和本地 artifact 状态执行语义安全的
  compaction；Gateway 不得静默删除早期 messages；
- 以成功 Markdown 的 immutable artifact id/hash 派生精简 Build 会话，同时保留来源链接；
- 以稳定 user-message id 作为 `client_turn_id`，创建并持久化 `artifact_id/recovery_id`，
  跨 HTTP 请求原样携带这些 ID 和累计恢复次数；与 Gateway 权威计数不一致时拒绝继续，
  避免每个请求重新获得一次恢复机会；
- 在 UI 中区分 provider 等待、校验、分块写入、最终提交、用户取消和最终失败。

当前已发布 Desktop 没有本文要求的版本化 artifact 事务和完成性协议。因此 Gateway 可先
上线分类、专用错误和 shadow 观测，但 **P0 单独上线时不得启用主动 `chunk`**。客户端仓库
报告的 `20 pass` 只覆盖 helper，既不能在本仓库复核，也不构成上述跨仓 E2E 证据。

客户端协作建议不需要等 Gateway P0 全部完成后才提出。本文进入阶段 0 复审时就应发送
联合协议提案，让客户端确认真实工具语义并并行评估实现；同时明确其中的 error code、
header 和 Schema 在双方审核关闭前仍是 draft。Gateway 可独立推进分类、错误和审计，
客户端可并行推进 artifact transaction、UI 和动态预算；主动 `chunk` 是最后解锁的联合
能力，而不是任一方先单独上线的前置步骤。

## 9. 不建议采用的方案

### 9.1 只提高 32k output token 上限

32k 是遗留客户端预算，不是模型上限；单独审计并移除 MedCode 的硬编码是合理改进，
但不能把“所有请求固定改成 64k/128k”当作本事故主修复：

- 本次约 101k prompt 若固定预留 128k 输出，会超过注册的 200k context；
- 更大的单次工具 JSON 仍可能截断、格式错误或在终态校验前长时间不可见；
- `req-99d5...` 证明非 `length` 的大型无效参数也会出现；
- 用户等待、token 成本以及取消后的沉没成本都会增加；
- 它不解决 artifact 原子性、最终完整性、跨请求循环和盲重试。

正确的独立改进是验证 provider 档位后使用模型感知预算，例如：

```text
effective_output_budget = min(
  verified_provider_output_limit,
  model_context - estimated_prompt - safety_margin,
  task_product_cap
)
```

即使该值大于 32k，长 artifact 仍应优先走事务化分块，不应继续依赖单体工具 JSON。

### 9.2 对截断 JSON 自动补括号后当作成功

禁止。语法可修复不代表内容完整，可能生成缺少结尾、引用、样式或医学结论的文件，
且客户端会把不完整产物当成权威结果继续处理。

### 9.3 Gateway 静默删除早期 messages

禁止。可能删除当前文件所依赖的工具结果、用户约束、citation 上下文或 agent 状态。
必须由了解会话语义的客户端执行 compaction/fork，并通过 capability 明确协商。

### 9.4 在 Azure 和 R760 之间重试同一 session

禁止。会引入状态分叉、重复计费和难以对账的 provider/session 行为，也违反当前迁移
契约。本文所有改进均以 R760 权威公网入口为目标。

### 9.5 无限增加 validation retry 次数

禁止。当前一次通用 retry 已经造成额外数分钟等待。任何恢复都必须有单请求 attempt
上限；**仅在 §7.2 全部 gate 均满足的 `chunk` 模式**才允许最多两次 provider attempts，
第二次必须是有边界的专门恢复。`error`/client-owner 路径不做第二次 provider attempt。
同一 turn 还必须有跨 HTTP 累计上限，不能把计数器只放在单请求内。

### 9.6 流式透传工具参数、客户端边收边写

禁止作为现有 native tool 协议的替代方案。工具参数流在终态前尚未通过 JSON、Schema、
路径、权限和业务约束校验；直接落盘会让截断、取消或恶意/错误参数形成可见半成品，也会
绕过当前“校验后才执行工具”的安全边界。若未来需要真正的输入流，必须设计为独立的
版本化上传/文件事务协议：只写 staging、逐块校验、支持取消清理，最终校验后原子 commit，
不能把当前 provider 的 `tool-input-delta` 直接映射为文件写入。

### 9.7 Gateway 与客户端同时自动恢复

禁止。双方同时把同一失败各自重试一次，会产生重复 provider 调用、重复 chunk、状态
分叉和无法可靠执行的次数上限。每个 turn 必须协商唯一 `recovery_owner`；未协商时默认
由客户端接收专用错误，Gateway 不主动恢复。

## 10. 测试方案

测试必须把 Gateway 请求成功、客户端工具执行成功和最终 artifact 完成分开断言。外部
Desktop 仓库报告的 `20 pass` 不能替代以下任何一项。

### 10.1 分类与错误契约单元测试

至少覆盖以下矩阵：

1. `finish_reason=length` + 截断的 `write` JSON：在 validation retry 前分类为
   `confirmed_truncated`，返回 `tool_call_output_truncated`，不进入 generic repair。
2. `finish_reason=length` + JSON/Schema 恰好合法的 `write`：仍不得作为普通成功交付；
   证明分类发生在 `validateNativeCompletion()` 接受之前。
3. provider 明确流异常/不完整但没有 `length`：分类为 `upstream_incomplete`，不得回落到
   generic invalid-JSON repair。
4. `finish_reason=stop` + 大型 invalid JSON + 达到 hard argument budget：分类为
   `suspected_incomplete/argument_budget_exceeded`，不得谎报确认截断，也不得同形态重生成
   完整文件。
5. 完整终态的小型 invalid JSON：最多一次通用 JSON repair；Schema mismatch、未声明工具
   和 tool-choice mismatch 分别保留准确的 `failure_kind`。
6. 合法 `read` 参数通过 required/schema 校验；无效 `read` 参数记录具体 validation subtype。
   这用于解释 `req-8c3d...` 与 `req-cdfa...` 的结局差异，并防止未来再只记录工具名。
7. 非文件工具的 `length` 不误入 artifact recovery；确认不完整仍不得静默成功。
8. 普通文本 `finish_reason=length` 返回 `output_length_exceeded`，不误报工具或 context
   错误，也不把部分正文静默当作完整成功。
9. 已成功的大型 Markdown `write` 继续通过，证明仅观测的 byte threshold 不误杀。
10. streaming 与 non-streaming 的 HTTP status、error code、`failure_kind`、`retryable` 和
   metadata 一致；SSE 已提交 200 后通过规范 error event 终止并有明确终态。

### 10.2 Retry、跨请求上限与 attempt 审计测试

- 初始 invalid JSON 后，第二次 collection 直接返回 `GatewayError`（包括 client abort 或
  upstream error）：两次 attempt 都落库，第一轮 summary 不丢失；
- 两次均完成但最终 validation 失败：每次 duration 和 provider usage 均保留；provider
  未返回 usage 时写 `null/unknown`，不得伪造为 0；
- 第二次仍截断或无效：不发起第三次 provider attempt；
- 同一 `credential/session/client_turn_id/recovery_id` 的下一 HTTP 请求再次截断：拒绝第二次 recovery，
  记录 `turn_recovery_count=1`、终态错误和循环告警；
- 新 HTTP 请求试图更换 recovery id 规避上限：按同一 turn 拒绝；
- `recovery_owner=client` 时 Gateway 不做第二次调用，`gateway` 时客户端不再自动重试；
- client abort、provider abort、Gateway 主动取消分别可区分，取消只记一次；
- request event 的 attempts、usage、duration 与最终计费/预留记录可对账。

### 10.3 Desktop artifact 事务 E2E

此组必须在 Desktop 仓库和打包应用中执行，并把结果附回本文；只测 helper 不算通过：

1. 首块只写 HTML 骨架，下一轮模型直接 `stop` 或声称完成：artifact 保持
   `incomplete`，UI 不显示为最终成功，不能用于导出/医学交付。
2. 多个有序 chunk + `final=true` + 最终 hash/结构校验通过：staging 文件只在最后一步
   原子 commit，turn 才进入 completed。
3. 重复 `recovery_id + chunk.index`：幂等，不重复追加；乱序、offset/hash 不一致、目标
   路径变化均拒绝并保持原权威文件不变。
4. 中途取消、断线、超时、工具失败或应用重启：partial 可恢复或清理，但不得冒充 final。
5. 同一 turn 再次尝试整文件 `write`：触发上限/压缩或终态错误，不形成每轮一次的慢循环。
6. 只有精确 `artifact-write-v1` Schema 可进入该 E2E；只有 `write/edit/patch` 名称、通用
   `edit` 或 `apply_patch` 必须被拒绝，不能推断 capability。
7. capability 未声明、Gateway 未在首个 tool call 前通过初始 header 或首个 control event
   回显接受、contract version 不匹配或双方 recovery owner 不一致：不得进入主动 chunk。
8. 客户端创建并持久化 `client_turn_id/artifact_id/recovery_id`；Gateway 必须原样回显；任一
   ID 被替换或客户端/Gateway 累计次数不一致时，双方都拒绝继续恢复。
9. 最终完成必须同时依赖连续分块、`final=true`、Desktop 校验/原子 commit 和 turn terminal state；
   仅 Gateway request `ok`、合法 tool call 或模型自然停止均不充分。

### 10.4 Tool-loop/context guard 测试

- 当前 `100k/120k` 只作为 policy shadow threshold，不写成模型 hard context；
- 模型感知公式使用 effective context、estimated prompt、请求输出和 safety margin；
- 模型发现与请求确认返回一致的 `effective_context_tokens`、
  `effective_max_output_tokens` 和 tokenizer version；Desktop 估算偏小时仍由 Gateway 最终
  tokenizer/admission 拒绝超预算请求，且不会把所有模型固定提升为 128k；
- capability 客户端命中 hard policy 时返回 `context_compaction_required`，旧客户端在迁移期
  只 shadow；
- compaction retry 携带稳定 generation/id，同一 generation 不重复压缩；
- 已完成工具轮次后不把 `auto` 再升级为 `required`；
- 文件意图只检查当前有效 user message，不扫描历史 system/tool 正文。

### 10.5 脱敏集成 replay 与杜衡长任务 fixture

构造不包含真实医学正文的固定 fixture：

- 约 55k 字符、已知成功的 Markdown；
- 超过单次安全预算的 HTML；
- 带 Research-like tool history 的约 100k prompt；
- compaction 后只携带 immutable artifact 摘要/hash 的 35k–50k prompt；
- `req-8c3d...` 形态的无效 `read` 与 `req-cdfa...` 形态的合法 `read`。

可编程 fake Tencent SSE 分别产生 `length`、非 `length` 异常终止、JSON string 中间截断、
合法但潜在不完整的参数、第二轮再次失败和 recovery 中取消。fixture 只保存结构、长度、
hash 与合成正文，不复制真实医学内容。

另将杜衡反馈的“无法跑完”长任务作为独立回归案例，材料位于仓库本地问题目录
`issues/长任务测试/`。为避免测试代码复制个人或单位信息，测试只固定以下文件身份：

| 文件 | UTF-8 bytes | SHA-256 |
|---|---:|---|
| `长任务.txt` | 5,978 | `a31d10e15104a608a193f9ad12e320e7e3590c422c67e06e4ab64420401d1019` |
| `教授_科研方向检索.md` | 43,479 | `b454e08debbf2aaccf68bdb6d53f744cb58bc12635d2d0319e80dd25afddd5c4` |

该案例分两层测试，结果不得混用：

1. 本地确定性 Gateway replay：通过 `MEDCODE_LONG_TASK_FIXTURE_DIR` 显式加载材料，验证约
   49 KiB 原始输入可完整送达 provider；正常 `stop` 不因输入较长被误杀；模拟输出达到
   limit 时只进行一次 provider attempt，返回 `output_length_exceeded`，不得把部分综述
   作为成功响应。测试不得调用外部检索服务，也不得输出或持久化 fixture 正文。
2. Desktop + R760 真实 agent-loop E2E：验证检索、工具调用、上下文增长、阶段性产物和最终
   交付确实跑到 terminal completed。只有此层通过，才能把杜衡的“无法跑完”问题记为已
   解决；本地单 HTTP replay 通过不代表长任务已经完成。

本地精确回放命令（PowerShell）：

```powershell
$env:MEDCODE_LONG_TASK_FIXTURE_DIR = 'C:\work\code\codex-gateway\issues\长任务测试'
npx vitest run apps/gateway/src/long-task-regression.test.ts
```

截至 2026-08-06，本地两项精确 fixture 测试均已通过；真实 R760/Desktop E2E 尚未执行。

### 10.6 R760 受控 smoke

代码审核和本地测试通过后，使用临时测试用户和合成 artifact 分阶段执行：

1. `/v1/models` 仍只暴露 `goldencode`，并记录 registry 128k 与实际请求 effective budget；
2. non-streaming/streaming 普通问答、小型 native tool call 和大型 Markdown 均无回归；
3. `shadow` 模式只记录分类，不改变响应；
4. `error` 模式对确认截断快速返回专用错误，不进行通用完整文件 repair；
5. 只有 Desktop artifact E2E、双向 capability 和 credential canary 全部满足后，才 smoke
   一次主动 `chunk`；否则该项必须明确记为“未启用”，不能用 Gateway 单测替代；
6. `request_events` 可对账所有 attempts、usage、finish reason、UTF-8 参数 bytes、
   validation subtype、recovery owner/id/count 和终态；
7. 临时用户/key 按 runbook 清理，Gateway 仍只监听 loopback，由现有 Nginx/SNI 对外服务。

合成 smoke 通过后，再以明确授权的测试 credential 执行一次上述杜衡长任务。该 E2E 必须：

- 使用固定 hash 的两份输入，记录 `client_turn_id`、session、请求链和总 wall time，但诊断
  日志不得保存原始个人/单位信息；
- 覆盖完整 Desktop agent loop，而不是只调用一次 Gateway endpoint；
- 最终产物包含任务要求的 15 个输出部分、可追溯引用和明确的检索/筛选信息，并通过人工
  医学与方法学抽查；不得出现输入材料中的个人姓名或单位信息；
- 成功时必须有 Desktop terminal completed 与最终产物校验信号；达到长度、超时、取消或
  上下文边界时必须有明确终态和业务错误，不得无限运行、静默停在中间步骤或展示半成品；
- 对账每次 provider attempt、工具轮次、usage、finish reason 和恢复计数，确认没有跨请求
  重复恢复循环。

真实用户医学会话不得作为反复压测输入。

## 11. 验收标准

### 11.1 分类、错误与兼容性

- 所有 `finish_reason=length` 的工具结果都在 validation/交付前判定；即使 JSON/Schema
  合法，也不得静默作为完整文件成功；
- provider 明确不完整流、确认 output-limit 截断、疑似参数超预算、普通 invalid JSON、
  Schema、undeclared tool 和 tool-choice mismatch 可稳定区分；
- 确认截断不再返回通用 `Expected valid JSON object output`，也不进入同形态完整文件 repair；
- streaming/non-streaming 使用相同契约语义；旧客户端忽略新增字段时不会崩溃；
- 普通对话、小工具和已知成功的大型 Markdown 无回归。

### 11.2 Artifact 完整性与循环上限

- capability/contract/E2E 任一未满足时，生产不启用 Gateway 主动 `chunk`；默认走专用错误；
- 首块、骨架、模型 `stop`、合法但非 final 的工具调用、HTTP `ok` 和 turn 中间成功均不能
  使 artifact 进入 completed；
- 只有连续分块、最终标记、offset/hash/结构校验、原子 commit 和 turn terminal completed
  全部满足，UI 才呈现最终成功；
- 取消、断线、超时、第二次失败和应用重启不会暴露半成品为权威文件；
- 每个 turn 的 output-truncation recovery 累计不超过 1，跨 HTTP 请求仍生效；第二次命中
  产生终态错误及告警，不形成“每请求一次”的慢循环；
- Gateway 与客户端只有一个 recovery owner，重复 chunk 幂等，乱序/重复/路径变化可拒绝。

### 11.3 性能与成本

- 确认截断后的额外 provider attempts：`error/client-owner` 路径为 0；经批准的
  `gateway-owner chunk` 路径最多 1；
- 不再出现“第一次已 hit length，第二次又完整生成数分钟”的 generic repair 路径；
- 初始、repair、recovery attempt 的 duration、token、取消和 validation 结果分别可统计；
- 受控样本的专用错误或首个 staging chunk 明显早于当前 3–10 分钟盲重试路径。

在没有真实供应商 latency 分布前不写死绝对秒数 SLO；shadow/beta 后基于 P50/P95 制定。

### 11.4 用户体验

- UI 区分“用户停止”“provider 等待”“正在恢复”“需要压缩”“artifact 未完成”“最终失败”；
- 只有实际进入已协商 recovery 后才显示“正在分段”，不能用预测性文案掩盖普通重试；
- compaction 显示为正常阶段，成功后 turn terminal state 覆盖可恢复的中间 error；
- 用户无需重新执行已成功的 MedEvidence/PubMed 检索；
- 只有自动恢复/压缩达到上限后才建议缩小任务或创建新会话。

### 11.5 可观测性与隐私

- request event 可回答每次 attempt 的 kind、duration、usage、finish reason、工具名、UTF-8
  参数 bytes/code units、validation subtype、recovery owner/id/count/action/result；
- `req-8c3d...` 式失败与 `req-cdfa...` 式成功能从脱敏字段解释，不再只看到工具名 `read`；
- provider 未回 usage 记录为 unknown/null；attempt、reservation 与计费字段可以对账；
- 不记录工具参数正文、生成文件正文、API key、用户身份或医学内容；
- Desktop 顶层 app version 不再长期为 `local`，并可用 request id + turn id 完成跨端对账。

### 11.6 杜衡长任务完成性

- 固定 hash 的本地 fixture replay 必须同时覆盖正常 `stop` 和 output-limit 两条路径；前者
  不因约 49 KiB 输入被误杀，后者不得自动通用重试或返回部分成功；
- 真实验收必须由 Desktop 发起并覆盖完整 R760 agent loop；单次 Gateway `200`、一次合法
  tool call、模型 `stop` 或“已生成部分章节”都不算长任务完成；
- 成功结果具有 15 个要求部分、可追溯来源、Desktop terminal completed 和最终产物校验；
  个人姓名及单位信息不得进入交付物；
- 未完成时必须落入明确的 timeout/cancel/output/context/tool 终态之一，保留可对账的请求链、
  attempts、usage 和工具进度，不得永久 pending、静默结束或把半成品展示为成功；
- 只有本地 replay 与真实 E2E 都通过，才关闭“无法跑完”问题。

## 12. 分阶段实施与回滚

### 阶段 0：审核

- 关闭 §13 的 8 项决策，确认 32k 是客户端遗留预算而非模型上限；
- 立即向 Desktop 团队发送本文作为联合协议 draft，不等待 Gateway P0 完工；指定双方
  owner、评审时限和固定合成 fixture，但不得把未关闭的字段描述为已定生产契约；
- 客户端团队已给出条件批准意见；双方继续关闭精确 `artifact-write-v1` Schema、
  staging/commit、顺序、幂等、hash、取消和 turn terminal 语义；首版排除通用
  `edit/apply_patch`；
- 确认 accepted capability 在首个工具调用前的传输方式、错误 HTTP/SSE 契约、旧客户端
  兼容性、客户端 ID 归属、唯一 recovery owner 与 Gateway 跨请求持久化计数键；
- 未完成这些决策前，不批准生产主动 chunk。

### 阶段 1：Gateway P0 分类、错误与审计

- 实现 completion assessment、统一截断口径、validation subtype、专用错误与 attempt/usage
  无损聚合；
- 增加 `legacy|shadow|error|chunk` 配置，但 `chunk` 在代码和配置中保持不可用/0% canary；
- 完成 §10.1、§10.2 和脱敏 replay；
- 本阶段不依赖 Desktop 发布，也不修改生产行为。

### 阶段 2：R760 shadow，再到 error

- 先只部署 `shadow`，记录如果启用会得到的分类、错误和 recovery 决策；
- 以 UTF-8 argument bytes 校准 soft candidate；不从 32k tokens 推导 hard bytes；
- 验证 attempts/usage 不丢失、旧客户端不受影响、错误率和数据体积可接受；
- 审核 shadow 数据后，先把指定测试 credential 切到 `error`，确认截断停止盲重试；
- 不启用主动 chunk，不在同一 session 回退到 Azure。

### 阶段 3：Desktop capability、事务与动态预算

- 发布 `artifact-write-v1`、稳定 user-message `client_turn_id`、客户端创建并持久化的
  `artifact_id/recovery_id`、recovery owner/count 和在首个 tool call 前可见的双向
  accepted-capabilities；
- 实现 staging、幂等、offset/hash、final validation、原子 commit、取消/重启恢复和 UI 状态；
- 把 Research Markdown 作为带 immutable id/hash 的 Build handoff；
- 单独移除 MedCode 普通请求 32k 硬编码，Gateway 发布/确认 effective context/output budget
  并以最终 tokenizer/admission 校验模型/context-aware 动态预算；该项不能替代 artifact
  协议，也不能改成全局固定 128k；
- 完成 §10.3 的 Desktop 源码、打包应用和 R760 `error` 路径 E2E。

### 阶段 4：R760 capability-gated chunk canary

- 仅对明确测试 credential、精确 `artifact-write-v1` 双向 capability 已在首个 tool call
  前确认、`recovery_owner=gateway`、客户端 ID 原样校验且协议版本匹配的请求开放非零 canary；
- 先合成 artifact，再内部 beta；逐项观察 incomplete rate、重复 chunk、turn recovery
  loop、duration、usage 和最终 commit 成功率；
- 任一完成性或对账指标异常，立即退回 `error`；
- 不在同一 session 回退到 Azure。

### 阶段 5：guard enforcement 与范围评估

- 仅对声明并被 Gateway 接受 capability 的新客户端启用模型感知 hard guard；
- 旧客户端继续 shadow，直至版本覆盖率满足迁移门槛；
- 根据 R760 数据单独决定 Azure compatibility 是否值得移植错误分类；不自动扩展主动
  recovery，Azure 下线计划不得因此被反向延长。

### 回滚

按从最小影响到代码回退的顺序执行：

1. 将 `MEDCODE_NATIVE_FILE_TOOL_RECOVERY_CANARY_PERCENT=0`，并把
   `MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE=error`；这会立即停止主动 recovery，同时保留
   对确认截断的安全终止。
2. 若专用错误契约本身造成客户端兼容问题，退到 `shadow`；只有必须完全恢复旧响应时才
   使用 `legacy`，因为它会重新允许当前 generic retry 风险。
3. Desktop 通过 kill switch 停止声明 chunk capabilities/recovery owner；已在 staging 的
   artifact 保持 incomplete 或清理，绝不能强制 commit。
4. tool-loop/context guard 退回 `shadow`；不触发 Azure fallback。
5. 如需代码回退，切换到发布记录中已验证的 previous R760 release symlink target，仅重建
   Gateway 服务并执行普通问答、小工具、错误契约和数据库写入 smoke。
6. 新增数据库/event 字段必须是 additive/nullable，旧代码可忽略；回滚不删除事件、不改
   用户正文，也不做破坏性 schema downgrade。

## 13. 审核待决策项

以下仍保持 8 项，复审时应逐项记录批准、修改或拒绝及 owner：

1. **错误码与传输语义**：是否批准 §7.4 的
   `tool_call_output_truncated = 502/server_error`、
   `output_length_exceeded = 502/server_error`、
   `context_compaction_required = 413/invalid_request_error` 及 versioned metadata？
   **建议：批准**，并要求 streaming/non-streaming 一致；`retryable=false` 明确指原 payload。
2. **P0 恢复策略**：确认截断后是 Gateway 主动恢复，还是先返回客户端？
   **建议：生产默认 `error`、`recovery_owner=client`**。只有版本化 artifact E2E、双向
   accepted `artifact-write-v1` capability、经审核的精确工具 Schema、
   `recovery_owner=gateway`、客户端稳定 user-message turn id、客户端创建并持久化且由
   Gateway 原样回显的 artifact/recovery id、Gateway 权威累计次数为 0 和 credential
   canary 全部满足后，才批准 Gateway 最多一次非最终 chunk；首版明确排除
   `edit/apply_patch`。
3. **参数预算与 Desktop 32k**：soft/hard UTF-8 argument bytes 如何校准，是否移除 MedCode
   普通请求的 32k 硬编码？**建议：参数 bytes 先 shadow，不在审核前写死 hard 值；批准把
   32k 认定为遗留客户端 cap 并单独改为模型/context-aware 动态预算；Gateway 必须发布并
   确认 effective context/output budget，使用最终 tokenizer/admission 校验；禁止固定全局
   128k，也禁止用 token cap 推导工具 byte cap。**
4. **Capability 与恢复 owner**：是否批准精确版本的请求/响应 capability header、稳定
   `client_turn_id/recovery_id` 和唯一 recovery owner，而不是依赖 app semantic version？
   **建议：按 Desktop 条件批准意见修订后批准**；accepted capability 必须在首个 tool call
   前通过初始 HTTP header 或首个 SSE control event 可见；turn id 使用稳定 user-message id，
   artifact/recovery id 归客户端创建与持久化，Gateway 原样回显并持久化权威计数；未及时
   确认或计数不一致时不得激活行为。
5. **Context/tool-loop guard**：是否只对 accepted-capability 客户端执行模型感知 hard guard，
   把现有 100k/120k 保留为 policy 阈值？**建议：是**；旧客户端迁移期只 shadow。
6. **部署范围**：R760 验证后是否自动扩展 Azure compatibility？**建议：否**；错误分类可
   单独评估，主动 recovery 不自动移植，也不延长 Azure 下线计划。
7. **Artifact handoff 与完整性**：是否批准以带 immutable id/hash 的 Research Markdown
   派生 Build 会话，并要求 staging/final/atomic commit 状态机？**建议：批准**；骨架、首块、
   模型 `stop` 或 Gateway `ok` 均不得视为最终完成；最终校验和原子 commit 明确只属于
   Desktop，Gateway 不宣告本地产物完成。
8. **Turn/UI 终态与循环上限**：UI 是否把中间 attempt error 作为可恢复事件，只用 turn
   terminal state 决定最终错误，并由双方执行同 turn 跨 HTTP recovery 累计上限？
   **建议：是**；第二次命中必须终止并告警。

## 14. 建议的审核结论

建议本轮结论为“**有条件批准设计，分层进入实现**”：

1. 可立即批准 Gateway P0 的统一 completion assessment、length/incomplete-aware 分类、
   专用错误契约、validation subtype、attempt/usage 无损审计、feature flag 和 shadow replay。
2. shadow 数据通过复审后，可批准 R760 `error` 模式：确认截断停止 generic retry，并把恢复
   责任交给客户端；该阶段不需要也不允许主动 chunk。
3. 可并行推进 Desktop `artifact-write-v1` transaction、首个 tool call 前完成双向
   capability 确认、客户端 ID 持久化、Research → Build immutable handoff、turn/UI 终态
   对账，以及由 Gateway 最终校验的模型/context-aware 动态预算。
4. Gateway 主动 `chunk` 仅作条件性批准；在 Desktop 打包 E2E、最终完整性、跨请求上限、
   唯一 recovery owner、Gateway 持久化计数、credential canary 和回滚演练全部有证据前，
   生产比例必须为 0；不得以 `write/edit/patch` 名称推断或放行。
5. 强制回归样本至少包括：成功大型 Markdown、length 截断且无效 HTML、length 但合法 JSON、
   非 length 不完整流、大型疑似超预算 invalid JSON、合法/无效 `read`、首块后提前停止、
   跨请求恢复循环、普通小工具、用户取消，以及 §10.5 固定 hash 的杜衡长任务；后者必须
   同时通过本地 replay 和 Desktop/R760 完整 agent-loop E2E。

不建议批准：固定把所有请求提升到 128k、静默修补截断 JSON、流式未校验参数直接落盘、
Gateway 删除历史消息、Gateway/客户端双重恢复、无上限重试或跨 Azure/R760 重试同一 session。

本文获得审核通过之前，不应把用户临时规避说明当作问题已经关闭；生产 Gateway 当前
仍可能在类似的长上下文完整文件任务中重复出现相同失败。
