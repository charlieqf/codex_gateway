# GoldenCode `tool_choice=required` 工具循环：问题描述与修复方案

> 日期：2026-07-14
>
> 状态：审核意见已纳入；P0 与 24 小时 shadow 代码已实现，待部署灰度
>
> 范围：生产 Gateway 的 `/v1/chat/completions`、GoldenCode/GLM-5.2 原生客户端工具调用
>
> 时区：除非明确写 UTC，本文时间均为 Australia/Sydney

## 1. 审核结论摘要

生产事件已证明存在系统性工具循环风险：客户端发送 `tool_choice=auto`，Gateway 的文件/成品任务启发式将其改为 `required`；模型每轮因而必须返回至少一个工具调用，不能用 `finish_reason=stop` 结束。客户端执行工具并携带结果发起下一次 HTTP 请求后，Gateway 又基于完整历史重复命中同一启发式，最终形成跨请求循环。

客户端团队追加确认：用户最新的文献检索问题本身不是文件生成请求；真正触发启发式的是 Research system prompt。当前 `looksLikeFileGenerationTask` 拼接扫描全部 messages，而 Research prompt 固定包含 `write/generate/create/build/make` 和 `code/pages/files/source file` 等两组关键词。因此只要请求携带该 Research prompt 和 file/code 类工具，**即使当前用户问题只是普通文献检索，也会稳定误判为文件生成任务**。这不是边缘概率误判，而是当前提示词和 Gateway 分类器之间的确定性冲突。

本次用户事件中，Gateway 容器、宿主机资源和 Nginx 没有发生整体故障。客户端到公网 Gateway 的瞬时连接超时/重置、OpenRouter 长响应、PubMed/Webfetch 失败均真实存在，但它们是延迟和循环次数的放大因素，不是工具循环的根因。

推荐分三层修复：

1. **P0 根因修复**：文件任务意图只能检查当前有效 user message，禁止扫描 system/developer/assistant/tool 内容；`auto -> required` 还必须只允许发生在尚未执行过任何客户端工具的首个工具步骤。一旦消息历史包含 assistant tool call 或 `role=tool` 结果，初始选择和 acknowledgement retry 两条路径都不得再升级为 `required`，必须保留 `auto`，允许模型生成最终答复。
2. **P0/P1 Gateway 安全网**：按 subject、credential、`client_turn_id`、public model 统计连续工具轮次和总耗时；达到硬阈值后只允许一次 `tool_choice=none` 的强制总结，禁止继续调用工具。
3. **P1/P2 防放大保护**：加入单 HTTP 请求总 deadline、Prompt 阈值和客户端侧重复工具失败熔断。deadline 不能代替工具轮次上限。

不建议仅通过缩短 OpenRouter timeout、切换 GoldenCode 平台成员或增加客户端重试解决。这些措施不会解除 `required`，可能只是把无限工具循环变成反复超时或跨平台循环。

## 2. 生产事件

### 2.1 用户报告的两个 turn

为避免在审核材料中扩散个人信息，本文只保留必要的 `client_turn_id` 和聚合数据，不记录手机号、完整 credential、问题正文或工具返回正文。

本次定向查询使用客户端提供并由生产诊断事件确认的标识：

- subject：`subj_GW_Q0211KpnHLZn-9xFN7w4Y`；
- client session：`ses_0a1ae80b1ffeJ7tCTlcwfkxtXk`；
- 两个 client turn 如下表。

诊断数据中的 `app_version=local` 是客户端团队已确认的遥测问题，不能用于判断用户实际安装版本，也不作为本次根因或影响范围依据。

| 项目 | 第一次 turn | 第二次 turn |
|---|---:|---:|
| `client_turn_id` | `msg_f5e517f5b001PRvcufHrlsx4ZQ` | `msg_f5e611797001ETL393kGYg7dQG` |
| 客户端开始时间 | 11:50 左右 | 12:07 左右 |
| 取证时 Gateway 请求数 | 21 | 截至 12:39 已达 38，仍在继续 |
| Gateway 成功/失败 | 20 成功；1 `client_aborted` | 38 成功；0 Gateway 错误 |
| `tool_choice` | 1 次 `auto`；20 次 `required` | 38 次均为 `required` |
| 完成原因 | 1 次 `stop`；19 次 `tool_calls`；1 次中断 | 已完成请求全部为 `tool_calls` |
| 已返回工具调用 | 59 个 | 12:28 时前 20 次已返回 46 个；之后仍增长 |
| 最大单请求耗时 | 164,995 ms | 280,271 ms |
| 最大 Prompt | 89,389 tokens | 截至 12:39 已达 138,440 tokens |
| 路由 | `goldencode-openrouter` | `goldencode-openrouter` |
| 上游模型 | `z-ai/glm-5.2` | `z-ai/glm-5.2` |

第一次 turn 最终由客户端中断。第二次 turn 在最后一次取证时只有 `agent_turn.started`，没有 `completed`、`error` 或 `aborted` 终态。

### 2.2 当日影响范围

