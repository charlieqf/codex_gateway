# Gateway Phase 0：诊断与计量基础实施结果

日期：2026-08-21

状态：本地实现与验证完成；已形成候选提交；未部署

实施规格：`gateway-phase0-diagnostic-metering-foundation-implementation-spec-2026-08-21.zh-CN.md`

## 1. 结论

Phase 0 的本地代码、additive SQLite migration、Admin CLI、client-messages Admin JSON/HTML、自动化测试和本实施记录均已完成。实现保持现有公开错误码、HTTP 状态、响应正文、重试条件、限流、计费、Plan、entitlement 和客户端协议不变。

本次没有连接 R760、Azure 或 CN1，没有部署或重启任何生产服务，也没有把 system status/current state 更新为“已部署”。当前工作区的 Phone Auth、client-messages 和其他既有用户修改均被保留；没有执行 reset、checkout 或删除。核心实现已按用户后续授权形成候选 commit `a2acb552f025feafad64c192331c8133a91707e6`，本实施结果记录随同一功能分支提交和推送。

## 2. 实际 migration

实际 migration 编号为 **26**。检查时 Gateway schema 最新已使用 migration 25，因此按规格选择下一个编号。

Migration 26 只对 `request_events` additive 增加以下列：

- `upstream_failure_origin TEXT`
- `upstream_failure_kind TEXT`
- `upstream_failure_stage TEXT`
- `upstream_transport_code TEXT`
- `upstream_failure_retry_count INTEGER`
- `upstream_recovery_attempt_count INTEGER`
- `upstream_unclassified_additional_attempt_count INTEGER`

同时增加只覆盖已分类终态失败的部分索引：

- `idx_request_events_failure_started(upstream_failure_origin, upstream_failure_kind, started_at DESC)`

Migration 使用列存在性检查，可重复执行；只含 `request_events(request_id)` 的最小历史 schema 也可迁移。既有 migration 25 未被修改。新 attempts JSON 字段仍位于既有 `upstream_attempts_json` 中，旧应用可以忽略。

## 3. 最终数据合同

### 3.1 Provider failure

内部分类对象固定为：

- `origin`：`client | gateway | network | proxy | provider | unknown`
- `kind`：`client_aborted | deadline_exceeded | dns | connect | connection_reset | tls | proxy_connect | http_auth | http_rate_limit | http_request | http_timeout | http_server | response_body_missing | stream_incomplete | stream_protocol | provider_reauth | unknown`
- `stage`：`before_headers | after_headers | streaming | unknown`
- `transportCode`：经过 `^[A-Z0-9_-]{1,64}$` 校验的 transport code 或 `null`
- `upstreamStatus`：有效 HTTP status 或 `null`

分类器最多遍历 6 层 cause，支持 `AggregateError`，防止 cause 循环，并覆盖 DNS、connect/reset、TLS、proxy CONNECT、Gateway deadline、client abort、HTTP 4xx/5xx/429、无 body、SSE malformed/incomplete/interruption 和 unknown fallback。

分类只进入内部 error、attempt summary、request event 和安全结构化日志字段，不进入普通客户端响应。成功请求的终态 failure 标量保持 `null`；如果成功前有失败 attempt，事实保留在对应 attempt 内。

审查后又对旧 `POST /sessions/:id/messages` SSE 做了显式公开事件投影：内部 `providerFailure` 不再随 error event 返回客户端，但同一分类仍完整写入 observation。该旧接口的真实 `provider.message()` 调用现在也生成一个 `purpose=primary` 的 `ProviderStreamSummary`，成功和失败都不再错误显示为 0 次模型调用。

### 3.2 Upstream attempt

每个新 provider attempt 都有稳定 `purpose`：

- `primary`
- `failure_retry`
- `contract_recovery`
- `unknown`

统一 resolver 覆盖普通 primary、stateless retry、native initial、全部 native retry plan、strict initial/repair 和未知历史 kind。Native/strict validation、ack、empty-output recovery 计入 `contract_recovery`，不计入故障重试。多个 primary 会增加未分类附加尝试并产生内部 warning。

每个新 request event 的 `upstream_attempt_count` 为明确的 0 或正整数，并分别持久化：

- `upstream_failure_retry_count`
- `upstream_recovery_attempt_count`
- `upstream_unclassified_additional_attempt_count`

