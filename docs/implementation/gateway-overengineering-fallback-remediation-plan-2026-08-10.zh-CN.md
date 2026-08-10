# Codex Gateway 过度设计、过度防御与静默 Fallback 整改实施计划

| 项目 | 内容 |
| --- | --- |
| 状态 | 实施中；M0、M1 已完成，M1 已部署 R760；M2 至 M7 尚未实施或部署 |
| 建立日期 | 2026-08-10 |
| 最后更新 | 2026-08-10 |
| 审查基线 | `6ca36cda2855a89d1e77e574e81a9a177daa4c96` |
| 适用范围 | Gateway、Doctor Research Worker、Research Agent、SQLite Store 及相关测试/配置 |
| 部署目标 | 仅 R760；Azure 不纳入本计划的修复部署 |
| 主要目标 | 消除“失败被加工成成功”、关键保护配置静默失效、特权写操作静默丢审计和 fallback 尝试不可见 |
| 非目标 | 不更换 provider，不放宽医疗证据门禁，不实现主动 artifact chunk，不借机重写整个 Gateway/Research 架构 |

本文是 2026-08-10 代码审查的实施跟踪文档。它不替代
[`system-status.md`](../operations/system-status.md) 的实际运行状态，也不授权修改
R760、CN1、Nginx、Docker、数据库或生产配置。代码完成和 R760 部署必须分别记录，
不能把其中一个状态自动推断为另一个。Azure 兼容栈不纳入本计划的实现、配置预检、
修复部署或验收；其最终同步、流量冻结和停机由独立退役流程跟踪。在退役事实发生前，
本文不把 Azure 预先记为“已下线”，也不授权提前停止现存服务。

相关文档：

- [`code-quality-remediation-plan-2026-04-30.md`](../code-quality-remediation-plan-2026-04-30.md)：通用代码质量与大文件拆分计划；
- [`goldencode-long-artifact-tool-call-incident-and-gateway-improvement-plan-2026-08-06.zh-CN.md`](./goldencode-long-artifact-tool-call-incident-and-gateway-improvement-plan-2026-08-06.zh-CN.md)：原生长工具调用及 `shadow/error/chunk` 背景；
- [`azure-vm-retirement-scope-inventory-2026-08-05.zh-CN.md`](./azure-vm-retirement-scope-inventory-2026-08-05.zh-CN.md)：Azure 完整退役范围和独立门禁；
- [`operational-experience.md`](../operations/operational-experience.md)：生产安全、fail-closed、发布与回滚经验；
- [`environment-access.md`](../operations/environment-access.md)：本地、R760 和遗留环境的安全操作边界。

## 1. 状态与更新规则

任务状态只使用以下值：

| 状态 | 含义 |
| --- | --- |
| 未开始 | 尚无实现 PR 或验证证据 |
| 进行中 | 已有负责人和工作分支/PR |
| 阻塞 | 有明确外部依赖或待决策项；必须记录解除条件 |
| 已完成 | 实现和本地验收完成；若涉及运行时，不代表已经部署 |
| 不实施 | 经审核决定不做；必须记录理由和批准人 |

每次更新任务状态时，应同时填写：

1. 负责人；
2. PR/commit；
3. 实际运行的测试及结果；
4. 如有部署，填写环境、release commit、回滚边界和 smoke 证据；
5. 未执行的门禁及原因。

不得在本文记录用户身份、完整 key、token、secret、提示词正文、模型完整输出或生产
env 值。配置审计只记录变量名、是否存在和是否合法。

## 2. 不可破坏的行为约束

以下约束优先于“成功率”和“尽量不报错”：

1. **Research fail-closed**：任何必需 synthesis shard 缺失、不可验证或 transport
   重试耗尽时，不得发布完整报告或 artifacts。
2. **成功必须真实**：`succeeded` 表示所有必需模型产物存在并通过独立质量门；warning
   不能替代失败状态。
3. **不得生成证据替身**：不能用固定综述、局限性、结论或核心证据话术替代缺失模型
   内容，也不能按文献序号机械地给新增话术附引用。
4. **修复必须受限**：JSON 编码、标点、完全重复段落和展示格式等语义无损修复可以保留；
   删除不支持内容后若必需字段、章节或证据覆盖不再完整，必须失败，不能再靠模板补齐。
5. **显式错误配置不能等同于缺失配置**：变量缺失可使用已批准默认值；变量存在但非法
   必须在启动或预部署检查阶段失败。
6. **特权写操作必须可追踪**：配额重置等管理操作不能在无持久审计证据的情况下静默
   返回成功；跨状态边界无法原子化时必须暴露部分完成状态。
7. **fallback 必须可见**：保留业务上合理的 provider fallback，但每次尝试、失败原因、
   最终选择和是否降级必须可查询。
8. **整改不等于重构授权**：行为修复、纯搬迁、抽象引入和配置清理分别提交；不得在同一
   PR 中顺手重命名、重排目录或重写无关代码。

## 3. 审查基线

### 3.1 已确认问题

