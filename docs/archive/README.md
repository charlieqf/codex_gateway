# 历史存档

归档日期：2026-11-14。保留 **263 个归档文件**；另按用户要求删除 **31 份明确过时或冲突的文档**；原 `docs/` 下的相对分类保留在本目录中。
逐项原路径、归档原因和后继依据见 [归档索引](INDEX.md)。

## 使用原则

这里保存已完成实施的设计及已结束阶段的发布、巡检、实验和验收证据。明确废弃、已被替代且会误导实施的旧说明直接删除，见[删除记录](INDEX.md#删除记录)。
原文中的“当前”“尚未部署”、版本、额度和主机信息均属于其记录时点；不能用作现行操作指令。
归档一份报告只表示该份记录进入历史区，不代表其中所有跨团队待办、可选阶段或验收限制已经解除。
原始实验失败、未投产结论和验收边界均保留，附件未因归档而删除。

现行入口：[文档目录](../README.md)、[操作索引](../operations/runbook-index.md)、[服务状态](../operations/system-status.md)。

## 分类

| 分类 | 文件数 | 内容 |
| --- | ---: | --- |
| 根目录文档 | 7 | 早期接入、凭据设计、迁移通知及已修复审查 |
| [coordination](coordination/) | 1 | 已完成的 beta.40 Phone Auth 冻结验收 |
| [implementation](implementation/) | 32 | 已实施方案与被后继流程取代的设计记录 |
| [operations](operations/) | 115 | 发布、巡检、配置调整、实验结果 |
| [outbox](outbox/) | 99 | 已完成交付回执、修复记录及整组验收附件 |
| [research](research/doctor-research/) | 9 | Research 阶段验证、实验与恢复记录 |

## Research

Research 现行 [API](../research/doctor-research/api-usage.zh-CN.md) 和
[生产手册](../research/doctor-research/production-runbook.md) 保留在原目录。
旧学术流程设计与实用资料切换记录在 `implementation/`；阶段验证与实验在 `research/doctor-research/`；
2026-08-28 样本交付包在 `outbox/doctor-pinyin-production-results-2026-08-28/`。

## 路径兼容与保留

归档文件的仓库内引用已更新；已知由仓库外运维技能直接使用的 Phone Auth 系统恢复旧路径保留简短跳转。
现行合同、可复用手册、未关闭计划、原始需求输入、技能来源与未确认失效的材料继续留在原目录。
