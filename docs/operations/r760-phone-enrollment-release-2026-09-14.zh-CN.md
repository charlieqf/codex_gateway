# R760 历史账号手机号补登记上线记录

2026-09-14。北京时间 **16:22:34**（UTC 08:22:34，Sydney 18:22:34）部署完成；16:23:42 部署后审计通过。用户已授权 commit、push 和部署，R760 为唯一业务环境及 Gateway 权威。

## 结果与版本

历史 Billing 账号已经有 Subject 和 Desktop Key、缺少手机号或 Phone identity 时，身份后台携带已验证手机号关联账号，现在会补齐登录登记并复用原 Key。resolve 返回 `200 linked`；直接带 phone 开户完成补登记后仍返回 `409 subject_already_exists`，保持查询恢复合同。重复关联不重写身份，冲突和无效 Key 明确失败。

| 项目 | 值 |
| --- | --- |
| 运行源码提交 | `892a76dc12486b400a5d42ce565bcf7f6cebe2a3`，已推送 `origin/main` |
| 部署操作脚本提交 | `06f9c6c6f67d95f9ee24a1472c34b06c768c5bca`，已推送 `origin/main` |
| current | `/opt/codex-gateway-r760/releases/892a76dc12486b400a5d42ce565bcf7f6cebe2a3` |
| previous | `/opt/codex-gateway-r760/releases/0bfb98589bb90ef2315e3321866d12bd21ab6fcf` |
| Gateway 镜像 | `codex_gateway_r760-gateway:892a76dc12486b400a5d42ce565bcf7f6cebe2a3` |
| 镜像 ID | `sha256:b7035f500f503636ffeb6e9daa3b1c6e71d3726ae8277f7bb41401f84738afaf` |
| 源码归档 SHA256 | `bb82d316e5a26914b7aab42c8183dcf6fab956af0a38e36816a502ee58382a7a` |
| Gateway 状态 | healthy，RestartCount 0，公网 `/gateway/health` 为 ready |
| 数据库 schema | 30，无迁移 |

源码归档由固定提交 `git archive` 生成，在 R760 校验哈希、归档路径及链接安全后解包。使用已有 `deploy/r760-phone-signup.Dockerfile` 在 Linux 构建和验证，再覆盖既有生产镜像中的 Gateway/core/store-sqlite 产物。候选镜像使用独立 tag，没有重写 Research Worker 共用的旧镜像 tag。

后续三个操作工具提交修正旧版 Docker 构建完成识别、将空闲等待延长至 300 秒，并增加显式的带在途请求重启选项及请求留档。最终操作脚本从 Git 提交经 SSH stdin 执行；运行源码仍固定为 `892a76d`，没有把工作区未提交内容打入镜像。独立的年付周期、管理消息查询及客户端运行时 Key 改动未包含在本次发布中。

## 构建与公网验收

固定源码的 `npm ci --include=dev`、`npm run build` 成功；Vitest 两组分别为 28/28 和 595/595，共 **20 个文件、623 项测试通过**。Free/paid 编译产物 smoke 同样通过。构建日志保存在 R760 staging 和备份目录；见[构建摘要](../../artifacts/sms-login-pending-20260914/release/build-summary.json)。

使用 [public smoke 脚本](../../scripts/ops/phone-enrollment-public-smoke.mjs)，在唯一公网 Origin `https://goldencode.instmarket.com.au:1443` 创建两个合成历史账号，分别验证 resolve 和直接带 phone 开户路径。管理凭据仅从容器环境读取，没有输出；没有发送短信。共 **24 项 HTTP 检查通过**，包括补登记、重复关联、手机号冲突、登录、bootstrap、resolver/current 及账号清理。

| 验收 | request ID | 结果 |
| --- | --- | --- |
| resolve 补登记 | `req-64312338-a547-42e9-94c3-13da9941268e` | 200 linked，原 Key/权益/用量保持不变 |
| resolve 路径登录 | `req-5928f7eb-87da-45e5-b7c6-062c82709080` | 200 |
| resolve 路径 bootstrap | `req-7676922c-c47e-4c1d-8f4f-81b5ee259766` | 200，返回原 Key |
| 直接开户补登记 | `req-52373a8c-653e-48b0-b9b0-2871672dd023` | 409 subject_already_exists，已完成补登记 |
| 直接路径登录 / bootstrap | `req-510fc3f4-ba60-4430-bf1f-e952e7f113c8` / `req-423e9a2e-b1ed-4d88-8039-ef175f3df156` | 均 200，返回原 Key |
| 实际 goldencode 调用 | `req-9a6dcb61-c38f-4f7e-bd9f-2293a0008292` | 200，结算 135 token |

