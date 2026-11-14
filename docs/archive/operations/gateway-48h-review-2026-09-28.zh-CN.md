# Gateway 过去 48 小时检查

后续 [深入责任边界调查](../../operations/client-timeout-upload-boundaries-2026-09-28.zh-CN.md) 已确认：31 分钟任务中有约 27 分钟的客户端未确认等待，而对应 Gateway 请求已在 4.89 秒完成；62 次诊断限流关联 beta.77 的 59 次和 beta.85 的 3 次；图片并发为 3 个 complete 校验与 1 个模型请求共享名额。以下保留本轮统计及初步分析，具体根因以深入调查为准。

统计窗口：2026-09-25 22:05:30.686 至 2026-09-27 22:05:30.685 UTC，即北京时间 9 月 26 日 06:05 至 9 月 28 日 06:05。只读检查 R760 请求事件、客户端诊断、Gateway 容器日志、Nginx 当前及轮转日志，并验证公网健康。未修改生产配置、数据或重启服务。

## 结论

Gateway 持续健康，双平台仍启用。窗口内没有记录到模型上游超时、供应商 5xx 或 Nginx 5xx；实际存在客户端断开、客户端整轮任务超时、模型长耗时、诊断上传突发限流和图片资产创建并发限流。不能把全部鉴权拒绝算成业务故障，也不能把 HTTP 200 等同于整轮任务完成。

## 服务与请求

- 当前发布 `3d4c10a85bb3d0aa393d30b6be40bf4777740e84`，Gateway 自 2026-09-24 10:11:59 UTC 启动，healthy、restart count 0、OOMKilled=false。
- 公网 health 为 ready，关联 Research 容器均 healthy。抽样 Gateway CPU 0.10%、内存 285.5 MiB / 6 GiB；根盘使用 59%、数据盘 15%。这只是当前资源快照，不是过去 48 小时峰值。
- 未结算 token reservations 为 0。
- Nginx 公网 14,804 次请求：200=6,627，201=6,643，401=1,457，409=6，426=2，429=64，204=4，499=1；5xx=0。目标 Nginx error 日志窗口内未发现错误。
- Gateway request_events 共 4,378 条，2,918 ok、1,460 error。它不是全部 HTTP 访问表，不与 Nginx 总数等同。
- 模型请求 238 次，涉及 6 个 subject；234 ok、4 client_aborted，完成率 98.32%。全部只记录 1 次上游尝试，未发现故障切换/重试挽救后成功或 length 截断。

## 模型表现

耗时分位数只统计成功请求；P95 为按样本排序的近邻分位数，不是同输入对照测试。

| 平台 | 成功 | 客户端断开 | 总耗时 P50 | P95 | 最长 | 成功消耗 tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 天宽 `official/glm-5.3` | 133 | 2 | 13.84 s | 143.75 s | 488.83 s | 7,812,347 |
| 腾讯 `glm-5.3` | 74 | 2 | 14.99 s | 78.47 s | 237.37 s | 5,486,027 |
| xAI `grok-4.5` 视觉路由 | 27 | 0 | 16.71 s | 63.86 s | 64.62 s | 1,636,161 |

腾讯和天宽保持 `hrw_sticky` 会话粘性分配，天宽文本请求占比约 64%，不应按逐请求 50/50 判断故障。不同会话大小、用户数少和请求复杂度都会影响分布。

29 次成功请求超过 60 秒，5 次超过 180 秒。最长请求 `req-05d69bca-9f95-4151-a6ba-6e9432155fb1`：

- 9 月 27 日 08:58:44.970 UTC 开始，天宽，beta.77，high reasoning。
- 总耗时 488,832 ms，上游耗时 488,775 ms；Gateway 额外耗时很小。
- 输入 42,202 tokens，输出 44,492 tokens，其中 reasoning 34,639 tokens；以 tool_calls 正常结束。
- 说明此次等待主要发生在上游长推理/生成阶段，不是 Gateway 排队超时。没有原始上游网络跟踪，不能进一步区分供应商内部排队与推理阶段的全部耗时。

腾讯最长请求 `req-a39b105a-b4f3-49a0-93e2-77abc50cb929` 耗时 237.37 秒，reasoning 14,013 tokens，也以 tool_calls 正常结束。不能仅凭本窗口 P95 判定天宽在同输入下比腾讯慢。

## 报错与超时定位

