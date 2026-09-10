# R760 额度与权益自审修复发布验收

2026-09-10 22:21:39 UTC（北京时间 2026-09-11 06:21:39、悉尼时间 08:21:39）上线。
22:23:54 UTC 完成 Gateway 审计，22:24:44 UTC 完成远端清理。

## 修复范围

对应[最近提交自审及第二轮复查](../code-review-2026-09-11.zh-CN.md)中的 R1–R5：

- 默认取消选择当前付费／当前周期暂停权益，保留未来 scheduled 续费；未来权益通过显式 ID 操作。
- 有双账本请求尚未结算时，额度重置返回 `409 quota_reset_conflict`；不会清掉请求次数或吞掉晚到用量，结束后可重试。
- Gateway 管理页分别展示免费日、付费日和付费周期余额，正确计算“额度耗尽”；年付不限额仍显示已用量。
- 新发基础 Free 时缺少模板会复用手机开户工厂初始化；模板明确停用则整笔权益事件回滚并返回 `409 plan_inactive`。
- 实测公共 Free 模板的缺失 usage 策略是 `estimate`，月付、年付是 `none`。修正合同及测试替身，既有模板与权益快照不变。

删除 Billing 的无用窗口序列化函数、纯透传包装和重复产品名单。第二轮复查未发现新的阻断发布问题。
未修改 Desktop 源码。支付／客户端字段和重试说明见[独立记账合同](../outbox/medevidence-free-paid-quota-contract-2026-09-10.zh-CN.md)。

## 固定版本与回归

- 部署提交：`77c6404fe5884f360a9b68fceb30fcaec13cd2e9`，已推送 `codex/sms-phone-signup-20260909`。
- previous：`9627d4f263a97b10a38bfcc12f52867b8f9df824`；schema 仍为 29。
- 镜像：`sha256:08e730a358728061f00be19f57b159820a8b8822e53fb8c1137e341027265a34`。
- 源归档 SHA-256：`d10b890372e2c14eb12985b573431b7d7b8b86c3f84ccdd0a7ac1a330497d934`。
- 本地六个相关测试文件共 412 项通过；发布工作树与同步后的主工作区 TypeScript 构建均通过。
- 固定提交的 Linux 构建通过：24 项分账／管理页测试和 576 项 Gateway、身份、图片、SQLite 回归，共 600 项。
- 候选运行镜像在无网络、无生产配置的临时容器验证 Chat／Responses 各自流式与非流式，4 条编译后路由均通过；80,000 总用量分别记入 Free 10,000、付费 70,000，完整请求用量不重复。
- 候选镜像仅挂载只读备份、对临时副本启动 Store。943 个 Subject、952 个模型凭据、454 个统一 Key、14 个 Plan、599 条权益、242 个 Phone identity、1,782 个 subject 窗口、25,700 个 entitlement 窗口、51,134 条请求账本和 254 条 Billing 事件逐项比较无变化。

管理页测试运行真实页面生成的渲染函数并检查脚本语法；不等于真实浏览器布局验收。模板缺失／停用的异常场景在隔离测试验证，没有停用生产 Plan 制造故障。

## 公网业务自测

使用一个新建、无真实手机号的合成 Billing 账户，经公开入口执行 May 版开户、Key 解析、月付购买、下月续费、暂停及取消、年度购买和真实模型调用。

| 检查 | 结果与请求 ID |
| --- | --- |
| 请求进行中暂停月付，再重置当前 Free | `409 quota_reset_conflict`；`req-5c055d5f-a4f1-4d44-8bae-176b4e682175` |
| 该请求随后成功完成 | HTTP 200，真实 396 token 全部结算到 Free，完整请求账本为 396；`req-e6ecdc55-0a7d-4a82-9b34-8adcffa668ed` |
| 默认取消当前暂停月付 | 当前月付取消、下月续费仍为 scheduled、Free 保留；`req-191a96e3-020d-44bd-95d6-904e42e8c354` |
| 只剩未来续费时再次默认取消 | `404 entitlement_not_found`，随后显式指定未来 ID 可取消 |
| 模型完成后重试重置 | HTTP 200；`req-f135ffb1-8c38-4512-9f7e-e5201526b6f8` |
| 年付购买及用量查询 | 付费日／周期 limit=null，保留同一个 Free；`req-dab58eb7-d0cc-4dc4-962a-a1ab71b0cdf7` |
| 管理页公网 HTML | 已包含免费日、付费周期、不限额已用量以及服务端耗尽标记 |

在线测试验证真实模型的晚到结算；免费用尽后晚到 5,000 付费 token、日／周期重置及请求次数保护由 Store／HTTP 回归覆盖。没有为了自测消耗真实用户额度，也未执行真实收款或 Desktop EXE 验收。

合成账户 `subj_qDKE8Ly8dX5zEDBmtysqkr8X` 已停用，模型凭据全部吊销、未结算预留为零；原统一 Key 解析返回 `401 revoked_credential`。保留审计记录，不硬删除业务历史。

## 运行审计与既有 Research 故障

- 只重建 Gateway；current／previous、镜像标签、配置及环境指纹、端口均符合预期。Gateway healthy，重启数 0，公网 health=ready。
- Gateway、client-events、Research 三个数据库均 quick_check=ok、外键违规 0。
- 与发布前备份比较，既有 Subject、模型凭据、统一 Key、Plan、权益、Phone identity 变化数均为零。
- Gateway 日志 error、fatal、未捕获异常、未处理 Promise 拒绝均为 0。
- Research Worker、Research LLM Gateway、Mihomo、Qwen 容器未重建且健康。

**Research maintenance 有一项发布前已存在的故障**：同一容器在 2026-09-10 12:35:08 UTC 已退出（exit=1，restart=3），日志为备份启动 `ENOENT`。发生时间早于本次备份和上线约十小时；本次没有重建或重启它。Research Worker 仍健康，但自动维护／备份任务需要单独修复。

原审计脚本因要求所有关联容器健康而失败。后续审计使用明确限定同一容器、同一退出时间和退出状态的记录变体，继续执行所有 Gateway、数据保护和清理检查；最终结果为 `passed_with_preexisting_maintenance_incident`，不把整个 R760 宣称为全绿。

## 备份与清理

证据目录：`/opt/codex-gateway-r760/backups/phone-signup-77c6404fe588`。

发布前在线备份 Gateway 293,666,816 字节、client-events 1,335,156,736 字节、Research 21,835,776 字节；均验证大小、SHA-256、完整性和外键。配置与 secret mount 权限已核对。
保留 deployment.json、build.log、clone-smoke.json、compiled-smoke.json、public-smoke.json、final-audit.json、audit-with-known-maintenance-incident.py、source.tar.gz、cleanup.json。

临时容器为零，远端 staging 已删除，归档移至受保护的备份目录并验证；本批本地临时归档已删除。主工作区只同步本次补丁，保留其他未提交修改。
恢复应使用支持双账本的程序；不得以旧数据库覆盖上线后的账本。年付 Key 覆盖完整付费期的既有待办仍按支付合同单独处理。
