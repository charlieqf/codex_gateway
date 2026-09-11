# R760 新用户每日 1 万 token 免费权益上线记录

2026-09-10 北京时间 16:25:31 上线，16:26:13 完成公网和数据库验收。

按用户要求，测试期间将之后新开户的默认免费权益调整为每日 10,000 token。
新发放使用独立的 `plan_free_daily_10k_v1`；此前的 `plan_free_daily_1m_v1`
以及所有既有权益、Key 和用量保持不变。老账户首次短信登录仍关联原账户。

## 生效范围

- 直接带 phone 的 POST /subjects 和可选 resolve → subjects 新手机号开户流程均使用新套餐。
- 旧版每日 100 万套餐、套餐名称和已发放权益快照全部保留，没有批量迁移。
- 不带 phone、也无 resolve 记录的五月版 Billing 开户合同不变。
- 日窗口仍为 UTC 00:00（北京时间 08:00）；登录、换设备、重放开户和轮换 Key 不重置用量。
- 其他请求限额、并发、能力和 Key 有效期规则沿用原值。
- 没有设置自动恢复日期。以后恢复新用户默认值时，已发放的 1 万权益不会自动扩额。

## 发布与验收

- 提交：`532774dca5e1c5ddc5f719d29e22015c6fc2388e`。
- previous：`27f10d95c13476ac8bd9c609985071882e37eb9e`。
- 镜像：`sha256:4b47156032a8f97438d32faa4619c79ed93f024668bdabc850e8243bd6ffb989`。
- 源码归档 SHA-256：`7934b68b8a58e7d5ef42009af1cd7754e2b0f0238ff8c1f38d218601558c008b`。
- 本地类型检查、相关回归及固定提交 Linux 镜像内 345 项测试通过。覆盖新账户累计
  1 万后拒绝、UTC 次日恢复，以及旧 100 万账户的套餐、Key、权益和已用额度保持不变。
- 切换曾因真实请求未结束而自动推迟，随后在无未结算请求时完成。
- 只重建 Gateway；配置、schema 28、其他服务容器保持不变。

| 公网验证 | 结果 | 请求 ID |
| --- | --- | --- |
| 直接带 phone 新开户 | 200，自动 1 万免费权益 | `req-98857728-81e5-499a-ad5f-832ec8845100` |
| 手机号登录 | 200 | `req-47b431d7-abe6-43a8-9596-c6e77ed3b787` |
| bootstrap 领取 Key | 200 | `req-80b0864c-fab8-456d-8724-5e9c9616e9e1` |
| 实际模型凭据每日限额 | 200，tokensPerDay=10000 | `req-822417aa-6371-44f0-949f-daaeda8648fd` |
| goldencode 真实模型请求 | 200，有模型响应 | `req-2bea05e8-1d67-4771-a6e6-7e598ede9588` |
| 可选两步开户 | 200，自动 1 万免费权益 | `req-807c00d9-675a-4a18-8c93-d1030700b58e` |

重复开户和重登保持相同 Key、唯一权益；五月版原样开户及幂等检查继续通过。
关联 MedEvidence 运行凭据通过 /validate-key。没有对生产真实用户执行额度耗尽测试。

## 老用户保护与清理

与部署前备份逐条比较：929 条 Subject、938 条模型凭据、440 条统一 Key、12 条既有
Plan、583 条权益、231 条 Phone identity，变化数全部为零。数量包含历史状态记录。
另确认既有测试账户 `subj_GhISouthMW04s8QnqOYP2aJF` 的权益仍为
`plan_free_daily_1m_v1`、active、每日 1,000,000 token。

三个临时测试账户均已停用；有效凭据、统一 Key、Phone identity、会话、权益及未结算
预留均为零。保留审计历史，staging 已清理。

备份目录：`/opt/codex-gateway-r760/backups/phone-signup-532774dca5e1`。
部署前 Gateway、client-events、Research 在线备份均校验通过；目录和文件有访问保护。
证据为 deployment.json、build.log、public-smoke.json、final-audit.json、cleanup.json、source.tar.gz。
上线后三个数据库 quick_check=ok、外键违规为零，Gateway healthy、重启数零，公开 health=ready。

当前合同：[短信／临时登录联调说明](../outbox/medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md)。
