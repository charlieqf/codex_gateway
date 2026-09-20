# R760 图片资产请求日志脱敏修复

日期：2026-09-20。状态：已上线，04:27:44 UTC（14:27 Sydney）完成验证。

## 修复范围

提交 `07a650429bd828dc2390a7b747c4fd252743ccaa` 修复 [自审发现](../code-review-vision-read-url-2026-09-20.zh-CN.md)：脱敏原来仅覆盖成功匹配的 POST read-url 路由，GET、末尾斜线等未匹配请求仍会把资产标识和查询参数写入日志。

现在根级请求 logger factory 对图片资产路径统一输出固定模板，隐藏 assetId、查询参数和未知尾部，仅保留已知 read-url/complete 操作名。编码路径、超长参数、错误方法及认证失败同样适用。移除原路由内的局部实现；非资产请求沿用 Fastify 的原日志选项和 serializer。

这只改变日志展示。实际请求 URL、路由匹配、认证、权限及限流均不修改，图片预算仍为每 subject 20 并发、1920 次/分钟、80000 次/UTC 日。未新增依赖、数据库表、缓存或另一套限流算法。

## 验证

类型检查及 63 项相关测试通过。新增 13 个完整 Gateway 集成用例，覆盖正常 POST、GET/HEAD、末尾斜线、未知尾部、编码前缀、超长参数、401、无效 JSON、complete/delete、资产集合路径，以及非资产自定义 serializer。测试同时检查业务收到原始 assetId、存储调用次数和图片计数，防止把日志脱敏误用于请求分类。

固定 Git archive 的敏感信息扫描通过。原有 25 个文件的未提交修改保留，未纳入发布提交。

不可变源码在 Linux 镜像内完成全量测试：**1535 项通过、3 项既有外部 fixture 测试跳过**，80 个测试文件通过、1 个跳过，耗时 74.90 秒。编译后的 Free/paid 配额验证通过。新镜像离线打开生产备份两次，26 张表内容保持不变，schema 34、完整性及外键检查通过。

公网发送 8 种带合成资产标识和查询值的请求：POST、GET、HEAD、末尾斜线、超长参数、编码路径、complete 和 DELETE。按响应 request ID 关联 Gateway 日志，8 条 incoming request 均只保留固定模板，相关日志均不含测试资产标识或查询值。

这 8 个公网请求未带凭据，均由认证返回 401，未进入图片准入或存储服务；认证后的正常 200、404 和无效 JSON 等路径由完整 Gateway 集成测试覆盖。本次公网检查针对 Gateway 应用日志，不扩展为 Nginx 或所有外部日志的脱敏结论。没有创建生产账户、凭据或图片资产，没有调用 R2 或模型，无测试数据待清理。

## 发布产物与回退

- 切换前版本：`4b1dc8fa4f0f5a3e9d6e97ef83dc9f2921c862c2`；候选来自其后续 main，包含已部署的独立限流改动。
- 源码 archive SHA256：`574d9e0901fef1de6a5e7ef95c5b367b8eb30a6dd2441988756d1eb92f8ca787`，7329898 bytes。
- 镜像 ID：`sha256:6eebed0923c1446bbfc9e42d5e7cf4c1775a545494a7ae0dc6588dfc8ab69116`。
- 受控备份目录：`/opt/codex-gateway-r760/backups/phone-signup-07a650429bd8`，目录名沿用现有准备脚本。
- 只替换 Gateway，保留其他五个容器、环境变量和配置；schema 仍为 34。回退仅恢复原镜像及发布链接，不自动恢复数据库覆盖新业务数据。

04:27:01 UTC 开始切换，Gateway 于 04:27:05 启动，04:27:11 健康确认。`current` 指向 `07a6504`，`previous` 指向 `4b1dc8f`；上线使用已提交并推送的固定版本，不含开发工作区改动。

最终复核：公网和回环 health 均为 ready，Gateway 零重启，其他五个容器 ID 不变且健康；三个 SQLite 数据库均 `quick_check=ok`、外键违规为 0。切换前的 3722 条主体、凭据、统一 Key、Plan、权益和 Phone identity 记录逐行比对无变化。上线以来 error/fatal/uncaught/unhandled 日志计数均为 0。

服务器受保护备份目录保留 `deployment.json`、`build.log`、`compatibility.json`、`public-redaction-smoke.json`、`final-audit.json` 及数据库/配置备份。原独立图片限流的并发、取消、普通额度隔离和真实模型验收见 [此前发布记录](./r760-vision-read-url-release-2026-09-20.zh-CN.md)。
