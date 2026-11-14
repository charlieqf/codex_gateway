# Gateway 最近 48 小时检查（2026-10-02）

统计窗口为 **2026-09-30 02:12:48.137 至 2026-10-02 02:12:48.137 UTC**，即北京时间 **9 月 30 日 10:12 至 10 月 2 日 10:12**；时间范围左闭右开。只读检查 R760 的 request_events、token_reservations、model_calls、客户端诊断、当前 Gateway 容器日志，以及完整窗口的 Nginx 当前/轮转日志，并检查当前公网健康。数据库以 readOnly 和 PRAGMA query_only=ON 打开。

## 结论

当前 Gateway 健康。完整窗口没有记录到公网 5xx、504、429 或模型上游最终 timeout/5xx。8 次模型连接中断均有关联任务的客户端 stop 诊断；部分客户端与服务器时钟有偏差，不能要求各条时间完全一致。

实际需要跟进的是：3 次模型接口 HTTP 409 与客户端 Call ID 时间超前约 91 秒吻合；3 次客户端模型配置错误；10 月 1 日集中出现的 44 次调用上游前耗时超过 5 秒。此外，长工具执行和长推理仍会带来等待，但本窗口没有发现客户端整轮任务超时诊断。

## 当前服务状态

- 实际发布为 `2378c8e44e0eead62458caa01024e1c1a38ccf9f`，与既有发布记录一致。
- 当前 Gateway 容器自 2026-10-01 02:22:31 UTC 启动，healthy、RestartCount=0、OOMKilled=false。这个重启计数仅针对当前容器，不代表整个 48 小时没有发布重建。
- 公网 health=ready，draining=false、active_requests=0、active_work=0。Research 三个相关容器也 healthy。
- 资源采样：Gateway CPU 0.14%，内存 148.8 MiB / 6 GiB；根盘使用 66%，数据盘 16%。这些是当前快照，不是历史峰值。
- 当前未结算 token reservations 为 0。窗口内 580 笔聊天预留均有关联 request_events：572 笔 provider 结算、8 笔 estimate，对应成功请求与中断请求的数量；未发现已准入预留缺少请求完成事件。

## 访问与模型统计

以下均为窗口内全流量，包含试点/测试客户端，不宣称全部是普通真实用户调用。request_events 不是所有 HTTP 访问表。

| 数据来源 | 数量与结果 |
| --- | --- |
| 公网 Nginx | 13,758 次；200=6,837、201=5,888、401=958、426=48、499=15、409=6、204=5、400=1 |
| Gateway request_events | 5,038 条；ok=4,071、missing_credential=949、invalid_credential=7、client_aborted=8、error_code 为空的 error=3 |
| 已进入聊天/视觉模型 | 580 次；572 完成、8 客户端中断，完成比例 98.62% |
| 图片生成 | qwen-image-2.1 共 4 次，均成功，耗时 P50=77.00 秒、最长 78.59 秒 |
| 上述模型合计 | 584 次，涉及 11 个 subject；576 完成、8 客户端中断 |

公网 `/v1/chat/completions` 为 572 次 200、8 次 499、3 次 409。3 次 409 在调用上游前拒绝，不计入 580 次已进入模型的集合。

958 次公网 401 中有大量 `.env`、`.git/config`、PHP/后台路径扫描，以及少量 models/logout 等请求。不能把所有 401 归为已登录用户的业务故障。

## 模型耗时

仅统计成功调用，P50/P95 为排序后的近邻分位数；各平台输入和客户端构成不同，不是同输入对照。

| 平台 | 总调用 | 完成 / 中断 | P50 | P95 | 最长 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 腾讯 GLM-5.3 | 250 | 246 / 4 | 9.97 s | 72.65 s | 198.99 s |
| 天宽 GLM-5.3 | 147 | 144 / 3 | 9.11 s | 41.94 s | 158.81 s |
| xAI 视觉 grok-4.5 | 183 | 182 / 1 | 13.19 s | 59.20 s | 68.77 s |

