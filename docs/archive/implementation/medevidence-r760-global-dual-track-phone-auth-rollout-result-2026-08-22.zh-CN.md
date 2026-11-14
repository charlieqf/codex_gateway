# MedEvidence R760 全量双轨 Phone Auth 上线结果

| 项目 | 结果 |
| --- | --- |
| 状态 | `deployed` / `enabled` / `verified` |
| 执行时间 | 2026-08-22 15:07–15:31 AEST |
| Gateway release | `8d7acb977866cca41c38a3ec7c3ae4fc1a769ffe` |
| Gateway image | `sha256:3d5cb8b8062dea4d3960012150a9d3d9d7cfe2301be6c9f340bd533e3d50f162` |
| 生产模式 | `transition / auth_only / 2.0.0-beta.40` |
| 旧客户端 | 原有 `cgu_live_*` 继续可用，无 Desktop 版本 Header 也不进入 426 门禁 |
| 新客户端 | beta.40 及以上可使用已登记手机号、无需验证码登录 |
| 权威端 | 仅 R760；没有修改 Azure、CN1、Nginx、DNS、Research 或 vessel 配置 |

## 1. 业务范围

业务 owner 的最终要求是：所有符合条件的现有 MedEvidence 用户均可在新版客户端用手机号免验证码
登录；旧客户端继续使用原有 `cgu_live_*`。同时，owner 明确将最后两名缺失手机号的用户排除，
不再要求补登记。

生产只读审计得到 161 个同时满足“活动 Subject、`external_provider=manual_trial`、存在未撤销且未
过期统一 Key”的目标。排除 8 个：诊断用途 1 个、船期业务 1 个、合成 A/B 身份 2 个、重复或
非权威记录 2 个、owner 明确排除 2 个。最终准备 153 个 Phone identity。

排除仅表示不开放手机号登录；没有删除 Subject、历史数据或旧 Key。另清除了 3 条已确认陈旧或冲突
的手机号关联，避免手机号映射不唯一；没有删除对应 Subject。

## 2. 实现与发布

release `8d7acb9` 包含：

- 结构化 provider failure、attempt purpose、准确/估算 Token 分账及 Admin 诊断展示（schema 26）；
- real-user issuance 在成功发放 Subject、Plan、entitlement 和统一 Key 后自动准备 Phone identity；
- 旧 `cgu_live_*` 鉴权路径保持不变；
- 客户端公开 Gateway prefix 继续使用已冻结的 `cgw.<stored-prefix>` 合同。

发布前，相关 targeted 测试 197 项通过，typecheck、build、diff 检查和敏感信息扫描通过。Phase 0
支线合入前的完整门禁为 794 项测试通过、2 项按配置跳过。

R760 先以 `disabled / disabled` 部署该 release，并完成旧 Key resolve、唯一 `goldencode` 模型面和
真实聊天回归；随后才准备真实用户身份并启用生产开关。三个 Research 容器没有重建，ID 和配置均
保持不变。

## 3. 数据迁移方法

大量历史统一 Key 只保留哈希，无法恢复原明文。迁移没有轮换或撤销这些旧 Key，而是对每个目标：

1. 复用同一个 Subject、backing access credential、Plan、entitlement、capability 和用量归属；
2. 从现有加密 backing bundle 增发一个可恢复的兼容统一 Key；
3. 将新 Key 标记为该 Subject 的 Phone Auth current desktop Key；
4. 建立唯一 phone hash/ciphertext 到同一 Subject 的 identity；
5. 保留全部旧 Key 供旧客户端继续使用。

快照预演和实际执行结果一致：

```text
目标 Subject               161
排除                        8
成功准备                  153
新兼容 current Key        153
失败                        0
活动 Phone identity       153
quick_check                ok
foreign-key error           0
```

## 4. 备份与不变量

写入前权威在线备份：

```text
/data/codex-gateway-r760/backups/pre-global-phone-auth-identities-20260822T050748Z
```

该目录包含 Gateway、client-events、Research 三个 SQLite 在线快照、受保护配置、release boundary 和
SHA-256 清单；目录为 `0700`，数据库和配置副本为 `0400`。三个数据库均为
`quick_check=ok`、foreign-key error 0，SHA-256 复核通过。

启用开关前的独立配置回滚边界：

```text
/data/codex-gateway-r760/backups/pre-phone-auth-enable-20260822T052411Z
```

写入后逐行/逐对象审计证明：

- 200 条既有统一 Key 全部仍存在；其 hash、prefix、密文 bundle、撤销和到期状态未改变；
- 新增恰好 153 个兼容 Key，每个目标恰好一个 current Key；
- `plans` 和 `entitlements` 精确不变；迁移前已有 Phone Session 和 Refresh Token 精确不变；
- 新增恰好 153 个 active identity 和 153 条 `prepare_identity / ok` 审计；
- 排除的 8 个 Subject 均无 active identity；
- 迁移 request ID 未进入 `request_events`，认证准备没有计为模型请求或 Token 用量；
- 迁移期间生产正常流量继续增长，但没有计量行丢失或归因到迁移。

## 5. 生产验收

公开 health 当前返回：

```text
state=ready
phone_auth.mode=transition
phone_auth.version_gate_mode=auth_only
phone_auth.minimum_desktop_version=2.0.0-beta.40
```

旧客户端无版本 Header 的 resolve、公开 prefix、`/v1/models` 和真实聊天通过：

```text
req-549d8862-46c1-42ff-b828-47d4bb2d8e15
```

beta.40 受控身份完成 login、bootstrap、account current、resolve、`goldencode` 模型面、真实聊天、
Refresh 原子轮换、logout 和登出后拒绝。关键请求：

```text
login    req-884305e6-bbab-4f15-a645-55b121a3f389
resolve  req-806afd29-9481-4c22-8fea-b29700f3e96b
chat     req-1f48f108-25ca-442e-aa78-95474eca9176
refresh  req-c74f2df6-c199-41fb-902d-09512ee0aeb6
logout   req-3306f24e-9264-4f5b-aee6-9c0e14fbb003
```

负向合同通过：

```text
未登记手机号  403 phone_not_registered       req-67ed4fa0-0ad6-438d-b80c-1a645161f8b1
beta.39       426 client_upgrade_required    req-b0e6c07a-55b6-469a-a53b-ca1ed1cfb0c6
```

受控合成身份随后恢复为 `disabled`；活动 Session 和活动 Refresh Token 均为 0。最终再次在生产快照上
预演，153 个目标均可直接恢复现有 current Key，失败 0。Gateway 和三个 Research 容器均 healthy、
restart count 0。

## 6. 当前运行与回滚

当前状态是正式生产状态，不再由临时 timer 自动恢复 disabled。配置回滚只需要：

```text
GATEWAY_PHONE_AUTH_MODE=disabled
GATEWAY_DESKTOP_VERSION_GATE=disabled
```

然后使用完整 base + Research overlay + R760 override 仅重建 Gateway，并复验旧 Key 路径。配置回滚
不应删除 153 个 identity、不应撤销任何 Key，也不应恢复旧数据库。若 release 本身需要回滚，可使用
`previous=f7e69eabbc5c1fed484d63f2547af158fc70238e`、已验证备份和镜像 tag
`codex_gateway_r760-gateway:rollback-global-phone-auth-20260822T042929Z`。

后续新用户必须继续通过正式 real-user issuance 流程发放；提供有效唯一手机号时自动准备 identity。
登录接口对未知手机号只返回 `phone_not_registered`，不得自动创建账户或权益。
