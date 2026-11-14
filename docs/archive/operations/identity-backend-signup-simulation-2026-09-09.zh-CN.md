# 模拟身份后端开户：公网验证记录

2026-09-09 北京时间 17:00 执行，17:00:56 完成清理核验。用户授权直接模拟身份后端调用 Gateway，以验证新用户开户和每日免费额度，无需在外部 login 页面提交身份证件。

## 结果

使用独立、未登记的测试手机号和唯一测试 external_user_id，provider 为 medevidence_billing。通过 https://goldencode.instmarket.com.au:1443 的正式公网接口，复用服务端 Billing Admin 凭据执行 resolve → subjects。未填写姓名。

测试 Subject：subj_xz55uPZlDcJDVUoeF2cQSLIu，创建时间 2026-09-09T09:00:05.329Z。该账户用于本次验证，不是用户此前在外部 login 页面使用的手机号账户。

| 检查 | 结果 | 请求 ID |
| --- | --- | --- |
| POST /gateway/admin/billing/v1/subjects/resolve | 200，create_ready | req-a13c94eb-3265-4cf1-8f56-ae4144137bd0 |
| POST /gateway/admin/billing/v1/subjects | 200，自动准备账户、Key、免费权益及手机号身份 | req-1414efd9-e7a6-4083-8e19-e5a0236c44f5 |
| POST /gateway/auth/v1/login/start | 200，可立即使用手机号登录 | req-895dd078-9780-4621-8e9e-b5547de484cc |
| POST /gateway/auth/v1/session/bootstrap | 200，返回与首次签发相同的 Key | req-5a463013-f95b-4769-ab92-d81e543050c6 |
| GET /gateway/account/v1/current | 200，plan_free_daily_1m_v1 | req-115e8a3e-aa6a-4f87-aba2-d3691e0246c8 |
| GET /gateway/credentials/current | 200，tokensPerDay=1000000 | req-0fc90d28-6cce-40a2-aa03-ae2151dfc23d |
| 同一事件重试 POST /subjects | 200，幂等重放，权益仍只有一条 | req-8b0d9ed2-14d7-462b-9041-b4f91c3f368a |
| 再次登录、bootstrap | 200，同一账户、同一 Key | req-846f5f8d-d05f-401b-84ba-d209a08a545b |
| POST /v1/chat/completions，goldencode | 200，有真实模型响应 | req-c9c37d56-2e9d-4668-abe7-c4e91c8bced9 |
| 再次 resolve | 200，linked，返回原 Subject | req-a48fddec-02d6-4a07-b37d-3078a5868f4c |
| 另一个未登记手机号登录 | 403，phone_not_registered | req-8006abbb-9f9c-4b58-bbd6-6d5cfb3d9bc0 |

resolver 返回的 R760 MedEvidence 运行凭据也通过 /validate-key 检查，valid=true。这里只验证运行凭据；本次没有调用外部短信、实名资料或支付接口。

每日 100 万是服务端日累计上限。验证同时核对公开凭据接口和数据库权益快照；未消耗 100 万 token 做生产压力测试。重复开户与登录没有新增第二份权益。

## 备份与清理

执行前已创建并验证 R760 在线备份：

- 路径：/data/backups/codex-gateway/signup-smoke-pre-control-state-sync-20260909T085927Z-5f089be9.db
- 大小：284585984 字节。
- SHA-256：383b38d908260bbaea8094a976c2c79bf79f9940c1a2f36137c7cfb2b3e7afe0。
- quick_check=ok，外键违规数为 0。

测试结束后，通过管理接口停用测试手机号身份和 Subject，撤销测试凭据、会话及权益。清理后的 Key 调用 resolver 返回 401。最终只读核验：

- Subject、Phone identity 均为 disabled；免费权益为 cancelled，历史快照保留 tokensPerDay=1000000。
- 有效模型凭据、有效统一 Key、活动会话和未结算 token 预留均为 0。
- Gateway 数据库 quick_check=ok、外键违规数为 0；容器 healthy，重启数为 0。

未删除审计历史，不复用测试 external_user_id。报告不包含完整手机号、Key 或令牌。

## 协作结论

Gateway 的后台开户 → 免费权益 → 手机号登录 → 领取 Key → 模型调用流程已通过此次模拟。身份后端实际接入仍需按[联调说明](../../outbox/medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md)调用 resolve 和 subjects；此次模拟不代表外部登录页面已经接入开户。

执行脚本：scripts/ops/phone-signup-public-smoke.mjs。脱敏运行证据保存在 .codex-tmp/identity-backend-signup-smoke-20260909.json、identity-backend-signup-backup-20260909.json 和 identity-backend-signup-audit-20260909.json。
