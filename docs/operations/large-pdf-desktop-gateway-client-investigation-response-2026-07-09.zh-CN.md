# 大 PDF 读取失败：客户端代码核查回复

日期：2026-07-09

本文回复 `large-pdf-desktop-gateway-client-investigation-2026-07-09.zh-CN.md` 中的客户端侧调查请求。核查范围为当前 `dev` 工作区代码，不包含对用户本机 PDF 文件本体的复现。

## 结论

Gateway 侧结论成立：样本失败更符合 `context_length_exceeded`，不是 Gateway 健康、鉴权、限流或上游 reauth 问题。

客户端代码中存在一个足以解释该现象的路径：普通聊天里的本地 PDF 会被转换成完整 `data:application/pdf;base64,...` 文件附件，然后随正常 `messages` 发给 MedCode/Gateway。普通“解读/总结 PDF”路径没有先做本地文本抽取、分块、检索或摘要；这些能力目前主要存在于 PDF 翻译导出 DOCX 的结构化工作流里。

因此，同一份大 PDF 在长会话或多次重试中，容易让首轮或后续模型请求超出上下文窗口。当前 8 MB PDF 保留/剔除逻辑只在 compaction overflow replay 中生效，不能保护第一次大 PDF 请求。

需要特别修正一个容易误导的表述：这不是“MedCode Max 模型弱于用户直连模型”。如果 Max 背后同样是 GPT-5.5，则更合理的判断是：同一个强模型在两条调用路径里收到的输入形态不同。直连 provider/model 可能使用厂商原生文件/PDF 接口、服务端文件引用、缓存或更贴近模型原生能力的附件协议；当前 Gateway-backed MedCode 路径则更像把整份 PDF 作为 chat messages 里的大附件发送，并叠加历史重放和较大的输出预算预留。因此用户感知到的是 Gateway-backed 路径在大 PDF 普通解读场景下发生“有效能力退化”，而不是底层模型本身不够强。

同时，不应写成“原版 OpenCode 已有本地大 PDF 分块能力，我们定制后丢失了”。本地对照 `upstream/dev` 后，原版 `read` 对 PDF 也是读取整文件并返回 `data:${mime};base64,...` 附件。当前证据只能说明：我们的 fork 额外实现了 PDF 本地抽取/分块能力，但它主要挂在 PDF 翻译导出 DOCX 工作流，没有接入普通 PDF 解读/总结路径。

## 关键证据

1. Desktop 会把提示词中的本地 PDF 路径识别成 `file://` 文件 part。

   - `packages/app/src/components/prompt-input/build-request-parts.ts:60`：`.pdf` 映射为 `application/pdf`。
   - `packages/app/src/components/prompt-input/build-request-parts.ts:127`：`locals()` 从普通文本中识别本地 PDF 路径并 attach。
   - `packages/app/src/components/prompt-input/build-request-parts.ts:333`：`buildRequestParts()` 会把 `local` PDF parts 放入请求。

2. 简单 PDF 解读/总结不会进入 PDF 翻译导出分支，而是走普通 prompt。

   - `packages/app/src/components/prompt-input/submit.test.ts:586` 的测试名是 `keeps simple PDF summary prompts on normal prompt path`。
   - 该测试断言简单 PDF 总结不调用 `exportDocument`，而是发送普通 prompt，并携带 PDF file part。

3. 普通 prompt 保存用户消息时，会把本地 PDF 文件读成完整 base64 data URL。

   - `packages/opencode/src/session/prompt.ts:1290-1306`：对非 text/plain、非目录的 `file://` part 记录读取时间后，直接 `fsys.readFile(filepath)`。
   - `packages/opencode/src/session/prompt.ts:1303`：生成 `type: "file"`。
   - `packages/opencode/src/session/prompt.ts:1305`：URL 是 `data:${part.mime};base64,...`。

   这段代码的 synthetic 文本写着 `Called the Read tool`，但对 PDF 不是按页/按 chunk 读取正文，而是将整份文件编码成附件。

