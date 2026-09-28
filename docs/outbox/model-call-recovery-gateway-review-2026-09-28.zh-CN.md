# Model Call Recovery：Gateway 评审意见（2026-09-28）

第二轮自审修复：查询/回放与新调用准入已拆为独立限流预算，两个方向的耗尽隔离均有回归测试。migration 37 对 v36 回执一次性回填容量计数，之后通过同事务触发器维护增减；终态保存的执行计划为回执主键查找和容量单行主键查找，没有历史表扫描。完成/中断统一由请求上的 `ModelCallReceipt` 管理，移除了 `WeakMap`、重复排序和重复的大小常量。类型检查及相关 7 个测试文件共 372 项测试通过，涵盖 v35/v36 升级、重开、跨连接容量、删除/过期/回滚和真实连接中断。修复随补充提交交付，尚未上线。

后续修复记录：同日已修复下述三个发现，并补充终态区分、真实 Retry-After、存储故障保护和协议说明，随本次提交交付。下文保留为修复前的评审证据；当前接口语义见 [v1 协议](../coordination/model-call-recovery-v1.zh-CN.md)。尚未上线。

修复后验证：`npm run typecheck` 通过；model-call-recovery、SSE、model-calls SQLite、Gateway index、SQLite index、rate-limit、rate-limit-lease 共 7 个测试文件、367 项测试通过。新增覆盖包括首帧前和流中失败回放、模型频次/并发与回执隔离、语义指纹、凭据轮换/跨用户及 scope 隔离、存储故障、真实 socket 在 DONE 交付前断开、磁盘迁移及重新打开。测试仅使用本地假 Provider 和独立数据库。

结论：认可“稳定调用 ID + 持久回执 + 查询恢复”的方向，保留 `X-MedCode-Call-Id` 和 `GET /gateway/model-calls/:id` 作为 v1 候选接口；当前实现需要修改，不能据此确认已具备可发布的协议保证。

本次评审对象是 `main` 工作区中客户端团队尚未提交的修改，基线 HEAD 为 `7263028ebe3ed4791678321b11c1b41bebf50077`。检查了四个已跟踪文件的修改以及三个新增文件，并阅读 Desktop 实际调用/恢复代码。本次没有修改业务实现，没有提交、推送、部署或访问生产数据。本文是本地评审记录，未向外部团队发送。

## 已确认的问题

### P1：SSE 的明确失败没有持久化，恢复查询错误地返回 unknown

位置：`apps/gateway/src/model-call-recovery.ts:160–195`、`apps/gateway/src/http/sse.ts` 的 `writeSseDone`，以及现有 `apps/gateway/src/http/gateway-errors.ts:37`。

当前只在成功 `[DONE]` 路径保存 SSE 回执。`setupSseResponse()` 已经 hijack Fastify 响应，失败时不会经过普通 `onSend` 保存逻辑：

- 首个数据帧之前失败：`writeOpenAIStreamError` 直接向 raw response 写 JSON 504，没有进入帧捕获，也没有持久化失败结果。
- 已发出部分数据后失败：错误帧会被捕获，但失败路径没有调用 `complete()`。
- 正常结束响应后的 `close` 执行 `finish(undefined)`，最终将记录变成 `unknown`。

真实 `buildGateway` 路由、本地假 Provider 复现结果：

| 场景 | 原始响应 | 查询结果 | 同 ID 再 POST |
| --- | --- | --- | --- |
| 首帧前上游超时 | 504，含 upstream_timeout | unknown，无 response | 409 model_call_pending |
| 部分输出后上游超时 | 200 SSE，含 upstream_timeout 错误帧 | unknown，无 response | 409 model_call_pending |

影响：原错误响应在网络中丢失时，Gateway 明明知道终态，客户端却只能停在“结果待确认”。这正是新增协议要解决的异常路径。

修复要求：在模型执行的成功、明确失败两个终态统一落回执；保留实际 HTTP 状态、内容类型、完整原始响应和必要协议头。状态不能仅依赖 HTTP `<400`：HTTP 200 内的 SSE 错误也应是逻辑 `failed`。不要直接给当前失败路径补一次 `complete()`，因为它硬编码了 200 和 SSE 类型，会错误包装首帧前的 JSON 504。只有确实无法确认的断连/进程中断才进入 `unknown`。

