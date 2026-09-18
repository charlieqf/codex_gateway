# Gateway 身份请求审计职责收敛与实施方案

日期：2026-09-18

状态：实施中；用户已要求按本文实施、自审、自测、部署及线上自测。本文定义范围与门槛，不是完成验收报告，不表示已上线。

核对基线：本地唯一开发工作区的 `main`，HEAD `1a37c0c`。第 2 节的“现状”以该已提交版本的改造前职责为准。工作区已存在相关未提交实现和其他功能改动，应按本文分别审核，不能据此认为方案已验收或已上线。本轮文档整理未重新核验生产版本或远端最新提交。

评审重点：是否认可职责拆分、完整手机号的受控留存、429 聚合的信息损失，以及明确的替换／删除清单。留存、压测负载和告警责任人待团队确认，见第 14 节。

## 1. 结论与目标

建议将“身份 HTTP 请求最终结果”集中到一个出口记录，替换服务层零散的请求结果审计；事务内安全审计、开户状态记录和 Pino 运维告警各自保留。

本次要解决的问题是：遇到注册／关联 409 或手机号登录失败时，运维能按 request ID、请求手机号、外部身份或已确认的 Subject 找到当时的事实，不再仅凭相邻日志时间推测归属。

采用以下边界：

- 普通请求：逐条记录最终 HTTP 结果、公开错误码、内部原因及必要身份上下文。
- Gateway 登录限流 429：使用现成的 `markRateLimitRejection` 标记，在同一个出口按分钟聚合。
- 手机号：允许在受控审计存储内保存完整输入值和规范化值，不输出到普通访问日志，不保存完整请求体。
- 事务安全审计：继续与身份登记、Session、Refresh Token 的状态变更处于同一事务。
- Pino 5xx、补偿失败及安全告警：继续保留，不因“合并审计”而删除。
- 开发顺序：先增加出口与存储并通过集成测试，再切换三个消费者，最后删除旧接口；三步完成后作为同一个发布上线。

本文建议增加两张职责单一的表：请求明细表和限流分钟表。相较此前“增加一张请求审计表”的讨论，这是为落实 429 聚合而作的设计细化，不增加第二条审计写入链路。避免在同一张表中混用“一行代表一次请求”和“一行代表多次请求”。

## 2. 改造前现状及代码依据

以下符号以 `1a37c0c` 为基线；文件链接指向工作区，相关旧方法可能已在未提交实现中被替换。复核原职责时使用 `git show 1a37c0c:<文件路径>`，不将新旧实现的描述混为一谈。

| 位置 | 当前职责／缺口 | 本次处理 |
| --- | --- | --- |
| [HTTP observation](../../apps/gateway/src/http/observation.ts)，`recordObservation` | 跳过 `public` 和 `skipObservation`；手机号和 Billing 身份接口不能依赖该表归因 | 保持模型请求统计边界，增加独立的身份请求出口 |
| [Phone Auth 路由](../../apps/gateway/src/phone-auth-routes.ts)，`sendPhoneAuthError`、`acquireLoginPermits` | 前者标记公开错误；后者将限流结果转换为 `auth_rate_limited`，丢失原始限流类别信息 | 在转换前标记原始拒绝，并记录 phone／ip／device 维度 |
| [Phone Auth 服务](../../apps/gateway/src/services/phone-auth-service.ts)，`recordSuccess`、`auditFailure`、`recordLoginRateLimit` | 把部分请求成功／失败写入 `phone_auth_audit_events`；不能覆盖所有出口 | 用统一请求出口替换这些调用 |
| [Billing Admin](../../apps/gateway/src/billing-admin.ts)，`sendBillingError` | 返回错误码及 request ID，但没有统一请求审计；错误可能只留下 HTTP 状态 | 标记错误和业务上下文，交给统一出口落盘 |
| [外部身份存储](../../packages/store-sqlite/src/external-identities.ts)，`conflict()` | 不同冲突共用 `identity_conflict` 和相同消息 | 增加内部原因枚举；本次不改公开 code、message 或 HTTP 状态 |
| [Phone Auth 存储](../../packages/store-sqlite/src/phone-auth.ts) | 身份登记、会话创建、刷新轮换／重放／撤销及相关安全审计 | 保留事务和安全审计，不替换成出口写入 |
| [人工开户](../../apps/gateway/src/real-user-issue.ts)、Billing `launchIssuance` | HTTP 202 后异步推进任务，存在独立任务及补偿结果 | 请求只记录受理；任务表和现有管理审计仍是最终状态依据 |

