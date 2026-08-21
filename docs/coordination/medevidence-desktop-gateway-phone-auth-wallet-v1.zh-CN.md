# MedEvidence Desktop × Codex Gateway 内部用户手机号登录 v1 联合协调

> **状态提示（2026-08-21）：** 本文记录的一次性切换、旧 Desktop
> 不再兼容和全路径 426 方案，已由
> [`MedEvidence R760 双轨兼容手机号免验证码登录 Gateway 实施规格 v1`](../implementation/medevidence-r760-dual-track-phone-auth-gateway-implementation-spec-2026-08-21.zh-CN.md)
> 替代。新的 additive contract 为
> [`medevidence-r760-dual-track-phone-auth-v1`](../contracts/medevidence-r760-dual-track-phone-auth-v1/README.md)。
> 本文及其旧 frozen fixture 作为历史基线保留，不得据此启用生产；未被新规范替代的 v1 wire shape 仍可复用。
> 截至 2026-08-21，新方案仅完成本地候选和自动化门禁，尚未完成 R760
> additive/canary，不能把本历史稿的 `active`、全路径 426 或一次性切换文字视为当前状态。

| 项目 | 内容 |
| --- | --- |
| 文档状态 | `draft`；双方确认并合入 Gateway `main` 后改为 `active` |
| 实施状态 | `contract_frozen`；Gateway/Desktop 已签收同一 contract `47b0e9cafa5cf2525bc2d17d99f98c9364919a4a`，双方可继续实现和真实 adapter 联调 |
| 协调版本 | `coordination-internal-v1-draft.3` |
| 当前范围 | 少量、已知、可逐一协调的内部用户 |
| 唯一运行环境 | R760 `https://goldencode.instmarket.com.au:1443` |
| 客户端范围 | 当前按 Windows x64；若目标用户实际使用其他平台，窗口前补齐该平台 |
| 最后更新 | 2026-08-20 |

## 1. 当前实施范围

本次只完成内部手机号直登和统一客户端升级：

1. 管理员提前为每个目标手机号准备完整内部账户；
2. 用户输入已登记手机号后直接取得 Session，不发送短信验证码；
3. Desktop 完成 bootstrap、resolver、credential/account current 后进入主界面；
4. 所有目标用户在一次协调维护窗口升级；
5. 切换后旧 Desktop 不再兼容。

公开注册、真实短信、免费 50 万 Token/3 次图片、用户协议与隐私政策、充值及月付/年付支付不属于本次实施，后续需要时另立 v2。内部用户继续使用现有明确的内部 Plan/额度，不进入新消费钱包。当前统一 Desktop 已有的 Vision 图片附件能力继续保留；它不是“免费图片次数”，其四条 Gateway Asset 路由纳入本次 426 覆盖。

R760 是唯一运行、账户、Key、Plan 和用量权威。其他 Gateway 环境逻辑下线，即使 VM 或进程仍保留，也不承担兼容、发布、用量合并或回滚职责。

## 2. 唯一规范来源和责任人

本次只有两类规范来源：

1. 本文：范围、责任、风险决定、版本门禁和维护窗口；
2. [`medevidence-internal-phone-auth-v1` contract fixture](../contracts/medevidence-internal-phone-auth-v1/README.md)：方法、路径、字段、响应和错误映射。

Gateway/Desktop 的详细设计只是不具规范效力的实现参考。发生冲突时，以本文和双方签收的 fixture commit 为准；详细设计是否合入各自仓库不再是本文生效的前置条件。

### 2.1 责任人

| 角色 | 人员/GitHub 身份 |
| --- | --- |
| 业务升级与风险负责人 | 待填写 |
| Gateway owner | 待填写 |
| Gateway reviewer | 待填写 |
| Desktop owner | 待填写 |
| Desktop reviewer | 待填写 |

### 2.2 活动链接与不可变链接

