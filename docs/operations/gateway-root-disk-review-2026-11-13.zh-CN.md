# R760 系统盘占用与释放方案

2026-11-13 10:12 北京时间只读盘点。未删除文件、调整保留策略、迁移数据或重启服务。

## 当前容量

- 根盘约 97.87 GiB，已用 80.27 GiB，可用 12.59 GiB，另有 ext4 预留约 5.02 GiB。
  按 `used / (used + available)` 为 86.4%，`df` 向上取整显示 **87%**。
- 此前 82% 是 `used / total` 的结果；巡检脚本已改用与 `df` 一致的分母，避免
  因预留块而漏掉 85% 的空间告警。
- `/data` 可用约 1,134.87 GiB。Docker 数据根目录为 `/data/docker`；Gateway 数据库、
  Docker 日志卷和 Gateway 发布备份也已在 `/data`。清理镜像不是根盘释放方案。
- 没有发现根盘上已删除但仍被进程打开的普通文件占用。

## 主要占用

以下为互不重叠的主要目录，GiB 为二进制单位，数值为当次盘点近似值。

| 目录/用途 | 占用 | 处理方向 |
| --- | ---: | --- |
| `/var/lib/pubmed-evidence-set` | 20.13 GiB | 含运行数据、模型及审计材料，不能整体删除；其中 `paper-weight-operations/deploy-audits` 约 13.90 GiB 可另行评估迁到数据盘 |
| `/usr/local/cuda-12.8` | 8.74 GiB | 运行依赖，保留 |
| `/opt/codex-gateway-r760` | 8.43 GiB | 主要为 staging 3.98、releases 3.73、builds 0.50 GiB，适合按引用关系归档旧版本 |
| `/opt/goldencode-vessel/releases` | 6.80 GiB | 同机其他服务的版本材料，需该服务的回滚与挂载审查 |
| `/var/backups/pubmed-evidence-set` | 4.73 GiB | 倾向迁到 `/data` 并保留可恢复副本 |
| `/opt/meeting-pack-assistant` | 4.67 GiB | 包含约 2.95 GiB 旧发布目录，需按该项目规则评估 |
| `/var/log/journal` | 4.05 GiB | 当前未配置显式容量上限，可先归档再控制为约 1 GiB |
| `/tmp` | 约 1.84 GiB | 其中已识别超过 14 天、未打开的大型发布压缩包约 0.91 GiB；其他临时文件仍需逐项确认 |
| `/root/.cache/pip` | 0.62 GiB | 可重建的下载缓存；确认无安装任务后清理 |

## 建议第一阶段：释放约 10–11 GiB

1. **归档 Gateway 冷发布材料，约 6.32 GiB。** 候选规则为超过 14 天，排除当前、
   上一版、rehearsal 软链、所有容器的挂载和 Compose 工作目录/配置引用、已发现的
   systemd/cron 引用和进程引用；releases 另保留最近 10 个。得到 staging 69 项
   2.88 GiB、releases 123 项 2.94 GiB、builds 1 项 0.50 GiB。
   这些是归档候选，尚不是可直接批量删除的白名单。执行前重新检查引用，尤其是
   保留目录内部的软链目标，以及候选目录里的凭据和审计材料。
2. **系统 journal 约 4 GiB 缩至约 1 GiB，释放约 3 GiB。** 先归档需要保留的历史
   日志，再设置 `SystemMaxUse=1G`、`SystemKeepFree=10G`，按批准的保留策略轮转清理。
   这会改变系统日志保留策略，不属于本次只读调查。
3. **清理可重建 pip 缓存及确认无引用的旧临时发布包，约 1.5 GiB。** 不清空整个
   `/tmp`，不把近期医疗字幕材料或未知临时文件混入清单。

全部完成后，可用空间估计由 12.6 GiB 增至约 23.4 GiB，使用率降至约 75%。
空间收益需以归档后实际 `df` 为准，文件持续增长、共享硬链接等可能影响净释放量。

**必须保留的 Gateway 版本并不只有 current/previous。** 本次还发现 Research Worker
引用 `9db1efa…`，Research Maintenance 引用 `9808ac8…`，Research LLM Gateway 引用
`2126e7c…`，以及 `rehearsal-current` 指向的历史演练目录。按“只留最新两个版本”
删除其他目录会破坏仍在使用的组件。

归档应写到 `/data` 上受保护目录，保留属主、权限和软链，核对文件清单与校验和后，
才移除根盘原件。引用中的运行版本不迁移。记录原路径、归档位置和恢复步骤，并在
变更后核对原有容器、服务及公网健康；不需要为归档未引用材料重启 Gateway。

## 第二阶段：按项目治理，避免再次增长

优先评估将 PubMed 的历史部署审计约 13.9 GiB 和备份约 4.7 GiB 迁到 `/data`，
合计约 18.6 GiB；先核对活跃写入、定时任务、路径引用和保留需求。Vessel 与会议
资料项目的旧发布目录另走各自保留规则，不能视为 Gateway 的可删缓存。

不建议通过减少 ext4 预留块、卸载 CUDA、删除业务数据库，或执行全局
`docker system prune --volumes` 来处理本次根盘压力。

## 证据与局限

使用 `df`/`statvfs`、限制文件系统的 `du`、Docker 只读 inspect、进程文件引用和
journald 配置核对。受保护的本机证据为
`C:\work\secrets\gateway-ops\disk-review-20261113\report.json`，包含候选目录清单。
`docker system df` 在 100 秒内未完成；已通过 DockerRootDir 和卷路径确认它位于
数据盘，因此未继续耗时枚举镜像，也未估算镜像清理收益。

本次仅形成方案，执行空间释放需要另行明确授权。
