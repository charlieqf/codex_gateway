# 客户端任务超时、诊断限流与图片并发：责任边界

日期：2026-09-28。继续调查 [48 小时检查](../archive/operations/gateway-48h-review-2026-09-28.zh-CN.md) 中三个问题。生产只读，未修改配置、额度或应用实现，未重放用户任务。

证据：R760 request_events、client_diagnostic_events、Gateway/Nginx 日志；Gateway 已部署提交 `3d4c10a`；Desktop 精确源码 tag `v2.0.0-beta.77` 和 `v2.0.0-beta.85`。下文时间表均为北京时间。

## 结论与责任

| 问题 | 已确认机制 | 主责与协作 |
| --- | --- | --- |
| 任务约 31 分钟后超时 | 中间一笔调用 Gateway 已在 4.89 秒完成，客户端却约 27 分钟后失败并重试；随后在步边界发现整轮预算耗尽 | 客户端负责时间预算、传输存活判断、休眠/恢复与结果不确定时的重试。Gateway 本笔执行正常；应协作提供请求回执关联和不重复执行契约。底层网络/休眠/挂起原因尚不能定论 |
| 诊断上传 62 次 429 | 59 次关联 beta.77；该版本 429 只延迟当前事件，不暂停队列。beta.85 的 3 次触限是突发发送，已观察到冷却后恢复 | 持续重试主责客户端旧版；beta.85 仍需主动限速及进程间协调。Gateway 正常执行独立限流，但应完善容量契约和聚合可观测性 |
| 图片创建两次 429、本地 502 | 3 个 complete 校验和 1 个模型请求占满同一凭据并发 4；1 秒后重试时名额仍未释放；客户端把错误包装为固定 502 | 两端均有修复责任：Gateway 隔离不同资源预算，客户端有界调度、保留错误语义并合理等待 |

不能把诊断限流、图片并发和模型慢视为一个共用队列：诊断上传已有独立 limiter，图片 create/complete 则仍使用普通 credential limiter。

## 一、任务超时：主要时间没有花在 Gateway 推理

目标：beta.77，research agent，支持码 `T:4HXWNFQM`。同一 message_id 在 17:43:57 和 18:00:44 有两次 turn started；最终 31.16 分钟是从第二次开始计算，不能把两个阶段合并成一次连续运行。

| 时间 | 证据 |
| --- | --- |
| 18:00:44.302 | 第二次 turn started |
| 18:04:35.539 | 客户端第 6 步开始，local attempt `b2b0a616-cd61-47d5-8047-f9726bc9c9e6` |
| 18:04:35.622 | Gateway 接收同会话/message 的 `req-ece4b20e-68e7-4375-900d-81126066b2c5` |
| 18:04:40.514 | Gateway HTTP 200，耗时 4,890 ms，tool_calls 正常结束；对应边缘日志也为 200，发送 1,536 bytes |
| 18:31:35.313 | 客户端该 attempt 才报告 AI_APICallError，duration=1,619,769 ms、delivery_state=unconfirmed |
| 18:31:37.367 | 客户端 automatic_retry；Gateway 新请求 `req-4dface04-269f-460a-ba7d-4eaabdd44f39` 4.835 秒成功 |
| 18:31:42.706 | 第 7 步；Gateway `req-4d3e81fa-cc53-4d30-88ef-f6da998b315e` 11.401 秒、stop 成功 |
| 18:31:54.199 | 客户端报告 agent_time_limit_exceeded，source=desktop，duration=1,869,896 ms |

本地第 6 步等待约占最终这轮耗时的 87%。18:04:40 至 18:31:35，该用户客户端诊断的 created_at 也有空档。现有证据支持调查休眠、进程暂停或网络失联，但诊断空档本身不能证明电脑休眠。没有用户机器的电源事件、进程日志和网络跟踪，不能从服务器侧确定具体原因。

**`delivery_state=unconfirmed` 仅代表客户端没有确认回执，不能据此说请求没有到达 Gateway。** 本案正好是 Gateway 已完成、客户端仍未确认。HTTP 200 与边缘发送字节数同样不证明客户端 SDK 成功消费了响应。

源码边界：

- beta.77 `packages/desktop/resources/opencode-config/agent/research.md` 默认 `steps: 30`、`timeout: 1500000`，即 25 分钟。无法读取该用户安装机配置，因此这是发布默认值，不是已验证的用户自定义值。
- `packages/opencode/src/session/prompt.ts` 在每步开始计算 `remainingTime`；过期后安排收尾，`handle.process` 返回后生成 `agent_time_limit_exceeded`。不是每笔网络调用都在整轮截止时被立即中止。一次长等待可以跨过预算，下一步才发现。
- 预算属于 runLoop 内存状态。新 runLoop 会重新建立预算，不能把相同 message_id 的两个 turn started 自动解释为预算沿用错误。
- `packages/opencode/src/provider/provider.ts` 使用可配置的 header/chunk/overall timeout 和取消信号，并显式关闭 Bun 默认 fetch timeout。不能在未取得用户实际配置时断言这些可配置超时全部关闭；但整轮剩余时间没有直接作为该次调用的强制期限传入。
- AI_APICallError 的诊断错误文本已被客户端脱敏概括，现有记录不足以判断断点具体在 DNS、TCP、TLS、响应头还是流消费阶段。