同时修正同 ID POST 的终态反馈：当前 `expired` 和 `unknown` 也都落入 `model_call_pending`；应与查询状态一致，不能把不再运行的记录表述成仍在等待。

### P2：缓存回放仍消耗模型请求限额，也会被模型并发挡住

位置：`apps/gateway/src/index.ts:863–882`。

全局 `rateLimitHook` 先执行，幂等判断随后才执行。真实 credential auth 路由复现：每分钟限额设为 2，首次模型调用 200，同 ID 缓存回放 200，接下来新 ID 请求 429；Provider 实际只调用过一次。

影响：用户恢复结果会挤占新模型请求额度；额度耗尽或模型并发已满时，同 ID POST 在读取缓存之前就会被拒绝。GET 查询已有独立限流，额度耗尽时本次验证仍能成功读取，这是正确的。

修复要求：鉴权后将重复调用判定/缓存回放与新模型执行的频率及并发准入分开；查询与回放仍要有独立流量保护。只给真正的新模型执行扣模型请求次数。对准入前明确拒绝的请求，需要定义可查询的拒绝结果，避免客户端丢失拒绝响应后只能得到 unknown。

### P2：指纹绑定全部 x-medcode-*，把客户端版本变动误判为请求冲突

位置：`apps/gateway/src/model-call-recovery.ts:107–117`。

同用户、同 scope、同 call ID、同模型和正文，仅把 `x-medcode-client-app-version` 从 beta.85 改为 beta.86，即复现 409 `model_call_conflict`。当前做法也绑定了其他观测标识；`JSON.stringify(body)` 还对 JSON 对象属性顺序敏感。

影响限于同 ID POST 的等价请求回放，GET 取回原结果不受此指纹检查影响。不能把它夸大成当前 Desktop 所有恢复都会失败，但作为正式幂等接口，应避免把与执行无关的观测变化当成新的模型输入。

修复要求：使用明确的执行语义头白名单，并对 JSON 对象做确定性规范化，数组顺序保持原样。模型、消息、工具定义、生成参数和影响执行的协议头仍必须绑定。图片 URL 续签涉及正文变化，不能简单忽略；是否以稳定 asset ID 表达同一输入，需要在协议中明确。

## 可保留的设计及责任边界

- 一个 call ID 对应一个逻辑模型步骤，不能复用整个 agent task 的 ID，也不能跨工具续接步骤复用。
- `(subject_id, scope, id)` 主键与 SQLite `INSERT OR IGNORE` 可用作防止同 ID 重复进入执行流程的基础。鉴权不能绕过；同主体的凭据轮换可以恢复自己的记录，跨主体查询不应泄露记录存在性。
- `GET /gateway/model-calls/:id` 是只读恢复操作，不能隐式调用模型或重复扣 token。现有独立查询限流方向正确。
- 完成回执在 `[DONE]` 写出前保存，能覆盖“服务端已经生成完整结果、最后响应丢失”的一部分场景。但当前模型执行仍与连接断开联动取消，这不等于断网后任务会在后台继续完成。
- 进程重启后，旧 owner 的 running 记录降为 unknown 并禁止同 ID 重做，是合理的保守策略；不能承诺所有请求都能恢复完整结果。
- 该机制约束的是一个逻辑 Gateway 调用的重复准入，不是上游只调用一次的保证：Gateway 原有的腾讯/天宽切换和内部重试仍可能产生多个上游 attempt。它也不能保证客户端工具的副作用只执行一次。

建议冻结的状态语义：

| 状态 | Gateway 应保证 | Desktop 应执行 |
| --- | --- | --- |
| running | 当前进程确实仍在执行 | 有预算地轮询，遵守 Retry-After |
| completed | 成功终态，原响应可回放 | 消费原结果，不重发模型调用 |
| failed | 已确认失败，原错误可回放 | 按错误契约及任务预算判断是否允许一个明确的新调用 |
| unknown | 无记录、执行中断或结果不可恢复，必须提供可区分的原因 | 不把它当作“未执行”，不自动换 ID 重发 |
| expired | 结果已过保留期，禁止用原 ID 重执行 | 明确提示无法恢复旧结果 |