特别注意两处现有语义：

1. `markGatewayError` 只对 `rate_limited` 自动设置限流标志，不对 `auth_rate_limited` 设置；删除 `recordLoginRateLimit` 后不能仅依赖 HTTP 429 或公开错误码推测限流信息。
2. Refresh Token 轮换的安全审计可能先成功，后续账户就绪检查再失败并撤销会话。因此，`phone_auth_audit_events` 中的 `refresh/ok` 不等于该 HTTP 请求最终成功。

Gateway 当前复用 phone-auth v1，不负责真实短信发送／验证码校验。本方案统计的是 Gateway 开户、关联及领取模型凭据的结果，不将其命名为“短信验证成功率”。

## 3. 替换范围与非目标

### 3.1 本次纳入的 HTTP 路由

通过路由配置显式声明 `identityAuditOperation`，不使用 URL 前缀通配收集整个 Billing API。路由模板、operation 必须是固定值，不把用户提供的路径参数或 query 当作统计维度。

| 路由组 | 纳入接口 |
| --- | --- |
| Phone Auth | `POST /gateway/auth/v1/login/start`、`token/refresh`、`logout`、`session/bootstrap`；`GET /gateway/account/v1/current` |
| 身份登记 | `POST /gateway/admin/billing/v1/phone-auth-identities`；`PATCH .../phone-auth-identities/:subjectId` |
| 关联／开户／查询 | `POST .../subjects/resolve`；`POST .../subjects`；`GET .../subjects`；`GET .../subjects/:subjectId` |
| 凭据／账户维护 | `POST .../subjects/:subjectId/keys`；`POST .../subjects/:subjectId/disable` |
| 登记对账 | `GET .../subject-registrations/:provider/:externalUserId`；`POST .../subject-registrations/:provider/:externalUserId/retry-disable` |
| 人工开户请求 | `POST .../real-user-issue`；`GET .../real-user-issue/:jobId`；`POST .../real-user-issue/:jobId/resume`、`retry-disable` |

上表省略号均表示 `/gateway/admin/billing/v1` 前缀。开户列表、HTML 管理页面、套餐／订单／权益接口不因共享 `billingRouteOptions` 而自动纳入。

### 3.2 明确不做

- 不调整手机号匹配、账户归属、人工开户状态机、租约、上游补偿、登记释放的业务条件。
- 不修改 migration 31–33，不回填或改写历史安全审计。
- 不改变手机号登录、Billing 创建、幂等重放、409 查询恢复、版本门禁和下载页合同。
- 不新增短信 token 校验、短信登录 v2、外部 JWT 密钥或平台识别。
- 不把身份请求塞进模型 `request_events`、计费 `billing_subject_events` 或管理操作审计来复用统计。
- 不采集完整请求／响应，不增加通用事件总线、审计队列、独立后台服务或新管理页面。
- 不混入当前工作区的模型 Key 路由、零售套餐、额度重置、研究功能和会话查询改动。

## 4. 目标职责与请求生命周期

| 层级 | 应负责 | 不应负责 |
| --- | --- | --- |
| 路由 | 校验、响应合同、标记 operation／输入身份／错误／限流维度 | 每个分支自行 INSERT 审计、扫描响应找凭据或手机号 |
| Phone／Billing 业务服务与存储 | 业务判断、返回已确认事实、抛出带类型的内部原因 | 持有 Fastify request、写 HTTP 请求结果日志 |
| 统一 HTTP 出口 | 合并安全上下文与最终响应状态，选择明细或限流聚合，每请求最多终结一次 | 执行开户／补偿／重新校验 token／查全量用户补身份 |
| 身份审计存储 | 明细 INSERT、分钟计数 UPSERT、索引、留存清理 | 业务归属判断、解析 HTTP body、修改身份或权益 |
| 事务安全审计 | 记录实际安全决策及状态变更，与业务事务同成败 | 用来代替 HTTP 成功率或覆盖请求全部拒绝路径 |
| Pino | 5xx、补偿未完成、审计存储异常等运维告警 | 作为可检索的完整手机号审计数据库 |

