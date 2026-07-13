# 大 PDF 读取失败：Desktop + Gateway 客户端侧调查说明

日期：2026-07-09

本文用于转交 OpenCode Desktop / MedEvidence Desktop 客户端团队，说明近期用户反馈“大 PDF 文件读取和处理有问题”的 Gateway 侧排查结果，以及需要客户端团队继续调查的问题。

## 背景

用户反馈：使用原版 OpenCode 加自己的 LLM 订阅时，能够处理同一类 PDF；使用我们定制开发的 Desktop 加 Azure Gateway 时，会出现 PDF 读取或处理失败。

需要先区分两条路径：

- 原版 OpenCode：本机 agent 可直接访问用户电脑上的 PDF 路径，通常可通过本地工具分段读取、转换、检索，再把必要片段交给模型。
- 定制 Desktop + Gateway：Desktop 通过 `/v1/chat/completions` 调用远端 Azure Gateway。Gateway 在 Azure VM 上，不能访问用户本机的 `C:\...` 或 `E:\...` 文件路径，只能处理 Desktop 发来的 messages、tool result、工具 schema 和附件 metadata。

因此，即使 Desktop 基于 OpenCode 增量开发，只要 provider/agent 调用路径切换为 Gateway，就可能改变原版 OpenCode 的本地文件读取、分块、历史裁剪和 tool result 回放行为。

## Gateway 侧已确认事实

1. Azure Gateway 当前健康。

   - Gateway 容器 `codex_gateway_test-gateway-1` 为 healthy。
   - 端口形态仍为 `127.0.0.1:18787->8787`，Nginx 仍是公网 `80/443` 边缘。
   - 本次没有看到 gateway 容器故障、Nginx 故障、API key 失效或上游账号 reauth 类证据。

2. 最近 7 天内存在 PDF 相关请求。

   - 查询窗口：`2026-07-02T00:00:00.000Z` 起。
   - Desktop client message 中约 828 条消息里，筛到 25 条 PDF 相关请求。
   - 相关请求包括“解读该篇文献”“浏览文件夹内的 pdf”“读取这些 PDF 或 excel”“4 个文件转化成了 PDF”等。

3. 明确失败的 PDF 读取请求集中在上下文窗口溢出。

   典型失败样本：

   - 用户标签：王伊莲
   - 时间：`2026-07-08 11:22-11:33 Australia/Sydney`
   - 文件：`NEJMclde2600182.pdf`
   - 用户请求示例：`C:\Users\Elainewang1\Desktop\公众号供稿\NEJMclde2600182.pdf，请解读该篇文献`
   - Desktop message ids：
     - `msg_f3f51b51c002npNonylmuEAGT5`
     - `msg_f3f51f6fd002wfNG20B9edOXMF`
     - `msg_f3f5260dd002YFmFBBRaiZoSP3`
     - `msg_f3f5b789e002msuKNL6lYloixf`
   - Gateway model request ids：
     - `req-56114cc7-a25b-4b6a-90e1-2b5019184dd6`
     - `req-4e5f81be-d2e4-4619-92e3-2acbb98aaa4e`
     - `req-6b2d777a-b9f6-4e05-92f0-98bda6db2f93`
     - `req-ae2b1368-f76f-4988-9bfc-a604f6668dda`
     - `req-0aeddbd9-f06f-498c-aa91-c9096a5688b0`
     - `req-32c22cc9-0a04-48ec-9298-7cc33fb981fd`
     - `req-23e38075-442c-41e9-ace5-c342e4199835`
     - `req-1ae7e4ca-edb4-4a04-ba00-caf1c4643f2a`
   - request_events 结果：上述请求均为 `status=error`，`error_code=context_length_exceeded`。
   - 容器日志中的上游归一化错误：
     - `public_message`: `Current conversation is too long. Start a new conversation or clear earlier history before retrying.`
     - `raw_message`: `Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.`

4. Desktop 侧诊断也记录了同类错误。

   例如 `msg_f3f51b51c002npNonylmuEAGT5` 对应诊断：

   - `category=provider_stream`, `action=request`, `status=error`
   - `category=agent_turn`, `action=turn`, `status=error`
   - `error_message=Current conversation is too long. Start a new conversation or clear earlier history before retrying.`

5. 并非所有 PDF 请求都失败。

   同日另有与 PDF/标书相关的请求成功，例如：

   - 用户标签：王文晟
   - 时间：`2026-07-08 11:44-12:40 Australia/Sydney`
   - 内容涉及“4 个文件转化成 PDF”“只读取两个 PDF”“重新绘制机制图”等。
   - 部分请求成功，最高观察到约 `39k` prompt tokens、约 `39.5k` total tokens。

   这说明问题更像是上下文管理/输入体积问题，不是“Gateway 完全不能处理 PDF”。

6. Gateway 看到的 PDF 附件信息很有限。

   在 `client_message_events.attachments_json` 中，PDF 附件一般只有 metadata，例如：

   ```json
   {
     "type": "file",
     "filename": "NEJMclde2600182.pdf",
     "mime": "application/pdf",
     "size": null
   }
   ```

   Gateway 当前没有收到 PDF 正文、页数、提取字符数、分块信息、OCR 状态或本地可读文件句柄。远端 Gateway 也不能读取用户本机路径。

## 当前判断

本次已确认的失败根因是：模型请求上下文过大，触发上游 `context_length_exceeded`。

Gateway 侧没有证据表明这是鉴权、限流、Nginx、Docker、上游账号 reauth 或 gateway 健康问题。

