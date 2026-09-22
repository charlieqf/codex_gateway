# Qwen / RADAR 统一调度生产切换回执

2026-09-22 **05:03:25 UTC / 北京时间 13:03:25 / 悉尼时间 15:03:25** 恢复业务入口，生产已启用真实共享调度。05:04:40 UTC 完成上线状态核验。用户明确授权“完成充分的 mock 测试验证后，把生产切换到真实调度”；本次没有提交真实生图或 CT 推理测试请求。

## 生效版本与行为

| 项目 | 当前状态 |
| --- | --- |
| 调度器 / Qwen 源码 | Gateway main `58a4d806b39e493a4ca9bbfb9f69825cd20eb946`，已推送 |
| RADAR 源码 | `20a371030093989b5dfe08ae58e9b89d8bd9c26c`，已随 dev 合并提交 `34c50a9c39` 推送；两提交的 RADAR 目录树完全相同 |
| Gateway 容器 | 继续使用 `f8c1a943d31769125fb80574b22eab6f6c74b06f`，未重建 |
| 模式 | `star-gpu-scheduler.service`，`mode=enforce`，`ready=true`，未 drain |
| 强制参与者 | Qwen pool、GPU0 / GPU1 worker、RADAR service 均已核验实际进程环境 `GPU_SCHEDULER_REQUIRED=1` |
| 外部接口 | 生图同步 API、CT 异步 API 保持原合同 |
| 生图链 | Qwen pool → 既有 GPT Image 2 / 云端后备；LLaDA 仍停用，Gateway 无 LLaDA 配置 |

GPU0 接生图；GPU1 优先处理已准备好的 CT，没有待执行 CT 时可接生图。已开始的任务不会被新任务抢占。CT 预处理预约主机内存且不占 GPU；RADAR 每次最多一个子进程。GPU 原子预约与执行器自己的 Linux flock 同时生效，claim 核验实际持锁 PID。调度器重启或心跳失联不能自动释放正在执行的 GPU。

主机额外保留 12 GiB；Qwen 按每个 56 GiB cgroup 上限与当前占用之差预约增长空间，CT 按完整 32 GiB 保守预约。**双卡就绪不保证双任务同时执行**：资源预算不足时会串行或等待。此次未通过真实混合推理重新测量峰值，未为追求并行放松内存预算。温度策略保持 80°C 准入、88°C 中止。

生图最多四个在途任务，最多两个执行；排队上限 80 秒，总预算 170 秒。队列满返回 429，无法取得资源或排队到期返回 503，之后由 Gateway 既有云端策略处理。CT 保留原异步状态机，资源等待显示 `waiting_gpu`；调度器暂不可用时未启动的任务继续排队，受资源有效期限制。已中断的 CT 执行保持原有显式重试语义。

IndexTTS **尚未加入共享锁**。其实际显存和内存占用计入资源准入，推理期间的增量仍是首版边界；本次未重启或修改它，PID 保持 `2872499`。

## 验证与自审

- 最终已提交发布包在 star 的 Qwen Python 3.11 环境运行 **68 项 mock 测试，全部通过，无跳过**。
- 同一运行代码在 RADAR Python 3.10 环境运行兼容性检查：51 项中 **47 通过、4 跳过**；跳过的是依赖 Qwen HTTP 环境的混合池测试，这四项已在上述 Python 3.11 环境通过。后续增加的四项仅覆盖部署脚本，已纳入最终 68 项。
- Gateway Qwen provider 回归 **4 项通过**；防止残留 LLaDA 配置重新进入 Qwen 后备链的源码加固已提交。当前 Gateway 二进制未更新，线上不回落到 LLaDA 仍由已撤下的配置与服务保证。
- RADAR 源码推送前，仓库要求的 workspace typecheck 30 个任务全部通过，使用缓存。
- 三个 Python 环境中安装的调度器文件均与已提交源码构建的 wheel 逐文件哈希一致；systemd unit 校验通过。

测试使用真实 SQLite、Unix socket、SO_PEERCRED、Linux flock 和短生命期子进程，模型执行器与硬件观测为 mock。测试 runner 禁止真实模型库导入、GPU / systemd 命令以及外网连接。覆盖双卡分配、CT 优先且不抢占、CPU 预处理、内存 / 温度 / 未知 GPU 进程阻塞、队列容量及期限、取消、幂等、权限与载荷绑定、过期令牌、调度器重启、心跳失联、claim / finish 响应丢失、清理失败、持锁进程退出、存储失败关闭准入，以及部署与回退保护。

