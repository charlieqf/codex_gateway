# Codex Gateway 轻量监控、预警与报警实施方案

| 项目 | 内容 |
| --- | --- |
| 状态 | 待审核、待批准实施 |
| 日期 | 2026-07-14 |
| 版本 | v2（根据实现性审核意见修订） |
| 适用环境 | Azure 生产 Gateway、独立阿里云监控 VM |
| 主要目标 | 提前发现请求卡住、错误激增、上游异常、内存/磁盘/PID 接近失控及服务不可用 |
| 通知渠道 | Email；Critical/Emergency 追加 SMS |
| 云服务依赖 | 不依赖 Azure Monitor、Application Insights 或 Azure Action Groups |
| 推荐组件 | 阿里云运行 Gatus；Azure 运行只读 watchdog/systemd timer |

## 1. 结论

建议采用“外部黑盒监控 + Gateway 本机白盒巡检”的双层方案：

```text
独立阿里云 VM
  └─ Gatus（非 root、单程序、systemd 限额、仅监听 loopback）
       ├─ 从公网检查 Gateway 健康、TLS 和延迟
       ├─ 同机 canary timer 采集模型首字节/总耗时并推送到 loopback
       ├─ Email 通知
       └─ Critical/Emergency -> SMS

Azure Gateway VM
  └─ root-owned 只读 watchdog + systemd timer
       ├─ 主机内存、PSI、磁盘、inode
       ├─ Docker health/restart/OOM/PID/内存
       ├─ Codex 临时 SQLite、rollout 隔离区和持久 SQLite/WAL 增长
       ├─ request_events 错误率、延迟、首字节和上游账号状态
       └─ Email/SMS；必要时输出受控恢复建议，但默认不自动重启
```

该结构解决两个不同问题：

1. Azure 整机、网络或公网入口失效时，阿里云仍能发现并报警；
2. 公共 `/gateway/health` 仍返回正常、但模型请求卡住或主机资源逼近极限时，Azure 本机 watchdog 能提前报警。

阿里云 VM 资源足够承载轻量监控，但它同时运行重要的 MedEvidence 应用。因此首期不安装 Docker、Node、Prometheus 或 Grafana，不开放新的公网端口，不修改现有 Nginx、Mihomo、防火墙或业务服务。监控程序必须使用独立用户、loopback 监听和 systemd 硬资源限制。

## 2. 背景与问题范围

近期生产现象包括：

- 模型长时间无首字节或总响应时间异常，客户端表现为持续生成不出来；
- 客户端看到 `internal server error`、`high demand`、额度/频率受限等泛化信息；
- Gateway 日志曾出现 `Codex Exec exited with signal SIGKILL`、`terminated` 和 `The operation was aborted`；
- 容器曾发生重启，需区分 OOM、人工重建、进程退出和宿主机资源压力；
- Codex Max 历史 rollout 回填曾让单请求临时写入约 4–5.3 GB，造成磁盘和内存连锁压力；
- 单纯检查 HTTP health 无法判断模型是否能在合理时间内产生首字节，也无法识别某一上游账号失效或拥塞。

本方案覆盖：

- 外部可用性、DNS、TLS 和公网延迟；
- Gateway 主机及容器资源；
- 请求耗时、首字节、错误率和并发异常；
- 上游模型、账号池和 GoldenCode 成员状态；
- Max 临时状态和 SQLite/WAL 异常增长；
- 邮件、短信、去重、恢复通知和维护静默；
- 监控系统自身的隔离、验收和回滚。

本方案不直接实施：

- 自动扩容、自动切换云主机或自动修改上游账号配置；
- 无条件自动重启 Gateway、Docker、Nginx 或整机；
- 自动删除 Codex rollout、SQLite、WAL、日志或 Docker 数据；
- 在监控配置、日志或仓库中保存真实 API key、SMTP 密码或 SMS token；
- 用真实用户 key 或真实用户提示词做探针。

## 3. 2026-07-14 基线

### 3.1 Azure Gateway VM

近期只读巡检和已完成的生产验证显示：

- 主机约 15 GiB 内存，无 swap；
- Gateway 容器内存上限为 6 GiB，PID 上限为 256；
- 最近巡检时容器约使用 289 MiB，`RestartCount=0`、`OOMKilled=false`；
- 系统盘约 123 GB，已使用约 82 GB，可用约 42 GB；
- Docker volume 约 22.48 GB，是磁盘容量规划的重要组成部分；
- Gateway 当前使用启动时 rollout 安全归档，Max 修复后的临时 state 峰值已由数 GB 降至约 13–19 MB；
- 生产仍需对归档失败、临时 state 回归、持久 SQLite/WAL 异常增长设置强告警。

上述数据只是阈值起点，不代表持续容量保证。阈值必须同时使用绝对剩余量、使用百分比和短时间增长率，避免“大盘百分比正常但瞬时写入已不可控”。

### 3.2 独立阿里云 VM

2026-07-14 只读巡检结果：

| 项目 | 结果 |
| --- | --- |
| CPU | 4 vCPU |
| 系统负载 | 约 `0.48 / 0.19 / 0.06` |
| 内存 | 约 15 GiB，总可用约 13 GiB |
| Swap | 未配置 |
| 系统盘 | 99 GB，已使用约 7.4 GB（8%） |
| inode | 使用约 2% |
| 短时 CPU/I/O | 基本 100% idle，无明显 I/O wait |
| systemd | 无 failed unit |
| 现有业务 | MedEvidence 服务组、Nginx、Mihomo 等重要程序 |
| 容器/运行时 | 未安装 Docker、Podman、Node 或 Monit |
| systemd journal | 约 3.9 GB，不应再引入高频大日志 |
| 到 Gateway 连通性 | 连续 5 次 health 均为 HTTP 200，总耗时约 0.55–0.76 秒 |

结论：资源和跨云连通性适合运行轻量外部监控，但必须避免为了监控安装 Docker，也不能占用或修改现有 `80/443`、Nginx 和业务服务。

## 4. 设计原则