Gateway 负责原子准入、终态保存、查询鉴权、回放与模型额度隔离、生命周期清理、可观测性和迁移。Desktop 负责在发出请求前持久化 ID、按逻辑步骤稳定使用 ID、任务 deadline/轮询退避、恢复后的内容及工具消费去重。对于“已确认失败后允许新调用”的场景，双方必须共享重试规则，不能仅因 failureConfirmed 就无条件重试。

当前 Desktop 已实现不确定结果先 GET 查询、404/405 视为 unknown，并阻止自动重发，这个保守方向可以保留。但是旧 Gateway 没有回执就不能补取旧结果，客户端不能展示“保证可恢复”。上线应先使 Gateway 协议可用并验证，再发布依赖它的客户端能力；宜通过能力字段和接受回执显式识别支持情况，不能仅以请求中发送过 call ID 为依据。

## 持久化与协议约束还需写清

当前实现的实际限制为：新 ID 的客户端时间戳最多落后服务端 5 分钟、超前 1 分钟；回执从准入起保留 24 小时，之后留约 7 天墓碑；单条序列化回执最多 8 MiB，全局 response_bytes 合计最多 256 MiB。清理由每分钟任务执行。

这些限制目前未形成双方契约：

- 8 MiB 限制在帧收集与 JSON 序列化后各检查一次，JSON 转义开销可能使正文尚未达到 8 MiB 的结果也无法保存。
- 全局满额或单条超限时，当前静默转为 unknown；需要明确 `reason`、容量指标/告警和可恢复性反馈，不能把容量拒绝混为执行结果未知。
- 严格依赖客户端时钟，意味着机器时钟漂移或请求准备过久会得到 `model_call_expired`；必须公开有效窗口并给出可操作的错误说明。
- `request_id` 应明确区分原模型执行与当前查询/回放请求；日志应能关联 call ID、原 request ID、状态转换及 replay，而不输出原始响应内容。
- 明确模型响应内容的保留和清理范围，包括数据库备份；不要把 24 小时逻辑过期描述成所有备份和磁盘页都立即擦除。
- 查询 429 当前固定 `Retry-After: 2`，没有使用限流器算出的窗口等待时间；分钟/日额度耗尽时应返回真实等待时间，Desktop 也应遵守。

## 验证记录与尚缺覆盖

已完成：

1. `npm run typecheck` 通过。
2. 新增 `apps/gateway/src/model-call-recovery.test.ts`：7/7 通过。
3. `apps/gateway/src/index.test.ts`、`apps/gateway/src/http/sse.test.ts`、`packages/store-sqlite/src/index.test.ts`：339/339 通过。
4. 独立复现脚本验证了上述两种失败丢回执、缓存回放扣频次、版本头导致指纹冲突。
5. 使用独立磁盘 SQLite 文件模拟 schema 35 → 36：升级后旧 subject 保留，migration 36 只登记一次；关闭并重新打开数据库后成功回执仍存在。

第 5 项使用合成数据，不是生产库迁移演练。新表追加且不修改旧业务数据，基础迁移方向可接受；部署时仍需要按现有流程用备份演练和确认旧版本回退后的协议兼容性。

复现脚本和结果位于仓库外：

- `C:/work/review-artifacts/gateway-model-call-recovery-20260928/review.mjs`
- `C:/work/review-artifacts/gateway-model-call-recovery-20260928/results.json`

脚本仅使用本地编译产物、假 Provider、合成凭据和独立 SQLite，不访问上游或生产数据库。执行前在仓库运行 `npm run typecheck`，随后运行 `node C:/work/review-artifacts/gateway-model-call-recovery-20260928/review.mjs`。它输出行为证据，不是断言所有契约要求已经满足的验收测试。

正式验收还需覆盖：真实 socket 断开前后与 DONE 落库顺序、SSE 明确失败回放、进程退出后的文件恢复、存储写入失败/容量耗尽、同 ID 并发及不同主体/scope 隔离、凭据轮换、回放不再扣模型额度、客户端恢复后工具不重复执行，以及新旧客户端/Gateway 的组合兼容性。应先修复并加入针对性回归，再冻结 v1 文档和安排发布。
