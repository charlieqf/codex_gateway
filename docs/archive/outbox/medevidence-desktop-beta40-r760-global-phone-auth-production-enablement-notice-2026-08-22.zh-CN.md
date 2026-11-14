# MedEvidence Desktop beta.40：R760 全量双轨 Phone Auth 正式启用通知

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-22（AEST） |
| 发送方 | Codex Gateway 团队 |
| 接收方 | MedEvidence Desktop 客户端团队 |
| 状态 | `production_enabled` / `contract_frozen` / `desktop_may_proceed` |
| 唯一生产 Origin | `https://goldencode.instmarket.com.au:1443` |
| 最低 Phone Auth 客户端版本 | `2.0.0-beta.40` |
| 当前生产模式 | `transition / auth_only / 2.0.0-beta.40` |
| Gateway 生产 release | `8d7acb977866cca41c38a3ec7c3ae4fc1a769ffe` |
| Gateway 生产 image | `sha256:3d5cb8b8062dea4d3960012150a9d3d9d7cfe2301be6c9f340bd533e3d50f162` |
| Desktop 已验收 commit | `65eadd000a310e64897e9700def9b8f4e0941be9` |
| Desktop beta.40 安装包 SHA-256 | `0dd8a6dc8ef28a06adba4d5428759c708233aa1bda8e8cb2731c489107056d95` |

## 1. 结论与客户端动作

R760 Gateway 已完成正式生产部署和全量启用。此前客户端联调回执中列出的两个等待条件已经关闭：

1. 不再需要临时 `transition/auth_only` 联调窗口；该模式现在是 R760 的永久生产配置，除非后续另行发布变更通知。
2. 现有 MedEvidence 用户的业务授权和批量身份准备已经完成，不再等待“真实用户预登记名单”批准。

客户端团队现在可以：

- 继续使用已经完成 live acceptance 的公开 beta.40 安装包；本次 Gateway 上线不要求重新构建 beta.40。
- 正式开展 beta.38 原地升级到 beta.40，以及全新 beta.40 安装后的真实用户使用。
- 在 beta.40 中让已登记用户只输入手机号、无需短信验证码即可登录并继续使用原账户。
- 继续保留已签收的 legacy Key 接管、显式恢复和登出 suppression 行为。

若客户端使用的安装包不是上表 SHA-256 对应的已验收 beta.40，应先按自身发布流程重新确认版本来源；本通知不授权发布其他未验收二进制。

## 2. 双轨兼容规则

### 2.1 旧客户端

- 已经填写原有 `cgu_live_*` 的 beta.38、beta.39 或其他旧客户端继续正常使用。
- 旧 Key 的 resolve、`/v1/models` 和真实聊天路径保持兼容。
- 缺少 `X-MedEvidence-Client-Version` 的 legacy Key 请求不会因为 Phone Auth 版本门禁而收到 426。
- 本次上线没有撤销、轮换或删除任何既有用户 Key。

### 2.2 beta.40 及以上客户端

- 已登记手机号调用 Phone Auth 时直接返回 `authenticated / transition_phone_only`，不进入验证码页面。
- bootstrap、account/current、credentials/current、unified-key resolve、Refresh 和 logout 按已冻结的 v1 合同执行。
- Phone Session 继续归属原 Subject、Plan、entitlement、capabilities 和 usage/额度窗口；登录本身不产生模型请求或 Token 消耗。
- `codex_gateway.key_prefix` 和 current credential prefix 的公开表示固定为 `cgw.<stored-prefix>`，并且必须是返回 `api_key` 的真实字面前缀。

### 2.3 负向行为

- 未登记手机号严格返回 HTTP 403 `phone_not_registered`；客户端应停留在已登出状态，不自动创建账户，也不要自动循环重试。
- beta.39 调用 Phone Auth 路由严格返回 HTTP 426 `client_upgrade_required`；应提示升级到 beta.40，而不是把它显示为服务不可用。
- 版本门禁仅作用于 Phone Session 相关认证路由，不应影响旧客户端的 legacy Key 业务流量。

## 3. 已启用用户范围

生产审计识别出 161 个同时满足“active Subject、`external_provider=manual_trial`、存在有效统一 Key”的现有目标，最终启用 153 个 Phone identity。

