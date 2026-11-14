# 云模型视觉兼容发布与审核闭环（2026-10-28）

Gateway 已于 2026-10-28 02:47:52 UTC（北京时间 10:47:52）切换至
`007f5073428ead3457c7f786b139aa6a4bddedb2`，02:50:46 UTC 完成在线核验。
前一版本为 `954eb3bedca6648405fa419d232cdb4a43dbe8fc`。
实现、运维及审核修订提交为 `1416399`、`1dd0c56`、`007f507`，均已推送 main。
前两版只构建和检查，未切换生产；本次实际部署的是审核后的第三版。

## 审核意见处理

1. 已确认旧生产 GLM 视觉配置只有 `effort: medium`，MAX 缺少兼容处理。
   在公共档位解析层统一处理：先沿用显式文字合同的默认值、允许值和别名，再适配视觉能力。
   两个云模型默认 high，none→low、medium→high；当前视觉 max→high。
   不支持的公共档位仍返回 400，不因视觉降档而放行任意输入。
   修正 dispatcher 再次用视觉默认值覆盖解析结果的问题；审计保留 requested/effective 和归一化原因。
2. 更新模型合同和客户端指南，移除两个云模型间切换必须删图的旧要求。
   首次添加 D 的旧部署与预检流程显式排除示例 `vision`，防止隐式启用示例上游。
3. 配置准备脚本原样复制现网 GLM 视觉块，不再注入 reasoning、支持列表或别名。
   回归覆盖缺省 reasoning、xhigh、自定义列表和下划线字段，保留 Gateway 原有继承语义。
4. 预检直接读取准备好的候选环境，不再重建另一份 registry；切换前比较候选文件与现场生成值，
   本次预检文件、部署文件及生效文件字节一致。间接 `*_API_KEY_ENV` 及其 `_FILE` 被安全保留，
   生产数据库路径和后台服务开关被隔离。
5. 修复预检 Responses 无图请求构造、非流式文本提取和失败定位信息。
   候选文件先私有临时写入、fsync，再原子发布且不覆盖已有文件；验证中断写入不会发布残缺候选。
6. 移除只换模型 ID 的 dispatcher 重复用例，改为真实示例配置的两模型入口测试：xAI 不可用时返回 503，
   不调用各自文字池。预检的环境和消息处理提取为纯辅助模块；未进行与修复无关的全面测试框架重构。

## 发布验证

- Windows 和不可变 Linux 源码构建均通过；相关 4 个测试文件全部 497 项通过。
- 配置脚本 7 项、预检辅助模块 2 项通过。备份副本用候选镜像打开后仍是 schema 44，完整性/FK 通过。
- 同一候选配置真实预检：D 和 GLM 的 Responses 流式图片 MAX 各一次，均走 xAI 并读出合成图片数字 7319。
- 生产配置仅新增 `goldencode-d.vision`，其他 registry、环境变量和 20 个受保护文件保持不变。
  候选 SHA-256：`135040ec8955d035bfea919d198cddfdc9c112d599573177007f28bbe1b99e35`。
- 仅重建 Gateway；其他 3 个容器、端口绑定保持不变。current/previous、镜像 revision 一致，重启数 0、无 OOM。
- 切换全程约 49.5 秒。公网探测记录 37 次 503、3 次 502，非就绪观测区间为
  02:47:05.723–02:47:45.526 UTC；随后恢复并通过连续 ready 检查。本次不是零停机发布。

公网 `https://goldencode.instmarket.com.au:1443` 验收全部 HTTP 200，流式终态和账本结算通过：

| 请求 | 请求 ID | 实际路由／有效档位 | 结果 |
| --- | --- | --- | --- |
| D 图片 Chat 非流式 MAX | `req-140cdfb7-1891-437d-95d3-2ca76fe94e9e` | xai/grok-4.5 / high | 7319 |
| D 图片 Chat 流式 MAX | `req-5a4b5462-80e4-485d-8dc8-f17fb035a4e1` | xai/grok-4.5 / high | 7319 |
| D 图片 Responses 非流式 MAX | `req-85b9f655-2b84-41b9-ad95-e039bcedcf5e` | xai/grok-4.5 / high | 7319 |
| D 图片 Responses 流式 MAX | `req-206277cb-4440-48dd-b1d2-175c9d465fdc` | xai/grok-4.5 / high | 7319 |
| GLM 图片 Chat 非流式 MAX | `req-e5b0cc22-fdfb-4eb0-b47b-37679f5c52ae` | xai/grok-4.5 / high | 7319 |
| D 纯文本 Chat MAX | `req-dd2e9a6e-2d6f-4a6c-80a6-9ef95f9b84e6` | tiankuan/deepseek-v4.1-flash / max | PREFLIGHT_OK |

测试 Subject 禁用、凭据撤销（公网复核 401）、权益取消、Plan 废弃，待结算为 0，保留审计记录。
临时数据库副本和容器内测试报告已清理。正式 gateway.db、client-events.db 的 quick_check 均为 ok，
无 FK 违规、无过期待结算记录。切换完成后的日志未出现 error 级记录；审计中的 revoked_credential
来自清理复核，另有一条 missing_credential，不是模型路由或上游错误。

备份：`/opt/codex-gateway-r760/backups/release-007f5073428e`；数据库备份：
`/data/backups/codex-gateway-daily/20261028T024231Z`。
构建、预检、切换观察、公网 smoke 和最终核验记录保存在
`/opt/codex-gateway-r760/staging/007f5073428ead3457c7f786b139aa6a4bddedb2`。
备份及候选环境含凭据，受保护且未提交。

## 客户端边界

本次验收为 Gateway 公网 API，不是 Desktop 端到端验收。原 beta.116 的 D 图片本地拦截仍需客户端修复；
应允许 D 的图片输入与历史重放，保留所选公共档位，并展示具体 API 错误而不是只显示 APIError。
客户端验收应使用同一带图会话在 GLM→D→GLM 间切换，覆盖 MAX 和默认档，回传 Gateway request ID。