| ID | 优先级 | 问题 | 当前证据位置 |
| --- | --- | --- | --- |
| F-01 | P1 | closing shard transport 重试耗尽后生成固定报告并继续成功 | `packages/research-agent/src/workflow.ts:3093-3156,5029-5143` |
| F-02 | P1 | deterministic normalization 通过删除、补写和机械引用把无效输出修成 `ok` | `packages/research-agent/src/workflow.ts:7668-7818,9638-10823` |
| F-03 | P1 | 非法 chat timeout 配置可退回 `0`，静默取消 total deadline | `apps/gateway/src/services/chat-request-deadline.ts:15-42,109-145` |
| F-04 | P1 | quota reset 跨多个状态顺序写入，audit insert 失败被空 `catch` 吞掉 | `apps/gateway/src/billing-admin.ts:640-678,2156-2191` |
| F-05 | P2 | image billing fallback 只持久化最终 attribution，中间失败尝试消失 | `apps/gateway/src/index.ts:4326-4372,4406-4419` |
| F-06 | P2 | `chunk` 被接受但等同 `error`，`canaryPercent` 被解析却无人消费 | `apps/gateway/src/index.ts:3398-3456`、`apps/gateway/src/services/provider-stream.ts:234-238,652-657` |
| F-07 | P3 | Research policy/version 在 store、配置、测试和 15 个 replay fixture 中重复，放大小改动范围 | `packages/research-agent/src/skill-definition.ts:29-42`、`packages/research-agent/src/replay.ts:170-203`、`packages/store-sqlite/src/research-store.ts:415-443` |

### 3.2 已运行的定向基线

2026-08-10 审查期间只运行了用于确认当前行为的定向测试；未运行全量 release gate：

| 测试 | 结果 | 说明 |
| --- | --- | --- |
| `apps/gateway/src/services/chat-request-deadline.test.ts` | 5/5 通过 | 当前测试明确接受非法 JSON 后 fallback |
| `apps/gateway/src/index.test.ts` image billing fallback 两项 | 2/2 通过 | 当前测试只要求保存最终成功 attribution |
| `apps/research-worker/src/research-worker.test.ts` `transport-double` | 1/1 通过 | 当前测试明确要求双重 transport 失败后任务成功 |

这些结果是行为基线，不是正确性验收。M0 必须重新运行完整基线。

## 4. 总体路线与主跟踪表

优先级沿用本次审查口径：P1 是内容完整性、保护机制或特权操作风险；P2 是故障可见性
和误导性配置；P3 是变更半径与维护性。优先级不等同于部署授权。

| 顺序 | 里程碑 | 核心交付 | 优先级 | 前置 | 负责人/目标日期 | 实现状态 | R760 | 证据/PR |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | M0 行为与配置基线 | 固定失败/成功语义、全量测试基线、R760 配置合法性预检 | P1 | 无 | Codex / 2026-08-10 | 已完成 | 不适用 | 本文 §5.1-§5.2 |
| 1 | M1 Research fail-closed | 删除 transport 成功兜底；限制 semantic normalization | P1 | M0 | Codex / 2026-08-10 | 已完成 | 已部署；限量验收 | `977639f`；本文 M1 R760 发布记录 |
| 2 | M2 关键配置 fail-fast | 区分缺失与非法配置；先预检再启用启动失败 | P1 | M0 | 待认领/待定 | 未开始 | 未部署 | 待填 |
| 3 | M3 quota reset 审计一致性 | 取消静默 audit 失败；明确部分成功/持久审计契约 | P1 | M0 | 待认领/待定 | 未开始 | 未部署 | 待填 |
| 4 | M4 fallback 可观测性 | image attempt ledger 与降级成功标记 | P2 | M0 | 待认领/待定 | 未开始 | 未部署 | 待填 |
| 5 | M5 删除死配置 | 拒绝未实现 `chunk`，移除未消费 canary | P2 | M2、环境清单 | 待认领/待定 | 未开始 | 未部署 | 待填 |
| 6 | M6 收敛 Research 版本元数据 | 单一版本所有权、去除 store 硬编码和 fixture 手工扩散 | P3 | M1 稳定 | 待认领/待定 | 未开始 | 未部署 | 待填 |
| 7 | M7 受控拆分巨型函数 | 只做等价搬迁，分离 transport、validation、assembly | P3 | M1-M6 | 待认领/待定 | 未开始 | 未部署 | 待填 |

M1、M2、M3 的代码可由不同 PR 独立推进，但部署顺序仍需按本表执行。M4 的完整
attempt ledger 不阻塞 M1 关闭危险内容兜底，因为继续收集样本的价值低于发布伪成功报告
的风险。

## 5. M0：行为契约、基线与预检

目标：在修改前固定什么是成功、失败和降级，并确认现有环境配置不会被 fail-fast 发布
意外阻断。

任务：

- [x] **M0-01** 运行并记录完整本地基线：

  ```powershell
  npm run typecheck
  npm run build
  npm test
  python -m unittest discover -s tests -p "test_*.py"
  ```

- [x] **M0-02** 在测试中建立结果状态矩阵，至少覆盖：
  - 所有必需 shard 完成且质量门通过 -> `succeeded`；
  - 任一必需 shard transport 重试耗尽 -> terminal failure、零 artifacts；
  - 仅展示格式缺陷且语义无损修复通过 -> `succeeded` + 明确 warning；
  - 删除不支持内容后必需章节/字段不完整 -> terminal failure；
  - provider fallback 成功 -> 业务成功，但标记 degraded 并保存所有 attempts。
- [x] **M0-03** 对 R760 protected env 和仓库内受支持的配置示例做只读配置预检，只记录
  变量名、存在性和解析结果，不输出值。
- [x] **M0-04** 确认并记录 `MEDCODE_CHAT_REQUEST_TIMEOUT_MS=0` 是否仍是被批准的显式
  禁用语义。若无明确批准，M2 不得自行改变它的产品含义，只修复“非法值变成 0”。
- [x] **M0-05** 为后续 PR 固定范围模板：问题 ID、in-scope、out-of-scope、行为变化、
  数据/schema 影响、测试、部署和回滚。

验收：

- 全量基线结果已写入 PR 或本文变更日志；
- 现有失败被单独记录，不能在后续 PR 中顺手修复；
- R760 配置预检不包含 secret 值；
- 结果状态矩阵得到产品/医疗质量负责人确认。

### 5.1 M0 执行记录（2026-08-10）

