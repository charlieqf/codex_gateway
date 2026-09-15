# GoldenCode 受限写入恢复：Gateway 对 Desktop 第二轮评审的回执（R3）

日期：2026-09-15。状态：**接受第二轮意见，A/S 首期开发契约按本回执及 R3 附件冻结；业务实现、联合验收和生产启用尚未完成。** B/C 继续独立交付，不再将已达成共识的架构重新列为待确认项。开发排期与生产性能配置不在本次冻结范围内。

对应 [Desktop R2 回执](../../../medevidence-opencode-stable/docs/outbox/goldencode-bounded-write-client-review-r2-2026-09-15.zh-CN.md)。本轮完成了请求声明修订、三个可复现缺口修复及复测，满足该回执提出的开发契约冻结条件。

## 请求声明及检查入口

采纳 SDK 本地注册、`activeTools` 排除接收器的方案。接收器仅在 `session/llm.ts` SDK 调用边界注册；HTTP `request_body.tools` 只包含原普通工具，普通工具选择、顺序、预算和 tool_choice 不变。原 write 未启用、tool_choice 不允许、保留名冲突或 runtime 未验收时，不声明 S。

新增 `X-MedCode-Write-Delivery-Schema-SHA256`，值为固定 schema 文件**原始 UTF-8 字节**的摘要：

```text
57b561afab26d73faa7f91908d35195767162fa3cc734ab547faf02b5df9fa11
```

Gateway 以 version + SHA 查有限的内置协议 schema 注册表；未知摘要不接受 S，普通请求照常处理。不传完整 schema header、不新增 body 字段、不增加能力探测模型请求。固定 schema 保持 R2 原始字节，包括其说明注释；R3 目录增加 `.gitattributes -text` 防止检出时转换换行。此摘要不同于每次响应原始 arguments 的摘要。

[R3 请求示例](../../artifacts/write-delivery-contract-r3-2026-09-15/success.example.json)已拆分 `sdk_registered_tools`、`sdk_active_tools`、`request_body.tools`，另列[协议 schema 注册表](../../artifacts/write-delivery-contract-r3-2026-09-15/schema-registry.json)及请求/响应/信任上下文。

检查入口固定为最终实际模型 HTTP 响应进入 `MedcodeStream.stream` 及任何合并、丢弃、提前释放数据的转换**之前**。每次实际模型 HTTP（包括刷新凭据后的重发）生成新 nonce，校验最终可信 origin、主体、session/turn、nonce、实际 `X-Request-Id`、接受版本/能力/有效 limits、原始 arguments 摘要。无 manifest 保留原流；有非法 manifest 在消费 body 前报协议错误。接收器 execute 再核对已验证请求上下文，通用工具纠错、大小写修复、普通 write 回退都不能绕过此边界。native 未单独验收不声明 S。

## 三个缺口及复测

| Desktop 反例 | R3 处理与结果 |
| --- | --- |
| arguments 前置 8,388,608 个空格并重算合法 hash | 原始 arguments 实际 8,389,074 字节，SSE 8,390,022 字节；在 JSON.parse 前按累积的真实 UTF-8 字节拒绝，不使用紧凑重新序列化大小替代 |
| manifest.request_id 不同于 HTTP X-Request-Id | 验证入口接收实际请求/响应上下文；在读取 body 前拒绝 |
| 同一事件含两个 index=0 choices | 验证每事件唯一 choice；明确 usage-only 空 choices 的位置及唯一性，拒绝重复 choice |

[R3 校验脚本](../../artifacts/write-delivery-contract-r3-2026-09-15/verify-fixtures.mjs)通过 **60 项**检查。除上述反例，还覆盖接受上限高于请求/本地/schema、实际 payload/原始参数/响应超过较小有效上限、身份绑定、Unicode 跨 delta、无 manifest 不读取 body 等。该脚本是契约 fixture 验证器，不是生产流式适配器；生产实现仍须有界逐步读取、取消和原 deadline。

独立复跑 Desktop 提供的 SDK 脚本，并用只调整样例读取字段的临时副本验证 R3：**7 次本地 HTTP 对照通过**，请求 body 字节一致、网络 tools 只有 write/read、普通文本在 EOF 前到达、接收器执行一次并返回一个结果、未可信接收器执行零次、普通多工具保持 write/read，实际 Gateway body parser 通过。结果见[验证摘要](../../artifacts/write-delivery-contract-r3-2026-09-15/validation-summary.json)。

这些结果解决请求格式和 SDK 可行性问题；尚未覆盖真实旧 Gateway HTTP 中间件、TLS/header 信任、生产适配器、文件事务、崩溃恢复、native、混合负载或真实性能，不能作为上线验收或短任务零回归证明。

## 已接受的实现边界

- S 在原一次普通 write 成功前提交，保留 mode/chunk 省略语义；原中间块完成不新增整文件完成标识，不要求 done。
- 独立每文件事务，除 delivery 身份外还约束真实本地工具记录；持久化接受、暂存、替换意图/确定目标摘要/结果收据、替换、committed、工具结果。提交后落库前崩溃恢复同一结果，避免重复 append。
- BOM/格式化进入 journal 覆盖范围；LSP/通知失败不等于文件未提交。Windows 外部编辑竞争与断电持久性只承诺实际实现并验收的保证。
- 网络用原绝对期限；本地权限沿用 SessionTools ask/wait/暂停计时，提交遵守本地取消与工具限制。不新增统一 120 秒权限期限或失败后模型调用。
- 本地保存真实调用/结果；在 `convertToModelMessages` 前把已验证的整对记录转换为有界状态摘要，覆盖未完成、失败、取消和恢复，不重复回传巨大封装或保留工具到旧 Gateway。
- 首期仅 A 明确内容长度错误 + S 完整结果交付；合规 write、普通非长度纠错保持原行为，B/C 关闭。候选 limits 可用于开发和测试，性能配置须经实测。

后续按[协议说明](../coordination/goldencode-write-delivery-v1-contract-draft-2026-09-15.zh-CN.md)及[回归矩阵](../coordination/goldencode-write-delivery-short-task-regression-gates-2026-09-15.zh-CN.md)分别实现和联合验收。此文件供转交客户端团队；本次没有向外发送消息、提交发布或启用生产开关。
