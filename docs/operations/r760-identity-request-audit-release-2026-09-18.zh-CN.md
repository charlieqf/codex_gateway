# R760 身份请求审计上线与验收记录

日期：2026-09-18。运行版本：`71689e3012e7a5092bca09ca59bdd31f4f0a1b68`。

状态：已实施、自审、测试并部署；公网验收和三个消费者只读检查通过。本文记录实际证据与能力边界，不把短时压测当作长期容量保证。

对应[实施方案](../implementation/gateway-identity-request-audit-plan-2026-09-18.zh-CN.md)和[运维查询说明](./identity-request-audit.zh-CN.md)。

## 1. 发布范围与运行状态

- 唯一开发工作区及分支仍为 `C:\work\code\codex-gateway` / `main`。发布前 fetch，`main` 与 `origin/main` 一致。
- 发布提交 `71689e3` 包含新出口、两个新表、三个消费者切换和旧接口删除，没有发布双写中间态。
- 原生产版本 `1a37c0c`，原 schema 33；新程序启动于 **08:35:57 UTC / 北京时间 16:35:57**，08:36:03 UTC 确认健康，schema 34 生效。
- `current` 指向 `71689e3`；`previous` 指向 `1a37c0c`。Gateway 镜像 ID：`sha256:253874547b371fdaa886881371c28282a22edd2d407168d055bedcaecb478842`。
- 仅重建 Gateway；Research Worker、Research LLM Gateway、Research maintenance、Mihomo、Qwen 五个容器 ID 未变且健康。Gateway 重启计数为 0。
- 配置变更仅为共享 Compose override 的 Gateway image；环境变量、公开端口、稳定加密/恢复密钥保持原值，备份及文件权限已检查。
- 未包含工作区中的 MedEvidence 运行态 Key 校验、零售套餐、额度重置、Research 或消息查询等无关改动；这些文件仍保留在用户工作区。

第一次切换尝试因仍有模型请求而在停服前退出；随后只读等待至空闲，再执行原受控切换检查。没有为部署强行终结用户请求。

## 2. 已完成的职责替换

| 职责 | 实际实现 |
| --- | --- |
| HTTP 最终结果 | `http/identity-request-audit.ts`，19 个显式 operation；onRequest 早于门禁初始化，onResponse/断连共用一次性终结 |
| 普通请求 | `identity_request_events`，request ID 唯一，固定字段和部分索引；不存 body/response JSON |
| 登录限流 | 三个拒绝分支均调用既有 `markRateLimitRejection`；公开码仍为 `auth_rate_limited`，出口同步 UPSERT 分钟计数 |
| 内部归因 | 输入手机号与已确认手机号分开；请求指定 Subject 与实际/冲突 Subject 分开；GatewayError 诊断事实不可枚举，不扩展公开响应 |
| 事务安全 | Store 内 `recordAudit`、登记事务、刷新轮换/重放/撤销、补偿及任务记录保留 |
| 告警 | Phone 5xx、Billing 鉴权存储异常、孤儿与人工开户补偿等 Pino 日志保留；新增审计写入/清理告警，不替代业务告警 |
| 消费者 | 账户导出、手机号冲突巡检、登录就绪巡检改读 HTTP 结果；旧安全记录单独标为 legacy；429 使用 SUM 计数 |
| 私有查询 | 有界时间、分页和定向条件；默认脱敏，完整手机号仅允许定向输出；SQLite read-only + query_only |

清理检索确认 PhoneAuthService 的 `recordSuccess`、`auditFailure`、`recordLoginRateLimit` 和公开 `recordPhoneAuthAudit` 门面已删除。模型运行器另有同名 `recordSuccess`，不属于本次删除范围。没有改写 migration 31–33、手机号归属条件、人工开户状态机或补偿/释放条件。

## 3. 固定提交构建、自审与测试

不可变产物由 `git archive 71689e3` 生成，不使用脏工作区：7,300,504 字节，SHA-256：

`c64ac83cc8fa4a74f36e9456d9286772827861b830dadf8630e070e1845d6fae`

固定提交的 Linux 构建执行 `npm ci --include=dev`、`npm run build`、`npm test -- --maxWorkers=4` 和 `node scripts/ops/free-paid-quota-smoke.mjs`：

- 75 个测试文件通过、1 个跳过；**1477 项通过、3 项跳过**。跳过的是依赖外部私有样本的既有 long-task regression，不是本次审计用例。
- 编译后 Chat/Responses 流式及非流式四条用量路径通过；总用量 80,000，Free 10,000，付费 70,000，账单读取/重放通过。
- 本地 typecheck、聚焦回归及 Python 账户导出 4 项测试通过。
- 对最终提交的不可变导出运行既有秘密扫描，基线 `1a37c0c`，通过；新增文件均已纳入受检差异。

主要验收证据对应关系：