客户端应修复/完善：区分整轮预算与单次网络无进展；记录挂起/恢复和连接状态；恢复后主动核对任务状态，及时提示用户；在请求结果不确定时避免把重试当成尚未执行。是否扣除休眠/断网时间属于产品政策，必须明确，不能通过无限延长超时掩盖。

Gateway 应协作：让客户端生成的 attempt ID 可查询已接收/运行/完成/失败状态，约定幂等边界与不确定结果恢复策略。本案没有证据指向上游超时、Gateway 排队或执行失败。已部署的 provider failover 处理供应商错误，不能自动补救客户端未消费成功响应。

## 二、诊断上传：旧版持续重试与新版突发要分开

按 429 时间、聚合告警的 credential、来源分布和相邻已接收诊断版本关联：

| 时间 | 429 数 | 对应客户端 |
| --- | ---: | --- |
| 9 月 26 日 16:52 | 1 | beta.85 |
| 9 月 26 日 16:54 | 1 | beta.85 |
| 9 月 27 日 16:55 | 7 | beta.77 |
| 9 月 27 日 18:33–18:34 | 52 | beta.77 |
| 9 月 27 日 21:01 | 1 | beta.85 |

拒绝的请求体没有写入诊断表，因此版本归因是上述关联证据，不是对 62 条被拒绝 body 的直接读取。

### beta.77：明确的队列缺陷

`medcode/diagnostic-upload.ts` 的 `attempt` 只对 HTTP 503 更新全局 pausedUntil。429 调用 `later(job, retryAfterMs)` 延迟当前 job，pump 继续发送其他已排队事件。

9 月 27 日 18:33:27 首次聚合告警给出 Retry-After=33 秒；18:33:27.362–.683 即连续出现 16 次 429，后续仍持续触发。在这段用户窗口，工具执行、文件编辑、provider 事件和普通 `/session/status` 轮询一起产生上传。服务器明确要求冷却，客户端仍发送其他事件，是旧版持续拒绝的直接机制。

### beta.85：上述缺陷已经修复，但没有主动控制总发送速率

tag beta.85 包含 `c718e882db`：

- 429 和 503 都暂停该 credential 的本进程队列；新事件与重试都受 pausedUntil 约束。
- Retry-After 最大可等待 24 小时，不再把日限流截断成 5 分钟；普通陈旧事件会丢弃，保留高优先级终态。
- 但 pump 只保证串行发送，不保证每分钟不超过 60。一次请求只需十几毫秒时，串行队列仍然能快速耗尽分钟预算。
- 队列及 pausedUntil 是模块内存状态，并非 main、sidecar、多窗口、其他设备之间共享的凭据调度器。

本次 beta.85 在 16:54:50 触限，积压诊断随后于 16:55:00 起恢复提交；21:01:13 触限后，一些 21:01:50 产生的业务诊断于 21:02:01 后提交。与等待分钟窗口重置的实现一致。

图片场景也会放大诊断：一次成功 upload 产生 create、upload、complete 各 started/ok 6 个事件，加本地 HTTP 完成事件，共至少 7 次上传；多图操作加模型步骤很容易超过 60/min。另一突发窗口含大量会话/消息读取事件，不能只靠抑制 `/session/status` 解决全部流量。

Gateway 边界：

- `/gateway/client-events/diagnostics` 跳过普通 rateLimitHook，使用 `credentialId:diagnostics` 的独立 limiter；messages 又是另一 key。诊断 429 不会占满模型 concurrentRequests=4。
- 默认 60/min、2,000/day，本窗口聚合告警全部是 request_minute；返回 Retry-After 正常。没有证据支持通过重启恢复。
- 当前先限流再去重，重传相同 event_id 仍消耗接入预算；高频重复可以污染观测。应讨论批量/摘要协议、优先级与幂等计数，并保留防滥用保护。
- 5 条聚合告警不是只有 5 次拒绝。精确计数要使用 HTTP 访问指标；聚合日志中被抑制的末批可能没有下一条来带出，不能直接求和替代计数。

责任：beta.77 优先升级到含队列修复的版本；beta.85 继续增加主动节流、事件合并、进程间共享预算或集中上传出口。Gateway 负责公布/协调遥测预算与准确指标，不应仅放大上限。

