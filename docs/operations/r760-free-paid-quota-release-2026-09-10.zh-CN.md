# R760 免费与付费独立记账发布验收

2026-09-10 12:10:25 UTC（北京时间 20:10:25）上线，12:11:38 UTC 完成运行和公网 Billing 验证。

## 行为与合同

公开月付／年付在基础 Free 之外生效，免费优先预留与结算，付费日／周期账本只累计付费部分。
购买不重置当天 Free，续费不复制免费消耗；付费到期、暂停或取消后，仍有效的基础 Free 可继续使用。
Free 日切保持 UTC 00:00（北京时间 08:00）。原 1M Free 和付费快照保留。

月付模板仍为每日 5M、周期 50M；年付累计不限量，技术限速和单请求上限仍适用。
支付团队沿用 entitlement-events；Free 升级既可省略 replace_current，也兼容 true。
客户端／支付端新增字段及示例见[独立记账合同](../outbox/medevidence-free-paid-quota-contract-2026-09-10.zh-CN.md)。

Migration 29 增加免费预留、策略快照和最终免费／付费 token 字段。生产中 4 个有效月付账户
此前没有 Free 历史，已各新增一份每日 10,000 的基础权益；没有调整它们原来的付费权益或 Key。
此批未修改客户端源码或发布 EXE，未发起真实收款或生产模型调用。

## 固定版本验证

- 部署提交：`9627d4f263a97b10a38bfcc12f52867b8f9df824`；分支 codex/sms-phone-signup-20260909 已推送。
- previous：`8dab89da424ce722df2c433d52132e19707536b9`。
- 镜像：`sha256:468782fc35aadc4f46686b8ca187ba5634e3b2896b9a02fb0a2459fd9405db4c`。
- 源码归档 SHA-256：`c5cb755dc7a3c0b90894b7404c783a09cbd1e4ca7e6a7f8c5c14653612fafb20`。
- 本地构建、368 项相关回归以及补充后的 16 项重点场景通过；当前共享工作目录同步后构建通过。
- 固定提交在 R760 完成 Linux 构建，15 项新账本测试和 18 个文件的 575 项回归全部通过，共 590 项。
- 候选镜像使用无外网、无生产配置的临时容器跑实际编译路由：Chat／Responses 各自的流式与
  非流式共 4 次调用，总用量 80,000，仅记 80,000；Free 扣 10,000、付费扣 70,000。
  Billing purchase、双权益查询和幂等重放通过。全部使用内存数据库和本机模拟上游。
- 生产备份副本在候选镜像中迁移通过；943 个 Subject、952 个模型凭据、454 个统一 Key、
  14 个 Plan、242 个 Phone identity、595 条原权益，以及 1,782 个 subject 用量窗口、
  25,687 个 entitlement 用量窗口、51,117 条请求账本的原字段逐项比较无变化，仅补充预期 4 份 Free。

## 公网与运行验收

- 切换前等待未结算预留归零；仅重建 Gateway，配置和环境指纹不变，健康 ready、重启数 0。
- Research Worker、Research LLM Gateway、Research maintenance、Mihomo、Qwen 的容器 ID 不变且健康。
- Gateway、client-events、Research 三个数据库 quick_check=ok、外键违规 0，Gateway schema=29。
- 与备份比较，以上 943／952／454／14／595／242 条既有控制记录变化数均为 0。
- 公网查询 4 个有效月付账户均返回当前月付及独立 active Free，每日 10,000；请求 ID：
  req-548b00fd-e4ac-4545-a858-d722808a8606、req-48f4fcf8-b1ac-4dfd-9011-09ee9444383a、
  req-60976613-b14f-4c5d-a0e9-40fd23d9e62d、req-46e7f090-f670-44f7-95bb-7928725586dc。
- 套餐目录仍为月付 5M/day、50M/month，年付 day/month=null；
  request_id=req-887c007f-5538-4e28-9d3d-d439b1ae80b1。公开模型接口未消费真实用户额度。
- 验收期间日志 error、fatal、未捕获异常、未处理 Promise 拒绝计数均为 0。

## 备份、清理与后续

备份与证据目录：`/opt/codex-gateway-r760/backups/phone-signup-9627d4f263a9`。
在线备份 Gateway 292,904,960 字节、client-events 1,333,895,168 字节、Research 21,835,776 字节，
均校验完整性、外键、大小和 SHA-256；配置文件及 secret mount 保护权限已检查。
保留 deployment.json、build.log、migration-smoke.json、public-smoke.json、public-billing-read.json、
final-audit.json、source.tar.gz 和 cleanup.json。

12:12:39 UTC 完成远端清理：临时迁移／接口验证容器为 0，staging 已移除，源归档转存备份并验证。
没有创建生产测试账户或新模型 Key；4 份正式基础 Free 权益保留。
本地临时归档 `.gateway-state/free-paid-release/source.tar.gz`（2,472,085 字节）删除被自动审批
拒绝，返回 blocked by policy；已保留，不影响发布及远端清理，SHA-256 与上述源码归档一致。

本次使用 `--forward-only`：旧版假设单一 active entitlement，不能直接用旧镜像回滚双账本。
后续恢复应采用支持双账本的版本，禁止用旧数据库覆盖上线后的业务记录。
保留的 usage transfer 工具遇到双额度记录会明确拒绝导入，避免按旧逻辑重复扣付费额度。
年付 Key 有效期覆盖付费期的问题未在本批修改；真实收款和客户端双余额展示仍需团队联合验收。