1. **跨故障域**：外部监控必须在 Azure 之外运行。
2. **只读优先**：监控只采集状态；恢复动作默认由运维确认后执行。
3. **不与业务争抢资源**：阿里云监控进程设置 CPU、内存、任务数和磁盘上限。
4. **不暴露管理面**：首期仅监听 `127.0.0.1`，通过 SSH tunnel 查看面板。
5. **不依赖单一 health**：同时检查公网、真实模型、主机资源和被动请求事件。
6. **不把用户错误当系统事故**：认证失败、用户主动取消、上下文过长和单用户并发超限需单独分类。
7. **告警必须可行动**：通知包含环境、指标、当前值、阈值、首次发生时间、持续时间、建议 runbook 和恢复状态。
8. **敏感信息最小化**：不记录提示词正文、完整 key、上游 token、手机号或 SMTP/SMS 凭据。
9. **安全测试**：不得通过填满磁盘、制造 OOM 或停止生产 Nginx 来验证告警。
10. **可回滚**：监控组件与业务目录、服务、端口完全分离。

## 5. 组件选型

### 5.1 外部监控：Gatus

首期选择 Gatus，而不是 Uptime Kuma 或完整 Prometheus/Grafana：

- 单一轻量 Go 服务，适合没有 Docker 和 Node 的现有 VM；
- 支持 HTTP、TCP、DNS、TLS、响应体和响应时间条件；
- 原生支持 SMTP Email、Twilio 等通知，也可通过 custom provider/webhook 接国内 SMS；
- 支持 failure threshold、恢复通知和状态页面；
- 配置可审计，部署和回滚范围小。

首期 Gatus 只负责：

- 公共 health；
- DNS/TLS/证书有效期；
- 公网响应时间；
- 接收同机专用 canary timer 通过 loopback 提交的模型探针结果；
- Email/SMS 分发。

Gatus 的普通 HTTP 检查用于判断完整响应耗时；精确的 time-to-first-byte 由同一阿里云 VM 上的轻量 canary timer 使用 `curl` 指标采集。canary 只向本机 Gatus loopback external endpoint 提交成功/失败和 sanitized 耗时，不需要新增公网 push 入口。

首期不把 Gatus 面板暴露到公网。若以后确需中心化 push heartbeat，再单独评审专用域名、Nginx location、鉴权、速率限制和证书，不与本次首期部署捆绑。

### 5.2 Azure 本机：Gateway watchdog

watchdog 建议作为仓库内脚本加 root-owned systemd oneshot service/timer：

- 每 30 秒采集便宜的主机和容器指标；
- 每 60 秒通过容器内只读 `ops-snapshot` 聚合最近 5/15 分钟 `request_events`；
- 每 5 分钟检查状态目录、SQLite/WAL 和 rollout 归档状态；
- 用本地状态文件完成连续次数、去重、恢复判定和重复通知控制；
- 读取动作均设定超时，任何单项检查不得拖住下一轮；
- 默认不执行 `docker restart`、文件删除、WAL truncate 或进程 kill。

当前超时能力必须按路径区分：

- 图片请求已有 Gateway 请求总超时；
- GoldenCode、OpenRouter 等 OpenAI-compatible adapter 已有单次上游调用超时，当前默认 300 秒；
- Max/Codex adapter 只接收客户端断开传入的 abort signal，没有 Gateway 主动触发的请求总 deadline；
- 跨重试、工具调用和 `/v1/responses` 的统一 chat 请求总 deadline 尚未实现。

因此“provider attempt timeout”和“Gateway request total deadline”不得混用。阶段 3 实施前，卡住告警只能依据活动请求年龄；阶段 3 必须把可配置、按 runtime/model 区分的请求总 deadline 与 `ops-snapshot` 一起作为前置交付物。

Azure 宿主机历史上没有 system Node，只有用户目录下的 Node。root-owned watchdog 不应依赖可由普通用户修改的 Node binary。主机资源采集使用受限 shell；请求事件、活动请求和容器内 `/tmp` 采集优先使用 Gateway 镜像内的 Node，通过带超时的 `docker exec -T` 调用。

推荐后续仓库文件：

```text
ops/monitoring/gatus/config.yaml.example
scripts/ops/gateway-host-watchdog.sh
scripts/ops/gateway-request-watchdog.mjs
scripts/ops/gateway-model-canary.sh
deploy/systemd/codex-gateway-watchdog.service
deploy/systemd/codex-gateway-watchdog.timer
deploy/systemd/gatus.service
docs/operations/gateway-monitoring-runbook.md
```

示例文件不得包含真实 hostname、key、SMTP 密码、SMS token、邮箱或手机号。

### 5.3 可选后续组件

- **Beszel**：需要图形化查看多主机 CPU、内存、磁盘和容器历史时再加入；
- **Prometheus + Alertmanager**：服务器规模扩大、需要长期指标和复杂聚合时再引入；
- **ntfy/Gotify**：需要自建移动端 push 时加入，不能替代运营商 SMS；
- **GSM modem + SIM**：需要短信链路也完全自建时使用，硬件和 SIM 运维成本较高。

## 6. 监控项与初始阈值

阈值分为 Warning、Critical 和 Emergency。上线前先采集 7 天基线；以下数值是首期保护阈值，可在不放宽 Emergency 边界的前提下调优。

### 6.1 外部可用性

| 检查 | Warning | Critical/Emergency | 备注 |
| --- | --- | --- | --- |
| `/gateway/health` | 连续 2 次失败 | 连续 3 次失败；完全无法连接立即 Critical | 30 秒一次，10 秒超时 |
| health 状态 | 非 `ready` 1 次 | 连续 2 次非 `ready` | 同时检查 JSON 字段 |
| 公网响应时间 | > 2 秒，连续 3 次 | > 5 秒，连续 3 次 | 不等同于模型延迟 |
| TLS 证书 | 剩余 < 21 天 | < 7 天；< 2 天为 Emergency | 每 6 小时检查 |
| DNS | 连续 2 次解析异常 | 连续 3 次或解析到非预期地址 | 地址变更需维护静默 |

