# 图片链接刷新独立限流自审

审查日期：2026-09-20。审查对象：当时已上线的 `4b1dc8fa4f0f5a3e9d6e97ef83dc9f2921c862c2`，相对 `078d890` 的实现差异及直接调用路径。自审时 main 的后续提交只有发布文档；工作区原有未提交改动不纳入此功能结论。

结论：确认一项 P2 脱敏覆盖问题。未发现可复现的图片预算绕过、跨主体共享、普通请求扣错额度或并发名额重复释放回归。没有发现需要重写计数算法或大规模重构的理由。此结论是本次代码检查和有界测试的结果，不替代长期容量观测。

修复状态：该 P2 已在 `07a6504` 修复并上线，1535 项 Linux 测试及 8 种公网请求日志核验通过；以下复现表保留修复前证据，最终结果见文末。

## P2：路由未匹配时仍把资产 token 和查询参数写入日志

位置：`apps/gateway/src/vision-asset-routes.ts:112` 的 `childLoggerFactory`。

脱敏 serializer 只安装在成功匹配的 POST read-url 路由上。同一个 URL 使用错误方法、增加末尾斜线，或参数超过路由器限制后，会走未找到路由的日志上下文。Fastify 在进入 handler 前写出的 `incoming request` 仍包含完整原始 URL。

使用固定发布源码、真实 `buildGateway`、内存 SQLite 和合成资产标识复现：

| 请求 | HTTP | 日志包含资产标识 | 日志包含查询参数 |
|---|---|---|---|
| 正常 POST `/gateway/vision/assets/<asset>/read-url?secret=...` | 200 | 否 | 否 |
| GET 同一个 URL | 404 | 是 | 是 |
| POST `/gateway/vision/assets/<asset>/read-url/?secret=...` | 404 | 是 | 是 |
| POST 使用超长 assetId 的同类 URL | 404 | 路径未经脱敏 | 是 |

影响：客户端拼接错误、错误方法或畸形请求可能把签名资产标识及查询中的敏感值留在普通操作日志中。本次不能声称所有刷新相关请求的原始 URL 都已脱敏。资产标识仍受主体认证约束；此问题不等于获得其他用户图片访问权，也没有让这些 404 请求进入图片存储服务。

归因：错误路由原始 URL 日志是既有风险，本次新增局部脱敏没有覆盖它，属于安全补强不完整；不是独立计数功能新引入的权限绕过。

建议：在共享请求日志 serializer 中统一处理图片资产路径，去掉资产参数和查询串，使正常、认证失败、参数失败及 404 路径都适用。只调整日志展示；限流分类仍须由已注册路由元数据决定，不能改成 URL 前缀判断。已有局部 serializer 随之移除，避免两套规则。持久回归测试应覆盖错误方法、末尾斜线、超长参数及正常 POST。

## 回归检查与可维护性

- 底层 `InMemoryRequestRateLimiter` 的检查顺序、UTC 窗口、prune、release 算法保持原样；改名和 `key/scope` 适配已覆盖生产调用者，未找到残留旧接口名的已跟踪脚本或源文件。
- 图片分支位于普通 credential.rate 缺省返回之前；使用一个独立实例、subject.id 和统一策略，一次准入只 acquire 一次。身份、模型访问权限、权益、资产归属、到期、ready marker 和元数据检查均保留。
- Phone/IP/device、Research、Billing、client events 保持各自原 key 和 scope。Billing 对外 reset 结果仍由 serializer 映射，没有把内部 `key` 改名泄漏为 HTTP 合同变更。
- 补测实际 Billing quota-reset：图片分钟额度耗尽后，重置普通分钟/日额度，图片下一次仍是 429；普通状态请求恢复为 200。图片计数保持 2，普通计数重新从 1 开始。
- 对 HTTP 完成、断开、工作 finally 的全部六种顺序补测，底层许可均只释放一次。现有真实 socket 测试另外覆盖 R2 工作尚未收尾时拒绝替代请求的情形。
- `RateLimitLease` 有必要：明确分开 HTTP 结束与存储 Promise 收尾。当前没有新增第二套计数算法或并发 semaphore；其幂等控制解决的不是单纯调整上限能解决的问题。
- `gatewayRateLimitRelease` 与 `gatewayRateLimitLease` 存在两种释放接口，但前者还有 Billing 的原有调用者，不能作为无用字段直接删除。以后统一时应连同 Billing 生命周期一起处理；此次没有证据表明值得为减少字段扩展修改面。

## 本轮验证与交付范围

执行六个相关测试文件：**46 项通过**，包括计数算法、策略配置、R2 取消、HTTP 准入竞争、lease 和资产路由。这些文件的实现与发布提交一致。

另运行 `.codex-tmp/vision-read-url-audit-20260920.mts`，直接导入固定 Git archive 中的 Gateway 源码，复现上表泄露并验证 Billing reset 隔离和六种释放顺序。资产、凭据、查询内容全部为本地合成数据，无生产数据库或 R2 操作。

自审阶段只新增该复现脚本和本报告，未修改业务源码或生产状态。

## 后续修复

用户要求修复后，提交 `07a650429bd828dc2390a7b747c4fd252743ccaa` 把资产请求的脱敏移到根级请求 logger factory，并移除原 POST 路由的局部 serializer。生成日志时覆盖成功匹配、404 路由上下文、认证及参数失败；不改实际 URL 或路由选择。资产标识、查询和未知尾部一律不进入请求日志，已知操作名只允许 read-url/complete。

增加 13 个完整 Gateway 集成用例，包括错误方法、末尾斜线、超长资产参数、编码路径、认证失败、无效 JSON、complete/delete 和非资产自定义 serializer 兼容。63 项相关测试及类型检查通过。固定版本 Linux 全量测试 1535 项通过、3 项跳过，8 种公网请求的相关 Gateway 日志均未含合成资产标识或查询值。发布验证、检查边界与最终线上状态见 [修复发布记录](./operations/r760-vision-log-redaction-release-2026-09-20.zh-CN.md)。