本次只建立基线和契约，没有修改业务代码、schema、生产配置或运行状态，也没有检查或操作
Azure。审查工作区基于 commit `6ca36cda2855a89d1e77e574e81a9a177daa4c96`；R760
只读检查时观察到 `current` 指向 release
`abb137325bfddda7cb5621bbffb202a040f5bd12`，四个 Compose 服务均为 healthy。两者用途不同：
前者是本次代码审查基线，后者只是当时的生产观测，不表示本地代码已经部署。
预检完成后的最终只读核对显示四个服务均为 `running/healthy`，restart count 均为 `0`。

完整本地门禁：

| 门禁 | 结果 | 备注 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 无 TypeScript 错误 |
| `npm run build` | 通过 | 全 workspace 构建完成 |
| `npm test` | 通过 | 43 个文件通过、1 个文件跳过；676 项通过、2 项跳过 |
| Python contract suite | 通过 | `python -m unittest discover -s tests -p "test_*.py"`：51/51 通过 |

Vitest 唯一跳过的文件是
`apps/gateway/src/long-task-regression.test.ts`，其中两项 external fixture 测试仅在
`MEDCODE_LONG_TASK_FIXTURE_DIR` 存在时运行；本次基线未配置该外部 fixture。没有既有失败。

结果状态矩阵以现有可执行测试为锚点，不另建重复测试框架，也不提交明知失败的红测；需要改变的
断言由对应行为 PR 在同一提交中翻转：

| 场景 | M0 基线证据与结果 | 已批准目标 | 归属 |
| --- | --- | --- | --- |
| 所有必需 shard 与质量门通过 | `apps/research-worker/src/research-worker.test.ts:175`：`succeeded`，发布 4 个经校验 artifact | 保持 `succeeded` 与 4-artifact contract | 回归门禁 |
| 必需 closing shard 两次 transport 均失败 | 基线 `apps/research-worker/src/research-worker.test.ts:391,395,1990` 仍断言 `succeeded`，并记录 deterministic fallback warning | terminal failure；零 artifacts；无完整 result；保留脱敏 transport/validation 诊断 | M1-A（本地已完成） |
| 仅 fragment envelope/展示结构可无损修复 | 同一参数化测试的 `body-envelope`、`closing-envelope`：当前成功并带具名 warning | 仅 presentation repair 可继续成功，warning 必须可见 | M1-B |
| 删除不支持内容后必需字段、章节或证据覆盖不足 | `apps/research-worker/src/research-worker.test.ts:3675,3852,4022` 已覆盖部分 fail-closed 路径；其他 deterministic filler 路径仍可能成功 | 一律 terminal failure、零 artifacts；不得用模板补齐 | M1-B |
| provider fallback 最终成功 | `apps/gateway/src/index.test.ts:954,1013`：当前只验证最终成功 attribution | 业务成功，但持久标记 degraded 并保留全部 attempts | M4 |

D-01 的公开行为由需求方在本轮确认：任何必需 Research shard 重试耗尽均 terminal failure，且
不得发布 artifacts。对显式 timeout `0` 未找到独立的产品批准记录，因此 M2 采用最小变更边界：
暂时保持当前“显式 `0` 禁用默认 total deadline”的行为，只修复“非法值静默变成 `0`”；若要
删除显式 `0`，必须另行做产品决策，不能夹带在 fail-fast 修复中。

R760 与仓库示例配置预检结果（全部值已脱敏）：

| 检查面 | 存在性/解析结果 |
| --- | --- |
| protected env 文件权限 | `gateway.container.env`、`research.production.llm-gateway.env` 均为 `0600`；未读取或输出 secret 值 |
| public Gateway 有效进程环境 | 六个目标变量均未显式设置，均落入已知默认；整体合法 |
| Research LLM Gateway 有效进程环境 | `MEDCODE_CHAT_REQUEST_TIMEOUT_MS` 已设置、非空且合法；timeout JSON 未设置；native file recovery 变量未设置；整体合法 |
| 仓库示例 | 8 份 `config/*.example.env` 全部可解析；仅 Research production LLM Gateway 示例显式包含目标 timeout 变量且合法，其他目标变量均缺失并使用默认 |

预检脚本只输出变量名、存在性、合法性、非敏感的有效 mode 和 map 条目数；已用默认、合法、非法
三组合成输入自测，并在检查后删除。R760 未写文件、未重启或重建容器、未改 env。

### 5.2 后续 PR 固定范围模板

后续每个整改 PR 必须在描述中填写以下最小字段；不为此再引入新配置系统或流程框架：

```text
问题 ID：
行为变化：
In scope：
Out of scope：
数据 / schema 影响：无 / 说明迁移与兼容读取
配置影响：无 / 说明缺失、非法和显式值的语义
测试证据：定向门禁 + 全量门禁
部署目标：仅 R760 / 不涉及运行时
回滚边界：
```

## 6. M1：Doctor Research fail-closed

M1 分两个独立 PR。M1-A 先停止最危险的 transport fallback；M1-B 再收紧
normalization。禁止合并成一次工作流重写。

### M1-A：停止 closing transport “成功兜底”

任务：

- [x] **M1A-01** closing shard transport 重试耗尽时返回稳定 terminal reason，例如现有
  `model_contract_error`/`upstream_unavailable` 分类中的准确一类；不要增加含糊的
  `UnknownError`。
- [x] **M1A-02** 删除 `buildDeterministicClosingTransportFallback` 的成功调用路径；若函数
  无其他调用，同 PR 删除死实现和只服务它的测试数据。
- [x] **M1A-03** 将 `transport-double` 测试从 `outcome: succeeded` 改为 terminal failure，
  并断言零 artifacts、无完整 result、保留安全的 validation/transport diagnostic。