验证：对与 beta.85 一致的当前 diagnostic-upload 实现运行 3 项针对性测试，覆盖 Retry-After、凭据队列暂停、重试耗尽仍暂停，全部通过。首轮测试结束钩子超时；按显式 `--timeout 60000` 复跑后 3 pass、0 fail、16 assertions，4.27 秒。未发真实遥测测试请求。

## 三、图片并发：两个资源域共享名额导致失败

9 月 26 日 16:54:53.431，beta.85 准备创建一张 47,218 bytes 的 PNG。凭据并发上限为 4。当时四个在途请求可由起始时间、耗时和路由日志完全还原：

| Request ID | 路由 | 开始 | 完成 |
| --- | --- | --- | --- |
| `req-9d176cff-ff0c-4c77-bbae-091fa6354a99` | vision asset complete | 16:54:48.904 | 16:54:56.800 |
| `req-0c4c36aa-f265-42c9-b327-f569ed878c8b` | vision asset complete | 16:54:50.807 | 16:54:55.795 |
| `req-9db2b551-ada2-4d6b-965f-6215484dc292` | 模型 chat/completions，xAI 视觉 | 16:54:52.851 | 16:55:57.472 |
| `req-19cd7405-4c2c-4d1a-b07c-14820143e92d` | vision asset complete | 16:54:52.990 | 16:54:58.665 |

- 新 create：`req-fb4ee3ee-6b91-483d-9424-9b7a3204e268`，16:54:53.431，2 ms 内 429。
- 重试 create：`req-ff8595ba-38e5-48ef-8f4a-cf3edc5d3c32`，16:54:54.462，仍为 429。
- 首个名额要到 16:54:55.795 才释放，所以 1 秒后重试仍失败是可解释的，不是计数泄漏。上述四笔最终均成功。
- 客户端 operation `c9387cd4-dd45-4e5a-842f-1d4e584ceb3a` 最终记录 vision_asset_create/429；同一本地上传请求随后显示 `/experimental/vision/assets` HTTP 502。

**Gateway 应承担的设计责任：**

- 已部署代码只给 read-url 分离了 `vision_read_url` limiter，create、complete、delete 仍与模型共享普通 credential 限制。不能拿 9 月 20 日的旧 read-url 问题解释本次事件。
- complete 要等待 R2 校验，本次三笔耗时 4.99–7.90 秒；与模型放在同一并发池会让正常附件操作互相阻塞。
- 应将附件控制接口作为独立、有上限的资源域，并明确按 subject/credential 计数、速率、在途释放及取消规则。不能取消保护，也不能简单把某个用户 concurrentRequests 改大当永久修复。
- concurrency 的 Retry-After=1 是建议再试的最小等待，不保证一秒后必有空位；本次 429 符合现行策略，没有长期占用不释放的证据。

**客户端应承担的实现责任：**

- upload 管线没有跨请求/会话统一的凭据并发调度。R2 PUT 是直传，不占 Gateway HTTP 名额；create/complete 调度必须与模型请求的资源约束协调。
- `vision-asset.ts/gatewayRequest` 遇到 429 仅等待后再试一次；`retryDelay` 把等待最多截断为 2 秒。本次服务端要求 1 秒，因此截断不是本次直接原因，但长期是协议缺陷。
- `gatewayError` 能保留 status=429；`handlers/experimental.ts/mapVisionError` 却只转移 code/message/requestID，丢弃 status；`VisionAssetUploadError` 固定 `httpApiStatus: 502`。这是明确的客户端错误转译缺陷。code/message 仍可能显示具体并发原因，但 HTTP 与重试语义已经失真。
- 应有界排队，按剩余预算、Retry-After 和抖动重试；失败保留附件草稿，并把 429、limit_kind、retry_after_seconds、request_id 传到界面。禁止无限重试。

## 实施顺序与验收建议

1. 客户端：修复图片 429→502 和上传排队；旧 beta.77 升级；遥测集中调度并提前节流。
2. Gateway：图片 create/complete 等接口独立预算，验证多图上传与正在运行的模型不会争抢同一池；取消和异常释放也要覆盖。
3. 双端：优先补齐“服务端成功、客户端未确认”的关联/恢复契约；客户端增加睡眠恢复、无进展期限及实际配置诊断。
4. 验收须包括：模型在途时多图上传、Retry-After 大于 2 秒、同凭据跨窗口、收到 429 后的新事件、上传完成响应丢失、模型返回前后断网/休眠恢复。客户端不应重复执行已确认完成的工具；无法确认时应显式呈现不确定状态。

源码定位：Gateway `apps/gateway/src/http/rate-limit.ts`、`vision-asset-routes.ts`、`services/client-event-ingest.ts`、`services/rate-limiter.ts`；Desktop `session/prompt.ts`、`provider/provider.ts`、`medcode/diagnostic-upload.ts`、`medcode/vision-asset.ts`、`server/routes/instance/httpapi/handlers/experimental.ts` 和同层 `groups/experimental.ts`（均位于 `packages/opencode/src`）。
