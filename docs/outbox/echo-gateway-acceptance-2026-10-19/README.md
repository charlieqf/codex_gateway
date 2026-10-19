# EchoNet / EchoNext Gateway 部署与联调回执

Gateway 已于 **2026-10-19 13:15:35 UTC（北京时间 21:15:35）** 上线，部署提交：
`6d33d4a44ba19d31192d82ee1ecfb9e1ab08e502`，已推送 main。

两条公网能力接口均返回 HTTP 200、`available:true`：

- `https://goldencode.instmarket.com.au:1443/gateway/echonet/v1/capabilities`
- `https://goldencode.instmarket.com.au:1443/gateway/echonext/v1/capabilities`

按用户后续要求，访问策略为 **所有现有和未来注册的 MedEvidence 账号**，使用现有有效 Gateway 凭证即可，新账号无需追加白名单或重启。
两种新服务设为 `MODE=authenticated`；既有 AIPAL / PanEcho 仍保留原 pilot 白名单。未登录、失效凭证、停用账号不放行；用户任务保持隔离。
每种服务独立限制每用户每 UTC 日 10 个新任务、1 个活动任务；不扣聊天 token。

完整能力响应见 [capabilities.json](./capabilities.json)，接口约束见 [Echo Gateway v1](../../operations/echo-gateway-v1.md)。

## 真实公网验收

从 R760 经真实公网 HTTPS 地址调用，使用公开样例完成创建、分块、续传、complete、轮询、result 和全部产物下载。

| 输入 | 任务 ID | 完成耗时 | 验证结果 |
| --- | --- | --- | --- |
| EchoNet 原始演示 MP4 | `job_a0f64c6fc6e141218e0f3c4fbda61625` | 182.69 秒 | EF 60.68011477，211 帧，5 个产物 |
| EchoNext 公开 MUSE XML | `job_867c5e08e9e141c0b05b0491c60fca1d` | 4.74 秒 | 12 项独立分数，3 个产物 |

8 个文件均核对 Content-Length、X-Content-SHA256、实际字节长度与 SHA256；无 Content-Encoding，Cache-Control 为 no-store, no-transform。
EchoNet 五个文件完整包含 result.json、report.csv、preview.png、overlay.mp4、contours.json。
完整请求 ID、状态及产物散列见 [public-acceptance.json](./public-acceptance.json)。

同时实测：未登录 401；跨账号读取、上传、取消及伪造 owner 均不能越权；同键同请求重放 200；同键不同请求 409；错误分块摘要 409；正确块重传成功；续传包含 job_id、chunk_bytes 和已接收分块；取消/删除 202，删除后查询及下载 404。

## 客户端代码真实联调

直接调用客户端实际 `clinicalClient`，未重新实现其上传、轮询或下载逻辑，完成本地文件散列、真实公网提交、等待及本地原子落盘。
使用不在旧 clinical pilot 白名单中的独立已注册服务账户，验证新的全账号开放策略。
客户端 checkout 为 `13ac0e9a8fa5fee1405420dd0529ac34b438d793`，clinical-client.ts 与交接提交 `c4b1d4b677b19d5b87e16ee2601ebdaf7ef9967c` 无差异。

| 输入 | 任务 ID | 客户端端到端 | 后台 runtime_seconds | 已校验落盘文件 |
| --- | --- | --- | --- | --- |
| MUSE XML | `job_6c8fb10b490044eaafe89a276bbc63f4` | 123.930 秒 | 3.286 秒 | 3 |
| 63 帧视频 ZIP | `job_63ea2413dc194f63851438819e414703` | 55.134 秒 | 8.622 秒 | 5 |
| 63 帧合成 DICOM ZIP | `job_9403098d5fe34dcd87dc7b809a38de49` | 305.943 秒 | 8.371 秒 | 5 |

客户端端到端包含本地散列、公网上传、控制请求、轮询和全部下载，不能等同于模型推理耗时。DICOM 来自公开视频的合成包装，仅验证接口，不代表真实设备或临床准确性。
13 个客户端产物的完整散列、输入散列和模型来源见 [client-acceptance.json](./client-acceptance.json)。后台源码仍为 `76712e80495e640c841a78a61cea4124a659e5d3`。

## 发布、回归与清理

- 本地构建及 focused 测试通过；干净 Linux 构建 **1,910 passed / 4 skipped**；部署配置边界测试通过。
- 覆盖新注册账号自动准入、停用账号拒绝、请求/结果校验、32 MiB 边界、完整产物集合、日志脱敏、数据库互斥、CA/散列验证。
- 持久任务重启恢复由真实 SQLite 的自动化集成测试验证；没有为测试额外重启生产 Gateway。
- 从 13:04:02 UTC 等待生产请求自然结束，13:15:14 确认连续 30.31 秒空闲后 drain 和切换。单实例切换及验证约 20.6 秒，不宣称零中断。
- 备份：`/data/backups/codex-gateway-daily/20261019T125409Z`；控制配置恢复材料在 `backups/release-6d33d4a44ba1/`。
- 13:26:16 UTC 复核：健康、RestartCount=0；8 个数据库 quick_check=ok、外键异常 0；identity schema 仍为 42。
- 8 个既有受保护配置/密钥文件、3 个其他 Compose 容器和端口保持原状。star 两个新模型、AIPAL、PanEcho 及 GPU 调度器均保持原启动时间、NRestarts=0。
- 7 个测试任务已撤销访问并清除 Gateway 输入记录，无待投递删除动作。公开样例下载保留为验收证据，不含患者数据或密钥。
- 发布后无 error/fatal；1 条 warning 为既有工具循环保护的 shadow 提示，不改变请求，与 Echo 无关。

详细部署复查见 [deployment-verification.json](./deployment-verification.json)。构建、等待、切换及失败构建尝试日志均保存在 R760 `staging/6d33d4a44ba19d31192d82ee1ecfb9e1ab08e502/`。

## 客户端团队的安装包验收

Gateway 和客户端协议代码实连均已通过，尚未把该结果等同于已发布安装包的界面验收。客户端团队可进入候选安装包验证：

1. 用普通现有账号及新注册账号登录，确认两个功能可用。
2. 从文件选择器分别选择视频/视频 ZIP/DICOM ZIP 和 XML，确认 A4C/ROI 或 ECG 质量提示，完成上传、等待及产物打开。
3. EchoNet 应展示或提供五个文件，EchoNext 三个；等待超时应保留原任务，点击继续不得创建重复推理。
4. 若失败，回传客户端版本、UTC 时间、mode、job_id、Gateway request_id、错误 code，以及是否发生在上传/轮询/下载/打开阶段；无需回传密钥或原始病例。
