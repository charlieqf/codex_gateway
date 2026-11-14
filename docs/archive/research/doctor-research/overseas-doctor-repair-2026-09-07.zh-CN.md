# 海外医生身份检索修复（2026-09-07）

本次修复截图中三位医生卡在身份发现/核验阶段的问题。修复已提交、推送并部署为 `ebad087`，发布及公网验收见 [上线记录](overseas-doctor-release-2026-09-07.zh-CN.md)。此前调查见 [失败调查](overseas-doctor-validation-2026-09-07.zh-CN.md)。

## 代码改动

1. 首轮搜索改为姓名＋机构；移除完整科室与固定 `doctor profile`。缺少机构域内候选时最多补一次域内查询；无法确定机构域名时补一次姓名查询。医生候选仍限制在配置上限内，合并去重、过滤不含姓名的结果后再截断。补充结果保留首轮候选的优先级。
2. 官网核验支持英文、德文、意大利文等语言首页及医院/大学名称；在核验过的机构域名下支持教授子域名。仍核对姓名和科室，拒绝 `tum.de.attacker.example`、`nottum.de` 等无关域名，保留共享大学页面不能证明某附属医院身份的限制。
3. 在 `institution-names.ts` 维护本次三组机构、科室的中外文名称对照。中文译名由本次维护，链接来源用于核对外文原名。Aachen、TUM 使用核对过的机构首页作为候选入口，减少官网搜索排名波动；首页正文仍需抓取并核验。数据不包含医生姓名或直接放行规则。未收录机构沿用通用检索，不自动翻译或猜测别名。
4. 原始请求中的中文医院、科室不被改写。比萨大学医院与 Bicocca、Bergamo 不作为同一机构。简介提示词要求保留任职时间，区分现职与历史任职，不把查询机构自动描述成现职。
5. 身份检查点新增候选数量、成功抓取数量和按 source ID 记录的 HTTP/格式/抓取失败分类。403 和不支持的格式不重复抓取；受控 seed 的既有失败语义保留。PDF 解析不在本次实现中。
6. 正确识别 SerpAPI Google 成功但零结果的特定响应；额度、认证和其他服务错误仍报错。该响应可能带 `error` 字段，官方文档有明确示例：[SerpAPI 错误处理说明](https://serpapi.com/blog/fix-serpapi-errors-guide/)。

每次身份发现最多三条逻辑搜索，每条最多两次请求；预留搜索请求预算由 4 调整为 6。已维护官网的机构不再重复执行机构搜索。未增加模型调用或依赖包，也未调整公网路由和生产配置。

## 验证

真实来源验证在 R760 的一次性容器内运行，使用修改后的代码与现有搜索配置。执行真实的 `discoverIdentityEvidence` / `resolveIdentity`，保留原始中文输入。使用独立目录，不写生产数据库、不创建用户、不替换线上 Worker。

最后一轮三组原始中文输入全部通过身份核验：

| 医生 | 原始医院 / 科室 | 核验结果与来源 |
| --- | --- | --- |
| Felix Mottaghy | 德国亚琛工业大学医院 / 核医学科 | 通过；Aachen 核医学科官网 |
| Markus Schwaiger | 德国慕尼黑工业大学（TUM） / 核医学诊所 | 通过；TUM 教授主页 |
| Paola Anna Erba | 比萨大学医院 / 区域核医学中心 | 通过；欧洲癌症组织个人介绍中的历史任职 |

`npm run typecheck` 通过。Research Agent、Worker、Gateway Research 路由及 Research Store 共 **278 项测试通过**，覆盖原始中文输入、外文输入、错误科室、伪装域名、共享大学页面、未知机构保持原值、候选排序、永久抓取失败和零结果/额度错误区分。

真实来源验证仅覆盖身份发现和核验，不能替代部署后的公网请求、论文检索、模型生成和报告下载验收。

收尾完成：一次性容器已退出并自动删除，远程及本地临时执行脚本和代码包已移除；保留诊断结果作为审查证据。线上 Research Worker 健康状态为 healthy。

中间轮次证明：只改搜索和官网识别，可以使 Felix、Markus 的外文对照通过；加入名称对照后，Markus 与 Paola 的原始中文输入通过。Felix 的候选排序波动随后通过保留首轮候选和使用已核对机构入口修正。

Paola 的比萨大学医院任职来自 [欧洲癌症组织介绍页](https://www.europeancancer.org/content/paola-anna-erba.html)，页面明确叙述其历史经历。使用该记录核验身份不等于认定她目前仍在比萨任职。先前使用 Milano-Bicocca 的对照输入在源站 403、名称差异下仍失败，不能把三位原始输入的验收扩展成所有现职、机构均已覆盖。

测试记录在 `artifacts/doctor-overseas-2026-09-07/`：`repair-tests-final.json`、`repair-probe-final.json`；真实来源中间轮次为 `repair-probe-first.json`、`repair-probe-second.json`、`repair-probe-third.json`。

## 版本与上线边界

- Skill：`1.6.119`。
- Workflow：`doctor_research_workflow.v88`。
- Validation：`doctor_research_validation.v48`。
- Prompt：`doctor-research-prompt.v33`。
- 官方搜索 adapter：`bounded-hospital-identity-search-v4`。

创建 run 的 Store 版本常量与 Worker 同步更新；回放样例更新策略版本，合成输入、响应和预期产物未修改。部署时需要协调 Gateway 的新任务版本与 Worker，先处理旧版本在途任务，避免旧任务交给新版本 Worker 后被版本校验拒绝。

本补丁针对已知海外机构名称与通用召回缺陷，不构成全球机构名称库。部署后的三组原始输入公网验收及 Paola 任职表述复核见上线记录；本节前述真实来源验证仍仅指部署前的身份阶段测试。