4. 正常模型请求不会 strip PDF media。

   - `packages/opencode/src/session/prompt.ts:2006`：普通 agent loop 调用 `MessageV2.toModelMessagesEffect(msgs, model)`，未传 `stripMedia`。
   - `packages/opencode/src/session/message-v2.ts:696`：非 text/plain 文件会进入模型消息。
   - `packages/opencode/src/session/message-v2.ts:703`：文件 part 以 `{ type: "file", url, mediaType, filename }` 发送。
   - `packages/opencode/src/session/llm.ts:455-459`：实际 provider 请求前还会经过 `ProviderTransform.message(...)`。
   - `packages/opencode/src/provider/transform.ts:243-274`：如果模型不支持该 modality，会把 file/image part 改写成文本错误提示。

   所以要区分两层：`message-v2` 的模型消息中会保留 PDF file part；实际 provider-bound request 还有一层 capability transform。文档中的“大 PDF 问题”主要发生在支持 PDF 的 Max 路径，因为它不会被 capability transform 拦截。

5. compaction 的 PDF 限制只保护 overflow replay，不保护首轮请求。

   - `packages/opencode/src/session/compaction.ts:24`：`PDF_LIMIT = 8 * 1024 * 1024`。
   - `packages/opencode/src/session/compaction.ts:72`：`media()` 仅在 compaction/replay 处理 part。
   - `packages/opencode/src/session/compaction.ts:268`：compaction 摘要请求使用 `stripMedia: true`。
   - `packages/opencode/src/session/compaction.ts:346`：overflow replay 才按 `media(part, mdl)` 决定保留或替换 PDF。

6. 预检 token 估算可能低估含 PDF 请求。

   - `packages/opencode/src/session/llm.ts:72`：`media()` 会把 `data:*;base64,...` 替换成 `[Attached mime size bytes]`。
   - `packages/opencode/src/session/llm.ts:79`：估算使用替换后的文本。
   - `packages/opencode/src/session/llm.ts:295`：预检在发送前执行。

   这能避免把 base64 字符串本身当作几百万 token 估算，但也意味着客户端预检不能准确模拟上游对 PDF 内容、页数或附件体积的真实计费/上下文计算。

7. 诊断能关联 turn，但缺少 PDF 体积信息。

   - `packages/opencode/src/medcode/turn.ts:145`：`request_shape` 上报 message count、content part count、attachment count、mime types 等。
   - `packages/opencode/src/medcode/turn.ts:167`：只统计 text chars，不统计 file bytes/base64 bytes。
   - `packages/opencode/src/medcode/message-upload.ts:285`：client message 附件来自 file parts。
   - `packages/opencode/src/medcode/message-upload.ts:294`：`size: part.size ?? null`，但当前 `MessageV2.FilePart` schema 没有 `size` 字段，所以 Gateway 看到 `size:null` 是预期结果。

8. 本地 PDF 文本抽取能力存在，但覆盖范围窄。

   - `packages/opencode/src/session/prompt.ts:2960`：`pdfText()` 使用 pdf.js 抽取 PDF 文本。
   - `packages/opencode/src/session/prompt.ts:3006`：单 PDF 抽取文本上限为 160,000 字符。
   - `packages/opencode/src/session/prompt.ts:3278`：PDF 翻译导出分支会抽取 PDF。
   - `packages/opencode/src/session/prompt.ts:3582`：只有 `pdfTask(...)` 成立才进入该分支。
   - `packages/opencode/test/session/prompt-effect.test.ts:1857`：PDF 翻译分支的模型请求包含抽取后的文本。
   - `packages/opencode/test/session/prompt-effect.test.ts:1858`：同一测试断言模型请求不包含 `data:application/pdf;base64`。

   这说明“客户端完全没有 PDF 抽取能力”不准确；准确说法是：普通 PDF 解读/总结路径没有使用这套抽取/分块能力。