排除的 8 个对象包括诊断身份、船期/vessel 业务身份、合成 A/B 测试身份、重复或非权威记录，以及业务 owner 明确不再纳入的两名缺少手机号用户。排除对象没有开放手机号登录，但其 Subject、历史数据和既有 Key 均未被删除。

特别说明：船期/vessel 与 MedEvidence 是两个独立业务和客户端，不属于本次 MedEvidence Phone Auth 用户范围。

客户端不应硬编码用户数量或手机号清单。后续通过正式 real-user issuance 流程创建、且提供有效唯一手机号的新用户，会自动准备 Phone identity。

## 4. Gateway 生产验收证据

当前公共 health 返回：

```text
state=ready
phone_auth.mode=transition
phone_auth.version_gate_mode=auth_only
phone_auth.minimum_desktop_version=2.0.0-beta.40
```

旧客户端无版本 Header 的 legacy resolve、prefix、models 和真实聊天已通过：

```text
req-549d8862-46c1-42ff-b828-47d4bb2d8e15
```

beta.40 完整 Phone Session 流程已通过：

```text
login       req-884305e6-bbab-4f15-a645-55b121a3f389
bootstrap   req-53a02a97-487a-415f-9772-94163f5dfa46
account     req-f935ad7c-0a4d-4e61-9bbb-e7d2095929ea
resolve     req-806afd29-9481-4c22-8fea-b29700f3e96b
chat        req-1f48f108-25ca-442e-aa78-95474eca9176
refresh     req-c74f2df6-c199-41fb-902d-09512ee0aeb6
logout      req-3306f24e-9264-4f5b-aee6-9c0e14fbb003
enforcement req-2180ed6f-7aba-4710-ab11-0fb12cb1b366
```

负向合同已通过：

```text
unknown phone  403 phone_not_registered     req-67ed4fa0-0ad6-438d-b80c-1a645161f8b1
beta.39        426 client_upgrade_required  req-b0e6c07a-55b6-469a-a53b-ca1ed1cfb0c6
```

Gateway 和三个 Research 容器均为 healthy，restart count 为 0。受控合成测试身份已经重新 disabled，活动测试 Session 和 Refresh Token 均为 0。

## 5. 数据与计量不变量

- 200 条上线前已经存在的统一 Key 全部保留；hash、prefix、加密 bundle、撤销和到期状态未改变。
- 为 153 个目标 Subject 各增加一个可恢复的兼容 current Key，供 Phone Session bootstrap 使用；旧 Key 同时继续有效。
- `plans` 和 `entitlements` 保持不变；手机号登录映射到原 Subject，而不是建立第二个业务账户。
- 身份准备没有写入 `request_events`，没有被计为模型请求、重试或 Token 用量。
- 未登记手机号不会自动创建 Subject、Key、Plan 或 entitlement。

## 6. 客户端签收与问题回传

客户端已经完成的 A/B/U live acceptance 继续有效，双方冻结的 Contract ID 为：

```text
medevidence-r760-dual-track-phone-auth-v1
```

请客户端团队将此前状态中的“等待 Gateway 临时窗口/真实用户批准”更新为“Gateway 已正式启用”，并继续按已签收 beta.40 合同运行，无需为本次生产启用另做客户端协议改动。

若真实用户仍遇到登录或聊天问题，请回传以下最小诊断信息：

- 发生时间和时区；
- Desktop 完整版本；
- Gateway Request ID；
- 错误码和客户端终态；
- 手机号仅提供脱敏尾号，不要在普通文档或日志中写完整手机号、Key、Access Token 或 Refresh Token。

## 7. 权威记录

- Gateway 上线结果：`C:\work\code\codex-gateway\docs\archive\implementation\medevidence-r760-global-dual-track-phone-auth-rollout-result-2026-08-22.zh-CN.md`
- Gateway 合同冻结：`C:\work\code\codex-gateway\docs\archive\coordination\medevidence-desktop-beta40-phone-auth-r760-live-contract-freeze-2026-08-22.zh-CN.md`
- Desktop live acceptance：`C:\work\code\medevidence-opencode-stable\docs\outbox\medevidence-desktop-beta40-phone-auth-r760-live-acceptance-2026-08-22.zh-CN.md`
