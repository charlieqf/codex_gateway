# 付费套餐取消每日 Token 上限

2026-10-23 北京时间 13:10:44 生效，13:12:19 完成验证。用户要求取消套餐页面红框中的日 Token 限制，保留月额度。

| 套餐模板 | 每日 Token 上限 | 月额度 |
| --- | --- | --- |
| `plan_paid_monthly_v1` | 无，API 返回 null | 每计费月 150,000,000 |
| `plan_paid_yearly_v1` | 无，API 返回 null | 每 UTC 自然月 200,000,000，无额外年度总量上限 |

## 线上执行范围

通过 `manage-r760-gateway-control.py remove-paid-daily-limits` 执行，先预览、备份，再以预览 SHA-256 校验同一批对象，事务内修改并写审计。

- 修改 2 个套餐模板、12 条未到期权益快照（月付 7、年付 5）、1 个 Key 的独立日 Token 上限。
- 权益范围包含 active／paused／scheduled，不因账户停用而遗漏可恢复权益；不重开停用账户。
- 12 条权益中有 10 条属于活跃账户的 active 权益、2 条属于停用账户的 paused 权益。
- 仅将 `tokensPerDay` 改为 null；原月额度、周期、累计已用量、免费权益和追加 Token 余额保持。6 条旧月付快照仍为每月 100,000,000（其中 2 条 paused），并未统一改成新模板的 150,000,000。
- 请求次数、并发、每分钟 Token 与单次上下文等限制保持；日用量仍统计，null 不等于 0。
- 已取消／已过期权益保留历史记录。新购买与续费读取更新后的模板。

运行版本仍为 `954eb3bedca6648405fa419d232cdb4a43dbe8fc`，无应用重启或数据库 schema 变更。

## 验证

- 运维操作及原有模板修改测试 11 项通过；免费／付费账本、追加余额与 HTTP 合同回归 57 项通过。
- 公网 `GET /gateway/admin/billing/v1/plans` 返回 200；两个模板的 `tokens_per_day=null`，月额度分别为 1.5 亿／2 亿。
- 在已部署容器中用现行模板和实际限额器做内存数据库验证：两种套餐当天已用 700 万后均可继续预留并结算；月额度用尽后均拒绝并返回 `token_month`。新权益日限额均为 null。该边界验证未制造真实用户用量，也未调用上游模型。
- 与变更前备份比较：12 条权益和 1 个 Key 的目标字段正确，183 条原用量窗口保留；追加余额账本保留。SQLite quick_check=ok、外键违规 0、schema=44。
- 公网健康 ready，容器 healthy、RestartCount=0，启动时间保持 03:15 UTC。

备份：`/data/backups/codex-gateway/r760-control-pre-control-state-sync-20261023T051016Z-d74ab46d.db`，626,991,104 字节，权限 0400；SHA-256 `51d501480647a7dc9f14e6d01e0dab6bd8281553e4b63eab24d4146b305a5885`。

审计：`audit_44c54c02110a4f6a99984c816e4e0721`。本地脱敏回执：`.task-artifacts/paid-daily-limits-20261023/apply-result.json`、`verify-result.json`。

## 支付页／客户端交接

Gateway 已生效，截图中的支付页面不在本仓库；页面删除和展示验收由支付页所属团队完成。本次未修改外部页面。

1. 年付页删除“600万 Token/日 付费额度”和“日调用限额 600 万”；保留“每月 2 亿 Token，无额外年度总量上限”。
2. 月付页删除“500万 Token/日 付费额度”和“日调用限额 500 万”；保留“每计费月 1.5 亿 Token”。
3. 如需说明，可写“套餐不设每日 Token 上限”。不能把 null 渲染为 0、余额不足或旧的 500／600 万。
4. 会员页刷新账户额度后，应以实际权益的月额度／剩余额度显示，不能将所有旧权益硬编码为新模板额度。月付按计费周期，年付按 UTC 自然月。
5. 月额度不足后，有赠送／充值 Token 余额仍可继续使用。此次无需重放支付回调或重建用户权益。

对外清单已同步：[身份／支付后端评审清单](../../outbox/gateway-token-issuance-api-review-2026-10-22.zh-CN.md)、[追加 Token 接口](../../outbox/gateway-token-credits-api-2026-10-23.zh-CN.md)。