外部探测失败时，告警必须区分 DNS、TCP connect、TLS handshake、HTTP 状态和响应体错误，避免全部显示为“Gateway down”。

### 6.2 Azure 主机资源

| 指标 | Warning | Critical | Emergency |
| --- | ---: | ---: | ---: |
| `MemAvailable` | < 3 GiB 持续 5 分钟 | < 1.5 GiB 持续 2 分钟 | < 750 MiB 单次 |
| Memory PSI `some avg60` | > 10% 持续 5 分钟 | > 25% 持续 2 分钟 | `full avg60` > 10% |
| 根盘使用率 | >= 75% | >= 85% | >= 92% |
| 根盘绝对剩余 | <= 25 GiB | <= 12 GiB | <= 6 GiB |
| 磁盘增长 | > 2 GiB/10 分钟 | > 5 GiB/10 分钟 | > 8 GiB/10 分钟 |
| inode 使用率 | >= 75% | >= 85% | >= 92% |
| load/CPU | load > vCPU 数持续 10 分钟 | load > 2×vCPU 数持续 5 分钟 | PSI/业务失败同时出现 |

百分比与绝对剩余量按“任一条件触发”。磁盘增长率必须排除已知备份维护窗口，并记录增长最大的一级目录，但不得遍历或输出业务文件内容。

当前 Azure 无 swap。是否新增 swap 属于独立容量与性能决策，不在监控部署中自动实施。

Memory/IO PSI 依赖内核提供 `/proc/pressure/memory` 和 `/proc/pressure/io`。阶段 2 dry-run 必须先做能力探测；缺失时将该指标标记为 `unsupported` 并继续其他检查，不能把缺失解释为 0 压力，也不能让整轮 watchdog 失败。

### 6.3 Gateway 容器和 Codex 子进程

| 指标 | Warning | Critical/Emergency |
| --- | --- | --- |
| Docker health | 1 次 unhealthy | 连续 2 次 unhealthy |
| RestartCount | 发生增加立即 Warning | 10 分钟内增加 >= 2 次为 Critical |
| OOMKilled | 不适用 | 任意一次立即 Emergency |
| 容器内存（6 GiB limit） | >= 4.5 GiB 持续 2 分钟 | >= 5.4 GiB；>= 5.8 GiB 为 Emergency |
| 容器 PID（limit 256） | >= 200 | >= 230；>= 245 为 Emergency |
| Codex 子进程 | 数量超过允许并发 + 2 | 超过 2 倍允许并发或持续不退出 |
| 最老运行请求 | > 300 秒 | > 600 秒；总 deadline 上线后，超过 deadline 30 秒仍存在为 Emergency |
| 启动归档 | 出现 warning | 出现 `Codex rollout startup archive failed` 立即 Critical |

RestartCount 告警要保存上次观测值，不能因为历史值大于零而每轮重复报警。必须同时读取 `OOMKilled`、容器退出码、宿主机 kernel OOM 日志和部署时间，区分资源事故与计划重建。

在阶段 3 请求总 deadline 上线前，“> 600 秒”只是监控阈值，watchdog 不得声称 Gateway 已经执行超时或释放请求。deadline 上线后，超时必须归一化为 `upstream_timeout`，并验证非流式返回 504、流式发送失败事件、账号租约/concurrency 释放、临时目录回收以及 Codex 子进程无残留。

### 6.4 Max 状态目录和 SQLite

| 检查 | Warning | Critical/Emergency |
| --- | --- | --- |
| 单个请求级临时 state | > 128 MiB | > 512 MiB 立即 Critical |
| 所有请求级临时 state 合计 | > 256 MiB | > 1 GiB；> 3 GiB 为 Emergency |
| 临时 state 年龄 | 请求结束后 > 10 分钟 | > 30 分钟 |
| 单次 5 分钟增长 | > 128 MiB | > 512 MiB |
| 持久 `state_5.sqlite`/WAL | > 128 MiB/10 分钟 | > 512 MiB/10 分钟 |
| rollout 隔离区 | 按日容量报告 | > 2 GiB/日异常增长 |

512 MiB 是防止“简单请求重新回填数 GB 历史”的回归阈值，不是正常请求应接近的容量。报警只报告路径类别、字节数、mtime、关联 request id 和上游账号，不读取、上传或打印 rollout/提示词内容。

请求级 `codex-gateway-state-*` 位于 Gateway 容器的 `/tmp`，属于容器 writable/overlay 层，并未挂载到宿主机普通目录。宿主机 watchdog 必须使用带 5–10 秒超时的 `docker exec -T` 在容器内进行第一层目录、大小和 mtime 采集。容器 unhealthy 或无法 exec 时：

- 将该项标记为 `container_introspection_unavailable`，不能记录为 0 字节或正常；
- 继续使用宿主机 `df`、Docker health/restart/OOM 和低频 writable-layer size 作为降级证据；
- 连续两轮无法采集为 Warning；同时出现 health、磁盘或重启异常时升级为 Critical。

生产 `gateway.db` 在容器内为 `/var/lib/codex-gateway/gateway.db`，由 Docker volume `codex_gateway_test_gateway_state` 持久化。优先方案是让容器内 `ops-snapshot` 使用镜像自带 Node 读取该路径。若容器仍可 inspect 但无法 exec，备用宿主机路径必须通过 `docker volume inspect` 动态解析 mountpoint，不能硬编码 `/var/lib/docker/volumes/...`。SQLite 连接必须使用 `readOnly: true`、1 秒 busy timeout 和 `PRAGMA query_only = ON`；禁止使用会忽略 WAL 变化的 `immutable=1`，禁止在监控进程中执行 migration 或任何会修改数据库/持久配置的 PRAGMA。首期不得为此调用用户目录 Node；如果没有经批准的 root-owned 宿主机读取器，容器无法 exec 时直接标记 DB 采集 degraded，备用 mountpoint 仅用于人工只读取证或后续受控实现。

禁止 watchdog 自动执行：

- `rm` 临时目录；
- 删除 rollout 隔离区；
- `PRAGMA wal_checkpoint(TRUNCATE)`；
- 移动仍可能被原生 session 引用的 rollout；
- kill 无法证明归属于已超时请求的进程。

