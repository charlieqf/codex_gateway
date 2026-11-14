# Gateway 已完成：AlphaFold / MedEvidence beta.107

2026-10-20 北京时间 08:48 完成 Gateway 验收，可接续已安装 beta.107 的三个模型实际对话验收。

## 部署

- Gateway 应用提交：`43ba3d7536d4795147b84d91f3832ae1ab827a94`，上线于 `2026-10-20T00:43:08.978Z`（北京时间 08:43:08）。
- Nginx 下载配置提交：`b5213615bff75778b2b7eff34268fed4bb0db88e`，平滑重载于 `2026-10-20T00:46:03.385Z`（北京时间 08:46:03）。此次配置修复没有重启 Gateway，容器仍为上面的应用提交。
- 公网地址：`https://goldencode.instmarket.com.au:1443/gateway/alphafold/v1`。
- 所有现有及未来注册的有效 MedEvidence 账号均可使用，沿用登录凭证。默认每账号每天 10 个任务、同时 1 个任务，使用独立持久数据库。
- 私有 TLS 使用托管 CA 验证；独立服务令牌只读挂载。目录保持 root/0700，文件 root:999/0440，私钥留在 star。
- 切换前等待连续 30.31 秒无活动请求，再排空并切换。未重启 star 模型服务或 GPU 调度服务。
- 完整测试 1,914 通过、4 跳过，部署配置测试 2 通过。9 个数据库完整性和外键检查通过，主库 schema 42 不变。8 个受保护输入文件、3 个其他容器及端口保持不变。检查时 Gateway 重启次数 0，发布后日志 warn/error/fatal 均为 0。

## 公网验收

- 公开 76 aa 预测成功：`job_66042a249c0149f997a8f13a340686e1`。创建至完成 44.67 秒；模型报告执行 42.91 秒。
- 创建 request ID：`req-7e45cba2-c1da-4e4d-96d9-e8db980b90b2`；结果 request ID：`req-e044ef99-8d16-44b4-875f-0a42b8f3b201`。其余逐步 ID 见附件。
- 本次结果：length=76，mean_pLDDT=96.02131578947369，pTM=0.84；profile、序列摘要、5 个模型、3 次 recycle、seed 0、无模板/无松弛均符合契约。这些数值仅为本次实测。
- 未登录 401；两名真实账号均可取得 available=true。同键重试返回相同 job_id/200；改序列复用同键 409。
- 未同意外发、非法残基、多条序列均为 422，在创建前拒绝。持久恢复自动化测试确认原始幂等键不变。
- 第二账号查询、读取结果、下载、取消、删除均为 404，即使伪造真实 owner 也不能越权。/source、/input 不开放。
- 七个文件的原始大小、SHA-256、Content-Length、X-Content-SHA256、无 Content-Encoding、no-store/no-transform 及附件头均通过。/result 与下载 result.json 字节完全一致。
- 首次公网验收发现 Nginx 默认 gzip 压缩 HTML、移除 Content-Length；已用上述配置提交修复，并重新跑完整预测和七文件校验。
- 取消任务 `job_74b37fee7f97476b9eb1a33632aaa879`：在 predicting 阶段取消，约 2 秒后 cancelled；00:48:41 UTC 在 star 验证任务 unit 为 inactive，MainPID=0、ControlPID=0。
- 删除后 status/result/artifacts 均为 404。含首次验收在内，3 个 AlphaFold、2 个 EchoNet、2 个 EchoNext 任务均已撤销并清除 Gateway 输入记录，待办动作为空。临时验收文件已清理，脱敏回执已归档。

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| result.json | 1685 | `a6a714774be6d65c9bfd96a0586ce691db62266fc4ee45bf8142e6fe4b7f463b` |
| report.csv | 924 | `79ccd309203243bac9221763c0309e5f312a71345ffdb0b946f411c939af4504` |
| preview.png | 91403 | `7b20e2985027f0b6cd79776fe5523695065ac97b011d539c2fb1683f74876b45` |
| structure.pdb | 49005 | `12286c62269f8189b9e6d84c69930b78496f5a3a6919c6cc390ee9544e2976a5` |
| scores.json | 29196 | `8e9c54e0faf060dae7f64a17536200a8430b80a07aa80d28d11c086ff197daa0` |
| structure.html | 736163 | `f756e6e7e7e3960f08b1f4549a10c5d29ccf2a4787db20900ba330c9fe0a311a` |
| models.zip | 103840 | `cdcf2cb1719a0c2d06dbbbdfc4f7fbaf2eee362fc11696f78f78b9d3364a257c` |

## Echo 回归与客户端后续

- echonext：`job_e447eeb9a234455b9ecd4b4a106bedce`，上传至完成 6.72 秒，原有 3 文件契约通过；幂等、断点状态、分片摘要、账号隔离、取消和删除均通过。
- echonet：`job_ec153132d27b458a94d03eb53a9542f2`，上传至完成 188.76 秒，原有 5 文件契约通过；幂等、断点状态、分片摘要、账号隔离、取消和删除均通过。

AlphaFold、EchoNet、EchoNext-Mini 和 GPU 调度服务的启动时间与验收前一致，NRestarts 均为 0。Gateway 公网接口验收已完成；beta.107 实际对话、文件卡片、离线三维查看器和截图由客户端团队接续，本文不将其标记为已完成。

附件：

- [public capabilities 实际 JSON](capabilities.json)
- [AlphaFold 公网逐步回执与七文件校验](public-acceptance.json)
- [Echo 上传至下载回归](echo-regression.json)
- [部署后验证](deployment-verification.json)
- [Nginx 配置部署回执](edge-deployment.json)

回执不包含 token、用户手机号或原始序列正文。
