# GoldenCode write-delivery-v1：Gateway R3 开发契约

日期：2026-09-15。状态：**已按 Desktop R2 回执修订，作为 A/S 首期开发契约冻结；业务实现、联调、性能配置及上线验收尚未完成。** 参见 [Gateway R3 回执](../outbox/goldencode-bounded-write-gateway-review-response-r3-2026-09-15.zh-CN.md)。

参见[短任务回归风险与首期发布门槛](./goldencode-write-delivery-short-task-regression-gates-2026-09-15.zh-CN.md)。首期保留普通 write 和非长度错误重试的既有行为；120 秒不作为原有 schema 修复的通用门槛。R3 已改为 SDK 本地注册、activeTools 排除接收器及 schema SHA 请求头；实际旧 HTTP 中间件、滚动/回滚和混合负载仍须实现后验收。

输入为 [Desktop 初评](../../../medevidence-opencode-stable/docs/outbox/goldencode-bounded-write-client-review-2026-09-15.zh-CN.md)及[第二轮回执](../../../medevidence-opencode-stable/docs/outbox/goldencode-bounded-write-client-review-r2-2026-09-15.zh-CN.md)。后者业务基线为 Desktop `5d910fa309b4`、Gateway `1534af7b50a2`。本轮使用实际 AI SDK 6.0.168 和合成 HTTP 验证声明及执行方式，不改变生产或业务源码。

## 评审结论与采纳

**采纳客户端的主要技术意见，无需改变“先保住已生成结果”的目标。** A 可独立减少无效重试；S 使用一个事务封装工具并在 SDK 前检查完整响应；B/C 后续单独交付。S 不等待 B 的模型逐片生成能力。

| Desktop 意见 | Gateway 接受的边界 |
| --- | --- |
| 多个普通 write 在 SDK 内可能并行，processor 介入太晚 | 采纳。固定一个 `write_delivery_v1` 封装调用；接收器仍须在 SDK 之前缓冲及校验整个响应，单个 execute 不是充分保护 |
| 一个原调用对应一个结果 | 采纳。外层调用 ID 沿用原 write 的 call ID，真实历史保存一个封装调用与一个结果、原工具映射及交付身份 |
| 普通 write 没有 done | 采纳。S 第一版不要求、也不新增 done；保持原 mode/chunk 的存在或省略语义 |
| 旧事务表只有 session+turn 唯一目标，且整轮完成才提交 | 采纳。新建每文件交付事务生命周期；仅复用校验/journal/提交原语，不伪装旧 recovery_count=1 |
| 新工具参数不能自证来自 Gateway | 采纳。新增每请求 nonce 与 Gateway 响应头清单，清单绑定精确封装参数摘要；保留工具不传给上游模型 |
| S/B 能力分开 | 采纳。本稿仅定义 S 的 `write-delivery-v1`；不携带 B/C 能力承诺 |
| 所有重试入口先检查禁止信号 | 采纳，归 A/C 接口与客户端修复。须覆盖 policy、retryable、SDK/native 路径，不能只修一个入口 |
| Windows 检查后 rename 不等于原子 CAS；取消与崩溃须核验实际状态 | 采纳。收窄保证并增加 journal 恢复验收，不承诺阻止所有外部编辑竞争 |

## 可直接检查的协议附件

- [固定封装参数 JSON Schema](../../artifacts/write-delivery-contract-r3-2026-09-15/write-delivery-v1.parameters.schema.json)
- [响应清单 JSON Schema](../../artifacts/write-delivery-contract-r3-2026-09-15/delivery-manifest.schema.json)
- [SDK 注册与实际 HTTP 请求分离的完整示例](../../artifacts/write-delivery-contract-r3-2026-09-15/success.example.json)
- [完整 SSE 示例，arguments 分成两个 delta](../../artifacts/write-delivery-contract-r3-2026-09-15/success.sse)
- [A：长度错误及明确禁止重试的 JSON 示例](../../artifacts/write-delivery-contract-r3-2026-09-15/a-content-too-long.error.json)
- [附件校验脚本](../../artifacts/write-delivery-contract-r3-2026-09-15/verify-fixtures.mjs)及[协议 schema 注册表](../../artifacts/write-delivery-contract-r3-2026-09-15/schema-registry.json)

成功示例采用 `abc`，用于检查协议，不是假称 3 字节触发了实际长度上限。所有示例凭据、ID 和路径都是合成值，没有真实用户正文。usage 的示例值也不能作为生产用量。

## S 的准入与能力声明

请求同时满足以下条件才可转换：