- [x] **M1A-04** 确认 foundation/body/closing 任一必需分片缺失时行为一致，不为某个分片
  保留特殊成功出口。
- [x] **M1A-05** 不新增新的 recovery feature flag；紧急回退使用现有 Research admission/
  feature 开关。

验收：

- 双重 transport 失败不能得到 `succeeded` 或 `passed_with_warnings`；
- 不生成固定 synthesis、limitations、conclusion，也不产生引用替身；
- 成功路径的报告与 artifact contract 不变；
- Worker 不因可分类的 terminal run 进入无界重启或重复执行。

#### M1-A 执行记录（2026-08-10）

状态：本地实现和验收已完成，尚未创建 commit/PR，未部署 R760。生产运行态仍是部署前行为，
不能根据本节推断线上已经 fail-closed。

实现严格限定在 F-01：

- closing shard 的一次有界 transport retry 再次失败后，保留原始
  `ResearchModelClientError`，由现有映射返回
  `outcome=failed`、`reason=upstream_unavailable`、`retryable=false`；不会启动整次 run replay；
- 删除 `buildDeterministicClosingTransportFallback`、对应成功 warning 和只为该 fallback
  放宽聚合正文下限的分支；没有增加错误类型、feature flag、配置或 schema；
- foundation、body、closing 均通过同一个 `terminalShardError` 出口失败；重叠的 body/closing
  故障在各自有界重试都成功时仍可继续；
- `transport-double` 现在断言两次 stage-run 错误诊断仍持久化、完整 result 不存在、数据库
  artifact 行为零且 artifact 目录不存在；
- 同步修正当前 Doctor Research README；历史事故、生产状态和既有 replay fixture 未改写。

测试证据：

| 门禁 | 结果 |
| --- | --- |
| 目标测试先行 | 修改断言后按预期红：实际仍为 `succeeded`，且继续发生第 5 次模型调用 |
| `transport-double` | 修复后 1/1 通过；终态为 `upstream_unavailable`，两次脱敏 transport diagnostic 保留，零 result/artifacts |
| `transport-double` + `transport-middle-and-closing` | 2/2 通过；耗尽失败与有界恢复路径同时受保护 |
| Research Worker | `apps/research-worker/src/research-worker.test.ts`：90/90 通过 |
| Research Agent、replay、Research routes | 3 个文件、77/77 通过 |
| `npm run typecheck` / `npm run build` | 通过 |
| `npm test` | 43 个文件通过、1 个 external-fixture 文件按条件跳过；676 项通过、2 项按条件跳过 |
| Python contract suite | 51/51 通过 |
| diff / 死引用检查 | `git diff --check` 通过；活动源码、测试和当前 README 中无已删除 fallback 标识符 |

回滚边界不是恢复固定报告 fallback。若上线后出现不可接受回归，应关闭现有 Doctor Research
admission 并 roll forward；本次没有执行部署、smoke、远程写入或 Azure 操作。

### M1-B：限制 deterministic normalization

任务：

- [x] **M1B-01** 给每类 normalization 标记 `presentation` 或 `semantic`：
  - `presentation`：JSON 编码、平衡符号、完全重复段落、展示枚举；
  - `semantic`：删除实质性 claim、替换核心证据字段、补写段落、补写章节、分配引用。
- [x] **M1B-02** 成功发布路径只允许已批准的 presentation repair；semantic repair 不得把
  原始失败变成成功。
- [x] **M1B-03** 移除或隔离 `supplementReviewEvidenceBoundary`、
  `supplementReviewSkillSectionBoundaries` 和 `closeEmptyCoreEvidenceFields` 在最终成功验证
  中的填充作用。若保留用于草稿展示，产物必须明确不可发布且不带伪引用。
- [x] **M1B-04** 删除不支持的数字/claim 后重新运行完整 validator；任何必需长度、章节、
  核心字段或证据覆盖不足都必须失败。
- [x] **M1B-05** 保存第一次失败的稳定 error codes；后续 repair 不能覆盖原始诊断。
- [x] **M1B-06** 增加负向测试：固定模板不能补齐最低篇幅，空 core evidence 不能用默认
  话术变为通过，新增文字不能按位置自动获得引用。

验收：

- validator 不再依赖自己生成的 filler 来证明结果通过；
- 所有成功报告正文均可追溯到模型输出和闭合证据，不包含服务器生成的医学综述替身；
- 现有 presentation-only 修复仍有精确测试；
- Research 完整定向测试、replay fixture 和 Python contract suite 通过。

发布与回滚：

- 先在干净 release 和隔离状态上验证，再部署 R760；本计划不向 Azure 发布修复；
- 真实 smoke 必须使用批准的临时用户/key，完成后撤销并确认零残留；
- 若 M1 导致不可接受回归，优先临时关闭 Doctor Research admission 并修正，不得回退到
  会发布固定报告的旧行为。

### M1-B 执行记录（2026-08-10）

本次只收紧本地 Doctor Research 归一化与发布契约，没有修改 public result schema、配置、
数据库或运行环境。成功路径的分类和处理结果如下：

| 分类 | 处理 | 发布条件 |
| --- | --- | --- |
| Presentation | 保留有界 JSON 字符串编码修复、唯一无歧义 envelope、括号平衡、完全重复段落删除和行内枚举格式化 | 原始稳定错误码必须全部属于 presentation 集合；修复后重新通过完整 schema、Skill、证据、引用、长度和 artifact 门禁 |
| Semantic | 删除 claim/数字、改写证据标签、补答案、补摘要/段落/章节、删除欠长章节、给服务器新增文字分配引用 | 不再允许服务器修成成功；只能由现有有界模型纠错返回合格内容，否则 terminal failure、零 artifacts |
| 可信投影 | verified profile 与分片模式 core evidence 继续由闭合官方/PubMed 证据投影 | 不是缺失模型分片的替身，且仍通过完整 validator；M1-A 的必需分片 fail-closed 不变 |

