# 长推理断流：调查、实现及本地验证

2026-10-28。本次仅修改 Gateway 开发工作区和本地测试；没有部署、重启、修改生产配置或数据、发送外部消息，也没有修改 Desktop 工作区。代码尚未提交。

## 现网复核与归因边界

- 北京时间 15:09:58 初次只读采样，15:20:51 再次采样。生产 current 为 `1efc613f32bbd2a2068d18e1f7cc0639a44a7d03`，Gateway healthy，重启 0、OOM=false；公网 ready、draining=false。
- `git ls-remote` 核实远端 main 与本地 HEAD 均为 `8a91359af8bdb9f51291143bdaf320ba93f93319`；生产提交是 main 的祖先。两者 Gateway/core 源码无差异。开发仍是唯一 main / 唯一 worktree，原有其他任务修改保留；未暂存、提交或推送。
- 失败 `req-3016b0a3-0b1b-46cb-843d-e7b191c388f2` 持续 881.494 秒。上游 HTTP 200、首字节 2.008 秒，最后字节 880.352 秒，6,195,453 字节 SSE、192,222 个推理字符，无正文、工具、正常终态或 usage；`network / connection_reset / streaming`。预留已在 06:52:39.950 UTC 结算，来源 estimate，84,860 token。
- 前一请求 814.250 秒成功并交付正文和一次工具调用。约 28 分 17 秒是两次模型调用累计，不是一个 Shell 执行时间。恢复只重做当前失败的模型请求，不重放整个回合或已交付工具。
- 故障后短调用 11.996、23.802、13.021、26.884 秒成功；最新 `req-45205599-2c9c-44c1-b50a-d9989399fc1f` 从 15:08:15 开始、503.527 秒成功。不能据此宣称长推理稳定性恢复。
- 不能确认谁关闭连接，不能归因为 idle timeout 或固定 15 分钟上限。已证实的 Gateway 问题是：streaming 断流不恢复，而且旧判断将包含推理的 semanticOutputChars 当作阻止恢复的输出。

证据位于本地 `.task-artifacts/long-reasoning-evidence-20261028.json` 和 `long-reasoning-evidence-latest-20261028.json`。读取现有 request_events 与 token_reservations 使用 SQLite `mode=ro`、`query_only=ON`；配置只输出明确列出的非秘密超时设置，不输出凭据或用户会话正文。

## 实际时限、读取与交付

生产 `MEDCODE_CHAT_REQUEST_TIMEOUT_MS=600000`，模型覆盖 `goldencode=900000`；TokenSwitch、腾讯、天宽适配器的独立超时都是 900000。`x-medcode-request-timeout-ms` 可进一步缩短实际总预算。Gateway 在原请求创建一次 deadline，内部尝试共享它，不能因为换通道重新获得 900 秒。

兼容适配器逐块读取 SSE；reasoning 只增加计数和阶段，不向客户端泄露推理正文。`parseOpenAISse` 的 finally 取消 reader 并释放锁；适配器 finally 清理上游定时器及 abort 监听。原生工具路径 `collectProviderMessage` 收集正文/工具，待完整结束和校验通过后才写客户端。工具增量在适配器缓冲，只有完成后才成为完整 tool_call。

因此必须区分：

1. **上游生成**：reasoningChars、visibleOutputChars、observedToolCallCount、toolArgumentBytes；原始字节/心跳不是正文。
2. **Gateway 缓冲**：contentChars、toolCallCount；未交付的内容也采取保守保护，不丢弃重试。
3. **客户端交付**：路由持有 outputCommitted（含初始输出、关闭状态）。这些计数不能单独证明客户端执行过工具。

现有 SSE 心跳保持连接；progress 的模型活动可持续更新，但不延长 deadline。原错误没有命中 Gateway 总时限。

## 实现与阈值依据

`native-tool-failover.ts` 保持既有两次实际调用的 NativeCallBudget，初次、格式修复与换通道共同消费。新增规则仅由缓冲的原生工具恢复路径启用；无工具的直接流路径不借此放开重试。

- 已收到推理但没有正文、完整或部分工具，HTTP 200、未完成、无 finish_reason，发生 connection_reset 或 EOF-before-terminal 时，允许换到现有路由选出的备用成员一次。
- 必须有解析器的正面证据、未向客户端交付、未取消、有限原 deadline 且剩余至少 60 秒。调用数耗尽、不满足证据、无备用容量、余额/准入失败则返回原失败；客户端 automatic_retry_allowed 仍为 false。
- 在调用备用前再检查交付、取消与剩余时间。所有尝试保留同一输入/已完成工具结果、reasoning effort、显式输出上限、原 deadline、回执及预留；不新增重试层，不调用客户端工具。
- 旧流退出、清理完成后才释放旧 lease 并选择备用。最终 lease 仍由现有 route finally 释放；原 active request、收据和预留按原流程终结。备用失败不会尝试第三个通道。

