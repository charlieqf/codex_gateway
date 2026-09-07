# 医生跨语言检索独立盲测评价

仓库保留[逐例指标与判分摘要](blind-evaluation-summary.json)。下文引用的完整评估 JSON、原始模型响应及网页正文属于本地证据记录，未随代码推送；其哈希和官方来源链接供后续复核。

评价日期：2026-09-07。状态：全量完成，32/32 个正例、8/8 个负对照已评价，pending 为 0。评分依据执行前固定的 [blind-scoring-rubric.md](blind-scoring-rubric.md)、独立 [blind-ground-truth.json](blind-ground-truth.json)、本轮实际验证窗口及保存的来源正文。未修改算法或输入，未现场重测，也未联网补充资料追认成功。逐例机器可读记录见 [blind-evaluation.json](blind-evaluation.json)。

程序返回 matched 为 **25/32（78.125%）**；独立确认身份正确为 **25/32（78.125%）**；姓名、机构、科室事实均正确为 **24/32（75%）**；完全满足预先证据和时态契约为 **1/32（3.125%）**。其余正例状态为 6 个 not_found、1 个 ambiguous，执行错误 0。这些正例弃答均未计成功。

严格契约未通过不等于找错人物或全部事实错误。25 个已返回身份均为正确人物；其中 24 个三维事实正确。唯一实际科室误认，是把 Christina Canil 的 OHRI Cancer Research 研究项目当作 Medical Oncology 临床科室。其余严格失败主要来自指定引文字段没有完整支持所声称的关联，或 current / 当前职务精度超出本轮日期证据。

| 独立案例 | 正确身份 | 程序 matched | 身份正确 | 三维事实正确 | 严格契约通过 |
| --- | --- | ---: | ---: | ---: | ---: |
| blind01 | Mengtao Li | 8/8 | 8/8 | 8/8 | 0/8 |
| blind02 | Louise Emmett | 8/8 | 8/8 | 8/8 | 1/8 |
| blind03 | Christina Canil | 1/8 | 1/8 | 0/8 | 0/8 |
| blind04 | Peter Rossing | 8/8 | 8/8 | 8/8 | 0/8 |

唯一严格通过的正例为 blind02-en-zh-zh。语言顺序始终是姓名、医院/机构、科室；zh/en 只表示独立设定的输入语言。

| 输入语言组合 | 程序 matched | 身份正确 | 三维事实正确 | 严格契约通过 |
| --- | ---: | ---: | ---: | ---: |
| zh/zh/zh | 3/4 | 3/4 | 3/4 | 0/4 |
| zh/zh/en | 3/4 | 3/4 | 3/4 | 0/4 |
| zh/en/zh | 3/4 | 3/4 | 3/4 | 0/4 |
| zh/en/en | 3/4 | 3/4 | 3/4 | 0/4 |
| en/zh/zh | 4/4 | 4/4 | 3/4 | 1/4 |
| en/zh/en | 3/4 | 3/4 | 3/4 | 0/4 |
| en/en/zh | 3/4 | 3/4 | 3/4 | 0/4 |
| en/en/en | 3/4 | 3/4 | 3/4 | 0/4 |

**独立样本与事实锚点**

| ID | 姓名 | 任职机构所在国家 | 请求机构 | 请求科室及可接受关系 |
| --- | --- | --- | --- | --- |
| blind01 | 李梦涛 / Mengtao Li | 中国 | 北京协和医院 / Peking Union Medical College Hospital | 风湿免疫科 / Rheumatology；英文简称是可接受专科对应 |
| blind02 | Louise Emmett | 澳大利亚 | St Vincent's Hospital Sydney | Theranostics and Nuclear Medicine；Nuclear Medicine 是可接受较宽专科描述 |
| blind03 | Christina Canil | 加拿大 | The Ottawa Hospital Cancer Centre | Medical Oncology；可接受其母医院 The Ottawa Hospital，但需要说明癌症中心/肿瘤内科关系 |
| blind04 | Peter Rossing | 丹麦 | University of Copenhagen | Department of Clinical Medicine, Internal Medicine: Endocrinology；临床医学系及内分泌学层级关系 |

