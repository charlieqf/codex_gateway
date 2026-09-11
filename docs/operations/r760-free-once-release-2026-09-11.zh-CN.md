# R760 免费额度一次性化发布验收（schema 30）

2026-09-11 10:37:17 UTC（北京时间 18:37:17、悉尼时间 20:37:17）上线。
10:38:08 UTC 完成 Gateway 审计，10:41:17 UTC 完成付费模板调整，10:43:29 UTC 完成 Billing 公网自测。

## 发布范围

- 部署提交：`45465ee13ebf7b629e24821385b5bc064b6423f2`（远端 `main` 头，已推送）。
- previous：`99f5a1d1743f25d2670601dd585850bb3d5790fd`（Research 实用资料发布目录）；
  切换前 Gateway 容器实际运行 `3985d84` 的实用告警兼容运行时。
- 镜像：`sha256:eac5685cf79e2151f0fc5bccc1b4d4bba06d0b07d666e5137127f22d22a61c59`
  （`codex_gateway_r760-gateway:45465ee…`），以运行中的 Gateway 镜像
  `sha256:1302800315…` 为基础，在 R760 上用 `deploy/r760-phone-signup.Dockerfile` 从固定提交构建。
- 源码归档 SHA-256：`df34b704e48563d540d918f376a663f6b4c821350e15a9e80ad6716c7a1d87fb`。
- schema 29 → 30；只重建 Gateway，Research Worker、Research LLM Gateway、maintenance、Mihomo、Qwen 容器未动。

业务规则见[免费额度一次性化合同 v2](../outbox/medevidence-free-once-quota-contract-2026-09-11.zh-CN.md)：

- 新手机号开户在同一事务自动获得 `plan_free_once_1m_v1`：一次性 1,000,000 token，终身有效、不重置、不补发。
- 纯免费请求放不进剩余额度时返回 `429 free_quota_exhausted`，无 `retry_after`；付费请求仍先借免费剩余。
- 购买月付／年付不再补发基础 Free。
- 存量 25 条每日 Free 权益（18 条每日 1 万、7 条每日 100 万）随 schema 30 转为一次性 1,000,000，
  历史月窗口用量按单次结转进 `period` 终身窗口；已取消／过期的历史权益保留原快照。
- 旧快照缺少 `tokensTotal` 字段按不限量解码；Billing `GET /plans` 新增 `tokens_total`。

## 发布前验证

- 本地干净工作树对固定提交：类型检查通过，47 个测试文件 675 项通过；主工作区完整套件 1137 项通过。
- R760 构建镜像的 verify 阶段：`npm ci`、`npm run build`、2 个分账／管理页测试文件与 18 个 Gateway、
  身份、图片、SQLite 回归测试文件全部通过，编译后路由冒烟通过。
- 隔离迁移冒烟（无网络、只读挂载发布前 gateway.db 备份、tmpfs 临时副本）：schema 29 → 30，
  25 条 active 每日 Free 全部转为 `plan_free_once_1m_v1`，每条终身窗口 = 历史月窗口用量；
  957 个 Subject、467 个统一 Key 逐条一致；非免费权益的 plan 与策略字节不变；quick_check=ok、外键违规 0。
- 候选镜像内编译后路由冒烟（内存库、回环 provider）通过。

## 切换过程

`prepare` 10:31:09 UTC 完成三库在线备份并校验（gateway.db 301,465,600 字节、client-events.db 1,354,280,960 字节、
research.db 24,264,704 字节），复制并校验共享配置，创建 release 配置软链，`compose config --quiet` 通过。
`cutover` 10:37:04 UTC 确认无未结算预留后停止旧容器，只替换 override 中 gateway 服务的镜像行
（sha256 `0e43ceea…` → `34f9c238…`），切换 `previous`／`current`，重建 Gateway。
10:37:06 UTC 容器启动，启动时完成 schema 30 迁移（日志：`{"migration":30,"free_allowances_migrated":25}`），
10:37:17 UTC healthy、公网 health=ready，切换窗口约 13 秒。

本次为单向发布：schema 30 之后旧镜像会把迁移后的免费快照读成不限量，因此不提供旧镜像自动回滚；
异常时以前向修复为准。

## 公网业务自测