572 次成功聊天/视觉调用总体 P50=10.80 秒、P95=63.61 秒；32 次超过 60 秒，2 次超过 180 秒。没有记录到输出 length 截断或最终 empty_stop。

最长请求 `req-6481549f-3442-4116-a9b2-c9ac4ba82101` 共 198.986 秒，provider_duration=198.765 秒。腾讯首次 `export_document` 工具参数 invalid_json，随后同平台修复成功，因此耗时包含两次上游生成，不是网络超时。另一次腾讯 export_document schema_mismatch 修复成功，耗时 173.884 秒；天宽一次 aipal schema_mismatch 也修复成功。本窗口共 3 次合同修复，均最终成功，不是供应商故障切换。

另一笔腾讯请求 `req-cc576acd-95e3-46e2-8cf4-f92e49b28967` 总耗时 180.719 秒，provider_first_event=173.649 秒，说明首次事件前等待较长；没有网络跟踪，不能进一步区分供应商内部排队、计算和传输的耗时。

## 需要跟进的问题

### 1. 模型接口 409：Call ID 与服务器时钟偏差

9 月 30 日 09:43:00–09:43:30 UTC，beta.88 有三笔新模型调用 HTTP 409，均只耗时 3–6 ms，未进入上游，没有 token 预留：

| 支持码 | Gateway request ID | Call ID 时间超前服务器 |
| --- | --- | ---: |
| T:Q76Z27DT | req-0017154a-2eb3-40d3-abc2-add3c3fd19d5 | 90,973 ms |
| T:P2FGAV8V | req-d49760a1-cfc8-4826-9135-985d01110697 | 90,956 ms |
| T:VFMRSPAN | req-f81931bb-a0de-4edd-ab9a-23703e9d65ed | 90,759 ms |

客户端诊断记录的 call_contract_accepted=true 不等于模型已经准入。当前代码会先设置协议响应头，再检查新 Call ID 的时间窗；未来超过 60 秒会返回 `model_call_expired`。这三笔 ID 时间超前超过门槛，且当前回执表没有对应记录，因此与时间窗拒绝一致。未取得这三笔原始响应错误正文，不把推断写成已读取的错误码。

这三条 request_events 的 error_code 均为空，表明该直接 409 路径存在分类观测缺口。应核对客户端系统时钟/服务端时间偏差处理，并补齐拒绝路径的错误码记录。不要通过不断换 Call ID 或重新生成规避恢复协议。

另有 beta.87 的 T:VFCNVDS9 在客户端报告 409、call_contract_accepted=false、delivery_state=unconfirmed、recovery_state=unknown，没有对应 Gateway request ID。公网日志没有该时刻的第四次 chat 409，不能直接计为第四次 Gateway 拒绝。

### 2. 调用上游前延迟集中出现

44 次成功调用 gateway_admitted_ms 超过 5 秒，最大 20.710 秒；全部集中在 10 月 1 日 01:58–05:33 UTC：38 次来自 beta.89，6 次来自 beta.88.imaging-test.5。最长例子 `req-df88ce3e-45c7-4f5e-994e-7ed96cf8da15` 总耗时 36.134 秒，其中调用上游前 20.710 秒、上游 15.422 秒。

该指标从 Fastify onRequest 开始，直到 markProviderCallStarted，包含请求体接收/解析、认证、准入、上下文处理等环节；不能仅凭它认定内部排队、数据库锁或供应商慢。延迟横跨发布切换前后，也不能直接归因于一次容器重建。

10 月 1 日 06:00 UTC 以后，16 次成功调用的此项最大值/P95 均为 640 ms；当前证据显示这是一段集中延迟，尚无持续异常证据。建议针对那段客户端上传时间、请求体大小及服务端分阶段耗时进一步定位。

### 3. 客户端模型配置、版本和登录路径

