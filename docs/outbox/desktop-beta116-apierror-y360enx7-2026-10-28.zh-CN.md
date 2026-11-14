# beta.116 连续 APIError：T:Y360ENX7

结论：故障发生在旧客户端的请求准备阶段，符合 beta.116 对 `goldencode-d` 含图历史的本地硬拦截。Gateway 没有收到后两次重试的模型请求，也没有在相关时间窗对该账号返回模型错误或额度错误。客户端源码已有修复，当前 macOS beta 更新源仍为 2.0.0-beta.116，用户尚未获得修复安装包。

## 定位信息与证据

- 账号：`182****1431`；subject `subj_8o_N1jHeCv8xhnkscPf2us7l`。
- 客户端：MedEvidence Desktop 2.0.0-beta.116，macOS arm64，Research，`goldencode-d`，High。
- session：`ses_e7fd957b0ffeE4VubIqrpgo9FM`。
- instance：`inst_8e2e08e8294a47948c3d964faa30b967`。
- 截图回合：`T:Y360ENX7`；message：`msg_180a13835001l5AuNy1jgQkNFf`。

以下时间均为北京时间（UTC+8）：

| 时间 | 回合 | 结果 |
| --- | --- | --- |
| 11:31:14—11:36:19 | `T:2J2C5YX1` | 23 次 Gateway 模型请求全部成功、上游 HTTP 200，传输图片数均为 0 |
| 11:36:57.040 | 同上 | `read` 工具成功，`output_chars=23` |
| 11:36:57.302 | 同上 | 客户端第 24 次调用准备阶段报 APIError；无对应 Gateway 模型请求 |
| 11:48:50.577 | `T:Z78RG6HZ` | 纯文本重试，59 ms 后本地 APIError；无 Gateway 模型请求 |
| 11:50:11.956 | `T:Y360ENX7` | 再次纯文本重试，62 ms 后本地 APIError；无 Gateway 模型请求 |

最后一次成功模型请求：`req-57072786-1d2e-4723-a9b3-1b54a2d9cff0`，触发 `read` 工具 `call_00_s46q2diqf0hpdd9ozdn052fa`。前一步 `screenshot` 工具成功，截图界面也显示 `hr-preview.png`。

失败诊断 ID 依次为：`cde_0b49e9ddaa034b1789b1c3883c2eebf2`、`cde_370778078778442db6439d63cd7a31de`、`cde_70f7b85a3d804974af099f631141aa77`。堆栈首帧一致：`node-Cq9yxJXe.js:262112:13`，phase 为 `preparing_environment`。诊断上传的 request_id 不是模型 request_id，不应混为模型已到达 Gateway 的证据。

## 客户端代码依据与修复状态

beta.116 标签 `e360e8bf4b84139efb962dd6793bce7096db8600` 的 `packages/opencode/src/session/message-v2.ts:156` 在转换模型消息之前检查：provider 为 medcode、model 为 goldencode-d、`MedcodeVisionContext.catalog(input).length > 0` 时直接抛出 APIError。其正文为“DeepSeek 暂不支持图片，当前会话包含图片”。catalog 包括用户图片及已完成工具结果中的图片附件，因此当前输入是纯文本也会被历史图片阻断。

`read.ts` 读取图片时返回 `Image read successfully`（23 字符）并附加图片。这个实现与本次 read 结果长度及预览图时间线吻合；远程诊断没有保存该工具的原始文件路径和附件正文，精确的图片对象仍需在用户本地 session 数据中确认。

已核实远端 `origin/dev` 为 `fd5a6e1dadb938963c7b08519639f4c98b663f01`：移除了上述硬拦截，并保留 APIError 的实际内容，避免转换成仅显示类型名的 UnknownError。该提交不属于 beta.116 标签。公网 `https://updates.instmarket.com.au/desktop-updates/beta/latest-mac.yml` 返回 HTTP 200，版本仍为 `2.0.0-beta.116`。

Gateway 当前运行 `1efc613f32bbd2a2068d18e1f7cc0639a44a7d03`，healthy、0 次重启；goldencode/goldencode-d 视觉路由的部署与公网验收已完成，见 `docs/archive/operations/cloud-vision-followup-2026-10-28.zh-CN.md`。客户端早期交接文档中“生产 goldencode-d 视觉尚未验收”的描述已过时。

该账号当前有效权益为 `plan_internal_high_quota_image_v1`，每日 50,000,000、每月 500,000,000 token，到期 2027-10-28。这些权益不会绕过 beta.116 本地的模型限制。

## 恢复和客户端验收

临时恢复：在原会话切换到 GoldenCode 的 GLM 模型，再发送“先说明修改方案，等我确认后再改”。GLM 不命中上述 DeepSeek 专属拦截；无需删除历史或反复重试相同 DeepSeek 请求。是否最终恢复需以该会话新请求及回复为准。

正式恢复由客户端发布流程完成：把已包含 `fd5a6e1dad` 的主线提交打包发布到 macOS beta 渠道，验证已安装应用实际升级。不能仅以源码提交或 Gateway 已部署作为恢复证据。

验收必须覆盖：DeepSeek 工具生成 PNG → read 图片 → 后续模型续接；已有图片历史后连续发送纯文本；直接发图及从 GLM 切换到 DeepSeek。要求请求实际抵达 Gateway，Grok 视觉路由成功、用户获得最终回复，且不再显示裸 APIError。保留用户“先确认再修改”的指令。

最小回传：新客户端版本及源码提交、上述 session/turn 对应的新 Gateway request_id、工具图片是否进入历史、最终回复或明确错误文本。若新版本仍在发送前失败，回传完整脱敏 APIError.data 与堆栈；不要回传密钥或签名图片 URL。