截至本次取证，今天存在 5 个带有效 `client_turn_id` 的 GoldenCode turn：

- 5/5 均达到至少 12 次模型请求；
- 4/5 达到至少 20 次；
- 最高已达到 65 次；
- 已观察到的最大 Prompt 超过 138k tokens。

该统计不代表 5 名不同用户，也不包含缺少 `x-medcode-client-turn-id` 的调用；它足以证明问题不是单一用户、单一 PubMed 失败或一次偶发网络故障。

## 3. 生产证据

### 3.1 Gateway 和主机稳定性

事发时生产容器来自 release `e58877e`，状态如下：

- 容器持续 `healthy`；
- `RestartCount=0`；
- `OOMKilled=false`；
- 约 384 MiB/6 GiB 容器内存，24 PIDs；
- 容器 `/tmp` 约 2.6 MiB，没有遗留 `codex-gateway-state-*` 目录；
- 宿主机约 13.1 GiB available memory，负载很低；
- 01:00–02:39 UTC 的 Nginx `/v1/*` 访问记录中，已聚合的 400 个请求均为 HTTP 200，其中 `/v1/chat/completions` 361 个；
- 没有同期 Nginx 499/5xx 激增、OOM 或容器重启证据。

注意：SSE 在响应头写出后中途断开时，Nginx access log 仍可能记录 200，因此“全部 200”不能排除单连接中途重置；它可以排除同一时段明显的 Gateway 整体不可用或 5xx 风暴。

### 3.2 客户端连接异常

第一次 turn 的客户端诊断包含：

- 两次连接 `gw.instmarket.com.au:443` 的 10 秒 connect timeout；
- 一次 `read ECONNRESET`；
- 最终一次 `AbortError`/Gateway `client_aborted`。

connect timeout 没有对应的 Gateway/Nginx入站请求，说明连接尚未抵达应用层，更符合客户端、本地网络、ISP、TLS/边缘链路的瞬时问题。`ECONNRESET` 与客户端中断相邻，是本次体验恶化的一部分，但无法解释几十次成功的 `required -> tool_calls`。

按客户端、Gateway 和服务器时间线对齐：

- 11:51 左右的两次 connect timeout 发生在 Gateway 首次记录该 turn 的成功模型请求之前；
- Gateway 从约 11:52:28 开始持续接受并完成该 turn 的请求；
- 12:08 左右客户端记录 `ECONNRESET`，随后该 turn 出现 Gateway `client_aborted`；
- 第二个 turn 在连接恢复后能够持续得到 HTTP 200/tool_calls，说明网络异常不是其 30+ 轮无法结束的必要条件。

### 3.3 OpenRouter 延迟和输出放大

同一取证窗口内，两个目标 turn 的 `goldencode-openrouter` 请求与其他请求对比如下：

| 样本 | duration P50 | duration P95 | 最大值 |
|---|---:|---:|---:|
| 两个目标 turn | 27.9 秒 | 55.3 秒 | 280.3 秒 |
| 同期其他 `goldencode-openrouter` 请求 | 8.1 秒 | 22.5 秒 | 另有一次 600 秒 timeout |

两个代表性长请求：

1. 164,995 ms 请求进行了两次上游尝试。第一次 OpenRouter HTTP 200，但没有产生满足 `required` 的合法工具调用；Gateway 以 `auto` 做 validation retry，第二次返回 4 个工具调用。
2. 280,271 ms 请求一次完成，OpenRouter HTTP 200，原始 SSE 累计约 2.89M 字符，Prompt 57,363 tokens，最终 total 71,587 tokens，即约 14,224 个输出 tokens；最终仍为 `tool_calls`。

生产 `MEDCODE_OPENROUTER_TIMEOUT_MS=600000`，因此 280 秒虽然用户感知接近卡住，仍在当前 provider attempt timeout 内。缩短该 timeout 可以减少单次最坏等待，但不会让模型生成最终答复。

Gateway `request_events.first_byte_ms` 在这些 native-tool 请求中多为 20–40 ms，不能解释为真实 OpenRouter TTFT：当前路径会先发送 Gateway 自己的 SSE 初始帧，再等待工具结果。延迟评估应使用完整 duration、provider diagnostics 或未来新增的 upstream-first-semantic-event 指标。

### 3.4 工具错误

第一次 turn 的客户端工具终态包括：

- PubMed：45 次成功、1 次 502；
- Webfetch：8 次失败、1 次成功；
- 失败类型包括传输失败、403 和 404。

这些错误会促使模型换关键词、换来源或再次调用工具。但即使全部工具成功，只要下一轮仍被强制为 `required`，模型依旧不能正常结束。

### 3.5 GoldenCode 四平台路由

两个 turn 均粘滞到 `goldencode-openrouter`。这是当前 pool affinity 的预期结果：成功响应不会触发账号冷却或跨成员 failover。四个平台最终都是 GLM-5.2；将每一工具轮随机切换平台会破坏亲和性和可复现性，也无法解除 Gateway 的 `required`。