具体接入方式：

1. 在现有启动／HTTP 生命周期中安装一个窄模块，例如 `http/identity-request-audit.ts`。通过配置识别纳入路由，不更改原来的 `public`、`skipObservation` 和鉴权含义。
2. `onRequest` 初始化请求审计上下文，位置必须早于可能短路的鉴权及版本门禁。复用 Gateway 生成的 request ID 和开始时间。
3. 请求体已解析时，只提取白名单字段。Billing 在鉴权通过后提取业务输入；未通过鉴权不为采集手机号而提前读取原始请求流。JSON 解析失败、超大 body、在 `onRequest` 已返回的 426 等允许手机号为空，并记录字段不可用的原因。
4. 路由／错误出口标记公开错误码，业务层用类型化返回值或异常携带内部原因和已确认事实。不要解析 `error.message` 反推原因，也不要遍历最终响应对象——成功响应可能含完整 Key 或 token。
5. `onResponse` 调用统一终结函数，读取实际响应状态并落盘。异常处理路径补齐错误上下文；`onError` 不另写一份同类审计。
6. 复用现有连接中断观测，在中断与正常响应之间执行一次性终结保护。断连记 `transport_outcome=aborted`，没有最终 HTTP 响应时 `http_status=NULL`；不伪造客户端收到了 499。
7. 请求审计在业务事务结束后独立写入。事务回滚不应带走失败原因；但断连后业务仍可能继续，审计只能表达截至终结时已知事实，不能把断连等同于开户回滚。

普通出口写入失败：保留原业务响应，输出脱敏的 `identity_request_audit_write_failed` 告警及丢失计数；不因观测失败把已成功开户改成 503，不进行无限重试。相同故障持续发生时按时间窗口抑制重复告警并保留次数。

这一出口属于尽力记录，不承诺进程崩溃时零丢失：响应已发送而出口尚未落盘，或正在处理时进程退出，都可能留下缺口，且进程内丢失计数也未必可恢复。报告需结合重启／故障区间标识覆盖不确定性，不能把“没有记录”解释为“没有失败”。需要强持久化保证时应单独评审，不能把事务安全审计的保证移植为本方案已经具备的能力。

这不改变事务安全审计的失败语义：其写入失败仍须导致原事务失败／回滚。两者必须分别测试，不共用一个“所有审计都吞异常”的包装器。

## 5. 上下文与内部原因

### 5.1 身份事实的来源

- `phone_input`：仅来自白名单 phone 字段的字符串快照；限制长度并拒绝控制字符，不进行任意对象序列化。
- `phone_normalized`：使用现有 `normalizeMainlandChinaPhone`，禁止另写第三套规则。采集规范化不代表放宽当前接口校验。
- `provider`、`external_user_id`：来自已解析的合法输入；属于请求声明，不据此证明用户身份。
- `target_subject_id`：请求参数指定的目标；`subject_id`：业务实际查得／确认的账户。两者分开，不能把请求方填写的 ID 当作已验证归属。
- `conflicting_subject_id`：仅在业务当时确认单一冲突账户时记录。多归属冲突记录枚举原因，不任意选择一个 Subject。
- `session_id`、`job_id`：仅来自业务已校验或生成的对象；不记录 Session／Refresh Token 本身。
- 无 phone 输入的请求若业务本来已读取账户手机号，可记录为 `resolved_phone`，并保留来源；不得伪称为请求中的手机号。

服务层需要返回安全的内部诊断事实时，使用固定字段类型。可在现有 `GatewayError` 上增加可选、类型化的 `identityFailure` 数据，路由显式映射；禁止任意 `metadata`／`details` 字典、Fastify 回调或自动将异常对象序列化到客户端。

内部事实还必须避开通用日志序列化：不能只保证公共响应 DTO 不输出这些字段，却让 `JSON.stringify(error)`、对象展开或 Pino error serializer 将完整手机号写入普通日志。若放在异常对象上，应采用不可枚举属性等明确隔离方式，并测试实际响应与日志出口；只有受控审计出口显式读取白名单字段。

未知 token、未验证 JWT 和认证失败的请求，不为审计而反解／补查账户；信息未知就留空。历史审计也不通过关联“当前手机号”冒充当时请求的号码。

### 5.2 原因分类

