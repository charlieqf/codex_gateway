# 发放用户 Key 网页控制台

内部同事自助发放真实用户 `cgu_live_*` key 的网页入口，替代每次都由运维在本机手工跑
`scripts/issue-real-user-cgu-key.py`。

- 页面：`https://goldencode.instmarket.com.au:1443/gateway/admin/billing/v1/real-user-issue-ui`
- 权威：**R760 单权威（`authority_mode=r760_only`）**，不做 Azure 兼容镜像
- 鉴权：每人一个 Billing Admin token（`bat_test_*` / `bat_live_*`）

## 为什么是 R760-only

R760 是唯一 Gateway 权威。页面和 `scripts/issue-real-user-cgu-key.py` 都只写入并校验 R760；脚本的
`--r760-only` 仅为旧命令兼容保留，是 no-op。

含义：**发出的 key 只支持 `https://goldencode.instmarket.com.au:1443`**。仍指向旧端点的客户端必须
先协调升级，不提供兼容签发或回退路径。

## 前置条件

| 条件 | 说明 |
|---|---|
| `GATEWAY_PUBLIC_BASE_URL` | 必须配置为公网 origin。缺失时发放接口返回 503，因为端到端校验无处可发 |
| `GATEWAY_API_KEY_ENCRYPTION_SECRET` | 必须稳定，否则加密 key 无法恢复 |
| SQLite migration 33（含 32） | 开户任务加密持久化、失败任务历史与受控释放；不能退回内存模式签发 |
| `GATEWAY_UNIFIED_KEY_RECOVERY_KEY` / phone auth transition | 必须与现有手机号认证配置一致；创建时原子登记手机号身份 |
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
2. 填姓名、手机号（11 位大陆手机号，可带 `+86`；不接受连字符或内部空格）。统一存储为 `+86` 格式；默认 `external_user_id` 使用不带区号的 `phone_<11位数字>`，同号重复发放会被拒。
3. 两个下拉：
   - **有效期**：默认 92 天，最少 90 天
   - **限额档位**：标准 20/分·200/日·4 并发；加强 30/600/8；或自定义（RPM 不得低于 20）
4. 点「发放 Key」→ 立即返回 job，页面轮询进度。

**Plan 是固定的**，不给选：`plan_internal_high_quota_image_v1`，即真实用户的既定默认（含
`chat`/`tools`/`image_generation`）。页面仍会调 `GET /plans` 把它的能力和 token 配额显示出来，
让发放人看得见自己在发什么，但不提供切换。**Scope 也不再出现在界面上**，由服务端取该 Plan 的
`scope_allowlist[0]`（即 `code`）。

接口层允许指定包含 chat 能力的 `plan_id`；scope 必须为 `code`，provider 固定为 `manual_trial`。
其他套餐可走 API 或本机脚本。要更换页面固定的套餐，改 `defaultRealUserPlanId`。

## 为什么是后台任务

一次完整发放含端到端校验通常要几十秒。同步返回会撞 Nginx/代理超时，关标签页也会丢结果。所以：

- `POST /gateway/admin/billing/v1/real-user-issue` → `202` + `job_id`
- `GET  /gateway/admin/billing/v1/real-user-issue/:jobId` → 轮询状态
- `GET  /gateway/admin/billing/v1/real-user-issues` → 本 token 最近的发放
- `POST /gateway/admin/billing/v1/real-user-issue/:jobId/resume` → 使用持久化原请求恢复，不接受修改套餐、日期等参数
- `POST /gateway/admin/billing/v1/real-user-issue/:jobId/retry-disable` → 仅继续已开始的禁用补偿

六个步骤，逐个在页面上亮起：

1. `create_subject` 创建计费主体与 key（含隐藏的 MedEvidence v2 key）
2. `grant_entitlement` 授予 Plan 权益，必须变为 active
3. `resolve_key` 走公网 `/gateway/unified-keys/resolve`，校验 subject 一致、`cgw.` 运行态 key、
   MedEvidence 运行态 key、endpoint 与校验地址指向本 origin
4. `normalize_metadata` 写入姓名/手机，规范 label、限额与到期
5. `validate_credential` 走公网 `/gateway/credentials/current`，校验 active 权益与能力
6. `prepare_phone_login` 校验并准备手机号登录身份

## Key 可见窗口

完整 `cgu_live_*` 的任务显示副本只存在于内存，**15 分钟**后自动抹除，且只回传给发起任务的同一个
token。Env 模式的 active/next token 也分别计算 owner，不再共用 `env` 标签。任务快照不包含完整 Key，
不写日志或审计参数；手机号等原请求字段经加密后持久化（检索用的 external ID 仍可能包含手机号）。

配置统一 Key 恢复密钥后，`unified_client_keys.token_ciphertext` 保存原 Key 的密文，供现有手机号登录恢复，
以及未完成任务的内部恢复使用。内部恢复须验证原事件、Subject、手机号、current Key、撤销/到期状态和上游 binding；
不能拿别人的账号或轮换后的 Key 继续任务。公开 `POST /subjects` 的幂等重放仍不返回完整 Key。