路由策略不是根因。上游 `upstream_timeout`、`upstream_unavailable` 等真实失败仍应按现有 pool 规则处理，但不能把“返回了合法 `tool_calls`”误判为需要换平台。

## 4. 根因分析

### 4.1 触发链路

当前链路可概括为：

```text
客户端发送 tool_choice=auto + Research system prompt + write/pubmed/webfetch 等工具
  -> Gateway 把全部 messages 拼接为一个分类文本
  -> Research prompt 自身同时包含 create/write 和 code/file/page 等固定词
  -> 即使最新用户问题只是文献检索，Gateway 仍判断为文件/成品任务
  -> initialNativeToolChoice 将 auto 改成 required
  -> GLM-5.2 必须返回至少一个 tool_call
  -> 客户端执行工具并把结果追加到消息历史
  -> 客户端发起同一 client_turn_id 的下一次 HTTP 请求，仍传 auto
  -> 历史仍含 file/code/create/write 等触发词，Gateway再次改成 required
  -> 无法产生最终 stop，循环重复，Prompt 与耗时持续增长
```

### 4.2 相关代码

主要代码位于 `apps/gateway/src/index.ts`：

- `runNativeClientTools`：记录 `native_tools_initial_tool_choice=auto_to_required`；
- `initialNativeToolChoice`：决定是否覆盖客户端 `toolChoice`；
- `shouldRequireNativeToolForFileGeneration`：按模型、工具定义和完整消息文本判断；
- `nativeAutoToolRetryPlan`：即使初始选择保持 `auto`，确认式短回复仍可能触发 `auto_ack_to_required`，构成第二个升级入口；
- `looksLikeFileGenerationTask`：扫描整个请求消息历史；
- `modelsWithAutoOnlyNativeTools`：当前只包含 `glm-5-turbo`，不包含 `glm-5.2`；
- `nativeValidationRetryPlan`：GLM-5.2 的 required validation 失败后可再以 `auto` 重试，导致单 HTTP 请求进一步放大。

相关行为由 `5092d64`/`b4304070` 引入，初衷是避免 OpenRouter 文件任务只回复“我将创建文件”却不调用写文件工具。`4fe64e4` 为 Responses 请求增加了 `preserveAutoToolChoice`，但普通 `/v1/chat/completions` 没有同等保护。

客户端团队确认这两个 turn 在有工具时发送的原始值均为 `tool_choice=auto`；Gateway `request_events.tool_choice` 却记录为 `required`，代表性生产日志同时明确出现：

```text
native_tools_initial_tool_choice=auto_to_required
```

结合当前唯一执行路径，可以确认有效值是在 `initialNativeToolChoice`/`shouldRequireNativeToolForFileGeneration` 中被 Gateway 改写，而不是客户端原本发送了 `required`。

审核进一步发现根因不只存在于初始选择。`nativeAutoToolRetryPlan` 在以下条件同时成立时也会把 `auto` 升级为 `required`：

1. 客户端原始选择和本次 attempted choice 都是 `auto`；
2. 模型没有返回工具调用；
3. 模型返回不超过 180 字符的“I'll create/我来创建”式确认文本；
4. 上游模型不在 auto-only 集合中；GLM-5.2 当前符合此条件。

因此只修改 `shouldRequireNativeToolForFileGeneration` 不完整：已有工具历史时，初始选择虽然会保留 `auto`，短确认仍可在同一 HTTP 请求内触发 `auto_ack_to_required`，重新产生 tool calls 并延续客户端循环。P0 必须同时封堵两个升级点。

### 4.3 Research system prompt 的确定性误判

客户端仓库的 `packages/desktop-electron/resources/opencode-config/agent/research.md` 固定包含以下语义：

- 动作组：`write`、`generate`、`create`、`build`、`make`、`implement`；
- 对象组：`code`、`HTML/CSS/JS`、`scripts`、`pages`、`files`、`source file`；
- 还明确要求在 filesystem tools 可用时 create/edit source file。

Gateway 当前分类器把所有消息 content 合并后，只要同时命中动作组和对象组就返回 true。它不区分这些词来自 system policy 还是用户意图。因此对带 Research prompt、write/file 工具的普通医学研究请求，分类结果在读取用户问题之前就已经被 system prompt 决定。

只增加更多正向关键词或修改用户问题无法可靠修复。分类器必须限定消息角色和当前 turn 范围，并以回归测试锁定。

### 4.4 为什么现有机制没有停止循环

1. Gateway 每次只处理一个 stateless chat completion，不拥有客户端完整 agent loop。
2. 虽然 `x-medcode-client-turn-id` 已进入 `request_events.client_turn_id`，当前执行路径没有用它做轮次或总耗时限制。
3. Provider timeout 只限制单次上游 attempt；每次成功返回 `tool_calls` 后，客户端可以无限创建下一次请求。
4. Gateway rate/concurrency limiter 在每次请求完成后正常释放，所以不会把串行工具循环识别为 concurrency 超限。
5. GoldenCode pool 把成功的 `tool_calls` 视为成功，不会换成员，也不应靠换成员终止业务层循环。