这些动作必须进入 runbook，由运维确认进程归属、引用关系和备份后执行。

### 6.5 请求延迟和错误

被动聚合使用 `request_events`，至少按 `public_model_id`、`upstream_account_id`、`status`、`error_code`、`limit_kind` 和时间窗口分组。

`request_events` 只在请求结束或连接关闭后写入，不能用于发现仍在运行的请求。当前实现对从未产生首字节的已结束请求，会把结束时间作为 `first_byte_ms`；这适合事后延迟统计，但不能替代实时状态。因此：

- p95、错误率和已结束请求使用 `request_events`；
- `oldest_inflight`、`waiting_first_byte` 和 deadline 后残留必须来自阶段 3 新增的 Gateway 进程内活动请求注册表；
- 活动注册表必须在所有成功、失败、客户端断开、超时和异常路径的 `finally` 中清理，并由 `ops-snapshot` 只读输出聚合值。
- 首期活动注册表在 begin、首次字节、路由更新和 finish 时同步原子发布小型 JSON。对当前最多 10 名试用用户的低并发规模可接受；扩容前应加入最小写间隔/合并写入，至少保留 begin 与 finish 的及时发布，并对 first-byte/route update 去抖。去抖实现必须保证进程退出前的最终空快照和异常路径清理可观察，不能单纯延迟所有写入。

| 指标 | Warning | Critical |
| --- | --- | --- |
| 首字节时间 | p95 > 120 秒，样本 >= 5 | p95 > 300 秒或连续 3 个请求 > 300 秒 |
| 总耗时 | p95 > 300 秒，样本 >= 5 | p95 > 600 秒或存在活动年龄 > 600 秒的请求 |
| 基础设施错误率 | >= 20%，且样本 >= 5 | >= 40%，且样本 >= 5 |
| 基础设施错误码合计 | 5 分钟 >= 3 次 | 5 分钟 >= 5 次或涉及 >= 3 个用户 |
| `client_aborted` | 15 分钟异常增幅 | 与长首字节/资源压力同时出现时 Critical |
| 上游 high demand/429 | 单账号连续 >= 3 次 | 所有可用账号同时受限或 10 分钟无成功请求 |
| concurrency | 单用户短时事件仅记录 | 5 分钟涉及 >= 3 个用户或系统 inflight 无法下降 |

`internal server error` 是客户端可见文案，不是 `GatewayErrorCode`，不得作为数据库规则键。告警规则使用以下真实错误码分类：

| 分类 | `error_code` | 默认处理 |
| --- | --- | --- |
| 基础设施 | `upstream_timeout`、`upstream_unavailable`、`service_unavailable`、`provider_reauth_required`、`subscription_unavailable` | 计入基础设施错误率 |
| 条件分类 | `rate_limited` | 必须按 `limit_kind` 和上游尝试信息消歧 |
| credential/权限 | `missing_credential`、`invalid_credential`、`revoked_credential`、`expired_credential`、`forbidden_scope` | 默认不计入；多用户突增为 Warning |
| plan/额度策略 | `plan_inactive`、`plan_expired`、`plan_capability_required` | 默认不计入基础设施错误率 |
| 请求/客户端 | `invalid_request`、`unsupported_parameter`、`model_not_found`、`unsupported_model`、`unsupported_size`、`unsupported_quality`、`unsupported_format`、`content_policy_violation`、`context_length_exceeded`、`client_aborted` | 默认不计入；按相关性另行告警 |
| 工具兼容性 | `tool_call_validation_failed` | 单次记录；多模型或多用户突增为 Warning |
| 控制面 | `invalid_event_type`、`invalid_period`、`invalid_external_user_id`、`idempotency_conflict`、`idempotency_in_progress`、`idempotency_expired`、`subject_not_found`、`subject_already_exists`、`plan_not_found`、`entitlement_not_found`、`credential_not_found`、`entitlement_already_active`、`invalid_entitlement_transition`、`session_not_found` | 不进入 chat 基础设施错误率；由对应控制面规则处理 |

`rate_limited` 的来源必须按以下顺序判定：

```text
error_code != "rate_limited"
  -> 不进入本规则

error_code = "rate_limited" AND limit_kind IS NOT NULL
  -> Gateway 本地用户/request/token/concurrency 策略限制
  -> 默认不计基础设施错误率

error_code = "rate_limited" AND limit_kind IS NULL
  AND (upstream_account_id IS NOT NULL OR upstream_attempts_json 有上游尝试)
  -> 上游账号/模型 429 或 high demand
  -> 计入上游受限规则

其余
  -> rate_limit_origin_unknown
  -> Warning，结合 sanitized provider 日志确认
```

`request_events.rate_limited` 布尔列只能作为快速筛选：Gateway 本地限流和上游 429 都会写为 true，本身不能消歧。`upstream_account_id` 也不能单独作为来源依据，因为 token policy 可能在选定 runtime 后触发；`limit_kind` 是否非空是当前 schema 的首要判据。若生产仍持续出现 `rate_limit_origin_unknown`，再评审新增显式 `rate_limit_origin` 列。

基础设施错误率默认包含：

- `upstream_timeout`、`upstream_unavailable`、`service_unavailable`；
- `provider_reauth_required`、`subscription_unavailable`；
- Codex 子进程 SIGKILL/terminated/aborted；
- 上游账号不可用、认证失效或全池 cooldown；
- 阶段 3 deadline 上线后的 Gateway 总请求超时。

阶段 3 前，活动年龄超过 600 秒只触发卡住告警，不得写成“已达到 Gateway 硬超时”。OpenAI-compatible adapter 当前的 300 秒单次 provider timeout 继续有效，但它不等于跨重试、工具调用和 `/v1/responses` 的请求总 deadline。

默认不计入系统错误率：

- 缺少或错误 credential；
- 用户主动取消；
- 用户自身 RPM/RPD/concurrency 超限；
- 输入校验、model not found；
- 明确的上下文窗口超限。