更可能需要客户端侧核查的是：定制 Desktop 切到 Gateway provider 后，是否仍保留了原版 OpenCode 的本地 PDF 读取、分块、摘要、检索、历史裁剪和 tool result 压缩策略。

## 需要客户端团队重点调查的问题

1. Provider 路径是否改变了 OpenCode 原有文件处理方式。

   请比较原版 OpenCode + 用户自己的 LLM 订阅，与定制 Desktop + Gateway provider 在同一个 PDF 任务中的执行路径：

   - 是否仍由本地 agent 工具读取 PDF？
   - 是否仍按页/章节/chunk 分段读取？
   - 是否仍只把相关片段发给模型？
   - 切到 Gateway provider 后，是否退化为把提取后的 PDF 全文直接放进 `messages`？
   - 本地 `Read` / PDF parser / OCR / grep / chunk retrieval 等工具是否还在同一 agent loop 内可用？

2. `/v1/chat/completions` 请求体是否过大。

   请在客户端本地记录脱敏后的请求体规模，不要记录 API key：

   - 每轮 `messages.length`
   - 每条 message 的 role、content 字符数和 UTF-8 字节数
   - 总 content 字符数和估算 token 数
   - `tools` JSON schema 字节数
   - 是否包含 PDF 提取全文
   - 是否重复包含旧的 PDF tool result
   - 是否重复包含旧的 assistant 长输出

3. 历史裁剪和 tool result 回放是否与原版不同。

   这类 PDF 任务失败常见原因是“每轮完整重放历史 + 旧 PDF 全文 + 新请求”。请核查：

   - Gateway provider 是否每轮发送完整 conversation history。
   - 是否有 max history tokens / max tool result chars / summarization policy。
   - 旧的 PDF 提取结果是否被压缩成摘要。
   - 大型 tool output 是否被保留为文件引用，而不是全文回放。
   - retry 时是否重复追加同一份 PDF 文本，造成上下文指数式变大。

4. 附件 metadata 是否完整。

   当前 Gateway 观察到部分 PDF 的 `size=null`。请核查 Desktop 上传 client message 时：

   - `attachments[].size` 为什么为空。
   - 是否可以补充 `pages`、`extracted_chars`、`extracted_bytes`、`chunk_count`、`parser`、`ocr_used` 等诊断 metadata。
   - 附件 metadata 中不要包含本地完整路径、PDF 正文、base64 或敏感内容。

5. PDF 提取策略是否有上限和降级。

   请核查客户端对大 PDF 的策略：

   - 单 PDF 最大页数/字符数限制。
   - 多 PDF 同时输入时的总字符数限制。
   - 是否先生成本地摘要或索引，再按用户问题检索相关 chunk。
   - 超出阈值时是否提示用户分章节处理，而不是继续发送超大请求。

6. 原版 OpenCode 对比实验。

   建议用同一台机器、同一个 workspace、同一个 PDF 做 A/B：

   - A：原版 OpenCode + 用户自己的 LLM 订阅。
   - B：定制 Desktop + Gateway provider。
   - 比较两边第一轮和后续轮次的：
     - 本地工具调用序列。
     - 是否读取 PDF 文件。
     - 每次发给模型的 prompt/token 规模。
     - 是否发生历史裁剪或摘要。
     - 是否有本地文件索引/缓存。

7. 错误处理和用户提示。

   当前上游错误会变成“conversation is too long”。客户端应进一步处理：

   - 识别 `context_length_exceeded` 后提示用户新开对话、拆分 PDF、按章节处理。
   - 不要自动原样 retry 超大请求。
   - 如果 retry，需要先缩短历史或改用分块摘要。

## 建议客户端收集的脱敏材料

请客户端团队在本地复现时收集以下材料，避免包含 API key、完整用户隐私文本或完整 PDF 正文：

- Desktop 版本、OpenCode fork commit、provider 配置类型。
- 用户本地 PDF 的文件大小、页数、是否扫描版、是否 OCR。
- PDF 提取后的字符数、chunk 数、每 chunk 大小。
- 触发失败那一轮的 request id、message id、turn code。
- `/v1/chat/completions` 请求体的结构化统计：
  - messages 条数
  - 每条 content 字符数
  - tools schema 字节数
  - 总估算 token
  - 是否包含历史 PDF 全文或旧 tool result
- 本地 agent 工具调用摘要：
  - 读取了哪些文件
  - 读了多少字节/页
  - 是否做了摘要、裁剪、检索

## 临时规避建议

在客户端修复前，建议支持团队对用户说明：

- 大 PDF 或多个 PDF 不要在长历史会话中继续处理，优先新开会话。
- 将 PDF 按章节、页段或主题拆分处理。
- 先让客户端/本地工具提取摘要或目录，再基于具体章节提问。
- 对多个 PDF 的任务，先逐个总结，再做跨文档综合。
- 出现 `context_length_exceeded` 后，不要直接重复发送同一请求。

## Gateway 侧可配合的后续改进

这些不是本次失败的直接根因，但可以提高可观测性和用户体验：

- 在 request_events/client diagnostics 中增加请求体规模观测字段，例如 messages count、estimated prompt chars、tools schema chars。
- 对 `context_length_exceeded` 返回更面向用户的中文提示。
- 在 Gateway 管理查询中增加按 `context_length_exceeded` 聚合的报表。
- 要求 Desktop 上传更完整但不含正文的附件统计 metadata。

Gateway 不适合直接承担用户本机 PDF 读取，因为远端 VM 无法访问本地路径，也不应让 client-events 上传 PDF 正文或 base64 到消息审计库。
