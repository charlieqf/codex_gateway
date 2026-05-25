# 王云 `MedCode service is temporarily unavailable` 排障记录

日期：2026-05-25

## 背景

用户王云反馈 Desktop 端出现：

```text
MedCode service is temporarily unavailable.
```

本次排查只执行只读操作：查询客户端消息、客户端诊断事件、
Gateway request events、公开 health、容器状态和相关容器日志。未修改
Gateway、Nginx、Docker、数据库或用户配置。

## 查询入口

最近客户端消息使用固定脚本查询：

```powershell
python scripts\query-client-messages.py --user "王云" --limit 10
```

诊断和 request events 使用生产容器内只读 admin CLI：

```bash
node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  --client-events-db /var/lib/codex-gateway/client-events.db \
  client-diagnostics --user "王云" --status error --limit 30 \
  --timezone Asia/Shanghai --include-metadata

node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  events --user medevidence-f25ba355979b4ca39545b091a2837195 --limit 30
```

## 关键发现

用户最近消息显示，报错发生在 build/PPT 任务附近：

- `2026-05-25 10:48:59 Asia/Shanghai`：用户要求调用本地 `PPT1`
  skill，制作 BMI 与心脏病患病风险相关性的课件。
- `2026-05-25 10:58:32 Asia/Shanghai`：用户再次提交同类 PPT/skill
  任务。
- `2026-05-25 11:06:21 Asia/Shanghai`：用户询问
  `MedCode service is temporarily unavailable 是什么原因`。

错误诊断中定位到两次 provider/build 失败：

| 时间 | message_id | agent | 诊断类别 | 错误 |
| --- | --- | --- | --- | --- |
| 2026-05-25 10:51:26 | `msg_e5d098644001AfnLnS4XNNsdBg` | build | `provider_stream` / `agent_turn` | `MedCode service is temporarily unavailable.` |
| 2026-05-25 10:59:03 | `msg_e5d124391001cfE0u5AorETaFG` | build | `provider_stream` / `agent_turn` | `MedCode service is temporarily unavailable.` |

Gateway request events 中对应的上游请求为：

| started_at UTC | request_id | status | error_code | estimated_tokens | rate_limited | over_request_limit |
| --- | --- | --- | --- | ---: | --- | --- |
| 2026-05-25T02:50:57Z | `req-30292b59-9e3d-4455-a01b-2b6797f0e877` | error | `service_unavailable` | 258596 | false | false |
| 2026-05-25T02:58:34Z | `req-ba916ef3-97f7-4371-b7d7-d237b4af409e` | error | `service_unavailable` | 258633 | false | false |

这说明失败不是用户 API key 失效、不是请求限流，也不是 token quota 阻断。

容器日志中同一 request id 的上游原始错误为：

```text
Codex ran out of room in the model's context window.
Start a new thread or clear earlier history before retrying.
```

Gateway 为避免暴露上游内部实现，把该错误归一化为用户可见的：

```text
MedCode service is temporarily unavailable.
```

## 当前服务状态

后续只读检查显示服务链路可用：

- `https://gw.instmarket.com.au/gateway/health` 返回 `state=ready`。
- Gateway 容器 `codex_gateway_test-gateway-1` 为 `healthy`。
- 最近真实模型请求成功，例如 `2026-05-25T03:21:56Z`
  request event 为 `status=ok`。
- 王云本人后续 research 请求在 `11:06`、`11:09`、`11:12`、`11:20`
  附近有成功 request event。

因此本次不是 Gateway 整体宕机，而是特定超长上下文请求失败。

## 原因分析

当前 OpenAI-compatible `/v1/chat/completions` 路径是 stateless 形态。
客户端每次请求会提交完整 `messages`，Gateway 将其转换为 prompt 后发给
上游，并创建临时 `sess_stateless_*` 会话。Gateway 当前会估算并记录
`estimated_tokens`，但没有在请求前自动压缩、裁剪或总结历史。

王云这两次失败请求的估算上下文约 258k tokens。PPT/skill/build 类任务
容易累积大量内容，包括本地路径、skill 指令、工具调用结果、网页抓取错误、
文件处理上下文和反复重试历史。一次性把完整历史带入新请求时，上游模型上下文
窗口装不下，于是返回 `ran out of room in the model's context window`。

“上游自动上下文压缩”没有兜住这次请求，原因是这不是一个上游长期 thread
自然变长后的压缩场景，而是下游一次性提交了一个已经过大的 stateless 请求。
上游不能安全地自动丢弃用户消息、文件内容、工具结果或任务约束；Gateway 侧
当前也没有请求前摘要/裁剪机制。

## 用户侧处理建议

可回复用户：

```text
这不是账号或服务整体故障，是当前会话上下文太长导致模型装不下。
请新建一个对话重新提交任务，或者清掉之前历史后重试。
如果是 PPT/skill 任务，建议把材料和要求拆小，不要在同一个长会话里连续反复提交。
```

对于同类 PPT/skill 任务，建议：

- 新任务使用新对话。
- 只保留必要文件路径和核心要求。
- 将素材整理、文献检索、PPT 生成拆成多个较小步骤。
- 避免在同一会话中反复粘贴长指令和长工具输出。

## 产品和工程改进建议

1. Gateway 增加请求前上下文保护。
   - 当 `estimated_tokens` 超过安全阈值时，直接返回更准确的
     `context_too_large` 或类似错误。
   - 用户文案建议明确提示“当前会话过长，请新开对话或清理历史后重试”。

2. 避免把上下文窗口错误归一化成通用 `service_unavailable`。
   - 当前文案会让用户误以为服务宕机。
   - 可以在 provider error normalize 中识别
     `ran out of room in the model's context window`。

3. Desktop 侧对 build/PPT/skill 任务做历史控制。
   - 新建任务时主动开启新 session 或减少随请求带上的历史。
   - 对工具输出、skill 文件内容和网页抓取结果做摘要缓存，而不是每轮带全文。

4. 后续如实现 Gateway 侧摘要，需要谨慎。
   - 医疗、文档生成和本地文件任务不能随意丢弃约束。
   - 更安全的第一步是“超阈值拒绝 + 明确提示”，再逐步实现可审计摘要。
