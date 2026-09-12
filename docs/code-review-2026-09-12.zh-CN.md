# 代码评审与文档核对（2026-09-12）

评审范围：2026-09-05 至 2026-09-12 的 59 个提交（`35a7f1b`..`a3a3a2b`，含 merge 提交；
按 apps/packages/scripts 统计为 58 个），代码约 150 个文件（另含 deploy/config）
+13,537/-658 行，及关联运维文档。方法：静态检查 + 巨大函数扫描 + 关键路径抽查
（`token-budget` 双账本一致性、四个新增 agent 文件、`workflow.ts` 变更热点）+ 文档与
生产状态（`45465ee`，schema 30）交叉核对。**未逐行审计 `workflow.ts` 巨型函数内部**，
本文标注的行数为近似跨度；已按复核意见（2026-09-12）修正数字偏差并补录 D5。

## 一、代码问题

### A1. workflow.ts 巨型函数（可维护性，高）

`packages/research-agent/src/workflow.ts` 全文 11,697 行，单个文件承载状态机、分片生成、
校验、恢复、诊断全部职责。实测函数跨度（按相邻顶层声明估算，复核修正）：

| 函数 | 起点 | 跨度 |
| --- | --- | --- |
| `generateAndValidateShardedModelOutput` | :3415 | ~2,331 行 |
| `generateAndValidateModelOutput` | :2830 | ~535 行 |
| `executeDoctorResearchWorkflow` | :164 | ~505 行 |
| `replayDoctorResearchSynthesis` | :1810 | ~234 行 |

风险：分片生成与校验循环、恢复语义和诊断投影相互缠绕，任何限额/窗口改动的回归面
不可控。建议按"生成 / 校验 / 恢复 / 诊断"拆为 4 个模块，先抽纯函数（`isUsableReviewMarkdownFragment`
附近已有纯函数区可作起点），`executeDoctorResearchWorkflow` 只保留阶段编排。

### A2. apps/gateway/src/index.ts 单文件过大（可维护性，高）

路由注册、运行时构造、failover、重试、vision recovery、runtime key 校验、环境校验
全部在一个文件（复核时 8,487 行，仍在中期 WIP 中继续膨胀）；`index.test.ts` 同步达到
17,124 行。建议按路由域拆分（billing / phone-auth / research / vision / compat），先移动
已自包含的段落（如 `parseResearchLlmReadinessRequirements` 一带的纯函数）。

### A3. 模型 JSON 解析四处实现、三种行为（冗余 + bug 风险，中）

同为"从模型输出提取 JSON"，四个 agent 各自实现且行为分三种（复核补充了第四处）：

- `practical-profile-agent.ts:252` — 严格成对 fence 正则 + 信封补救，最严格
- `identity-investigator.ts:361`、`evidence-investigator.ts:547` — 同一种宽松 strip（行为相同，代码重复）
- `narrative-review-agent.ts` — 单 fence 正则，解析失败返回 `null` 而非抛错，语义又不同

同一类模型畸形输出在不同 agent 里成功率与失败路径不同，修复不会互相同步。建议抽到
公共 `model-json.ts`（含 fence 容错策略的测试矩阵），统一"抛错 or null"的错误合同。

### A4. 测试文件规模（可维护性，中）

`index.test.ts` 17,124 行、`research-store.test.ts` ~2,300 行、`live-adapters.test.ts` ~1,250 行。
vitest 按文件并行，拆小可缩短反馈并降低合并冲突面。优先拆 `index.test.ts`（按拆分后的
路由域对应建文件）。

### 通过项（本轮未发现新问题）

- `token-budget.ts` 双账本：`activeReserved` 的 4 个调用点 ledger 视角
  （primary/free）逐一对账正确（初稿误记为 5 个，复核修正）；daily legacy 纯 Free 请求
  不进 free 账本、直接走自身 policy 窗口，无上周修复的镜像 bug。
- 四个新增 agent 文件（evidence/identity/narrative/practical，共 ~1,500 行）结构一致
  （冻结策略 + BudgetError + 主循环 + 小工具），47 处 catch 密度与"模型输出不可信"
  的设计前提匹配，**不属过度设计**；`practical-profile-agent.ts` 的 `validateDraft`
  白名单校验是合同要求（限定交付字段），保留。
