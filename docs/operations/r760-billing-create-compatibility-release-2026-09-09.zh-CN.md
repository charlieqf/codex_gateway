# R760 Billing 开户兼容修订上线记录

2026-09-09 北京时间 17:41:33 上线，17:42:09 完成公网和数据库验收。

## 生效行为

用户明确要求兼容 5 月版开户规范，不强制 resolve。本次取消对配置 provider 的无条件 resolve 前置检查，保留原 POST /gateway/admin/billing/v1/subjects 请求、嵌套响应及幂等语义。

| 请求方式 | 结果 |
| --- | --- |
| 5 月原样请求，不带 phone，也没有 resolve 记录 | 200，原 Billing Subject 和 cgu_live Key；权益沿用原付费事件流程 |
| POST /subjects 直接增加 phone | Gateway 内部关联手机号；新账户一次完成 Key、每日 100 万 token 免费权益和 Phone identity |
| 可选 resolve → subjects | 继续支持，保持已接入的两步流程 |
| phone 匹配旧账户 | 建立外部身份关联后沿用 409 subject_already_exists，按原 GET 查询恢复；保留旧账户、Key 和权益 |

姓名可省略。原始响应读取 subject.id、credential.key、credential.issued_at、credential.expires_at。相同事件重试不再次返回完整 Key；同 key 改 body 为 idempotency_conflict，换 key 重复开户为 subject_already_exists。手机号开户事件重试不得临时增删 phone 字段。

未登记手机号仍不能通过公开 login/start 自动开户。完全不提供手机号信息的旧 Billing 请求不会自动完成手机号登录准备或免费额度授予。外部短信 token 不参与 Gateway 授权。

## 发布和验证

- 发布提交：27f10d95c13476ac8bd9c609985071882e37eb9e。
- 分支：codex/sms-phone-signup-20260909；从已推送的独立工作区提交构建，共享工作区的其他改动未纳入。
- previous：63c818f3c0588f602eaa51438b46981d8a34cc9e。
- 镜像：sha256:2bd87ebc8226ec592c9ec9abd31cb8f68d460ae0b891a20d2a422ec57a9718a0。
- 源码归档 SHA-256：ddb931b820ec4ff71c8c3f93dd986e252bfe555bd8dcf5bd171b3f65378913f0。
- 类型检查、Windows 本地 344 项测试、固定提交 Linux 构建中的同组 344 项测试全部通过。
- 未修改运行配置，schema 仍为 28；只重建 Gateway，其余服务容器未改变。

公网验证使用正式 Origin https://goldencode.instmarket.com.au:1443 和临时测试账户：

| 验证 | 结果 | 请求 ID |
| --- | --- | --- |
| 5 月原样请求，不调 resolve | 200 | req-2a785f15-1767-424d-ae9c-f9f08b41d557 |
| 旧请求同 key、同 body 重试 | 200，幂等重放，无完整 Key | req-3f30e9d5-eb17-4031-9927-4ce3e7ec2d17 |
| 同 key 改 body | 409 idempotency_conflict | req-f68f1823-ae29-45c5-a2af-8e22669a8d6d |
| 换 key 重复开户 | 409 subject_already_exists | req-7305bc19-c20a-4697-b8e0-c9aec81f2079 |
| 直接带 phone 开户，不调 resolve | 200，自动免费权益及手机号身份 | req-4a567b5d-621a-4433-979a-1d2f7ec666cc |
| 手机号登录 | 200 | req-45cab61c-0677-44da-9ab0-65c63937e54c |
| bootstrap 领取同一 Key | 200 | req-d3f18cc5-f062-4d11-9f32-74bf3f2e8bdd |
| 实际模型凭据每日上限 | 200，tokensPerDay=1000000 | req-b06eabc0-1b23-44dc-9a89-255863db7042 |
| goldencode 真实模型请求 | 200，有模型响应 | req-298399b5-4b4b-4568-bfdf-75133687ae51 |
| 可选 resolve 后再开户 | 200，仍可登录并获得每日免费权益 | req-5512ed06-56a5-4af7-890c-43dffccff5d4 |

直接手机号开户的再次登录、重复开户保持同一 Key 和唯一权益；R760 MedEvidence 运行 Key 也通过 /validate-key 检查。未进行生产百万 token 压力测试，未替代身份后端真实短信／支付验收。

## 保护、清理和证据

备份目录：/opt/codex-gateway-r760/backups/phone-signup-27f10d95c134。

上线前在线备份 Gateway（284999680 字节）、client-events（1307049984 字节）及 Research（21364736 字节）数据库，均通过 quick_check 和外键检查；配置备份校验及保护文件权限检查通过。

上线后逐条对比发布前的控制记录：Subjects 914、模型凭据 923、统一 Key 425、Plan 12、权益 569、Phone identity 217，变化数均为 0。以上包含各状态及历史记录，并非活跃用户数。

三个临时账户均已停用；有效模型凭据、统一 Key、手机号身份、会话、权益及未结算 token 预留均已清零。停用后的测试 Key 返回 401。保留审计历史，不删除并复用外部 ID。

最终 Gateway healthy、重启数 0；三个数据库 quick_check=ok、外键违规数 0；日志 error/fatal、未捕获异常和未处理 Promise 拒绝均为 0。公网服务 ready。源码归档移入备份并复核哈希，staging 目录已清理。

证据文件：deployment.json、build.log、public-smoke.json、final-audit.json、cleanup.json、source.tar.gz。没有输出完整 Key、token 或手机号。

若需回滚，可使用备份中的旧镜像与发布路径只重建 Gateway；不恢复旧数据库覆盖新业务记录。回到 63c818f 会重新引入 resolve 强制前置，因此必须明确其业务影响。

当前对接文档：[Billing 集成指南](../medevidence-billing-integration-guide.external.zh-CN.md)、[短信／临时登录联调说明](../outbox/medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md)。