自审修复了：Qwen 传输超时后健康探测未知却提前释放名额；RADAR 用旧 queued 快照取消正在运行的任务；systemd-run 失败时未充分确认子进程退出；完成回执临时文件过于宽泛。清理失败现在令 Qwen 退出并由有限次 systemd 重启恢复，不继续承接新任务。

## 上线核验

切换前确认无排队 / 执行中的 Qwen、RADAR 任务，再停止入口和空闲 worker。新 worker 在 **05:02:20 / 05:02:27 UTC** 就绪。数据库记录两个 `image_init` 均 `succeeded`，分别由两个 worker 在指定 GPU 上取得票据并执行；这证明生产调度与锁的初始化路径实际工作，**不属于生图或 CT 推理质量 / 性能验收**。

恢复入口后：调度器、两个 Qwen worker、pool、RADAR 均 active / enabled，重启计数 0；两个 worker ready 且空闲；调度器队列、运行、释放、恢复计数均为 0。恢复入口前已确认两张卡的共享锁可取得。RADAR 经过证书验证的私有 TLS capabilities 返回 HTTP 200、available=true；调度器与 RADAR SQLite quick_check 均为 ok，外键违规 0。公网 Gateway `/gateway/health` 返回 HTTP 200、state=ready、inference.state=healthy。

没有修改模型权重、Torch 等模型依赖、驱动、风扇、功耗、SSH 白名单 / 隧道、公网端口、客户端凭据或业务套餐。模型重新初始化是本次重启的必要步骤；未提交真实生成、CT 作业或人工混合负载。

## 制品、备份和回退

- Gateway 限定源码归档 SHA-256：`0f886793ee538354f6d294b7c8e94eaf62abc65b5c78ace89a4a4b8ea1945ef1`。
- RADAR 源码归档 SHA-256：`37bc2a9a7e2d23736080ea918614ee9669808d4a0380223ae4da0b251ea4e426`。
- 调度器 wheel SHA-256：`5e37816acdda12d1822affae89e8c19502dedb7f91ca09d73afdd90e1cf961f9`，只包含标准库实现，无模型依赖。
- star 最终备份：`/data/apps/star-gpu-scheduler/backups/pre-20260922T050113Z`，含原 units / current 记录、受保护配置、RADAR 在线 SQLite 备份、逐文件校验记录。目录 0700，文件 0600。
- 首次准备发现 RADAR venv 没有 pip，在停止业务前退出；该次备份保留。改用现有 Qwen pip 的 `--python` 定向安装，`--no-index --no-deps`，不更改模型依赖。
- Linux 最终 mock 记录：`/data/apps/star-gpu-scheduler-tests/58a4d80/qwen311-tests.txt`。
- 生产核验：`/data/apps/star-gpu-scheduler/state/production-verification-20260922.json`。
- 本地不含凭据的证据归档：`C:/work/code/.task-artifacts/star-scheduler-20260922`。

按 [运行说明](../../services/star-gpu-scheduler/README.md) 操作 operator `status / drain / resume`。回退执行已发布 `deploy.py rollback`：停止入口与执行器、确认 RADAR 子进程消失，恢复原源码与单元，并从旧 pool 的 systemd 依赖移除 GPU1 worker。回退仅启动 **GPU0 Qwen + GPU1 RADAR**，不恢复数据库备份、不重启 LLaDA。不得使用旧双 Qwen 发布文档中会恢复 LLaDA 的历史回退流程。

开发过程中保留了两个仓库的所有无关修改。RADAR dev 在准备期间收到一个无关发布文档提交，已备份三个脏文件后原地合并，恢复核验逐字节一致；未创建开发分支、worktree 或 clone。

## 可转发给客户端团队

> Qwen / RADAR 统一资源调度已于 2026-09-22 北京时间 13:03:25 生效。生图与 CT 继续使用原接口，两类请求现在共同申请 GPU 和内存资源；GPU1 优先 CT，不抢占已开始的任务。资源不足时等待或按原接口返回队列 / 超时状态。LLaDA 未恢复，既有云端生图后备保留。
>
> 最终 68 项 Linux mock 测试全部通过，生产服务、调度模式、初始化票据、共享锁和 CT capabilities 已核验。本次未提交真实生图或 CT 推理测试。请客户端按现有入口复测连续生图、CT 与生图交错提交，并回传 request ID / job ID、等待时间及实际 provider；主机内存预算可能使任务串行执行。
