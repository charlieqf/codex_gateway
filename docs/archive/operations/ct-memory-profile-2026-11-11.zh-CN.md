# CT 内存实测与 star 内存准入调整（2026-11-11）

## 背景

2026-11-11 08:53（北京时间），一次 CT 预处理因主机内存不足排队 30 分钟。当时两个 Qwen worker 都在常驻，每个约占 40 GiB 匿名内存，`MemAvailable` 低于 CT 空闲准入门槛 43 GiB（CT 预约 32 GiB + 主机余量 11 GiB）。09:23:36 用户手动停掉 `qwen-image-worker@1`，3 秒后预处理获准，实际只运行约 1 秒，随后两次推理各 11–13 秒完成。

32 GiB 是 RADAR 子单元的 `MemoryMax`，被直接当作预处理和推理的预约额，并非实测值（见 [9-22 恢复记录](ct-memory-admission-recovery-2026-09-22.zh-CN.md)）。

## 实测方法

- 内核 5.15 没有 `memory.peak`，systemd 249 也不记录峰值。用只读采样器每 50 ms 读取 `radar-task-*` 临时单元的 cgroup `memory.current` 与 `memory.stat`（anon、shmem、file），记录各项最大值。
- 所有测例都经私有 RADAR API 正常提交，由调度器发放执行票据，不绕过准入。每例完成后立即删除 study。
- 输入只有公开示例（`AC423ccbe.nii.gz`）和合成数据，不含患者数据。合成数据取体素上限 512×512×1024，全部为软组织值，是 RADAR 裁剪和 `np.nonzero` 的最坏情况。
- 原始结果见 [profile.json](../../../artifacts/ct-memory-profile-20261111/profile.json)。

| 测例 | 输入 | 预处理峰值 | 推理峰值 | 结果 |
| --- | --- | ---: | ---: | --- |
| A | 公开 CT 512×512×368，0.70/0.70/1.25 mm | 0.3 GiB | 4.5 GiB | 成功，推理 19 秒 |
| B | 合成 NIfTI 512×512×1024，0.8/0.8/1.25 mm | 0.6 GiB | 10.6 GiB | CUDA 显存不足 |
| C | 同体积 DICOM ZIP，16 位，无 rescale | 2.6 GiB | 10.3 GiB | 推理失败 |
| C2 | 同体积 DICOM，intercept −1024（读入为 32 位） | 4.2 GiB | 不适用 | 合成像素值超出窗位，推理无效 |
| C3 / F | 同体积 DICOM，slope 0.5（读入为 64 位浮点） | 7.2 GiB | 10.4 GiB | CUDA 显存不足 |
| D | 同体积 NIfTI，0.7/0.7/1.0 mm | 0.6 GiB | 7.7 GiB | CUDA 显存不足 |
| E | 64 位浮点 NIfTI | 被拒 | — | 解压后超过 2 GiB 上限 |

结论：

- RADAR 先把体积重采样到 1×1×5 mm，再在 GPU 上生成 37 通道全尺寸掩码；运行时显存上限为 50%（23.69 GiB）。重采样后体积较大的输入先因显存不足失败，因此能成功完成的任务，主机内存峰值都低于上表各失败例。
- 主机内存最坏值：预处理 7.2 GiB，出现在非整数斜率 DICOM，整卷以 64 位读入时；推理 10.6 GiB。

## 调整

| 项目 | 原值 | 新值 | 依据 |
| --- | --- | --- | --- |
| RADAR 预处理 `MemoryMax` / 调度器预约 | 32 GiB | 12 GiB | 7.2 GiB 的 1.67 倍 |
| RADAR 推理 `MemoryMax` / 调度器预约 | 32 GiB | 16 GiB | 10.6 GiB 的 1.5 倍 |
| 排队 CT 的内存保护 | 32 GiB | 等于推理预约（16 GiB） | 与预约一致 |
| 正在生图的 Qwen 增长预算 | 56 GiB − `MemoryCurrent` | 56 GiB − anon | `MemoryCurrent` 含约 16 GiB 可回收页缓存，导致增长被低估约 15 GiB |
| 主机余量 | 11 GiB（现场覆盖） | 不变 | — |

预约额始终等于子单元的硬上限。估错时只会让这一单 CT 在自己的 cgroup 内超限失败，不会拖垮主机。部署顺序为先降 RADAR 的上限，再降调度器的预约，保证任何时刻预约都不低于上限。

空闲时 CT 推理的准入门槛由 43 GiB 降为 27 GiB（16 + 11）。

## 部署与验收（2026-11-11，北京时间）

| 时间 | 变更 | 结果 |
| --- | --- | --- |
| 09:49 | 停用 `qwen-image-worker@1`，并从 pool 依赖中移除 | 未重启任何服务；pool 与 worker@0 的 PID 不变 |
| 10:11 | RADAR 切换到 `releases/2f0ba2c2d8dc768c9600a3cddacc2c857078d413`（MedEvidence dev 提交），空闲时重启 | 能力接口正常 |
| 10:22 | 调度器切换到 `releases/31729a15d2122b070b0a9f6dbdca71fe58869eda`：先 drain，再改 systemd drop-in 的 ExecStart，然后 resume | ready / enforce，主机余量保持 11 GiB |

验收：

- RADAR 切换后、调度器切换前：临时单元的 `memory.max` 分别为 12 GiB 和 16 GiB，swap 为 0。公开 CT 推理成功（19.2 秒）。64 位 DICOM 预处理在 12 GiB 内完成，推理仍因 CUDA 显存不足失败，与切换前一致。日志中没有 cgroup OOM。
- 调度器切换后：新代码读到 worker@0 的 anon 为 40,790 MiB。一张 512×512 生图在 GPU0 运行期间，公开 CT 的预处理和 GPU1 推理分别在 0.4 秒和 0.2 秒内获准，没有 `waiting_memory`。生图 34.5 秒返回有效 PNG；CT 推理 18.2 秒完成。系统 `oom_kill` 计数没有增加。
- 未覆盖：Desktop → Gateway → star 的完整客户端流程。这条链路本身没有改动，需要在客户端发起一次 CT 读图来确认。

回退方法：

- 调度器：把 `backups/ct-memory-20261111T022201Z/clinical-models.conf` 恢复为 drop-in，执行 `daemon-reload` 后重启调度器，旧 release `480bcf8…` 保留在原处。必须先回退调度器，再回退 RADAR，保证预约始终不低于上限。
- RADAR：把 `current` 指回 `releases/1d0ac94dd7c2d51fa518cdc238605bd3e57c1230`，空闲时重启 `radar-imaging.service`。

## Qwen GPU1 worker

同日起 `qwen-image-worker@1` 保持停用，并已从 pool 单元的依赖中移除。理由如下：

- 近 30 天 373 张图中，GPU1 只承担了 36 张。
- 按单 worker 回放，最长等待 253 秒，没有请求超过 600 秒的排队上限。
- 11-06 worker@0 撞上自己 56 GiB 的 cgroup 上限被杀，说明单个 Qwen 峰值可达 56 GiB。两个同时生图可能需要约 112 GiB，而主机总内存只有 125.5 GiB。

现场备份：`/data/apps/star-gpu-scheduler/backups/worker1-off-20261111T014932Z`。