1. 已认证，具有现有客户端 session/turn 关联；本次请求显式声明 `write-delivery-v1`、版本、nonce、接收上限和固定接收 schema 的 SHA-256；Gateway 按 version + SHA 查内置协议注册表。
2. 请求也声明普通 write；原上游输出仅有一个完整普通 write，正常结束、完整 JSON，无其他副作用工具、无截断或输出上限命中。
3. 仅 `content.maxLength` 不合规，其余原参数与原 tool_choice 均符合声明及已支持的普通 write 语义。未知 schema、artifact 字段、内部 done 或非普通写入不转换。
4. 完整内容符合接收方与 Gateway 共同上限；能够在原网络期限内完成交付，且尚未取消。

需要扫描全部校验错误，不能把 Ajv 返回列表中的第一条 maxLength 当作“只有长度错误”。只允许针对已识别内容约束的专用判断，不修改原客户端 schema 的全局行为。

工具 `write_delivery_v1` 属于传输保留接收器，只在 `session/llm.ts` 的 SDK 边界本地注册，activeTools 排除它；HTTP body.tools 只保留原普通工具。不能把接收器加入普通工具选择、排序、预算或 tool_choice 推断。Gateway 的有限协议 schema 注册表独立于模型工具注册表，不传完整 schema header 或新增 body 字段。原 write 禁用、原 tool_choice 不允许、保留名冲突或 runtime 未验收时不声明 S。Gateway 仍须防御性拒绝模型自行生成保留工具，名称和 delivery_id 不能自证来源；新封装额度不放宽普通工具上限。

### 请求头草案

| 名称 | 值与校验 |
| --- | --- |
| X-MedCode-Client-Capabilities | 包含 `write-delivery-v1`，可与其他独立能力并存 |
| X-MedCode-Write-Delivery-Version | `1` |
| X-MedCode-Write-Delivery-Schema-SHA256 | 固定 schema 文件原始 UTF-8 字节摘要：`57b561afab26d73faa7f91908d35195767162fa3cc734ab547faf02b5df9fa11`；固定文件禁止 CRLF/LF 转换或格式化后沿用旧 hash |
| X-MedCode-Write-Delivery-Nonce | 每次实际模型 HTTP 请求生成至少 128 位随机值，base64url 无填充；凭据刷新重发也生成新值，不给视觉资产/额度辅助请求误分配交付身份 |
| X-MedCode-Write-Delivery-Limits | 下述 limits 对象的紧凑 JSON，以 UTF-8/base64url 无填充编码 |
| X-MedCode-Client-Session-Id / X-MedCode-Client-Turn-Id | 使用现有关联字段 |

缺项、非法值、schema 不匹配时不接受 S；仍按普通请求和 A 的兼容错误路径处理。显式选择保留工具作为 model tool_choice 的请求应在上游调用前拒绝。

## 单个封装与来源绑定

封装沿用客户端建议字段：

`version, delivery_id, original_tool_call_id, original_tool_name, original_arguments, operation, payload_utf8_bytes, payload_sha256, transport_chunk_count, chunks`。

每片只有 `transport_chunk_index, offset_bytes, content`。S 的传输片号从 0 开始；原普通 `chunk.index` 从 1 开始，两者互不替代。original_arguments 保留 filePath 和原本存在的 mode/chunk，仅移除 content；不得把省略字段补成原模型已提供。operation 是解析后的方式：省略 mode 表示 overwrite。

转换后的外层工具 ID 等于 original_tool_call_id，一次上游工具调用对应一个封装调用和一个工具结果。上游无 ID 时，Gateway 在转换前按现有机制分配一次稳定 ID，后续映射沿用该值。

### 响应头与清单草案

| 名称 | 用途 |
| --- | --- |
| X-MedCode-Accepted-Capabilities | 包含被本次接受的 `write-delivery-v1` |
| X-MedCode-Accepted-Write-Delivery-Version | `1` |
| X-MedCode-Accepted-Write-Delivery-Limits | 本次实际接受的 limits，编码同请求 |
| X-MedCode-Write-Delivery-Manifest | 仅在实际发生 S 转换时设置；一个 base64url 编码的紧凑 JSON 清单 |
| X-Request-Id | 与清单 request_id 一致 |

清单字段：

```text
version, request_id, request_nonce, client_session_id, client_turn_id,
delivery_id, tool_call_id, tool_name, arguments_sha256
```

`arguments_sha256` 对**各 SSE delta 解码后拼接出的 function.arguments 原始字符串的 UTF-8 字节**计算 SHA-256。在 JSON.parse 之前核验；不重新序列化或做 JSON canonicalization。这样键顺序、字段省略、路径、操作和全部片段都绑定到原响应。payload_sha256 再独立核验重组文件内容。

