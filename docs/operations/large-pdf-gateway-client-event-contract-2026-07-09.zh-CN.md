# 大 PDF 诊断字段契约

日期：2026-07-09

本文记录 Desktop 客户端与 Codex Gateway 在大 PDF 排查中的最小配合字段。目标是提升可观测性，不通过 Gateway 存储或解析 PDF 正文。

## client_message.v1 attachments

Gateway 会保留以下附件 metadata 字段：

- `type`
- `filename`
- `mime`
- `size`
- `pages`
- `sha256_prefix`
- `source_kind`
- `extracted_chars`
- `extracted_bytes`
- `chunk_count`
- `parser`
- `ocr_used`

约束：

- `filename` 只能是文件名，不能包含路径分隔符。
- `sha256_prefix` 必须是 8-64 位十六进制字符；Gateway 会规范成小写。
- `source_kind`、`parser` 只能包含字母、数字、点、下划线或连字符。
- `pages`、`size`、`extracted_chars`、`extracted_bytes`、`chunk_count` 必须是非负整数；`pages` 从 1 开始。

Gateway 继续拒绝以下附件字段：

- `content`
- `data`
- `data_url`
- `base64`
- `text`
- `path`
- `file_path`
- `filepath`
- `local_path`
- `localpath`
- `url`
- `uri`

客户端不要把 PDF 正文、base64 data URL、本地完整路径、用户文本片段放进 `attachments`。

## client_diagnostic.v1 metadata.request_shape

Gateway 会原样保留脱敏后的 diagnostic metadata，并在 admin CLI 输出中平铺以下 `request_shape` 字段：

- `pdf_count`
- `pdf_total_bytes`
- `pdf_max_bytes`
- `file_total_bytes`
- `media_base64_bytes`
- `estimated_prompt_tokens`
- `tools_schema_bytes`
- `pdf_context_overflow`

这些字段可以放在 `metadata.request_shape` 根部；Gateway 查询也兼容 `request_shape.request`、`request_shape.request.body`、`request_shape.request.prompt` 下的同名数字/布尔字段。

## Admin CLI 查询

`client-messages` 现在会输出：

- `attachments_count`
- `pdf_attachment_count`
- `pdf_total_bytes`
- `pdf_max_bytes`
- `pdf_total_pages`
- `pdf_max_pages`
- `pdf_extracted_chars`
- `pdf_chunk_count`

`client-diagnostics` 现在会输出：

- `request_shape_pdf_count`
- `request_shape_pdf_total_bytes`
- `request_shape_pdf_max_bytes`
- `request_shape_file_total_bytes`
- `request_shape_media_base64_bytes`
- `request_shape_estimated_prompt_tokens`
- `request_shape_tools_schema_bytes`
- `request_shape_pdf_context_overflow`

## 边界

本次 Gateway 改动只解决诊断可见性和错误提示，不解决大 PDF 处理本身。真正避免 `context_length_exceeded` 仍需要客户端在发送模型请求前做大 PDF guard、本地抽取/分块、历史 PDF 去重和输出预算控制。
