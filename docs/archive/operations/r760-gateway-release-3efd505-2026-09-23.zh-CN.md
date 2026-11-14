# R760 Gateway 发布回执：3efd505

**2026-09-23 00:40:59 UTC**（北京时间 08:40:59，悉尼时间 10:40:59）开始割接，00:41:11 UTC 完成。本次只重建 Gateway 容器，Research Worker、Research LLM Gateway 和 Research maintenance 都没有重建。部署由用户批准，所有操作由会话在主机上执行。

## 版本

| 项目 | 状态 |
| --- | --- |
| `current` | `3efd50541278735836eeeb608244f628a31b913c`（发布时的 `origin/main`） |
| `previous` | `95e724cc06c07f139d94cd46b0f1f0c3c1a6a3b2` |
| 镜像 | `codex_gateway_r760-gateway:3efd505…`，`sha256:52b377076453ce9856b5fa6ae211483dfa92a1f91d2bb2fd6b4c3dae1c916948` |
| 数据库 | schema 35 不变，本次没有迁移 |

## 上线内容

- `cbcc212`：resolve 时对 Gateway 管理的 MedEvidence 入口调用 `/validate-key`。
  - 明确拒绝（401/403 或 `valid=false`）返回 `409 account_migration_required`，不下发任何凭证。
  - 无法得到判定（超时、5xx 等）时照常放行，只记录告警。
- `5142b29`：零售付费周期校验，付费期覆盖当前 Desktop Key，到期 90 天内的 Key 随付款恢复，管理页增加账号不一致提示。
- `a8f009b`：启动归档脚本的修复，不影响运行时。
- 启动归档开关：override 在 2026-09-22 已改为 `0`，本次重建后生效，启动日志里不再出现 `Codex rollout startup archive failed`。
- `7289d4d`：学术问题特性的代码已随镜像带入，但它在 Research Worker 里运行，**Worker 没有重新部署，所以这项还没有生效**。

## 已知并已接受的对外影响

- **年付周期校验。** 计费系统到 2026-09-15 为止，发送的年付仍是 `period_kind=monthly`。本版本会以 `400 invalid_period` 拒绝这类购买和续费（取消、暂停不受影响）。用户知情后决定照常部署，已起草消息请 MedEvidence 团队改为 `one_off` 加 365/366 天，并确认 400 之后怎么处理。
- **resolve 校验。** 部署前 00:26–00:28 UTC 做了全量只读探测，共 483 把 Key、326 个 Subject。
  - 9 月 9 日清单上的 112 把，已有 109 把在 R760 验证通过。
  - 在 R760 仍被拒的共 7 把，其中只有 1 把近期在用（`uck_gImVIpRlZ3dxWuz9`，最近一次使用是 09-20）。这个用户在 v2 恢复之前 resolve 会返回 409。
  - 7 把的清单已写进给 v2 团队的消息。

## 过程

1. **源码。** R760 当时连不上 GitHub（`git fetch`、`ls-remote`、`curl` 都超时）。改为在本地把 `95e724c..3efd505` 打成 git bundle（143,670 字节，sha256 `db0eb12cb7af2cfe…`），在主机镜像仓库校验通过后 fetch；主机上的 `FETCH_HEAD` 等于 `3efd505`，也就是本地和 GitHub 上的 `origin/main`。用完已删除主机上的临时 bundle。
2. **准备。** 用 `git archive` 生成 `staging/3efd505…/src` 和不可变的 `releases/3efd505…`，并按当前 release 复刻 5 个运行时 env 软链：`config/gateway.container.env` 和 `config/research.production.{api,compose,llm-gateway,worker}.env`。脚本核对过，当前 release 里除这 5 个软链外没有其他未跟踪的文件。
3. **备份。** 触发一次 `codex-gateway-db-backup.service`，结果是 `/data/backups/codex-gateway-daily/20260923T003601Z`，2.03 GB，三个库都校验通过。割接前的状态记录在 `backups/release-3efd50541278/deployment.json`，旧 override 保存为 `previous.override.yml`。
4. **构建。** 使用 `deploy/r760-vision-observation.Dockerfile`（通用的 packages overlay），基础镜像是 `95e724c`。verify 阶段在容器里跑全量测试：Test Files 87 passed / 2 skipped（89）。
5. **割接。** 用文本替换的方式改 override 里的 gateway 镜像行，保留注释；override 哈希从 `ec669a05…` 变为 `bd88326c…`。等待未结算预留清零后，用新 release 的 Compose 文件，只执行 `up --no-deps --force-recreate --wait gateway`。

## 验证

割接脚本内置检查，全部通过：
- 容器运行的是候选镜像，healthy，RestartCount 0，端口绑定不变。
- 环境变量只有 `CODEX_GATEWAY_ROLLOUT_ARCHIVE_ON_START` 从 1 变为 0。
- 3 个 Research 容器的 ID 不变。
- 公网 `/gateway/health` 返回 ready。
- schema 35，`quick_check=ok`，外键违规 0。
- 没有出现启动归档告警。
- `current` 和 `previous` 已更新。