| 规范 | 活动链接 | 当前签收 commit permalink | 状态 |
| --- | --- | --- | --- |
| 本文 | [Gateway `main`](https://github.com/charlieqf/codex_gateway/blob/main/docs/coordination/medevidence-desktop-gateway-phone-auth-wallet-v1.zh-CN.md) | [`7d661a323bf96da81b297db50676841b2a38db3c`](https://github.com/charlieqf/codex_gateway/blob/7d661a323bf96da81b297db50676841b2a38db3c/docs/coordination/medevidence-desktop-gateway-phone-auth-wallet-v1.zh-CN.md) | `draft` |
| Contract 说明 | [Gateway `main`](https://github.com/charlieqf/codex_gateway/blob/main/docs/contracts/medevidence-internal-phone-auth-v1/README.md) | [`47b0e9cafa5cf2525bc2d17d99f98c9364919a4a`](https://github.com/charlieqf/codex_gateway/blob/47b0e9cafa5cf2525bc2d17d99f98c9364919a4a/docs/contracts/medevidence-internal-phone-auth-v1/README.md) | `frozen` |
| Contract fixtures | [Gateway `main`](https://github.com/charlieqf/codex_gateway/blob/main/docs/contracts/medevidence-internal-phone-auth-v1/fixtures.json) | [`47b0e9cafa5cf2525bc2d17d99f98c9364919a4a`](https://github.com/charlieqf/codex_gateway/blob/47b0e9cafa5cf2525bc2d17d99f98c9364919a4a/docs/contracts/medevidence-internal-phone-auth-v1/fixtures.json) | `frozen` |
| Contract 完整性文件 | [Gateway `main`](https://github.com/charlieqf/codex_gateway/blob/main/docs/contracts/medevidence-internal-phone-auth-v1/SHA256SUMS) | [`47b0e9cafa5cf2525bc2d17d99f98c9364919a4a`](https://github.com/charlieqf/codex_gateway/blob/47b0e9cafa5cf2525bc2d17d99f98c9364919a4a/docs/contracts/medevidence-internal-phone-auth-v1/SHA256SUMS) | `frozen` |

活动链接在 PR 合入前可能返回 404。Contract 只有在 fixture 目录进入远端 commit、本文写入包含完整 40 位 commit SHA 的 permalink、Gateway 与 Desktop 对同一 commit 签字后才是 `frozen`。

## 3. 最小规范合同

### 3.1 完整路由

| 方法 | 路径 | 授权 |
| --- | --- | --- |
| `POST` | `/gateway/auth/v1/login/start` | 无 bearer；手机号直登 |
| `POST` | `/gateway/auth/v1/token/refresh` | JSON 中的 Refresh Token |
| `POST` | `/gateway/auth/v1/logout` | Access JWT |
| `POST` | `/gateway/auth/v1/session/bootstrap` | Access JWT |
| `POST` | `/gateway/unified-keys/resolve` | `cgu_live_*` |
| `GET` | `/gateway/credentials/current` | resolver 返回的 `cgw.*` |
| `GET` | `/gateway/account/v1/current` | Access JWT |

请求/响应必填字段、bodyless 规则、成功 fixture 和 HTTP 错误映射均在 [contract 说明](../contracts/medevidence-internal-phone-auth-v1/README.md) 与 [`fixtures.json`](../contracts/medevidence-internal-phone-auth-v1/fixtures.json) 中。Gateway/Desktop 已签收远端 commit [`47b0e9cafa5cf2525bc2d17d99f98c9364919a4a`](https://github.com/charlieqf/codex_gateway/tree/47b0e9cafa5cf2525bc2d17d99f98c9364919a4a/docs/contracts/medevidence-internal-phone-auth-v1) 为 frozen；双方可以继续实现、单元测试和真实 adapter 联调。

Desktop 只有在 bootstrap、resolver、`credentials/current` 和 `account/current` 全部成功，且 capability 包含 `chat` 后才能进入主界面。

同一 Session 的 Subject、unified-key prefix/到期时间、backing `cgw.*` prefix 和固定 R760 URL 必须满足 contract 中的跨响应一致性规则；任一不一致时 Desktop fail closed，不得带着部分匹配的 runtime bundle 进入业务请求。Unified key 到期时间保持现有非空 RFC 3339 语义，不在本次引入 nullable expiry。Resolver 兼容无正文和空对象 `{}`，仅拒绝含字段对象或其他 JSON 类型。

### 3.2 Refresh 歧义

Refresh Token 每次原子轮换。Desktop 在发送前持久化 pending 标记；若响应丢失、新 Token 落盘失败或进程崩溃导致结果不确定，Desktop 清除本地 Session 并重新登录，不再次发送旧 Refresh Token。v1 不提供 replay grace。

### 3.3 426 覆盖范围

`X-MedEvidence-Client-Version` 缺失、非法或低于 `minimum_desktop_version` 均返回结构化 HTTP 426 `client_upgrade_required`，正文必须包含 `minimum_version`、`download_url` 和 `request_id`。

版本检查覆盖：

- auth、refresh、logout 和 bootstrap；
- resolver、`credentials/current` 和 `account/current`；
- Desktop 的 `/v1/*` 模型请求；
- Desktop 的 `/gateway/research/v1/*` 请求；
- Desktop 的 `/gateway/images/generations` 请求；
- Vision Asset 的 create、complete、read-url 和 delete：`POST /gateway/vision/assets`、`POST /gateway/vision/assets/:assetId/complete`、`POST /gateway/vision/assets/:assetId/read-url`、`DELETE /gateway/vision/assets/:assetId`。签名 R2 `PUT` 不是 Gateway 请求，不携带 Gateway bearer 或版本头。

Gateway 通过绑定在 Session、`cgu_live_*` 和 backing credential 上的显式 credential class 判断 Desktop 请求。当前流程签发的 credential class 为 `desktop`。只有显式配置为 `service` 或 `operator` 的非 Desktop credential 才豁免；class 缺失或未知时不豁免。不得使用 `User-Agent`、源 IP 或“缺少版本头”推断豁免。

Credential class 是服务端绑定的元数据，客户端不得通过 header/body 自选或覆盖。Desktop 专用 auth 路由先执行版本检查；resolver 和业务路由先把 bearer 认证到足以确定 class，无效 bearer 仍返回 401，有效且不豁免的 credential 在版本头缺失、非法或过旧时返回 426。未来新增的 Desktop 业务路由默认执行同一门禁，除非双方在 frozen contract 中明确排除。

## 4. 手机号直登风险签收

`transition_phone_only` 不是强身份认证。任何知道已登记手机号的人都可能取得该用户 Session，并通过 bootstrap 取得长期 `cgu_live_*`。用户数量少、可以协调升级，并不能消除公网入口上的冒用风险。

如果继续采用手机号直登，Gateway 必须：

- 对 `login/start` 执行手机号 hash 与 IP risk key 双维度限流，429 返回 `Retry-After`；
- 审计 request ID、phone hash、Subject、Session、`auth_method=transition_phone_only` 和结果，不记录原始手机号或秘密；
- auth、bootstrap、resolver 和 current 响应统一返回 `Cache-Control: no-store` 与 `Pragma: no-cache`；
- 支持撤销 Session 和受控轮换当前 `cgu_live_*`；
- 不得把管理员直登记录为已经完成 SMS 验证。

| 风险决定 | 业务风险负责人 | 日期 | 备注 |
| --- | --- | --- | --- |
| 待填写：`accept phone-only risk` 或 `require second factor` | 待填写 | — | 未签字前实施状态不能进入 `ready` |

若业务负责人不接受该风险，双方在维护窗口前增加第二因素并更新 contract fixture；不能仅依靠“内部用户很少”上线。

## 5. 双方并行实现

Gateway 实现 additive schema、逐用户管理员准备、手机号直登、Session/JWT、bootstrap、account current 和全路径 426；Desktop 实现安全 Session Store、登录、refresh single-flight、bootstrap/resolver/current 就绪门禁、内存 Key 和升级页面。

双方可以并行开发，各自的单元测试、迁移测试和 PR 过程不写入共同台账。真实 adapter 联调只等待同一 contract fixture commit 被双方签为 `frozen`。

## 6. 一次协调维护窗口

### 窗口前

- [x] Contract fixture 已进入远端 commit，本文已记录 permalink，Gateway/Desktop 已签为 `frozen`；
- [ ] 业务风险负责人已签收手机号直登风险；
- [ ] Gateway candidate 已进入 `origin/main`，Desktop candidate 已进入 `origin/dev`；
- [ ] 每个目标手机号均已规范化并验证为唯一 Subject、唯一可恢复 current `cgu_live_*`、显式 `desktop` credential class、有效内部 Plan 和 `chat` capability；实际客户端平台已确认；
- [ ] 仍需访问覆盖路由的非 Desktop credential 均已有 owner，并被显式标记为 `service` 或 `operator`；不存在依靠缺失 class 获得豁免的调用方；
- [ ] Windows x64 或实际目标平台安装包位于稳定下载地址，并记录版本和 SHA-256；
- [ ] 所有目标用户已收到停止使用时间和升级方式；
- [ ] Gateway 已准备 online backup、上一个 R760 release、一个有效 SemVer 最低 Desktop 版本、HTTPS 稳定下载地址和一个最终验证账户；`transition_phone_only` 与 426 在窗口前保持关闭。

### 窗口内

1. 业务负责人确认所有目标用户停止使用；
2. Gateway 部署 additive release，写入最低版本和下载地址，启用内部手机号登录与全路径 426；
3. 在一台实际内部用户电脑安装正式 candidate；
4. 只执行一次最终 E2E：手机号登录 → bootstrap → resolver → `credentials/current` → `account/current` → 一次真实对话 → 重启客户端 → Session 恢复并重新完成 current 就绪检查；
5. 通过后，其余目标用户统一安装新客户端并恢复使用。

### 失败处理

最终 E2E 失败时：

1. 停止用户升级并保持用户离线；
2. 同时关闭 `transition_phone_only` 和 426 配置；
3. Gateway 撤销本次测试签发的 Access/Refresh Session，Desktop 清除本地 Session 和内存运行 Key；本次新签或轮换的 `cgu_live_*`/backing credential 必须明确记录为保留 current，或执行撤销/轮换，不能处于未决状态；
4. 必要时把应用二进制回滚到上一个 R760 release；
5. 保留 additive schema 和已经写入的审计记录，不使用旧数据库覆盖当前数据库；本范围不得产生消费钱包 ledger event，若异常产生则保留原始事件并前向核对，不删除事件伪造回滚；
6. 修复后重新安排维护窗口，不恢复第二 Gateway 入口。

## 7. 状态和签收

文档状态与实施状态分开：

| 类型 | 状态 | 含义 |
| --- | --- | --- |
| 文档 | `draft` | 本文尚未获双方确认 |
| 文档 | `active` | 本文已合入 Gateway `main`，Gateway/Desktop 已确认当前内容 |
| 实施 | `contract_pending` | fixture 尚未由双方签为 frozen |
| 实施 | `contract_frozen` | Gateway/Desktop 已签收同一 fixture commit，可以继续实现和真实 adapter 联调 |
| 实施 | `ready` | contract frozen、风险已签、candidate/安装包/逐用户预检/窗口均就绪 |
| 实施 | `completed` | 单次最终 E2E 通过，目标用户均已升级或明确保持离线 |

| 记录 | Gateway | Desktop | 业务风险负责人 | 证据 |
| --- | --- | --- | --- | --- |
| 文档转为 `active` | 待签 | 待签 | — | 本文 merge commit |
| Contract `frozen` | 已签收 `47b0e9cafa5cf2525bc2d17d99f98c9364919a4a`（签署身份待补） | 已签收同一 commit（签署身份待补） | — | Gateway/Desktop 均于 2026-08-20 明确回复接受该 commit 为 frozen |
| 维护窗口 `ready` | 待签 | 待签 | 待签 | 两端 commit、版本、SHA-256、逐用户预检 |
| 内部升级 `completed` | 待签 | 待签 | 待签 | 最终 E2E 时间与结果 |

Desktop 同时确认：原样使用 426 的 `download_url`；Refresh 结果存在歧义时清除本地 Session、重新登录且不重发旧 Refresh Token；跨响应一致性失败时 fail closed。Capability 集合一致性校验作为 Desktop 实现收尾，不修改 frozen contract，也不阻塞双方继续实现。

## 8. 后续另立计划

需要未知手机号注册、真实短信、免费钱包、图片赠送、收费支付、无法逐一协调的用户规模或新的正式平台时，再建立 v2。届时再讨论公众发布和支付所需的额外门槛。

## 9. 非规范性参考

- [Gateway 详细技术实施方案](../implementation/medevidence-phone-auth-cgu-wallet-implementation-plan-2026-08-15.zh-CN.md)
- [Gateway 当前系统状态](../operations/system-status.md)
- [R760 Control-Plane Authority](../operations/r760-control-plane-authority.md)
- [Desktop R2 发布手册](https://github.com/charlieqf/medevidence-app-src/blob/dev/docs/desktop-release-r2.md)

本节资料不得覆盖本文或 frozen contract fixture。

## 10. 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-08-20 | `coordination-internal-v1-draft.3` | 保持 unified-key 非空到期时间；冻结跨响应 Subject/Key/capability/URL 一致性；将四条既有 Vision Asset 路由纳入 426；resolver 接受无正文或空对象 `{}` |
| 2026-08-20 | `coordination-internal-v1-draft.2` | 删除旧的前置签收阶段和多文档门禁；分离文档/实施状态；补齐七条完整路由、fixture 冻结规则、全路径 426、手机号直登风险签收、逐用户预检、origin branch candidate、最终重启恢复 E2E 和数据库安全回滚 |
| 2026-08-20 | `coordination-internal-v1-draft.1` | 按少量可协调内部用户重写为最小 contract、双方并行、单维护窗口和单次最终 E2E |
