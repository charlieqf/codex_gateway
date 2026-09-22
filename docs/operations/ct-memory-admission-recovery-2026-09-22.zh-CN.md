# CT 内存准入恢复：主机余量从 12 GiB 调为 11 GiB

2026-09-22 07:20 UTC（北京时间 15:20）确认原检查通过公网 Gateway 返回 ready。用户明确要求“只差不到 1GB，能否紧凑一些”，据此仅将 star 调度器主机保留余量由 12288 MiB 调为 11264 MiB。CT 预约仍为 32768 MiB；没有执行单 Qwen 停用方案。

## 原因与变更范围

44 GiB 来自本系统的保守准入策略：RADAR 子进程 `MemoryMax=32G` 被用作 CT 预处理及推理的统一预约额，再叠加 12 GiB 主机余量。它不是已经测量证明的 CT 最低运行内存。双 Qwen 空闲常驻时，现场 MemAvailable 约 43.39 GiB，导致无 GPU 任务时也无法放行原 CT 预处理。

本次保留全部模型进程，只修改 `/data/apps/star-gpu-scheduler/config/service.json` 中 `host_reserve_mib` 一个字段。受保护备份验证后，经 operator drain 暂停新准入，重启调度器加载配置，核验 ready/enforce 后 resume。Qwen pool、两个 worker、RADAR、IndexTTS 的 PID 与活动状态保持不变；未变更权重、模型依赖、显存和温度门槛、票据和 GPU flock 机制。

空闲时准入门槛因此由 44 GiB 变为 43 GiB。有其他执行任务时，仍须扣除它们的预约增长空间，不能仅以系统显示的 MemAvailable 判断能否立即开 CT。切换期间已有图片继续执行，CT 待资源释放后获准。

运行版本保持：Qwen / scheduler `58a4d806b39e493a4ca9bbfb9f69825cd20eb946`，RADAR `20a371030093989b5dfe08ae58e9b89d8bd9c26c`。这是显式配置覆盖；源码和部署工具默认仍为 12 GiB，后续发布应先核对并保留当前选择，不可无意恢复旧值。

## 原检查恢复证据

- 原会话：`ses_f382ac527ffe2rZvUNz7WdAF7b`。
- 原 study：`study_cdc4595c1e15442fbfdee46f66eb9e02`。
- 原预处理票据：`sched_2486ca3c77c248509cc2531ff157f677`，未换单或重新上传。
- 输入保持 98,330,067 字节，SHA-256 `8e0e52551b675cb64907bb74506cd9393f195454a6ee7ebf56163e2c136fbabf`。
- 07:19:16 UTC 原 study 已 ready，`series_0001` 为 eligible，尺寸 512×512×368，spacing 为 0.703125 / 0.703125 / 1.25。
- 07:20:13.997 UTC 用原归属账号现有凭据，从公网 Gateway GET 原 study，HTTP 200、state=ready、eligible=true；request ID `req-b72005d5-7025-44c9-8cbc-025704f19a23`。
- 调度器和 RADAR SQLite quick_check=ok、外键违规 0；恢复记录时 MemAvailable 约 43.34 GiB。

脱敏配置与状态回执：[recovery.json](../../artifacts/ct-waiting-memory-20260922/recovery.json)。本次未创建 study 或提交新的推理 job，未生成或宣称验收 HTML。

## 客户端接续及待改进项

可在原会话使用上述原 study 和 `series_0001` 接续一次正常推理、下载与 HTML 打开验收。无需重新上传，也无需在资源未准备好时反复要求用户回复“继续”。服务端 study ready 不会自动唤醒已经结束的客户端回合；需要由客户端团队恢复原流程。

本次最小配置调整没有实现：等待原因在 study/job/Gateway 响应中的透传、RADAR 等待期间避免重复拼接校验 upload.bin、客户端可取消的限频等待。这些仍是交接中的后续产品修复项。主机余量缩减也不代表完成了所有 CT 尺寸及混合负载的峰值内存测量。

## 备份与恢复

备份目录：`/data/apps/star-gpu-scheduler/backups/ct-reserve11-20260922T071659Z`，目录 0700；原 service.json、两库在线备份及验证记录受保护保存。数据库备份均通过 quick_check 和外键检查。回退配置使用 `previous.service.json`，只重启调度器并恢复此前准入状态；不恢复旧业务数据库，不清除票据或 GPU 锁文件。

此前单 Qwen 恢复脚本因出现正在运行的图片，在前置检查即退出，未 drain、停用或 mask 任何 worker。