## 5. 目标与非目标

### 5.1 目标

- 保留首个文件/成品任务主动调用工具的成功率；
- 工具执行后允许模型生成最终文本答复；
- 即使旧客户端自身没有轮次限制，也不能无限调用；
- Prompt、总耗时和上游成本存在明确上界；
- 超限时优先返回可用的阶段性总结，而不是只显示 generic internal error；
- 所有保护行为可观测、可灰度、可回滚；
- 不记录问题正文、工具正文、完整 key 或个人联系方式。

### 5.2 非目标

- 不用本修复改变 GoldenCode 四平台权重或粘滞策略；
- 不把 PubMed/Webfetch 的具体站点错误全部转移到 Gateway 修复；
- 不保证模型在缺少可靠证据时生成确定性医学结论；
- 不通过重启 Gateway 或永久禁用用户 key 处理单个工具循环；
- 不把单请求 deadline 当作 agent turn deadline。

## 6. 方案比较

| 方案 | 效果 | 风险 | 结论 |
|---|---|---|---|
| A. 完全删除 `auto -> required` | 最直接消除 Gateway 强制循环 | 可能恢复“只承诺创建但不调用 write”回归 | 不单独采用 |
| B. 把 `glm-5.2` 加入 `modelsWithAutoOnlyNativeTools` | 改动很小，四平台 GLM-5.2 均保留 auto | 所有 GLM-5.2 首轮文件任务都不再强制工具 | 可作紧急开关，不是首选最终方案 |
| C. 只扫描最新 user message，并同时限制 initial choice 与 acknowledgement retry 的 `auto -> required` | 排除 system prompt 误判；保留真实文件任务首轮工具可靠性；执行过工具后不会从任一入口重新升级 | 需要可靠定位最新 user message、既有工具回合和两条升级路径 | **推荐 P0 根因修复** |
| D. 仅增加单请求 timeout | 限制某一次调用的最长时间 | 下一轮仍可继续；用户得到更多 timeout | 仅作防放大 |
| E. 仅由新客户端限制轮次 | 客户端最理解工具执行状态 | 旧客户端继续受影响，无法立即覆盖 | 必须做，但不能作为唯一保护 |
| F. Gateway 按 `client_turn_id` 做硬上限和总结 | 覆盖旧客户端，提供全局安全网 | 涉及跨请求状态、并发和总结失败语义 | **推荐 defense-in-depth** |
| G. 每轮切换 GoldenCode 平台 | 可能避开某成员短时延迟 | 不能解除 required；破坏粘滞和复现 | 不采用 |

## 7. 推荐设计

### 7.1 P0：两个 `auto -> required` 入口都只用于首个工具步骤

首先把文件任务分类输入改为**最新有效 user message**，不能再拼接全部 messages：

```ts
function latestUserText(request: ChatCompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}
```

system、developer、assistant 和 tool message 必须从意图分类输入中排除。多模态 user content 若未来需要支持，应通过显式的用户文本提取器处理，不能回退到扫描 system prompt。

然后新增纯函数识别是否已经执行过工具，例如：

```ts
function hasCompletedClientToolRound(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0)
  );
}
```

`shouldRequireNativeToolForFileGeneration` 必须同时满足：

1. 客户端原始值为 `auto`；
2. 工具列表包含 file/code/write 类工具；
3. **最新有效 user message** 确实像文件/成品生成；
4. 模型不属于 auto-only 集合；
5. **消息历史中尚未出现任何 assistant tool call 或 tool result**；
6. 调用路径没有设置 `preserveAutoToolChoice`。

一旦已有工具历史，Gateway 必须把客户端的 `auto` 原样发给上游。显式传入的 `required` 或 named function choice 仍然尊重，不得静默改成 `auto`。

同一个 `hasCompletedClientToolRound` 判断必须传入并约束 `nativeAutoToolRetryPlan`：

- 没有工具历史、真实文件任务、模型只返回确认式短文本时，可保留现有首步骤 `auto_ack_to_required` 行为；
- **已有工具历史时，禁止返回 `auto_ack_to_required`**；
- 推荐新增可观测的 `auto_ack_after_tool_to_auto` 分支，重试 choice 仍为 `auto`；
- 该分支使用新的 post-tool retry prompt：“不要只确认；如果仍确有必要可调用工具，否则立即基于现有结果给出最终答复”；不能复用当前强制“必须调用工具”的 acknowledgement prompt；
- post-tool acknowledgement retry 每个 HTTP 请求最多一次；第二次仍为短确认时直接作为文本结果结束，不再重试；
- `auto_empty_to_auto` 始终保留 `auto`，不属于本次升级漏洞；
- GLM-5.2 的 `validation_failed_to_auto` 也是降回 `auto`，保持现有行为即可。