公开 `error_code` 保持原样；内部 `reason_code` 只记录业务分支已知的事实。首批建议覆盖：

| 分支 | 内部原因示例 | 说明 |
| --- | --- | --- |
| 多个 Subject 具有相同规范手机号 | `phone_multiple_subjects` | 保持原冲突判断，含历史停用账户的处理规则不变 |
| 已绑定身份与本次手机号不一致 | `linked_subject_phone_mismatch` | 不自动改绑 |
| 当前 provider 下同一账户已被另一外部身份关联 | `external_identity_binding_conflict` | 不解释成“购买过其他套餐” |
| 手机号被另一未释放登记占用 | `phone_reserved_by_other_identity` | 不改变释放条件 |
| 同一外部登记重试时手机号改变 | `registration_phone_mismatch` | 与 payload／幂等冲突分开 |
| 建档完成／补偿时幂等信息或上游归属不匹配 | `registration_state_mismatch` | 不把所有 `conflict()` 都换成手机号冲突 |
| 既有账号查询恢复路径 | `existing_subject` | 可能对应公开 `subject_already_exists` 409；不视为系统 5xx |
| 账户就绪检查失败 | 沿用具体业务错误，必要时补窄枚举 | 不把 Key 不可恢复、账户停用、手机号重复都记成一个原因 |

精确枚举须逐分支核对后定稿。无法可靠细分时保留公开错误码并使用 `unclassified`，不编造归因。字段只供受控运维查询，不扩展公共错误响应。

## 6. 存储设计与访问边界

### 6.1 请求明细：`identity_request_events`

建议字段如下；均为有长度限制的标量或受限枚举，无 body／response JSON 列。

| 字段组 | 字段 |
| --- | --- |
| 请求标识 | `request_id`（唯一）、`operation`、`method`、`route_template` |
| 时间／传输 | `started_at`、`completed_at`（UTC）、`duration_ms`、`http_status`（可空）、`transport_outcome` |
| 最终结果 | `outcome`、`error_code`、`reason_code`、`stage` |
| 输入身份 | `phone_input`、`phone_normalized`、`phone_capture_status`、`provider`、`external_user_id` |
| 确认事实 | `subject_id`、`target_subject_id`、`conflicting_subject_id`、`resolved_phone`、`session_id`、`job_id` |
| 最小客户端信息 | `client_version`，仅记录有长度限制的版本值 |

`outcome` 建议固定为 `succeeded / accepted / rejected / failed / aborted`：HTTP 202 为 accepted；一般 4xx 为 rejected；5xx 为 failed。`existing_subject` 通过 reason 解释，不能把所有 409 自动归成故障或成功。

`stage` 仅在现有边界赋值，例如 `preflight / validation / identity_resolution / provisioning / account_readiness / credential_recovery / response`。缺少证据时为空，不为审计重写整套业务流程。

索引：request ID 唯一；完成时间；规范化输入手机号＋完成时间；确认账户手机号＋完成时间；provider＋external ID＋完成时间；Subject＋完成时间。按 job ID 的索引随实际查询需求确定，不默认索引所有列。

身份选择字段可为空，应使用只覆盖非空值的部分索引；例如未携带外部身份或任务 ID 的登录请求，不为这些空值维护无用索引项。保留完整请求明细，不以减少记录或降低业务事务持久化强度换取性能。

审计中的 Subject 标识是历史事实，不设置会级联删除证据的外键。数据库类型／CHECK 约束限制字段值；SQL 参数化写入。

### 6.2 限流分钟计数：`identity_rate_limit_minutes`

仅用于已由 Gateway 标记、最终确实返回 429 的本地身份限流。业务冲突、异常 5xx、未归因的上游 429 不自动折叠到这里。

- 唯一桶键：UTC `minute_start + operation + limit_dimension + limit_kind + origin + error_code`。
- `limit_dimension` 固定为 `phone / ip / device`；其余维度也来自内部枚举。
- 记录 `rejection_count`、`first_at`、`last_at`、首尾 request ID，以及首尾样本手机号输入／规范值（能获取时）。样本固定最多两个，不保存无限增长的 ID／手机号数组。
- 不将完整手机号、IP、device ID、external ID、request ID 或任意 header 作为桶键。因此攻击者轮换这些值不会产生无限高基数的分钟桶。
- 采用原子 UPSERT 增加计数，复用同一请求的终结保护防止重复计数；跨分钟按终结时刻归桶，和计数报告口径一致。

