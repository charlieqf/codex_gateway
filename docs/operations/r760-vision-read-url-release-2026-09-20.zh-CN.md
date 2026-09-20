# R760 图片链接刷新独立限流发布记录

日期：2026-09-20。状态：已部署、公网验收及最终审计通过；03:52:43 UTC 完成清理核验。

## 发布结果

Gateway 于 03:37:32 UTC 启动提交 `4b1dc8fa4f0f5a3e9d6e97ef83dc9f2921c862c2`，03:37:38 UTC 通过切换核验。仅重建 Gateway；数据库版本仍为 34。

- 图片刷新：每个已认证 subject 独立 **20 并发、1920 次/分钟、80000 次/UTC 日**。
- 仅精确注册的 `POST /gateway/vision/assets/:assetId/read-url` 使用该预算。同主体不同 Key、会话和设备共享；不同主体独立。
- 普通请求仍按原 credential 计数。图片上传、complete、删除、生成、编辑及带图模型请求都不能使用刷新名额。
- 每个获准刷新计一次；内部两次 HEAD 不重复计数，已获准后的失败和取消不退次数。429 不扣次。
- HTTP 断开会取消存储查询；名额等 HTTP 与工作 Promise 都结束才释放，避免提前腾出尚在工作的名额。

实现使用现有限流算法的两个实例和统一入口的一次策略选择。内部接口整理为 `key + scope + policy`，其他消费者保持原有 key、scope 和算法；没有第二次 acquire、事后返还普通次数或复制计数算法。

设计、容量选择与限制见 [实现方案](../implementation/vision-read-url-independent-rate-limit-design-2026-09-20.zh-CN.md)。此次修复无需客户端发布；20 并发仍不能保证多个会话同时超过 20 次刷新时不出现 429。

## 固定版本验证

- 类型检查通过；相关 HTTP、身份、Research 路由等集成验证通过。
- 不包含原有未提交修改的固定 Git archive，在 Linux 镜像中完成构建和全量测试：**1522 通过、3 跳过，80 个测试文件通过、1 个跳过**，耗时 72.99 秒。
- 编译产物的 free/paid quota smoke 通过：chat/responses 的流式及非流式共四条路径、额度拆分、Billing 读取和重放均通过；不调用外部模型。
- 测试覆盖：8 并发复现、20+4 隔离、第 21 个拒绝、跨 Key 共享/跨主体隔离、分钟/日双向耗尽、UTC 边界、失败计数、伪造路由类别、身份/方法拒绝、日志脱敏、真实 HTTP socket 断开与异步工作收尾、HEAD 阶段取消和超时竞争。
- Windows 脏工作区全量测试曾为 1582 通过、5 失败、3 跳过；失败涉及 Research practical-profile 与 CLI 超时。发布版本排除原有未提交工作，在 Linux 上没有这些失败；不将脏工作区结果冒充发布版本通过结果。
- 对生产备份副本用候选 Store 打开两次，26 张表逐表逐行摘要和行数保持相同，schema 34、quick_check/FK 均通过。
- 原有 25 个已修改文件的未提交变更按增删行逐项核对保留；未跟踪的既有文件不纳入此次提交。恢复备份位于本机受限目录 `C:\work\backups\gateway-vision-read-url-20260920`。

## 生产 R2 与公网验收

03:13 UTC 的存储预检创建 40 个临时 PNG，分别运行 8、20、两个主体合计 40 并发刷新，全部成功，p95 为 1655 / 1700 / 1833 ms。40 个资产全部删除。这一步只验证存储路径，不经过 Gateway HTTP 限流。

03:42:54 UTC 开始公网验收，使用两个独立临时账号、三把 service Key、16 张 68-byte PNG。所有 **204 个 HTTP 响应断言**通过，另验证一次主动断开：

| 场景 | 结果 | p95 |
|---|---|---|
| 原事故的 8 张图片同时刷新 | 8/8 HTTP 200 | 1820 ms |
| 已有 4 个普通请求，再发 20 个刷新 | 刷新 20/20 HTTP 200；第 5 个普通请求按 credential 并发 4 拒绝 | 1857 ms |
| 同主体两把 Key 同时发 40 个刷新 | 20 个 200、20 个预期 429；subject 并发 maximum/used 都为 20 | 1772 ms |
| 两个主体各发 20 个刷新 | 40/40 HTTP 200 | 2024 ms |
| 普通 20 RPM 耗尽后刷新 8 张图片 | 普通下一次 429，图片 8/8 HTTP 200 | 1615 ms |
| 主动取消一个刷新，再发 20 个 | 取消记录为 client_aborted；随后 20/20 HTTP 200 | 1755 ms |