但同一类“用户错误”若在多个用户中突然激增，仍应作为 Warning，防止客户端版本或配置回归被误分类而漏报。

### 6.6 上游账号与 GoldenCode

- 任一上游账号从 active 进入 cooldown：Warning；
- 任一账号进入 `reauth_required`：Critical；
- 同一模型所有账号不可用：Critical；
- GoldenCode 单个池成员连续 3 次失败：Warning 并临时降低探针频率；
- GoldenCode 全池 5 分钟无成功请求：Critical；
- sticky session 指向已禁用或不存在账号：Critical；
- 上游账号错误通知不得包含 token、`auth.json`、设备码或第三方原始敏感响应。

## 7. 合成模型探针

### 7.1 探针层级

1. **L1 health**：每 30 秒，零模型成本；
2. **L2 轻量模型探针**：每 5 分钟，优先 GoldenCode，短输入、短输出、无工具；
3. **L3 Max 探针**：每 2 小时，短输入、严格输出上限，最多 12 次/天；
4. **L4 工具闭环探针**：每 6 小时，最多 4 次/天，验证 Codex App `/v1/responses` 或工具调用闭环。

L2/L3/L4 必须串行运行，避免制造 SQLite 写锁或把探针自身变成并发压力源。

L2/L3/L4 由阿里云上的独立 systemd canary timer 执行。脚本使用 `curl` 的 connect、start-transfer 和 total 时间，完成后把 sanitized 结果提交到 `127.0.0.1` 上的 Gatus external endpoint；Gatus 负责连续次数、incident 状态和通知。脚本不得监听端口。

首期固定成本边界：L2 最多 288 次/天，L3 最多 12 次/天，L4 最多 4 次/天；若 L4 使用 Max，则计入同一个“Max 合计最多 12 次/天”上限，而不是额外增加。失败重试也计入对应上限。阶段 0 不再以“待确认”代替数字；后续只能经评审降低频率或调整上限。

### 7.2 专用 key

- 创建专用 `monitor-canary` 用户和 key；
- 不复用吴杰、沈杰等真实用户 key；
- `rpm=1`、`concurrent=1`、`rpd=365`，并由 canary 自身另行执行 L2/L3/L4 分项硬上限；
- 设置明确失效日期并纳入轮换提醒；
- key 只保存在 root-only `0600` secret/config 文件；
- 不把 Authorization header 放入命令行、日志、邮件或状态页面；
- 探针请求事件应有可识别且精确配置的 subject/credential id；用户影响统计、quota dashboard 和普通用户错误率必须显式排除这些 id，不能只依赖 label 命名约定；
- 排除只影响用户影响报表，探针消耗仍保留在独立 canary 用量报表，并计入上游账号实际额度。

### 7.3 超时与成功标准

- connect timeout：10 秒；
- L2 首字节 Warning 120 秒、canary 客户端硬停止 300 秒；
- L3 首字节 Warning 180 秒、canary 客户端硬停止 600 秒；
- 探针子进程退出后必须确认没有残留；
- 成功要求 HTTP/协议正确、首字节在阈值内、流正常结束且响应满足固定短断言；
- 禁止把完整模型回答写入报警，只保留 request id、耗时、状态和少量固定断言结果。

上述“canary 客户端硬停止”由阿里云探针的 `curl --max-time` 实现，只限制该探针调用，不代表生产 Gateway 已具备请求总 deadline。

## 8. 告警等级、路由与降噪

| 等级 | 典型事件 | 渠道 | 重复策略 |
| --- | --- | --- | --- |
| Info | 恢复、部署开始/结束、每日摘要 | Email | 单次 |
| Warning | 容量逼近、单账号 cooldown、延迟升高 | Email | 30 分钟，最多 3 次 |
| Critical | Gateway 不可用、错误激增、所有上游受限、磁盘/内存危险 | Email + SMS | 10 分钟，直到确认或最多 6 次 |
| Emergency | OOMKilled、磁盘即将写满、持续重启、失控增长 | Email + SMS 给全部值班人员 | 5 分钟，并要求人工确认 |

降噪规则：

- 一般指标连续 2 次异常才触发；OOMKilled、磁盘 Emergency 和证书 < 2 天例外；
- 恢复需要连续 2–3 次正常，防止抖动；
- 相同环境、根因和指标在一个 incident 内去重；
- “Azure host down”触发后抑制其下游 container、health 和模型探针重复告警；
- 计划部署、证书切换和演练必须设置有起止时间的 maintenance silence；
- 每条报警必须发送 resolved 通知；
- SMS 只用于 Critical/Emergency，Warning 不发短信；
- 每日摘要列出过去 24 小时 incident、恢复时间、错误率、p95 和剩余容量。

## 9. Email 与 SMS 实施

### 9.1 Email

使用独立 SMTP relay 或企业 SMTP，不依赖 Azure 服务。配置包括：

- 专用发件账号；
- 多个运维收件人；
- TLS 校验开启；
- 使用 app password，不使用个人主密码；
- 发件限额和退信告警；
- 至少每月执行一次测试通知。

### 9.2 SMS

优先级：

1. 国内手机号为主时，使用阿里云短信/腾讯云短信，通过受控 custom webhook 适配；
2. 国际手机号或已具备 Twilio 账号时，使用 Gatus 原生 Twilio；
3. 如要求短信链路完全自建，另行部署 USB 4G/GSM modem + SIM + `gammu-smsd`。

监控和规则引擎可以完全自建，但真正发送运营商 SMS 必须依赖短信服务商或物理 modem/SIM。首期不建议在承载重要应用的阿里云 VM 上接入 USB modem。

### 9.3 凭据保护

- secrets 不进入 Git；
- 阿里云 Gatus 配置和环境文件权限为 `0600`，目录为 `0700`；
- systemd service 使用 `EnvironmentFile` 或 root-only 配置；
- 日志过滤 Authorization、SMTP 密码、SMS token、手机号和完整邮箱列表；
- 报警中只显示 key prefix，不显示完整 key；
- secret 轮换后执行通知 smoke，并确认旧 secret 已失效。

## 10. 阿里云安全部署边界