此设计的明确代价：429 的次数和分钟分布准确，但只保留首尾请求样本；不能承诺逐次 request ID 查到记录，也不能精确统计任意手机号的全部限流次数。查询返回应标注 `detail_level=minute_aggregate`，样本不是该桶全部请求的身份归属。若业务要求每个 429 都保留完整手机号，需要重新评估容量，不能同时声称已经做了无损的逐条归因和有界聚合。

报表中的总请求数为普通明细数加 `SUM(rejection_count)`，不能把分钟桶 `COUNT(*)` 当作限流请求数。分钟汇总只支持分钟粒度窗口；任意秒级边界须显式向外取整并返回实际窗口，不能伪称精确。涉及“受影响用户数”时不使用首尾样本推算全量去重用户。

### 6.3 留存、容量及保密

- 建议初始留存：请求明细 30 天，限流分钟计数 7 天；作为评审参数，不声称现已配置。旧安全审计沿用现有规则。
- 清理使用有界批次、按时间索引执行，在维护任务中运行，不在每条登录请求中扫描／删除旧数据，不自动 `VACUUM`。
- 有界清理还须能够追上过期数据增长：验收实际删除速率、最旧记录时间和过期积压量，不能仅因配置了“30 天”就声称实际留存已达标。若使用进程内定时维护，明确启动／停止归属、故障告警和每轮上限；不额外新建后台服务。
- 429 聚合减少行数和索引增长，不代表每分钟只写一次。首版保持同步原子计数，不引入内存缓冲队列；需实测 SQLite 锁等待、WAL 写量、事件循环延迟和模型请求的连带影响。
- 若同步计数在约定负载下不能通过性能门槛，先阻止发布并复审方案，不未经评审加入异步队列或悄悄丢事件。
- 分钟聚合只约束已识别的 429，不能解决所有恶意请求造成的明细增长。400／401／403 等仍逐条记录，容量验收须包含这些负载；不得为了达标静默采样注册 409 或 5xx。超出容量时按既有入口防护处置，新增防护策略另行审核。
- 完整手机号只在受控数据库和指定的运维查询结果内可见；普通日志、指标标签、客户端错误及公开页面不扩散。
- 备份和导出文件沿用受控权限与留存管理。文档、测试、Git 提交不包含真实手机号、token 或 Key；现有秘密扫描规则继续保留。
- 只读查询以 `DatabaseSync(..., { readOnly: true })` 及 `PRAGMA query_only=ON` 打开数据库，不能为了查询实例化会执行迁移的正常 Store。

## 7. 429 标记的精确实现要求

调整 `acquireLoginPermits` 的三个拒绝分支，而不是在服务层新增一个审计方法：

1. 在仍持有原始 `LimitRejection` 时调用 `markRateLimitRejection(request, rejection)`，保留 limit kind／details／origin。
2. 同时向身份请求上下文写入 `limit_dimension=phone|ip|device`；无需复制一套 limit kind 字段。
3. 按现有逻辑释放此前获得的 permit，不能泄漏，也不调整原有计数／扣减语义。
4. 转换为原有 `authRateLimited(retryAfterSeconds)`，通过 `sendPhoneAuthError` 返回。
5. `markRateLimitRejection` 会暂时把 `gatewayErrorCode` 设为 `rate_limited`；随后 `sendPhoneAuthError` 调用 `markGatewayError`，必须保留最终公开码 `auth_rate_limited`。出口记录该最终码，同时读取保留下来的限流标志。
6. HTTP 状态、`Retry-After`、`retry_after_seconds`、私有响应头保持不变。审计失败不再把本该返回的 429 改成 503。

## 8. 保留／删除清单

### 删除或替换

- `PhoneAuthService.recordLoginRateLimit` 及路由中的专门调用和审计异常处理。
- `PhoneAuthService.recordSuccess`、`auditFailure` 及仅为记录 HTTP 结果存在的调用；失败分支改为携带安全的内部事实。
- `PhoneAuthStore.recordPhoneAuthAudit` 通用公开门面；同步清理 core 接口、SQLite Store 门面、运行态 `isPhoneAuthStore` 检查、fake store 及测试。
- `bootstrap`／`accountCurrent` 中仅供上述请求审计使用的 `requestId` 参数及其调用点。仍用于事务安全审计的 request ID 不删。
- 三个消费者中把安全事件当作 HTTP 最终成功／失败的查询口径。

