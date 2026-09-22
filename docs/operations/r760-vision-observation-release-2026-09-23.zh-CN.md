# R760 视觉结构观测发布回执（schema 35）

2026-09-22 **22:55:35 UTC / 北京时间 09-23 06:55:35 / 悉尼时间 09-23 08:55:35** 完成 Gateway 割接。本次只重建 Gateway 容器；Research Worker、Research LLM Gateway、Research maintenance 未重建。

## 生效版本与行为

| 项目 | 状态 |
| --- | --- |
| Gateway `current` | `95e724cc06c07f139d94cd46b0f1f0c3c1a6a3b2`（`d09b4ef` 功能 + `95e724c` 发布 overlay），已推送 `origin/main` |
| Gateway `previous` | `da97de6567e1e988b7cb12594166f195af0139e7` |
| 数据库 | `schema_migrations` 最新 35，`2026-09-22T22:55:30.516Z` 应用；34 为 2026-09-18 |
| 构建 | `deploy/r760-vision-observation.Dockerfile`，基底为割接前运行镜像；因 schema 35 修改 `packages/store-sqlite`，不能使用仅 `apps/gateway` 的 overlay |

Gateway 在解析期记录每个 wire 图片条目的结构位置，写入 `request_events.vision_observation_json`：是否位于最后一条 protocol user 消息内、`detail` 分布、重复条目数，以及 `completeness`（`complete` / `partial` / `unavailable`）。**路由、413 image_count 合同和发往上游的请求体均未改变。**

用途是让 Desktop 的“历史图片重放”修复可以被 Gateway 独立验证；客户端自报的重放计数不能作为验收依据。`inside` 是 wire 位置，不等于“用户本轮新上传”：OpenAI 兼容客户端会把工具结果图片提升到末尾的合成 user 消息。背景与判读口径见 Grok 视觉历史图片重放与成本调查（`docs/operations/grok-vision-history-replay-cost-investigation-2026-09-22.zh-CN.md`，本回执提交时尚未入库）。

## 前序未记录的发布：da97de6

`da97de6`（CT 资源等待进度投影，`fix(imaging): expose bounded resource waiting progress`）已于 **2026-09-22 08:40:14 UTC** 部署到 R760 Gateway，此前没有写入仓库文档。主机回执 `/opt/codex-gateway-r760/backups/ct-progress-20260922T083948Z/receipt.json` 记录：health=healthy、重启 0、其他容器未变、环境保留、imaging allowlist 3 个、四个数据库 `quick_check=ok` 且外键违规 0。

CT 资源等待交接（`docs/outbox/medevidence-ct-resource-wait-progress-2026-09-22.zh-CN.md`，尚未入库）开头仍写“尚未提交、部署”，其中 **Gateway 部分已过时**。本回执未核验 star RADAR（`1d0ac94`）或 Desktop 候选包的实际发布状态。

## 验证

以下为割接后的只读核验（2026-09-22 23:03–23:10 UTC）：

- 容器 `codex_gateway_r760-gateway-1`：healthy，RestartCount 0，启动于 22:55:28 UTC；镜像与 revision 标签均为 `95e724c…`。
- `current` / `previous` 软链与上表一致。
- 公网 `https://goldencode.instmarket.com.au:1443/gateway/health`：HTTP 200，`state=ready`。
- 构建日志（`staging/95e724c…/build.log`）verify 阶段：Test Files **83 passed / 2 skipped（85）**。被跳过的包括固定于 33→34 割接的迁移演练测试。
- 割接前备份（schema 34 的 gateway.db、client-events.db、imaging-control.db）：`quick_check=ok`，外键违规 0，记录于 `deployment.json`。

### 生产观测覆盖

从新容器启动（22:55:28 UTC）到 23:03:20 UTC，共有 26 条请求事件：

| 类别 | 数量 | `vision_observation_json` |
| --- | ---: | --- |
| 模型聊天请求（xAI `grok-4.5`、腾讯 `glm-5.3`） | 11 | 全部为 `complete` |
| 非模型事件（`public_model_id` 与 `upstream_runtime` 均为空） | 15 | NULL，符合“未进入扫描”的设计 |

另有 22:55:13/15 两条 xAI 请求由旧容器处理，无观测，符合预期。

割接后第一条真实视觉请求（22:55:32 UTC）即命中调查所述现象：`wireImageCount 1`，`imagesInLastUserMessage 0`，`imagesOutsideLastUserMessage 1`，`detailCounts.high 1`。也就是历史位置的媒体被再次发送，并使用 high detail，由 Gateway 独立测得。其余视觉请求均为 `inside=1 / outside=0`。

### 尚未在生产观测到的分支

`completeness: partial`、`unavailable`，以及“413 image_count 被拒时仍携带完整快照”，目前只有单测覆盖（`apps/gateway/src/services/vision-observation.test.ts`）。413 分支在调用上游之前拒绝，零 provider 成本；主动冒烟需要临时凭据，并须按运维规则在用后清理。**未经批准不执行。**

## 发布过程中的问题

1. **首次割接失败：release 目录缺运行时 env 文件。** release 树由 `git archive` 生成，不含 5 个不在 git 中的运行时 env 文件：`gateway.container.env`，以及 `research.production.{api,compose,llm-gateway,worker}.env`。22:50 UTC 首次割接因找不到 `research.production.worker.env` 失败，失败日志保存在备份目录 `cutover-failure.log`。发布会话随后在新 release 的 `config/` 下补建了这 5 个软链，指向 `shared/config/` 中的同名文件（已核验），于 22:55 成功割接。
   **后续发布必须把这一步加入暂存流程**：按当前 release 的 `readlink` 结果复刻 5 个软链，或沿用 imaging 发布的 manifest + delta 继承方式。