### 10.1 运行身份和目录

建议：

```text
user/group:          gatus:gatus
binary:              /usr/local/lib/gatus/gatus
config:              /etc/gatus/config.yaml
secret env:          /etc/gatus/gatus.env
state:               /var/lib/gatus
listener:            127.0.0.1:<dedicated-port>
```

配置和状态目录不得位于现有 MedEvidence 应用目录内。

### 10.2 systemd 限制

初始硬限制：

```ini
User=gatus
Group=gatus
MemoryMax=256M
CPUQuota=10%
TasksMax=64
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/gatus
Restart=on-failure
RestartSec=10s
```

部署时按 Gatus 实际文件访问需求补充最小权限。不得为了图方便使用 root、`ProtectSystem=false` 或开放整个 `/opt`、`/etc` 写权限。

### 10.3 网络和日志

- 首期仅 outbound 访问 Gateway、SMTP、SMS API 和 DNS；
- 不修改防火墙、Nginx 或现有公网端口；
- 面板使用 SSH tunnel 访问；
- Gatus 不保存响应正文，不显示敏感 URL query/header；
- 设置服务级日志限速；
- 状态库设定容量预算 1 GiB，达到 70%/90% 分别告警；
- 不修改全局 journald 策略，避免影响现有重要应用的取证日志。

## 11. Azure watchdog 安全边界

- root-owned、不可被 Gateway 容器用户修改；
- 所有 Docker/SQLite/文件检查使用只读命令；
- 每个子检查设置 5–10 秒 timeout；
- 状态和锁文件放在独立目录，使用原子 rename；
- 同一时刻只允许一个 watchdog 实例；
- 不读取容器完整 environment；
- 不输出 `auth.json`、API key、请求正文或 rollout 内容；
- 不自动重启 Nginx、Docker daemon、Gateway 或 VM；
- 不自动清理磁盘；
- 若后续批准有限自愈，只允许经过独立评审的明确动作，并设冷却、次数上限和审计日志。

运行时约束：

- Azure 宿主机资源脚本不得假设存在 system Node；
- `gateway-request-watchdog.mjs` 和 `ops-snapshot` 使用 Gateway 镜像内 Node，通过 `timeout 10s docker exec -T ...` 执行；
- 容器无法 exec 时，宿主机 shell 继续采集 Docker/主机指标，请求/临时目录采集标记 degraded，不能回报正常；
- 生产 DB 优先读取容器内 `/var/lib/codex-gateway/gateway.db`；备用宿主机路径只允许从 Docker volume mountpoint 动态解析；
- 所有 SQLite 监控连接强制 read-only、1 秒 busy timeout 和 `PRAGMA query_only = ON`。

建议把以下状态作为 Gateway 内部只读 `ops-snapshot` 管理命令输出，而不是新增公网 endpoint：

```text
inflight_requests_by_model
oldest_inflight_age_seconds
oldest_waiting_first_byte_age_seconds
upstream_account_state
upstream_account_inflight
recent_timeout_and_abort_counts
temporary_state_directory_count_and_bytes
```

输出必须是聚合值和内部 id，不包含用户提示词或 secret。

其中前三项不能从 `request_events` 推算，必须由 Gateway 进程维护活动请求注册表。注册表至少保存 request id、public model、upstream account/runtime、开始时间、首字节时间和 deadline；不保存提示词或响应正文。所有完成、错误、断开和超时路径必须在 `finally` 中移除记录。

阶段 3 还必须实现统一的 chat 请求总 deadline：

- 可按 runtime/model 配置，并与现有 provider 单次调用 timeout 分开；
- 将 deadline signal 与客户端断开 signal 合并，覆盖非流式、流式、严格工具、原生工具、重试和 `/v1/responses`；
- deadline 触发后归一化为 `upstream_timeout`，非流式返回 504，流式发出失败事件后结束；
- 在 `finally` 中释放 upstream lease、credential concurrency、活动注册表和临时 state；
- 对 Codex 路径验证 abort 后子进程/进程组在 30 秒内退出，否则触发 Emergency；
- 在该功能部署前，所有文档和报警只能称为“活动年龄阈值”，不能称为 Gateway 硬超时。

## 12. 分阶段实施

### 阶段 0：审核与准备

- 确认收件邮箱、短信号码及值班分组；
- 确认 SMTP 和 SMS 服务商；
- 确认短信模板报备要求；
- 确认专用探针模型；首期固定 L2 288 次/天、L3 12 次/天、L4 4 次/天，Max 合计不超过 12 次/天；
- 确认 canary subject/credential id 的用户影响统计和 quota dashboard 排除配置；
- 确认 Azure watchdog 使用容器内 Node，不依赖宿主机 system Node 或用户目录 Node；
- 预检容器 `/tmp` 采集、Docker volume mountpoint 动态解析和 SQLite read-only 连接；
- 评审统一 chat 请求总 deadline 的 runtime/model 配置、流式错误语义和上线前 observe-only 基线；
- 审核 systemd hardening 和目录；
- 记录维护窗口，但不停止现有业务。

### 阶段 1：阿里云外部监控

1. 下载固定版本 Gatus release，记录制品 SHA-256；若发布方提供 checksum/signature，则同时完成校验；
2. 创建 `gatus` 用户、目录和 root-only 配置；
3. 配置 loopback listener 和 systemd hard limits；
4. 首批只配置 public health、DNS、TLS 和响应时间；
5. 使用本地故障 fixture 验证 Email、SMS、去重和 resolved；
6. 观察 24 小时资源和日志，再进入下一阶段。

验收期间必须确认现有 MedEvidence 服务、Nginx、Mihomo、CPU、内存和端口均未受影响。

### 阶段 2：Azure 主机资源 watchdog

1. 预检 `/proc/pressure/memory`、`/proc/pressure/io`；缺失时记录 `unsupported`；
2. 预检带 timeout 的 `docker exec -T`、容器 `/tmp` 和 unhealthy 时的 degraded 路径；
3. 先以 `--dry-run --no-notify` 运行，保存 24 小时基线；
4. 启用 Warning Email；
5. 用 fixture/阈值覆盖测试 Critical 和 Emergency，不制造真实资源压力；
6. 启用 SMS；
7. 检查 systemd timer 无重叠、无残留进程、日志不含 secret。