### 必须保留

- Phone Auth Store 内的身份登记、状态变更、Session 创建、刷新轮换／重放／撤销及安全审计。
- `phone-auth.ts` 内的 `recordAudit`／事务内写入能力，特别是外部身份补登记使用的 `phoneAuth.recordAudit`；不能因移除公开门面一并删除。
- `revokeAfterFailedRefresh` 及其事务安全审计。
- `external_subject_registrations.last_error_*`、补偿状态、发放任务快照和管理操作审计，它们服务于恢复和对账。
- 人工开户 started／resumed／finished 等管理审计；HTTP 202 与后台任务完成是不同事实，不属于重复请求审计。
- `sendPhoneAuthFailure` 的异常告警、Billing 认证存储故障、`orphan_compensation_pending`、`issuance_compensation_pending`、worker 异常等 Pino 日志。
- 原有账单事件、模型请求观测及部署后的安全扫描能力。

“零散日志合并”在本方案中仅指重复持久化的 HTTP 请求结果。现有 5xx 告警的保留应有测试，不能用数据库审计替代告警。新增审计落盘失败告警时只记录 request ID、operation、错误类别及次数，不打印异常携带的完整 SQL 参数或请求内容。

## 9. 三个消费者和运维查询

| 消费者 | 改动 | 保持不变 |
| --- | --- | --- |
| [export-user-accounts.py](../../scripts/export-user-accounts.py) | 最近手机号请求、近期失败改读新明细；429 单独列为聚合统计，不能归给样本账户 | 原有账户、权益、Key 一致性检查和 F01–F09 规则 |
| [audit-phone-conflicts-r760.mjs](../../scripts/ops/audit-phone-conflicts-r760.mjs) | 按最终错误码／内部原因统计；区分请求明细、429 分钟统计和历史安全记录 | 重复手机号／归属／运行态检查 |
| [audit-phone-auth-readiness-r760.mjs](../../scripts/ops/audit-phone-auth-readiness-r760.mjs) | 最近登录结果改读新明细，旧记录标为 legacy security event | 现有只读就绪检查，不触发 login、bootstrap 或权益状态推进 |

同一发布增加一个窄的只读查询入口，支持时间范围＋request ID／手机号／provider 与 external ID／Subject ID／job ID，强制 limit／分页。完整手机号只允许定向、受控输出；一般巡检继续脱敏。

历史兼容要求：

- 新数据是 HTTP 结果，旧 `phone_auth_audit_events` 是安全／操作记录，两者不可直接 UNION 后计算成功率。
- 报告标明来源、覆盖起止和缺口。部署时间、回滚区间及审计写入失败区间以发布记录／告警说明，不能假装连续完整覆盖。
- 无新表的历史数据库或回滚环境可返回显式 legacy 模式；不能显示成“零失败”。
- 不迁移旧表数据为新请求事实，不用当前账户手机号回填历史请求输入。

## 10. 文件级实施清单

下列名称中标注“新建”的是建议组织方式，审核通过后实施；不创建通用审计框架。

| 文件／模块 | 工作 |
| --- | --- |
| `packages/core/src/identity-request-audit.ts`（新建）及导出入口 | operation／reason／事件字段、窄 Store 接口；不依赖 HTTP 框架 |
| `packages/core/src/errors.ts` | 如采用异常携带事实，添加可选类型化字段；保持公开错误序列化不变 |
| `packages/store-sqlite/src/identity-request-audit.ts`（新建） | 两张表的明细写入／聚合／维护操作及测试 |
| `packages/store-sqlite/src/migrations.ts` | 已提交基线最高 33；工作区草稿使用 additive migration 34。合并／发布前重新核对编号，不能覆盖其他迁移 |
| `packages/store-sqlite/src/index.ts`、`packages/core/src/phone-auth.ts` | 接入新 Store，移除旧请求审计门面，不删事务 helper |
| `apps/gateway/src/http/identity-request-audit.ts`（新建）、`http/context.ts` | 生命周期、类型化请求上下文、一次性终结、审计失败告警 |
| `apps/gateway/src/index.ts`、`gateway-options.ts`、`runtime/gateway-state.ts` | 依赖接线、hook 顺序、Store 能力校验；避开现有无关修改 |
| `apps/gateway/src/phone-auth-routes.ts`、`services/phone-auth-service.ts` | 替换请求审计、429 标记、安全事实传递；不改鉴权合同 |
| `apps/gateway/src/billing-admin.ts`、`packages/store-sqlite/src/external-identities.ts` | 路由显式纳入、错误标记、关联／开户内部原因与结果事实 |
| 三个消费者、其测试、只读查询入口 | 同步统计语义、历史兼容、聚合提示和权限边界 |