| 方案要求 | 可复核证据 |
| --- | --- |
| 成功生命周期、401/403/426、JSON 错误及提前拒绝 | `identity-request-audit.test.ts`、`phone-auth-routes.test.ts`；公网登录/刷新/退出/门禁 |
| 既有账号与各身份冲突的准确归因 | 新出口集成测试；Billing identity coordination 回归；公网两类 409 和 GET 恢复 |
| 三维 429、重试头、permit、跨分钟/固定基数 | 出口参数化测试、Store 聚合测试、正常与混合压测；公网 phone 维度两次 429 |
| 成功轮换但最终刷新失败、撤销与回滚 | 新出口的 failed-refresh、transactional-enrollment 故障注入及既有 Phone Store 测试 |
| 普通审计故障不改响应、安全审计仍 fail-closed | 出口写入故障和 429 写入故障测试；事务内审计触发器故障仍回滚 |
| 202 与后台任务状态分开、断连不伪造 499 | 出口集成测试包含实际关闭 HTTP socket；公网任务受理/终态/拒绝恢复 |
| 5xx/补偿告警保留 | Phone 5xx 日志断言；Billing 补偿测试验证 `issuance_compensation_pending`，孤儿禁用故障/重试路径保留 |
| 字段白名单、不可枚举异常、凭据隔离 | 出口/Store/序列化测试、秘密扫描；公网用真实生成的测试凭据检查审计不含凭据 |
| 新旧消费者、分页、脱敏及只读 | `tests/identity-request-query.test.mjs`、Python 导出测试；部署后实际执行三个消费者 |
| migration 与旧程序兼容 | 迁移测试、最新生产备份演练及下节旧镜像试验 |

上线前自审发现并修正了测试/发布辅助脚本的两个问题：等待请求的退出边界、SQLite WAL 备份转为独立离线副本的处理；未降低业务持久化配置。早期压测还修正了共享刷新会话造成的排队失真，以及跨分钟限流样本不稳定的问题。最终性能结果使用 32 个独立会话和确定的限流时间窗。

## 4. 迁移、备份与回滚

受保护备份目录：

`/opt/codex-gateway-r760/backups/phone-signup-71689e3012e7/`

目录名沿用已有受控工具的命名，不表示本次改动了短信开户合同。备份覆盖 Gateway/client-events/Research 三个数据库、配置和稳定恢复密钥；校验摘要及权限，不打印内容。Gateway 停止后另取 `gateway-pre-cutover.db` 一致快照，不自动恢复整库。

最新 schema 33 副本重复启动迁移两次，原有 **23 张业务表全部字段/行指纹一致**，仅增加两张空表和 migration 34 记录；完整性正常、外键错误为 0。

保留新表的离线 schema 34 数据库已用旧生产镜像 `1a37c0c` 打开：Store 打开前后 26 张表不变；旧 Gateway 启动健康响应 200，除正常的 `upstream_accounts.updated_at` 刷新外，另外 25 张表不变，上游配置其他字段不变。该演练只挂载离线副本，未写生产数据库。

因此回滚方式为：按同一受控配置/健康验证流程回退 **程序到 `1a37c0c`**，保留 schema 34 和审计数据。不得恢复旧整库覆盖切换后产生的账本。回滚期间 HTTP 新审计覆盖会停止，应标注缺口；不能把旧安全事件当作补齐记录。

部署后再次核对切换前的控制记录：1026 个 Subject、1036 条访问凭据、536 条统一 Key、16 个 Plan、762 条权益、318 条 Phone identity，全部原行未改变。三个生产数据库均 `quick_check=ok`、外键错误为 0。

## 5. 性能与留存容量

压测使用与生产相同磁盘的独立测试目录、真实 Gateway HTTP/PhoneAuthService/SQLite，1026 个合成 Subject、32 个独立会话；上游模型为 stub，不向真实用户或供应商施压。每个窗口 20 秒，正常场景三组开/关配对。

测量用的构建树 `54bd086` 与最终 `71689e3` 的应用/包生产源码相同；该范围内差异只有新增的出口测试。性能没有通过关闭业务同步写入、采样失败请求或引入异步队列达标。

| 指标 | 关闭新审计 | 开启新审计 |
| --- | --- | --- |
| 正常认证 100 RPS，三轮 p95 中位数 | 11.962 ms | 12.346 ms |
| 正常认证事件循环 p95（三轮范围） | 14.74–14.91 ms | 14.31–14.78 ms |
| 正常窗口进程 CPU 时间（三轮范围） | 19.17–19.37 s | 18.85–19.13 s |
| 混合场景认证 p95 | 29.57 ms | 168.49 ms |
| 混合场景模型 stub p95 | 30.12 ms | 170.69 ms |
| 混合场景拒绝请求 p95 / p99 | 27.94 / 50.58 ms | 1766.97 / 6714.41 ms |
| 混合场景事件循环 p95 | 18.87 ms | 59.90 ms |
| 混合场景进程 CPU 时间 | 26.30 s | 23.60 s |

正常认证额外 **0.385 ms / 3.21%**，通过不超过 5 ms 且不超过 10% 的门槛；没有新增 SQLite busy/锁超时或非预期 HTTP 错误。

