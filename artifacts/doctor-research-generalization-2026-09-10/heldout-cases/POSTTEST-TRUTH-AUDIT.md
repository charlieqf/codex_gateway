# 测试后独立真值与译名复核

复核时间：2026-09-10 12:20:06 UTC。

冻结代码（主代理报告）：`a67d2d3a4415d3aceed360d2a394e6f4933964da`。本代理未读取服务结果内容、未调用服务、未读取或修改运行代码，未替换任何样本。此次只新增审计说明，不修改原始输入、候选池和抽样结果。

输入文件 SHA-256 再次核对仍为 `f7af16073320e8101da23a6a5e27ae0b87f368058bbcee2ae5af3c03b4301a92`。

## 结论

8人的姓名、原文机构及专业归属均由医院或大学官方目录支持，未发现虚构人员或错配医院/专业。3个中国输入直接采用官方中文；海外输入为人工中文翻译，不能声称全为机构公布的标准中文名。2个海外输入有需要明确承认的用词/组织层级问题：OS01的NHS译法不严谨；OS02把目录栏目补称为“组”。原始测试仍应保留，不能在看见结果后更换输入重算成功率。

## 逐人审计

| ID | 姓名 | 一手支持 | 中文输入审计 |
| --- | --- | --- | --- |
| CN01 | 钟历勇 | [医院内分泌科目录](https://bifns.bjtth.org/Mobile/DoctorTeam/Index?departmentId=1007)及[医院个人页](https://www.bjtth.cn/Html/Doctors/Main/Index_1031092.html)均支持，个人页科室列出内分泌科 | 首都医科大学附属北京天坛医院／内分泌科直接对应；无翻译问题 |
| CN02 | 杨祖立 | [普通外科目录](https://www.sysu6h.cn/medical-department/key/national/1)及[医院个人页](https://www.sysu6h.cn/expert/653)支持，个人页科室字段是普通外科 | 中山大学附属第六医院／普通外科准确；胃外科二区是更细分职位，不与所给科室冲突 |
| CN03 | 王惠平 | [皮肤性病科医师目录](https://www.tjmugh.com.cn/lcks/pfk/zjjs/index.shtml)及[医院个人页](https://www.tjmugh.com.cn/system/2018/11/09/020005347.shtml)支持 | 天津医科大学总医院／皮肤性病科（含医学美容科）直接采用目录导航名；无翻译问题 |
| OS01 | Jason Dunn | [医院消化内科目录](https://www.guysandstthomas.nhs.uk/our-services/gastroenterology)及[个人页](https://www.guysandstthomas.nhs.uk/our-consultants/jason-dunn)明确对应 Guy's and St Thomas' NHS Foundation Trust，gastroenterologist | “盖伊和圣托马斯”正确对应核心机构；消化内科对应 Gastroenterology。但把NHS写成“国民保健署”不严谨，也未证明长机构译名是标准中文别名；此输入有额外译名噪声，应标注 |
| OS02 | Tim Kerruish | [奥塔哥大学内科学系人员目录](https://www.otago.ac.nz/dsm-medicine/people)的 Academic staff > Emergency Medicine 列出其姓名和 Clinical Senior Lecturer | 奥塔哥大学正确；但尼丁内科学系／急诊医学表达了实际目录层级和专业，但原文只提供栏目标题，并未证明独立组织正式命名为“急诊医学组”；“组”为本代理补出的层级用语，应标注 |
| OS03 | Alexander Tsoukas | [麦吉尔大学风湿病学部Faculty目录](https://www.mcgill.ca/rheumatology/faculty)列出MD、Rheumatologist；[医学院官方说明](https://healthenews.mcgill.ca/rheumatology-outreach-in-abitibi/)确认内科学系Division of Rheumatology | 麦吉尔大学／风湿病学部语义对应；“学部”为Division的人工译法，未核得该单位发布的标准中文名称；没有改成其他学科 |
| OS04 | 飯田 円 | [名古屋大学附属医院2026年9月门诊表](https://www.med.nagoya-u.ac.jp/hospital/guide/outpatient/schedules/neurology/)在神经内科第2诊察室周一列出完整姓名 | 名古屋大学医学部附属医院准确对应日文；神经内科准确对应脳神経内科；姓名保持日文字形及空格，没有改成汉语简体或罗马字 |
| OS05 | Shoshana Sztal-Mazer | [阿尔弗雷德医院内分泌门诊顾问目录](https://www.alfredhealth.org.au/the-alfred/services/hp/endocrinology-clinic)列出该人及Endocrinology，院区为The Alfred；[女性内分泌门诊](https://www.alfredhealth.org.au/services/womens-endocrinology-health-clinic)另有一致记录 | 阿尔弗雷德医院／内分泌科语义正确；没有混成Royal Prince Alfred Hospital。中文音译并未由医院发布的中文名表确认 |

## 抓取证据与时间范围

构建真值阶段已成功读取上述8个官方目录；候选顺序和排除项保存在 sampling-manifest.json。CN01的旧子域目录快照与搜索摘要版本不同，抽样严格依已固定的目录快照；已用新主站个人页复核所选人的身份。CN03个人页路径有2018年日期，但构建时官方医师目录仍链接该页；不能据此证明最新行政任期。

OS02个人独立profile页在构建时超时，但完整大学目录已给出姓名、专业和职务。个人独立URL不是身份真值成立的必要条件，也没有因其抓取困难换人。

此次测试后重新抓取时，CN03、OS02、OS03、OS05的目录又返回抓取超时；CN01、CN02、OS01、OS04成功返回。上述超时是本次浏览工具的抓取结果，不能改写为目录“不存在该人”。对4个超时目录，复核依靠测试前已成功读取的原始官方目录返回记录以及当时保存的候选/核验说明；不宣称此次全部重新实时取回。

## 如何解释本次测试

- 这次结果能描述冻结版本对这8份原始中文输入的端到端表现。8个机构目录为独立定向选择，目录内随机抽样；不是全球医生总体随机样本。
- 不能将其表述为“8个全部具有机构认证标准中文译名的无歧义测试”。尤其OS01、OS02应保留译名噪声标记。
- 未查看各案例的具体服务输出，不能判断任何失败是否由译名导致。译名问题不否定对应人物与真实机构、专业的一手证据。
- 搜索超时与身份核验失败是不同结果；一手存在性证据说明“系统未核验”不等于“此人或所给机构关系不存在”。
- 流程成功仅表示流程结束；完整医生研究结论、引文和身份匹配仍需以已保存原始输出来独立评分。
- 不更换任何样本、不修订已测输入、不重写本轮成功率。若以后研究标准化中文或原文输入的影响，应另建对照轮次，并保留本轮结果。