清单由已认证请求所连接的可信 Gateway HTTPS 响应产生，不是数字签名或供第三方离线验证的凭证。Gateway 不得透传上游同名响应头，也不能由模型输出构造受信任清单。客户端将 nonce、session/turn 与本地该次实际请求核对，将清单和封装 ID/摘要核对。仅检查清单和参数彼此一致不够。

接受能力但未实际转换的普通响应可以没有清单。没有有效清单却出现保留封装工具时，客户端禁止执行；旧客户端不接收保留工具或新控制帧。

普通响应没有 S 清单时必须保留原流式 body，不因 accepted capability 头而先 readText/json 或等待 EOF。只有合法清单触发后述完整缓冲；有非法清单则先报协议错误。R3 的 sdk_registered_tools 与 request_body.tools 已分离，普通模型输入不携带接收器，不需额外探测或依赖上次响应缓存。实际跨版本 HTTP 中间件仍须验收。

## 在 SDK 之前完成整响应检查

入口固定在**最终实际 HTTP 响应 → S 头部/全响应校验 → 现有额度及 MedcodeStream.stream → SDK**，在任何合并、丢弃或提前释放工具数据的转换前检查原响应；保留必要登录/传输诊断观察。绑定最终可信 origin、主体、session/turn、该次 nonce、实际 X-Request-Id、接受能力/版本/limits。不能仅用 turn ID 全局 Map；native 未验收不得声明 S。

对有有效清单的 S 响应：

1. 边读取边限制响应体总字节、时间及取消；禁止先无上限读完再检查。
2. 每个有 choice 的事件必须恰有一项且 index=0，全响应只有一个封装工具；不能只循环检查 index=0。空 choices 仅允许工具正常 finish 后、DONE 前的一次 usage-only 事件。要求 finish_reason=tool_calls、正常 DONE 和 EOF，不能在最后一个工具 delta 到达时就执行。
3. 拒绝混合普通 write/其他工具、重复 finish、DONE 后额外事件、数据截断、摘要不符，以及原调用映射不一致。
4. 验证封装 schema 及所有跨字段条件，随后才把已检查的一个封装调用交给 SDK。
5. execute 再校验本地该请求的已接受交付上下文与持久化去重状态，然后询问既有权限并执行文件事务。execute 不能单凭参数通过 schema 就写文件；通用工具纠错、大小写修复和普通 write 回退不能绕过验证。

不向 SDK 添加未经适配的独立控制帧。本稿的清单位于响应头，SDK 输入仍是普通的单工具 OpenAI 兼容响应；具体缓冲与重放 Response 的代码入口由 Desktop 确认。

## 上限与校验口径

以下上限接受为开发/联调起点，不是已发布或性能实测配置。Gateway 按请求、schema、服务配置取较小有效值；客户端再验证 accepted 不高于请求、本地或固定 schema，并对每一项以 accepted 有效限值执行。缺项、非法值、超额接受或实际超额都拒绝。

| limits 键 | 初始候选 |
| --- | ---: |
| chunk_utf16_units | 4,000 |
| chunk_json_utf8_bytes | 32,768 |
| chunk_count | 256 |
| payload_utf8_bytes | 1,048,576 |
| arguments_utf8_bytes | 8,388,608 |
| response_body_bytes | 12,582,912 |

JSON Schema maxLength 计数与 UTF-16 .length 分别校验。每片不能拆开 surrogate pair，孤立 surrogate 拒绝；不在拼接前规范化 Unicode、换行或 BOM。片段 JSON 字节数指该片对象紧凑序列化后的 UTF-8 大小。arguments 则检查 delta 解码后原始字符串的真实 UTF-8 字节，累积时执行、JSON.parse 前拒绝；不能以 parse 后 stringify 大小替代。参数、payload 与解压响应上限独立检查，均按有效协商值执行。

跨字段检查包括：片号从 0 连续、offset 为此前片段实际 UTF-8 字节之和、声明片数等于数组长度、payload 长度与 SHA 正确、operation 与原 mode 一致、原 chunk.index 不大于已声明 total。

这不等于直接重用旧 artifact 的 64 KiB 整体工具限制。JSON 转义与多次缓冲会放大内存，必须按实际并发测峰值；不能因源 payload 仅 1 MiB 就声称内存只增加 1 MiB。

## 每文件事务、完成与崩溃恢复

S 的幂等身份至少为经过本地认证上下文确认的主体 + session + turn + delivery_id；绑定工作区、真实 assistant message/本地工具记录、原 call ID、规范化目标、操作、原始参数及 payload 摘要、原逻辑片信息。除 delivery 去重，还约束真实本地工具记录，防止换 nonce/delivery 后重复 append；同一身份内容一致返回原持久化收据，不同则冲突。