具体变更：

- `validateGeneratedOutput` 的二次入口改为具名 `presentationRepair`；混合或 semantic 错误不会
  进入展示修复，第一次失败的稳定错误码继续保存在 validation/stage diagnostics 中；
- 删除最终发布路径的 semantic normalizer 及固定模板/机械引用实现，包括
  `normalizeFinalModelOutputForSafety`、`supplementReviewEvidenceBoundary`、
  `supplementReviewSkillSectionBoundaries`、`supplementNearMinimumBodySections`、
  `closeReviewReferenceCitations` 和 `closeEmptyCoreEvidenceFields`；
- 删除摘要/章节近阈值补写、欠长可选主题删除、答案长度填充/截断、数字 claim 自动删除和
  结论纠错后的服务器数字清理；保留现有有界模型重试与 section/QA 修复，模型结果仍须完整验证；
- 任一 QA source ID 超出闭合证据时不再删除未知 ID 后接受；原 QA payload 被拒绝，只有
  QA-only 模型纠错能恢复；
- 空白 core evidence 字段新增稳定 `core_evidence_field_contract`，避免 `minLength: 1` 接受
  纯空白字符串；中文数量转 Arabic 只用于让精确数字门禁可见，不补内容、不放宽答案长度；
- replay 中 unsupported numeric、orphaned demonstrative、truncated comparison、结论后 QA、
  混合 presentation/semantic 缺陷等旧伪成功场景均改为失败且零 artifacts；唯一括号、JSON
  编码和无歧义 envelope 等纯 presentation 场景仍成功并带具名 warning。

测试证据：

| 门禁 | 结果 |
| --- | --- |
| 目标测试先行 | semantic filler、机械引用、未知 QA source、重复因果过度主张等旧成功断言按预期变红；空白 core evidence 在删除 filler 后仍暴露为成功，新增独立字段门禁后转绿 |
| Worker + replay | `apps/research-worker/src/research-worker.test.ts`、`packages/research-agent/src/replay.test.ts`：117/117 通过 |
| Research Agent、replay、Research routes | 3 个文件、77/77 通过 |
| `npm run typecheck` / `npm run build` | 通过 |
| `npm test` | 43 个文件通过、1 个 external-fixture 文件按条件跳过；677 项通过、2 项按条件跳过 |
| Python contract suite | 51/51 通过 |
| diff / 死引用检查 | `git diff --check` 通过；活动源码、测试和当前 README 中无已删除 semantic normalizer/filler 标识符 |

本次没有部署 R760，没有运行真实用户 smoke，没有远程写入，也没有检查或操作 Azure。
回滚不得恢复服务器语义补写；若上线后成功率不可接受，应使用现有 Doctor Research admission
边界停止新任务并 roll forward 修正。

### M1 R760 发布记录（2026-08-10）

M1-A、M1-B 与发布版本闭合在 clean commit
`977639f4161f99c8f2a8282e1f804c48698b5cec`。运行时版本为 Skill `1.6.106`、prompt
`v31`、workflow `v83`、validation `v44`；没有 schema、artifact policy、provider、模型、
医疗 Skill 或 Azure 变更。发布前 `typecheck`、build、677 项 Vitest、51 项 Python contract
与 diff check 均通过；2 项依赖外部 fixture 的测试按既有条件跳过。

R760 只重建 public Gateway 与 Research Worker：

| 项目 | 实际结果 |
| --- | --- |
| release | `/opt/codex-gateway-r760/releases/977639f4161f99c8f2a8282e1f804c48698b5cec` |
| Gateway image | `sha256:6b9ee9bdfd7edcc5e8dfc03575aa52c2ec733038cc200ad73d778c5e6dafb8f0` |
| Worker image | `sha256:4651fadd9ff284cfce5959e8538b3d6fad936ca6386947c352a34c680fd07501` |
| 未变服务 | Research LLM Gateway `sha256:99fc3789ae0920538e3fba202476b8a50162f1d110894cbfa5e26b6cfc012c6a`；maintenance `sha256:dc76e04777f3c8a2b4ff5e5d2931d72643b76af26950cbd89b92550d619451cb` |
| 回滚边界 | `/data/codex-gateway-r760/backups/pre-977639f-20260810T025725Z`；旧 Gateway/Worker image tag、旧 Worker env、public Gateway 与 Research SQLite 快照 |
| Azure | 未检查、未写入、未部署 |

第一次正式切换在创建 Worker 时发现新 release 缺少历史发布已有的
`secrets -> /opt/codex-gateway-r760/shared/secrets` 链接。自动回滚恢复了旧 env、image tag 和
release link，但因当时 `current` 是只重建过 Gateway 的 `abb1373` release，使用它重建旧
Worker 时遇到同一缺失链接，造成一次短暂服务中断。随后使用已验证旧 Gateway/Worker 镜像、
`1.6.105` env 和同一个受保护 shared secret 目录恢复，两容器回到 healthy/restart 0；数据库
未迁移。补齐新 release 的同构只读链接后，第二次切换成功。secret 内容和 `999:999/0400`
宿主机权限均未修改或输出。

按需求方要求，本次生产验收限制为最小集合，不执行 Azure、图片、Billing、容量/压力、取消、
越权、遍历或多轮成功率矩阵：