如果实现者选择“已有工具历史时不重试确认式短文本”，同样可以封堵 required 升级，但可能把“I'll create”式低质量确认直接作为最终文本返回。综合质量和成本，本文推荐一次带中性 prompt 的 `auto_ack_after_tool_to_auto`。

建议增加紧急配置开关：

```text
MEDCODE_NATIVE_TOOL_FORCE_REQUIRED_MODE=first_step
```

允许值：

- `first_step`：推荐默认值；
- `disabled`：紧急关闭所有 auto-to-required；
- `legacy`：仅用于短期兼容性诊断，不是完整旧行为回滚。它恢复完整历史文件分类和“尚无工具历史”时的旧 acknowledgement escalation，但**不会越过 `hasCompletedClientToolRound` 安全边界**；已有工具历史时仍保持 `auto`，避免为诊断重新打开本次循环根因。

对 auto-only 模型还需区分“不能发送 `required`”与“是否使用强工具提示”：glm-5-turbo 的真实首步骤文件任务必须继续发送 `tool_choice=auto`，但 acknowledgement retry 应保留原有“立即调用客户端工具完成任务”的强提示。不能复用 `shouldRequireNativeToolForFileGeneration` 的结果选择 prompt，因为该函数会按 auto-only 能力提前返回 false；应单独计算“最新 user 确为文件任务且尚无工具历史”的标志。

### 7.2 P0/P1：跨请求工具循环保护

仅在存在合法 `x-medcode-client-turn-id` 时启用跨请求保护。统计键必须至少包含：

```text
subject_id + credential_id + client_turn_id + public_model_id
```

不能只按 `client_turn_id`，否则不同用户构造相同 ID 时会相互影响。

**已接受的残余风险**：没有携带 `x-medcode-client-turn-id` 的旧版或非标准客户端无法使用跨请求 turn guard。它们仍受 P0 两个升级入口修复和单 HTTP 请求 deadline 保护，但 Gateway 无法可靠聚合跨请求轮次、elapsed 或 finalizer 幂等状态。这是有意取舍：不使用 prompt、IP、session 猜测 turn 身份，避免跨用户误伤。后续若要覆盖，客户端必须先提供稳定 turn id。

建议 shadow 期初始候选阈值：

| 条件 | 动作 |
|---|---|
| 连续 8 次 `finish_reason=tool_calls` | Warning 日志/指标；继续当前请求 |
| 连续 12 次工具完成 | 进入 finalization，不再向上游提供工具 |
| turn elapsed 达 10 分钟 | 进入 finalization |
| 估算 Prompt 达 100k | Warning，并要求客户端压缩历史 |
| 估算 Prompt 达 120k | 进入 finalization；不得继续扩张工具历史 |

阈值应配置化。P0 根因修复可以直接启用；turn guard 首先以 shadow 模式记录至少 24 小时并覆盖真实使用高峰，再由审核确认正式 hard 值。shadow 期间表中的 Hard 条件只记录“本应 finalization”，不实际改写请求：

```text
MEDCODE_TOOL_LOOP_WARNING_CALLS=8
MEDCODE_TOOL_LOOP_HARD_CALLS=12
MEDCODE_TOOL_LOOP_MAX_ELAPSED_MS=600000
MEDCODE_TOOL_LOOP_PROMPT_WARNING_TOKENS=100000
MEDCODE_TOOL_LOOP_PROMPT_HARD_TOKENS=120000
```

正式 enforcement 启用后必须有审核批准的默认值，不能因环境变量缺失而静默变为无限制。Hard=12 是事故拦截候选值，不在 shadow 数据出来前宣称为最终阈值；如果合法重度研究任务分布接近 12，应提高 calls 阈值或以 elapsed/prompt 联合判断，但不得取消 hard guard。

统计来源：

- 已完成历史使用 `ObservationStore.listRequestEvents({ subjectId, clientTurnId, ... })`；
- 只统计当前 public model 下连续的 `tool_calls`，遇到 `stop`、终态失败或新的 turn 即重置；
- 当前进程增加小型 in-memory reservation，防止同一 turn 的并发请求同时越过硬阈值；
- DB 是重启后的恢复依据，in-memory reservation 只解决单进程竞态；
- 查询已有 `client_turn_id + started_at` 索引，必须设置小 limit，不做全表扫描。

### 7.3 超限后的强制总结

达到硬阈值后，不应继续把客户端工具定义发给上游。Gateway 对该请求执行一次 finalizer：

1. 将有效工具选择覆盖为 `none`；
2. OpenAI-compatible adapter 在 `clientToolChoice=none` 时不发送 `tools` 和 `tool_choice`；
3. 在 prompt 末尾追加受控 developer 指令：停止调用工具，仅根据已有上下文总结；明确说明未完成事项、失败来源和证据限制；不得声称失败工具已成功；
4. 成功时返回普通 `finish_reason=stop`，让现有客户端自然结束；
5. 同一 turn 只允许一个 finalizer；若客户端在 finalizer 成功后仍重试，直接返回明确错误，不再次产生模型成本；
6. finalizer 自己必须受更短 timeout 和输出 token 上限约束。

