# 三位海外医生检索失败调查（2026-09-07）

后续代码修复和验证记录见 [海外医生身份检索修复](overseas-doctor-repair-2026-09-07.zh-CN.md)。下文保留修复前的调查结果。

结论：公网端到端测试未通过。原始中文医院/科室输入 0/3 成功，改用外文机构/科室的对照输入仍为 0/3。失败在身份发现/核验阶段，尚未进入论文检索和模型生成。已复现服务端搜索召回及官网识别缺陷，不能以此结果承诺全球医生、教授覆盖。

## 测试范围与结果

入口：`https://goldencode.instmarket.com.au:1443/gateway/research/v1/doctor-runs`。
运行位置：R760 生产 Research Worker，版本 `doctor-research-skill.1.6.118`；使用临时测试账号和正式 Research 权益。没有修改生产代码、配置或手动重启服务。

| 医生 | 原始输入：医院 / 科室 | 原始结果 | 外文对照结果 |
| --- | --- | --- | --- |
| Felix Mottaghy | 德国亚琛工业大学医院 / 核医学科 | `upstream_unavailable`，discover_identity | `identity_not_resolved`，resolve_identity |
| Markus Schwaiger | 德国慕尼黑工业大学（TUM） / 核医学诊所 | `identity_not_resolved`，resolve_identity | `identity_not_resolved`，resolve_identity |
| Paola Anna Erba | 比萨大学医院 / 区域核医学中心 | `identity_not_resolved`，resolve_identity | `identity_not_resolved`，resolve_identity |

截图中 Markus 医院名称被截断，测试采用上表完整名称。外文对照分别采用：

- Felix：`Uniklinik RWTH Aachen` / `Nuklearmedizin`。
- Markus：`Technical University of Munich` / `Nuclear Medical Clinic and Policlinic`。
- Paola：`Università degli Studi di Milano-Bicocca` / `DIPARTIMENTO DI MEDICINA E CHIRURGIA`。此项同时更换了机构，不能视为仅翻译的严格对照。

正式测试前另有三次 503 未受理请求，未创建 run，不计入上述六次。最初测试脚本经 PowerShell 管道传送出现中文编码损失，已改为 scp 传送 UTF-8 文件后重新测试；本文统计的是重测结果。

## 已确认的原因与证据

### 1. 身份查询过度叠加条件，漏掉可访问的官方个人主页

`packages/research-agent/src/workflow.ts:1094` 将带引号姓名、医院、完整科室及固定 `doctor profile` 拼成唯一的医生身份查询。

在同一个生产 Worker 内，用相同 LiveResearchAdapters、SerpAPI Google 配置重放外文查询：

- Felix：结果主要为论文 PDF 和 LinkedIn，未返回其核医学科官网。另一路机构搜索取回 `https://www.ukaachen.de/en/`，但首页没有姓名。
- Markus：结果主要为会议 PDF、论文和 ResearchGate，未返回官方教授主页。机构搜索取回 `https://www.tum.de/en/`，但首页没有姓名。
- Paola：结果主要为 CV / 课程 PDF、LinkedIn，未返回官方个人主页。

进一步只改查询进行对照：`"Markus Schwaiger" TUM` 的第一条结果就是 `https://www.professoren.tum.de/en/schwaiger-markus`。同一 Worker 使用正式安全抓取函数读取该页成功。这直接证明至少 Markus 的当前长查询存在可避免的召回失败。

Felix 的简化查询返回了官网团队页及招聘页，但仍未直接返回目标科室主页；因此不能把“删掉科室词”宣称为三人问题的完整修复。搜索结果具有时效性，本次重放用于验证现有策略，不等同于恢复每次历史请求的全部响应。

### 2. 海外机构官网识别规则存在确定性缺口

`workflow.ts:9419` 的 `isRootLikeHospitalUrl` 接受根路径、`/cn/`、`/zh/` 等，但不接受本次实际成功取回的 `/en/` 首页。

`workflow.ts:9433` 的机构标题标记仅覆盖中文医院及英文 hospital / medical center / clinic，不覆盖 Uniklinik / Klinik 或大学名称。本次 Aachen、TUM 的机构首页无法成为可信机构域名锚点。核验检查点的 `hospital_official_domain_count` 为 0 与此一致。

`workflow.ts:9202` 还要求姓名、机构全称、科室词组在有限正文窗口内匹配；已有别名桥接依赖机构官网锚点。翻译差异、机构别名及历史任职关系会放大前面的召回问题。这是代码层面的覆盖缺口，不能仅靠让用户把输入改成英文解决。

### 3. 部分海外证据无法被当前抓取器消费

同一 Worker 直接通过 `fetchApprovedWebDocument` 访问：

| 页面 | 结果 |
| --- | --- |
| `https://www.ukaachen.de/kliniken-institute/klinik-fuer-nuklearmedizin/` | 成功，正文 8,110 字符 |
| `https://www.professoren.tum.de/en/schwaiger-markus` | 成功，正文 5,026 字符 |
| `https://en.unimib.it/paola-anna-erba` | HTTP 403 |

Paola 现行大学个人主页的 403 是确认的访问障碍，但不能解释为她所有历史请求的唯一根因。当前查询还有大量 PDF 候选；`packages/research-agent/src/safe-http.ts:245` 只接受 HTML/XHTML/plain text，PDF 不受支持。重放中多个候选抓取返回 null，当前日志未逐条保留失败原因，不能把所有 null 都归为 PDF。

### 4. 尚未查清的独立瞬时故障

Felix 首次原始输入 run 在 discover_identity 报 `upstream_unavailable`。日志只有 `dependency_scope: service`，`upstream_http_status` / `upstream_error_kind` 均为空，无法继续确定是哪一个依赖或网络错误。之后外文重测可以完成发现流程，但在身份核验失败。该瞬时故障与稳定复现的身份检索问题分开记录。

## 修复方向（本次尚未实施）

1. 将身份发现改成有限数量的分阶段查询：先姓名＋机构；候选不足时使用机构域内查询、必要别名，避免强制科室全称与 `doctor profile` 同时出现。
2. 支持有证据的国际机构名称和语言首页，明确接纳医学院/大学；保留对身份归属的核验，不能仅因姓名相同就认定命中。
3. 为个人主页不可访问提供可核验的其他官方来源，并单独显示来源被拒绝、内容格式不支持、身份歧义等原因。是否新增 PDF 解析应单独评估，不应绕过现有网络安全约束。
4. 记录候选数量、过滤原因和脱敏后的依赖错误。以上三人必须完成端到端成功验收后，才能声称相关海外场景已支持。

## 原始记录

脱敏结果及诊断重放位于 `artifacts/doctor-overseas-2026-09-07/`：`report-original.json`、`report-official.json`、`trace.jsonl`、`search-control.jsonl`。不包含临时密钥。

收尾已完成：测试凭据已撤销、权益已取消、账号已禁用，临时明文密钥和执行脚本已删除。控制面写入均经备份与完整性检查；Research Worker 收尾健康状态为 healthy。

| 医生 | 原始 run | 外文对照 run |
| --- | --- | --- |
| Felix | `drr_37d9e3b7830148c697089aab66dab1a7` | `drr_162702ae4a77400ca5122f3aed5083f2` |
| Markus | `drr_d4c46af3494c4f8789c3ee6742acd085` | `drr_bc5040224f904222a3cc805f85c86252` |
| Paola | `drr_df48dfaa1662492d95db22f9ef0c8eba` | `drr_bec705bb384142a6b0f0e331d25b2beb` |