同一 `client_message_id` 下的多个 Gateway request ID 仍分别计为多个 Gateway/模型调用请求，不据此推断 beta.38 客户端自动重试。

### 3.3 Token 与 usage

最终展示和聚合已拆分为：

- Provider 准确 `prompt/completion/total/cached/reasoning` Token
- 仅在 Provider usage 不存在时采用的 Gateway 最终 `estimated_tokens`
- 独立展示、从不进入总量的准入前 `gateway_estimated_prompt_tokens`
- `usage_missing`

`provider_usage_present` 根据准确字段是否为非 NULL 判断，因此 Provider 明确返回 0 仍是准确 usage。Gateway 本地 429 等明确零用量请求使用 `usage_source=none`，不标记为 missing。Request event 只用于诊断和关联，没有与 token reservation ledger 相加，未引入双倍累计。

`RequestUsageReportRow` 新增：

- `modelCallRequests`
- `upstreamAttempts`
- `failureRetries`
- `recoveryAttempts`
- `unclassifiedAdditionalAttempts`
- `attemptCountMissing`
- `attemptPurposeMissing`

历史记录缺少字段时保留 `null`/legacy unknown，不根据错误正文猜测。损坏 attempts JSON 降级为 `null`，不阻断查询。

只有 `upstream_attempt_count`、没有 attempts JSON 的历史记录会把对应 attempt 全部计入 `attemptPurposeMissing`；attempt 数大于 JSON 明细数时，缺口同样计为 missing。即使三项聚合 counter 已持久化为 0，JSON 中显式为 `unknown` 的 purpose 仍会被统计，避免把未知事实伪装成确定的 0。

Token reservation 报表按 `final_usage_source` 解释账务终态：只有 `provider|soft_write` 进入 Provider 准确 Token；`estimate|reserve` 的 `final_total_tokens` 只进入 Gateway 最终估算 Token。以 fallback 125 为例，报表和 dashboard 现在固定为 Provider 0、估算 125、可归因 125，不再得到 250。

## 4. Admin 交付

Admin CLI `events` 已输出完整 failure、attempt purpose/counters 和 Token 来源，并新增 `--request-id` 精确过滤。Admin CLI `report-usage` 已输出上述七项模型调用/attempt 计数。

`/gateway/admin/client-messages.json` 和 `/gateway/admin/client-messages` 现在分别展示：

- Gateway 请求数、模型调用请求数、upstream attempts、故障重试、合同恢复和未分类附加尝试；
- Provider Token、最终估算 Token、可归因 Token、准入前估算和 missing usage；
- 真实 Gateway request ID、终态失败、每次 attempt 的 purpose、分类、HTTP/request ID、耗时和 Token；
- Admin HTML 展开的 attempt 同时显示 provider/runtime/model、upstream request ID、upstream HTTP status、prompt/completion/total Token，以及 failure transport/upstream status；
- 每条消息最新 100 个 Gateway request 明细、总数和明确截断标志；
- `tokens`、`provider_tokens`、`estimated_tokens`、`upstream_attempts`、`retries`、`recoveries` 排序。

既有 Admin token 鉴权、CSP、`Cache-Control: no-store`、HTML escaping、正文访问控制和敏感信息脱敏保持不变。普通 client credential 仍不能读取 Admin JSON/HTML。

## 5. 核心修改文件

Core 与 provider：

- `packages/core/src/provider-failure.ts`
- `packages/core/src/provider-failure.test.ts`
- `packages/core/src/errors.ts`
- `packages/core/src/index.ts`
- `packages/core/src/stores.ts`
- `packages/core/src/types.ts`
- `packages/provider-codex/src/codex-adapter.ts`
- `packages/provider-codex/src/codex-adapter.test.ts`
- `apps/gateway/src/services/openai-compatible-provider.ts`
- `apps/gateway/src/services/openai-compatible-provider.test.ts`
- `apps/gateway/src/services/provider-stream.ts`
- `apps/gateway/src/services/provider-stream.test.ts`

Gateway observation 与 Admin：