9. 原版 OpenCode 不能作为“已有本地分块能力”的直接证据。

   - 本地 `upstream/dev:packages/opencode/src/tool/read.ts` 中，PDF 分支同样是 `fs.readFile(filepath)` 后返回 `attachments`。
   - 同一 upstream 文件中，PDF attachment URL 同样是 `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`。
   - 本地 `upstream/dev:packages/opencode/src/session/prompt.ts` 中，`file://` 文件也会被读成 `data:${mime};base64,...` file part。

   因此“用户直连原版能处理”更可能来自 provider/model 直连协议、上下文/文件处理能力、服务端缓存、输出预算或历史重放差异，而不是原版普通聊天已经做了本地 PDF chunk retrieval。

## 为什么 Gateway-backed Max 可能不如直连 provider/model

这里的“不如”指用户体验上的有效能力，不指 Max/GPT-5.5 模型本身更弱。

1. 输入封装方式不同。

   直连 provider/model 时，SDK 可能使用厂商原生 PDF 或文件接口。Gateway-backed MedCode 当前通过 OpenAI-compatible chat 路径统一转发，更容易把 PDF 表现为 messages 里的大附件，而不是可复用的服务端文件引用或原生文件处理任务。

2. 请求历史重放不同。

   普通 agent loop 每轮会把会话历史转换为模型消息。用户重复发送同一 PDF 或在长会话里继续追问时，历史中的 PDF file part 可能继续参与请求。直连路径如果有 provider 文件缓存、server-side file id 或不同的 history policy，实际输入体积可能小得多。

3. 输出预算预留不同。

   Desktop 的 MedCode Max 配置为较大的输出上限。大输出预算对长文生成有利，但在普通 PDF 解读中会压缩可用输入空间。直连 provider/model 如果默认输出上限更小，同一 PDF 更可能留出足够输入窗口。

4. Gateway 无法访问本地路径。

   Gateway 只能看到客户端发来的 messages、附件和脱敏 diagnostics，不能读取 `C:\...` 本地文件，也不能自行把本地 PDF 分块。是否稳健处理大 PDF，必须在 Desktop/opencode 客户端侧先完成。

5. 缺少附件体积诊断。

   当前 Gateway 看到的 PDF metadata 里 `size:null`，无法在请求进入上游前判断“这是一份过大的 PDF”还是“普通长历史”。这使得降级策略和用户提示都滞后。

## 对原调查问题的逐项回答

1. Provider 路径是否改变了文件处理方式？

   当前定制 Desktop + MedCode/Gateway 的普通聊天路径确实依赖模型原生 PDF 附件输入，而不是本地 PDF 分块读取后只发送相关片段。但这不应解释为“原版 OpenCode 已有普通 PDF 本地分块能力”。本地 upstream 对照显示，原版普通 PDF read 也会生成完整 base64 附件。更准确的差异是：直连 provider/model 可能更好地承载这种附件输入，而 Gateway-backed 路径在同样输入形态下更容易触发上下文限制。

2. `/v1/chat/completions` 请求体是否过大？

   高概率是。客户端会发送完整 PDF data URL/file part，Gateway 上游返回 `context_length_exceeded`。当前客户端 `request_shape` 没有记录 PDF byte/page/extracted chars，无法从现有诊断中量化到底是哪一份 PDF 或历史累计导致溢出。

3. 历史裁剪和 tool result 回放是否存在风险？

   存在。普通 loop 每轮从 `MessageV2.filterCompactedEffect(sessionID)` 取历史，再转换成模型消息。失败 assistant 会被跳过，但用户消息中的 PDF file parts 会留在历史里。用户多次重复同一 PDF 请求时，后续请求可能包含多个历史 PDF 附件。

4. `attachments[].size` 为什么是空？

   因为 file part schema 和构造路径没有填 `size`。上报层写了 `part.size ?? null`，但上游 part 没有该字段。

5. PDF 提取策略是否有上限和降级？

   PDF 翻译 DOCX 工作流有：默认最多 40 页、抽取文本最多 160,000 字符、chunk 化后逐段模型调用。普通 PDF 解读/总结路径目前没有等价的页数、字节、字符、chunk 或摘要上限，主要依赖模型原生 PDF 输入和后续 compaction。

6. 是否仍建议做原版 OpenCode A/B？

   建议做，但它不应阻塞修复。当前客户端代码已经能解释失败机制。A/B 的价值是量化差异：直连 provider 是否使用不同的 provider attachment handling、服务端文件引用/缓存、输出 token 默认值、history policy 或请求体序列化方式。