数据库变更只增加审计表及索引，不修改业务表、唯一手机号约束、任务记录或历史迁移。即使 migration 编号为 34，也不意味着再次修复 migration 31–33 的业务逻辑。

## 11. 实施顺序：一个完整发布

### A. 新出口和存储先通过测试

先添加类型、迁移、Store、出口，接通本文白名单路由的最小上下文和 429 标记；验证正常、拒绝、异常、门禁及断连路径。此时开发测试中可暂时同时存在旧请求审计，但新统计只读取新表，不把这种中间状态发布到生产。

准出：集成测试可通过新出口直接查到原先缺失的注册 409；三维限流进入分钟表；响应合同及事务安全审计未变。

### B. 切换三个消费者

完成新表读取、旧数据显式标识、429 `SUM(rejection_count)`、只读查询和消费者回归。跨部署边界不混算安全事件与请求成功率。

准出：同一测试数据集在三个消费者中含义一致；不将 accepted、刷新轮换成功或限流样本误报为最终成功／用户全量行为。

### C. 删除旧接口，完整回归后再发布

按第 8 节删除旧门面和调用，清理 fake store／类型／测试。检索确认没有普通请求审计的遗留写入者；重新执行 A、B 的全部回归以及开户、补偿、释放相关安全测试。

可以使用三个可审核的提交组织开发，但最终部署必须包含 A、B、C；不得上线“只加新表、新旧长期双写”的半成品。按用户授权和仓库受控流程执行提交、推送及部署；工作区已有实现同样必须逐项满足上述准出条件，不能把方案或未提交草稿当作完成证据。

## 12. 验收矩阵

| 类别 | 必须通过的场景与断言 |
| --- | --- |
| 请求覆盖 | 登录／刷新／bootstrap／current／logout 成功；未知手机号、停用、迁移未就绪、无效 token；每次完成的普通请求仅一条明细 |
| 提前拒绝 | 401／403、426、JSON 错误、超大 body／不支持类型；记录实际公开状态与错误；未取得 phone 时原因明确，不提前读取 body 绕过门禁 |
| 开户 409 | 既有账号、真实手机号冲突、外部身份冲突、reservation、幂等冲突；request ID 能定向找到输入手机号、外部身份及准确原因；原本的业务副作用／事务结果不变 |
| 手机号字段 | 合法输入、规范化、非字符串、过长／控制字符、无 phone；保留原合同接受／拒绝行为；输入身份与确认归属分开 |
| 429 | phone／ip／device 分别触发；标志及维度齐全；公开码仍为 `auth_rate_limited`；重试头不变；permit 正确释放；分钟计数无重无漏 |
| 聚合容量 | 同分钟大量请求及不断变化的 phone／device 均不增加动态桶维度；跨分钟正确分桶；首尾样本固定上限；报表计数及时间边界正确 |
| 刷新安全 | rotate 成功后 readiness 失败：最终请求为失败，轮换及后续撤销安全审计保留；重放、防重用、无效会话行为不变 |
| 事务回滚 | 身份登记审计故障注入仍回滚 Subject 联系方式、Phone identity、外部关联；失败请求明细独立存在（审计存储可用时） |
| 观测故障 | 普通审计写入失败不改成功／拒绝响应；Pino 脱敏告警及丢失计数可见；不能影响既有事务 fail-closed 语义 |
| 异步／断连 | 202 仅 accepted 并关联 job；任务失败按任务状态查询；中断／onResponse 竞态不双写、不伪造最终业务成败 |
| 告警保留 | 原有 Phone 5xx、认证存储错误、孤儿上游补偿和人工开户补偿失败告警仍可触发；没有把审计表当作告警替代物 |
| 数据安全 | 表中只含白名单；完整 Key、access／refresh token、验证码、Authorization、device 原值和完整 body 均不落盘；普通日志不新增完整手机号 |
| 消费者／只读 | 三个消费者在新表、旧库、跨切换区间下不误报；查询不执行迁移、登录、清理或权益状态变更 |
| 迁移／回滚 | 空库和 schema 33 数据库均可迁移且重复启动幂等；原业务数据未改；旧程序可在保留新表的 DB 上运行，不要求 down migration |