建议为失败路径新增真实 Gateway error code：

```text
agent_turn_limit_exceeded
```

建议 HTTP 409 或 422；错误消息应明确为“工具轮次或总耗时达到安全上限，自动总结未成功”，而不是 `internal server error`。新增错误码需要同步 core 类型、OpenAI error payload、Responses failure event、客户端文案、统计分类和测试。

如果审核不接受新增错误码，首期可暂用 `invalid_request`，但必须通过结构化日志字段区分；不建议长期复用 `service_unavailable`，因为这不是基础设施故障。

`agent_turn_limit_exceeded` 在真正加入 `GatewayErrorCode` 后，必须同步更新监控预警方案第 6.5 节的错误码分类和规则测试；在枚举落地前，监控文档不得把它当作已经存在的真实 error code。

### 7.4 单 HTTP 请求总 deadline

当前 OpenRouter provider attempt timeout 为 600 秒。建议把“provider attempt timeout”和“Gateway chat total deadline”分开：

- GoldenCode 单请求 Warning：180 秒；
- 初始 total deadline 建议 360 秒，灰度观察后再评估 300 秒；
- finalizer deadline 建议 120 秒；
- deadline 超时归一化为现有 `upstream_timeout`；
- 流式请求发送失败事件并结束 SSE；
- 非流式返回 504；
- 所有租约、concurrency、token reservation 和临时状态必须在 `finally` 释放。

280 秒请求说明直接把 hard timeout 设成 180 秒会截断当前能够完成的请求。应先修复工具循环，再基于修复后的 duration 分布调整 deadline。

### 7.5 客户端工具失败熔断

客户端比 Gateway 更适合识别具体工具失败，因为它实际执行 PubMed/Webfetch 并掌握规范化参数。建议 Desktop/OpenCode agent loop 增加：

- 同一工具、同一规范化目标连续失败 2 次后，本 turn 禁止再次调用相同目标；
- 同一域名持续 403/404 时不再换同义 URL 反复尝试；
- PubMed 502/transport error 允许有限退避重试，之后把失败状态交给模型总结；
- 达到客户端轮次或耗时上限时发送一次 `tool_choice=none` finalizer；
- finalizer 失败时显示明确的“已停止工具循环”状态和已有阶段结果。

Gateway 的通用 turn guard 是旧客户端和异常客户端的最后安全网，不能依赖解析任意工具正文来做站点级熔断。

### 7.6 GoldenCode pool 行为

保持现有 sticky affinity：

- `tool_calls` 是业务成功，不触发成员切换；
- 真实 `upstream_timeout`、`upstream_unavailable`、provider auth/billing 错误继续参与 cooldown/failover；
- 不因达到工具轮次上限而惩罚 `goldencode-openrouter` 账号，因为根因在 Gateway/client loop；
- 统计必须同时保留 public model、pool member、upstream model，便于比较不同平台的延迟和工具质量。

## 8. 可观测性

建议为 `request_events` 或等价结构化事件增加：

- `agent_turn_request_index`；
- `consecutive_tool_call_rounds`；
- `agent_turn_elapsed_ms`；
- `turn_guard_action`：`none`、`warning`、`force_finalize`、`reject_after_finalize`；
- `effective_tool_choice_source`：`client`、`first_step_heuristic`、`turn_guard`；
- `upstream_first_semantic_event_ms`，与当前 Gateway SSE `first_byte_ms` 分开；
- finalizer 成功/失败和使用 tokens。

日志必须只包含 request id、turn 的不可逆 hash 或受控 ID、计数、模型和动作；禁止记录 prompt、工具正文、完整 key、手机号或邮箱。

建议报警条件：

- 单 turn 连续工具轮次达到 8；
- 5 分钟内出现 3 个以上 hard guard；
- 单 turn Prompt 超过 100k；
- finalizer 失败；
- GoldenCode 单请求超过 180 秒或达到 deadline；
- 某 pool member 的 P95 显著高于其他成员，但不得把工具循环计为账号故障。

## 9. 实施阶段

### 阶段 1：最小根因修复

1. 新增 `latestUserText` 或等价的角色限定提取器；
2. 新增 `hasCompletedClientToolRound`；
3. 禁止文件任务分类器读取 system/developer/assistant/tool message；
4. `initialNativeToolChoice` 的 `auto -> required` 限于真实文件意图的首个工具步骤；
5. `nativeAutoToolRetryPlan` 在已有工具历史时不得进入 `auto_ack_to_required`，改为一次中性 prompt 的 auto retry 或不重试；
6. 加配置模式 `first_step/disabled/legacy`；
7. 保持显式 `required` 和 named tool 语义；
8. 增加结构化日志，区分客户端选择、初始覆盖和 acknowledgement retry 覆盖；
9. 完成单元与集成测试；
10. 先对 GoldenCode 灰度，再观察 24 小时工具完成率和 turn 轮次数。

### 阶段 2：Gateway turn guard 与 finalizer