7. 错误处理是否足够？

   基础识别已存在：`context_length_exceeded` 会映射成 `ContextOverflowError`，Desktop 也有中文提示。缺口是提示不区分“普通长历史”和“大 PDF 附件导致上下文过大”，也没有自动改用本地抽取/分块或阻止原样重试。

## 建议修复方案

### 客户端/Gateway 改动边界

核心修复可以在客户端闭环：P1 大 PDF guard、P2 本地抽取/分块、P3 历史去重、P4 UI 降级提示、P5 输出预算分场景控制，都不依赖 Gateway 代码改动即可解决用户这次失败路径。因为根因是客户端把大 PDF 原样作为普通模型消息附件送出；只要客户端在送出前完成拦截、抽取、去重和预算控制，就能避免同类 `context_length_exceeded`。

有三处需要 Gateway 配合或确认，但它们不阻塞本地方案：

1. P0 诊断增强需要确认 Gateway 是否能接收新字段。

   客户端可以把 `size`、`pdf_total_bytes`、`pdf_max_bytes` 等新字段加进 `client_message.v1` 的 `attachments_json` 和 `request_shape`。这些数据是否最终落库，取决于 Gateway ingestion 是宽松保存 JSON，还是严格校验 schema。如果 Gateway 严格校验，新字段可能被丢弃，极端情况下也可能拒收整条诊断事件，需要 Gateway 侧放行。即使 Gateway 暂不配合，受影响的是可观测性，P1/P2 的修复效果不受影响。

2. P1 阈值校准需要 Gateway 提供真实承载数据。

   单 PDF 8 MB、单请求总 PDF 12 MB 只是初始保守阈值。最终阈值要结合 Gateway/上游模型对不同页数、文本密度、扫描件和表格型 PDF 的真实 context 消耗来校准。这是数据配合，不是代码依赖；客户端可以先按保守阈值上线，再按 Gateway 观测结果调整。

3. P6 原生文件接口完全依赖 Gateway。

   如果选择“Desktop 上传 PDF 到 Gateway，换取短期 file id，再由 Gateway 管理文件生命周期”的路线，需要 Gateway 侧提供文件接口、存储、安全删除和上游 file id 转发能力。该路线属于并行调研项，不阻塞 P1/P2 的本地抽取/分块方案。

### P0：补可观测性和复现材料

先做低风险诊断增强，不改变用户工作流：

- 在 file part 中补充脱敏 metadata：`size`、`mime`、`filename`、`source_kind`、可选 `sha256_prefix`，不要上传本地完整路径或 PDF 正文。
- 在 `MedcodeTurn.request()` 的 `request_shape` 中增加：
  - `pdf_count`
  - `pdf_total_bytes`
  - `pdf_max_bytes`
  - `file_total_bytes`
  - `media_base64_bytes`
  - `estimated_prompt_tokens`
  - `tools_schema_bytes`
- 对 `context_length_exceeded` 且当前/历史请求含 PDF 的场景，上报 `pdf_context_overflow: true`。

具体落点：

- `MessageV2.FilePart` schema 增加可选 `size`、`hash`、`source_kind`、`metadata` 字段。
- `build-request-parts.ts` 对本地 path 场景尽量填 `source_kind: "local_path"`；拖拽/data URL 场景填 `source_kind: "data_url"`。
- `prompt.ts` 读取 `file://` 前后记录 `stat.size`，不记录完整路径。
- `MedcodeTurn.request()` 在 `scan()` 中识别 file/pdf part，统计 data URL 解码后的字节数。

### P1：普通聊天路径增加大 PDF guard

在 PDF 被转成 base64 data URL 前做大小检查：

- 对 `file://` PDF 用 `stat.size` 判断。
- 对 `data:` PDF 从 base64 长度计算字节数。
- 超过阈值时不要直接发送完整 PDF 附件。
- 用户提示改为明确动作：新开会话、拆分 PDF、选择“本地解析/分块阅读”，或让系统自动进入本地分块模式。