混合窗口额外施加 20 model RPS 和 500 rejection RPS；400/401/403/429 各 2500 次，全部得到预期状态。审计准确增加 9500 条明细及 2500 次限流计数（1 个桶），没有丢失。开启时审计写入 p95 0.483 ms、写入累计 2.23 s；WAL 文件约 4.17 MB 并复用，数据库 6.82 MB。

**混合攻击流量明显增加尾延迟**，这不是“无性能影响”或持续承载 500 RPS 攻击的保证。CPU 结果包含同进程压测客户端，WAL 文件大小也不等于累计磁盘写入字节。真实公网/模型供应商延迟不在这个基准内。

留存初值为明细 30 天、分钟表 7 天；每分钟最多清理每表 500 行，不在请求路径清理、不自动 VACUUM。最终镜像的磁盘演练清理 10000 条过期明细及 1000 个过期桶，20 次调用后积压为 0，保留 50 条新数据；批次 p95 3.28 ms，临时数据库已移除。

现有清理上限为每表每天 **720000 行，约 8.33 条过期明细/秒**；分钟表最多 3 桶/分钟，低于清理能力。明细若长期超过此增长速率，30 天实际留存会拖长，需复审清理容量；不能用本次短时 100 RPS 基准推导长期留存已获保证。08:39 UTC 实库无过期积压。巡检必须关注最旧记录、过期数量、磁盘及 Pino 清理告警。

## 6. 公网与消费者验收

完整第二轮：**35 次 HTTP 检查通过**，其中 28 条普通身份请求逐条核验、2 次限流进入分钟聚合，5 条健康/模型/凭据相关请求不属于本次身份明细范围。

- 人工开户完成 6 步，快照加密、手机号规范化；两个确定性重复开户任务均进入 failed，恢复请求明确拒绝，未再调用上游开户。
- 已有账号创建返回 `subject_already_exists`，审计 reason 为 `existing_subject`；GET 按 provider/external ID 取回同一 Subject。另一外部身份占用同手机号返回 `identity_conflict`，reason 为 `external_identity_binding_conflict`。未修改公开错误合同。
- 登录、bootstrap、current、刷新轮换、logout 均通过；401/426 按实际状态记录，提前版本拒绝的手机号保持不可用。
- `1.9.116` 被拒，最低版本及平台中立下载页不变。
- 私有 request ID 查询能取得当时完整手机号，默认查询脱敏；审计无测试 Key/access token/refresh token。
- GoldenCode 实际调用 HTTP 200，135 tokens 已结算。
- 测试 phone 的两次 429 对应全局计数增加 2；不把分钟首尾样本解释为该用户全部限流历史。

第一轮曾因**验收脚本**把 HTTP 200 任务查询中的 `job.error` 当成 HTTP 错误而停止；运行代码未变。修正断言后完整重跑通过，原失败报告保留。这个区别正是本方案要求的“请求结果不等于任务结果”。

两轮共创建两个合成账号，均通过管理 API 在本地和上游停用；活动凭据、Key、Session、未结算 reservation 均为 0。五个任务均已终结（2 succeeded、3 failed）；审计及账本保留，不删除历史。不使用真实用户账号作测试。

三个消费者实际只读执行通过：账户导出分析 1028 个账号，HTTP/legacy 来源分开；冲突巡检重复手机号组为 0；就绪巡检 **300/300 个活动身份通过身份与运行态检查**，未执行可能写状态的权益评估。两个统计消费者均得到 2 次聚合限流；验证不落盘完整用户导出。

## 7. 覆盖边界与复核入口

新表最早记录为 `2026-09-18T08:36:50.161Z`；新程序启动与最早记录之间没有据此承诺请求零缺失。旧历史不回填。后来由身份团队提供响应体的历史 409，应引用其原日志，不冒充新审计回溯所得。

截至 08:39 UTC，新增审计写入失败、清理失败、恢复缺口及 Pino error/fatal 均为 0。告警仍沿用现有 Pino 运维采集；本次没有新建通知服务或指定新的告警责任人。

授权运维可复核以下受保护证据，不对外复制原始数据库/密钥/完整手机号：

- 发布目录：`/opt/codex-gateway-r760/releases/71689e3012e7a5092bca09ca59bdd31f4f0a1b68/`
- 上述备份目录内：`deployment.json`、`build.log`、`migration-smoke.json`、`final-audit.json`、`public-smoke.json`（首轮断言失败）、`public-smoke-v2.json`（完整通过）、`identity-final-probe.json`。
- staging 同 revision 目录：受控 `operate.py`、两版公网验收脚本、`retention-result.json`。
- 压测：`/opt/codex-gateway-r760/staging/identity-audit-54bd086-bind-benchmark.log`。
- 旧镜像兼容演练副本：`/opt/codex-gateway-r760/backups/identity-audit-preflight-20260918T075120Z/`。

已验证内容不包括：外部短信系统的验证码成功率、身份后端是否正确执行每次 409 查询恢复、无限攻击容量或进程崩溃时审计零丢失。Gateway 出口为尽力记录；事务内安全审计的保证另行保留，不能互相替代。