成功任务不允许重新执行来延长显示窗口。窗口到期或成功后重启，请走已有手机号登录/受控恢复路径；必要时另行审批轮换。

轮换用 `POST /gateway/admin/billing/v1/subjects/<subjectId>/keys`，它同样只在响应里返回一次新
key，旧 key 按请求参数吊销。所以运维上的硬要求是：**发放当场必须复制走**。

## 失败处理

任务原请求、有效期、进度、Subject ID 和补偿方向持久化。开户与权益业务事件以原 `job_id` 为稳定标识；恢复
不会新建任务、重新计算有效期或重复赠送权益。每个任务有 120 秒写入租约，步骤推进时续期；租约未到期返回 409，
过期执行者不得继续写入或发起补偿。重启后由操作员从「恢复原任务」入口处理，不自动扫描重跑。

| 状态 | 操作 |
|---|---|
| `retryable` | 查看原因，确认后恢复原任务。网络暂不可达不自动销毁已创建账号 |
| `requires_review=true`（附加标志） | 需人工核查，不能直接重试；核查完成后在页面明确确认，再恢复原方向 |
| `compensating` / `compensation_failed` | 只能继续禁用，不允许返回开户/赠送方向 |
| `failed` | 原任务终态。前置归属冲突未创建账号时，可核实并更正输入后新建任务；不会借此释放已有登记或修改已有账号 |
| `succeeded` | 终态；按显示窗口或手机号登录交付 |

业务步骤返回确定性失败且原账号完全未变更时，先持久化补偿方向，再原子关闭本地 Subject、凭据、权益和手机号会话；上游 binding 先记 `pending`。
只有收到原上游用户确实已禁用的确认后才记 `disabled`。上游失败保持可重试状态和错误，不再吞掉异常或伪造同步成功。
上游响应需明确返回 `disabled: true`，或省略该字段但给出 `user.state: disabled`；缺失/异常确认不算成功，矛盾的用户状态也会拒绝。
账号在中断期间被轮换、撤销或变更权益时，自动恢复/禁用会拒绝继续，须人工复核；不会覆盖后续购买的套餐。

恢复及补偿共同核对原创建事件、登记中的原上游 user/key ID、手机身份、原凭据和权益。
本地禁用事件的幂等重放也在写锁内检查，不能以“以前禁用过”为由跳过；上游调用前后再次核对。
`pending` 期间不得并行进行账号恢复或换绑：已经发出的远端禁用请求无法由本地事务撤回。
手机号身份在创建事务内完成登记；后续步骤只核验，不会重新启用被人工停用的登录，也不会切换 current key。
凭据期限和限额在创建时写入，恢复不会重新覆盖；发现续期、限额或其他权限变化时保留现值并转人工核查。

公网校验保留受支持的错误码和 HTTP 状态，不保存上游任意错误正文。网络故障、5xx、408/425/429 可重试；
其他非成功 HTTP 响应（包括 401/403/409/426）转人工核查，不自动禁用账号。
`requires_review` 保存在现有加密任务快照中，仍使用原 SQL 状态和唯一索引，**无需 migration 34**。
核查后用原 `/resume` 或 `/retry-disable` 接口提交 `{"acknowledge_review":true}`；页面有单独确认，CLI 不会代为确认。
确认会写 `reviewed_resume` / `reviewed_retry-disable` 审计，但不会绕过任何状态检查或授权覆盖后续变更。
若账号已由其他受控操作恢复并在使用，不应为让旧任务成功而把账号改回原状态；保留核查标志及历史，转独立账号运维流程。

人工开户在同一 SQLite 事务里先核对规范化手机号、手机登录身份与外部身份归属，再预占登记。
号码已归属其他 Subject 时终止任务并显示归属，不调用上游，不走身份后端的“关联已有账号”路径。
`subject_already_exists`、`identity_conflict`、`account_disabled`、`account_migration_required` 等确定性失败，
只有确认没有待处理的本任务上游创建时才进入 `failed`；上游已调用但本地冲突仍保留原任务用于对账。
身份后端公开 resolve 的旧账号关联和无手机号的旧 create 合约不变。

任务每次步骤写入续租；公网校验最长 45 秒，创建/补偿上游调用额外受 60 秒 deadline 限制，低于 120 秒租约。
网络超时不等于上游未执行：保留创建尝试登记和原幂等键。进程暂停超过租约仍会失去执行权，不能盲目续跑。

失败信息在存储前会过滤 `cgu_live_*`、`cgw.*`、`mev2_live_*`、`bat_*` 形状的子串。

## 审计

每次发放写 `real-user-issue` 审计事件（`phase=started` / `finished`，受控恢复另有 `resumed` / `retry_disable`），参数含 `job_id`、
`external_user_id`、`plan_id`、`actor_token_prefix`、`authority_mode`，不含任何 key 值。追责时用
`actor_token_prefix` 关联到 `billing-token list` 里的 label。

## 与本机脚本的关系

