# Doctor Research 独立留出样本（揭示前保密）

完成日期：2026-09-10。样本共8人：中国3人，海外5人；海外覆盖英国、新西兰、加拿大、日本、澳大利亚5个国家。所有姓名来自医院或大学官方人员目录。未读取或修改服务代码，未调用 Doctor Research，未将任何身份信息、候选目录或个人URL交给服务。

## 文件用途

- `inputs.json`：唯一盲测输入。每项只有内部案例ID、姓名、机构和科室；提交服务时只使用后三个字段。
- `official-ground-truth.json`：独立官方核验数据，不得拼入服务请求。
- `sampling-manifest.json`：固定的候选顺序、目录来源、种子与排除项。
- `sampling-draws.json`：每一步抽中的零基下标。
- `reproduce_sampling.py`：复现抽样和验证已有输入的独立辅助脚本。

## 可复现抽样方法

先独立选择8个官方科室目录，再在每个目录内随机抽取1人。这是分层目录内随机抽样，不代表全球医生总体的概率样本。目录按中国3个、海外5个的固定顺序排列。候选按各目录指定区段出现顺序；去掉职称敬称，保留原姓名拼写；排除护理人员、无完整姓名的条目；去掉重复出现的相同人名。没有按知名度或个人页是否容易搜索做筛选。

随机种子在看到任何抽样结果前固定为整数 `20260910`。使用 CPython 3.14.0 的 `random.Random(20260910)`，按 manifest.strata 的顺序各执行一次 `randrange(len(candidates))`。8个零基下标依次为 `1, 8, 1, 5, 5, 22, 5, 9`，对应候选数为 `13, 31, 11, 21, 8, 25, 15, 11`。第一次运行在写入输入和抽样记录后，因 Windows 默认 cp1252 无法打印姓名而失败；仅增加 Python UTF-8 模式重跑复现，同一文件字节通过一致性断言，未更改种子、候选或结果。

复现命令：`python -X utf8 reproduce_sampling.py`。脚本若发现既有 inputs.json 字节不一致，会报错，拒绝覆盖。

输入文件 UTF-8、无BOM、LF换行，SHA-256：`f7af16073320e8101da23a6a5e27ae0b87f368058bbcee2ae5af3c03b4301a92`。

## 排除及目录发现记录

抽样前，中国首个目录排除3名护理人员（杨文雯、谷静、姚宁）；日本目录排除仅有姓的“蛭薙”和“辻河”，以及未公开姓名的“担当医”。这些条目的原文及原因已记录在 manifest。日本排班表还去掉4次重复医生出现。无因科室缺失而剔除的条目。抽样后替换人数为0。

目录发现阶段还探索过苏州大学附属第一医院肾内科、谢菲尔德医院消化内科、渥太华大学风湿病科和悉尼大学风湿病相关页面；没有从这些探索结果抽取人名。最终采用具备明确人员列表的8个目录，随后才运行随机抽样。该目录发现过程不能解释成服务测试失败后的样本替换。名单尚未经过服务。

遵从主代理给定的排除机构：南京市妇幼保健院；重庆医科大学附属第一医院；四川大学华西医院；Novartis/诺华；Inselspital/伯尔尼大学小岛医院；UMCG/格罗宁根大学医学中心；EANM；RWTH Aachen大学医院；TUM及其医院；比萨大学医院；Bergamo/Bicocca机构；北京协和医院；复旦大学附属华山医院；北京大学第三医院。本次8个抽样机构均不在此表。已讨论的13名人员亦均未进入最终名单。

海外机构及科室采用中文输入、姓名保留原文。中文名称依据官方原文准确翻译，非声称每个译名均为机构自发公布的唯一标准中文名；官方原文对应保存在真值文件中。大学的 department/division 采用学系/学部名称，医院采用科室名称。

## 官方核验

### CN01 — 钟历勇

首都医科大学附属北京天坛医院；内分泌科。医院个人页的姓名、主任医师职称及科室栏直接对应；同页内分泌科说明给出医院全称。