阈值建议先保守设置，例如单 PDF 8 MB、单请求总 PDF 12 MB；最终阈值以 Gateway/上游真实可承载能力校准。

字节阈值只能作为一级近似：上游 context 消耗还取决于页数、文本密度、表格/图片结构和上游 PDF 解析策略。8 MB 扫描版和 2 MB 文本密集版的 token 压力可能倒挂。因此 guard 命中后仍要保留 `context_length_exceeded` 的兜底处理，不能假设字节阈值能拦住所有溢出。

策略建议：

- 小 PDF：保留现有原生 PDF 附件路径，避免改变用户习惯。
- 大 PDF：默认切到本地抽取/分块，不再发送完整 PDF base64。
- 无法抽取文本的 PDF：不要继续原样发送大附件，提示用户该 PDF 可能是扫描版，需要 OCR、拆分页面或改用图片页分析。
- 重试同一请求时：如果上一轮因 `context_length_exceeded` 失败，禁止原样 retry，必须先 strip PDF 或进入分块模式。

### P2：把 PDF 本地抽取能力复用到普通解读路径

将 `prompt.ts` 里的 `pdfText()`、清洗、分页和 chunk 逻辑抽到共享模块，例如 `packages/opencode/src/pdf/text.ts`，供两个路径共用：

- PDF 翻译导出 DOCX：继续使用现有分块翻译能力。
- 普通“解读/总结 PDF”：先本地抽取文本，按页/章节 chunk，发送摘要或与问题相关的 chunk，而不是发送完整 PDF base64。

普通解读的推荐流程：

1. 抽取 PDF 元数据和文本：文件大小、页数、抽取字符数、是否无可抽取文本。
2. 清理页眉页脚、页码、参考文献等噪声。
3. 生成 chunk map：每 chunk 约 4k-6k 字符，带页码/标题/anchor。
4. 首轮解读只发送结构化 source map 和必要 chunk；超大 PDF 先做局部摘要或要求用户选择章节。
5. 后续追问按 chunk 检索，不重复发送整份 PDF。

建议接口形态：

- `pdfInfo(part)`：返回 `filename`、`bytes`、`hash`、`source_kind`。
- `pdfExtract(part, opts)`：返回 `pages`、`text`、`warnings`。
- `pdfChunks(text, opts)`：返回 chunk 列表，每个 chunk 带 `index`、`scope`、`page_start`、`page_end`、`heading`、`anchors`、`text`。
- `pdfPrompt(req, chunks)`：根据用户问题选择 chunk；普通“解读全文”先发摘要用 chunk map，后续再按需展开。

普通聊天接入点建议放在用户消息创建前：当 `input.parts` 中存在 PDF 且满足 MedCode/Gateway 或大文件阈值时，把 PDF part 转换为 synthetic text parts 和轻量 metadata part，避免后续 `toModelMessagesEffect()` 看到完整 PDF data URL。

### P3：历史去重和 compaction 前置

普通模型请求前增加 PDF 历史治理：

- 同一 session 中按 `source path` 或内容 hash 去重 PDF 附件。
- 当前轮已处理/抽取的 PDF，在历史里替换为 `[Attached application/pdf: filename, extracted locally]`。
- 对历史中的旧 PDF data URL，默认 strip，除非当前用户明确要求再次查看原附件。
- overflow 之后自动继续前，先替换或摘要 PDF 附件，避免原样 retry。

去重规则建议：

- 优先用内容 hash。
- 无 hash 时用 `filename + size + source_kind`。
- 同一 hash 在同一 session 中只允许一个“当前活跃 PDF source record”。
- 历史消息里的旧 PDF file part 改写为摘要占位，保留 filename、size、hash prefix、chunk count，去掉 base64。

### P4：UI/交互降级

Desktop UI 层建议补：

- PDF 附件显示文件大小。
- 大 PDF 发送前提示“将使用本地解析/分块阅读”。
- 拖拽 PDF 时优先保留本地文件路径和 size；不要无条件把大 PDF 读成 base64 放入 prompt state。若浏览器安全限制无法拿到路径，也要在 data URL 路径上执行大小阈值和降级。
- 扫描版/无文本 PDF 给出明确提示：需要 OCR 或拆分页面。