### 阶段 3：请求事件和卡住检测

1. 实现 Gateway 进程内活动请求注册表，以及容器内只读 `ops-snapshot` 命令；
2. 实现按 runtime/model 配置的 chat 请求总 deadline，并覆盖非流式、流式、工具、重试和 `/v1/responses`；
3. 验证 deadline 归一化为 `upstream_timeout`、协议错误输出正确、所有 lease/concurrency/state/子进程完成清理；
4. 使用 read-only SQLite 连接按模型/账号聚合 `request_events`；
5. 输出 oldest inflight、waiting-first-byte、deadline 和 deadline 后残留指标；
6. 按真实 `GatewayErrorCode` 分类，使用 `limit_kind` 消歧本地与上游 `rate_limited`；
7. 对 `rate_limit_origin_unknown` 和容器/DB 采集降级设置独立 Warning；
8. 验证真实历史事件能够触发预期等级，但不发送给正式收件人。

### 阶段 4：合成模型探针

1. 签发专用、低额度、可撤销 key；
2. 先启用 GoldenCode L2；
3. 稳定 48 小时后启用 Max L3；
4. 最后加入低频工具闭环 L4；
5. 强制执行 L2/L3/L4 分项日上限和 Max 合计 12 次/天上限；
6. 按精确 subject/credential id 将探针从普通用户影响统计和 quota dashboard 中排除，但保留独立可用性与用量报表。

### 阶段 5：可选集中化

只有在确需远程状态页面或 Azure 主动 push 到阿里云时才实施：

- 申请独立监控域名；
- 单独评审 Nginx location、TLS、鉴权、限流和来源限制；
- 不把现有 MedEvidence vhost 变成监控默认站点；
- 不直接公开 Gatus 管理界面；
- 变更前备份并验证 Nginx config，维护窗口内上线。

## 13. 验收测试

### 13.1 功能验收

- health 正常时不报警；
- 本地 fixture 连续失败达到阈值后只产生一个 incident；
- Email 和 SMS 到达全部指定人员；
- 恢复后产生 resolved；
- maintenance silence 期间不发送正式报警；
- DNS、TLS、HTTP、响应慢显示为不同根因；
- GoldenCode 和 Max 探针均能记录首字节、总耗时和 request id；
- 被动事件聚合正确排除探针用户和正常的用户限流；
- `rate_limited + limit_kind` fixture 被归为 Gateway 本地策略，`rate_limited + limit_kind=null + upstream attempt` 被归为上游限制；
- `internal server error` 只作为客户端症状展示，规则查询只使用真实 `GatewayErrorCode`；
- 活动请求注册表能够在请求尚未结束时报告 oldest inflight 和 waiting-first-byte；
- 请求总 deadline 覆盖非流式、流式、严格/原生工具、重试和 `/v1/responses`；
- deadline 返回/流式失败语义正确，且 30 秒内无残留 lease、concurrency、临时目录和 Codex 子进程；
- deadline 上线前的 observe-only/纯年龄规则不会误报“Gateway 已执行硬超时”。

### 13.2 资源与隔离验收

- Gatus 常态资源显著低于 `MemoryMax=256M` 和 `CPUQuota=10%`；
- 监控异常时 systemd 限额生效，不影响现有业务；
- 没有新增公网监听；
- 没有安装或启用 Docker/Podman；
- 没有修改现有 Nginx、防火墙、Mihomo 和 MedEvidence unit；
- Gatus 停止/启动不影响任何业务服务；
- Azure watchdog 单轮执行时间小于 timer 间隔且不存在并发实例；
- Azure watchdog 不依赖宿主机 system Node 或用户目录 Node；
- PSI 存在时正确采集，缺失时标记 `unsupported` 且其他检查继续；
- 容器无法 exec 时 `/tmp` 和请求指标标记 degraded，不会被记录为正常或 0；
- SQLite watchdog 连接为 read-only/query-only，遇到 1 秒 busy timeout 后降级退出而不阻塞 Gateway。

### 13.3 安全验收

- `git grep`、journal 和报警正文中不存在真实 key/token/password；
- 文件权限符合 `0600/0700`；
- Gatus 进程为非 root；
- 状态页面不显示内部地址、Authorization header 或完整错误响应；
- 模型探针不会输出用户数据；
- 所有测试凭据均可列出、审计、轮换和撤销。

### 13.4 演练方式

允许：

- 使用仅本机可见、固定返回 500 或延迟的测试 endpoint；
- 用保存的 sanitized fixture 测试 OOM/restart/SQLite 增长规则；
- 临时降低测试环境阈值；
- 撤销专用 canary key 验证认证告警后立即恢复。

禁止：

- 填满生产磁盘；
- 真实制造 OOM；
- 停止生产 Nginx 或 Docker daemon；
- kill 无法证明归属的生产 Codex 进程；
- 并行运行多个真实 Max smoke；
- 使用真实用户 key 做演练。

## 14. 回滚方案

### 14.1 阿里云

1. 停止并 disable `gatus.service`；
2. 确认专用 loopback listener 消失；
3. 保留配置和状态快照用于审计；
4. 在确认无需恢复后删除 Gatus 专用 binary/user/directories；
5. 验证现有 MedEvidence、Nginx、Mihomo 和端口状态不变。

由于首期不改 Nginx、防火墙和 Docker，回滚不涉及现有业务配置。

### 14.2 Azure

1. 停止并 disable watchdog timer；
2. 确认没有运行中的 watchdog/canary 子进程；
3. 撤销专用 canary key；
4. 保留 sanitized incident/state 记录；
5. 不回滚 Gateway 业务 release，不触碰生产 SQLite 和 rollout 数据。

## 15. 运维流程

收到报警后的首要动作：