2. **每次启动都出现 `Codex rollout startup archive failed`**。详见下一节。旧容器同样存在，不是本次发布引入。

## Codex rollout 启动归档告警：原因

启动日志中的实际错误为：

```text
error=ENOENT: no such file or directory, lstat '/var/lib/codex-gateway/codex-home/sessions'
warning=Codex rollout startup archive failed; gateway startup will continue without moving files.
```

只读核验结果：

- `CODEX_GATEWAY_ROLLOUT_ARCHIVE_ON_START=1` 来自已提交的基础 `compose.azure.yml`（第 17 行）。R760 叠加 `compose.research-production.yml` 与 `shared/config/compose.r760.override.yml`，但 override 没有覆盖该开关。
- R760 的 `codex-home` 自 2026-08-04 创建以来一直是空目录：没有 `auth.json`，也从未有过 `sessions/`，因此 R760 从未运行过 openai-codex 会话。隔离目录 `codex-rollout-quarantine` 也不存在。模型流量由腾讯 `glm-5.3`、xAI 等 provider 承接。
- `sessions` 表 2 行，其中 1 行带 `provider_session_ref`：`sess_bddb1235-4341-4298-ba70-af9b0e045b05`，Subject `subj_dev`，账号 `sub_openai_codex_dev`，创建和最后更新时间均为 2026-04-22。它来自 Azure 时期的库，所对应的 rollout 文件从未存在于 R760。
- `request_events.provider='openai-codex'` 的大量记录都没有 `public_model_id` 和 `upstream_runtime`，属于非模型事件上的默认标签，不代表调用了 Codex 运行时。

结论：这不是数据丢失信号，而是 R760 开启了一个与其运行时不匹配的归档功能。[0bfb985 对齐记录](./r760-main-alignment-0bfb985-2026-09-12.zh-CN.md)把它列为“已知、非本次引入”后放过，这个处理不对：按[监控方案](../implementation/gateway-monitoring-alerting-implementation-plan-2026-07-14.zh-CN.md)它属于 Critical，应该定位并消除，而不是长期容忍。

工作区中未提交的 `scripts/archive-unreferenced-codex-rollouts.mjs` 修复会把“从未创建 sessions 目录”视为无可归档，同时保留“被引用文件缺失则 fail closed”的守卫。因此在 R760 上它**只会把报错变成** `Refusing to archive account 'sub_openai_codex_dev': 1 referenced provider session file(s) were not found.`，**不能消除告警**。消除告警需要单独决策（见“待决事项”）。

### 处置：R760 关闭启动归档（已执行）

用户确认 openai-codex 运行时已停用（模型改由腾讯 `glm-5.3` 等承接）。

**2026-09-22 23:29:12 UTC** 起，`shared/config/compose.r760.override.yml` 的 gateway environment 新增 `CODEX_GATEWAY_ROLLOUT_ARCHIVE_ON_START: "0"`，并附一行注释指向本回执。该脚本由用户在终端执行，过程如下：
1. 持有部署锁。
2. 校验原哈希 `78948b5c…`。
3. 做 0600 备份。
4. 原子替换文件。
5. 用 `docker compose config` 校验合并结果：开关为 `"0"`，镜像与运行中一致。

新哈希为 `ec669a05eb07039fc0c62fa63b0e0ba5c87be5a387d405d0fe6eeb634617efab`。原文件和回执保存在 `backups/archive-flag-off-20260922T232911Z/`。

本次**没有重建容器**。运行中的 Gateway 仍是 `"1"`，下一次受控重建时生效；届时启动日志应不再出现这条告警。数据库和 `codex-home` 都未改动。之后若用割接前保存的 `previous.override.yml` 回退，会把开关带回 `"1"`，但只会让告警重新出现，不影响功能。

## 回退

schema 35 只新增一个可空列，`da97de6` 镜像可以读取迁移后的库。回退时将 override 中的 gateway 镜像行恢复为 `codex_gateway_r760-gateway:da97de6…`，只重建 gateway，并将 `current` 指回 `previous`。无需恢复数据库。备份位于 `/opt/codex-gateway-r760/backups/vision-observation-95e724cc06c0/`，`deployment.json` 记录原容器 ID、配置哈希和端口绑定。

## 主机磁盘

据发布会话记录，根盘曾写满 100%；该会话删除了 27 份 9-11 至 9-21 的过期发布前备份。本次核验时，`/opt/codex-gateway-r760/backups` 保留 5 个实体目录（每个 1.6–1.9 GiB）和 18 个指向 `/data` 的有效软链，无断链；根盘 98G 已用 64%（剩余 35G），`/data` 已用 16%（剩余 1.4T）。

尚未解决：

- 每次发布都会在根盘写入约 2 GiB 备份，但没有保留策略。
- 全机没有 Gateway 定时备份任务，只有 `dpkg-db-backup.timer`；数据库只在发布时顺带备份。

这两项都需要另行批准后处理。

## 待决事项

| 事项 | 建议 | 需要 |
| --- | --- | --- |
| 启动归档告警 | **已于 23:29 UTC 执行**，见上文“处置”；下次 Gateway 重建后核对启动日志 | 下次发布时验证 |
| 413 快照冒烟 | 用临时凭据发送超限图片数请求，核对 `complete` 快照后清理 | 生产临时账户批准 |
| 备份保留 / 定时备份 | 备份目录迁至 `/data` 并加保留 N 份的 prune timer；另设数据库定时备份 | 主机变更批准 |
| 发布暂存流程 | 在暂存步骤补建 5 个运行时 env 软链 | 发布脚本 / runbook 修改 |