- beta.88 在 9 月 30 日约 09:52 UTC（客户端时间）记录 3 次 `ProviderModelNotFoundError`，provider_id=medcode、public_model_id=goldencode，耗时仅 2–3 ms；支持码 T:27PAKYY0、T:ZS826472、T:FCD8T24V。需要检查客户端模型注册/登录恢复状态，不能归为供应商处理失败。
- 48 次 HTTP 426：47 次 unified-keys/resolve、1 次 login/start。46 次 resolve 拒绝集中在 10 月 1 日 07:16–07:18 UTC。需要核对调用方的版本请求头和升级路径；仅凭 user-agent=node 无法断定具体旧版本或账户。
- beta.88 有一次 phone_auth_phone_signed_out / network_unavailable。缺少关联服务器请求，暂不能判断是客户端网络还是登录服务异常。
- 公网另外 3 次 billing subjects 409 属业务冲突，应与模型接口 409 分开统计。

## 客户端长等待、上传和恢复

- 收到 5,749 条诊断，其中 5,747 条 created_at 在窗口内，2 条为历史补传。客户端时钟可能有偏差，以 request ID、received_at 和服务器记录交叉定位。
- 没有发现 `agent_time_limit_exceeded` 或明确模型上游 timeout 诊断。
- T:Z68K74R7 的 transport duration=701.307 秒，但 Gateway `req-6e64c0b0-e826-4004-8492-3aac2d25f1f3` 只耗时 32.541 秒；客户端 write 工具自身耗时 668.500 秒。
- T:BT4MNGZB 的 transport duration=1,348.234 秒，但 Gateway `req-5aed8938-63d5-42a8-a419-2431e730e4db` 只耗时 6.889 秒；客户端 imaging 工具耗时 1,340.377 秒。两笔最终都成功。transport duration 不能直接用作模型 HTTP 等待时长。
- 诊断上传公网 201=5,748、幂等 200=8、499=6、429=0；消息上传 201=134、499=1。7 次遥测连接断开集中在 10 月 1 日 02:44–05:30 UTC，需与同段调用前延迟一起看，但没有因果证据。
- 图片资产 create=6、complete=6、read-url=9，均成功，没有 410 或 429。两个 complete 请求分别耗时 5.690/5.907 秒，最终 200。
- 客户端另有 37 条 updater.check 错误，以及工具执行、导出保护、会话本地 404 等；这些不是 Gateway 模型失败。
- 回执表正确使用毫秒整数 created_at 查询：窗口内有 549 条记录，目前 completed=96、expired=453。expired 是 24 小时保留期到期后的当前状态，不表示原调用失败。公网回执 GET 仅 1 次，不能据此证明断线恢复和结果复用已充分覆盖真实异常。

## 日志覆盖与发布影响

Nginx 当前及轮转日志覆盖完整窗口，目标 error 日志窗口内没有错误。10 月 1 日 02:22 UTC 的发布重建窗口，没有记录到公网 5xx；02:22:37/38 已有 health 200。这只证明已记录访问的结果，不能宣称维护期间每一秒或未到达 Nginx 的连接都可用。

Gateway docker logs 仅保留当前容器自 10 月 1 日 02:22:31 起的记录；窗口前半段依靠持久事件与 Nginx 补充。当前容器日志 30 条 tool-loop shadow 阈值告警，涉及 8 个 turn，其中 10 条 would_finalize，最大 elapsed=26.49 分钟。这是影子观测，不代表 30 次独立故障或已强制停止。唯一 Provider returned sanitized error 对应 client_aborted。

建议优先核对 Call ID 时钟偏差和 409 分类缺口，然后定位 44 次调用前延迟、客户端模型注册与版本门槛拒绝。继续追踪长工具任务进度和恢复，不宜仅延长模型 HTTP 超时。

本次没有修改生产配置、用户权益或数据库，没有重启、部署、重放用户任务或执行创建状态的 smoke。只新增本报告，保留仓库已有改动。