### P5：普通聊天降低默认输出预算

这不是根因修复，但能减少误触发 context overflow。

- 普通问答/解读场景默认输出上限建议为 16k 或 32k。
- 导出、长文生成、翻译 DOCX 等明确长输出场景再提升到 64k/128k。
- 如果通过 `chat.params` 或 agent/model variant 控制，需确保只影响普通聊天，不影响已有导出工作流。

### P6：评估 Gateway 是否支持原生文件接口

如果 MedCode Gateway 能安全暴露 GPT-5.5 的原生文件能力，可考虑比本地抽取更透明的方案：

- Desktop 先上传 PDF 到 Gateway 文件接口，拿到短期 file id。
- 后续 messages 只引用 file id，不重复发送 base64。
- Gateway 侧负责文件生命周期、大小限制、加密和删除。
- client-events/diagnostics 仍只记录脱敏 metadata，不记录正文。

如果短期没有文件接口，P1/P2 的本地抽取/分块仍是最稳妥路径。

## 验证计划

1. 单元测试：

- `build-request-parts`：本地 PDF path 生成 file part 时带 size metadata。
- `message-v2` 或新 PDF 模块：大 PDF 被替换为本地抽取文本或 placeholder，不进入普通模型请求。
- `medcode/turn`：`request_shape` 含 PDF 字节统计且不泄漏正文/base64/本地路径。
- `prompt-effect`：简单 PDF 解读不再发送 `data:application/pdf;base64`，而发送抽取后的 chunk/source map。
- compaction：历史重复 PDF 被去重或替换。
- `llm` 或 provider request 测试：普通 PDF 解读场景的 `messages` 中不含超过阈值的 PDF data URL。

2. 手工复现：

- 用样本类型请求：`<用户桌面路径>\NEJMclde2600182.pdf，请解读该篇文献`。
- 对比修复前后第一轮 Gateway `request_shape`：
  - PDF base64 是否消失。
  - prompt chars/tokens 是否下降。
  - `pdf_total_bytes`、`extracted_chars`、`chunk_count` 是否可见。
- 长历史中重复发送同一 PDF，确认后续请求不会累积多个完整 PDF 附件。

3. 回归验证：

- PDF 翻译 DOCX 既有 workflow 保持通过。
- 小 PDF / 图片附件仍能按模型支持能力发送。
- 非 `max` tier 等不支持 PDF 的模型在 provider-bound request 中仍不会收到 PDF 原生附件；如果中间诊断统计的是 transform 前消息，应明确标注为 pre-transform shape。
- `context_length_exceeded` 错误仍能映射为用户可读提示。
- Max/GPT-5.5 普通聊天仍可处理小 PDF 原生附件；大 PDF 自动走本地分块。

## 风险和兼容性

- 改用本地抽取会改变普通 PDF 解读的输入形态：模型看到的是提取文本/chunk，而不是原生 PDF 附件。对文本型论文这是正向变化；对扫描版 PDF、复杂图表、版式依赖强的文档，需要 OCR 或图片页截图补充。
- 大 PDF guard 可能让少数本来可由 `max` 原生 PDF 能力处理的文件改走本地抽取。建议先只对超过阈值的 PDF 生效，小 PDF 保持原使用习惯。
- 诊断 metadata 必须严格脱敏：只上传 size/count/hash prefix/类型，不上传本地完整路径、正文、base64 或 API key。

## 建议排期

- 当天：P0 诊断增强 + P1 大 PDF guard。
- 1-2 天：P2 抽出共享 PDF 文本抽取模块，并接入普通解读/总结路径。
- 之后：P3 历史去重与 replay 治理，P4 UI 体验完善，P5 输出预算分场景控制。
- 并行调研：P6 Gateway 原生文件接口可行性；若不可行，不阻塞本地抽取/分块方案。

这套方案能把问题从“远端 Gateway 收到一整份未知体积 PDF 后才爆 context”改成“客户端先知道 PDF 体积和抽取规模，按可控 chunk 发送，超限前就降级或提示”。