| 验收 | 结果 |
| --- | --- |
| public health | `ready / goldencode / r760-loopback` |
| public `goldencode` 非流式文本 | 通过；request `chatcmpl_c6eb870c141f4db497f30629e31d8abe` 返回非空内容 |
| Doctor Research | run `drr_e4d8e73f636942d8955b619204136db3` 在五次有界模型阶段后以 `model_contract_error` 失败；Skill `1.6.106`、prompt `v31`；零 result、零 artifact |
| fail-closed 结论 | 通过：不合格模型内容没有被 semantic filler、机械引用或固定报告加工成成功 |
| 四产物成功路径 | 本次未实证；遵守单次 Research E2E 边界，不追加重试来筛选成功样本 |
| 清理 | 临时 key 已 revoked、entitlement 已 cancelled、用户已 disabled；active credential 与 live entitlement 均为 0，临时 token/request/download 目录已删除 |
| 最终状态 | 四个服务均 running/healthy、restart 0；public/internal reservation、active/needs-input run 均为 0；三库 integrity `ok`、外键违规 0 |

因此当前事实是“代码与部署完成，危险伪成功路径及真实 fail-closed 已验证”，不是“真实四产物
成功路径全绿”。若需要证明发布成功率，应另行批准代表性样本与明确次数；不得把重复运行直到
成功当作本次验收，也不得为提高成功率恢复已删除的 semantic fallback。

## 7. M2：关键配置 fail-fast

任务：

- [ ] **M2-01** 让 timeout parser 区分 `undefined/空白` 与“存在但非法”。
- [ ] **M2-02** 非法 `MEDCODE_CHAT_REQUEST_TIMEOUT_MS`、
  `MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON` 或其字段必须抛出启动错误；不能退回 `0`、空 map
  或部分策略。
- [ ] **M2-03** 对 native file tool 的 mode、soft/hard bytes 和百分比采用同一原则：非法值
  或 `hard < soft` 必须拒绝启动，不能忽略 hard limit。
- [ ] **M2-04** 缺失变量仍使用已记录的默认策略；若显式 `0` 被批准，必须有单独测试，
  证明它与非法值不同。
- [ ] **M2-05** 增加 startup/config 单测，覆盖缺失、空白、非法 JSON、非法整数、越界、
  mode 拼写错误和相互矛盾的阈值。
- [ ] **M2-06** 部署前先在 R760 当前 protected env 上运行只打印变量名/合法性的
  preflight，再发布 fail-fast 代码。

验收：

- 显式非法配置不能启动 Gateway；
- 缺失配置行为与批准的默认策略一致；
- 预部署检查不会打印 env 内容或 secret；
- `public-model-registry` 等现有 fail-fast 配置行为不回归。

发布注意：fail-fast 代码不能在配置预检之前上线。若部署后启动失败，应修正配置并使用
既有 release/backup 回滚边界，不能为了启动而重新引入静默 fallback。

## 8. M3：quota reset 审计与部分成功契约

M3 也分为小修和持久一致性两步，避免直接引入不必要的分布式事务框架。

### M3-A：消除静默失败

- [ ] **M3A-01** 删除 `recordBillingQuotaResetAudit` 的空 `catch`。
- [ ] **M3A-02** audit store 缺失或 insert 失败时写入脱敏 error log/metric；不得记录 token、
  完整 key、手机号或原始请求正文。
- [ ] **M3A-03** 响应或错误 contract 必须明确 audit 是否成功；已发生的 quota mutation
  不能继续返回无条件普通 200。
- [ ] **M3A-04** 增加 throwing audit store、缺失 audit store 和正常成功测试。

### M3-B：定义可实现的一致性边界

- [ ] **M3B-01** 核对 request limiter、token quota 和 admin audit 的实际存储边界。
- [ ] **M3B-02** 只选择以下最小可行方案之一，并在 PR 中记录理由：
  - 同一 SQLite 边界可覆盖的部分使用事务；
  - 跨内存/SQLite 边界使用 durable audit intent + 明确的逐组件结果；
  - 若操作天然幂等，返回带 operation id 的 `partial_failure` 并提供只读核对路径。
- [ ] **M3B-03** 禁止为单个管理操作引入通用 saga、消息总线或新的分布式协调服务。
- [ ] **M3B-04** 增加 request reset 成功/token reset 失败、token reset 成功/audit 完成失败等
  故障注入测试。

验收：

- 不存在“状态已改变、审计丢失、响应仍普通成功”的路径；
- partial failure 可由 operation id 或明确字段核对；
- 重试语义有测试，不会因模糊 500 造成不可辨认的重复操作；
- Billing Admin 现有鉴权、安全 header 和脱敏规则不变。

R760 是控制权威端。生产 smoke 必须在 R760 使用临时对象完成，并按现有权威流程清理；
Azure 不执行本计划的控制写入或 smoke。

## 9. M4：fallback attempt 可观测性

任务：

- [ ] **M4-01** 优先复用现有 provider attempt/request observation contract；除非现有 schema
  无法表达，不新建独立 tracing 系统或表。
- [ ] **M4-02** 为每个 image attempt 持久化顺序、provider、upstream model/account、开始/
  结束、脱敏 outcome/error code 和是否最终选中。
- [ ] **M4-03** 最终 request event 明确标记是否使用 fallback。可选择
  `degraded_success` 或向后兼容的 `status=ok + degraded=true`，但查询/API 必须能可靠区分。
- [ ] **M4-04** attribution 不再覆盖并丢失先前尝试；最终 attribution 仍保持当前兼容字段。
- [ ] **M4-05** 更新两项现有 image fallback 测试，断言 primary、每个 fallback 和最终成功均
  存在，同时断言不保存 API key、prompt 或图片正文。
- [ ] **M4-06** 更新 admin CLI/ops 查询，使运营人员能够回答“哪个 provider 首先失败、为何
  fallback、最终落到哪里”。

验收：