- `apps/gateway/src/http/context.ts`
- `apps/gateway/src/http/observation.ts`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/index.test.ts`
- `apps/gateway/src/admin-client-messages.ts`
- `apps/admin-cli/src/index.ts`
- `apps/admin-cli/src/index.test.ts`

SQLite 与兼容工具：

- `packages/store-sqlite/src/migrations.ts`
- `packages/store-sqlite/src/columns.ts`
- `packages/store-sqlite/src/request-events.ts`
- `packages/store-sqlite/src/request-usage-report.ts`
- `packages/store-sqlite/src/row-mappers.ts`
- `packages/store-sqlite/src/quota-dashboard.ts`
- `packages/store-sqlite/src/index.test.ts`
- `scripts/gateway-usage-history-transfer.cjs`

## 6. 自动化验证结果

Vitest 的当前等价 targeted 命令使用 `npx vitest run <file>`。

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| Core provider failure targeted | 39/39 通过 |
| OpenAI-compatible provider targeted | 31/31 通过 |
| Provider stream targeted | 28/28 通过 |
| Codex adapter targeted | 23/23 通过 |
| SQLite store targeted | 41/41 通过 |
| Gateway index targeted | 184/184 通过 |
| Admin CLI targeted | 19/19 通过 |
| 七个规定 targeted 文件合计 | 365/365 通过 |
| `npm test` | 49 files 通过、1 file 按原配置跳过；794 tests 通过、2 tests 按原配置跳过 |
| `npm run build` | 通过 |
| `git diff --check` | 通过 |
| 50,000 行/48 小时报表性能门禁 | 通过，测试断言小于 500 ms |
| Migration 26 重复执行、最小历史 schema、v24→v26 transfer | 通过 |

覆盖证据包括：

- fetch failed 嵌套 cause、DNS/connect/reset/EPIPE/TLS/proxy/deadline/client abort；
- HTTP 400/401/403/408/429/500/503/504；
- response body missing、SSE malformed/incomplete/reader interruption；
- stateless failure retry、native/strict contract recovery、Gateway 本地 429 attempt=0；
- primary success、xAI fetch transport failure、三次正常 client tool loop；
- migration/JSON round-trip、历史 null、损坏 JSON、group merge 和 50k 性能；
- Admin JSON/HTML JavaScript parse、排序、Token 拆分、request ID、100 条截断、鉴权/CSP/no-store/escaping；
- 普通客户端响应不泄露 internal classification；
- 旧 sessions SSE 不泄露 `providerFailure`，同时成功/失败 observation 均记录真实 primary attempt；
- Codex 带 HTTP 401/403 的登录失效保持 `provider/provider_reauth`，不被通用 `http_auth` 覆盖；
- missing-provider-usage fallback 在 request report、Admin 用户/全局 dashboard 中不重复累计；
- raw message、API key、Bearer、统一 Key、refresh token、password 和 R2 签名 URL 脱敏。

静态敏感信息扫描覆盖 29 个 Phase 0 运行时、测试和交付文件；JWT、OpenAI key、AWS access key 和签名 URL 候选均为 0。扫描命中的 1 个 `cgu_live_*` 和 19 个 Bearer literal 全部只位于明确构造的脱敏/Admin 鉴权测试 fixture；逐行复核后确认不是生产凭据，并由负向断言确认不会进入公开响应、诊断输出或 Admin 输出。

## 7. 与规格的偏差

本地实现范围没有已知功能偏差。

生产相关条目按本 goal 的明确授权边界未执行：

- 未生成或发布 R760 release candidate artifact；
- 未备份或迁移 R760 SQLite；
- 未执行 R760 smoke、Admin 页面生产验收或观测期；
- 未更新 system status/current state 为 deployed commit；
- 未连接或修改 Azure/CN1。

这些未执行项不是本地实现失败，而是必须等待后续生产发布授权。规格第 20 节以及 Definition of Done 中依赖生产部署的项目仍保持未完成状态，不能用本地结果冒充生产证据。

## 8. 发布候选边界

当前功能分支已形成可供审查的本地 R760 发布候选，核心实现 commit 为 `a2acb552f025feafad64c192331c8133a91707e6`。生产发布仍未获授权；后续只有获得明确授权后，才能：

1. 从已推送功能分支选择并生成最终 release commit；
2. 按实时 R760 状态重新执行 preflight；
3. 建立 SQLite、配置、image 和 previous release 回滚边界；
4. 部署 Gateway additive migration 26；
5. 执行规格第 20 节 smoke、Admin 验收和观测；
6. 按真实部署 commit 更新 system status/current state。

在获得该授权前，不应连接、部署或重启生产服务。
