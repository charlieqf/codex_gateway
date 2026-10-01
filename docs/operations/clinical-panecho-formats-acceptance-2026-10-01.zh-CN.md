# PanEcho 公网 ZIP / DICOM 补充验收

2026-10-01 01:47:18 UTC 完成最终验证。**video、video_zip、dicom_zip 三种格式已逐项走通公网实推理、结果和下载。**
Gateway 继续运行 `abffeaf723f72c20ba11e4c6468b21a1c9de7b29`；本次未修改服务配置、替换容器或重启服务。
测试脚本版本 `868dd450aa9883ad930058292e943fa2195c354c`，路径 [clinical-public-formats.mjs](../../scripts/ops/clinical-public-formats.mjs)。

## 方法和样本

使用现有两个 CT 试点用户的真实 Key，通过 `https://goldencode.instmarket.com.au:1443/gateway/panecho/v1` 操作。
Key 仅在 Gateway 容器内存中恢复使用，没有转存到 star、文件或报告；没有新建用户、修改 Plan 或提高额度。
按当前每用户每日 10 次、最多 1 个未完成任务的限制顺序执行，共新增 5 个任务。

原视频来自 [CardioNetworks / I.A.C. van der Bilt 的 ECHOpedia A4CTTS](https://commons.wikimedia.org/wiki/File:A4CTTS_(CardioNetworks_ECHOpedia).webm)，许可 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)。
star 团队将 WebM 转为 MJPEG AVI，再由同一视频的 RGB 像素生成 DICOM；不是患者 DICOM 导出文件。
所有 DICOM 的 PatientID 为固定合成标记，无 PatientName、PatientBirthDate 或 AccessionNumber。
ROI `[0.24,0.21,0.78,0.8]` 排除视频时间和署名标签。
沿用 star 已验证样本，经可信 SSH 主机密钥校验的内网复制；所有输入 SHA256 在运行前复核一致。

## 结果

**119 条公网检查记录全部通过。**

| 案例 | 输入 | 分块 | 预期及实际结果 |
| --- | --- | --- | --- |
| video 基准 | 595712 字节，89 帧 AVI | 1 | completed，40 项输出、1 段视频 |
| video_zip | 609216 字节，包含两个相同 AVI | 1 | completed，40 项输出、2 段视频 |
| dicom_zip | 6748905 字节，单个 89 帧 US DICOM | 1 | completed，40 项输出、1 段视频 |
| mixed_study | 13497782 字节，两个不同 StudyInstanceUID 的 DICOM | 2 | failed，error.code=mixed_study，retryable=false |
| static_dicom | 104582 字节，单帧 US DICOM | 1 | failed，error.code=cine_limit，retryable=false |

每个任务创建后以原幂等键重放返回同一任务；首块重传成功，块清单、大小和散列一致，complete 可重复调用。
跨用户查询输入、已完成任务、结果及产物均 404。
三个合法案例的 40 项 `tasks` 逐字段完全一致，验证了同像素视频、重复视频聚合和 DICOM 解码路径的一致性。
三个案例各下载 result.json、report.csv、preview.png，共 **9 个产物**，均通过清单大小、Content-Length、X-Content-SHA256 及实际文件 SHA256 校验。
三个 report.csv 的散列均为 `23fb1306853e07e7fc3d7ee777fce9319dcd0e99dc514f9db34d42849ba972ee`。
两个反例的结果与产物接口均 409；原键重放仍返回 failed，未自动再执行。
全部任务 DELETE 后查询和下载均 404。

## 清理与运行状态

star 只读检查确认 5 个任务均 deleted，原始输入已从记录清除，对应输入/结果/执行目录已物理删除。
R760 的样本、测试状态、容器内临时脚本及临时 SSH known-hosts 文件均已清理；本地转存样本及传输脚本同样清理。
保留 star 团队原有公开测试样本，未删除其他任务或数据。
临床输入表为空，pending_action=0。五个数据库 quick_check=ok、foreign_key_check=0。
Gateway 和其他项目容器 ID 均与测试前一致，healthy、RestartCount=0，公网连续两次 ready。
应用日志未出现测试 session、检验值或后台 token。

## 验证边界和证据

本次证明当前公共接口的 ZIP 解包、分块传输、多帧 DICOM 解码、推理、任务隔离和结果交付可用。
DICOM 样本为 8-bit RGB、480×694、89 帧、Explicit VR Little Endian 的多帧 US 文件。
本次没有逐项验证不同厂家导出文件及其他 DICOM 压缩传输编码，也不构成诊断准确率或完整心超检查验证。
此前“ZIP/DICOM 尚未逐项实测”的缺口已补齐；客户端按 [v1 契约](./clinical-models-v1.md) 继续接入。

R760 受保护证据目录：`/opt/codex-gateway-r760/backups/clinical-format-842f6a5/`，包含样本散列、逐请求报告、执行日志、前后容器与数据库验证及公网收敛记录。
本地副本：`artifacts/clinical-gateway-20261001/panecho-formats-{report,fixtures,final-verification}.json`。
