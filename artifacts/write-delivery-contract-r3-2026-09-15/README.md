# write-delivery-v1 R3 开发契约附件

本目录是 A/S 首期开发基线；R2 目录保留为历史评审输入。此处没有生产接收器或文件事务实现。

- `success.example.json` 区分 SDK 本地注册表与实际 `request_body.tools`。实际网络工具不包含接收器。
- `schema-registry.json` 和 `X-MedCode-Write-Delivery-Schema-SHA256` 绑定固定 schema 文件的原始 UTF-8 字节。
- 接收 schema SHA-256：`57b561afab26d73faa7f91908d35195767162fa3cc734ab547faf02b5df9fa11`。保留了评审时的原始字节及 R2 注释；注释不是生产状态声明。
- `.gitattributes` 禁止两个 schema 文件自动转换换行；不要格式化固定 schema 后继续沿用原摘要。
- `contract-checks.mjs` 是附件校验参考，输入完整字符串；真实适配器还必须实现有界增量网络接收、取消与业务绑定。
- `verify-fixtures.mjs`：在 Gateway 仓库根运行 `node artifacts/write-delivery-contract-r3-2026-09-15/verify-fixtures.mjs`，共 60 项协议检查。
- `validation-summary.json` 记录本轮协议检查与独立复跑的 7 次 SDK loopback HTTP 结果，含未覆盖范围。
- `build-fixtures.mjs` 读取固定 schema，向 stdout 输出其他附件的 JSON 文件映射；不自动写文件，也不重建固定 schema。

SDK 验证基于 Desktop 的 `packages/opencode/script/verify-write-delivery-r2.ts`，仅将示例读取从 `example.declared_tools[0]` 适配为 `example.request_body.tools[0]`。本轮临时适配脚本位于 Desktop 的 `packages/opencode/.tmp/verify-write-delivery-r3.ts`，没有修改原评审脚本或业务代码。