公网业务冒烟（`scripts/ops/billing-quota-review-public-smoke.mjs`，一个合成账户，00:41:29 UTC）：
- 20 项检查全部通过，`assertions: passed`。
- 覆盖开户、resolve 200（新校验的正常路径）、月付购买与续费、暂停与取消、年付（`one_off`、一年）、额度重置冲突与完成、管理页，以及一次真实模型调用：`req-a50a7968-9429-4db9-898d-22b866401f00`，397 token 全部计入一次性 Free。
- 年付购买把合成账户的 Key 延到付费期结束（2027-09-23），审计里记录了 `credential_expiry_extensions`；月付那次因为 Key 本来就更晚到期，没有缩短，行为正确。
- 清理完成：账户已停用，有效凭证 0，未结算预留 0，停用后 resolve 返回 401。

割接后的只读观察（00:41–00:43:55 UTC，低峰时段）：
- 37 个请求全部成功。
- 8 个模型请求都有视觉观测。
- resolve 审计 2 次，都是冒烟发起的，全部 ok；这段时间真实用户还没有 resolve。
- 校验明确拒绝 0 次，无法验证 0 次，错误级日志 0，启动归档告警 0。
- 这段时间的计费事件全部来自冒烟，全部 applied。

## Research Worker 发布（00:51 UTC）

用户随后要求部署 Worker，好让学术问题改动（`7289d4d`）生效。只重建了 research-worker，Gateway、Research LLM Gateway 和 maintenance 都没有重建。

- **Worker 专用 overlay 不能用。** `deploy/r760-research-worker-overlay.Dockerfile` 以当前 Worker 镜像（`2c561f5`）为基础，只替换 research-worker、research-agent、store-sqlite 三个包的 dist。构建本身通过了（研究相关测试 19 个文件、405 个用例），但部署前在断网的临时容器里导入模块时报错：新版 store-sqlite 需要 `@codex-gateway/core` 导出 `identityAuditOperations`，而镜像里的 core 还是旧版。**如果当时部署了，Worker 一启动就会崩。** 这个镜像没有投入使用，已经删除。
- **改用 `3efd505` 的 Gateway 镜像运行 Worker。** 这沿用了 2126e7c 协调发布时"同一镜像跑 Gateway 和 Worker"的做法。这个镜像里所有包都是同一版本，已通过全量测试（87 个文件）；在断网环境下导入 Worker 模块图正常，健康检查脚本齐全，入口、命令和运行用户都和原 Worker 镜像一致，并且包含学术问题检查和修正后的正则。
- **发布目录补建了 secrets 软链。** Compose env 里 Worker 的密钥路径是相对路径 `./secrets/...`，而 `3efd505` 发布目录没有这个目录（上一个 `95e724c` 也没有；原 Worker 一直是用 `675e9fe` 的发布目录创建的）。已为 3 个 research 密钥建立指向 `shared/secrets` 的软链，并确认原 Worker 的挂载也来自这些文件。**以后准备发布目录时，也要把 `secrets/` 软链一起补上。**
- **备份与预览。** `research.db` 在线备份到 `backups/research-worker-3efd50541278/`，并已校验。第一次割接命令里同时删除镜像，被自动模式的权限分类器以 `[Blind Apply]` 拒绝。之后先只读预览：override 只改 research-worker 的 image 和 `RESEARCH_WORKER_VERSION` 两行，每行都只出现一次；没有未完成的研究任务。然后才单独执行割接。

割接结果（`scripts/ops/r760-research-worker-release-20260923.py`）：
- Worker 运行在 `codex_gateway_r760-gateway:3efd505…` 上，healthy，重启 0。
- 环境变量只有 `RESEARCH_WORKER_VERSION` 变化，新值是 `research-academic-3efd50541278`。
- 挂载解析到的仍是原来那批文件，其他容器都没有重建。
- 公网健康状态是 ready；`research.db` 的 `quick_check=ok`，外键违规 0。
- 启动日志里有 `research_worker_ready`，版本正确；心跳表已按新版本号更新；启动时的 Brave 搜索请求返回 200。
- 没有运行真实的医生研究任务。那会产生外部检索和模型费用，所以学术问题的效果要等真实任务来验证。

回退方法：把 override 里 research-worker 的两行改回 `codex-gateway-research-resilience:2c561f5…` 和 `research-resilience-2c561f5a1fe3`，然后用 `675e9fe` 发布目录只重建 research-worker。原 override 保存在 `backups/research-worker-3efd50541278/previous.override.yml`。

## 回退

本次没有数据库迁移。回退时，把 override 的 gateway 镜像行改回 `codex_gateway_r760-gateway:95e724c…`，用 `previous` release 的 Compose 文件只重建 gateway，再把 `current` 指回 `previous`。旧 override 保存在 `backups/release-3efd50541278/previous.override.yml`。回退会让启动归档开关恢复为 1，但只是告警重新出现，不影响功能。

## 后续

- 等 v2 团队恢复剩余 7 把 Key，确认 `/validate-key` 的失败状态码，并确认计费通知的周期格式。
- 学术问题特性已随 Worker 上线，等真实研究任务再观察效果。
- 本次构建之后根盘占用为 57%。