新增 `native-output-budget.ts` 是独立的**首次正文/工具增量等待预算**。仅适用于已启用原生 failover、goldencode、无图片、首次实际尝试、存在备用选择能力且当前剩余总预算至少 896 秒的请求。从该尝试开始计 835 秒；正文/工具生成或校验开始后清除该计时器，推理和心跳不重置它。到期只 abort 当前尝试，不 abort 或重建原总 deadline。原请求 900 秒时名义留下 65 秒；清理后不足 60 秒即不再发出备用。短预算、禁用 failover、其他模型、第二次尝试不启动此提前截止。

72 小时样本（2026-10-25 15:09:58 至 10-28 15:09:58，北京时间）：

| 通道 | 成功数 | 总耗时 P95 | 总耗时 P99 | 最大成功耗时 | 超过 600 秒成功数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| TokenSwitch | 1546 | 56.078s | 165.105s | 814.250s | 1 |
| 腾讯 | 284 | 203.461s | 516.696s | 810.040s | 3 |
| 天宽 | 919 | 129.104s | 225.231s | 614.748s | 1 |

这些是请求总耗时，**不是首次正文时间分布**。835 秒保留已观察到的 814/810 秒成功任务，并给 900 秒请求留出恢复机会；60 秒覆盖故障后的 12–27 秒短成功样本，但低于腾讯/天宽的 P95，不能视为复杂请求成功保证。阈值是保守初始策略，不是最优值的统计证明。

没有采用 180/300/600 秒全局硬截断：已有多次超过 600 秒的成功工具请求，缺少首次正文时刻分布和复杂任务备用耗时证据。此补丁**不承诺消除所有十几分钟等待**，主要避免直到 881 秒断流才发现没有恢复时间。若后续要将等待降到几分钟，应先补充按模型/推理档位/输入规模分组的首次正文时刻和备用成功率样本，再设置明确的延迟偏好策略；不能暗中降低 High 或 Max。

## 用量、错误与可观测性

首尝试推理断流通常没有实报 usage。旧通用求和会忽略 null，只留下备用的实报用量。新路径保留逐次实报和未知项；只要存在生成过推理但缺 usage 的尝试，请求总 usage 保持未知，不能伪称备用用量是完整总量。结算仍走原预留的 missingUsageCharge 策略（生产样本为 estimate），不创建新的豁免或第二份预留。它是请求级估算，不是从推理字符准确还原两次消耗；配置为 none 的计划仍按其既有策略处理未知用量。全部尝试有实报时沿用既有合计。

主动首次输出截止仍返回/记录 upstream_timeout，附 `gateway / deadline_exceeded` 和 `GATEWAY_NO_DELIVERABLE_OUTPUT` 标识，不把它归因为上游网络故障，也不计入供应商 service_error 健康评分/冷却。普通 socket reset 保留原 network 分类及原有暂态健康策略；不永久禁用任何通道，不把不完整 SSE 当成功。尝试历史保留失败和最终成功/失败，成功总记录清除终态失败。恢复日志增加 recovery_kind、calls_used、remaining_ms 和未恢复原因（预算耗尽、已交付、时间不足、无有限时限、选择后不足等）。不记录推理正文。

## 客户端可利用的现有契约与验收

无需更改 Gateway progress 协议；见[现有 v1 契约](../coordination/model-call-progress-v1.zh-CN.md)。`GET /gateway/model-calls/:id` 在 running 时已有 phase、started_at、deadline_at、last_model_activity_at、elapsed_ms、attempt_index；恢复时先报告 retrying，再随真实新尝试变为 waiting_upstream、attempt_index=2。始终不重置 started_at/deadline_at/elapsed_ms。现有收据测试验证终态/停止后清除进度和旧请求不可重放。

此次未查看或修改另一个工作区，不能确认 beta.116 已按这些字段展示。Desktop 可按以下具体行为接入：

- 以原 call ID 查询，约 30 秒一次、带抖动、一个在途查询，尊重 Retry-After。阶段显示“等待模型响应 / 模型推理中，尚无结果 / 正在接收结果 / 校验结果 / 正在切换或修复”。进度不作为工具正在执行的证据。
- 展示当前模型调用耗时与尝试序号，另列整个任务累计耗时；不将两次调用的 28 分钟标成一个 Shell 的执行时间。
- 剩余预算按 `deadline_at - started_at - elapsed_ms` 加本地后续经过时间估算；推理活动、查询或内部切换不能续期。近期模型活动只说明收到增量，不说明已经有可交付结果。
- 用户停止时 abort 原请求并停止轮询及后续工具执行，忽略旧查询响应。终态优先，未知字段/缺 progress 降级普通等待。
- 失败仍尊重 automatic_retry_allowed=false；优先 GET 恢复原回执，不重新 POST 整个回合。已交付工具按原 call/tool ID 去重，不重复执行。

