# Gateway 生命周期、图片与诊断预算修复（2026-09-29）

状态：实现和本地测试完成；生产部署以发布回执为准。依据 [深入调查](../operations/gateway-priority-investigation-2026-09-29.zh-CN.md)。没有修改生产额度、历史用量、供应商或客户端代码。

## 预留与结算

- Gateway 为实际执行中的 Token 预留持有租约，每分钟续期；准入、清理和用量查询也会续期，避免清理路径先于心跳处理超时请求。HTTP 断连不释放此租约，执行结束后的结算 finally 才释放。
- 进程消失后不再续期，预留仍可过期回收。当前方案服务于单活 Gateway，不声明具备多实例执行所有权协调。
- migration **38** 增加 `token_settlements`。过期清理的结算保存原始用量、时间以及精确的各窗口记账分配；迟到的真实用量在一个事务中撤销原分配并重新结算，保留更正记录。再次提交用量不重复更正。
- 删除额度窗口会使相关待更正记录失效，防止迟到用量恢复管理员已重置的额度；窗口数据不符合撤销条件时事务回滚，需人工对账。
- 旧版本历史估算没有精确分配快照，本次不会自动更正。此前发现的三笔线上记录仍需单独核对。

## 发布生命周期

- 独立跟踪 HTTP 请求和 handler 后台工作；连接已断开、Token 预留已结算均不代表后台工作完成。
- SIGUSR2 开始 drain，新业务请求返回 503 和 Retry-After；健康检查返回 draining/503，模型回执 GET 仍可查询。SIGCONT 在未开始关闭时恢复准入。
- SIGTERM/SIGINT 开始 drain，等待真实工作结束，再调用 `app.close()`；最长等待 600 秒，超时记录仍在途计数并以失败退出。
- 主 Dockerfile 和 R760 packages overlay 的 CMD 均直接运行 Node，Compose 停止宽限为 610 秒。需要在候选镜像核对运行命令及实际 stop timeout，不能假定外部 overlay 不会覆盖或继承旧的 npm 入口。
- `scripts/ops/gateway-drain.py` 在宿主机执行：先验证运行服务支持生命周期协议及直接 Node 入口，再发送信号和等待两个计数归零。成功后保持关闭准入，取消发布可使用 `--resume`。脚本本身不部署。
- 原 20260923 cutover 脚本的 SQL 预留轮询已移除，改为强制调用上述 drain。硬编码 schema 35 改为必填的已演练目标 schema 参数，并在切换前阻止 schema 倒退；本次候选为 38。调用形式为 `python3 - <完整提交> <已验证目标schema> < cutover脚本`。环境变量变化仍有原有白名单检查，发布准备必须核对它与候选配置相符。
- cutover 将排空纳入现有异常处理：排空失败或被中断、尚未修改发布配置时，对原容器 ID 执行 `--resume --timeout 30` 并确认恢复接入；恢复无法验证则明确报错。已经开始修改发布配置的失败仍走原有发布回滚路径。

首次升级的旧线上服务没有 drain 协议，工具会在发信号前拒绝执行。第一次发布需要在部署方案中明确维护入口控制，不能回退到“查预留为零就重建”。后续支持 drain 的版本按关闭准入 → 等待真实工作归零 → 停旧进程 → 启动并验证新进程执行。单实例仍有短维护窗口，不承诺零拒绝；没有开启多副本或模型 POST 自动重放。

## 图片操作

- complete、read-url、delete 都有覆盖整个操作的期限，并传递调用方取消信号；GET 响应体停滞会被取消，不再仅保护响应头。
- 期限沿用 `MEDCODE_VISION_R2_REQUEST_TIMEOUT_MS`，默认 30 秒。它现在限制完整操作；长图/慢链路应在灰度自测中验证。持续无进度同样被总期限约束，没有额外引入一套空闲超时参数。
- complete/delete 用已有的工作租约保护并发名额；依赖未结束时不会因客户端断开提前释放。
- `vision_upload` 与模型桶分开，complete 默认每主体 4、进程总计 4 并发。配置为 `GATEWAY_VISION_COMPLETE_CONCURRENT_REQUESTS`、`GATEWAY_VISION_COMPLETE_GLOBAL_CONCURRENT_REQUESTS`。这是保守保护值，保留已观测到的单凭证 4 并发能力，并非 R2 压测结论。
- `vision_control` 承载 create/capabilities/delete，每主体 4、进程 16 并发；两个新增池分别为每主体 60/min，无日额度。read-url 保持既有独立策略。
- 同资产并发校验合并尚未加入；本次先通过有界资源保护及正确取消解决生命周期问题。合并需要独立等待者取消语义，不是解决此次缺陷的前置条件。

