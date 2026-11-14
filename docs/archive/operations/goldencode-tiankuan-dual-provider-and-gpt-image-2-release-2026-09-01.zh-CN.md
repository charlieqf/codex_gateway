# GoldenCode 天宽双平台与 GPT Image 2 发布记录（2026-09-01）

## 结果

- R760 生产 `goldencode` 已从腾讯单平台改为腾讯与天宽双成员池。
- 选择策略为 `hrw_sticky`，粘性键顺序为
  `client_session -> credential -> subject`。
- `medcode-image-default` 的首选上游模型已改为 `gpt-image-2`；既有后备链路保留。
- 生产发布版本：
  `643235f8b9651ba099b8b48b6453097e16846034`。
- 回滚版本：
  `14935735f92f631e16355d62944feaef479f2921`。
- 发布备份：
  `/data/codex-gateway-r760/backups/pre-goldencode-tiankuan-20260901T092010Z`。

## 上游验证与性能

天宽的 OpenAI 兼容接口已验证模型枚举、非流式/流式文本、低/高推理、
强制工具调用和工具结果续接。R760 同提示词、同推理配置各取 5 次的结果为：

| 平台 | 成功率 | 首内容中位数 | 总耗时中位数 | 总耗时 P80 |
| --- | ---: | ---: | ---: | ---: |
| 腾讯 | 5/5 | 3,093 ms | 3,094 ms | 3,816 ms |
| 天宽 | 5/5 | 1,109 ms | 1,227 ms | 1,357 ms |

天宽在本次样本中更快，满足“不慢于现有腾讯平台”的接入条件。

## 会话粘性与故障转移

网关使用 HRW 哈希对粘性键和两个成员 ID 评分。正常情况下，相同客户端会话
始终命中相同平台；没有客户端会话 ID 时退化到凭证 ID，再退化到用户 ID。
平台进入限流、服务错误、超时、重授权或并发上限状态后会暂时从候选集合排除。
仅当响应内容尚未发给客户端时，本次无状态请求才允许改投另一平台。

## 生图故障结论

切换前 7 天的生图错误共 59 次，均为 OpenAI `gpt-image-1.5` 的
`rate_limited`。原后备逻辑只对账单硬限额分类触发，因此普通限流没有继续落到
xAI 或 Gemini。充值后已确认 OpenAI 账户可访问 `gpt-image-2`，并完成真实公网
生图验证。

`goldencode` 的图片理解仍由 xAI `grok-4.5` 提供；它与本次图片生成模型变更是
两条独立路径。

## 生产验收

- 腾讯：请求 `req-e2fc588c-7aea-4d97-8a9f-48a45a6d34b8`，
  `tencent / glm-5.3 / ok`。
- 天宽：请求 `req-29416e70-1fd8-41de-b955-de50ee036914`，
  `tiankuan / official/glm-5.3 / ok`。
- 天宽强制工具调用：参数结构与结果有效。
- 生图：请求 `req-6dabf920-9823-4d12-9df9-0b0ba7dc0d0d`，
  `openai-api / gpt-image-2 / ok`，响应为有效 JPEG。
- 公网健康状态：`ready / r760-loopback`。
- Gateway：`healthy`，重启计数 0，镜像 revision 与发布版本一致。
- Gateway DB：schema 27、`integrity_check=ok`、外键违规 0、过期预留 0。
- Research 与 `qwen38-fp8-local` 容器在切换中保持不变。
- 临时验收凭证均已撤销，撤销后访问返回 401；日志未出现凭证或测试提示词。

## 代码与验证

- `5ab9502`：增加天宽专用 runtime、provider 归因和双成员配置。
- `992bc98`：将 `gpt-image-2` 设为首选并增加真实生图验收。
- `643235f`：修正在线切换审计，允许正常的进行中 token 预留。
- `35a56cf`：提高 GLM 验收输出上限，并确保 smoke 失败能传递给部署脚本。
- TypeScript 类型检查通过。
- 全量测试：52 个文件通过、1 个跳过；858 个测试通过、3 个跳过。
- `git diff --check` 通过；部署和 smoke 脚本经 R760 `sh -n` 检查。

OpenAI 官方模型说明：
[GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)。
