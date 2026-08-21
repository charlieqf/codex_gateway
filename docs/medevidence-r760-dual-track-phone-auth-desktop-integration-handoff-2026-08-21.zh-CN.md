# MedEvidence R760 双轨手机号登录 Desktop 联调交接

状态：`gateway_candidate_local_validated`（R760 additive/canary 尚未完成，不可开始正式联调）

## 固定合同

| 项目 | 值 |
| --- | --- |
| Gateway 分支 | `feature/r760-dual-track-phone-auth-v1` |
| 实现基线 | `c528f4a8609dc88c56fc883426e54dd91ba73308` |
| 已验证代码提交 | `3c077fc` |
| Contract | `medevidence-r760-dual-track-phone-auth-v1` |
| README SHA-256 | `8cc44f4cd2f0e81e2747aa720df75a9fb0096c558cd06396e2456ccc7da9f2e2` |
| fixtures SHA-256 | `44ee80ce8eab7d1dbd22dede4cc9320a9cc9e97a11aea2ac3e1b8a0ea17cbb02` |
| Gateway Origin | `https://goldencode.instmarket.com.au:1443` |
| 最低 Desktop 版本 | `2.0.0-beta.40` |
| Phone auth method | `transition_phone_only` |

最终可联调 commit 将在 R760 验证后填入；Desktop 必须签收同一完整 commit 和上述 fixture SHA。

## 路由与错误矩阵

`auth_only` 只对 login、refresh、logout、bootstrap、account current 五条
Phone Session 路由要求版本 Header。beta.38 的 resolver、credentials current、
`/v1/*`、Research、image generation 和四条 Vision Asset Gateway 路由继续无 Header
运行，不得收到 `client_upgrade_required`。

| HTTP | code | Desktop 行为 |
| ---: | --- | --- |
| 403 | `phone_not_registered` | 保留独立有效的 legacy runtime；不得请求自动开户 |
| 403 | `phone_login_disabled` | 只关闭 Phone 登录；保持 `legacy_ready` |
| 403 | `account_disabled` | 整个 Subject 停用；清除 Session/runtime |
| 409 | `phone_identity_conflict` | fail closed，人工处理 Subject 映射 |
| 409 | `account_migration_required` | fail closed，交由管理员修复现有账户 |
| 426 | `client_upgrade_required` | 只在五条 Phone Session 路由按合同升级 |
| 429 | `auth_rate_limited` | 按 `Retry-After`/`retry_after_seconds` 退避 |
| 401 | `refresh_token_invalid` | 清除本地 Phone Session，重新登录；不 replay |

跨响应必须一致：Phone Session Subject、bootstrap/resolver unified-key prefix 与 expiry、resolver/credentials-current backing prefix、Plan、capabilities 和 Origin。

## Desktop 尚需完成

1. 落地正式回复中定义的双轨状态机：`legacy_ready`、Phone Session pending/active、Subject mismatch fail-closed 和 legacy runtime 保留规则。
2. refresh 前持久化 pending 标记；新 token pair 无法确认落盘时清除 Session 并重新登录，绝不 replay 旧 Refresh Token。
3. “退出此设备”调用 Gateway logout 后写入本地 legacy logout suppression，防止旧 Key 自动回填；该行为不得请求 Gateway 撤销旧 Key。
4. 新设备无旧 Key 时，只有已登记手机号登录成功后才能 bootstrap；`phone_not_registered` 不触发开户。
5. beta.40 联调包发送严格 SemVer Header，beta.38 旧路径继续不发送 Header。

## R760 验证待填

- deployed commit/image/current/previous：待 additive 部署后记录；
- disabled beta.38 全路径：待记录；
- controlled `transition + auth_only` canary：待记录；
- disabled 配置回滚与临时资源清理：待记录；
- Gateway/Research/Mihomo 健康、restart、listener、SQLite integrity/FK：待记录。

以上五项完成且 system-status 记录真实事实前，状态不得改为
`ready_for_desktop_integration`。

## 真实用户预登记

仍需业务 owner 提供并明确批准“手机号、现有 Subject、现有 current
`cgu_live_*`”一一对应名单。当前没有获批名单，本交接不授权任何真实用户写入、Key/Plan/entitlement 修改或 Desktop beta.40 发布。
