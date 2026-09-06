# LLaDA 首选生图链路发布记录（2026-09-06）

## 结果

- 公网客户端模型保持 `medcode-image-default` 不变。
- 首选上游改为外部 API `llada-image-turbo-fp8`，事件归因为
  `provider=llada-image`。
- 原 `gpt-image-2` 凭据保留为第一后备；既有后备链路继续保留。
- LLaDA 的限流、服务错误、超时或无效凭据可在尚未向客户端返回内容时触发后备；
  参数错误和内容策略拒绝不会被误重试。
- Gateway 把客户端的压缩度转换为 LLaDA 合同中的质量值，并校验上游声明的
  `output_format` 与 `mime_type`。即使旧响应返回 PNG，也会在 Gateway 转码为客户端
  请求的 JPEG/WebP，防止 MIME 与文件内容不一致。

LLaDA 只按公网 API 合同作为外部服务消费；Gateway 不依赖或推断其部署服务器。

## 生产发布

- R760 `current`：`b641ebbcc02b616726909fac4bda8ee9e4901981`
- R760 `previous`：`643235f8b9651ba099b8b48b6453097e16846034`
- 备份：
  `/data/codex-gateway-r760/backups/pre-llada-image-primary-20260906T023043Z`
- 仅 Gateway 容器被重建；Research Worker、Research LLM Gateway、Research
  maintenance 和 `qwen38-fp8-local` 保持原容器。
- 非 `MEDCODE_IMAGE_*` 配置在候选配置与原配置之间哈希一致。

## 验收证据

- 公网生图请求：`req-b08aaffa-8088-4ef2-9741-7d0ba8486dc0`
  - `llada-image / llada-image-turbo-fp8 / ok`
  - 13,956 ms；客户端端到端测量 14,048 ms
  - 返回 MIME 为 `image/jpeg`，Base64 解码后 JPEG 文件头与文件尾有效
- 公网文本控制请求：`req-f6a313a6-989a-4c03-a689-5323b9eec8b2`
  - `tiankuan / official/glm-5.3 / ok`
  - 1,171 ms
- 临时验收凭据已撤销，撤销后模型访问返回 401；Gateway 日志未出现临时凭据或
  测试提示词。
- 公网健康：`ready / r760-loopback`
- Gateway：`healthy`，重启计数 0，镜像 revision 与发布版本一致。
- Gateway DB：schema 27、`integrity_check=ok`、外键违规 0、过期预留 0。

## 代码验证与保护闸门

- TypeScript 类型检查通过。
- 全量测试：52 个文件通过、1 个跳过；863 项通过、3 项跳过。
- LLaDA/Gateway 相关测试：215 项通过。
- `git diff --check` 与 Linux `sh -n` 通过。
- 首次实际切换因天宽已有 HTTP 402 触发冷却，严格双成员 smoke 未满足而自动回滚；
  后续验收改为同时验证非生图配置哈希不变、任一健康 GLM 成员公网文本成功，以及
  LLaDA 生图的精确 provider/model/JPEG 合同。最终发布全部通过。