## 诊断 v1 兼容修复

- 保留单事件 v1 端点和既有请求体上限。HTTP 分钟限流移至鉴权后、请求体解析前；每凭证 4 个入站并发，响应或断连释放。不再把 HTTP 日计数当作唯一事件保存预算。
- SQLite 按服务端 received_at 的 UTC 日界、subject 和事件类别统计保存预算，检查与插入在同一事务中执行；重启、轮换凭证不能清空，重复事件仍走原有去重及冲突检查，不占新的保存预算。
- 普通事件和服务端识别的终态事件分别最多保存 `GATEWAY_CLIENT_EVENTS_RPD` 条（现有默认各 2,000）。终态类别包括 agent_turn 的 turn/step_finish 终结状态，provider_stream/tool 的 request/execution 错误、超时、取消，以及客户端实际发送的 provider_stream/transport_attempt 错误、超时、取消。使用同一个 SQL 判定表达式分类新事件并统计已保存事件；没有接受客户端任意 priority 标记。错误真实性不能由 Gateway 独立证明，因此终态桶同样有界。
- 普通预算耗尽返回 HTTP 200，明确 `stored:false, dropped:true, reason:daily_diagnostic_budget`，而非声称已经落库。这让收到任何 429 就暂停整个队列的 v1 客户端能继续发送后续终态。正常新写入返回 201/stored:true；已有事件返回 200/duplicate:true。
- 终态预算耗尽返回 429 到 UTC 日界；HTTP 分钟/并发超限仍返回 429。预算响应带 `x-diagnostic-budget-lane/reset/remaining`；耗尽会输出已有的有抑制间隔的告警。
- 查验过本地 Desktop `diagnostic-upload.ts`：使用 `res.ok` 处理成功、429/503 对整个凭证暂停。本次未运行或发布真实 Desktop；旧客户端的 uploaded 计数仍会包含服务端明确丢弃的事件，客户端应识别 stored/dropped 字段并改正统计。
- 本次不增加 batch 端点；批量协议与客户端采样可后续单独演进，不作为消除当前日预算整队停传问题的前提。

## 验证

新增边界测试覆盖：长请求租约、孤儿回收、迟到用量的幂等更正、Free/付费及组合窗口、重置保护、断连后的排空及名额保持、图片响应体停滞和取消、跨用户图片总并发、诊断跨重启/换 Key/日界、重复事件、普通预算耗尽后的终态保存。

验证结果：

- `npm run build` 通过。
- `npm test -- --maxWorkers=2`：94 个文件通过、2 个跳过；1,701 项通过、4 项跳过。
- 最后补充 provider setup 抛错时的租约清理兜底，并简化 R2 期限为一个完整操作计时器后，重新构建并运行相关 6 个文件，46 项全部通过。
- `python scripts/ops/gateway-drain.test.py`：3 项通过；两个运维脚本语法检查通过。
- `git diff --check` 通过。首轮默认并行测试有一个 CLI 测试超过 5 秒；降低并行度后通过，没有放宽测试时限。

未执行生产故障注入、真实 R2 压测或线上迁移。

自审修复后验证：重新构建通过；Gateway 主路由及诊断预算两个测试文件共 299 项通过；排空脚本 3 项、切换脚本新增 4 项测试通过。新增用例覆盖普通额度耗尽后的 transport_attempt 三种失败状态落库、重复事件和终态预算上限，以及排空失败／中断后恢复原实例、恢复失败报告、切换失败仍使用发布回滚。Python 语法检查及 `git diff --check` 通过。