相关既有回归入口包括 `phone-auth-routes.test.ts`、`services/phone-auth-service.test.ts`、`billing-identity-coordination.test.ts`、`real-user-issue.test.ts`、Store 的 `phone-auth.test.ts`／`registration-release.test.ts` 及三个消费者的测试。新增出口／Store／聚合测试，不能只修改旧测试断言使其通过。

验证命令沿用仓库 `npm run typecheck`、`npm test -- <相关测试路径>`、`npm run scan:phone-auth-secrets -- <trusted-base-revision>`，另执行涉及的 Python／Node 消费者测试；发布前在最终提交的 Linux 构建环境复验。秘密扫描基线须是已核对的改造前提交，并确保新文件已进入受检差异；不能用未跟踪文件未被扫描误作通过。

性能需对比关闭新审计的同一基线，覆盖正常流量、持续 429 与模型请求并发。建议评审门槛：正常认证 p95 额外延迟不超过 5 ms 且不超过基线 10%，无新增 SQLite busy／锁超时；峰值／攻击负载按团队确认的 RPS 测试，并报告 CPU、事件循环延迟、WAL 增长和审计行数。阈值是待确认目标，不是已经测得的结果。

审核交付物应包含：限定范围的代码差异、旧接口／调用点清理检索结果、验收矩阵对应的测试结果、固定提交的构建与秘密扫描结果、压测及留存容量报告、迁移／回滚演练结果。未通过项要单列，不以“相关测试通过”代替全部发布条件。

## 13. 发布与回滚边界

依 `codex-gateway-ops` 和组件运行手册执行，不在本文重复或替换生产命令：

1. 发布前 fetch，核对唯一 main、origin/main 和实际部署 revision；保留现有脏文件，只纳入本方案审核过的代码。
2. 只能部署经授权、测试、提交的 main revision，使用干净不可变发布产物；部署前完成可恢复备份和权限／完整性检查。
3. 三步实现同批上线，验证迁移、服务健康、私有审计写入、429 聚合、三个消费者以及关键异常告警；生产验证仅使用已批准的测试账户并清理测试资源。
4. 记录切换时间和审计数据覆盖范围；不声称新表能解释部署前那次未归因的 409。
5. 回滚优先回退程序版本并保留新增表；不得为了撤销审计功能覆盖持续增长的整个生产数据库。旧版本忽略新表的兼容性必须预先验证。
6. 回滚后新审计覆盖停止，报告须展示缺口；旧安全记录不能假装补齐 HTTP 明细。重新上线后也不得补造历史请求输入。

## 14. 审核时需要明确的决策

- [ ] 认可“统一出口＋请求明细表＋限流分钟表”，不混入模型计费观测。
- [ ] 认可第 3 节的显式路由范围，尤其人工开户 HTTP 受理与后台任务最终状态分开。
- [ ] 认可完整手机号仅用于受控审计；普通日志／通用巡检继续脱敏。
- [ ] 认可 429 固定维度分钟聚合及首尾样本：不再承诺逐次／逐手机号的完整 429 归因。
- [ ] 确认明细 30 天、聚合 7 天的初始留存，以及容量／清理责任人。
- [ ] 确认内部 reason 枚举、身份事实传递方式及公共响应不变。
- [ ] 认可普通观测写入失败不改变业务结果，同时保留事务安全审计失败即回滚和全部既有关键告警。
- [ ] 确认压测 RPS、性能门槛及审计写入失败／缺口的告警接收方。
- [ ] 认可 A→B→C 开发顺序、同一发布交付及旧接口清理为上线前置条件。

验收完成的判据不是“多了一个日志表”，而是：能准确解释一次身份请求；旧请求审计入口已被替换；安全事务和告警没有退化；统计语义、容量和回滚路径都明确。
