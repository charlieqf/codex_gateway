# Doctor Research API 现状、问题与解决思路

更新时间：2026-07-22

本文是 Doctor Research API 当前发布状态、已知问题和后续治理方案的
统一说明。它面向医学团队、产品负责人、研发和运维人员，不替代具体的
API 使用说明或生产操作手册。

相关文档：

- API 使用说明与 Python 示例：[`README.md`](README.md#api-quick-reference)
- 生产部署、备份和回滚：[`production-runbook.md`](production-runbook.md)
- 医学团队原始 Skill：[`../采访skill/`](../采访skill/)

## 一、结论摘要

Doctor Research API 的 `1.6.72` 已部署到 Azure VM 的公网生产入口。
取消、遥测、回放、规则统一、定向修复和四文件提交链路的工程整改已经完成，
服务和基础设施健康；但医学团队尚未完成人工四文件内容验收，且当前代表病例的
真实成功率为 3/5，因此仍定义为**受限试用版**，不能扩大用户范围。

当前结论可以概括为：

| 事项 | 当前状态 | 结论 |
| --- | --- | --- |
| 部署目标 | Azure VM，公网入口为 `https://gw.instmarket.com.au` | 正确；CN1 不是 Doctor Research 部署目标，且本轮未改动 CN1 |
| 服务状态 | 公网和 VM loopback 均返回 `ready / controlled-trial` | 基础服务可用 |
| 当前版本 | commit `70ca2675827acfa4992816e932a3afd236453adf`，执行器 `1.6.72` | 已上线 |
| 运行时上限 | 服务端硬截止 570 秒，客户端发布验证最多等待 590 秒 | 满足“整体不超过 10 分钟”的原则 |
| 自动化验证 | 本地和 Azure 均通过 build、577 个 Vitest、23 个 Python 测试；npm audit 为 0 | 工程回归通过 |
| 医学 Skill | 原始四文件无 Git diff，线上 bundle SHA-256 为 `6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351` | 未做业务文本“优化” |
| 真实公网 E2E | `1.6.72` 同一代表病例连续 5 次均在 10 分钟内终态；3 次成功、2 次 `model_contract_error` fail-closed | 墙钟与失败安全验收通过，成功率尚未达到 5/5 |
| 当前四文件 | 3 个成功 run 均恰好产生 3 MD + 1 TXT，下载内容与 manifest SHA-256 一致；2 个失败 run 均为 0 artifact | 自动化四文件契约通过，仍待医学团队人工内容验收 |
| 取消传播 | `/v1/chat/completions` 与 `/v1/responses` 非流式生产断开均到达 provider，记录 `cancel_requested=1`、`cancel_observed=1` | P0 已完成；故障注入覆盖无同分片新旧调用重叠 |
| 发布范围 | 仅允许命名、可追踪的少量用户试用 | 暂不扩大为普遍可用 |

今天已经完成的是“把取消、可观测性、确定性回放和安全四文件发布闭环部署到 Azure，
并用 5 次真实运行证明全部在 10 分钟内终态”。尚未完成的是医学团队对成功四文件的
人工内容验收，以及是否调整 600 字软门槛或允许多个独立硬错误后的额外改写。

## 二、必须遵守的边界

### 2.1 医学 Skill 的所有权

`docs/research/采访skill/` 是医学团队提供并持续维护的权威业务来源。
工程团队必须遵守以下原则：

1. 默认原样使用该目录，不维护工程侧业务分叉。
2. 除非存在明确、可复现且经医学团队确认的错误，不修改其中的业务方法、判断标准
   或写作要求。
3. 医学团队更新 Skill 后，通过重新构建、记录新摘要和重新验收来接入；不能把工程侧
   临时修改再次手工合并进医学团队版本。
4. 工程优化只处理输入输出契约、调度、超时、缓存、重试、验证、文件渲染和可观测性，
   不假定工程团队比医学团队更理解业务。

当前生产镜像按只读 bundle 加载四个 Skill 文件，不执行 Skill 目录内的脚本，也没有
修改医学团队原始文件。因此，现阶段问题不能归因于“医学 Skill 被工程优化坏了”。

### 2.2 不可单方面放宽的质量门槛

以下门槛继续 fail-closed，不能为了提高成功率由工程团队单方面降低：

- 医生身份、中文名与英文文献身份的证据闭环；
- 官网、PubMed/Crossref 等来源的允许范围和主体归属；
- 引用覆盖、数值与引用对应关系；
- 因果表述和证据等级；
- 五个问题与五个答案的完整性及证据覆盖；
- 恶意 HTML、链接、危险 URI、控制字符等安全过滤；
- 恰好 3 个 Markdown 和 1 个 TXT、manifest、大小及 SHA-256 一致；
- 整体墙钟时间不超过 10 分钟。

可以由工程侧处理的是纯展示问题，例如残留标题、截断句、孤立指代和服务器可确定的
版式收口；处理后仍必须重新经过同一套安全与证据验证。

### 2.3 可以讨论但需要医学团队确认的软门槛

“每个主题至少 600 字”“综述合计至少 6000 字”等完整度门槛可能影响用户体验，
但它们和身份、引用、数值安全不是同一类风险。如果医学团队认为在证据稀疏时可以输出
较短但边界清晰的章节，可以共同定义例外规则；工程团队不能自行把 `600` 改成 `328`
来让某次运行通过。

## 三、当前生产状态

### 3.1 部署信息

- 公网入口：`https://gw.instmarket.com.au`
- 目标环境：Azure VM
- Compose project：`codex_gateway_test`
- 发布目录：
  `/home/qian/codex-gateway-release-70ca267-20260722T093500Z`
- 执行器：`doctor-research-skill.1.6.72`
- Prompt：`v28`
- Validation：`v39`
- Workflow：`doctor_research_workflow.v65`
- 公网 Gateway 只监听 `127.0.0.1:18787->8787`，Nginx 仍是唯一公网边缘。
- Research LLM Gateway、Worker 和 maintenance 均不发布宿主机端口。

最终检查时四个容器均为 healthy、重启次数均为 0。公网和 loopback 健康检查通过，
Worker 报告 `doctor-research-skill.1.6.72`，内部 LLM Gateway 截止为 175000 ms。

### 3.2 备份与磁盘

当前发布回滚边界使用以下经过完整性、外键和 SHA-256 校验的三数据库备份：

```text
/home/qian/codex-gateway-backups/70ca267/20260722T093500Z
```

三份数据库均通过 SQLite integrity、foreign-key、权限和 SHA-256 检查；1.6.71 的四个
当前镜像已打上 `rollback-02e5880-20260722T093500Z` 标签。详细哈希见生产 runbook。

### 3.3 当前可以对用户承诺什么

可以承诺：

- API 已在 Azure 公网入口提供异步创建、状态查询、结果和下载接口；
- 每次 run 都有明确终态，并被 570 秒服务端硬截止约束；
- 失败时不会发布半成品四文件；
- 身份、引用、数值、证据等级和文件哈希门槛仍然有效；
- 可以向少量命名用户开放受限试用并跟踪每次 run。

暂时不能承诺：

- 每次请求都能成功；
- 每次请求都能生成合格结果；当前 5 次代表病例为 3 次成功、2 次 fail-closed；
- `1.6.72` 生成的 3 MD + 1 TXT 已经完成人工内容验收；
- 可以无风险扩大到普通用户或高并发流量。

## 四、最近验证过程和结果

近期发布验证揭示的问题并非同一个错误反复出现，而是上游长尾和模型输出随机性依次
暴露了不同边界。主要过程如下：

| 版本 / run | 结果和耗时 | 暴露的问题 |
| --- | --- | --- |
| `1.6.54` / `drr_e05f983ffaf74ea0bfddeb8c0e51b9d6` | 成功，约 8 分 11 秒，生成四文件 | 人工内容审核发现结论后残留 QA、截断比较句、空引用表达、标题推断、孤立指代、部分数值及方法描述问题 |
| `1.6.55` / `drr_893f6b3dfb4847239ccd795bc1e8d3c8` | 失败，约 5 分 11 秒 | 多个上游超时/错误后，重试优先级没有优先补齐正文 |
| `1.6.56` / `drr_509ad8dcdd9e4e1d848be0814d75e5e1` | 失败，约 7 分 29 秒 | 安全结尾回退只差主题长度 `588/600`，暴露边界段落池不足 |
| `1.6.57` / `drr_701618f6bb464c719cfd96cf35f2b100` | 失败，约 6 分 58 秒 | 回退内容出现 `review_orphaned_demonstrative_start`，暴露规范化器与验证器口径不一致 |
| `1.6.58` / `drr_9f7bb667522046389ef4579805b8fda4` | `upstream_unavailable`，414.416 秒 | 一个分片返回，其他必需生成调用长时间无结果；Worker 终止后主动重启并恢复 |
| `1.6.58` / `drr_25f189a126d54b6c9e0979495225215e` | `model_contract_error`，449.051 秒 | 两个分片约 77/108 秒成功；另一次收到上游 HTTP 500 `Batch backend error`；最终 peer 输出只剩主题长度 `328/600` 未通过 |
| `1.6.72` / `drr_a98ba77e84a04f99a47de3e322c07043` | 成功，237.459 秒 | peer contract 不可用后确定性安全回退通过；四文件和哈希一致 |
| `1.6.72` / `drr_dffe542c19914841bf9936e65f93ca3a` | 成功，209.931 秒 | 单一短正文主题使用 hash-bound 定向章节修复；四文件和哈希一致 |
| `1.6.72` / `drr_955f4e47884b4a9eaa1c0b5e57045265` | 成功，262.879 秒 | 安全规范化后摘要复用同源规则闭合；四文件和哈希一致 |
| `1.6.72` / `drr_9ac8538f3ce147a0abcf1f6c19a0f96b` | `model_contract_error`，285.717 秒 | 初始和纠错输出仍同时违反引用、孤立指代、数值与因果等级；peer 又破坏章节契约，按多硬门槛策略 fail-closed |
| `1.6.72` / `drr_9d5fea39377646daa08bdfacfaef1861` | `model_contract_error`，358.272 秒 | 纠错 provider 在 175 秒截止并确认取消；peer 不可用后只剩主题 `476/600`，未擅自放宽软门槛 |

这五次使用当前工程 allowlist 的同一 smoke 病例；医学团队仍需明确确认它是否可作为
正式代表性病例，并补充其要求覆盖的其他病例。该组数据可作为工程基线，不能替代医学
团队对病例代表性和四文件内容的判断。

三个成功 run 的 manifest/download SHA-256 记录如下，列顺序为
`profile / review / questions / answers`：

| run | SHA-256 |
| --- | --- |
| `drr_a98ba77e84a04f99a47de3e322c07043` | `4ae0c4abd1038fc22ab207ffc9c3a3ac8588363b26b2dca54bbee139266ad4d9` / `cfabe41b035579c89c23d5fdf0336ff10d3c2a18124bfeabf97e8c3a792d5674` / `cbc8e29486784c63bd6922aeecdb3de072658e6375e9ed9f90b4ae597c729cfb` / `d735406ac91c67fe9c167d032a4ff1606719908eea8801bd84acf8c8f599af66` |
| `drr_dffe542c19914841bf9936e65f93ca3a` | `4ae0c4abd1038fc22ab207ffc9c3a3ac8588363b26b2dca54bbee139266ad4d9` / `6e4158c8e5c87f5cbd00606d3f59e1df433c494515723f527dfd4e1e597deb16` / `45949843d70b867eae16b8ac4ecc92688ae3158c9f52af5d467baed1d5061c3a` / `ba347d9e18020bfd34eabd7ea5cbac7b3fc2eecbac9f2d359130b4eafa3ea2b4` |
| `drr_955f4e47884b4a9eaa1c0b5e57045265` | `4ae0c4abd1038fc22ab207ffc9c3a3ac8588363b26b2dca54bbee139266ad4d9` / `075c9d71a2f60f00c1f9a7ff4a6703e774aa103b06f5a58b78bc8cd253170fc7` / `53dcd6beff24d0dc9079c854114ad4ddbb65d154bfab755ebd3ee674b0b87864` / `ea2a1a51424542802c2759acdb9ec521520ea3dad38e5f5852bdd14c1644927a` |

`1.6.59` 至 `1.6.72` 进一步完成的工程修复包括：

- 清理结论后的 QA 残留和模型泄漏标题；
- 处理截断比较、空“显示 [n]”、标题式推断和孤立指代；
- 收紧 D-dimer、EASIX 等数值与引用闭环；
- 在已取得正文时优先补齐正文，而不是先消耗预算修结尾；
- 扩充经过预审的证据边界段落池；
- 贯通 Chat Completions 和 Responses 非流式断开到 provider 的取消链路；
- 建立 Worker/Gateway/provider 完整调用时间线和旧行兼容迁移；
- 建立 16 个脱敏离线回放测试，并保证重复运行诊断、语义和 artifact hash 确定；
- 统一 review contract、prose predicates、Prompt、分片/完整 validator 和 supplementer；
- 增加 hash-bound 单章节修复、peer fallback 和已通过章节字节保持；
- 去重证据 Prompt，并修复上游 cooldown、截断/空响应、推理预算和 provider 重试边界；
- 修复安全规范化后摘要变短和重复 warning 导致最终 manifest 组装失败的问题。

这些修改通过自动化与真实生产验证。剩余闭环证据是医学团队对三个成功 run 的四文件
人工审核；在该审核完成前继续保持 controlled-trial。

## 五、问题分析

### 5.1 已确认的上游长尾和错误

真实日志已经出现以下情况：

- 同一轮三个并行分片中，一个在 54、77 或 108 秒返回，其他分片超过超时窗口；
- 上游明确返回 HTTP 500 和 `Batch backend error`；
- 短小普通请求可以在约 9 秒成功，但这不能证明长证据 Prompt 也会稳定成功；
- 健康检查和模型 readiness 为 200 时，大型生成仍可能长时间无结果。

这些证据能够证明上游存在长尾和服务错误，但当前还不能仅凭它们断言根因一定是
“provider 容量不足”。Prompt 大小、provider 内部排队、账户并发、取消不完整及重试
重叠都会产生相似现象。

### 5.2 已完成的 P0：非流式客户端断开传播到 provider

Gateway 现在通过同一个 client-disconnect helper 处理执行取消和 499 observation，不再使用
已弃用的 `request.raw.aborted`。request close 只在请求体不完整时取消，reply close 只在
响应未正常结束时取消。信号贯通 `executeChatCompletion()`、deadline 和 provider adapter；
释放计数和故障注入覆盖恰好一次结算及无同分片新旧调用重叠。

1.6.72 生产 smoke 中，Chat Completions 与 Responses 非流式调用均在约 2 秒断开后记录
`client_aborted`、`terminal_source=client_abort`、`cancel_requested=1` 和
`cancel_observed=1`，无服务重启和未结算 reservation。

### 5.3 模型结构化输出存在随机性

即使 transport 成功，模型也可能产生不同类型的契约偏差，例如：

- 某主题段落不足最低长度；
- 引用覆盖不足或数值没有在同一证据闭环内；
- 因果语气强于证据等级；
- 问答与引用覆盖不完整；
- 句首出现无法明确回指的“该结果”“这一发现”等表达。

这些问题不是单靠增加等待时间可以解决的。增加单次超时甚至可能让一次最终仍不合格的
输出占用完整的 10 分钟预算。

### 5.4 已完成的结构整改：共享规则源和离线回放

`review-contract-policy.ts` 和共享 prose predicates 现在同时服务 Prompt、分片验证、
完整验证、规范化和补齐器；医学业务门槛记录来源 Skill 和 bundle SHA，并在摘要变化时
fail-closed。16 个独立 replay fixture 覆盖历史缺陷、provider 错误和确定性重复运行，
`samples/known-invalid/` 仍只作为缺陷目录，没有被当作 golden 或 executable fixture。

### 5.5 代码现状需要准确描述

| 项目 | 实际状态 | 对后续方案的影响 |
| --- | --- | --- |
| 模型输出回放 | 独立 replay 目录已有 16 个脱敏 fixture，使用固定证据、可注入时钟和语义/hash 断言 | 规则和修复改造受回放保护；known-invalid 继续隔离 |
| `known-invalid` 样本 | 是隔离的历史展示输出，目录标记明确禁止作为 golden、benchmark 或 executable fixture | 只能用作缺陷目录和派生负例来源，原目录继续保持隔离 |
| 分片指标 | Worker 与 Gateway 已记录 prompt/output budget、admission、provider 首事件/时长、客户端总时长、终态来源和取消状态 | 可按 client session ID 还原超时和无 request ID 的调用 |
| Gateway `first_byte_ms` | 已存在，但非流式路径在收集完 provider 内容后才标记 | 对 Research 非流式调用更接近“完整结果时间”，不能当作模型首 token |
| Skill Prompt | 三个分片重复的是手写 compact execution contract，不是四份完整原始 Skill | 重复存在但体积有限；没有数据前不应优先进一步压缩医学约束 |
| 定向修复 | 保留 peer `old_text/new_text`，并增加携带 section ID、原文 SHA 和引用闭包的单章节修复 | 哈希或引用不匹配、完整验证失败时不应用，已通过章节保持字节不变 |
| 确定性渲染 | 四文件、固定栏目、证据表、引用列表、manifest、文件名和哈希已由服务器生成 | 不需要重新实施“四文件服务器渲染”；剩余工作是让综述章节边界更结构化 |

### 5.6 验收方法问题：一次成功不能代表稳定可用

`1.6.72` 的自动化、取消和三次成功四文件验证已经通过，但 5 次真实运行仍有 2 次因
模型硬门槛 fail-closed。这说明当前验收仍需要同时覆盖：

1. 代码确定性回归；
2. 超时取消是否真正到达 provider；
3. 上游可用性和长尾时延；
4. 模型契约稳定性；
5. 四文件人工业务审核；
6. 连续多次运行的重复性。

只看 run 状态、只看某一次成功、只看自动化测试，都会高估实际可用性。

### 5.7 不是当前根因的事项

根据现有证据，以下事项不是本轮失败根因：

- 部署到了错误环境：实际目标和运行环境均为 Azure，CN1 未参与；
- Azure 磁盘不足：最终约有 39 GiB 可用；
- Gateway/LLM Gateway 容器崩溃：核心容器保持 healthy，LLM Gateway 为 0 重启；
- 医学 Skill 原始目录被修改：原始目录零 diff，bundle 摘要一致；
- API 无限等待：五次 `1.6.72` 运行均在 10 分钟前到达终态；
- 系统发布半成品：两个失败 run 均为 0 artifact，三个成功 run 均恰好四个。

## 六、具体优化方案

下列 6.2 至 6.7 的工程工作已经在 `1.6.72` 落地并通过自动化与生产验证；保留具体条目
作为设计与防回退依据。6.9 的模型/provider 评估和 6.10 的软门槛选择尚未启动，仍需
数据和医学团队决定。

### 6.1 P0：保持受限试用和透明失败

- 只向命名用户授权，不把 `doctor_research` 加入共享计划；
- Worker concurrency 保持 1；
- UI/API 明确展示 `upstream_unavailable`、`model_contract_error` 和是否建议稍后重试；
- 客户端不在后台无限自动重跑；一次用户请求最多对应一个受控 run；
- 保持 570 秒服务端硬截止和 fail-closed artifact 发布；
- 医学团队未完成人工四文件验收前继续标记 `controlled-trial`。

这允许少量用户实际试用，但不能以“服务有终态”代替“生成成功率达到验收标准”。

### 6.2 已完成 P0：贯通非流式取消并消除重试重叠

建议改动范围：

1. 在 `apps/gateway/src/` 增加可复用的客户端断开 `AbortSignal`，不再使用 Node 已弃用的
   `request.raw` `aborted` 事件。监听 `request.raw.close` 时只有
   `request.raw.complete === false` 才表示请求体未完整接收；监听 `reply.raw.close` 时只有
   `reply.raw.writableEnded === false` 才表示响应未正常结束。正常完成后必须移除监听器。
   不能在 `request.raw.close` 时只检查响应状态，因为 Node 16+ 会在正常请求消息完成时
   触发 IncomingMessage `close`。现有 `onRequest` observation 中的 `aborted` 监听也应迁移
   到同一 helper，避免取消执行和 499 观测各自维护一套生命周期判断。
2. `/v1/chat/completions` 和 `/v1/responses` 的非流式 handler 都把该 signal 传入
   `executeChatCompletion()`；`createChatRequestDeadline()` 再把它传播到 provider adapter。
   `/v1/responses` 流式路径继续使用现有 `sse.signal`，并增加防回退测试。
3. 保持 provider deadline 严格早于 Worker call deadline，预留返回结构化
   `upstream_timeout` 和清理活动调用的时间；不能让 Worker 先断开、Gateway 后超时。
4. 对本地超时采用保守策略：只有收到 Gateway/provider 的明确终态后才允许同分片重试；
   单纯的客户端断开在取消协议完成前不得立即重放。
5. `client_aborted` 不应错误地把上游账号标记为成功或故障；活动请求、并发计数和 token
   reservation 必须恰好释放一次。

最小回归用例：

- 分别通过 `/v1/chat/completions` 和 `/v1/responses` 模拟一个永不结束的非流式
  provider；客户端断开后 provider signal 必须在限定时间内进入 aborted；
- `activeRequestRegistry`、rate limit、token reservation 和 upstream inflight 最终均为 0；
- 同一 `run_id + stage + attempt` 不产生重叠 provider 调用；
- 正常非流式请求行为不变，`/v1/responses` 流式断开仍通过 `sse.signal` 取消且不重复结算；
- 取消过程中无未处理异常、无 Gateway/Worker 重启。

### 6.3 已完成 P0：建立 Worker 到 provider 的统一调用时间线

不要继续使用含义不清的“排队时间”和“TTFB”。建议明确记录：

| 字段 | 所属层 | 定义 |
| --- | --- | --- |
| `prompt_chars` / `maximum_output_tokens` | Worker stage | 实际发送的 Prompt 字符数和输出预算 |
| `admission_wait_ms` | Research Model Client | 因 429/Retry-After 在客户端等待的累计时间；没有等待则为 0 |
| `request_sent_at` | Research Model Client | 请求开始写入内部 LLM Gateway 的时间 |
| `gateway_admitted_ms` | Gateway | 从收到请求到选定 provider 并开始调用的时间 |
| `provider_first_event_ms` | Gateway/provider adapter | provider 返回第一个内容、tool 或终态事件的时间；这才是 Research 所需首事件 |
| `provider_duration_ms` | Gateway/provider adapter | provider 调用从开始到完成或取消的时间 |
| `client_total_ms` | Worker stage | Worker 观察到的完整调用时间，含 admission wait |
| `terminal_source` | 两层 | `provider_response`、`gateway_deadline`、`client_abort`、`run_deadline` 或 `transport_error` |
| `cancel_requested` / `cancel_observed` | 两层 | 谁发起取消、provider adapter 是否观察到取消 |

关联方式优先复用现有
`x-medcode-client-session-id=<run_id>:<stage>:<attempt>` 和 turn code。超时调用可能拿不到
响应头中的 `gateway_request_id`，因此不能只依赖该字段做 join；Gateway 的
`request_events.client_session_id` 必须可以反查失败调用。

落地建议：

- `research_stage_runs` 保存 Worker 可见的输入规模、等待、总时长和终态来源；
- `request_events` 保存真正的 provider 首事件、provider 时长和取消结果；
- 运维查询按 client session ID 合并两层记录，不复制原始 Prompt 或模型正文；
- 指标迁移必须兼容旧行，新增列允许 `NULL`，旧版本回滚不得破坏数据库读取。

验收标准是任取一次成功、provider 500、Gateway timeout 和客户端取消，均能从数据中还原
唯一、时间单调且无重叠的调用时间线。

### 6.4 已完成 P0/P1：建设可复现的模型响应回放链路

回放 fixture 不能只有模型字符串。建议每个案例包含：

```text
fixture_version
skill_bundle_sha256
prompt_version / validation_version / workflow_version
run_input（脱敏）
closed_evidence（脱敏、固定顺序）
model_calls[]: stage, attempt, response_or_error
expected: terminal_status, diagnostics, artifact_semantics
```

具体实现：

1. 从 `workflow.ts` 抽出一个无网络、时钟可注入的合成处理入口，输入闭合证据和逐次模型
   响应，执行解析、规范化、合并、验证和 `renderDoctorResearchArtifacts()`。
2. 在 `packages/research-agent/test-fixtures/replay/` 存放经过审核的脱敏 fixture；测试不得
   读取 `samples/known-invalid/`。
3. 历史 `known-invalid` 四文件只用于列出缺陷。需要覆盖其中问题时，在新目录创建最小
   派生负例，并明确预期是“拒绝”还是“规范化后通过”。
4. 增加默认关闭的受控 E2E 原始响应捕获开关。未脱敏捕获只允许写入权限受限的临时
   运维目录，不进入 Git；经人工脱敏后才可转为 fixture，并立即删除临时原文。
5. 回放断言同时覆盖最终诊断、确定性输出和 artifact SHA；对于时间、ID 等非确定字段
   使用注入值或语义断言。

首批案例至少覆盖：短主题、孤立指代、截断比较句、结论后 QA、无证据数值、缺引用、
peer 补丁、分片 JSON 失败、provider 500、超时取消和同一响应重复运行。

### 6.5 已完成 P1：把医学契约和展示规则变成单一工程规则源

建议新增两个职责明确的模块，而不是继续在 `workflow.ts` 内复制字面量：

- `review-contract-policy.ts`：章节数量、长度、问答数量和语言计数规则；
- `review-prose-rules.ts`：残句、孤立指代、嵌入 QA 等共享谓词及允许的确定性转换。

实施原则：

1. 医学团队拥有的数值和业务要求必须标注来源 Skill、bundle SHA 和责任方；医学 Skill
   更新导致摘要变化时，构建/测试必须失败并要求重新审核派生 policy，不能静默沿用旧值。
2. Prompt builder、分片 validator、完整 validator 和 supplementer 全部引用同一 policy。
3. 规范化器和验证器共享同一个“是否违规”谓词；修复函数只能把违规状态变成非违规，
   不能自行补写医学事实。
4. 生产规则文件之外不再保留 `600/800/200` 等同义业务门槛字面量；测试数据可例外。
5. 任何规则重构必须先通过全部回放案例，再运行完整测试。

### 6.6 已完成 P1：缩小剩余的整分片重写

现有 peer review 已经是 substring patch，不应重写为另一套机制。优化重点是分片契约失败：

| 失败类型 | 建议处理 |
| --- | --- |
| provider 500/明确 transport 终态 | 在取消已完成且墙钟预算足够时，最多重试同一分片一次 |
| 客户端本地 timeout/连接断开 | 未确认旧调用终止前不重试 |
| JSON 完全不可解析 | 允许一次格式修复或同分片重试，因为无法安全定位字段 |
| 单一章节过短、孤立指代或局部引用失败 | 只提交失败章节、结构化诊断和该章节允许的闭合 evidence IDs |
| QA、引言或结论局部失败 | 复用现有定向 correction 路径 |
| 多个独立硬门槛同时失败 | 立即 fail-closed，不进行多轮自我改写 |

章节补丁响应应携带 `section_id`、原文 SHA-256 和 replacement；服务器只有在原文哈希匹配、
引用仍属于允许集合且完整验证通过时才应用。验收时应证明已通过章节的字节内容没有变化，
并记录修改前后差异。

### 6.7 已完成 P1：按风险顺序减少 Prompt 和模型工作

当前分片重复的是 compact Skill contract，不是四份完整 Skill 文档。Prompt 优化顺序应为：

1. 先记录每个分片实际 prompt token、证据条数、摘要字符数和输出 token；
2. 去掉同一分片内重复的 reference title、doctor context 和搜索元数据；
3. 使用稳定 evidence ID、结构化字段和有界摘要，不重复传递服务器已经确定的文件格式、
   manifest 或 profile 内容；
4. 根据分片职责只发送其闭合证据子集，但保留全局引用编号与可审计映射；
5. 在调用前做 token 和剩余墙钟预算预检，预算明显不足时提前返回可解释错误；
6. 最后才评估 Skill 约束投影。

如果调整 Skill 投影，必须从只读原始 Skill 按明确章节机械抽取，记录 bundle/projection
摘要，并与现有完整机械投影做差异检查。不得由工程人员手写一个更短的医学方法摘要来
替代医学团队原文。目标是减少数据传输，不是改变业务流程。

Prompt 优化验收至少包括：固定回放零质量回退、输入 token 有可测下降、真实同病例的
成功率不下降，以及医学 Skill 目录保持零 diff。没有这些数据，不以字符更短作为完成。

### 6.8 P2：完成剩余的确定性章节结构，而不是重复实现四文件渲染

当前服务器已经生成四个文件、标准栏目、核心证据表、引用列表、五行 TXT、manifest 和
SHA-256。模型仍负责综述 title、abstract、keywords 和带 `##` 标题的正文 Markdown。

后续可把模型正文改成类型化 `sections[]`，每项包含 `kind`、`title`、`body` 和
`evidence_ids`，由服务器负责标题级别、顺序和 Markdown 拼装。topic 标题属于内容语义，
仍由模型或医学团队定义；服务器只约束结构。该改造是降低格式随机性的 P2，不是当前
长尾问题的首要性能修复。

### 6.9 P2：评估上游冗余，但禁止盲目跨供应商重放

当前生产 Research 路径只使用经过批准的 `goldencode`/GLM-5.2 配置。候选 provider 或
模型只能在以下条件满足后进入评估：

- 取消传播已经验证，不会把同一长调用同时留在两个 provider；
- 使用同一批医学团队认可病例、同一 Skill、同一闭合证据和同一硬验证器；
- 分别记录 provider 首事件、完成时长、契约成功率、token 和人工内容结果；
- 至少积累 5–10 次当前基线 run，使切换决策有对照数据；
- 通过重复 E2E 和医学团队人工审核后才进入生产池。

直接把 Research 改用 Max、Codex 或另一个模型不是低风险“性能优化”，而是新的受控评估。

### 6.10 P2：由医学团队决定软完整度策略

`1.6.72` 的第五次基线运行在纠错 provider 超时并完成取消后，确定性回退最终只剩
`review_topic_section_minimum:476/600`；历史 `1.6.58` 也出现过 `328/600`。可供
医学团队选择的业务策略包括：

- 继续坚持每主题 600 字，工程侧通过更稳定的生成和定向修复满足；
- 在证据确实不足时允许短章节，但明确证据边界且禁止通用文字灌水；
- 将逐主题最低字数改为总内容、核心主题覆盖和证据密度的组合标准；
- 为不同研究方向定义医学团队认可的章节最小要求。

在医学团队决定前，生产继续保留当前门槛。工程团队不应为了单次验收自行放宽。

## 七、分层验收方案

正式验收拆成五层，避免继续用一次 7–10 分钟真实 E2E 承担全部问题发现工作。

### 7.1 第一层：确定性单元和集成回归

- build、全量 Vitest、Python 测试和 `git diff --check` 全部通过；
- 取消传播、活动请求释放、数据库迁移和回滚兼容用例通过；
- 确认 `docs/research/采访skill/` 零 diff，bundle 摘要符合预期。

### 7.2 第二层：模型响应回放

- 不调用任何外部网络或模型；
- 同一 fixture 连续运行得到相同诊断、语义结果和 artifact SHA；
- 历史缺陷均有明确的“拒绝”或“修复后通过”预期；
- 新修复不得使任何已经通过的历史案例回退。

### 7.3 第三层：取消和遥测故障注入

- 注入 provider hang、500、429、断流和客户端断开；
- 证明 provider 能观察取消，且没有旧调用与 retry 重叠；
- 每种故障都能关联 Worker stage 和 Gateway request event；
- 所有故障在 10 分钟总上限内到达明确终态且不发布半成品。

### 7.4 第四层：小规模真实稳定性测试

病例和人工判断应由医学团队提供。建议至少包含：

- 同一认可病例连续 5 次，用于验证上游成功率和输出重复性；
- 至少 3 个医学团队认可的不同医生/研究方向，用于验证业务覆盖；
- 每次 run 均必须在 10 分钟内到达终态；
- 成功 run 必须恰好产生 3 MD + 1 TXT，manifest 大小和 SHA-256 完全匹配；
- 任何失败都记录到分片和 provider 级原因，不能用后续成功覆盖。

“连续 5 次”和“3 个病例”是工程侧建议的最低稳定性样本，不替代医学团队最终方案。

### 7.5 第五层：医学团队人工验收

医学团队完整阅读四个文件，重点确认：

- 医生身份和研究方向是否准确；
- 文献是否属于目标医生，而不是同名作者；
- 核心证据表的方法、结果和局限是否可读；
- 数值、比较、因果语气和引用是否一致；
- 五个问题与答案是否符合实际业务使用；
- 是否存在模板灌水、残句、指代不明或结论后残留内容。

只有五层全部通过，才可以把 `controlled-trial` 改为正式验收状态。

## 八、实施顺序和交付物

### 阶段 A：立即保持的生产边界

1. 保持 `1.6.72` 受限试用，不扩大用户范围。
2. 保持 570 秒硬截止、Worker concurrency 1 和 fail-closed artifact 发布。
3. 对用户明确展示失败类型和是否建议稍后重试。
4. 冻结新的边缘句式补丁、盲目模型切换和未经医学团队确认的门槛放宽。

### 阶段 B：两个并行的 P0 工程轨道（已完成）

| 轨道 | 主要交付物 | 进入下一阶段的门槛 |
| --- | --- | --- |
| B1 取消与遥测 | 非流式 abort 贯通、分层 deadline、调用关联、provider 首事件和取消字段、故障注入测试 | 无重叠调用；四类终态时间线可还原；构建和测试通过 |
| B2 离线回放 | 纯合成处理入口、fixture schema、首批历史缺陷案例、确定性 artifact 断言 | 无网络回放稳定；`known-invalid` 原目录未被加载；Skill 零 diff |

B1 和 B2 互不依赖，应并行推进。上线 B1 前必须做 Gateway 通用 chat 回归；B2 可以先使用
现有手写模型响应建立框架，未来再加入脱敏真实响应。

### 阶段 C：依赖回放保护的规则和修复改造（已完成）

1. 引入共享 contract policy 和 prose predicate。
2. 让 Prompt、分片验证、完整验证和 supplementer 共用规则源。
3. 把单章节失败改成带原文 SHA 和 evidence allowlist 的章节补丁。
4. 保留 JSON 完全不可解析时的一次有界格式/整分片重试；其他失败不做多轮自改。
5. 跑完全部回放后，再做一次真实受限 E2E。

### 阶段 D：数据驱动的 Prompt 优化（工程部分已完成）

1. 先去重证据和重复上下文，记录前后 token、首事件和完成时长。
2. 只有在回放、真实成功率和医学审核不回退时，才接受 Prompt 改造。
3. 在至少 5–10 次当前 provider 基线数据后，再决定扩容、恢复候选 pool member 或评估
   新模型。

建议按以下独立提交拆分，避免把高风险工作压进一次大改：

| 工作包 | 主要代码位置 | 必须新增或更新的验证 |
| --- | --- | --- |
| PR-1 非流式取消 | `apps/gateway/src/index.ts`、`services/chat-request-deadline.ts`，必要时新增通用 client-disconnect helper；同时覆盖 `/v1/chat/completions` 和 `/v1/responses` | `index.test.ts` 和 `responses-compat.test.ts` 的两条非流式断开测试、responses 流式防回退、deadline signal、active request/inflight 归零断言 |
| PR-2 调用时间线 | `packages/research-agent/src/model-client.ts`、`packages/store-sqlite/src/research-migrations.ts`、`research-store.ts`、Gateway observation/request-events | schema 升级兼容、旧库读取、成功/500/timeout/cancel 四类时间线测试 |
| PR-3 离线回放 | `packages/research-agent/src/workflow.ts`、新 replay 模块、`apps/research-worker/src/research-worker.test.ts`、新 fixture 目录 | 禁网运行、重复运行确定性、首批历史缺陷用例、`known-invalid` 排除断言 |
| PR-4 单一规则源 | 新 contract policy/prose rules 模块及 `workflow.ts` 调用点 | Prompt/fragment/final/supplementer 同源断言、所有回放通过、Skill digest 变化时 fail-closed |
| PR-5 定向章节修复 | 分片 parser、repair prompt、patch apply/validate 路径 | 原文 SHA 匹配、evidence allowlist、已通过章节字节不变、完整验证重跑 |
| PR-6 Prompt 优化 | 各分片 prompt builder 和 evidence projection | 改造前后 token/时延报告、回放零回退、医学 Skill 零 diff |

PR-1 和 PR-2 可在同一发布候选中联调，但应保持可独立回滚；PR-3 可以并行开发。PR-4
以后必须依赖 PR-3 的回放保护。PR-6 不得阻塞取消修复上线。

### 阶段 E：业务联合决策

1. 医学团队确认每主题 600 字等软完整度规则。
2. 医学团队提供代表性病例和人工验收清单。
3. 产品、医学和工程共同确定连续成功率门槛。
4. 满足第十章退出条件后再决定扩大用户范围。

## 九、职责分工

| 角色 | 负责事项 | 不应单方面决定的事项 |
| --- | --- | --- |
| 医学团队 | Skill、业务方法、证据表达、软完整度门槛、代表性病例和最终内容验收 | Azure 调度、容器、重试和文件存储实现 |
| 工程团队 | API、超时、取消、重试、缓存、确定性渲染、验证执行、可观测性、安全和备份 | 修改医学方法、降低医学硬门槛、臆造补写内容 |
| 模型/供应商负责人 | 模型容量、长尾时延、HTTP 500、provider SLA 和可用性 | 医学内容是否合格 |
| 产品/发布负责人 | 试用范围、失败提示、用户预期和正式发布决策 | 绕过安全验证强制发布文件 |

## 十、正式放量前的退出条件

在同时满足以下条件前，维持受限试用：

- Azure 当前部署和备份健康，公网仍只经 Nginx 暴露；
- 医学 Skill 仍为经医学团队确认的原始版本；
- `/v1/chat/completions` 和 `/v1/responses` 的非流式客户端断开都能够到达 provider，
  活动调用和并发计数正常释放；
- timeout/retry 故障注入证明同一分片没有新旧 provider 调用重叠；
- Worker stage 与 Gateway request event 可以关联，并能区分 provider 首事件、完成、取消和
  admission wait；
- 历史模型响应回放无需上游即可稳定复现，且所有已知内容缺陷都有明确断言；
- 代表性真实 E2E 全部在 10 分钟内终止；
- 达到双方同意的连续成功率和样本规模；
- 每次成功均产生恰好 3 MD + 1 TXT，manifest 哈希一致；
- 历史内容缺陷没有在当前版本复现；
- 医学团队完成四文件人工审核并签字确认；
- 临时 E2E 用户、API key、entitlement 和文件全部清理；
- 生产 runbook、API 文档和当前状态记录同步更新。

在此之前，最准确的对外表述是：**Doctor Research API 已在 Azure 上线受限试用，
具备 10 分钟硬截止、provider 取消、可还原时间线和医学质量 fail-closed 保护；当前
代表病例基线为 3/5 成功，且当前版本四文件尚未通过医学团队人工内容验收。**