同时验证图片实际下载内容哈希、跨主体资产 404、伪造类别参数 400。真实 `goldencode` 非流式调用成功，使用 135 tokens（132 输入、3 输出）。未在生产人为耗尽 80000 日额度；日边界与双向隔离由固定版本的可控时钟集成测试验证。

日志核验得到 139 个刷新终态事件：116 个 200、1 个 404、1 个 400、20 个 429、1 个 499。每个完成刷新恰好一个终态事件，取消同样记录一次；相关日志没有资产 token、测试凭据或签名 URL。

首次公网脚本在读取数据库时因执行用户不匹配而退出，尚未发出测试请求；修正脚本为 Gateway 的受限运行用户后完整验收通过。没有修改容器权限或产品代码来绕过检查。

## 备份、产物与回退

- 旧版本/current-before：`71689e3012e7a5092bca09ca59bdd31f4f0a1b68`。
- 新镜像 ID：`sha256:34fabf24a40c9f9381041d5fca36579d045cbddb8e1018e2bc0c071bb7f239e0`。
- Git archive SHA256：`62245d4eab0da5b719b14ce6b873c79198efc79d7b97997768a8e7e6ac28fb00`，7324616 bytes；凭据扫描通过。
- R760 受限备份：`/opt/codex-gateway-r760/backups/phone-signup-4b1dc8fa4f0f`。目录名沿用受控准备脚本；本次内容为 Gateway 图片刷新发布备份。
- 已核验 gateway.db、client-events.db、research.db 在线备份及受限配置/恢复密钥备份。停旧 Gateway 后另做 `gateway-pre-cutover.db`，确保切换快照一致。
- 构建、兼容性、切换、回退和验收脚本保存在 `staging/4b1dc8fa4f0f5a3e9d6e97ef83dc9f2921c862c2`。Docker build 从独立固定 archive 构建，不部署开发目录。
- 如需回退，只恢复旧 Gateway 镜像及 current/previous、旧 override；保留 schema 34 和全部业务数据。准备了固定版本的 `rollback.py`，本次没有执行回退。不自动恢复数据库覆盖新增业务记录。

两份临时权益已取消、三把 Key 已撤销、两个主体已禁用，活动凭据和未结算 reservation 均为 0。16 个资产删除后又逐一验证均为不存在；容器和宿主机上的临时明文凭据文件已删除。测试审计记录保留，不以删除数据库行掩盖操作历史。

03:51:37 UTC 最终运行审计通过：current/previous、固定镜像、配置及恢复密钥摘要正确；只有 Gateway image 配置发生变化。Gateway healthy、零重启，公网和回环 health 都为 ready；其余五个容器 ID 未变化且全部 healthy。三个数据库 quick_check=ok、外键错误为 0；上线日志 fatal/error/uncaught/unhandled 均为 0。

切换前的 3715 条既有控制记录逐项保持不变：subjects 1030、access_credentials 1040、unified_client_keys 540、plans 16、entitlements 767、phone_auth_identities 322。清理通过后于 03:52:43 UTC 单独核验临时账号状态。脱敏证据保存在上述受限备份目录的 `final-audit.json`、`public-smoke-report.json`、`vision-observability-audit.json`、`asset-cleanup-verification.json` 和 `vision-smoke-cleanup.json`。

## 运行边界

三个配置项为 `GATEWAY_VISION_READ_URL_CONCURRENT_REQUESTS`、`GATEWAY_VISION_READ_URL_REQUESTS_PER_MINUTE`、`GATEWAY_VISION_READ_URL_REQUESTS_PER_DAY`，省略时用本次默认值，非法值启动失败。没有修改生产用户的 credential.rate、Plan 或权益快照。

计数仍为单进程内存固定 UTC 窗口，重启清空，不是计费账本；多副本时需另行处理共享计数。Billing quota reset 只重置原普通计数。20 是每主体上限而非全站上限，本次短时测试不证明持续满载容量，也不能保证远端存储收到取消后立即停止工作。

结构化日志使用 `rate_limit_profile=vision_read_url` 和路由模板；Docker 以 50 MB × 5 文件轮转，不承诺固定保留天数。后续根据真实 429 分布和 R2 延迟评估容量。
