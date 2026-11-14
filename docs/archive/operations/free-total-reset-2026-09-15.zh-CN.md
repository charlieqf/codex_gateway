# 免费总额度重置回执

- 对象：手机号尾号 4759，Subject `subj_GhISouthMW04s8QnqOYP2aJF`。
- 授权：用户明确要求重置该手机号额度。
- 套餐：`plan_free_once_1m_v1`，总额度 1,000,000 Token，无其他有效套餐。
- 重置前：已用 985,925，剩余 14,075，未结算预留 0。
- 拒绝证据：`req-6a0681ea-bf4f-45cd-bc03-041f9c6dbac7`，2026-09-15 04:43:44.129 UTC，`goldencode`，`free_quota_exhausted` / `token_total`。
- 执行时间：2026-09-15 06:07:16.956 UTC（北京时间 14:07:16.956）。
- 操作：受控 wrapper `reset-free-total`，核对 Subject、Entitlement、原已用值及总额度；事务内拒绝未结算预留，仅重置一次性免费总额度窗口并写入审计。
- 结果：已用 0，预留 0，剩余 1,000,000；历史请求、结算记录及其他窗口保留。
- 审计 ID：`audit_7c280e000c45473e889080392a483863`，包含重置前完整窗口记录。
- 备份：`/data/backups/codex-gateway/r760-control-pre-control-state-sync-20260915T060651Z-4900453d.db`，323,760,128 bytes。
- 备份 SHA-256：`fe0d1aa993d3bd23ca0389cc074af5bcc784ea7705fea699b673253966244501`。
- 备份及操作前后校验：schema 30，SQLite quick_check=ok，外键违规 0。
- 公网复核：06:08:17.494 UTC，管理额度接口 HTTP 200；目标账号 active，quota_exhausted=false，free_total.limit=1,000,000、used=0、reserved=0、remaining=1,000,000。
- 服务状态：healthy，restart_count=0。本次操作无需重启或部署。
- 工具验证：10 项 SQLite 重置/保护/回滚测试及 7 项 wrapper 测试通过；线上 dry-run 通过后执行。

现有 Billing quota-reset API 只接受 minute/day/month，不能重置一次性免费额度的 period 窗口。本次补充的是受控运维命令，未改变用户默认赠送额度或客户端 API。