两个测试 Subject 为 `subj_MvEiqJTLPSbEoH2HeR7ihsaD`、`subj_5ksdF6Iy1ItPLIk4ypA08YvW`，均已停用，活动凭据、活动 Phone Session 和未结算预留均为 0。审计保留测试记录。详见[完整公网回执](../../artifacts/sms-login-pending-20260914/release/public-smoke.json)。

## 备份、数据和服务核对

保护目录 `/opt/codex-gateway-r760/backups/phone-signup-892a76dc1248`（0700）保留三库在线备份、配置副本、旧镜像信息、构建日志与操作回执。三库备份均为 quick_check ok、外键错误 0；切换前另生成并验证 `gateway-pre-cutover.db`。大小和哈希见[脱敏部署摘要](../../artifacts/sms-login-pending-20260914/release/deployment-summary.json)，完整含配置的证据只保留在受保护目录。

部署后再次只读检查三库，quick_check 均 ok、外键错误均为 0。与切换前备份逐行比较，原有 subjects 970、access_credentials 979、unified_client_keys 480、plans 16、entitlements 643、phone_auth_identities 264，**改动数全部为 0**。此比较针对控制记录；线上请求的运行用量和审计正常继续增长。

共享 override 仅修改 Gateway 的 image。容器环境、端口及其他配置哈希一致；仅 Gateway 容器替换。Research Worker、Research LLM Gateway、Research maintenance、Mihomo、Qwen 五个容器 ID 均未变化且 healthy。审计窗口中 Gateway fatal/error/uncaught/unhandled 均为 0。见[部署后审计](../../artifacts/sms-login-pending-20260914/release/final-audit.json)。

激活脚本在失败时恢复旧配置和镜像，不回灌运行中的数据库。本次无需回滚；后续若回滚应使用 schema 30 兼容的 previous，保留新增身份及其审计记录。

## 切换期间的在途请求

等待期间持续有新请求进入，300 秒内没有完全空闲窗口。已向用户说明可能需要客户端重试后，按部署授权使用显式 `--restart-with-active-requests`，切换前保存两个未完成 request ID。操作在 UTC 08:22:24 开始，Gateway 于 08:22:28 启动，08:22:34 完成健康与公开入口核对。

08:27:38 只读复查时，两条请求均无 `request_events` 完成回执，预留已由现有过期机制按 `estimate` 结算：

| request ID | 预留结算时间 UTC | final_total_tokens |
| --- | --- | --- |
| `req-144ddfdc-f949-4b32-ba0c-cc7977a33f5d` | 08:24:31.575 | 67,221 |
| `req-cb6fd87b-f891-40ad-95c8-3208465ddf8f` | 08:27:20.794 | 93,595 |

不能将这两条记录当作客户端已完整收到结果的证据；受影响请求可能需要重试。上述数值是预留记录的估算结算，不能据此推断供应商实测用量或用户实际应退额度。本次没有手工改写其结算。见[切换请求核对](../../artifacts/sms-login-pending-20260914/release/cutover-requests.json)。

## 原报障账号的恢复边界

本次验证确认 Gateway 的历史账号登记缺口已修复并生效。原报障手机号缺少可定位的外部 user_id，调查时连续失败窗口没有开户/关联入站，所以不能声称本次部署已自动恢复该账号。身份后台仍需以既有 `provider`、`external_user_id` 携带已验证手机号发起关联或开户，之后客户端验证登录及实际调用。只有一个业务环境，无需区分 prod/test。

对客户端和身份后台的交接见[修复回执](../outbox/medevidence-sms-login-phone-enrollment-fix-receipt-2026-09-14.zh-CN.md)；原始问题证据见[调查回执](../outbox/medevidence-sms-login-phone-not-registered-gateway-result-2026-09-14.zh-CN.md)。
