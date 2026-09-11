# R760 短信开户与每日免费额度发布验收

2026-09-09 04:15:04 UTC（北京时间 12:15:04）上线，04:16:29 UTC 完成公网及数据库验收。Gateway 已可供客户端和身份后端联调。

## 发布内容

- 发布提交：63c818f3c0588f602eaa51438b46981d8a34cc9e。
- 发布分支：codex/sms-phone-signup-20260909。共享 main 工作目录存在其他并行改动，本轮从独立分支及已推送提交构建。
- current：/opt/codex-gateway-r760/releases/63c818f3c0588f602eaa51438b46981d8a34cc9e。
- previous：6640d0eda4db0f90ecf6aa18adbfb95e38b8f251。
- 镜像：sha256:be5a1ae1f9acb2909427f30381d1f624d9f9ab6463cd963fed80538a15948c01。
- 归档 SHA-256：d1201ca9d97a6252d0b3884f171d56e09298a89ba3e829092e8a5593cda107de。
- 备份与证据：/opt/codex-gateway-r760/backups/phone-signup-63c818f3c058。

新增启用配置为 GATEWAY_BILLING_IDENTITY_PROVIDER=medevidence_billing。其他环境配置指纹保持一致，复用原 Phone Auth 和加密密钥。Migration 28 增加外部身份关联／开户状态表，免费 Plan 已随首次测试开户事务创建。

新用户由身份后端执行 resolve → create_subject 后，Gateway 同一事务完成账户、可恢复 Key、每日 100 万免费权益和 Phone identity。姓名可空，临时登录仍走既有 v1。外部短信 token 不用于 Gateway 授权。

完整接入说明见[客户端／身份后端联调说明](../outbox/medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md)。

## 验收证据

独立工作区类型检查和 338 项测试通过；从提交归档构建的 Linux 镜像内，同一组 6 个测试文件、338 项测试再次通过。覆盖失败回滚、固定业务事件重试、并发开户、旧账户关联、额度累计和 UTC 日切、Key 轮换、免费转付费和原 v1 合同。

公网使用临时测试账户调用真实 Gateway 接口：

| 检查 | 结果 | 请求 ID |
| --- | --- | --- |
| 后台 resolve | 200，create_ready | req-252fbe34-03fd-4aaa-8b61-1628be6353f8 |
| 无姓名开户 | 200，免费 Plan 和手机号身份自动完成 | req-66bc744c-72bc-4542-8de6-6c025b8978d4 |
| 手机号登录 | 200，transition_phone_only | req-fdbd19dc-1589-4ba1-aafe-8196c9ae0f04 |
| bootstrap 领取 Key | 200，与首次签发 Key 一致 | req-1ea61a85-9b48-4388-ae64-8659cb892fdf |
| 账户权益 | 200，plan_free_daily_1m_v1 | req-798cc2ea-0d98-4459-97e7-7e7e7774d53d |
| resolver／凭据状态 | 200，日额度 1,000,000 | req-ccd58232-b756-42a5-a15f-3788e7affc8f |
| 开户重试 | 200，幂等重放，不重复返回完整 Key | req-9a9aecf0-2fda-42b7-b12a-71847dadd4d9 |
| 再次登录与 bootstrap | 200，仍为同一 Subject、Key 和唯一免费权益 | req-384ed744-c6fc-4ba2-ab42-abefac073a35 |
| goldencode 真实模型调用 | 200，有模型响应 | req-090cb055-0487-4676-9190-ec1e1a262f26 |
| 未登记手机号临时登录 | 403，phone_not_registered | req-d4137bb1-5f88-40c4-82cd-a8b1a5a7cdf2 |
| 清理后旧测试 Key | 401 | req-7ae32da1-c481-4f5a-8b05-38b1d5fdba4b |

resolver 返回的 R760 MedEvidence Origin／API Key 组合也通过其 /validate-key 检查，valid=true。该检查针对模型运行凭据，不是身份后端短信 access_token 的校验。

每日上限、跨设备／Key 轮换累计及 UTC 午夜重置通过 SQLite 账本测试验证；公网验证了实际免费 Plan 和真实模型请求，没有在生产消耗 100 万 token 做压力测试。

## 保护与清理

切换前完成在线备份：Gateway 282,427,392 字节、client-events 1,298,071,552 字节、Research 21,356,544 字节；备份均通过 quick_check 和外键检查并记录哈希，配置备份校验通过，保护文件权限符合要求。

切换前等待在途 token 预留归零，只重建 Gateway。Gateway healthy、重启数 0；Research Worker、Research LLM Gateway、Research maintenance、Mihomo、Qwen 的容器 ID 均未改变且健康。公网端口仍只由原配置发布。

逐条与备份比对所有既有控制记录，变化数均为 0：

| 表 | 比对记录数 | 变化数 |
| --- | ---: | ---: |
| subjects | 909 | 0 |
| access_credentials | 918 | 0 |
| unified_client_keys | 420 | 0 |
| plans | 11 | 0 |
| entitlements | 564 | 0 |
| phone_auth_identities | 212 | 0 |

以上包括历史和各状态记录，不是活跃付费用户数。

临时测试 Subject 已停用、Phone identity 已停用、会话撤销、凭据撤销，未结算预留为 0；审计历史保留，不删除账户后复用 ID。新免费 Plan 保留供正式新用户使用。无完整 Key、token 或手机号输出到验收报告。归档已移入备份并校验，远端 staging 目录已清理。

上线后三个数据库 quick_check=ok、外键违规 0；Gateway schema=28。日志 error/fatal、未捕获异常和未处理 Promise 拒绝计数均为 0。

主要证据：deployment.json、build.log、public-smoke.json、final-audit.json、source.tar.gz。公网上线验收脚本为 scripts/ops/phone-signup-public-smoke.mjs；验收增强了 MedEvidence 运行 Key 可用性检查及凭据断言脱敏，未改动已部署服务代码。

## 后续联调与回滚

Gateway 已就绪。身份后端需接入 subjects/resolve，再对 create_ready 的用户执行 create；客户端需完成 SMS→现有手机号 v1 的适配。真实 captcha／短信／支付和安装包仍待相关团队联合验收。正式用户协议／隐私链接仍由产品提供。

199／1999 月年付不限 token、付费期满自动回免费版不在本次发布内。首次免费转付费沿用 purchase + replace_current=true，既有付费套餐和历史权益未修改。

回滚使用备份中的原镜像、原配置及同一 Compose 组合，只重建 Gateway并恢复 current/previous 指向；不通过恢复旧数据库覆盖上线后的业务记录。Migration 28 是新增表，旧版本回滚时保留该表和账本。若撤回开户功能，先停止新 provider 开户协作，再执行受控回滚。