| 检查 | 结果与请求 ID |
| --- | --- |
| 直接带 phone 新开户（May 合同保留） | 200，自动获得 `plan_free_once_1m_v1`，`tokensTotal=1,000,000`；`req-8c6b2c04-bb68-4aa2-9a78-814bfef9fdf1`（bootstrap） |
| 手机号登录、bootstrap 取回同一 Key、解析统一 Key | 200；`req-fd4bd058-c604-4982-83a3-51fc6a14ed2d`、`req-980130ac-cc08-4c92-a38a-27956dd9a88c` |
| 模型凭据额度 | `tokensPerDay=null`、`tokensTotal=1,000,000`；`req-f1279f3b-072e-4536-b331-f7a14f7de14b` |
| 真实 goldencode 模型请求 | 200，有模型响应 |
| 可选两步开户 | 200，同样获得一次性 1,000,000 |
| 未注册手机号登录 | 403 `phone_not_registered`；`req-b13c5389-b93a-4d18-a501-293e7a36e769` |
| 月付购买后进行中请求暂停并重置 | 409 `quota_reset_conflict`；`req-9ed23f3c-333e-43f5-b024-ba3e179da357` |
| 该请求完成结算 | 385 token 全部计入一次性 Free，付费 0；`req-9af3b76f-2b9f-4c72-9a06-53452dbb7537` |
| 默认取消当前暂停月付、未来续费保留、只剩未来时 404、显式 ID 取消 | 通过 |
| 日窗口重置不触碰终身窗口 | 重置后免费累计仍为 385 |
| 年付购买及用量查询 | 日 6,000,000、周期 200,000,000，同一 Free 权益 |
| 管理页公网 HTML | 已包含免费累计余额 |

四个合成账户（`subj_9QeOQH7RS48JRkAzX4XWUJ-h`、`subj_oyXyW0y4Uw8Cx1wWprFziEJt`、`subj_bNTzZOEo73cz5yfKvGzN8zg8`、
`subj_zpwEGfxF6m-SLTxObdK9AXBw`）均已停用，Phone identity 停用，模型凭据全部吊销，未结算预留为零。
没有消耗真实用户额度，没有执行真实收款或 Desktop EXE 验收。

`scripts/ops/billing-quota-review-public-smoke.mjs` 随本次修正：合成账户改为带手机号开户以获得一次性 Free，
结算与年付断言改为终身窗口语义。

## 付费模板调整

Gateway 切换后按[额度调整记录](./medevidence-plan-quota-adjustment-2026-09-11.zh-CN.md)执行，
每次先 dry-run，再经完整在线备份、完整性校验、单事务修改并写审计：

| Plan | 修改 | 既有快照 | 备份 |
| --- | --- | --- | --- |
| `plan_paid_monthly_v1` | 月 50,000,000 → 150,000,000，日 5,000,000 不变 | 66 条不变 | `r760-control-pre-control-state-sync-20260911T104000Z-41e35393.db` |
| `plan_paid_yearly_v1` | 日 null → 6,000,000，每 UTC 自然月 null → 200,000,000 | 3 条不变 | `r760-control-pre-control-state-sync-20260911T104117Z-645a977a.db` |

Billing 目录公网确认：Free 模板 `tokens_total=1000000`，月付 5,000,000／150,000,000，年付 6,000,000／200,000,000。

## 运行审计

- current／previous、镜像 revision 标签、端口、环境指纹符合预期；除 gateway 镜像行外配置字节未变。
- Gateway healthy、重启 0，公网 health=ready；其余五个容器 ID 未变且健康。
- 三个数据库 quick_check=ok、外键违规 0。
- 与发布前备份逐条比较：957 个 Subject、966 个模型凭据、467 个统一 Key、15 个既有 Plan、
  253 个 Phone identity 变化数为零；620 条权益中恰好 25 条 active 每日 Free 只改了 plan_id 与策略快照，
  其余 0 条变化。
- Gateway 日志 error、fatal、未捕获异常、未处理 Promise 拒绝均为 0。

## 备份与清理

证据目录：`/opt/codex-gateway-r760/backups/free-once-45465ee13ebf`，含 deployment.json、build.log、
migration-smoke.json、compiled-smoke.log、public-smoke.json、billing-smoke.json、final-audit.json、
recreate.log、proposed.override.yml、源码归档、发布脚本 `free-once-release-r760.py` 及三个已验证数据库备份。
远端 staging 已删除；基础镜像标签 `codex_gateway_r760-gateway:free-once-base-45465ee13ebf` 指向切换前镜像。
根盘使用率 91%（剩余 8.6G），历史 Gateway 镜像清理另行安排。

发布脚本已入库为 `scripts/ops/free-once-release-r760.py`（prepare／migration-smoke／cutover／audit）。
