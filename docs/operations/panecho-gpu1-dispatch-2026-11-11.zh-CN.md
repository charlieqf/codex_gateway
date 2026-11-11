# PanEcho 解除对 Qwen 的依赖，可用 GPU1（2026-11-11）

## 变更

调度器 `25d8d26` 起，PanEcho 不再要求所在 GPU 的 Qwen worker 已就绪：

- 有就绪 Qwen worker 的卡：生图与 PanEcho 仍按先进先出排队。
- 没有就绪 Qwen worker 的卡：只派 PanEcho。生图仍只派给 Qwen 已就绪的卡。`qwen-image-worker@1` 停用期间，生图只走 GPU0，不会给 worker@1 发票据。
- PanEcho 原有准入不变：有 CT 排队时不占 GPU1；至少 8 GiB 空闲显存、温度 ≤80 °C、GPU 锁；同时只跑一个；预约 8 GiB 主机内存。

此前 PanEcho 与生图在 GPU0 上共用一个先进先出队列。生图每张约 75 秒，前面排着几张图时 PanEcho 要等几分钟，而 GPU1 在没有 CT 时基本空闲。

## 取舍

调度器不抢占已开始的任务，每张卡同一时间只发一张票据并持有一把 GPU 锁。PanEcho 正在 GPU1 上运行时来了 CT，CT 要等 PanEcho 退出并释放锁，与显存余量无关。单视频 PanEcho 约几秒；一次请求最多 64 个视频，执行上限 900 秒（调度器执行期限与临时单元 `RuntimeMaxSec`），所以 CT 的最坏额外等待也是 900 秒。

## 前置条件

MedEvidence `16b6cec518` 已在 star 上线：PanEcho runner 按分到的 UUID 设置 `CUDA_VISIBLE_DEVICES`，再用 `cuda:0`，并断言唯一可见设备的 UUID 与票据一致，否则以 `gpu_mismatch` 拒绝。此前 runner 按 UUID 在列表中的位置算 `cuda:N`，依赖 CUDA 设备顺序与 nvidia-smi 一致；在这一修复之前，不能把 PanEcho 派到 GPU1。客户端已在 GPU0 上完成 smoke 与格式验收，调度器分到的卡与 nvidia-smi 上实际使用的卡一致。

## 部署（北京时间 2026-11-11 13:48）

- 源码：codex-gateway `main` 的 `25d8d26fae76dea34b4845c163d22e29846dfd0f`，已推送到 origin。与线上 `31729a1` 相比只改 `core.py`；部署前核对线上 release 七个文件与 `31729a1` 逐一一致。
- 测试：干净 `git archive` 在 star 上运行 `tests/run_offline.py`，50 项通过、4 项跳过（star 系统 Python 没有 Qwen HTTP 依赖），其中包括 Linux IPC 测试。两项新测试在旧代码上失败。
- Release：`/data/apps/star-gpu-scheduler/releases/25d8d26fae76dea34b4845c163d22e29846dfd0f`，与上一版相同构造（uv 0.9.18 创建的 Python 3.10.12 venv，包复制进 site-packages，源码副本与安装副本一致）。
- 备份：`/data/apps/star-gpu-scheduler/backups/panecho-gpu1-20261111T054804Z`，含 drop-in `clinical-models.conf`、`service.json` 与在线 SQLite 备份（`integrity_check` ok，418 条任务）。
- 切换：队列空闲；drain → drop-in `ExecStart` 改指新 release → `daemon-reload` → 重启调度器 → 2 秒内 ready → resume。

## 验收

- 调度器 `ready=true`、`mode=enforce`、`drain=''`，进程命令行指向新 release，`NRestarts=0`，重启后日志无错误；SQLite `integrity_check` ok。
- 主机余量保持 11 GiB 现场覆盖（`host_reserve_mib=11264`），`service.json` 未改。
- Qwen pool、worker@0、RADAR、PanEcho、IndexTTS 的 PID 均未变化。
- `qwen-image-worker@1` 仍为 disabled / inactive（MainPID 0），调度器观测为未就绪，生图不会派往 GPU1。
- **待完成：**GPU1 上的真实 PanEcho 推理。由客户端在上线后发起一次，并核对实际用卡。

## 回退

把备份中的 `clinical-models.conf` 恢复为 drop-in，`daemon-reload` 后重启 `star-gpu-scheduler.service`；旧 release `31729a1…` 保留在原处。先 drain，等无授予或运行中的任务后再切换。数据库无需恢复，本次没有改动 schema。