| 报警 | 首查 |
| --- | --- |
| 外部 health down | 阿里云到公网的 DNS/TCP/TLS；Azure VM 和 Nginx；Gateway container health |
| 首字节/总耗时高 | request id、模型、上游账号、oldest inflight、Codex 子进程、容器资源 |
| OOM/SIGKILL | kernel OOM、Docker OOMKilled、MemoryCurrent/limit、PID、同时期请求 |
| 磁盘增长 | 增长目录类别、临时 state、SQLite/WAL、rollout 隔离区、Docker volume |
| high demand/429 | 账号池状态、cooldown、影响模型、成功账号数量；不要直接重启 |
| concurrency | 单用户还是多用户、inflight 是否正常下降、是否存在泄漏 |
| startup archive failed | 暂停高并发 Max，检查引用/manifest/目录安全条件；禁止直接删除 |

每个 incident 应记录：

- 首次/最后异常时间和时区；
- 告警规则、当前值和阈值；
- 受影响模型、账号、用户数和请求数；
- 代表性 request id；
- 部署版本和最近变更；
- 采取的动作、恢复时间和根因；
- 是否需要调整阈值或增加回归测试。

## 16. 实施风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 监控与阿里云重要应用争抢资源 | 非 root、CPU/内存/任务硬限制、loopback、分阶段观察 |
| 外部 health 绿但模型卡住 | 被动请求事件 + oldest inflight + 合成模型探针 |
| 短信服务商或 SMTP 故障 | 双渠道、恢复通知、月度测试；Critical 可配置第二短信渠道 |
| 跨境网络波动误报 | 连续失败阈值、分解 DNS/TCP/TLS、与 Azure 本机指标互证 |
| 探针消耗额度或制造压力 | 专用低额度 key、严格串行、短输出、分项日上限和 canary 客户端 timeout |
| 报警风暴 | 去重、抑制、分组、重复次数上限和维护静默 |
| secret 泄露 | root-only 文件、日志脱敏、仓库示例无值、轮换与审计 |
| 自动恢复误杀请求 | 首期无自动重启/kill/删除；人工 runbook 确认 |
| 监控自身失效 | systemd restart、每日 heartbeat/test notification、外部与本机互补 |

## 17. 待审核决策

- [ ] 同意使用 Gatus 作为阿里云外部监控，不安装 Docker/Node。
- [ ] 同意阿里云 Gatus 首期仅监听 loopback，不新增公网入口。
- [ ] 同意 Azure 使用 root-owned 只读 watchdog/systemd timer。
- [ ] 同意 Warning 仅 Email，Critical/Emergency 使用 Email + SMS。
- [ ] 确认 SMTP 服务商、发件地址和收件人列表。
- [ ] 确认 SMS 服务商、报备模板和接收号码。
- [ ] 同意创建独立 `monitor-canary` key，不使用真实用户 key。
- [ ] 同意首期 L2 288 次/天、L3 12 次/天、L4 4 次/天，且 Max 合计不超过 12 次/天。
- [ ] 同意按精确 canary subject/credential id 从普通用户影响统计和 quota dashboard 排除，同时保留独立用量。
- [ ] 同意阶段 3 实现按 runtime/model 配置的统一 chat 请求总 deadline；上线前仅使用活动年龄阈值。
- [ ] 同意真实 `GatewayErrorCode` 分类表，以及使用 `limit_kind` 消歧本地和上游 `rate_limited`。
- [ ] 同意 Azure 请求 watchdog 使用容器内 Node、带 timeout 的 `docker exec -T` 和 read-only/query-only SQLite。
- [ ] 同意 512 MiB 作为单请求临时 state Critical 回归阈值。
- [ ] 同意首期不启用自动重启、自动 kill 或自动磁盘清理。
- [ ] 同意先观察 7 天基线，再评审 Warning 阈值；Emergency 阈值不得自动放宽。

## 18. 交付物与完成标准

实施完成应交付：

1. 无 secret 的 Gatus 配置模板和固定版本记录；
2. hardened systemd unit；
3. Azure host/request watchdog、dry-run 模式和容器采集降级逻辑；
4. Gateway 活动请求注册表、只读 `ops-snapshot` 和统一 chat 请求总 deadline；
5. 真实错误码分类、`rate_limited` 消歧和 canary dashboard 排除实现；
6. 专用 canary key 的安全签发、轮换和撤销记录；
7. Email/SMS 通知矩阵；
8. 告警规则单元测试和 sanitized fixtures；
9. 生产验收记录；
10. `gateway-monitoring-runbook.md`；
11. 回滚验证记录；
12. 7 天基线与阈值复审报告。

完成标准：能够在不依赖 Azure 监控服务、不影响阿里云现有重要应用的前提下，分别发现 Gateway 整体不可用、模型卡住、错误激增、上游账号异常、容器 OOM/restart、内存/磁盘/PID 临界和 Max 状态放大，并向多名运维人员发送可行动、可去重、可恢复的 Email/SMS 通知。

## 19. 参考资料

1. Gatus 官方仓库与功能说明：<https://github.com/TwiN/gatus>
2. Gatus Email 告警：<https://gatus.io/docs/alerting-email>
3. Gatus 告警配置：<https://gatus.io/docs/alerting-getting-started>
4. Gatus endpoint 类型：<https://gatus.io/docs/endpoints>
5. 本项目 Max 磁盘放大修复：`docs/implementation/codex-max-sqlite-disk-amplification-solution-2026-07-13.zh-CN.md`
6. 本项目生产访问与安全边界：`docs/operations/environment-access.md`
7. 本项目运维经验：`docs/operations/operational-experience.md`
8. Gateway 真实错误码枚举：`packages/core/src/errors.ts`
9. Request observation 与 `rate_limited`/`limit_kind` 落库：`apps/gateway/src/http/observation.ts`
10. OpenAI-compatible provider 单次调用 timeout：`apps/gateway/src/services/openai-compatible-provider.ts`
11. Codex adapter 临时 `/tmp` state 与上游 429 归一化：`packages/provider-codex/src/codex-adapter.ts`
12. 现有 SQLite read-only/query-only 模式：`apps/admin-cli/src/commands/client-event-queries.ts`