- 上轮评审发现的五个缺陷（旧快照 `tokensTotal` 解码、迁移双计、超额放行、
  `/plans` 缺 `tokens_total`、dashboard 耗尽判定）已有修复与回归测试，并经
  `45465ee` 生产发布验证（迁移 25 条、审计全绿）。

## 二、文档问题（过时/自相矛盾，会误导后续开发与对接方）

### D1. 外部集成指南自相矛盾（高，需立即修）

`docs/medevidence-billing-integration-guide.external.zh-CN.md:23` 仍写
"2026-09-10 起新开户临时默认每日 1 万 token"，与同文件 :219-221 的一次性 1,000,000
语义直接矛盾。这是给 MedEvidence 的现行对接文档，两段并存会让人按旧口径实现。

### D2. system-status 付费模板段落过时（高）

`docs/operations/system-status.md:71-85`：年付"no daily/monthly token total cap"、
月付"5M/day and 50M/month"——均已被 2026-09-11 10:41 UTC 的模板调整取代
（年付 6M/日 + 200M/自然月，月付 150M/月）。该文件开头自我定位"current operational
state only"，历史段落应压缩为一句并指向 dated 发布记录。

### D3. 额度调整记录中的 Free 表述过时（中）

`docs/operations/medevidence-plan-quota-adjustment-2026-09-11.zh-CN.md:5`：
"基础 Free 每日额度（`plan_free_daily_100k_v1`，100,000/日）独立保留"——该行写作时
Free 尚为 100k/日，当日稍后被一次性模型取代。dated 文档不改写正文，但应在文首加
修订注记指向 `r760-free-once-release-2026-09-11.zh-CN.md`。

### D4. runbook-index 旧免费条目歧义（低）

`docs/operations/runbook-index.md:33`"Temporary new-user daily 10k free quota"行与
:30 的 v2 合同行并列，未标注前者已被取代；:29 的 v1 合同行同理（v1 文档内亦无
"已被 v2 取代"横幅）。建议在 v1 合同文档顶部加取代声明，runbook 两行合并。

### D5. system-status 第 69 行存量权益表述过时（高，复核补录）

初稿漏检：`docs/operations/system-status.md:69`"Existing 1M/day and other grants
retain their original Plans, keys and snapshots"——25 条 active 每日权益已在
`45465ee` 发布时迁移为一次性模型（历史用量结转），该句与迁移事实矛盾，随 D2 一并修正。

### 核对通过项

`r760-free-once-release-2026-09-11.zh-CN.md` 与生产实际一致（schema 30、迁移 25 条、
付费模板值、审计数据）；`system-status.md:38-44` 当前状态段正确；v2 合同文档
（`medevidence-free-once-quota-contract-2026-09-11.zh-CN.md`）与代码行为一致。

## 三. 建议行动

| 优先级 | 行动 | 对应 | 状态 |
| --- | --- | --- | --- |
| P0 | 修集成指南 :23 的旧口径段落 | D1 | 已修复（2026-09-12） |
| P0 | 更新 system-status 付费模板/免费/存量权益段落 | D2/D5 | 已修复（2026-09-12） |
| P1 | 统一模型 JSON 解析为公共模块 + 测试矩阵 | A3 | 已修复（2026-09-12）：新增 `packages/research-agent/src/model-json.ts`（`parseModelJson`/`parseModelJsonObject`），四处 agent 统一引用；practical 的信封补救与 narrative 的 null 降级作为合同行为保留在调用方；`model-json.test.ts` 覆盖 7 种合法 + 3 种非法输入 |
| P1 | quota-adjustment 文档加修订注记；v1 合同加取代声明；runbook 标注 | D3/D4 | 已修复（2026-09-12） |
| P2 | workflow.ts 与 index.ts 拆分（先抽纯函数，随下一个 research/gateway 变更分步进行） | A1/A2 | 待办 |
| P2 | 拆分 index.test.ts | A4 | 待办 |