1. **鉴权拒绝主要是扫描流量。** request_events 有 1,453 次 missing_credential 和 1 次 invalid_credential。Nginx 对应大量 `/.env`、`/.git/config`、`/index.php` 等探测路径，1,453 次 401 集中在同一记录来源。没有证据表明这些是已登录用户的模型调用失败。另有 3 次 logout 的 401。
2. **4 次模型中断归因为客户端连接断开。** 腾讯 88.916 秒、1.850 秒各一次；天宽 28.260 秒、56.647 秒各一次，全部 `terminal_source=client_abort` 且 cancel_requested/cancel_observed 均为 1。beta.85 的 1.850 秒请求与客户端明确的 user_action/stop 对应，其余 3 次不能仅凭 Gateway 记录认定为用户手动停止，也可能是客户端或网络中断。
3. **有 1 次客户端整轮任务超时。** 支持码 `T:4HXWNFQM`、beta.77，2026-09-27 10:31:54 UTC 报 `agent_time_limit_exceeded`，`provider_error_source=desktop`、持续 1,869,896 ms，约 31.16 分钟，错误已展示给用户。相同 message_id 在 09:43:57 和 10:00:44 有两次 turn started，不能把整个时间跨度当成一次连续运行；Gateway 共记录 19 次请求、17 次成功、2 次连接断开，成功用量共 1,485,134 tokens。此问题在多步任务/恢复/时间预算层面，不是单次上游 timeout。
4. **客户端工具网络失败。** beta.85 有 10 次 webfetch 的 HttpClientError，8 次集中在约 10.6 秒，两组各 4 个并行调用。属于客户端取网页环节；未看到对应 Gateway 模型 5xx。另有 beta.81 的 phone_auth_authorization_pending/request_timeout 一次，仅凭该条无法进一步归因。
5. **业务拒绝。** 5 次 billing subjects HTTP 409、1 次 unified-keys/resolve HTTP 409；后者日志为 account_migration_required。2 次 login/start HTTP 426 是版本门槛响应。这些需要按账户/兼容性问题处理，不属于上游模型不可用。

4 次 client_aborted request IDs：

- `req-42062c19-7339-4739-b567-9be6fbaff24c`
- `req-57ee883a-9f24-4957-b1f9-902694d9848c`
- `req-163e4c25-ea57-45d3-8e95-640ee18f3e0f`
- `req-ee6cc9ab-0d5c-4bdd-8427-16e5fd98d6cb`（客户端明确 stop）

## 限流与循环

- 诊断上传成功 6,565 次、HTTP 429 共 62 次，拒绝率约 0.94%。5 组聚合告警都为 Gateway 的 credential/minute 限制：60 次/分钟，Retry-After 为 9–47 秒。没有记录到日额度告警。仍存在短时突发，不能因为比之前减少就认为客户端上传问题已经修复。
- 另外 2 次 HTTP 429 来自 `/gateway/vision/assets`，同一 subject 在 9 月 26 日 08:54:53 和 08:54:54 UTC 连续触发 concurrency。客户端同时有 vision_asset_create/429 和本地 `/experimental/vision/assets` 的 502 记录；公网 Gateway 没有 502，提示客户端错误转译需要检查。
- Tool loop guard 产生 62 条 shadow 告警，涉及 4 个 subject、17 个 turn；25 条达到 would_finalize 条件。最多 prior_consecutive_tool_calls=17，最长 elapsed 约 30.97 分钟。当前只记录、不改变请求；告警不是 62 个独立故障，但表明长循环确实存在。
- 48 小时收到 6,565 条客户端诊断，其中 6 条 created_at 早于窗口，属于延迟上传。客户端事件定位按 created_at/请求关联检查，未把这些历史补传算作当前故障。

## 建议优先级

1. **客户端先处理长任务体验和恢复。** 核对 beta.77 的 `T:4HXWNFQM`：整轮预算、断线恢复是否复用旧时间预算、请求状态确认、重复生成和用户可见进度。对高 reasoning 的长工具生成提示当前阶段，并持久化已完成步骤；不能只延长 HTTP 超时。
2. **客户端处理突发。** 诊断上传按凭据做共享节流和 Retry-After 冷却；图片资产创建控制并发，保留 Gateway 的 429 错误语义，避免显示成笼统的本地 502。
3. **Gateway/客户端联调循环保护。** 先用这 17 个 turn 回放评估 shadow 告警及 25 次 would_finalize 的准确性，再决定预算提示和收尾策略；本次没有直接将 shadow 改成强制终止。
4. **监控分开统计。** 将公网扫描 401、业务冲突、诊断 429、模型错误、用户停止和整轮超时分开；同时跟踪平台 P95 和 reasoning tokens。保留腾讯+天宽路由，当前证据不支持因服务故障停用任一平台。