| 场景 | 用什么 |
|---|---|
| 新用户 | 本页面，或 `python scripts\issue-real-user-cgu-key.py --name ... --phone ... --client-version ...` |
| 仍指向旧端点的客户端 | 先升级到 R760 端点；不签发兼容 key |
| Desktop E2E 诊断 key | `scripts\issue-desktop-e2e-opaque-key.ps1` |

脚本直接提交、轮询同一个持久化任务接口，不再自行调用旧开户/权益接口或通过 SSH 改用户、改 Key。
脚本中断后保留输出的 `job_id`，用 `--resume-job rui_...` 恢复；拿不到首次 HTTP 响应时先查最近任务，不能猜测新建。
`--no-disable-on-failure` 已拒绝使用。脚本只把交付用统一 Key 写入本机受限 handoff 文件，不保存后端运行态 Key。

## 旧半成品登记对账

- `GET /gateway/admin/billing/v1/subject-registrations/:provider/:externalUserId`：查询登记状态、原幂等键、上游 user/key ID、错误与补偿状态。只显示手机号后四位，不返回 Key。
- 确认仍应开户且关联未变化：使用**原** `/subjects` 请求正文和原 `Idempotency-Key` 重试；不能重置 `creating` 后换请求。
- 确认是孤儿：`POST` 上述路径加 `/retry-disable`，正文必须确认 `idempotency_key`、`upstream_user_id`、`upstream_key_id`。
  接口只接受 `creating` 且不存在本地 Subject/binding 引用的原目标；先持久化禁用方向，再调用上游，事务内写对账审计。
  已在途的创建不能越过此状态完成本地绑定。
- 没有上游 ID、原请求缺失或存在关联歧义的历史登记需人工核对，不能自动补猜或释放手机号；禁用成功也保留登记。

## 受控释放废弃登记（migration 33）

只允许以下两类，且均不得存在本地 Subject、成功任务或上游 binding 引用：

- 新流程产生的 `ready`，没有上游 ID，且创建尝试账本证明尚未开始任何上游调用。
- `creating` 且 `compensation_state=disabled`，原上游 user/key ID 齐全、禁用已确认。

所有新上游 create（包括旧无手机号入口）在调用前持久化尝试记录。缺少 ID、租约过期、超时都不是“未调用”的证据；
迁移前的 `ready` 不自动获得可释放标记，未知 `creating` 必须先对账。此命令不替代历史上游核查。

通过现有 R760 受控包装器执行，先预览，人工确认后带回同一个 revision：

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- release-registration manual_trial <external-id> <operator-id> "废弃原因"
python scripts/manage-r760-gateway-control.py -- release-registration manual_trial <external-id> <operator-id> "废弃原因" <preview-revision>
```

预览以只读方式打开数据库，不执行 migration。执行流程再次预览、检查版本摘要、做已校验备份，之后才进入写事务；
事务内复核 revision 并原子终止旧任务执行权、解除手机号预占、写 `registration-release` 审计，最后运行完整性检查。
状态变更会使原 revision 失效，需重新预览。底层 CLI 默认 dry-run，生产不得绕过包装器直接 `--apply`。

释放保留原登记和任务历史，不删除账户、不恢复权益。**原 provider + external ID 永久退役**，防止幂等重放复活旧上游账号；
手机号可供身份后端的真实身份重新登记。旧请求、旧任务及无手机号 create 均不得复用已退役身份。
不能把“换 external ID”当作绕过归属冲突的通用方法。

## 补偿巡检与告警信号

- 补偿失败立即输出结构化错误事件 `issuance_compensation_pending` 或 `orphan_compensation_pending`，含原任务/目标与 `retry-disable` 指引，不含 Key。
- `scripts/export-user-accounts.py` 的 F05/F05b 不再被“已停用”状态覆盖；故障页、计数与控制台均保留这些风险。
- “待补偿”表包括 pending binding、pending 孤儿登记和补偿中/失败任务；是记录数而非去重账号数。已释放历史不再计为预占。
- 此次提供日志事件和巡检出口，未接入外部通知平台或自动重试。值班监控需订阅上述错误事件；不能把本地已锁定理解为上游 Key 已失效。

## 发布拆分提醒

本次 migration 33、开户前置校验/恢复状态、释放 CLI/包装器与相关测试必须配套发布。
启用释放前必须确认所有旧 Gateway/CLI 写入者已停止，不能新旧实现混跑。migration 33 改变任务唯一索引与登记释放语义，
不能只回退应用到旧版本；数据库与程序需按受控回滚方案保持一致，迁移后已有业务写入时先对账，不能直接覆盖为旧备份。
工作区另有 resolve 运行态 Key 校验、零售套餐周期/到期延长、`reset-free-total` 等变更，发布时按 hunk 分离审查与提交，
不要整文件打包混入，也不要为拆分回滚其他人的修改。本次仅本地修改与测试，未执行生产部署。

上线前按现有流程备份数据库并保管两个稳定的加密密钥；新 migration 不会为历史记录虚构任务或原请求。
本文描述仓库实现，不代表已部署到生产。

## 相关

- `docs/operations/medevidence-codex-key-provisioning.md`：real-user cgu_live key 的权威流程
- `docs/operations/r760-control-plane-authority.md`：R760 单一权威与运维边界