- primary 和中间 fallback 失败不再从持久证据中消失；
- 不改变本 PR 的 fallback 顺序、最大尝试次数、计费路由或 provider 选择；
- usage/report 查询不会把 attempt 数误计为用户请求数；
- schema 变更具有向后兼容读取和回滚说明。

## 10. M5：删除未实现配置面

任务：

- [ ] **M5-01** 只读确认 R760 及仓库示例配置中
  `MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE` 和 canary 变量的存在性/合法性，不输出值。
- [ ] **M5-02** 在主动 chunk 协议真正实现前，配置 parser 对 `chunk` 明确报 unsupported，
  不再接受后退化成 `error`。
- [ ] **M5-03** 删除没有运行时消费者的 `canaryPercent` 类型、解析、测试和示例配置。
- [ ] **M5-04** 保留历史实施文档中的审计记录，但明确标注已废弃；不要重写历史部署事实。
- [ ] **M5-05** 搜索所有代码、配置、部署模板和运行文档，确认没有活跃消费者。

验收：

- 运行时代码不再暴露“看似可用、实际未实现”的 chunk/canary 接口；
- 本里程碑不实现 artifact chunk、capability negotiation 或 Desktop 协议；
- `shadow/error` 等仍被批准的现有行为有回归测试；
- 部署前环境清单确认不会因删除变量意外阻断启动。

## 11. M6：Research 版本元数据单一所有权

任务：

- [ ] **M6-01** 以 `doctorResearchSkillDefinition` 为唯一业务版本来源；SQLite store 不反向
  依赖 research-agent 包。
- [ ] **M6-02** 通过调用参数把 skill/prompt/workflow/validation/schema 版本传入 store，
  删除 `research-store.ts` 中的业务版本字面量。
- [ ] **M6-03** 将 replay 场景内容与“当前 policy 兼容性清单”分离。fixture 应保留它代表的
  场景，不因每次版本 bump 手工修改 15 份同类字段。
- [ ] **M6-04** 如使用生成文件，生成器必须确定性、可 diff、默认不改场景正文；Skill bundle
  digest 变化仍需显式 review，不能盲目自动批准。
- [ ] **M6-05** 增加一致性测试，发现 runtime、store receipt、配置示例和 replay manifest
  版本不一致时失败。
- [ ] **M6-06** 用一次测试性 policy bump 验证：不再需要手工修改全部 replay JSON，且
  变更文件中没有无关格式重排。

验收：

- 业务版本只有一个手工维护源；
- store 通过依赖注入接收版本，不形成 package 循环；
- policy bump 的 diff 主要反映实际策略和集中 manifest 变化；
- 历史 replay 的可审计性和 bundle review 要求保留。

## 12. M7：最后进行受控结构拆分

只有 M1-M6 行为稳定并完成至少一个批准的观察窗口后，才允许开始 M7。

候选边界：

- shard admission、transport retry 和 terminal classification；
- fragment parsing/contract validation；
- presentation-only repair；
- quality gate 与 error code 汇总；
- result assembly、warning 去重和 artifact publication；
- Gateway route 注册与 chat/image orchestration。

执行约束：

- [ ] **M7-01** 每个 PR 只搬迁一个职责边界，不同时改变状态、重试次数、warning、错误码、
  prompt、质量阈值或输出文本。
- [ ] **M7-02** 优先抽取纯函数和已有重复逻辑，不引入 factory、strategy registry、通用
  workflow engine 或新配置系统。
- [ ] **M7-03** 搬迁前后运行相同 fixture，并比较 terminal outcome、warnings、artifacts、
  provider attempts 和持久化结果。
- [ ] **M7-04** 每个新模块必须有明确单一消费者或独立测试价值；只为假想未来 provider
  建立的接口不接受。
- [ ] **M7-05** 若某次拆分需要同时修改医疗规则，停止该 PR，把规则变化返回 M1 的独立
  行为 PR。

验收不使用“文件必须少于 N 行”作为目标。完成标准是：职责边界可独立测试、行为 diff
为零、后续修复不再需要跨越完整 2,000 行状态机定位。

## 13. 回归与发布矩阵

### 13.1 每个 PR 的最低门禁

| 变更 | 必跑定向测试 |
| --- | --- |
| M1 Research | `apps/research-worker/src/research-worker.test.ts`、`packages/research-agent/src/research-agent.test.ts`、replay tests、Research route tests |
| M2 配置 | `apps/gateway/src/services/chat-request-deadline.test.ts`、Gateway startup/config tests、provider-stream tests |
| M3 quota reset | Billing Admin route tests、Gateway integration tests、store audit tests |
| M4 image attempts | Gateway image fallback tests、request event/store tests、admin CLI event/report tests |
| M5 配置删除 | Gateway config/startup tests、provider-stream tests、配置/Compose contract tests |
| M6 版本元数据 | Research Agent、Research Store、Gateway route、replay 和 Python Docker contract tests |
| M7 等价拆分 | 被搬迁模块全部定向测试 + 全量 fixture 等价比较 |

所有行为敏感 PR 合并前：

```powershell
npm run typecheck
npm run build
npm test
python -m unittest discover -s tests -p "test_*.py"
git diff --check
```

如果有测试跳过或既有失败，必须记录测试名和原因，不能只写“基本通过”。

### 13.2 部署门禁

1. 从精确 clean commit 构建，不在历史脏 checkout 中部署；
2. 先完成 protected env 的变量名/合法性预检，不打印值；
3. 按现有运行手册建立数据库/config/image 回滚边界；
4. 只重建受影响服务，保留 Research overlay 和现有 volume；
5. R760 验证 public `goldencode`、Research、Billing Admin 或 image 中实际受影响的路径；
6. smoke 脚本串行运行，临时用户/key/entitlement/artifact 必须清理；
7. 记录容器健康、restart count、SQLite integrity/FK、未完成 reservation/run；
8. 不把本计划修复部署到 Azure；Azure 的最终同步、写冻结、流量切离和停机由独立退役
   计划执行，不能因为本计划删列而跳过退役门禁；