客户端验收：模拟持续推理，观察 elapsed 增长但没有 Shell 状态；注入首尝试断流，观察同一 call ID 下 attempt 1→2、预算不变；备用成功仅消费一次工具结果；用户停止后旧查询不能恢复 UI 或触发工具；备用失败出现一次失败，按钮人工重试不能自动重放先前工具；重连 GET / 同 ID 重放不新增模型调用或扣费。已有 progress 缺失、unknown、expired、终态无 progress、查询限流都须兼容。本文件仅本地交付，没有发送给客户端团队。

## 本地验证与自审

新增可控 ReadableStream SSE + 虚拟时钟测试覆盖：纯推理 reset/EOF、正文缓冲、部分工具、正文/工具交付锁、持续推理 835 秒截止、用户取消及临界竞态、60 秒不足、备用无容量/失败、原总时限到达、选择备用后交付/预算变化、814 秒推理成功、880 秒正文生成成功、590 秒短预算、禁用策略及其他模型。断言旧信号清理、无第三次调用、lease 释放、无遗留定时器、High/64000 保持、进度尝试数和未知用量。

另外使用真实本地 HTTP SSE server 断开 socket / 提前 EOF，覆盖 Chat Completions 和 Responses、流式及非流式 8 个组合，验证仅备用工具成功交付、两次 attempt、未知首尝试 usage、生产式 estimate 结算一次、无空响应豁免、同 call ID 重放不新增调用/预留。

自审重点：恢复只在缓冲路径显式启用；禁止部分工具重试；输出预算不重建总时限；模型参数保持；已交付回合不重放；失败流非成功；缺 usage 不冒充完整实报；首尝试 abort 完成后才能切换；最终资源归原 route finally；旧空响应、修复、视觉恢复行为保留。

最终验证：`npm run typecheck` 通过；相关 8 个文件 182 项测试通过；`npm test -- --reporter=dot` 全量 **2166 通过、4 跳过**（111 个文件通过、2 个文件跳过，117.51 秒）；末轮自审增加“主动首次输出截止不计入供应商健康失败”保护后，再次类型检查及两份直接相关测试 **46 项通过**；`git diff --check` 通过。全量日志在 `.task-artifacts/long-reasoning-full-tests-20261028.log`。仅使用本地模拟上游，没有发起真实付费模型测试；没有执行生产发布验证。

## 第二轮代码自审（2026-10-28）

用户要求重新自审后，先增加可复现测试，再修复以下三个问题。修复前有 7 项新增用例失败，证据为 `.task-artifacts/long-reasoning-review-repro.log`。

1. **P1，终态原因检查被预算分支绕过。** 已收到 `finish_reason=length/content_filter/stop` 但未收到 DONE、连接仍挂起时，首次输出截止分支位于 finishReason 检查之前，会错误地再发模型调用。现在将 finishReason 检查放到所有新恢复分支之前，三种场景均保持失败、只调用一次。不会把截断/过滤结果当作可恢复的纯推理断流。
2. **P2，内部截止混入请求取消及错误来源。** 适配器归一化丢失内部截止标识，旧观测逻辑把局部 abort 写入整次请求的 cancelObserved；备用成功也会遗留该标志。现在保留 Gateway 生成的 abort 标识，同时使用适配器观察到的真实 stage/HTTP status；未收到 headers 时不再伪写 streaming。局部截止不标记整次取消，若因此终结，terminalSource/超时诊断明确为 gateway_output_budget；管理员界面显示“Gateway 首次结果等待预算”。父请求主动取消或总时限仍优先。
3. **P1，格式修复合并后的未知用量被遗漏。** 两次格式修复尝试先在内层合并，顶层 usage 已包含某一次已知数值，且顶层不保留 streamProgress；仅检查顶层无法发现另一尝试的推理 usage 缺失。现在同时检查逐次 attempt，任一次生成过推理且 usage 未知时保持总量未知；两次均实报才相加。新增首尝试缺失、第二次缺失、全部已知三个场景，后者仍正确合计 24 token，不发生第三次调用。

修复后类型检查和直接相关 5 个文件 **125 项测试通过**，包括等待 headers 到首次结果预算截止、局部截止后成功/无备用、真实请求取消与原时限等边界。835 秒初始阈值与 60 秒恢复窗口未更改；它们仍是基于有限样本的保守策略，不是线上长任务成功保证。此轮仍仅修改本地 main，没有操作生产或其他工作区。

此轮最终全量回归：**2176 项通过、4 项跳过**，111 个文件通过、2 个文件跳过，耗时 130.10 秒；日志 `.task-artifacts/long-reasoning-review-full-tests-20261028.log`。`git diff --check` 通过，未暂存或提交。未发现仍待修复的明确阻断问题；真实上游长推理稳定性和更短等待阈值的效果仍不在本地模拟测试的证明范围内。
