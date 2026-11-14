# MedEvidence R760 双轨手机号登录 Desktop 联调交接

状态：`ready_for_desktop_integration`（Gateway 端已完成；生产 Phone Auth 开关保持关闭）

## 固定合同

| 项目 | 值 |
| --- | --- |
| Gateway 分支 | `feature/r760-dual-track-phone-auth-v1` |
| 实现基线 | `c528f4a8609dc88c56fc883426e54dd91ba73308` |
| R760 已部署代码提交 | `f7e69eabbc5c1fed484d63f2547af158fc70238e`（包含 production `c0d26ec` dashboard） |
| Canary/快照证据脚本提交 | `3aa506b` |
| R760 Gateway image | `sha256:2c7b587c1005ea77e5f89647c793b3e5617d49564681f10f371d4f463cfb8891` |
| R760 current / previous | `f7e69eabbc5c1fed484d63f2547af158fc70238e` / `c0d26ec28eb4794cea14750bd0a68e5a7b57b981` |
| Contract | `medevidence-r760-dual-track-phone-auth-v1` |
| Contract 状态 | `contract_candidate`；等待 Desktop 对同一 commit 和 SHA 正式签收 |
| README SHA-256 | `8cc44f4cd2f0e81e2747aa720df75a9fb0096c558cd06396e2456ccc7da9f2e2` |
| fixtures SHA-256 | `44ee80ce8eab7d1dbd22dede4cc9320a9cc9e97a11aea2ac3e1b8a0ea17cbb02` |
| Gateway Origin | `https://goldencode.instmarket.com.au:1443` |
| 最低 Desktop 版本 | `2.0.0-beta.40` |
| Desktop 下载地址 | `https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe` |
| Phone auth method | `transition_phone_only` |
| 当前生产开关 | `GATEWAY_PHONE_AUTH_MODE=disabled`；`GATEWAY_DESKTOP_VERSION_GATE=disabled` |

Desktop 必须以本分支完整 HEAD、上述已部署代码提交和两个 fixture SHA 为签收对象；不得只复制旧 frozen contract。Gateway ready 不代表 Desktop 已实现、合同已由双方冻结、真实用户已获准预登记或 beta.40 已获准发布。

## 路由与错误矩阵

`auth_only` 只对以下五条 Phone Session 路由要求版本 Header：

- `POST /gateway/auth/v1/login/start`
- `POST /gateway/auth/v1/token/refresh`
- `POST /gateway/auth/v1/logout`
- `POST /gateway/auth/v1/session/bootstrap`
- `GET /gateway/account/v1/current`

beta.38 的 resolver、credentials current、
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

跨响应必须一致：Phone Session Subject、bootstrap/resolver unified-key prefix 与 expiry、resolver/credentials-current backing prefix、Plan、entitlement、capabilities、额度/既有用量和 Origin。未登记手机号不得自动开户；已登记手机号在无旧 Key 的新设备上可直接登录并 bootstrap 同一 Subject 的 current Key。

## Gateway 与 R760 验证证据

- `npm run build`、完整 `npm test`（727 pass、2 skip）、`git diff --check`、敏感信息扫描、fresh/legacy migration 25 幂等测试全部通过。
- `disabled/auth_only/all` 与 `transition` 启动组合矩阵通过；旧 `enabled` 和 `transition + disabled/all/enabled` 均在监听端口前失败。
- disabled 基线及 auth_only canary 中，beta.38 无 Header 的 resolver、credentials current、models、chat、tools、Responses、Research 和 Vision 全路径通过。Image 路由到达既有上游后因上游 credits exhausted 返回 upstream-origin 429，不是 426，也不是 Gateway 版本门禁回归。
- beta.40 的三种低版本输入均返回 426；登录、bootstrap、account current、Refresh rotation/replay、logout、identity disable、`phone_login_disabled`/`account_disabled` 区分和 phone/IP/device 三维 429 均通过。
- logout、replay、Phone identity disable 和临时 Subject disable 均未撤销旧 Key。完整 Phone 生命周期保持同一 Subject、Plan、entitlement、capability 和既有用量。
- pre/post SQLite 比较证明部署前已有 Subject、credential、unified key、Plan、entitlement 和 request event 无缺失或内容变化；额度窗口无回退。migration 25 保留，数据库 integrity/FK 通过。
- 配置已回滚到 `disabled/disabled` 和默认 `5/20/10`。Gateway 与三个 Research 容器健康、restart=0，Research 容器未 recreate，只有 Gateway 发布 `127.0.0.1:18787`，六个生产卷未变。
- 四个受控临时 Subject 已全部停用并清除 phone、活动 Key、entitlement、Phone identity/Session；临时文件已删除。没有真实用户写入或业务状态变化。日志/fixture/测试输出未包含真实手机号、JWT、Refresh Token 或完整 Key。

## Desktop 尚需完成

1. 落地正式回复中定义的双轨状态机：`legacy_ready`、Phone Session pending/active、Subject mismatch fail-closed 和 legacy runtime 保留规则。
2. 对 legacy Key、Phone Session bootstrap 和 account current 执行 Subject 一致性比较；mismatch 必须 fail closed，不能覆盖现有 runtime。
3. 通过 OS safeStorage 保存 Session；refresh 使用 singleflight，并在发送前持久化 pending 标记。新 token pair 无法确认落盘时清除 Session 并重新登录，绝不 replay 旧 Refresh Token。
4. “退出此设备”调用 Gateway logout 后写入本地 legacy logout suppression，防止旧 Key 自动回填；该行为不得请求 Gateway 撤销旧 Key。
5. 新设备无旧 Key 时，只有已登记手机号登录成功后才能 bootstrap；`phone_not_registered` 不触发开户。
6. beta.40 联调包发送严格 SemVer Header，beta.38 旧路径继续不发送 Header；完成 beta.38 原地安装升级、网络/进程故障和恢复矩阵 E2E。
7. 对本 contract 的完整 commit、README/fixtures SHA 和错误分类正式签收；完成后才可把 artifact 从 `contract_candidate` 冻结为双方接受状态。

## 真实用户预登记

仍需业务 owner 提供并明确批准“手机号、现有 Subject、现有 current
`cgu_live_*`”一一对应名单，并逐项确认 Subject 活动、Plan/entitlement/capability
符合预期。当前没有获批名单，本交接只允许生成脱敏只读 readiness 报告，不授权任何真实用户写入、Key/Plan/entitlement 修改或 Desktop beta.40 发布。