9. R760 实际部署后才更新 `system-status.md`；不得预写“已部署”。

## 14. 风险与回滚策略

| 风险 | 预防 | 回滚原则 |
| --- | --- | --- |
| M1 后 Research 成功率下降 | 把真实失败与伪成功分开统计；先跑故障注入和批准 E2E | 优先关闭 admission/roll forward，不恢复固定报告 fallback |
| M2 fail-fast 导致启动失败 | 代码发布前检查所有目标环境配置 | 修正配置或回到上一 verified release；不得临时忽略非法值 |
| M3 管理 API contract 改变调用方行为 | 保留明确错误码和逐组件结果；增加兼容测试 | 回滚代码前核对是否已有 schema/审计 intent；不删除审计记录 |
| M4 schema/query 不兼容 | additive migration、旧行可读、attempt 不计为请求 | 回滚 reader/writer 到兼容版本，保留已写 observation |
| M5 删除仍被使用的变量 | 先做环境和仓库消费者清单 | 恢复精确 parser 支持，不实现虚假的 chunk 行为 |
| M6 引入 package 循环 | 版本由调用方注入 store | 回滚纯源码变更；fixture 历史内容不做破坏性重写 |
| M7 scope creep | 一职责一 PR、行为 diff 为零 | 回滚单个搬迁 PR，不与行为修复捆绑 |

## 15. 决策记录

| ID | 待决策事项 | 推荐答案 | 状态 | 决策人/日期 |
| --- | --- | --- | --- | --- |
| D-01 | Research 必需 shard 耗尽后的公开状态 | terminal failure，零 artifacts | 已确认 | 需求方 / 2026-08-10 |
| D-02 | 显式 timeout `0` 是否继续允许 | 未找到独立产品批准记录；M2 暂不改变现有显式 `0` 语义，只禁止非法值变成 `0` | 范围已冻结；产品语义待另行确认 | M0 实施边界 / 2026-08-10 |
| D-03 | quota reset 跨内存/SQLite 的一致性模型 | durable intent + 显式部分结果；不引入通用 saga | 待验证存储边界 | 待填 |
| D-04 | fallback 成功的持久状态字段 | 优先向后兼容字段，同时确保查询可区分 degraded | 待确认 | 待填 |
| D-05 | Azure 是否部署本计划修复 | 不部署；Azure 只按独立退役计划完成最终同步、冻结和停机 | 已确认 | 业务方 / 2026-08-10 |

## 16. 完成定义

本计划只有同时满足以下条件才可标记完成：

- F-01 至 F-07 均有对应 PR/“不实施”决策和证据；
- Research transport/质量失败不会产出服务器生成的报告替身；
- 显式非法关键配置无法静默关闭 deadline 或 hard protection；
- quota reset 不再存在空 audit catch，部分成功可查询；
- image fallback 的每次尝试和降级状态可持久查询；
- 未实现 chunk/canary 不再作为可用运行配置暴露；
- Research 版本 bump 不再要求手工修改全部 replay fixture；
- M7 如实施，所有拆分 PR 均为行为等价且未引入新框架；
- 全量 TypeScript、Vitest、Python contract 和 diff check 门禁通过；
- R760 release、回滚边界、smoke 和观察结果已记录；
- 相关运行文档只在事实发生后更新，无 secret、用户正文或凭据泄漏。

## 17. 变更日志

| 日期 | 事项 | 状态变化 | 证据/备注 |
| --- | --- | --- | --- |
| 2026-08-10 | 建立本计划 | 文档建立；所有实施里程碑保持未开始 | 基于 `6ca36cd` 本地只读审查；定向行为基线 8/8 通过；未修改运行环境 |
| 2026-08-10 | 收敛部署目标 | Azure 从整改实施、配置预检和部署跟踪中移除；D-05 已确认 | R760 是唯一部署目标；Azure 下线仍遵循独立退役门禁，本文未修改任何运行环境 |
| 2026-08-10 | 完成 M0 行为与配置基线 | M0 从未开始变为已完成；D-01 已确认，D-02 冻结最小变更边界 | TypeScript/typecheck/build、676 项 Vitest、51 项 Python 测试通过；2 项 external fixture 测试按条件跳过；R760/8 份示例配置脱敏预检合法；无部署或运行时写入 |
| 2026-08-10 | 完成 M1-A Research transport fail-closed | M1 从未开始变为进行中；M1-A 已完成、M1-B 未开始；R760 未部署 | 删除 closing 固定报告生成器及专属放宽分支；目标测试、90 项 Worker、77 项 Research 定向、676 项全量 Vitest 和 51 项 Python 测试通过；无 schema/config/运行时/Azure 变更 |
| 2026-08-10 | 完成 M1-B presentation-only 发布契约 | M1 从进行中变为已完成；M1-A、M1-B 均完成；R760 未部署 | 删除 semantic normalizer、固定段落/章节/答案 filler 和机械引用；空白 core evidence fail-closed；117 项 Worker/replay、77 项 Research 定向、677 项全量 Vitest、51 项 Python 测试通过；无 public schema/config/运行时/Azure 变更 |
| 2026-08-10 | 发布 M1 到 R760 并执行限量验收 | M1 保持已完成；R760 从未部署变为已部署、限量验收 | release `977639f`；public 文本通过；真实 Research run `drr_e4d8…` 因 `model_contract_error` fail-closed 且零 artifacts；未追加成功率重试；临时凭据已清理，四服务 healthy/restart 0，三库完整、无活动 run/未结算 reservation；Azure 未操作 |
