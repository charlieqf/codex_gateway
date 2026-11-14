# 文档目录

整理日期：2026-11-14。本次仅整理文档，不重新核验或改变生产状态。

## 从任务进入

| 任务 | 入口 |
| --- | --- |
| 当前服务状态、操作手册 | [System Status](operations/system-status.md)、[Runbook Index](operations/runbook-index.md) |
| 客户端接入与鉴权 | [接入合同](consumer-technical-guide.md)、[API key 验证](client-api-key-validation-guide.md) |
| 身份、收费与额度对接 | [Billing 接入](medevidence-billing-integration-guide.external.zh-CN.md)、[Phone Auth v1](operations/internal-phone-auth-v1.zh-CN.md)、[额度操作](operations/user-quota-operations.zh-CN.md) |
| 模型回执、进度及协同契约 | [回执与恢复 v1](coordination/model-call-recovery-v1.zh-CN.md)、[进度 v1](coordination/model-call-progress-v1.zh-CN.md)、[coordination](coordination/) |
| Research 接口及运行 | [Doctor Research](research/doctor-research/README.md) |
| 已完成实施与历史证据 | [历史存档](archive/README.md)、[逐文件归档索引](archive/INDEX.md) |

## 目录职责

- `operations/`：持续使用的操作手册，以及仍有待办的运行调查或维护安排。
- `implementation/`：仍适用的开发合同、未完成或缺少完整上线／验收证据的计划。
- `coordination/`、`contracts/`：现行协同合同、冻结字段及验收基准。
- `inbox/`、`outbox/`：尚需使用的需求输入、对外接口说明和待跟进交接。
- `architecture/`、`decisions/`：架构约束和决策记录，不因实施完成而丢弃设计依据。
- `research/`、`reference/`、`references/`：当前研究接口、可复用资料、样本和技能来源。
- `archive/`：已完成实施的方案，以及已结束阶段的发布、巡检、实验和验收记录。保留原分类与附件关系。

## 本次保留边界

带日期不等于过时，已上线不等于接口合同失效。仍使用的模型、额度、短信、图片与 SSE 合同继续保留。
分块写入 A/S 联合验收、过度设计整改 M2–M7、Phase 0 生产验收、调用方待跟进调查及本次断电维护等，
没有足够证据证明全部完成，继续留在现行目录；归档不替代这些工作的验收。

后续方案实施完毕后，应将方案及对应回执一起移入 `archive/`，更新引用，并在归档索引记录原因和后继入口。
现行手册可以引用存档中的具体证据，但不得直接把历史版本、额度或主机状态当作当前事实。

明确废弃、已被替代且与现行代码或流程冲突的文档直接删除，不继续放在历史存档；删除理由和现行替代入口见[删除记录](archive/INDEX.md#删除记录)。
