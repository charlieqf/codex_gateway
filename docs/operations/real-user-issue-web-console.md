# 发放用户 Key 网页控制台

内部同事自助发放真实用户 `cgu_live_*` key 的网页入口，替代每次都由运维在本机手工跑
`scripts/issue-real-user-cgu-key.py`。

- 页面：`https://goldencode.instmarket.com.au:1443/gateway/admin/billing/v1/real-user-issue-ui`
- 权威：**R760 单权威（`authority_mode=r760_only`）**，不做 Azure 兼容镜像
- 鉴权：每人一个 Billing Admin token（`bat_test_*` / `bat_live_*`）

## 为什么是 R760-only

页面跑在 R760 Gateway 容器内，容器没有、也不应该有 Azure VM 的 SSH 私钥，因此无法执行
`scripts/issue-real-user-cgu-key.py` 默认的 R760 → Azure 兼容镜像。页面签发的 key 等价于该脚本的
`--r760-only` 模式：R760 校验全部保留，Azure 侧不写、不校验。

含义：**页面发出的 key 只在 `https://goldencode.instmarket.com.au:1443` 可用**，在旧的
`https://gw.instmarket.com.au` 上不可用。给仍在用旧端点的客户端发 key，必须继续用本机脚本的默认
（带镜像）路径。Azure 退役后此区别消失。

## 前置条件

| 条件 | 说明 |
|---|---|
| `GATEWAY_PUBLIC_BASE_URL` | 必须配置为公网 origin。缺失时发放接口返回 503，因为端到端校验无处可发 |
| `GATEWAY_API_KEY_ENCRYPTION_SECRET` | 必须稳定，否则加密 key 无法恢复 |
| MedEvidence v2 provisioning | 必须已配置，隐藏的 `mev2_live_*` key 由它创建 |
| Billing Admin token | `hybrid`/`db` 模式下用 admin CLI 逐人签发 |

## 给同事开通

每人一个独立 token，便于审计与单独吊销：

```powershell
npm --workspace @codex-gateway/admin-cli run dev -- --db <gateway.db> `
  billing-token issue --label "<姓名>-issue-console" --kind test --expires-days 30
```

只有 `issue` 的响应会显示完整 `bat_test_*`，通过约定私密渠道单独交付，不要进聊天/文档/截图。
后续用点号前的公开前缀做 `billing-token list|show|revoke` 和审计查询。丢失只能重发 + 吊销旧前缀。

## 页面使用

1. 填 Billing Admin token（只存本标签页 sessionStorage），点「确认套餐」。
2. 填姓名、手机号。手机号决定 `external_user_id`（`phone_<数字>`），同号重复发放会被拒。
3. 两个下拉：
   - **有效期**：默认 92 天，最少 90 天
   - **限额档位**：标准 10/分·200/日·4 并发；加强 30/600/8；或自定义
4. 点「发放 Key」→ 立即返回 job，页面轮询进度。

**Plan 是固定的**，不给选：`plan_internal_high_quota_image_v1`，即真实用户的既定默认（含
`chat`/`tools`/`image_generation`）。页面仍会调 `GET /plans` 把它的能力和 token 配额显示出来，
让发放人看得见自己在发什么，但不提供切换。**Scope 也不再出现在界面上**，由服务端取该 Plan 的
`scope_allowlist[0]`（即 `code`）。

接口层仍然接受 `plan_id` 和 `scope` 两个可选字段并照常校验，所以需要非默认套餐时走 API 或本机
脚本，不必改页面。要更换页面固定的套餐，改 `defaultRealUserPlanId`。

## 为什么是后台任务

一次完整发放含端到端校验通常要几十秒。同步返回会撞 Nginx/代理超时，关标签页也会丢结果。所以：

- `POST /gateway/admin/billing/v1/real-user-issue` → `202` + `job_id`
- `GET  /gateway/admin/billing/v1/real-user-issue/:jobId` → 轮询状态
- `GET  /gateway/admin/billing/v1/real-user-issues` → 本 token 最近的发放

五个步骤，逐个在页面上亮起：

1. `create_subject` 创建计费主体与 key（含隐藏的 MedEvidence v2 key）
2. `grant_entitlement` 授予 Plan 权益，必须变为 active
3. `resolve_key` 走公网 `/gateway/unified-keys/resolve`，校验 subject 一致、`cgw.` 运行态 key、
   MedEvidence 运行态 key、endpoint 与校验地址指向本 origin
4. `normalize_metadata` 写入姓名/手机，规范 label、限额与到期
5. `validate_credential` 走公网 `/gateway/credentials/current`，校验 active 权益与能力

## Key 可见窗口

完整 `cgu_live_*` 只存在于 Gateway 进程内存的 job 记录里，**15 分钟**后自动抹除，且只回传给发起该
job 的那个 token 前缀。它不写日志、不落盘、不进审计参数。

超时或容器重启后拿不到完整 key 时，**没有找回途径，只能轮换重发**。`cgu_live_*` 在
`unified_client_keys` 里只存哈希（`hashUnifiedClientKey`），不是密文，因此 admin CLI 的
`reveal-key` 对它无效——`reveal-key` 能还原的是后端 Gateway 运行态 key（`cgw.*`），那把是用
`GATEWAY_API_KEY_ENCRYPTION_SECRET` 加密存储的，不是交付给用户的那把。

轮换用 `POST /gateway/admin/billing/v1/subjects/<subjectId>/keys`，它同样只在响应里返回一次新
key，旧 key 按请求参数吊销。所以运维上的硬要求是：**发放当场必须复制走**。

## 失败处理

任一步失败时 job 记为 failed 并显示失败步骤与原因。若该次运行**确实新建了** subject，会自动
best-effort 调用 disable，避免留下"有主体、无可用权益"的半成品用户。幂等重放（同一手机号已发过）
不会被 disable，因为主体不是这次创建的。

失败信息在存储前会过滤 `cgu_live_*`、`cgw.*`、`mev2_live_*`、`bat_*` 形状的子串。

## 审计

每次发放写两条 `real-user-issue` 审计事件（`phase=started` / `phase=finished`），参数含 `job_id`、
`external_user_id`、`plan_id`、`actor_token_prefix`、`authority_mode`，不含任何 key 值。追责时用
`actor_token_prefix` 关联到 `billing-token list` 里的 label。

## 与本机脚本的关系

| 场景 | 用什么 |
|---|---|
| 新用户，已用 R760 端点 | 本页面 |
| 新用户，仍需旧 `gw.instmarket.com.au` 兼容 | `python scripts\issue-real-user-cgu-key.py --name ... --phone ...`（默认带 Azure 镜像） |
| 明确不同步 Azure | 页面，或脚本 `--r760-only` |
| Desktop E2E 诊断 key | `scripts\issue-desktop-e2e-opaque-key.ps1` |

两条路径共用同一段开通逻辑（`provisionBillingSubject`），不会因为走网页而产生不同形态的主体或 key。

## 相关

- `docs/operations/medevidence-codex-key-provisioning.md`：real-user cgu_live key 的权威流程
- `docs/operations/r760-control-plane-authority.md`：权威写入、兼容镜像与用量归并规则