[官方人员目录](https://bifns.bjtth.org/Mobile/DoctorTeam/Index?departmentId=1007)；[官方补充核验](https://www.bjtth.cn/Html/Doctors/Main/Index_1031092.html)。

核验范围说明：抽样目录 web.open 快照与搜索摘要版本不同，严格采用 manifest 已固定的 web.open 列表。抽中人的新主站个人页已另行核验，未重新抽样。

### CN02 — 杨祖立

中山大学附属第六医院；普通外科。医院个人页明确列出主任医师、胃外科二区主任，科室字段为普通外科；因此沿用目录所属一级科室。

[官方人员目录](https://www.sysu6h.cn/medical-department/key/national/1)；[官方补充核验](https://www.sysu6h.cn/expert/653)。

### CN03 — 王惠平

天津医科大学总医院；皮肤性病科（含医学美容科）。医院皮肤性病科医师目录列出姓名；个人页载明主任医师，皮肤科主任兼过敏性疾病科主任。

[官方人员目录](https://www.tjmugh.com.cn/lcks/pfk/zjjs/index.shtml)；[官方补充核验](https://www.tjmugh.com.cn/system/2018/11/09/020005347.shtml)。

核验范围说明：个人页 URL 含2018年日期；目前官方医师目录仍链接此页。仅确认公开身份对应，不由页面日期推断最新行政任期。

### OS01 — Jason Dunn

盖伊和圣托马斯医院国民保健署基金会信托；消化内科。医院个人页明确为该信托的消化内科顾问医师，并列出 MBBS 和研究兴趣；目录与个人页相互一致。

[官方人员目录](https://www.guysandstthomas.nhs.uk/our-services/gastroenterology)；[官方补充核验](https://www.guysandstthomas.nhs.uk/our-consultants/jason-dunn)。

核验范围说明：机构中文为依据官方英文全称的完整中文翻译，不声称是该机构发布的唯一官方中文译名。

### OS02 — Tim Kerruish

奥塔哥大学；但尼丁内科学系急诊医学组。大学正式内科学系人员目录在 Academic staff > Emergency Medicine 下列出其姓名及 Clinical Senior Lecturer 职务。目录本身已同时确认机构、学系、临床专业和人员身份。

[官方人员目录](https://www.otago.ac.nz/dsm-medicine/people)。

核验范围说明：个人 profile?id=1493 直达页先后返回超时/内部错误；仍保留此样本，以可公开读取的大学人员目录构建真值，未将个人页不可抓取作为剔除条件。

### OS03 — Alexander Tsoukas

麦吉尔大学；风湿病学部。大学风湿病学部 Faculty 目录标明该人为 MD、风湿病医师；医学院官方新闻进一步确认其为内科学系风湿病学部助理教授，兼麦吉尔大学健康中心风湿病医师。

[官方人员目录](https://www.mcgill.ca/rheumatology/faculty)；[官方补充核验](https://healthenews.mcgill.ca/rheumatology-outreach-in-abitibi/)。

### OS04 — 飯田 円

名古屋大学医学部附属医院；神经内科。医院官方2026年9月神经内科门诊医生表（标注2026年9月1日）在第2诊察室周一列出完整姓名。保留日文原字形和姓/名间空格。

[官方人员目录](https://www.med.nagoya-u.ac.jp/hospital/guide/outpatient/schedules/neurology/)。

核验范围说明：原文脳神経内科译为神经内科，非神经外科。官方排班目录已确认此人，无须提供个人URL给服务。

### OS05 — Shoshana Sztal-Mazer

阿尔弗雷德医院；内分泌科。医院内分泌门诊顾问名单直接给出其姓名与专业，院区为 The Alfred；该院女性内分泌门诊页面另有一致记录。

[官方人员目录](https://www.alfredhealth.org.au/the-alfred/services/hp/endocrinology-clinic)；[官方补充核验](https://www.alfredhealth.org.au/services/womens-endocrinology-health-clinic)。

核验范围说明：The Alfred 为具体医院；Bayside Health/Alfred Health 是其管理组织或网站品牌。输入采用具体医院中文名，未把 Royal Prince Alfred Hospital 当作同一机构。

## 揭示约束

代码冻结并明确请求揭示之前，只向主代理报告样本数量、输入SHA-256与完成状态。名单路径、身份字段和来源URL均留在本目录内。评估时应先保存冻结代码下的原始服务结果，再读取真值评分。不得将真值中的URL、外文机构名、人物履历等预先提供给服务。