1. 只读查询既有 request events；
2. 增加进程内 reservation 防并发穿透；
3. 实现 warning/hard/prompt/elapsed 阈值；
4. hard guard 执行一次 `tool_choice=none` finalizer；
5. 增加明确错误码和观测字段；
6. 对 `/v1/chat/completions` 流式/非流式以及 `/v1/responses` 做一致性测试。

### 阶段 3：deadline、客户端熔断和报警

1. 上线可配置 Gateway chat total deadline；
2. Desktop/OpenCode 增加相同或更严格的本地轮次上限；
3. 加入 PubMed/Webfetch 重复失败熔断；
4. 将 turn warning/hard/finalizer failure 接入监控预警；
5. 根据修复后真实 duration 分布评估是否把 OpenRouter 600 秒 attempt timeout 下调。

## 10. 测试矩阵

### 10.1 单元测试

- system prompt 含 `create/write/file/code`、最新 user message 仅为文献检索：上游必须保持 `auto`；
- developer prompt 含文件生成词、最新 user message 非文件任务：上游必须保持 `auto`；
- assistant/tool 历史含文件路径或 source code、最新 user message 非文件任务：上游必须保持 `auto`；
- 首轮文件任务，客户端 `auto`：上游收到一次 `required`；
- 历史已有 assistant tool call：上游保持 `auto`；
- 历史已有 `role=tool`：上游保持 `auto`；
- 历史已有工具回合、模型在 `auto` 下返回确认式短文本：如发生 retry，第二次仍必须使用 `auto`，不得使用 `required`；
- 无工具历史的真实文件首步骤、模型在 `auto` 下返回确认式短文本：按批准模式验证首步骤 `auto_ack_to_required`；
- `auto_empty_to_auto` 和 GLM-5.2 `validation_failed_to_auto` 不得回归为 `required`；
- 客户端显式 `required`：仍为 `required`；
- 客户端 named function：仍为该函数；
- `/v1/responses` 的 `preserveAutoToolChoice` 不回归；
- GLM-5.2 的 OpenRouter/Qianfan/Aliyun/Tencent 成员行为一致；
- required validation failure 的单请求 retry 最多一次，且不会跨请求重新强制；
- turn warning 8 次、hard 12 次的边界值；
- 10 分钟和 Prompt 100k/120k 边界值；
- 不同 subject 使用相同 `client_turn_id` 不相互影响；
- 同一 turn 并发两个请求不能同时越过 hard limit；
- 缺少 `client_turn_id` 时不误伤，但仍适用首步骤修复和单请求 deadline；
- finalizer 上游返回 stop、错误、timeout、违规 tool call 的分支；
- 流式连接关闭后 reservation、租约、token budget 全部释放。

### 10.2 集成回归

- 模拟“生成文件 -> write -> PubMed/Webfetch -> 总结”的完整 agent loop，必须在有限轮次内得到 `stop`；
- 重放脱敏后的消息结构，不包含用户原文和真实工具结果；
- 使用脱敏的 Research system prompt 加普通文献检索 user message，必须不再出现 `auto_to_required`；
- 模拟 PubMed 502、Webfetch 403/404/transport error，最终必须总结而非无限重试；
- 模拟 OpenRouter 280 秒长流和 600 秒挂起，分别验证成功与 deadline；
- 验证四平台 pool sticky 不因 tool guard 错误 cooldown；
- 验证 request events 中 effective tool choice、轮次和 guard action 正确。

### 10.3 生产验收

- GoldenCode 真实短文件任务仍能实际调用 write 工具；
- 完成工具后下一请求的 effective choice 为 `auto`，并能返回 `stop`；
- 单 turn 不超过审核批准的硬上限；
- Prompt 不再无界增长；
- 观察窗口内没有新增 20+ 工具轮次；
- Gateway 容器无 restart/OOM/PID/临时目录回归；
- GoldenCode 四成员成功率、P50/P95 和 token 成本没有不可接受回归；
- 用户看到的是最终总结或明确 guard 错误，不是 generic internal server error。

## 11. 发布、回滚与紧急处置

### 11.1 发布

1. 提交并推送经过完整测试的 commit；
2. 从 commit 构建 release，不从 dirty worktree 部署；
3. 备份当前 release/env/数据库；
4. 保留生产 8 个 public models 和 GoldenCode 四成员配置；
5. 先启用 `first_step` 根因修复，turn guard 同时进入 shadow；
6. shadow 至少持续 24 小时并覆盖真实使用高峰，记录 8/12/10 分钟候选阈值的命中分布和合法任务样本；
7. 审核 shadow 结果并确认正式 hard 值后，再启用 hard guard/finalizer；
8. 串行执行 GoldenCode smoke，避免探针自己制造并发和锁压力；
9. 检查最近真实 turn 的轮次、stop 比例、Prompt 和错误。

### 11.2 回滚