新建独立交付事务生命周期和存储，不复用旧 session+turn 唯一行，也不赋造旧 recovery_count/owner。复用校验、staging、journal 和替换原语必须保持旧整轮事务回归。

普通 S write 在工具成功返回前完成**原来那一次写入**的提交：

- 未带 chunk 的普通 write：提交后可产生原工具既有的文件结果，不能因缺 done 失败。
- 带 chunk 且未到最终块：提交本次普通写入，但不新增整个文件的完成标识。
- append：拼接后的 payload 摘要只代表追加内容；目标最终摘要由客户端读取原文件并计算。
- B 的 done=false 属于未来多次生成状态，只 staging；不能混入 S 的普通 write 语义。

路径大小写、相对路径、符号链接和目录链接必须按实际目标统一权限与锁，不能只靠输入路径字符串。客户端内写入串行；提交前检查外部修改。检查后再 rename 不构成跨外部编辑器的原子 compare-and-swap，对两者间的外部竞争不作未实现保证；不得先删除原目标再 rename。

journal 顺序为接受记录 → staging → 持久化替换意图/确定目标摘要/结果收据 → 替换 → committed → 工具结果。BOM/格式化属于副作用，必须纳入阶段与最终摘要；LSP/通知失败不等于未提交。重启按目标/暂存摘要判断已提交、未提交或冲突，恢复同一结果，不再次 append。替换开始后取消不能声称原文件必然未改；进程崩溃恢复不自动意味着断电持久性。权限用重组后原操作的 diff，拒绝时不替换。

网络/模型原绝对期限约束完整接收；之后权限沿用 SessionTools ask/wait/暂停计时，本地提交遵守任务取消与工具限制，不新增统一 120 秒权限/S 门槛。I/O watchdog 如需新增由 Desktop 单独配置并测试，失败不自动再调用模型。95 秒剩余网络时间不排除纯交付。

真实历史保存一个封装调用/结果及原映射。在 convertToModelMessages 前将已核实的整对记录转换为有界文件状态摘要与有限尾部；不得留下孤立 tool 结果、伪造截短的普通 write 或反复重放巨大封装/保留工具到旧 Gateway。成功、失败、未提交、取消和恢复都按真实状态映射，并验收下一轮普通请求。

## A 的错误与 B/C 的边界

附件 A 示例仅针对本次明确的内容长度超限，继续使用 tool_call_validation_failed / schema_mismatch，同时给出结构化 tool_validation。该类错误未协商交付或不可恢复时明确 retryable=false、automatic_retry_allowed=false、transformed_retry_allowed=false；不能将这个禁止组合自动套到所有 schema、网络或限流错误。普通缺字段保留基线中按原期限和调用预算的修复行为，首期不新增通用 120 秒门槛。

新客户端所有修复入口优先处理禁止信号，再判断实验开关。旧客户端可能忽略扩展字段，A 只能保证 Gateway 不启动无效的第二次长调用；需真实旧版本测试，不能宣称所有旧 SDK 重试都已被控制。

S 不消耗新的模型调用或模型恢复额度；Gateway 只记录原生成 usage。C 的跨 HTTP 短片纠错需要原子消费恢复凭证和原期限校验，尚未在本稿启用。B 的普通片段生成仍受任务总时限、步数和额度约束。

## 本轮验证与实现分工

R3 附件通过 **60 项**检查，含 Desktop 提出的合法 hash 下原始参数超限、响应 request ID 不符、重复 choice 三个反例，以及有效 limits 和请求信任绑定。命令：`node artifacts/write-delivery-contract-r3-2026-09-15/verify-fixtures.mjs`。这是参考 fixture 验证器，生产仍须实现有界流式读取。

实际 AI SDK/OpenAI-compatible provider/MedcodeStream 的 7 次合成本地 HTTP 对照通过：body 字节一致，网络 tools 无接收器，普通文本在 EOF 前到达，可信接收器一次调用/一个结果，未可信接收器零执行，普通多工具保留，Gateway body parser 通过。见[验证摘要](../../artifacts/write-delivery-contract-r3-2026-09-15/validation-summary.json)。

上述结果满足 Desktop R2 的开发契约冻结条件，不再重复请求架构确认。实际旧 HTTP 中间件、TLS/响应适配器、文件事务、崩溃恢复、native、真实性能及混合负载仍是实现后的验收项，不代表已上线或零回归。

Gateway 实现 A 精确分类/原预算入口、保留工具防御、S 准入/构造/清单/输出；Desktop 实现 SDK 边界注册、实际 HTTP 前后信任上下文、pre-MedcodeStream 检查、接收器、每文件事务、历史映射及状态。按短任务矩阵共同验收；B/C 后续独立排期。
