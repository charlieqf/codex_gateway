# AF3 Gateway 上线与 AF2 撤除回执

Gateway 侧已完成。最终在线版本 `8d55a638ec30753094802a063c771b28ee358f17`，
部署时间为 **2026-10-21 08:27:40 北京时间**（00:27:40 UTC）。
08:32:11 完成终验，08:33:23 完成临时文件清理。

本次先上线 AF3 并完成真实公网验收，再立即执行 AF2 退役发布，
没有设置旧客户端或旧任务兼容期。最终 Gateway 只保留 AF3 蛋白服务。
star 端 AF2 服务退役和独立 ColabFold MSA 环境由原 AF3 服务端会话负责，
按用户确认分工，本回执不宣称该部分或新版安装包验收已经完成。

## 公网契约与 AF2 撤除

- 入口：`https://goldencode.instmarket.com.au:1443/gateway/alphafold3/v1`。
- profile：`alphafold3-monomer-public-msa-v1`；真实账号 capabilities 200/available=true，未登录 401。
- 独立任务库、AF3 CA/token 只读挂载及私有 TLS 校验通过；日限 10、同时活动任务 1。
- 一个网络、五个扩散样本、十次 recycle；capabilities 的 `num_recycle` 与 result 的 `num_recycles` 分别按实际契约处理。
- AF2 服务注册、profile、结果校验、PDB 白名单、公网路由、`GATEWAY_ALPHAFOLD_*` 和两个凭据挂载已删除。
- 旧 AF2 capabilities/jobs/result/source 实测均为 404，无跳转；AF2 profile 在 AF3 创建接口为 422，PDB 下载为 404。
- 不迁移 AF2 SQLite，不设置只读历史接口或 AF2 回退。当前 `current`、`previous` 均指向最终 AF3-only 版本，不存在活动的 AF2 回退目标。
- EchoNet、EchoNext 原有入口和输出数量保持不变。

## 真实任务与请求证据

首次验收成功任务：`job_e40cc3fe1d324d978e1ff4345e2e6b23`。
切换后再次成功任务：`job_2cdf845063914f3b85874c4c533cec96`，从提交到 completed 约 46.686 秒。
创建 request ID：`req-46c6ebe1-3e51-4121-9940-07f5017b9dd7`。

公开 ubiquitin 序列长 76 aa；本次平均原子 pLDDT 90.9232、
平均 CA pLDDT 94.5883、pTM 0.85，
CA pLDDT 低于 70 的残基 3 个，五个样本。上述数值是本次实测，未用固定置信度值作为验收断言。

切换后取消任务：`job_888af9bb733a4dc39ae8f345ee221dca`。
创建 request ID：`req-87d4c8e5-6d8a-4391-8b82-85cf21e521ff`。
实测路径为 predicting → cancel_requested → cancelled；最终 cancelled 后才删除。
首次和切换后的两轮预测/取消任务均已删除，向私有服务复核四个 job 均为 404。

全部通过：

- 同键同输入返回同 job_id；同键修改序列为 409。
- 未同意外发、131 aa、多序列及未知残基均为 422。
- 第二账号读取状态/result/artifact、取消、删除均为 404，伪造 owner 无法越权。
- 创建立即返回，保留 MSA/GPU/predicting 进度；没有重新提交到 AF2。
- 七文件大小和 SHA-256 均匹配；Content-Length、Content-Type、X-Content-SHA256 保留，未压缩，`no-store, no-transform`。
- `/result` 与 artifact `result.json` 原始字节相同；HTML 以附件及 sandbox CSP 提供。

[完整公网 capabilities](./public-capabilities.json)、[切换后逐请求回执](./post-retirement-report.json)、
[首次上线回执](./first-public-smoke.json)、[七文件机器回执](./artifact-receipt.json)。

## 七文件校验

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| result.json | 2580 | `889fa28195993a95e026cfc3b8c0fa2f93fb5dacc574805823f6a758edb91f0f` |
| report.csv | 936 | `4b40d4c8269d0e3bb97907750dd3495fa0c666baeb2ea19b18a9092973f6f67b` |
| preview.png | 92984 | `c4f070103618b72b05d72b71446906127c2490848c5fbc272aed7441ef6bf6c5` |
| structure.cif | 55981 | `7da60a2e9dec6e4aed8efdb5322ec8487c84870004f23b8a24245a4c18a344a6` |
| scores.json | 54742 | `4d22660bdded075ae22156fc94786ca97c33ee4b47f40dc5bc91b397e6f39c4e` |
| structure.html | 747892 | `e52b5820830b67b65ce2c22064fcdd2eaac231cf0c8b92bcb868542060c977d3` |
| models.zip | 137708 | `3641016ad81beb4d83ec832f1139bd7742efc91a2961e471d67fd4d4ebc9d3c8` |

## Echo 回归和运行终验

EchoNet：视频上传、断点/重复分片、推理、五文件下载、隔离、取消和删除通过，
成功任务 `job_1d76aa2a36cd40a2878682dfe18f1399`，耗时 186.66 秒。
EchoNext：XML 上传、推理、三文件下载、隔离、取消和删除通过，
成功任务 `job_e2dfb5de368f48f9b0e6d66977a9d4e9`，耗时 6.67 秒。
[Echo 完整回执](./echo-report.json)。

- 最终 Linux：103 个测试文件通过、2 个跳过；1920 项测试通过、4 项跳过。退役脚本离线检查 3 项通过，AF3 切换配置检查 2 项通过。
- Gateway healthy、restart_count=0、public ready；schema 42 不变。
- 9 个活动数据库 quick_check=ok、外键违规 0；8 个受保护配置文件、3 个其他项目容器和端口绑定均保持原样。
- 终验日志 warn/error/fatal 均为 0；未出现测试序列或 consent 正文。
- 本次共 8 个临床任务已撤销访问并移除本地输入，私有服务复核全部 404；8 个临时运行文件和目录已清理。
- 没有创建临时账号或凭据。两次发布均先等待自然空闲并排空请求；不宣称零停机。
- 第二阶段准备曾发现部署脚本生成的两项 Python 缓存；已精确清理，并设置禁止生成字节码后重新准备，未用脏目录发布。

[运行终验](./final-verification.json)、[私有任务清理复核](./upstream-cleanup.json)、
[临时文件清理](./runtime-cleanup.json)。

## 服务端／客户端后续交接边界

Gateway 已满足 AF3 公网真实预测与下载前置条件，原 AF3 服务端会话可按更新交接单完成：
独立安装固定 ColabFold 1.6.3 MSA 环境、切换 AF3 的 `msa_batch`，
再做一轮真实公共 MSA → AF3 → 七文件验证；随后停用 AF2 主服务及开机启动，
确认测试进程和锁已退出后清理 AF2 专用环境、权重和凭据。共享 GPU 锁、
进程组清理和报告实现继续保留。

服务端完成后应补回：独立 MSA 路径/版本、AF3 配置不再引用旧环境的确认、
AF2 inactive/disabled 证据、进程/锁清理结果、新真实任务及七文件哈希。
客户端团队继续新版安装后的实际对话与文件打开验收；本次未改 beta.108 安装包或更新源。
