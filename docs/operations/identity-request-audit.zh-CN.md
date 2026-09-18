# Gateway 身份请求审计：只读排查与覆盖边界

适用于包含本次身份请求出口的程序及 schema 34。`71689e3` 已于 2026-09-18 08:36 UTC 上线，详见[发布验收记录](./r760-identity-request-audit-release-2026-09-18.zh-CN.md)；后续实际运行版本仍需现场核对。

## 请求事实与安全事件

- `identity_request_events`：已完成的普通身份 HTTP 请求，包含最终状态、公开错误码、内部原因和当时取得的身份事实。
- `identity_rate_limit_minutes`：Gateway 手机号登录限流的 UTC 分钟计数。phone／IP／device 是三个固定维度，不是三个用户分组。
- `phone_auth_audit_events`：事务内安全事件。刷新轮换成功不代表之后的就绪检查及整个 HTTP 请求成功。
- 人工开户 HTTP 202 只表示受理；用返回的任务 ID 查询任务最终状态及补偿结果。

本次覆盖的是 Gateway 开户、关联及模型凭据登录，不是外部短信验证码校验。

## 先按 request ID 定向查询

通过既有 R760 SSH 受控入口，在 Gateway 容器中执行以下只读命令。时间使用明确的 UTC ISO 值；示例 ID 是占位值。

```bash
docker exec codex_gateway_r760-gateway-1 \
  node /app/scripts/query-identity-requests.mjs \
  --db /var/lib/codex-gateway/gateway.db \
  --since 2026-09-18T00:00:00Z --until 2026-09-19T00:00:00Z \
  --request-id '<request-id>' --limit 100
```

需要核对当时的完整手机号时，在同一定向查询上增加 `--include-phone`，仅在受控运维终端查看。默认输出脱敏；禁止把完整结果复制到普通日志、公共工单或 Git。

其他定向条件：

- `--phone '<phone>'`：使用既有大陆手机号规范化规则，匹配当时输入或业务确认的手机号。
- `--provider '<provider>' --external-user-id '<external-id>'`：必须同时提供两个字段。
- `--subject-id '<subject-id>'`：匹配已确认、请求指定或单一冲突账户；查看具体字段以区分含义。
- `--job-id '<job-id>'`：关联人工开户 HTTP 请求，不代替后台任务记录。

完整手机号不应用于共享命令历史；已有 request ID 时优先使用它。查询不加载会自动迁移的常规 Store，不执行登录、补登记、清理或权益状态推进。

## 分页与 429 的解读

- 时间窗口最长 31 天；`--limit` 为 1–500，默认 100。
- 普通请求按完成时间和 request ID 降序；将 `nextCursor` 作为 `--cursor` 继续，保持原时间和筛选条件不变。
- `rateLimits` 是独立的分钟汇总，不随普通请求分页而累计。多页重复出现的桶只能计一次。
- 429 总数使用 `SUM(rejection_count)`，不能用桶数量代替请求数。
- 任意秒级时间窗口会向外取整到分钟；以 `actualFrom`、`actualUntil` 为实际统计范围。
- 仅保留首尾请求及手机号样本；按 request ID／手机号命中样本，不表示桶中其他请求也属于这个身份。计数始终是整个桶的计数。
- Subject、外部身份或任务筛选不能给分钟计数归属，相关 `rows` 返回 `null`。
- `truncated=true` 时缩小分钟查询时间范围；不能将截断结果当作总量。

## 空结果不等于没有发生

以下情况必须在调查结论中区分：

1. 未解析 JSON、在版本／鉴权门禁提前拒绝时，手机号可能尚不可用，见 `phone_capture_status`。
2. 输入手机号与 `resolved_phone` 来源不同；请求方指定的目标 ID 也不等于已验证归属。
3. 断连记录 `aborted` 和空 HTTP 状态，不表示客户端收到了 499，也不能据此认为开户已回滚。
4. 新表不存在时返回 `legacy_security_only`；旧安全记录不是完整 HTTP 历史，不能显示为“零失败”。
5. 首次上线前、回滚期间、进程崩溃及审计落盘失败可能缺失请求；还要核对发布时间、重启和告警。
6. 旧记录不回填手机号或内部原因。不能借当前账户状态推断当时那次未归因 409 的请求体。

## 巡检、告警与留存

三个消费者统一区分新 HTTP 请求和 legacy 安全记录：

- `scripts/export-user-accounts.py`：受控账户工作簿，限流单列分钟统计，不归给样本账户。
- `scripts/ops/audit-phone-conflicts-r760.mjs`：冲突与请求结果分类。
- `scripts/ops/audit-phone-auth-readiness-r760.mjs`：只读身份／Key 就绪检查；不执行可能更新状态的权益评估。

保留已有 Pino 5xx、认证存储故障和补偿未完成告警。新增审计存储失败是观测故障，不能掩盖原始业务告警：

- `identity_request_audit_write_failed`：出口写入失败，业务响应不变；核对丢失计数、磁盘、SQLite 写入冲突和进程状态。
- `identity_request_audit_recovered`：恢复后报告进程已知丢失次数，不补造缺失请求。
- `identity_request_audit_prune_failed`：留存清理失败；检查实际最旧记录和积压，不能只相信配置期限。

初始目标留存是明细 30 天、分钟计数 7 天。清理每分钟最多处理每表 500 行，不在请求路径清理，不自动 VACUUM。每表每天最多 72 万行；持续过期明细超过约 8.33 行/秒时会形成积压，需复审清理容量，不能继续宣称实际留存严格为 30 天。备份和导出同样包含完整手机号，应遵守受控权限和留存要求。

在受控只读连接中检查积压（不执行删除）：

```sql
SELECT MIN(completed_at) AS oldest,
       COUNT(*) AS expired_requests
FROM identity_request_events
WHERE completed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days');

SELECT MIN(minute_start) AS oldest,
       COUNT(*) AS expired_buckets
FROM identity_rate_limit_minutes
WHERE minute_start < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days');
```

部署／回滚遵循 [容器发布手册](./container-deploy.md)。审计为追加表迁移，优先回退已验证兼容的程序并保留新表；不得用旧整库备份覆盖持续增长的生产账本。