一名原生中文医生，另三名中文姓名均为独立研究员设置的测试音译，标记为 test_transliteration_not_verified_official_name，不宣称官方或既有中文译名。国家指请求任职机构所在国家，不是国籍。输入未包含标准答案来源、额外别名或模型提示；配对翻译和标准答案没有传给被测模型。

独立一手身份锚点包括：李梦涛的[医院个人页](https://ims.pumch.cn/doctor/detail/4288.html)及[医院英文报道](https://www.pumch.cn/en/detail/32160.html)；Louise Emmett 的[医院团队介绍](https://www.svhs.org.au/our-services/list-of-services/theranostics-and-nuclear-medicine/our-team)和 [UNSW 教师页](https://www.unsw.edu.au/staff/louise-emmett)；Christina Canil 的[医院医务人员目录](https://www.ottawahospital.on.ca/en/documents/2025/05/medical-staff-directory.pdf)、[CPSO 注册记录](https://register.cpso.on.ca/physician-info/?cpsonum=70351)及[大学晋升公告](https://www.uottawa.ca/faculty-medicine/news-all/2023-professorial-promotions-ceremony-recognizes-faculty-members)；Peter Rossing 的[大学个人页](https://researchprofiles.ku.dk/en/persons/peter-rossing/)和[大学内分泌学人员目录](https://ikm.ku.dk/english/contact/specialties/internal-medicine-endocrinology/)。这些是执行前事实参照，其中未进入模型窗口的资料不用于补足输出证据。访问限制、日期不确定性及任职起点分别保存在标准答案。

**证据与时态核查**

对全部 47 条被接受匹配的四个引文字段逐项比较，共 188 个引文在对应模型可见正文中逐字存在。没有把摘录不存在的文字当作有效引文。来源文件、结果中的 source_id / URL / content_sha256 逐项关联；复建摘录和冻结机械校验，32 个正例和 8 个负对照结果均一致。文件名中的 content_sha256 对齐的是保存的抓取记录标识，本评价没有宣称重新计算未保存的原始 HTML 响应体哈希。

逐字真实仍需检查语义支持。16 个正例存在指定字段支持不足，例如只引用服务团队描述而没有人物、机构引文实际指向关联研究机构、或用 2004 年专科资格句作为大学科室任职证据。这里按预先口径检查每条被接受匹配和每个指定字段；整页别处支持正确关系，仍不自动补齐该字段。Christina 的研究项目替代临床科室另列为事实错误。

19 个正例的 current 或当前职务精度缺少充分时间证据。未将网页页脚 2026、论文列表年份、训练/资格年份、到院年份或旧会议现在时直接当作当前任职证明；也没有因此推断医生已经离任。下列差别保留在逐例 notes 中：

- 李梦涛的四个英文姓名组合见到 2026-08-05 医院招生计划，支持医院/风湿病导师关系，但未列当前科主任头衔。1999 是到院年份，2012 是教授/主任医师年份，科主任起任日期仍不明。Yale 合作项目页面完整正文有 2024-09-17 更新日期，但模型摘录遗漏该日期。
- Louise Emmett 有五个组合实际见到 [2026-03-17 医院新闻](https://www.svhs.org.au/newsroom/news/scan-reduces-need-for-invasive-prostate-biopsies)，其中日期与目标医院科主任角色均在验证窗口，故允许作为当期角色佐证。另三个组合没有该证据；不能跨组合补用。2012 只按到院从事核医学/PET 工作起点理解，不认定为科主任起任日期。
- Peter Rossing 的全中文组合见到 [2026-06-06 活动师资页](https://events.medscapelive.org/website/93810/)，日期及大学临床医学教授关系可见，当前身份可获佐证，但关联引文字段仍不完整。其他组合主要为无日期大学页或 2025-02-03 的 [ISN 会议简介](https://www.theisn.org/wcn25/member/peter-rossing/)。预先标准答案中的 2026 大学科室目录没有被这些组合抓到，因此未用于追认。

**跨语言失效定位**

Christina Canil 的四个中文姓名组合均把卡尼尔逆向猜成 Garnier。搜索持续引用错误全名，没有通过医院加科室优先的路径纠正姓名；其中三个组合没有选择来源，一个组合选择了异人、异机构的 LVHN 页面。它们的失败主要来自规划和来源选择，不能归咎于最后的引文规则。

四个英文姓名组合中，一个返回正确人物却把 Cancer Research 研究项目误当 Medical Oncology；两个 not_found、一个 ambiguous。已保存证据显示大学动态个人页仅抽取到 15 字符姓名后被过滤、部分注册/论文来源抓取失败、会议节目缺少医院科室、试验联络人记录只有癌症中心关系而没有临床科室。注册 URL 还保留了字面形式的 \u003d；记录为查询编码缺陷，不据此断言全部 403 的成因。安全弃答在这些正例中仍是未完成任务。

这不是全部语言组合普遍失败：另外三人的各八个组合都找到了正确身份和三维事实。四人全英文基线为三人 matched、一人 ambiguous。共享网页缓存和失败缓存使各组合并非独立重复实验；四个人不足以外推全球检索成功率。

**负对照：八个均实际执行且适用**

负对照只重新验证全英文案例已取得的同批文档，分别把医院替换为 Unrelated Example Hospital 9XYZ、科室替换为 Ophthalmology；不代表进行了八次新的错误目标搜索。所选四人均无证据支持真实眼科任职，未因糖尿病或肿瘤研究可能涉及眼部而把临床研究联系等同于眼科部门。最终严格正确拒绝 **7/8**，另一个为保留不符请求匹配的结构化错误。未执行或不适用的项没有计为通过。

| 人物组 | 修改维度 | 原始模型状态 | 最终程序状态 | 保留匹配数 | 严格结果 | 独立说明 |
| --- | --- | --- | --- | ---: | --- | --- |
| blind01 | 错误医院 | not_found | not_found | 0 | 通过 | 已执行；适用；拒绝理由与错误输入一致。 |
| blind01 | 眼科 | not_found | not_found | 0 | 通过 | 已执行；适用；拒绝理由与错误输入一致。 |
| blind02 | 错误医院 | not_found | not_found | 0 | 通过 | 已执行；适用；拒绝理由与错误输入一致。 |
| blind02 | 眼科 | not_found | not_found | 0 | 通过 | 已执行；适用；拒绝理由与错误输入一致。 |
| blind03 | 错误医院 | not_found | not_found | 0 | 通过 | 已执行；适用；拒绝理由与错误输入一致。 |
| blind03 | 眼科 | matched | not_found | 0 | 通过 | 原始模型 status=matched 且返回两条不符合眼科的匹配；一条科室引文为空，另一条引文标点不逐字，机械层将其降为 not_found。最终拒绝计通过，但不是模型稳定完成语义拒绝的证据。 |
| blind04 | 错误医院 | not_found | not_found | 0 | 通过 | 已执行；适用；拒绝理由与错误输入一致。 |
| blind04 | 眼科 | ambiguous | ambiguous | 2 | 不通过 | 理由明确说没有眼科关系，但 ambiguous 下仍保留两条被机械接受的内分泌/糖尿病血管病匹配。按修改后的请求属于结构化误接受；不声称模型在文字解释里把此人称作眼科医生。 |

七个最终 not_found 中，六个是原始模型即明确拒绝；Christina 的眼科对照由原始 matched 经引文校验降为 not_found，属于最终系统正确拒绝，但不能作为模型稳健识别错误科室的证据。Peter 的眼科对照文字理由明确否认眼科关系，却在 ambiguous 的 matches 数组保留两条内分泌/糖尿病血管病匹配；按修改后的请求属于结构化误接受。本评价不声称其解释文字把 Peter 称为眼科医生。

**逐例评分**

三维“正确”判断真实人物关系；“严格结果”同时要求来源、各字段引文与时态满足冻结契约。未作结论表示该正例没有返回可评分身份，不算通过。更细的来源、引文偏移、拒绝原因、日期和诊断见 JSON。

| case_id | 程序状态 | 姓名 | 机构 | 科室 | 严格结果 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| blind01-zh-zh-zh | matched | 正确 | 正确 | 正确 | 不通过 | 三条匹配均为同一正确人物和医院/专科。团队名单的关联引文只列姓名及科室，未包含医院。无日期简介和 2023 年获奖简介不能保证当前主任头衔。首条 explanation 将 since 1999 接在主任医师/科主任描述后，可能混淆到院工作与职务起任时间。 |
| blind01-zh-zh-en | matched | 正确 | 正确 | 正确 | 不通过 | 最终只保留官方团队名单；关联引文未含医院。被拒绝的个人页 person_quote 是原文真实的三字姓名，唯一问题为长度小于 4；另一拒绝含姓名与逗号间空白差异。 |
| blind01-zh-en-zh | matched | 正确 | 正确 | 正确 | 不通过 | 个人介绍中的工作年份句可在此人独立简介上下文中支持医院/专科关系；其本身不提供简介更新日。2023 年获奖简介不能单独证明当前主任岗位。 |
| blind01-zh-en-en | matched | 正确 | 正确 | 正确 | 不通过 | 人物/医院/专科正确；现职依据缺少岗位时效。原始第三条将页面内分散的团队文字拼成连续引文，被机械验证正确拒绝。 |
| blind01-en-zh-zh | matched | 正确 | 正确 | 正确 | 不通过 | 最终只留 2023 年获奖人物简介。模型可见 2026-08-05 招生计划，能补强当期医院/风湿病导师关系，但未列主任头衔；不能把 2023 年主任描述直接作为当前主任岗位。原始个人页关联引文跳过中间履历段落，故被拒绝。 |
| blind01-en-zh-en | matched | 正确 | 正确 | 正确 | 不通过 | 人物/医院/科室正确，2026 导师计划支持当期机构/专业。关于主任岗位仍使用无日期个人页、2023 新闻及合作院校介绍。模型明确称合作院校页无日期并据现在时推断 current；完整页面实际标 2024-09-17，日期不在截取窗口。 |
| blind01-en-en-zh | matched | 正确 | 正确 | 正确 | 不通过 | 人物/医院/科室正确；2026 导师计划未列主任职务。合作大学页面被标为 professional_organization，实际为大学合作项目师资介绍。完整页 2024-09-17 更新日未进入验证窗口。 |
| blind01-en-en-en | matched | 正确 | 正确 | 正确 | 不通过 | 人物/医院/科室正确。2026 导师计划支持当期医院/专业关系，不能更新 2023 人物简介中的主任头衔。标为 other 的合作大学证据被拒绝；该拒绝不把最终身份匹配变成错误。 |
| blind02-zh-zh-zh | matched | 正确 | 正确 | 正确 | 不通过 | 两条官方个人/团队介绍均支持正确身份及医院专科，但均无岗位更新时间。模型把研究员设定音译称为 standard，未提供该中文译名为官方/既有名称的证据。 |
| blind02-zh-zh-en | matched | 正确 | 正确 | 正确 | 不通过 | 医院页 institution_quote 仅为服务团队描述，没有医院名称。另一研究机构介绍的医院引文正确。无日期主页加 2022 年公司公告不能证明测试日现职；2012 明确限定为到目标医院工作，未误定主任起任日期。 |
| blind02-zh-en-zh | matched | 正确 | 正确 | 正确 | 不通过 | 2026-03-17 医院新闻在验证窗口内，明确支持当前主任岗位，故时态合理。第二条 department_quote 只有 Research Program: Theranostics，未引出请求中的完整核医学部门；虽该页其他引文有完整部门，字段契约仍不完整。since 2012 按医院/核医学工作期间理解，主任起任日仍未知。 |
| blind02-zh-en-en | matched | 正确 | 正确 | 正确 | 不通过 | 2026-03-17 新闻支持当前主任岗位。第一条 affiliation_quote 只列姓名和职位，没有目标医院；第二条引用完整。2012 的说明明确引用到院核医学/PET 工作，不视为主任起任日。 |
| blind02-en-zh-zh | matched | 正确 | 正确 | 正确 | 通过 | 两条被接受匹配的四类引文均逐字真实且支持请求的三维关联。2026-03-17 医院新闻在模型窗口中，模型原始回复明确引用该日期与主任职务；该新闻因 source_type=other 被机械丢弃为独立匹配，但仍是本轮模型实际看到的有效时效佐证。since 2012 按医院/核医学工作起点理解，不认定为主任起任日。 |
| blind02-en-zh-en | matched | 正确 | 正确 | 正确 | 不通过 | 2026-03-17 新闻支持现职。第二条 institution_quote 引的是 St Vincent's Centre for Applied Medical Research；这是关联研究机构，不是请求医院的译名。该页 affiliation_quote 能证实医院任职，但 institution_quote 字段错误。 |
| blind02-en-en-zh | matched | 正确 | 正确 | 正确 | 不通过 | 无日期团队页/个人页可确认身份关系，但本组合没有 2026 新闻，现职推断不充分。第一条 affiliation_quote 描述医院服务团队整体，不含此人或此人角色；第二条引文完整。 |
| blind02-en-en-en | matched | 正确 | 正确 | 正确 | 不通过 | 2026-03-17 新闻支持现职。第二条 department_quote 仅为 Research Program: Theranostics，未引出完整的诊疗一体化与核医学部门，按冻结字段契约不算完整通过。 |
| blind03-zh-zh-zh | not_found | 未作结论 | 未作结论 | 未作结论 | 不通过 | 规划将输入姓氏收窄为错误拉丁拼写；每条查询都包含该带引号姓名，未进行机构+科室优先补救。搜索结果为社交/讣告/族谱等无关页面；选择器选择 0 个来源，验证输入为空。not_found 是合理安全弃答，但正例失败；不是引文规则造成。 |
| blind03-zh-zh-en | not_found | 未作结论 | 未作结论 | 未作结论 | 不通过 | 两个英文候选只改变名的拼写而沿用错误姓氏，正确姓名未进入候选。无目标医院/专业来源，选择器选择 0 个来源，最终无证据弃答。科室改为英文未修复音译规划问题。 |
| blind03-zh-en-zh | not_found | 未作结论 | 未作结论 | 未作结论 | 不通过 | 规划仍将姓氏误写为 Garnier。选中的两个 LVHN 页面针对异人/异机构；一个抓取错误、一个 403，最终验证文档为空。即使这两页抓取成功也不是标准答案人物。 |
| blind03-zh-en-en | not_found | 未作结论 | 未作结论 | 未作结论 | 不通过 | 中文姓名的四种组合全部未产生正确英文姓氏。英文医院和科室未纠正首轮错误猜名，选择器无有效来源并安全弃答。 |
| blind03-en-zh-zh | matched | 正确 | 正确 | 错误 | 不通过 | 姓名确为 Christina Canil，父医院与其实际任职有关。但 Cancer Research / Recherche sur le cancer 是 OHRI 研究项目，不能替换 Medical Oncology / 肿瘤内科。两条 affiliation_quote 仅定义研究人员通常属于哪些职业/机构，不是此人精确癌症中心科室关联。模型自己承认部门只是 approximate，却仍返回 matched，是三维匹配误接受。 |
| blind03-en-zh-en | not_found | 未作结论 | 未作结论 | 未作结论 | 不通过 | 英文姓名规划正确。注册机构/论文/ResearchGate 返回 403；大学动态页仅抓到姓名 15 字符，被最小正文长度过滤；学会节目只列主持人，未列医院或科室。not_found 合理但正例失败。注册 URL 内实际保留了文字形式的 \u003d，不能据此断言 403 全由该问题导致。 |
| blind03-en-en-zh | not_found | 未作结论 | 未作结论 | 未作结论 | 不通过 | 英文名正确，找到 2026 临床试验联络人与 OHRI 癌症研究目录，但没有一份模型可见文档同时支持姓名、癌症中心和肿瘤内科。此组合正确拒绝把 Cancer Research 等同 Medical Oncology，与 en-zh-zh 的过宽接受形成不一致。 |
| blind03-en-en-en | ambiguous | 未作结论 | 未作结论 | 未作结论 | 不通过 | 最终 ambiguous、matches=[]。医院癌症中心联络关系可见，但肿瘤内科任职缺证；不计独立明确身份成功或完整通过。两个负对照另行评分，不因正例未通过而认定未执行。 |
| blind04-zh-zh-zh | matched | 正确 | 正确 | 正确 | 不通过 | Peter Rossing、大学与临床医学/内分泌学身份正确。2026-06-06 活动师资表日期及大学临床医学教授信息在本轮窗口，时效不是只靠无日期主页。主页的 affiliation_quote 仅有 Clinical Professor / Department of Clinical Medicine，未包含大学名称；委员会条目仅给上级临床医学系，不额外声称它单独证实内分泌亚专业。 |
| blind04-zh-zh-en | matched | 正确 | 正确 | 正确 | 不通过 | 大学主页证实准确三维身份，现职仍用无日期个人陈述及 2025 学会简介推断。第二条 department_quote 是 2004 年取得内科/内分泌专科资格，不是大学科室任职；不能单独形成所请求的精确科室关联。 |
| blind04-zh-en-zh | matched | 正确 | 正确 | 正确 | 不通过 | 唯一被接受的大学个人页支持三维身份，但没有人事更新时间；其他本轮来源为无日期委员会/企业简介和 2025 学会简介。2026 论文或指南条目不自动更新任职日期。 |
| blind04-zh-en-en | matched | 正确 | 正确 | 正确 | 不通过 | 大学和内分泌学身份正确；关联引文只列姓名、科室及职称，没有大学名称。多个无日期/旧简介的现在时不能直接断定测试日现职。 |
| blind04-en-zh-zh | matched | 正确 | 正确 | 正确 | 不通过 | 英文姓名及三维真实对应正确。关联引文只列姓名/部门/职称，未引出请求大学。可见的委员会和大学简介均无更新日期；2025 学会资料不能单独作为当前岗位证明。 |
| blind04-en-zh-en | matched | 正确 | 正确 | 正确 | 不通过 | 模型明确将 affiliation_period 写成 undated institutional profile，却仍标 current。关联引文只列职称/科室，未含大学；这是冻结提示明确要求避免的无日期推断。 |
| blind04-en-en-zh | matched | 正确 | 正确 | 正确 | 不通过 | 大学个人页身份正确。辅助 ISN 来源实际为 2025-02-03，2004 年专科资格不能替代大学内分泌科室任职。当前任职断言无足够时效；本轮并未抓到独立标准答案中 2026 年大学科室名册。 |
| blind04-en-en-en | matched | 正确 | 正确 | 正确 | 不通过 | 全英文身份对应正确。使用无日期大学页及 2025 学会简介推断 current，并以 2004 资格句作为部门引文。最终眼科负对照保留两条内分泌匹配，单独记为结构化请求匹配错误。 |

**冻结与审计边界**

[static-audit.json](static-audit.json) 未发现独立人物特例、配对翻译、机构域名映射或 expected_name / ground truth 向模型泄漏。审计同时明确保留了排序中的 nuklearmedizin 专科词偏置、缺少科室和机构语义复核、短中文姓名引文长度门槛、无日期 current 推断等通用缺陷，因此不能表述为“无任何样本相关偏置”。评估过程未改这些实现。

- 冻结 core SHA256：116edd7000610db8014d1ae8f590abb789a8a83ced6e5c38b65c9375642badad
- 冻结 runner SHA256：85a67dae20f976288d8236f604b6e11562a9a60423f5990385bc91cea1062fef
- 输入矩阵 SHA256：8fad7a66ae890f7937cba9110d52185557378476c91840c92dccce7d64bfcd8d
- 预先 rubric SHA256：6f3e3181cc368c72ccaa76a887f1922d3c8f4c84fdfa0b20fbfe9651ef2c91d6
- 全量结果 SHA256：adb59c96be577e40ba632bcefd35b3606bfb8ebd8b410b8f20feab3a875189cc

本报告评价的是这一冻结实现、这一轮可见证据及四个独立人物。它区分了真实三维检索能力与严格证据输出质量，未把证据不足说成人物必然错误，也未把弃答或未执行说成正例通过。
