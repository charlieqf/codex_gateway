# R760 Gateway 备份运维

适用于 R760 主机。本文说明三件事：定时数据库备份、发布备份的存放位置，以及保留审查报告。代码都在仓库里，由 `scripts/ops/install-r760-backup-ops.py` 从已推送到 `origin/main` 的提交安装。

## 组成

| 组件 | 位置 | 行为 |
| --- | --- | --- |
| 每日数据库备份 | `codex-gateway-db-backup.timer`，每天 18:30 UTC | 备份 `gateway.db`、`client-events.db`、`imaging/control.db`，写到 `/data/backups/codex-gateway-daily/<UTC 时间戳>/` |
| 保留审查报告 | `codex-gateway-backup-report.timer`，每天 19:30 UTC | **只出报告，不删除任何东西**；写到 `/data/backups/codex-gateway-retention/` |
| 发布备份目录 | `/opt/codex-gateway-r760/backups` 是指向 `/data/codex-gateway-r760/backups` 的软链 | 发布和运维脚本仍写 `backups/<名称>`，但数据落在 `/data`，不占 98G 根盘 |

安装后的脚本在 `/opt/codex-gateway-r760/ops/`，所装的提交及每个文件的 sha256 记录在同目录的 `INSTALLED_REVISION`。

选 18:30 UTC 的原因：过去 14 天，UTC 17:00–20:59（北京时间 01:00–04:59）没有模型请求。备份期间读快照会让 WAL 暂时变大，也会占用磁盘 IO，放在低谷时段影响最小。

## 每日备份的保证

- 每个库用 SQLite online backup API，从只读连接（`mode=ro`，`query_only`）一次性复制，得到一致的快照，不阻塞 Gateway 写入。
- 副本转换为不依赖 `-wal` 的单文件，随后执行 `quick_check` 和 `foreign_key_check`，并记录 sha256、大小、schema 版本和耗时。
- 所有库都校验通过后，才把 `.partial-*` 暂存目录改名为正式目录；正式目录里的内容一定是校验过的。校验失败的暂存目录保留 48 小时供排查，之后由成功的运行清理。
- 保留策略：最近 7 个 UTC 日各留最新一份，最近 4 个 ISO 周各留最新一份，最新一份永远保留。只清理本脚本生成、且 manifest 标记为成功的目录，并且只在本次运行成功之后才清理。
- 当前容量：每份约 2.0 GB，最多约 11 份，合计约 22 GB；`/data` 可用约 1.4 TB。

失败时 unit 标记为 failed，`last-run.json` 记录 `status: failed` 和错误信息。目前还没有自动告警通道，请按下文定期检查。

## 检查

```bash
systemctl list-timers --all 'codex-gateway-*'
cat /data/backups/codex-gateway-daily/last-run.json
systemctl status codex-gateway-db-backup.service --no-pager
python3 -c "import json;r=json.load(open('/data/backups/codex-gateway-retention/latest.json'));print({k:{x:r[k].get(x) for x in ('entries','total_bytes','candidate_bytes')} for k in ('release','control')}, r['disk'])"
```

手动补跑一次备份：`systemctl start codex-gateway-db-backup.service`。它会等本次运行结束才返回，与定时运行共用锁，不会并发。

## 恢复

每日备份是独立的 SQLite 文件，可以直接以只读方式打开核对。用它**覆盖**线上库是另一项需要单独批准的操作：备份时间点之后的计费、预约和客户端消息都会丢失。执行前先确认这些数据怎么处理，并按发布流程受控停止和重建 Gateway，恢复文件的属主和权限要与原库一致。

## 保留审查报告（只读）

报告按以下规则列出“将来启用删除时会删掉什么”，但本身不删除任何文件。

- **发布备份**（`/data/codex-gateway-r760/backups`）
  - 保留最新 10 个。
  - 保留 14 天内的。
  - 保留名称或 `deployment.json` / `receipt.json` 指向当前或上一个 Gateway 版本的。
  - 保留被软链指向的目录，例如 2026-09-11 的冷归档 `opt-archive-20260911`。
  - 软链本身不计。
- **控制脚本快照**（`/data/backups/codex-gateway`）
  - 同一份快照与它的 `-wal` / `-shm` / `-journal` 算一组。
  - 保留最新 20 组和 30 天内的。
- **每日备份**：只报告大小和上一次运行的状态。

先看一周报告，确认列为可删的都确实可以删，再单独开发并批准删除模式。

2026-09-23 安装前的只读演练结果：
- 控制快照 151 组，约 48 GB，其中约 47 GB 在 30 天以内。每次控制操作前都会做一次整库快照，是增长最快的一类。
- `/data` 上的发布备份 78 项，约 78 GB。

## 发布备份迁出根盘（一次性）

`scripts/ops/r760-relocate-release-backups.py` 按以下步骤执行：
1. 持有部署锁，确认两边没有重名。
2. 把每个条目复制到 `/data` 上的暂存目录，保留权限和属主；逐文件比对 sha256、大小、类型和软链目标。
3. 在 `/data` 上用改名的方式发布。
4. 把 `/opt/codex-gateway-r760/backups` 换成软链。
5. 通过新路径再核验一遍，全部一致后才删除原件。
6. 在 `/data/codex-gateway-r760/backups` 下写入回执 `.relocation-backups-<时间>.json`。

交换之前失败，原目录保持不动；交换后核验失败，会自动换回原目录。重复运行时如果检测到已经迁移过，直接返回 `already-relocated`。

## 安装

先确认要安装的提交已推送到 `origin/main`。在 Windows 上执行：

```powershell
Get-Content -Raw C:\work\code\codex-gateway\scripts\ops\install-r760-backup-ops.py | ssh -p 7723 root@117.186.49.26 python3 - <revision> all
```

安装脚本按以下顺序执行，任何一步失败即停：

1. 在主机镜像仓库 fetch 该提交，确认它在 `origin/main` 上。
2. 解压脚本、测试和 unit，用主机的 Python 3.10 运行测试，要求 0 失败、0 跳过。
3. 安装文件，执行 `systemd-analyze verify`，启用两个定时器。
4. 立即运行一次备份。
5. 迁移发布备份。
6. 生成首份报告。

也可以只执行其中某些阶段，例如 `verify`、`install`、`backup`、`relocate`、`report`。