- 代码可回滚到前一 release；
- `MEDCODE_NATIVE_TOOL_FORCE_REQUIRED_MODE=disabled` 是比恢复 `legacy` 更安全的紧急降级；
- turn guard 可独立切换为 shadow，但根因修复应继续保留；
- 如果 finalizer 产生质量问题，先关闭自动总结并在 hard limit 返回明确错误，不要恢复无限循环；
- 不回滚数据库事件数据，不删除取证记录。

### 11.3 正在发生的循环

在没有定向 cancel API 的当前生产版本中，单个 turn 的低影响中断手段有限：

- 优先让客户端主动 Stop/Abort；
- 可短时暂停目标 credential，但必须事先记录并在确认停止后恢复；
- 不为单个用户重启整个 Gateway；
- 不永久 revoke key，除非用户或管理员明确要求；
- 容器资源健康时不应仅为“可能卡住”执行全局重启。

本次第二个 turn 虽仍在继续，但取证时容器资源稳定，因此没有执行全局重启或永久 credential 变更。

## 12. 安全与隐私

- 审核文档不保存用户问题正文、工具正文、手机号、完整 credential 或上游 API key；
- 重放测试必须使用脱敏结构 fixture；
- finalizer 指令不得把隐藏 system/developer prompt 回显给用户；
- turn guard key 必须包含用户身份维度，防止跨用户 ID 碰撞；
- 只读调查使用 `readOnly: true`、busy timeout 和 `PRAGMA query_only = ON`；
- 自动处置不得重启整个容器、删除 SQLite/WAL 或清理用户文件。

## 13. 需要审核的决策

- [ ] 同意把 initial choice 和 acknowledgement retry 的 `auto -> required` 都限制为尚无工具历史的首个工具步骤。
- [ ] 同意文件任务分类只读取最新有效 user message，禁止扫描 system/developer/assistant/tool 内容。
- [ ] 同意提供 `first_step/disabled/legacy` 配置开关，生产默认 `first_step`。
- [ ] 同意 Gateway 按 subject、credential、`client_turn_id`、public model 实施跨请求保护。
- [ ] 同意 Warning=8 次、Hard=12 次、turn elapsed=10 分钟作为至少 24 小时 shadow 期初始候选值；正式 hard 值待分布审核后确认。
- [ ] 同意 Prompt Warning=100k、Hard=120k，并在 hard 阈值进入 finalizer。
- [ ] 同意 hard guard 只执行一次 `tool_choice=none` 强制总结。
- [ ] 同意新增 `agent_turn_limit_exceeded` 错误码；若不同意，确认首期替代错误码。
- [ ] 同意 GoldenCode total deadline 初始为 360 秒、finalizer deadline 为 120 秒，并在灰度后复核。
- [ ] 同意客户端增加重复 PubMed/Webfetch 失败熔断和本地轮次限制。
- [ ] 同意保留 GoldenCode sticky affinity，不以换平台方式处理工具循环。
- [ ] 同意 finalizer 有问题时返回明确错误，而不是恢复 legacy 无限循环。
- [ ] 同意无 `client_turn_id` 的客户端仅由 P0 和单请求 deadline 保护，并接受其无法使用跨请求 turn guard 的残余风险。
- [ ] 同意新增错误码落地时同步更新监控预警方案第 6.5 节分类清单与测试。

## 14. 当前状态

- 本文基于 2026-07-14 生产只读取证；
- 定向查询已按客户端提供的 subject、session 和两个 client turn 完成；`app_version=local` 已按遥测噪声排除；
- 工作区已完成两个 `auto -> required` 入口的 P0 修复：默认 `first_step`、紧急 `disabled`、诊断回滚 `legacy`；
- 文件任务分类已改为只读取最新有效 user message；历史存在 assistant tool call 或 tool result 时，initial choice 与 acknowledgement retry 均保持 `auto`；
- glm-5-turbo 的真实首步骤文件任务仍使用 `auto`，但确认式回复的 auto retry 已恢复原有强工具提示，避免 Pro 文件工具调用率因本次安全修复下降；
- 已加入 `auto_ack_after_tool_to_auto` 中性重试，并验证其采用第二次最终文本而不是恢复首次确认文本；
- 已加入跨请求 turn guard shadow：仅在 subject、credential、`client_turn_id`、public model 均可确定时读取最多 64 条历史并记录结构化评估；默认候选值为 8/12 次、10 分钟、100k/120k tokens，shadow 不改写、不拒绝、不中断请求；
- 已有可配置的 Gateway chat total deadline 机制；生产 GoldenCode 的 360 秒配置仍需随灰度部署显式确认；
- `tool_choice=none` finalizer、幂等 reservation 和 `agent_turn_limit_exceeded` 尚未启用，必须等待至少 24 小时 shadow 分布审核后实施；
- `npm run build` 已通过；全量 20 个测试文件、306 项测试通过；`git diff --check` 通过；
- 没有修改生产 Gateway 代码版本、配置、数据库或 Nginx；
- 没有重启服务；
- 没有永久暂停或吊销用户 credential；
- 独立的外部监控预警部署仍保持暂停，避免与本次 Gateway 灰度混合变更。
