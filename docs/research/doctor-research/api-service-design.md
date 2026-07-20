# Doctor Research Agent API：Azure Codex Gateway 服务化设计方案

> 2026-07-20 实现勘误：医学团队提供的
> `docs/research/采访skill/` 现为权威业务规范。生产镜像原样携带并通过固定白名单
> 加载四个 `SKILL.md`，记录 bundle SHA-256；平台只负责安全适配器、编排、契约与
> 质量门禁，不再以硬编码摘要 Prompt 代替 Skill。`brief` 名称因 v1 API 兼容保留，
> 但当前生产配置执行 6000 字符正文下限和最多 40 篇可核验领域文献目标，并强制
> 第二次 peer-review 自检。执行层 `1.6.2` 只做可逆的工程投影和精简草稿协议：
> 原始四个 Skill 文件与完整 bundle hash 不变；运行时保留业务、检索、证据、引用、
> 写作和质控章节，排除本四文本 API 无法执行的安装命令、外部工具、图/PDF、示例
> 和资产；已核验身份、来源、参考文献和检索报告由 Worker 确定性回填。本文后续关于
> “SKILL.md 不进入镜像”“Phase 1 不执行
> 40 篇/6000 字目标”的段落属于早期设计记录，已由本勘误和
> `README.md` 的 Current production contract 取代。

> 2026-07-20 时延勘误：API 的整体墙钟耗时从创建任务时起不得超过 10 分钟，
> 包括排队和 Worker 重试。生产执行层采用三个受限综述分片并发生成，第四次调用
> 仅返回精简 peer-review 诊断与精确文本修订，不再串行重写整篇 6000 字综述。
> 生产硬截止为 570 秒，单模型调用截止为 240 秒，客户端等待上限为 600 秒；
> 超时必须以 `deadline_exceeded` 失败闭合，不发布部分文件。该变更只修改工程
> 编排、内部并发额度、超时和服务端组装，不修改
> `docs/research/采访skill/` 的任何业务文件。

> 文档状态：实施前审核稿<br>
> 版本：v0.7<br>
> 更新日期：2026-07-17<br>
> 适用仓库：`C:\work\code\codex-gateway`<br>
> 目标环境：Azure Ubuntu VM 上的 `codex_gateway_test`<br>
> 目标：在不影响现有 Codex Gateway 功能的前提下，提供“指定医生公开科研背景调研”异步 Agent API

v0.6 根据实施前审核补齐了以下阻断契约：Research 专用路由和错误格式、独立
control-plane 限流、Worker lease 续租与 fencing、滚动 30 天不同医生配额账本、
SQLite 与 artifact 文件的一致性提交、暂停时间与执行超时口径、默认鉴权下载、
幂等 tombstone、Worker heartbeat、Research audit、备份恢复和磁盘保护。

v0.7 修正 Research `limit_kind` 拼写，补充 run 列表端点，拆分“取消请求”与
“失去 lease”的 Worker 信号，指定逻辑过期 reconciler，冻结 Phase 0 必需的字段和
TypeScript 契约，并把第一方/第三方 Skill 审核发现转化为不可绕过的生产门禁。

## 1. 执行摘要

Azure 上现有 Codex Gateway 是一个 TypeScript/Fastify 实现的 LLM API Gateway。它已经具备 Bearer credential 鉴权、用户与套餐、SQLite、请求限流、模型注册与路由、上游账号池、用量记录、审计、Docker Compose 和公共 HTTPS 入口，但尚不具备长任务状态机、后台 Research Worker、服务端学术检索工具、阶段 checkpoint、身份确认后恢复和多产物管理。

本方案建议在现有 Azure Codex Gateway 项目中新增领域化的 Doctor Research Agent：

1. 客户端通过现有 `Authorization: Bearer` credential 创建调研任务。
2. Fastify Gateway 只执行鉴权、能力授权、输入校验、幂等控制和任务状态读写，不在 HTTP 请求内执行调研。
3. 独立 `research-worker` 容器执行确定性工作流，调用受控的 PubMed、Crossref、ORCID 和官网搜索适配器，并通过 Gateway 的内部 LLM 接口完成结构化提取、证据综合和写作。
4. Research 使用独立 `research.db`、独立 artifact 目录和独立 Docker volume，不复用现有 `gateway.db` 作为任务队列。
5. 任务可以暂停在 `needs_input`，等待用户确认同名医生后继续。
6. 最终返回结构化 JSON 和四个文本产物。

首版只开放内部 `brief` 模式。`full` 模式、40 篇目标文献、6000 字以上综述、PDF、图片和外部商业开放必须在身份准确性、引用准确性、成本、时延和上游容量经过真实验证后再启用。

Phase 1 交付的是 **Doctor Research Brief**，不是原始
`doctor-research-query` Skill 的完整 full 契约。马丁样例以及“约 40 篇目标
文献、6000 字以上综述”不得作为 Phase 1 的验收基线。

不提供“上传任意 Skill 并运行”的通用接口，不把 SKILL.md 直接拼接到 `/v1/chat/completions`，也不允许模型执行任意 shell、任意 URL 或用户提供的脚本。

## 2. 当前系统基线

### 2.1 Azure Codex Gateway 已有能力

当前仓库和 Azure 部署可复用：

- TypeScript/npm workspace；
- Fastify Gateway；
- `Authorization: Bearer` credential 鉴权；
- `cgu_live_*` unified credential 解析；
- subjects、access credentials、plans、entitlements 和 feature policy；
- SQLite migration、store 和审计模式；
- 每 credential 的请求、并发和 token 策略；
- `/v1/chat/completions`、模型注册、上游 provider 路由和账号池；
- AJV JSON Schema 校验；
- request events、token usage、admin audit 和运维快照；
- Docker Compose、非 root 容器、loopback-only listener；
- Nginx 公共 HTTPS 入口 `gw.instmarket.com.au`；
- Azure 发布、回滚、smoke 和备份流程。

### 2.2 当前不具备的能力

现有 Gateway 不能直接完成本业务：

- 没有 Research 长任务队列和 Worker；
- 没有阶段状态机、checkpoint 和恢复；
- 没有 `needs_input` 身份选择分支；
- 没有服务端 PubMed/Crossref/ORCID/官网搜索工具注册；
- 没有 claim-source 证据模型；
- 没有 Research artifact 生命周期；
- 没有对长任务的独立成本和并发预算；
- 当前 Codex provider 默认只读、关闭网络访问和 Web Search；
- 客户端定义 tools 的主要语义是返回并校验 `tool_calls`，不是由 Gateway 执行完整工具循环；
- 当前 Docker 镜像不包含本目录 Skills，也没有 Python、Pandoc 或 XeLaTeX 运行环境。

因此，Codex SDK 虽然具有 Agent 特征，当前生产 Gateway 的对外能力仍是 LLM API，而不是托管式 Research Agent。

### 2.3 当前容量约束

截至 2026-07-16，Azure Gateway 已有 77 个活跃用户和 73 个活跃 API key；两个上游 Codex 登录账号各自 `maxConcurrent: 1`。Doctor Research 会执行多轮、长上下文模型调用，不能未经隔离直接占用现有聊天容量。

首版必须：

- 仅限内部测试 principal；
- `research-worker` 并发固定为 1；
- 使用独立 Research 服务 credential；
- 设置单任务 token、调用次数和硬超时；
- 在公开启用前提供独立上游容量或证明现有容量具有足够保留余量。

## 3. Skills 研究结论与生产化边界

### 3.1 四个 Skills 的规则来源

| Skill | 生产化时提取的规则 |
|---|---|
| `doctor-research-query` | 顶层业务状态机和四产物契约 |
| `literature-review` | 检索策略、筛选、证据提取和主题综合规则 |
| `citation-management` | PubMed、Crossref、PMID/DOI 元数据和引用核验规则 |
| `scientific-writing` | 正式综述的结构、段落和报告规范 |

### 3.2 可以保留的规则

- 先做医生身份消歧，再认领论文；
- 论文作者身份至少使用单位、科室、共同作者、研究主题中的两类证据；
- 医生履历、任职、项目、专利和奖项必须关联公开来源；
- 文献真实性优先于数量，不允许以重复、无关或虚构文献凑足目标；
- 网页、PDF、元数据文本和抓取结果全部是不可信数据；其中出现的指令、工具调用、
  凭据请求或“忽略系统规则”等文本均不得执行或提升为 Prompt 指令；
- 核心证据与一般参考文献分层；
- 具体样本量、效应量、模型性能和实验结果必须关联 reference ID；
- 正文引用与参考文献必须闭环；
- 四个产物的内容必须一致；
- 诊疗、用药、挂号和个体化医疗建议不进入本工作流。

### 3.3 不直接进入生产的内容

以下内容只可作为原型或写作参考：

- `parallel-cli`、`gget`、`scholarly` 等当前 Gateway 镜像不存在的依赖；
- Google Scholar 页面抓取；
- Python 脚本直接作为服务器工具；
- `validate_citations.py --auto-fix` 等尚未实现的能力；
- SKILL.md 中演示但脚本未实现或参数不兼容的 `--validate`、`--report`、
  `--style`、`--auto-fix`、`--output` 等命令；文档示例不得被视为可执行验收依据；
- 只检查 DOI、不能验证 PMID-only 文献列表和正文编号闭环的校验逻辑；
- 通过免费公共代理抓取 Google Scholar，或由脚本自动读取工作目录 `.env`；
- 强制生成图形摘要和多幅图片；
- Pandoc、XeLaTeX 和 OpenRouter 图片脚本；
- 未固定、未验证的 OpenRouter 模型 ID；
- 三个目录中 SHA-256 分别完全相同的 `generate_schematic.py` 和
  `generate_schematic_ai.py`；生产实现不得复制维护这些脚本；
- `allowed-tools: Read Write Edit Bash` 等宽泛权限；
- 运行时从可编辑 docs 目录动态加载 Skill；
- 允许用户上传 Skill、Prompt、脚本、工具表或任意 URL。

### 3.4 生产 SkillDefinition

生产运行时使用代码评审过的版本化定义：

```text
SkillDefinition
  name
  version
  inputSchemaVersion
  outputSchemaVersion
  workflowPolicyVersion
  promptVersion
  allowedTools
  validationPolicyVersion
  artifactPolicyVersion
```

原始 SKILL.md 是设计来源，不是生产可执行代码。每次 run 固定 Skill、Prompt、Schema、模型、工具和验证策略版本。

### 3.5 仓库路径与第三方快照

原 `docs/采访skill/` 是实施前临时收集目录，不作为长期生产路径。Phase 0 已在
2026-07-17 完成迁移，后续生产代码、schema、migration 和正式契约只使用：

```text
docs/research/doctor-research/
docs/reference/skills/k-dense/
```

本项目业务设计、API 方案和第一方 `doctor-research-query` 放在前者；
`citation-management`、`literature-review` 和 `scientific-writing` 放在后者，
并明确标记为第三方参考快照。旧路径下不得继续产生实施 PR；路径迁移是 Phase 0
入口条件，不是退出前可补做的文档整理。

当前仓库已不存在旧目录，迁移后的所有仓库相对路径均为 ASCII；中文展示文件也已
使用 ASCII 存储名并隔离在 `samples/known-invalid/` 下。

三个第三方 SKILL.md 当前声明 `skill-author: K-Dense Inc.` 和 MIT license，
但本地快照没有记录准确上游 URL、tag/commit、获取日期和修改历史，也没有独立
LICENSE/NOTICE 文件。静态审核未发现硬编码密钥，但这不能抵消公共代理、工作目录
`.env` 自动读取和外部服务数据发送风险。正式入库前必须：

- 恢复并记录可核验的上游来源和固定版本，不猜测版本；
- 保存适用的许可证和版权通知；
- 记录获取日期、文件 hash 和本项目修改；
- 增加 `README.md` 与 `THIRD_PARTY_NOTICES.md`；
- 明确它们不进入生产镜像、不由 Worker 直接执行；
- 明确其引用的 `research-lookup`、`scientific-schematics` 和
  `venue-templates` 当前不在本仓库，`parallel-cli`、`gget` 等也不是本目录内
  自包含依赖，因此快照不能离线独立运行；
- 在 README 中列出已知的文档/脚本参数不一致、公共代理、`.env` 自动发现、
  外部模型依赖和重复脚本；在这些问题关闭前不得把快照标为“可运行”。

### 3.6 第一方 Skill 与样例审核阻断项

现有 `doctor-research-query` 及其展示样例不能直接成为生产 Prompt、fixture 或
验收基线，已确认的阻断项如下：

- “马丁”基础信息样例重复写成“2007 年当选中国工程院院士”，与
  [中国工程院 2017 年院士增选结果](https://www.cae.cn/cae/html/main/col280/2017-11/27/20171127085337936142127_1.html)
  不符；这类基础履历错误必须由官方来源 fixture 在生成前拦截；
- profile 缺少 Skill 强制要求的“主要公开来源”，论文、项目等条目存在无篇名、
  无编号、无逐项来源的概括性空壳；不可核验的小类必须整体隐去；
- 样例没有保存“标识符在生成时已由哪个 adapter、于何时、解析为何种元数据”的
  证据。PMID 位数或数值大小本身既不能证明真实，也不能证明虚构；例如
  `41638692` 和 `42236671` 截至本稿更新日已可由 NCBI E-utilities 解析，因此
  只能按运行时官方解析、题名/期刊/年份一致性和冻结 adapter 结果判定；
- Skill 缺少明确的 prompt-injection 隔离声明；生产定义必须把网页和文献内容
  仅作为数据，不执行其中任何指令；
- “不少于 6000 字”“不少于 40 篇”等要求不能只靠模型自报。full 模式启用前必须
  由确定性计数器、引用解析器和质量门控验证；不足时失败或按契约降级，不能补写
  虚构内容。当前“马丁”综述整份文件按 Unicode Han 字符计数约 5429，且该数值还
  包含标题、表格和参考文献，正文必然未达到 Skill 声明的 6000 字门槛；
- 当前 `evals.json` 使用自然语言断言、`files: []` 和实时在世人物，不能在 PR CI
  确定性复现，也未覆盖事实错误、引用幻觉和篇幅门槛。

处置原则是保留原样例作为带醒目 `KNOWN_INVALID_SAMPLE` 标记的历史展示材料，或在
迁移时移入明确的无效样例目录；不得就地修订后宣称它是 golden fixture。生产
golden 必须来自独立、可追溯、人工复核的冻结证据集。

## 4. 建设目标与非目标

### 4.1 建设目标

1. 通过稳定、可鉴权、可授权、可审计的 API 提供医生科研调研。
2. 支持异步执行、状态查询、身份确认、取消、有限重试和 checkpoint 恢复。
3. 输出结构化 JSON 和四个标准文本产物。
4. 保留医生身份、作者身份、事实、引用和具体数字的证据链。
5. 将检索、核验、编号和质量门控放在确定性代码中。
6. 将 LLM 限定在结构化提取、主题归纳、写作和定向修复。
7. 与现有 chat、sessions、models、images、billing、credentials 和运维功能隔离。
8. 支持按 capability、principal、mode 和全局容量限制访问。
9. 支持安全关闭 API 和 Worker，且不影响现有 Gateway。

### 4.2 非目标

首版不包括：

- 通用 Skill 执行平台；
- 任意 Prompt、脚本或 shell 执行；
- 运行时安装第三方 Skill；
- 个体化诊断、治疗、用药或挂号建议；
- 医生临床能力排名、个人品格评价或招聘决策；
- 绕过登录、验证码、付费墙或出版商许可；
- Google Scholar 网页抓取；
- CNKI、万方等未获正式授权的数据源；
- 对所有主题强制凑足 40 篇文献；
- PDF、图形摘要和科学示意图；
- 对外 callback URL；
- 修改现有 8 个公开模型或新增公开 `research` 模型；
- 依赖其他项目的 Web 框架、数据库、worker 或 artifact 实现。

## 5. 核心架构决策

| 决策 | 结论 |
|---|---|
| 部署位置 | Azure `codex-gateway` 同一仓库、同一 Compose 项目和同一公共 Gateway |
| API 形态 | `/gateway/research/v1` 下的领域化异步 REST API，不占用 OpenAI `/v1` 命名空间 |
| API 承载 | 现有 Fastify Gateway 中的轻量控制面路由 |
| 重任务执行 | 独立 `research-worker` 容器 |
| 维护调度 | 独立 `research-maintenance` 进程；Worker 默认不内嵌 scheduler，且新鲜备份未建立时不进入 ready |
| 数据库 | 独立 SQLite `research.db`，不复用 `gateway.db` |
| Artifact | 独立 `research_state` volume 中的文件，SQLite 保存元数据 |
| 备份 | 一致 SQLite snapshot 和 artifact manifest 写入独立批准的 backup target；同 `research_state` 内副本不算备份 |
| 鉴权 | 复用现有 `Authorization: Bearer` credential auth |
| 授权 | 新增 `doctor_research` capability，默认不授予 |
| 编排 | 确定性状态机加受控 LLM 节点 |
| LLM | Worker 通过内部 Gateway URL 和专用服务 credential 调用 |
| 学术工具 | TypeScript 白名单 adapters，不执行 bundled Python scripts |
| 文献主源 | PubMed；Crossref 和 ORCID 用于核验与消歧 |
| 官网发现 | 使用经审核的搜索 API 或受控域名发现服务 |
| Google Scholar | 不进入生产关键路径 |
| 公开模型表面 | 保持当前 8 模型完全不变 |
| 首版范围 | 内部 brief |
| 下载 | Phase 1 默认使用 Bearer 鉴权下载；可转发 signed URL 默认关闭 |
| 限流 | Research control-plane 独立限流，不消耗普通 chat request 计数 |
| 回滚 | 关闭 Research 路由与 Worker，保留数据；Gateway 镜像不得低于 capability 兼容读取版本 |

## 6. 总体架构

```text
Web / Desktop / Internal Client
                |
                v
Nginx: gw.instmarket.com.au
                |
                v
Existing Fastify Gateway
  - Bearer credential auth
  - subject / entitlement / capability
  - /gateway/research/v1 routes and Research error dialect
  - research request validation
  - idempotency
  - status / result / artifact authorization
  - no web search or LLM call in request handlers
                |
                v
research_state Docker volume
  - research.db
  - artifacts/
        ^       \
        |        +--> approved Research backup target
        |             - consistent SQLite snapshots
        |             - immutable artifacts and manifests
Research Worker
  - SQLite lease and checkpoint
  - Doctor Research state machine
  - PubMed / Crossref / ORCID / official-web adapters
  - evidence store and quality gates
  - internal LLM client
                |
                v
http://gateway:8787/v1/chat/completions
  - dedicated Research service credential
  - configured existing model
  - existing provider routing and usage observations
```

### 6.1 Fastify Gateway 职责

- 使用现有 credential auth 建立 subject 和 credential context；
- 检查 entitlement 中是否包含 `doctor_research`；
- 校验请求 JSON；
- 执行 Research 专用幂等控制；
- 创建 run；
- 查询状态、候选身份、结果和 artifact；
- 处理身份选择和取消；
- 提供 Bearer 鉴权 artifact 下载；仅在显式启用时签发短时 bearer URL；
- 不调用外部网站；
- 不调用 LLM；
- 不执行文献筛选、长文本生成、PDF 或重试循环。

### 6.2 Research Worker 职责

- 从 `research.db` 原子领取 queued run；
- 执行阶段状态机；
- 在每个阶段写 checkpoint；
- 执行受控外部 adapter；
- 调用内部 Gateway LLM；
- 验证结构化输出；
- 响应取消；
- 生成结果和四个 artifact；
- 记录阶段耗时、token、外部调用和错误分类；
- 不监听公共端口。

### 6.3 Research Store

Research Store 是独立 SQLite 数据库：

```text
/var/lib/codex-gateway-research/research.db
```

要求：

- `PRAGMA journal_mode=WAL`；
- `PRAGMA foreign_keys=ON`；
- 配置 `busy_timeout`；
- API 和 Worker 使用短事务；
- 单 Worker 起步；
- 不在事务中执行网络或模型调用；
- 大结果和 artifact 正文不写入 `research_runs` 热表；
- 不与现有 Gateway Store 共用数据库连接或 migration 版本。

由于 Research Store 与 `gateway.db` 分离，`subject_id` 和 `credential_id`
仅作为跨库不可变引用保存，不建立 SQLite 外键。控制面每次请求仍须通过现有
Gateway Auth 重新认证，不能仅凭这些 ID 授权。

### 6.4 Research Model Client

首版 Worker 使用内部 Docker 网络访问 Gateway：

```text
RESEARCH_LLM_BASE_URL=http://gateway:8787
RESEARCH_LLM_MODEL=goldencode
RESEARCH_LLM_REASONING_EFFORT=none|low|medium|high
RESEARCH_LLM_BEARER_TOKEN_FILE=/run/secrets/research_llm_bearer
```

服务 credential：

- 只供 Research Worker 使用；
- 明文 Bearer token 不写入仓库、日志、数据库或 artifact；
- 使用独立 subject/credential 便于用量归因；
- 不授予 `doctor_research`，因此不能从 Research 控制面创建或恢复 run；
- 不授予 `image_generation`，并复用现有 image 路由的 capability 强制检查；
- 不向该容器提供 Billing Admin token 或其他管理面认证材料；
- Phase 0/1 的 Worker 不发送 `tools`、`tool_choice` 或 chat
  `response_format`。当前 Gateway 未强制 `chat`/`tools` capability，因此不能把
  “policy 中只有 `chat`”或“未列出 `tools`”表述成安全边界；
- 只能调用审核通过的 `RESEARCH_LLM_MODEL`。该限制必须由 Gateway 的
  credential 级精确模型允许清单强制执行，不能只依赖 Worker 环境变量；
- 配置独立 rpm、rpd、并发和 token 策略；
- 不作为用户 credential 返回；
- 丢失或轮换时按现有 credential 流程处理。

Worker 的每次内部 LLM 请求还必须：

- 使用 `x-medcode-client-session-id=<run_id>` 建立 run 级归因；
- 使用长度受限的 `x-medcode-client-turn-code=research:<stage>:<attempt>`；
- 保存 Gateway 返回的 `X-Request-Id` 到 `research_stage_runs`，以便与
  `gateway.db.request_events` 对账；
- 在调用前按输入估算和最大输出做 per-run reservation，调用后用 Gateway usage
  或保守估算结算；缺失 usage 时不能记为 0；
- 在达到 per-run LLM call、input/output token 或 wall-clock budget 前拒绝发起
  下一次调用。

专用 credential 的 Gateway token policy 是第二层总量保护，不能代替
`research.db` 内跨多次调用、跨 Worker 重启持久化的 per-run 预算账本。

credential 级模型限制采用向后兼容的加法设计：在 `gateway.db` 的
`access_credentials` 通过 schema migration `22` 增加可空
`allowed_public_models_json TEXT`。字段名、NULL 语义和错误码在 Phase 0 编码前
冻结：`NULL` 保持现有 credential 可访问所有已启用公开模型的语义；非空值必须是
至少一个合法公开模型 ID 的去重 JSON string array，空数组、重复、未知 ID 和其他
JSON 类型均拒绝写入。Research 服务 credential 只保存
`[RESEARCH_LLM_MODEL]`。`/v1/chat/completions` 在 provider 选择前检查解析后的
公开模型 ID，不在清单内返回
`403 model_not_allowed_for_credential`。

此字段不改变 `/v1/models` 的公共 8 模型列表，也不追溯收紧现有 credential。
该 migration 和执行检查必须进入 capability 兼容读取先行版本，使 Research
上线后的任何允许回滚版本仍能维持模型隔离。

公开启用前必须解决 Research 与普通聊天共享上游账号容量的问题。允许的方案是独立上游账号、独立 provider 配额或经过验证的保留并发；不能仅依赖“Worker 并发为 1”来证明无影响。

## 7. Doctor Research 工作流

### 7.1 顶层状态

| 状态 | 含义 |
|---|---|
| `queued` | 已创建，等待 Worker |
| `running` | Worker 正在执行 |
| `needs_input` | 需要用户确认医生身份 |
| `succeeded` | 结果和 artifact 已生成 |
| `failed` | 不可恢复失败 |
| `cancelled` | 用户或管理员取消 |
| `expired` | 结果已超过保留期 |

### 7.2 合法状态迁移

| 当前状态 | 事件 | 下一状态 |
|---|---|---|
| 新建 | 请求通过 | `queued` |
| `queued` | Worker 获得 lease | `running` |
| `queued` | 用户取消 | `cancelled` |
| `running` | 多个高匹配医生 | `needs_input` |
| `needs_input` | 选择有效候选且 active brief 配额可用 | `queued` |
| `needs_input` | 选择有效候选但 active brief 配额已满 | 保持 `needs_input` |
| `needs_input` | 拒绝全部候选 | `failed` |
| `needs_input` | 超过 72 小时 | `cancelled` |
| `needs_input` | 用户取消 | `cancelled` |
| `running` | 当前 Worker 以有效 fencing token 写入可重试失败 | `queued` |
| `running` | lease 到期且新 Worker 原子接管 | `running`（新 generation） |
| `running` | 全部门控通过 | `succeeded` |
| `running` | 不可恢复失败 | `failed` |
| `running` | Worker 观察到取消 | `cancelled` |
| `succeeded` / `failed` / `cancelled` | 结果可见性保留期结束 | `expired` |

两条基于时钟的迁移由 §14.3 TTL reconciler 持久化并写 audit；API 读取只负责在
reconciler 延迟时按相同时间条件 fail closed，不作为状态迁移执行者。

`needs_input` 释放 Worker lease，不占 active Worker 并发，也不占
`queued/running` active brief 配额；但每个 subject 最多保留 10 个未过期
`needs_input` run。身份选择恢复是一次新的 active admission：成功转为 `queued`
后立即占用 active brief 配额。

恢复必须在一个短 `BEGIN IMMEDIATE` 事务内完成：

1. 认证 subject、验证 run 所有权并计算 canonical request hash；
2. 查询幂等记录：同 key/同 hash 直接重放成功收据，同 key/不同 hash 返回
   409；
3. 没有幂等记录时，再验证 run 仍为 `needs_input`、尚未过期且 candidate 有效；
4. 检查该 subject 是否已有其他 `queued/running` brief；
5. 配额可用时，原子写入 candidate 选择、`status=queued`、下一 stage、
   `resume_count + 1` 和幂等成功记录；
6. 配额已满时回滚并返回 `429 rate_limited`，
   `research_code=research_quota_exceeded`、
   `limit_kind=research_active_brief`，run 保持 `needs_input`，candidate、
   `resume_count` 和 `needs_input_expires_at` 均不改变。

429 响应包含 `limit_kind=research_active_brief` 和 `retry_after_seconds`。这次拒绝不写
成功幂等记录，客户端可以在额度释放后使用同一 `Idempotency-Key` 重试。

### 7.3 执行阶段

1. `validate_input`
2. `discover_identity`
3. `resolve_identity`
4. `collect_profile_evidence`
5. `infer_research_topics`
6. `build_search_strategy`
7. `search_literature`
8. `verify_metadata`
9. `screen_and_extract_evidence`
10. `synthesize_review`
11. `generate_questions`
12. `generate_answers`
13. `validate_outputs`
14. `render_artifacts`
15. `complete`

状态机决定阶段、工具、预算和重试。模型不得自行跳过阶段或扩大工具权限。

### 7.4 身份消歧

医生身份至少使用以下两类证据：

受控 beta 先收窄 admission：`hospital` 和 `department` 均为必填身份锚点；
`orcid` 可选但一旦提供必须精确解析。首版论文归属必须在目标作者自己的 PubMed
affiliation 中同时命中医院和科室。只有姓名、只有一个锚点或只在其他作者单位中
命中的请求不得进入排队；更宽输入和候选身份交互留待完成真实歧义质量验证后开放。

- 医院或大学；
- 科室；
- 城市或职称；
- 官方机构主页；
- ORCID；
- 共同作者；
- 长期研究主题。

若只有姓名且存在多个高匹配对象，保存 2 至 3 个候选并进入 `needs_input`。在身份确认前不得认领论文、项目、专利或奖项。

确认后生成 `canonical_identity_id`，绑定：

- 规范化姓名；
- 机构 canonical ID；
- 科室；
- 城市；
- 可用时的 ORCID；
- `identity_resolution_version`。

### 7.5 brief 与 full

| 项目 | brief | full |
|---|---|---|
| 首版状态 | 启用 | 关闭 |
| 参考文献目标 | 10 至 15 篇 | 约 40 篇 |
| 核心证据 | 3 至 5 篇 | 3 至 8 篇 |
| 综述正文 | `zh-CN` 约 1500 至 2500 汉字；`en` 约 900 至 1500 words | `zh-CN` 不少于 6000 汉字；`en` 不少于 3500 words |
| 主题小节 | 2 至 4 个 | 4 至 7 个 |
| 定向修复 | 最多 1 轮 | 最多 2 轮 |
| 目标 P95 | 8 分钟以内 | 25 分钟以内 |

文献数量是目标，不是成功硬门槛。相关且可核验的文献不足时允许 `passed_with_warnings`，但必须返回实际数量、检索范围和原因。

`passed_with_warnings` 只用于单个 run 已达到批准的最低证据门槛、但没有达到
目标数量的情况。它不能替代目标人群层面的覆盖率验证，也不能让系统性漏召回
通过 Phase 0。低于最低证据门槛时必须以
`failed/insufficient_research_evidence` 结束。

## 8. API 设计

### 8.1 通用约定

Research 是 Gateway 自定义业务 API，固定使用以下前缀，不进入 OpenAI-compatible
`/v1/*` 命名空间：

```text
/gateway/research/v1
```

控制面请求使用：

```http
Authorization: Bearer <gateway-credential>
Content-Type: application/json
```

创建、身份选择和取消支持 `Idempotency-Key`。Research 幂等记录独立于 Gateway
其他业务，不复用其他命名规则或 parser。

成功的状态变更与幂等记录必须在同一 SQLite 事务提交。同一 subject、endpoint、
key 和 canonical request hash 重放成功结果；同一 key 对应不同请求返回
`409 idempotency_conflict`。未发生状态变更的可重试 429/503 不写成功幂等记录。

所有时间使用 UTC ISO 8601。所有 JSON 响应包含 `schema_version` 和
`request_id`，所有 JSON 与 artifact 下载响应都返回 `X-Request-Id`。资源只能由
创建 run 的 Gateway subject 访问。普通
credential 请求不存在或属于其他 subject 的 run/artifact 时统一返回 404，避免
资源枚举；`resource_access_denied` 仅预留给未来已认证 operator 的显式 HTTP
管理面授权失败，Phase 1 不返回该错误。

现有 Gateway 会对 `/v1/*` 鉴权和限流错误使用 OpenAI 错误格式，并对所有未豁免
路由执行普通 credential request 限流。Phase 0 编码前冻结以下 TypeScript 表示：

```ts
export type GatewayResponseDialect = "gateway" | "openai" | "research";

declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
    skipAuth?: boolean;
    skipRateLimit?: boolean;
    skipObservation?: boolean;
    responseDialect?: GatewayResponseDialect;
  }
}

const researchRouteConfig = {
  responseDialect: "research",
  skipRateLimit: true
} as const satisfies import("fastify").FastifyContextConfig;
```

`responseDialect=research` 必须从最早的 auth hook 起生效，确保鉴权失败也使用
Research error envelope；`skipRateLimit` 只跳过普通 chat request limiter，不跳过
鉴权、Research 专用 limiter、Research admission quota 或 Worker 服务 credential
调用 `/v1/chat/completions` 时的现有请求/token 限制。

所有已注册 Research 路由必须显式复用 `researchRouteConfig`。正常路由不得仅凭
URL 前缀推断 dialect；只有 not-found handler 在没有 route config 时可按严格的
`/gateway/research/v1/` 前缀选择 Research 404 envelope。`GatewayErrorCode` 的
Phase 0 加法扩展冻结为：

```text
model_not_allowed_for_credential
research_capability_required
resource_access_denied
run_not_found
artifact_not_found
run_not_complete
identity_selection_not_expected
invalid_run_transition
run_expired
artifact_expired
research_worker_unavailable
research_storage_unavailable
research_backup_stale
```

其中 `resource_access_denied` 仅为未来 HTTP operator 管理面预留。现有通用
`missing_credential`、`invalid_credential`、`invalid_request`、
`idempotency_conflict`、`idempotency_expired` 和 `rate_limited` 不重复定义；
异步 `terminal_reason` 也不加入 `GatewayErrorCode`。

Research 专用 control-plane limiter 在认证后按 credential 和 subject 执行，分别
限制 mutation 与 read/poll 请求。它不消耗普通 chat 的 rpm/rpd，也不建立 LLM
token reservation。所有 429 复用 Gateway 公共 `rate_limited` 主错误码和
`rate_limit_contract_version=1`，Research 原因放在 `research_code`，并扩展以下
`limit_kind`：

```text
research_control_read_minute
research_control_mutation_minute
research_active_brief
research_needs_input
research_daily_runs
research_unique_doctors_30d
research_global_queue
```

以上七个字符串是 `packages/core` 中 `LimitKind` union 的最终 Phase 0 加法值，
不得引入 `active_brief` 等短别名。Research admission/control-plane 429 的
`GatewayErrorCode` 固定为 `rate_limited`，`research_code` 当前仅定义
`research_quota_exceeded`。

错误 envelope：

```json
{
  "schema_version": "doctor_research_error.v1",
  "request_id": "req-...",
  "error": {
    "code": "rate_limited",
    "research_code": "research_quota_exceeded",
    "message": "Research quota exceeded.",
    "rate_limit_contract_version": 1,
    "limit_kind": "research_active_brief",
    "rate_limit_origin": "gateway",
    "retry_after_seconds": 30
  }
}
```

非 429 错误沿用相同 envelope，但不包含 rate-limit 字段。公开 `message` 和
`details` 必须经过固定映射，不得直接返回 SQLite、provider、URL、容器路径或
内部异常文本。

### 8.2 创建任务

```http
POST /gateway/research/v1/doctor-runs
Idempotency-Key: research:<client-generated-id>
```

请求：

```json
{
  "doctor": {
    "name": "Shen Baiyong",
    "hospital": "Ruijin Hospital",
    "department": "Surgery",
    "title": "Professor, Chief Physician",
    "city": "Shanghai",
    "orcid": null,
    "official_profile_urls": [
      "https://www.shsmu.edu.cn/english/info/1336/2980.htm"
    ],
    "literature_identity": {
      "name": "Baiyong Shen",
      "hospital": "Ruijin Hospital",
      "department": "Surgery"
    }
  },
  "mode": "brief",
  "language": "zh-CN",
  "options": {
    "publication_years": 5,
    "citation_style": "vancouver"
  },
  "client_reference": "optional-client-reference"
}
```

约束：

- `name` 必填，trim 后 2 至 100 个字符；
- `hospital`、`department`、`title`、`city` 和 `orcid` 均有独立长度与字符集
  上限；所有字符串先做 Unicode NFC，再参与 canonical request hash；
- `official_profile_urls` 可包含 1 至 3 个 HTTPS URL，只允许命中配置中的官网
  域名；`direct` 官网来源模式下必填，Gateway 在排队前拒绝缺失、跨域、带
  credential、非 HTTPS、非 443 或含 fragment 的 URL；
- `literature_identity` 仅用于官网已明确桥接展示姓名与 PubMed 英文姓名的
  双语身份；出现时 `name`、`hospital`、`department` 三项必须同时提供。
  Worker 要求展示姓名与文献姓名在同一有界官网身份片段内共现，并逐篇验证
  匹配作者的同一条 affiliation 同时包含文献医院和科室，否则失败关闭；
- `mode` 为 `brief` 或 `full`，首版只允许 `brief`；
- `language` 首版允许 `zh-CN` 和 `en`；
- `publication_years` 为 1 至 10；
- `citation_style` 首版固定为 `vancouver`；
- `client_reference` 最长 128 个字符，只作为不可信显示元数据；
- Phase 1 固定生成 profile、review、questions 和 answers 四个标准 artifact，
  请求不接受 `outputs`；未来若支持子集必须升级 input schema version；
- 不接受 model、system prompt、tool list、skill path 或任意未审核 URL；
- `Idempotency-Key` 必填，总长不超过 128。

响应：HTTP 202

```json
{
  "schema_version": "doctor_research_run.v1",
  "request_id": "req-...",
  "run_id": "drr_...",
  "status": "queued",
  "stage": "validate_input",
  "mode": "brief",
  "skill": {
    "name": "doctor-research-query",
    "version": "1.6.2"
  },
  "created_at": "2026-07-17T01:30:00Z",
  "status_url": "/gateway/research/v1/doctor-runs/drr_...",
  "result_url": "/gateway/research/v1/doctor-runs/drr_.../result"
}
```

同一 subject、endpoint、Idempotency-Key 和 canonical request hash 在 7 天内返回
同一 run。相同 key 对应不同请求返回 `409 idempotency_conflict`。第 8 天起至
tombstone 到期，同 key/同 hash 返回 `409 idempotency_expired`，不得创建第二个
run；同 key/不同 hash 仍返回 `409 idempotency_conflict`。tombstone 物理删除后
key 才可重新使用。

### 8.3 查询与列出任务

按 ID 查询：

```http
GET /gateway/research/v1/doctor-runs/{run_id}
```

```json
{
  "schema_version": "doctor_research_run.v1",
  "request_id": "req-...",
  "run_id": "drr_...",
  "status": "running",
  "stage": "verify_metadata",
  "progress": {
    "completed_stages": 7,
    "total_stages": 15,
    "percent": 46
  },
  "warnings": [],
  "created_at": "...",
  "updated_at": "..."
}
```

进度只在阶段边界更新，不按 token 或单篇文献更新。进入终态时响应增加
`terminal_reason` 和经过固定映射的 `terminal_detail_public`；不得返回内部异常。
在 Store 持久化并由 checkpoint 原子更新真实计数器之前，v1 状态响应不返回
`statistics`，也不得用固定的零值占位。

状态轮询不消耗用户的普通 chat request 或 LLM token 配额，但使用独立的
Research control-plane read 速率限制。

为避免客户端丢失 `run_id` 后只能依赖幂等重放，Phase 1 提供 subject-scoped
列表：

```http
GET /gateway/research/v1/doctor-runs?limit=20&status=running&cursor=...
```

```json
{
  "schema_version": "doctor_research_run_list.v1",
  "request_id": "req-...",
  "items": [
    {
      "run_id": "drr_...",
      "status": "running",
      "stage": "verify_metadata",
      "mode": "brief",
      "doctor": {
        "name": "马丁",
        "hospital": "华中科技大学同济医学院附属同济医院",
        "department": "妇产科"
      },
      "client_reference": "optional-client-reference",
      "created_at": "2026-07-17T01:30:00Z",
      "updated_at": "2026-07-17T01:35:00Z",
      "completed_at": null,
      "expires_at": null,
      "status_url": "/gateway/research/v1/doctor-runs/drr_...",
      "result_url": "/gateway/research/v1/doctor-runs/drr_.../result"
    }
  ],
  "next_cursor": null
}
```

列表契约：

- 只能列出当前认证 subject 自己的 run，不提供跨 subject 参数或 operator 复用；
- `limit` 默认 20、最大 100；`status` 可选且只能是 §7.1 枚举值；
- 固定按 `(created_at DESC, run_id DESC)` 排序；`cursor` 是服务端生成的不透明
  continuation token，不含权限，非法、过期或参数不匹配时返回 `400 invalid_request`；
- 分页必须使用 keyset，不使用会在并发插入时跳项的 offset；
- item 只返回恢复任务所需摘要，不返回完整 input、候选身份、结果、artifact 或
  内部错误；
- 列表与点查使用同一 Research read limiter 和逻辑 TTL 口径；物理尚未清理但已
  到期的终态 item 必须表现为 `expired`。

### 8.4 身份选择

`needs_input` 状态返回：

```json
{
  "schema_version": "doctor_research_run.v1",
  "request_id": "req-...",
  "run_id": "drr_...",
  "status": "needs_input",
  "stage": "resolve_identity",
  "needs_input_expires_at": "2026-07-20T01:30:00Z",
  "input_required": {
    "type": "identity_selection",
    "candidates": [
      {
        "candidate_id": "dc_...",
        "name": "王伟",
        "hospital": "示例医院",
        "department": "心内科",
        "city": "北京",
        "sources": [
          {
            "title": "机构主页",
            "url": "https://example.org/..."
          }
        ]
      }
    ]
  }
}
```

选择：

```http
POST /gateway/research/v1/doctor-runs/{run_id}/identity-selection
Idempotency-Key: research:<client-generated-id>
```

```json
{
  "candidate_id": "dc_..."
}
```

接受后返回 `status=queued`、`stage=collect_profile_evidence`，`resume_count` 加 1，`attempt_count` 不增加。

identity-selection 的幂等行为：

- 同一 key 和同一 body 在之前已经成功时，返回原选择收据，不再次迁移状态或
  增加 `resume_count`；
- 同一 key 但 `candidate_id` 或 `action` 不同，返回
  `409 idempotency_conflict`；
- 使用不同 key 请求一个已不处于 `needs_input` 的 run，返回
  `409 identity_selection_not_expected`；
- active brief 配额已满时返回 `429 rate_limited`，其中
  `research_code=research_quota_exceeded`、
  `limit_kind=research_active_brief`，并附带
  `Retry-After`，run 保持 `needs_input`，且不写成功幂等记录；
- 成功选择、run 状态迁移和幂等成功记录必须在同一事务提交。

拒绝全部：

```json
{
  "action": "reject_all"
}
```

run 转为 `failed`，`terminal_reason=identity_rejected_by_user`。

### 8.5 获取结果

```http
GET /gateway/research/v1/doctor-runs/{run_id}/result
```

仅 `succeeded` 返回 200。未完成返回 `409 run_not_complete`；已过期返回 `410 run_expired`。

结果结构：

```json
{
  "schema_version": "doctor_research_result.v1",
  "request_id": "req-...",
  "run_id": "drr_...",
  "doctor": {
    "name": "马丁",
    "hospital": "...",
    "department": "..."
  },
  "identity_resolution": {
    "status": "verified",
    "confidence": "high",
    "canonical_identity_id": "dci_...",
    "matched_by": [
      "institution",
      "department",
      "research_topic"
    ]
  },
  "profile": {
    "positions": [],
    "expertise": [],
    "education_and_career": [],
    "research_directions": [],
    "representative_outputs": [],
    "claims": []
  },
  "review": {
    "title": "...",
    "abstract": "...",
    "keywords": [],
    "markdown": "...",
    "core_evidence": [],
    "references": [],
    "search_report": {}
  },
  "source_coverage": {
    "literature_sources": [
      "pubmed",
      "crossref"
    ],
    "profile_sources": [
      "official_web"
    ],
    "cutoff_date": "2026-07-17",
    "warnings": [
      "licensed_chinese_literature_not_covered"
    ]
  },
  "predicted_questions": [],
  "answers": [],
  "quality": {
    "status": "passed_with_warnings",
    "checks": [],
    "warnings": []
  },
  "artifacts": [
    {
      "artifact_id": "dra_...",
      "kind": "profile",
      "filename": "马丁_基础信息与研究方向.md",
      "content_type": "text/markdown; charset=utf-8",
      "size_bytes": 12345,
      "sha256": "...",
      "expires_at": "2026-08-16T01:30:00Z",
      "download_url": "/gateway/research/v1/artifacts/dra_.../download"
    }
  ]
}
```

实际成功结果必须列出四个 artifact manifest entry；数组中的示例只展示一个 entry。

### 8.6 Artifact

Phase 1 默认使用经过 Bearer 鉴权的下载端点：

```http
GET /gateway/research/v1/artifacts/{artifact_id}/download
Authorization: Bearer <gateway-credential>
```

Gateway 重新认证当前 credential，并按创建 run 的 subject 校验 artifact 所有权。
下载不消耗普通 chat request/token 配额，但消耗 Research control-plane read 限额。
响应必须设置：

```http
Content-Type: text/markdown; charset=utf-8
Content-Disposition: attachment; filename="doctor-research.md"; filename*=UTF-8''...
Cache-Control: private, no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Markdown artifact 使用 `text/markdown; charset=utf-8`，questions TXT 使用
`text/plain; charset=utf-8`，不得根据文件内容或用户输入反射任意 MIME type。

文件名进行路径、CR/LF 和 Unicode 规范化；`Content-Disposition` 同时提供固定
ASCII `filename` fallback 和按 RFC 6266/5987 编码的
`filename*=UTF-8''...`。下载前必须核对 artifact 元数据、storage version、
sha256、文件大小和逻辑 `expires_at`；到期后立即返回
`410 artifact_expired`，不依赖物理文件是否已被 cleanup 删除。

可转发 signed URL 不是 subject 身份证明，而是有效期内任何持有者都可使用的
bearer capability。Phase 1 默认：

```text
RESEARCH_SIGNED_URL_ENABLED=false
```

只有在完成隐私评估、Nginx 查询参数日志脱敏和泄漏测试后才可启用：

```http
GET /gateway/research/v1/artifacts/{artifact_id}/signed-url
Authorization: Bearer <gateway-credential>

GET /gateway/research/v1/artifacts/{artifact_id}/signed-download?exp={unix_ts}&sig={signature}
```

启用时必须：

- 签发前先按 Bearer credential 校验 subject 所有权；
- 使用 HMAC-SHA256、固定 canonical byte encoding、base64url 和 timing-safe
  comparison；
- 签名绑定 artifact ID、owner subject ID、sha256、storage version 和过期时间；
- URL 不包含 API key，最长有效期 5 分钟；
- Nginx、Gateway、APM 和错误日志均不得记录 `sig` 或完整查询字符串；
- signed download 使用与鉴权下载相同的 TTL、hash、响应头和大小检查；
- artifact 不可覆盖；任何新版本使用新 artifact ID 和 storage version；
- signing secret 轮换可使未到期旧 URL 失效，Phase 1 不承诺跨轮换继续可用。

示例：

```http
Content-Disposition: attachment; filename="doctor-research.md"; filename*=UTF-8''%E9%A9%AC%E4%B8%81_%E5%9F%BA%E7%A1%80%E4%BF%A1%E6%81%AF%E4%B8%8E%E7%A0%94%E7%A9%B6%E6%96%B9%E5%90%91.md
```

四个标准 artifact：

```text
医生姓名_基础信息与研究方向.md
医生姓名_相关领域前沿综述.md
医生姓名_医生可能问机器人问题.txt
医生姓名_问题与答案.md
```

上述是 `zh-CN` 展示名；`en` 分别使用
`<doctor>_profile-and-research-directions.md`、
`<doctor>_frontier-review.md`、`<doctor>_predicted-questions.txt` 和
`<doctor>_questions-and-answers.md`。存储路径不使用展示文件名，只使用内部
artifact ID 和 storage version。

### 8.7 取消

```http
POST /gateway/research/v1/doctor-runs/{run_id}/cancel
Idempotency-Key: research:<client-generated-id>
```

`queued` 和 `needs_input` 在 API 事务中立即转为 `cancelled`。`running` 原子写入
`cancel_requested_at`、`cancel_requested_by=subject` 和发起取消的 request ID；
Worker 在阶段边界、外部调用前、LLM 调用前和 lease 续租时检查，并中止可取消的
在途请求。Admin CLI 发起时写 `cancel_requested_by=operator`，并在 audit 保存
operator ID 和 reason。

立即取消事务同时写入 `terminal_reason`、固定公开 detail、`completed_at`、
`expires_at`、`purge_after` 和 audit；running 取消请求事务只记录请求，不抢先写
终态或清空 lease，终态由持有有效 fencing token 的 Worker 收敛。

同一 Idempotency-Key/同一 body 重放原取消收据；不同 key 取消已经
`cancelled` 的 run 返回当前状态的幂等成功收据，不重复写审计；取消
`succeeded`、`failed` 或 `expired` 返回 `409 invalid_run_transition`。

### 8.8 错误分类

API 操作错误：

| HTTP | error code |
|---|---|
| 400 | `invalid_request` |
| 401 | `missing_credential` / `invalid_credential` |
| 403 | `research_capability_required` |
| 403 | `resource_access_denied`（预留；Phase 1 不返回） |
| 404 | `run_not_found` |
| 404 | `artifact_not_found` |
| 409 | `idempotency_conflict` |
| 409 | `idempotency_expired` |
| 409 | `run_not_complete` |
| 409 | `identity_selection_not_expected` |
| 409 | `invalid_run_transition` |
| 410 | `run_expired` |
| 410 | `artifact_expired` |
| 429 | `rate_limited` + `research_code=research_quota_exceeded` |
| 503 | `research_worker_unavailable` |
| 503 | `research_storage_unavailable` |
| 503 | `research_backup_stale` |

异步终态原因：

| status | terminal reason |
|---|---|
| `failed` | `identity_not_resolved` |
| `failed` | `identity_rejected_by_user` |
| `cancelled` | `identity_selection_timeout` |
| `failed` | `insufficient_research_evidence` |
| `failed` | `upstream_unavailable` |
| `failed` | `quality_gate_failed` |
| `failed` | `model_contract_error` |
| `failed` | `deadline_exceeded` |
| `cancelled` | `cancelled_by_user` |
| `cancelled` | `cancelled_by_operator` |

失败或取消的状态查询仍返回 HTTP 200；客户端通过 `status` 和 `terminal_reason` 判断异步业务终态。

### 8.9 Phase 1 Operator 面

Phase 1 不开放普通 credential 可访问的跨 subject 管理 API，也不复用 Billing
Admin token。最低运维面由本仓库 admin CLI 提供受控命令：

```text
research-run show
research-run cancel
research-run audit
research-run verify-artifacts
research-run suppress
research-worker status
research-backup create
research-backup verify
```

写命令必须显式传入可审计 `operator_id` 和 reason，通过短事务及当前状态条件执行；
不得直接用 sqlite shell 修改 Research 状态。若后续需要 HTTP 管理面，只能使用
独立 `/gateway/admin/research/v1/*`、独立 admin auth、独立限流和完整 audit，
普通用户 credential、Research Worker credential 和 Billing Admin token 均不得
访问。

## 9. SQLite 数据模型

### 9.1 research_runs

```sql
CREATE TABLE research_runs (
  run_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  credential_id TEXT,
  skill_name TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_schema_version TEXT NOT NULL,
  output_schema_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('brief', 'full')),
  language TEXT NOT NULL CHECK (language IN ('zh-CN', 'en')),
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'needs_input', 'succeeded',
               'failed', 'cancelled', 'expired')
  ),
  stage TEXT NOT NULL,
  progress_percent INTEGER NOT NULL DEFAULT 0
    CHECK (progress_percent BETWEEN 0 AND 100),
  canonical_identity_id TEXT,
  warning_codes_json TEXT NOT NULL DEFAULT '[]',
  terminal_reason TEXT,
  terminal_detail_public TEXT,
  cancel_requested_at TEXT,
  cancel_requested_by TEXT CHECK (
    cancel_requested_by IN ('subject', 'operator', 'system')
  ),
  cancel_request_id TEXT,
  needs_input_expires_at TEXT,
  needs_input_started_at TEXT,
  queued_at TEXT NOT NULL,
  active_started_at TEXT,
  active_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_elapsed_ms >= 0),
  lease_owner TEXT,
  lease_until TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  resume_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT,
  purge_after TEXT
);
```

`expires_at` 是 API 逻辑可见性截止时间；`purge_after` 是状态行允许物理删除的最早
时间。二者不得复用，避免把 30 天结果 TTL 与 90 天 run/audit 保留期混为一谈。
所有进入 `succeeded`、`failed` 或 `cancelled` 的事务必须同时设置
`completed_at`、`expires_at` 和 `purge_after`；进入 `expired` 时不得重置这三个
原始生命周期时间。

索引：

- `(subject_id, created_at DESC, run_id DESC)`；
- `(status, created_at)`；
- `(status, queued_at)`；
- `lease_until`；
- `needs_input_expires_at`；
- `expires_at`；
- `purge_after`。

active brief 配额同时由部分唯一索引兜底：

```sql
CREATE UNIQUE INDEX uq_research_active_brief_subject
ON research_runs(subject_id)
WHERE mode = 'brief'
  AND status IN ('queued', 'running');
```

创建 run、恢复 `needs_input` 和任何重排队操作都必须把该唯一约束冲突映射为
`429 rate_limited`、`research_code=research_quota_exceeded` 和
`limit_kind=research_active_brief`；事务回滚后保持原状态。

`terminal_detail_public` 只保存经过固定错误映射、可返回给 run owner 的说明。
SQLite、provider、URL、Prompt、原始网页片段和内部 stack 不得写入该字段；内部
诊断只保存到受限的 stage/audit 记录，且必须脱敏。

### 9.2 research_run_results

```sql
CREATE TABLE research_run_results (
  run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id),
  schema_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

结果只在质量门控通过后的完成事务中插入一次。正常运行期间不反复覆盖大 JSON。

### 9.3 research_idempotency_keys

```sql
CREATE TABLE research_idempotency_keys (
  subject_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES research_runs(run_id),
  response_status INTEGER,
  response_body_json TEXT,
  replay_expires_at TEXT NOT NULL,
  tombstone_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, endpoint, idempotency_key)
);
```

`response_body_json` 只保存可公开给该 subject 的最小 mutation 收据，不保存
credential、Prompt、来源正文或 artifact 内容。它用于 create、
identity-selection 和 cancel 的精确成功重放；429/503 等未提交状态变更的响应
不写入该表。

在 `replay_expires_at` 到期后，cleanup 先把 `response_status` 和
`response_body_json` 置空，但保留 key、request hash、run ID 和 tombstone。
直到 `tombstone_expires_at`：

- 同 key/同 hash 返回 `409 idempotency_expired`；
- 同 key/不同 hash 返回 `409 idempotency_conflict`；
- 不得创建新 run 或再次执行 mutation。

tombstone 到期后才可删除该行。删除 run 前必须先满足 idempotency FK 的清理顺序。

### 9.4 其他表

- `research_stage_runs`：阶段、attempt、lease generation、输入输出 hash、耗时、
  token、Gateway request ID 和脱敏错误；
- `research_checkpoints`：run/stage/version、版本化已验证 payload 或引用 manifest、
  sha256、lease generation 和创建时间；不保存未通过 Schema 的模型原文；
- `research_identity_candidates`：同名候选、证据、评分和选择结果；
- `research_sources`：来源元数据、访问时间、内容 hash、可信等级；
- `research_claims`：事实或结论到 source IDs 的映射；
- `research_references`：PMID、DOI、题名、作者、期刊、年份、研究类型和核验状态；
- `research_artifacts`：文件元数据、路径、sha256、subject 和过期时间；
- `research_suppressions`：经核验的停止处理或删除限制，不保存证件正文；
- `research_doctor_admissions`：每个成功 admission 的 subject、run、identity
  fingerprint、canonical identity、effective doctor key 和时间；
- `research_subject_identity_aliases`：同一 subject 内 fingerprint 到 canonical
  identity 的已核验映射，不跨 subject 复用身份选择；
- `research_worker_heartbeats`：worker/process instance、版本、启动时间、
  `last_seen_at` 和 draining 状态；
- `research_audit_events`：append-only 的 actor、action、run/artifact、结果、
  request ID 和脱敏参数；
- `research_backup_runs`：backup ID、schema version、开始/完成时间、状态、
  manifest hash 和脱敏错误，用于 backup age admission gate。

### 9.5 Research admission、每日配额与不同医生窗口

反批量画像不能仅通过扫描 `input_json` 或应用内计数实现。最低表结构：

```sql
CREATE TABLE research_doctor_admissions (
  run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id),
  subject_id TEXT NOT NULL,
  identity_fingerprint TEXT NOT NULL,
  canonical_identity_id TEXT,
  doctor_key TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_research_admissions_subject_time
ON research_doctor_admissions(subject_id, admitted_at);

CREATE INDEX idx_research_admissions_subject_doctor_time
ON research_doctor_admissions(subject_id, doctor_key, admitted_at);

CREATE TABLE research_subject_identity_aliases (
  subject_id TEXT NOT NULL,
  identity_fingerprint TEXT NOT NULL,
  canonical_identity_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, identity_fingerprint)
);
```

`identity_fingerprint` 是规范化医生输入的带版本 hash，不包含可逆姓名正文。
`doctor_key` 初始为 `fp:<hash>`；若已有该 subject 的已核验 alias，则直接使用
`dci:<canonical_identity_id>`。身份确认后，在一个短 `BEGIN IMMEDIATE` 事务中：

1. upsert subject-local alias；
2. 将该 subject 下已确认属于同一 canonical identity 的 admission 更新为同一
   `doctor_key`；
3. 更新当前 run 的 `canonical_identity_id`；
4. 重新计算滚动 30 天 `COUNT(DISTINCT doctor_key)`；
5. 写入身份选择、状态迁移、配额结果和 audit。

创建 run 的 admission 事务按 UTC 日统计 `admitted_at` 以执行每日 run 上限，并按
最近 30 天 distinct `doctor_key` 执行不同医生上限。Idempotency 重放不得新增
admission；`needs_input` 恢复不得重复计算为新 run。fingerprint 尚不能映射到已知
canonical identity 时按新医生保守计数，不能为了减少误拒绝而 fail-open。所有
检查与 run/admission/idempotency 写入在同一 `BEGIN IMMEDIATE` 事务完成。创建
时还必须检查未过期 `needs_input` 数量和 global queue；恢复 `needs_input` 时检查
active brief 与 global queue。相应拒绝分别使用
`research_needs_input`、`research_global_queue`，且不得留下部分 admission。

### 9.6 SQLite lease、续租与 fencing

SQLite 不使用 PostgreSQL `SKIP LOCKED`。Worker 在短 `BEGIN IMMEDIATE` 事务中：

1. 查询一个 queued run，或 `lease_until` 已过期的 running run；
2. 条件更新 `status=running`、`lease_owner`、`lease_until`，
   `lease_generation=lease_generation+1` 和 `attempt_count=attempt_count+1`；
3. 返回本次 `(lease_owner, lease_generation)` fencing token；
4. 检查实际更新行数并立即提交；
5. 在事务外执行阶段。

Worker 使用独立计时器按不超过 lease 三分之一的间隔续租；初始 120 秒 lease 使用
30 秒续租。续租不能把取消和失去 lease 压成同一个“0 行”信号；它只按当前
fencing token 条件更新，并在同一语句返回取消标志：

```sql
UPDATE research_runs
SET lease_until = :next_lease, updated_at = :now
WHERE run_id = :run_id
  AND status = 'running'
  AND lease_owner = :owner
  AND lease_generation = :generation
  AND lease_until > :now
RETURNING cancel_requested_at, cancel_requested_by, lease_until;
```

续租结果按以下顺序处理：

1. 返回 0 行：当前 Worker 的 lease 已过期或已不再持有可写 fencing token。立即
   触发 AbortSignal、丢弃本次模型/adapter 结果并停止所有写入；随后允许只读重读
   该行用于日志分类，但该读取不能恢复所有权，也不能触发终态写入；
2. 返回 1 行且 `cancel_requested_at IS NULL`：续租成功，继续工作；
3. 返回 1 行且 `cancel_requested_at IS NOT NULL`：续租成功且本 Worker 仍持有
   fencing token；立即中止在途调用并进入取消终态事务；
4. 返回多于 1 行属于 Store invariant violation，停止 Worker readiness 并告警。

API 在两次续租之间写入取消请求时，普通 checkpoint、阶段结果、`needs_input`、
重排队、失败和成功完成写入都必须同时带 `status=running`、owner、generation、
`lease_until > :now` 和
`cancel_requested_at IS NULL`，因此不会越过取消请求。取消终态是唯一相反的
写入：它必须要求 `cancel_requested_at IS NOT NULL`，不得复制普通写入的
`IS NULL` 条件。

当前 lease owner 写 `cancelled` 的确切状态条件为：

```sql
UPDATE research_runs
SET status = 'cancelled',
    terminal_reason = :terminal_reason,
    terminal_detail_public = :terminal_detail_public,
    active_elapsed_ms = active_elapsed_ms + :active_delta_ms,
    active_started_at = NULL,
    lease_owner = NULL,
    lease_until = NULL,
    completed_at = :now,
    expires_at = :expires_at,
    purge_after = :purge_after,
    updated_at = :now
WHERE run_id = :run_id
  AND status = 'running'
  AND lease_owner = :owner
  AND lease_generation = :generation
  AND lease_until > :now
  AND cancel_requested_at IS NOT NULL
RETURNING status;
```

`:active_delta_ms` 由 Store 根据已读取的 `active_started_at` 和事务时间计算并校验为
非负值；`:terminal_reason` 只能由 `cancel_requested_by` 的固定映射产生：
`subject -> cancelled_by_user`、`operator -> cancelled_by_operator`，
`system` 只允许映射到已登记的系统取消原因。状态更新和
`research_audit_events` 插入必须在同一个短 `BEGIN IMMEDIATE` 事务提交。更新
返回 0 行时，Worker 只读重读以区分已终态、owner/generation 改变或其他 invariant
异常，然后无条件停止写入；新 owner 或 reconciler 负责后续收敛。

新 Worker 接管一个已过期且已有 `cancel_requested_at` 的 running run 后，不执行
业务阶段，直接按新 generation 进入上述取消终态事务。

旧 Worker 即使在新 Worker 接管后收到迟到响应，也不能覆盖新状态。任何 fenced
写入受影响行数不是 1 时都遵循相同的“中止、只读诊断、停止写入”规则。

每个阶段完成后以新短事务写 checkpoint。进入或离开 `running` 时原子维护
`active_started_at` 和 `active_elapsed_ms`。接管 expired running run 时，先把
旧 span 按 `min(now, old_lease_until)-active_started_at` 结算到
`active_elapsed_ms`，再把 `active_started_at` 设为本次领取时间，避免崩溃路径
漏算或重复计算。正常离开 running 时结算到当前时间并清空
`active_started_at`。lease 到期后其他 Worker 从最近成功 checkpoint 恢复；重复
的只读外部/LLM 调用可能产生额外成本，但其迟到输出被 fencing 丢弃。所有 adapter
和 LLM client 必须接受 AbortSignal。

### 9.7 Artifact 原子发布

最低元数据：

```sql
CREATE TABLE research_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(run_id),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'review', 'questions', 'answers')),
  storage_path TEXT NOT NULL UNIQUE,
  storage_version INTEGER NOT NULL CHECK (storage_version > 0),
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL,
  filename_ascii TEXT NOT NULL,
  filename_utf8 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (run_id, kind)
);
```

`storage_path` 只能是相对 `RESEARCH_ARTIFACT_ROOT` 的规范化内部路径，不接受
用户输入，不允许 `..`、绝对路径、alternate data stream 或符号链接跳转。

Artifact 文件与 SQLite 无法共享一个事务，Phase 1 使用“先持久化不可变文件，
再提交元数据”的发布协议：

1. 在目标 artifact 同一文件系统中写入带 run、artifact 和 storage version 的
   唯一临时文件；
2. 流式写入时计算 sha256 和 size，执行单 artifact 及单 run 大小检查；
3. flush、`fsync` 文件，使用不覆盖既有文件的原子 rename 发布；
4. 必要时 `fsync` 父目录；
5. 在一个 `BEGIN IMMEDIATE` 事务中，带当前 fencing token 插入四个 artifact
   元数据、插入一次 result、写 audit，并把 run 转为 `succeeded`；
6. 提交前再次确认 `cancel_requested_at IS NULL`、四文件均存在且 metadata
   完整。

Artifact 一经发布不可原地修改；新版本必须使用新的 artifact ID 和 storage
version。Worker 启动恢复和 cleanup 扫描：

- 删除超过安全宽限期、没有数据库元数据的临时文件和孤儿已发布文件；
- 发现数据库元数据对应文件缺失、size/hash 不符时，不提供下载，记录高优先级
  audit/metric，并把尚未公开完成的 run 恢复或失败；
- 已经提交为 `succeeded` 的损坏结果不得静默重新生成或返回部分 artifact，必须
  进入运维修复流程。

### 9.8 Worker heartbeat 与 Research audit

```sql
CREATE TABLE research_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  process_instance_id TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'ready', 'draining')),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE research_audit_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  request_id TEXT,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('subject', 'worker', 'operator', 'system')),
  subject_id TEXT,
  credential_id TEXT,
  operator_id TEXT,
  run_id TEXT,
  artifact_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_research_audit_time
ON research_audit_events(occurred_at);

CREATE INDEX idx_research_audit_run_time
ON research_audit_events(run_id, occurred_at);

CREATE TABLE research_backup_runs (
  backup_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  manifest_sha256 TEXT,
  error_code TEXT
);
```

Heartbeat upsert 必须比较 `process_instance_id`，防止同一静态 worker ID 的旧进程
覆盖新进程状态。Audit 写入失败时，普通 read 可按明确降级策略继续；create、
identity selection、cancel、operator、suppression、signed URL 签发和终态 mutation
必须 fail closed 或与业务事务一起回滚，不得出现状态已改变但关键审计缺失。

## 10. Tool Adapters

### 10.1 v1 必选

- PubMed E-utilities：搜索和批量元数据；
- Crossref：DOI 和出版元数据核验；
- ORCID：作者身份辅助匹配；
- 官网搜索：医院、大学、学会、基金和政府公开页面发现；
- Source Fetcher：仅抓取已批准的 HTTP(S) 来源；
- Citation Validator：PMID/DOI、元数据、编号和正文闭环；
- Artifact Renderer：Markdown/TXT/JSON。

### 10.2 v1 可选

- OpenAlex：补充作者和文献发现；
- PMC：开放全文；
- Unpaywall：开放获取状态。

v1 的明确覆盖范围是 PubMed、Crossref 和可配置的开放索引，不声称覆盖全部
中英文文献。未接入有授权的中文数据库时，结果必须返回覆盖范围警告。

覆盖范围 warning 是单次结果披露，不是 Phase 1 准入依据。若产品目标包括广泛
中国医生，Phase 0 必须证明 PubMed、Crossref、ORCID、官网搜索和已批准开放
索引组成的完整数据源栈达到预先批准的召回率与 claim coverage。未达标时必须
收窄 Phase 1 的适用人群，或者把有授权的中文数据源升级为 Phase 1 阻断项。

### 10.3 实现要求

- 使用 TypeScript 和明确接口；
- 使用 Node HTTP client，不从 shell 调用 Python；
- 每个 adapter 设置超时、重试、并发和响应大小；
- 使用固定 User-Agent 和必要的联系信息；
- 记录 adapter version；
- 对 429 使用 `Retry-After` 和指数退避；
- 不让模型直接构造或访问 URL；
- 用户输入不得成为 fetch URL。

### 10.4 外部访问安全

Source Fetcher 必须：

- 只允许 HTTP(S)；
- 默认只允许 80/443，非标准端口必须进入代码评审过的显式 allowlist；
- 拒绝 localhost、私网、link-local 和 metadata service；
- 对每次连接执行受控 DNS lookup，检查全部 A/AAAA 地址并把实际 socket 连接固定
  到已检查的地址；不能先检查再让通用 client 重新解析；
- 限制重定向次数；
- 重定向后重新执行 URL、host、port、DNS 和实际连接地址检查；
- 禁止 URL userinfo，不发送 Cookie、Authorization、代理认证或同主机其他应用
  的 header；
- 限制响应体大小和内容类型；
- 设置连接和总超时；
- 只保存允许的短摘要、结构化证据和内容 hash；
- 把网页正文视为不可信数据；
- 不执行网页中的提示词、脚本或工具指令。

Azure Research 默认使用直接公网出口。所有 adapter 只读取 Research 自己的显式
网络配置，不读取同一主机上其他应用的代理、Cookie、账号或出口配置。Phase 0
必须对 DNS rebinding、IPv4/IPv6 混合解析、redirect 到私网、十进制/八进制 IP、
超大压缩响应和慢速响应建立 fixture；Phase 1 若不能可靠固定实际连接地址，则改用
独立受控 egress proxy，而不是以应用层 hostname 检查代替。

## 11. LLM 执行策略

### 11.1 模型负责

- 从候选来源提取结构化事实；
- 生成检索概念和检索式候选；
- 对已筛选证据做主题归纳；
- 按 JSON Schema 生成 profile、review、questions 和 answers；
- 根据验证器反馈执行定向修复。

### 11.2 代码负责

- 状态迁移；
- 外部检索；
- 元数据核验；
- 作者身份评分；
- 去重；
- reference ID 和正文编号；
- artifact 文件名和写入；
- 从模型文本中提取唯一 JSON value，拒绝前后说明、Markdown fence、多个 JSON
  value 和尾随非空内容；
- 使用 AJV 按版本化 JSON Schema 校验模型输出；
- 长度、五行问题、引用闭环和 hash 校验；
- 配额、取消、重试和超时。

### 11.3 结构化输出

Phase 0/1 不依赖 Gateway 当前未实施的 chat `response_format/json_schema`，也不复用
strict/native tools function-calling 路径。Worker 使用非流式普通 chat：

1. 请求不包含 `tools`、`tool_choice` 或 `response_format`；
2. system/developer prompt 要求模型只返回一个 JSON value，不带 Markdown fence
   或解释文字；
3. Worker 严格解析唯一 JSON value，并使用 AJV 校验版本化 JSON Schema；
4. 首次失败时，把精简且不含敏感原文的解析/AJV 错误反馈给模型，执行一次定向
   格式修复；
5. 第二次仍失败则以 `model_contract_error` 终止，不把无效输出写入 checkpoint
   或 artifact。

“一次修复”是 Phase 0 的初始预算，不是未经验证的永久常量。fixture 报告必须单独
统计 schema 首次通过率、解析失败率、AJV 失败率、修复尝试率、修复成功率和
`model_contract_error` 率；进入 Phase 1 前按批准阈值确认模型和修复预算。

模型不得凭记忆补充 evidence bundle 中不存在的：

- PMID 或 DOI；
- 项目、专利或奖项编号；
- 样本量；
- 效应量；
- 性能指标；
- 作者单位；
- 临床结论。

### 11.4 长综述

full 模式流程：

1. 冻结已核验 reference set；
2. 生成大纲和每节允许使用的 reference IDs；
3. 分节生成；
4. 合并并重新编号；
5. 检查孤立引用、未引用文献和数字来源；
6. 生成摘要和结论；
7. 最多两轮定向修复；
8. 渲染四个文本 artifact。

## 12. 质量门控

### 12.1 身份与事实

- 同名歧义必须暂停；
- 论文归属不能只匹配姓名；
- 医生事实至少关联一个公开 source；
- profile 必须渲染非空“主要公开来源”，且来源集合覆盖已输出的履历与成果 claim；
- 论文归属保存至少两类身份依据；
- 来源冲突保留差异或选择依据；
- 未核验项目、专利、奖项和编号不得写成事实；
- 不生成医生临床能力或个人价值排名。

### 12.2 文献与引用

- 核验题名、期刊、年份；
- 尽量核验 PMID 和 DOI；
- 一旦输出 PMID/DOI，就必须由批准 adapter 解析成功并与题名、期刊、年份一致；
  无法解析的标识符不得作为已确认引用输出，编号数值大小不参与真实性判断；
- PMID、DOI 和规范化题名去重；
- 正文编号连续；
- 每个正文引用都有 reference；
- 每个非附录 reference 都在正文出现；
- 具体数字关联 reference ID；
- 摘要未披露的数据标记为需全文核验；
- 文献不足目标数时发 warning，不凑数。

### 12.3 输出契约

- 四个标准 artifact 全部存在；
- questions TXT 恰好 5 行；
- 每行一个编号问题；
- `zh-CN` 每个问题不超过 30 个汉字，`en` 每个问题不超过 20 words；
- answers 中的问题与 TXT 逐条一致；
- `zh-CN` 每条答案 100 至 300 个汉字，`en` 每条答案 80 至 180 words；
- brief/full 按第 7.5 节的语言专用口径达到篇幅；
- search report 包含数据库、日期、检索式、发现数和纳入数；
- Markdown 不包含脚本、危险 HTML 或本地绝对路径；
- artifact sha256 与下载内容一致。

“汉字”按 Unicode Han script code point 计数，不把 Markdown 标记、空白和引用编号
计入；英文使用由固定 tokenizer version 定义的 word count。所有计数器和版本写入
quality checks，不能由模型自行声明已达标。

### 12.4 安全门控

- 不包含个体化诊断、治疗或用药建议；
- 不输出私人联系方式、家庭信息或患者信息；
- 不复述网页提示词或工具指令；
- 不泄露 API key、内部 URL、账号、代理或容器路径；
- 对患者数据或明显敏感输入拒绝或脱敏。

质量状态：

- `passed`；
- `passed_with_warnings`；
- `failed`。

只有前两者可以进入 `succeeded`。

## 13. 鉴权、Capability 与配额

### 13.1 Capability

在 Doctor Research feature 版本的 `gatewayCapabilities` 中新增：

```text
doctor_research
```

默认 feature policy 不包含该 capability。只有明确配置的 plan/entitlement 可以创建 Research run。

这是一个需要先解决的发布阻断项。当前实现对持久化 policy 使用严格解析：
`parseCapabilities` 遇到 `gatewayCapabilities` 未知值会抛错，而 plan 和
entitlement row mapper 在每次读取时都会重新验证。因此，一旦
`gateway.db` 写入含 `doctor_research` 的
`feature_policy_json`/`feature_policy_snapshot_json`，回滚到今天不认识该值的
镜像会导致相关 get/list、entitlement access 和 quota dashboard 读取失败；plan
列表逐行映射时，一条新 plan 还可能使整个列表失败。不能把“保留
`gateway.db`、回滚旧镜像”描述为安全动作。

必须使用 expand/contract 顺序，且读取兼容与写入校验分离：

1. **持久化读取兼容**：plan、entitlement 及 snapshot 的数据库 decoder 接受未知
   capability，保留原始字符串，并在读取、展示和任何重新序列化时无损保留；
2. **外部写入严格**：plan create/update、entitlement grant/renew 和其他管理输入
   仍只接受当前版本认识的 capability；不能把现有 `parseCapabilities` 全局改成
   静默忽略未知值，否则拼写错误也会进入数据库；
3. **旧值读取**：新代码继续接受没有 `doctor_research` 的旧 policy 和 snapshot；
4. **先行发布**：只包含兼容 decoder、严格 writer 和 credential 模型允许清单的
   版本必须先独立发布、通过观察，并被固定为最低回滚版本；
5. **功能发布**：只有最低回滚版本稳定后，后续版本才可把
   `doctor_research` 加入已知 capability、注册 Research 路由并创建相关
   plan/entitlement；
6. **回滚约束**：生产数据写入 `doctor_research` 后，任何回滚都不得低于该最低
   兼容版本。发布系统必须保留并可按不可变 digest 重新部署该版本。

这里同时覆盖两个方向：新代码读取旧行的向后兼容，以及回滚代码读取新行的
向前/回滚兼容。若实现不能保证未知 capability 在 grant/renew 等重写路径中无损
保留，则该兼容版本不得被批准为回滚底座。

新增 capability 后必须验证：

- 旧 plan 和 entitlement snapshot 继续解析；
- 使用临时数据库注入未来未知 capability 后，plan/entitlement 的 get、list、
  access calculation、credential current 和 quota dashboard 均可读取；
- 兼容 decoder 会无损保留未知 capability，而 create/update 等外部写入仍拒绝
  未知值；
- 默认用户能力不变；
- `/gateway/credentials/current` 正确展示新 capability；
- 无 capability 的 credential 返回 403；
- capability 不能由请求体自行声明；
- Research Worker 服务 credential 调用 Research 创建、身份选择、取消和
  artifact 接口均返回 403；
- Research Worker 服务 credential 调用 image 路由返回 403；
- Research Worker 不持有管理面认证材料，管理 API 按独立 admin auth 拒绝；
- Research Worker 选择 `RESEARCH_LLM_MODEL` 成功，选择其他公开模型返回
  `403 model_not_allowed_for_credential`；
- 现有 `allowed_public_models_json=NULL` 的 credential 行为完全不变。

`chat` 和 `tools` 当前不是被 Gateway 强制的 capability。Phase 0/1 不新增共享
chat 热路径上的 `tools` 门禁，也不写“未授予 tools 所以调用必然 403”的契约测试；
若未来要实施该能力，应另立兼容性方案并评估全部现有 entitlement snapshot。

### 13.2 用户配额

内部 brief 初始值：

- 每 subject 同时最多 1 个 queued/running brief；
- 每 subject 最多 10 个未过期 `needs_input`；
- 每日 run 数由 Research policy 单独控制；
- 每 subject 在滚动 30 天内可调研的不同医生数量必须有非空上限，具体值由
  Phase 0 使用场景和隐私评估确定；
- full 默认禁用；
- 状态轮询、鉴权下载和可选 signed URL 使用独立 control-plane 限流；
- 不使用普通 chat request/day 计数表达 Research run 配额。

`needs_input` 恢复计入 active brief 配额。超限时返回 429，而不是把多个恢复
请求继续堆入 queued。被拒绝的 selection 保持 `needs_input`，等待客户端重试
或取消。

不同医生数量超限返回 `429 rate_limited`，并设置
`research_code=research_quota_exceeded` 和
`limit_kind=research_unique_doctors_30d`。

### 13.3 Worker 与上游配额

- Worker 并发 1；
- 每个 adapter 独立限流；
- 每个 run 设置外部请求、下载字节、LLM 调用、input token、output token 和修复轮数上限；
- 超过预算不得静默继续；
- Gateway 内部 LLM 服务 credential 有独立限流和用量归因；
- full 启用前必须解决专用上游容量。

## 14. 安全、隐私与数据保留

### 14.1 信息范围

仅处理公开、与职业和学术直接相关的信息：

- 医院、科室、职称和公开任职；
- 教育与职业经历；
- 论文、项目、专利、专著和奖项；
- 公开研究方向；
- 公开学术数据库元数据。

禁止主动汇集：

- 私人手机号、地址和家庭成员；
- 非公开履历；
- 患者信息；
- 与科研目的无关的社交媒体；
- 政治观点、健康状况或性格推断。

### 14.2 数据隔离

- run、result 和 artifact 绑定 subject ID；
- 不跨 subject 共享生成结果；
- 公开 PMID/DOI 元数据可以缓存；
- 医生身份选择和生成画像不能跨 subject 自动复用；
- 以规范化输入 identity fingerprint 和最终 `canonical_identity_id` 统计每个
  subject 在滚动窗口内调研的不同医生数量；
- 创建时先按 identity fingerprint 计数；身份确认后在同一事务把该计数合并到
  canonical identity，避免同一医生因别名或补充信息被重复计数；
- 超过不同医生数量上限时拒绝新 run、记录审计事件并触发异常批量行为指标；
- 合法批量业务必须使用单独审批的 operator policy，不得通过普通用户配额绕过；
- 管理员跨 subject 访问使用独立权限和审计；
- Research Store 不保存用户 credential 明文。

### 14.3 保留期

建议初始值：

- artifact：30 天；
- run result：30 天；
- run 状态与审计：90 天；
- 失败中间数据：14 天；
- 公开文献元数据缓存：180 天；
- `needs_input`：72 小时；
- idempotency 成功 replay body：7 天，最小 tombstone：30 天；
- doctor admission：至少覆盖滚动 30 天，初始保留 90 天；
- subject-local identity alias：当该 subject 已无保留期内 admission 时删除，最长
  初始 90 天；
- stale Worker heartbeat：7 天。

Research Worker 进程内运行两个职责分离的维护循环：

1. **TTL reconciler** 是状态行逻辑迁移的唯一后台执行者；
2. **physical cleanup** 只删除已经逻辑过期且超过 `purge_after` 的数据，并保留
   最小 tombstone。

TTL reconciler 至少每分钟运行一次，使用数据库级单例锁和不超过 100 行的小批量
短 `BEGIN IMMEDIATE` 事务。每一批必须完成以下条件迁移，并在同一事务写
`research_audit_events`：

```text
needs_input
  WHERE needs_input_expires_at <= now
  -> cancelled
     terminal_reason=identity_selection_timeout
     completed_at=now
     expires_at=now+result_ttl
     purge_after=now+run_retention

succeeded|failed|cancelled
  WHERE expires_at <= now
  -> expired
```

`terminal -> expired` 必须保留原 `terminal_reason`、`completed_at` 和审计链，只
更新 `status`、`updated_at` 并撤销结果/artifact 的逻辑可见性。物理删除在
`purge_after` 之后另行执行。身份选择事务始终要求
`needs_input_expires_at > :transaction_now`；所以即使 reconciler 延迟，过期选择
也不能恢复为 `queued`。

API 读取不承担数据库迁移，避免轮询制造写锁；但必须按同一时钟 fail closed：

- 读取到已超时但尚未 reconciled 的 `needs_input` 时，对外按
  `cancelled/identity_selection_timeout` 表现；
- 读取到 `expires_at <= now` 的终态时，点查/结果/下载按契约返回
  `410 run_expired` 或 `410 artifact_expired`，列表摘要表现为 `expired`；
- API 的惰性表现不能代替 reconciler 的持久化状态和 audit。

Worker 启动即先运行一次 reconciler；之后即使正在执行 run，也由独立定时器继续
运行，不占 Research run 并发槽。Worker 长时间不可用时 API 仍执行上述逻辑 TTL，
并对 reconciler lag 告警；恢复后必须在领取新 run 前优先收敛过期状态。

physical cleanup：

- 使用独立定时器，不占 Research run 并发槽；
- 同一时刻最多运行一个 cleanup；
- 使用短事务、小批量和低优先级 I/O；
- 不执行网络或 LLM 调用；
- 可以在 Worker 忙碌时延迟物理删除，但不能延迟逻辑过期；
- 下载和结果 API 始终先检查 `expires_at`，到期后即使文件仍存在也返回 410。

### 14.4 更正、删除与跨境

系统必须区分：

- API 用户删除自己的 run；
- 被调研医生针对公开个人信息提出更正、停止处理或删除请求。

公开职业信息不等于可以无限期、无限范围聚合。Azure 区域、LLM provider、搜索 provider 和数据接收方必须进入上线前隐私与跨境评估。未经批准不得把患者信息、完整网页正文或无关个人信息发送给模型或搜索供应商。

### 14.5 备份、恢复与磁盘保护

`research_state` 虽然是独立 named volume，但仍可能与 Gateway 位于同一宿主机和
Docker 数据盘。volume 隔离不能防止磁盘耗尽影响现有服务。Phase 1 必须：

- 限制单 source 响应、单 artifact、单 run artifacts/result、中间数据和全局
  Research storage bytes；
- admission 前检查可用空间和 inode；低于 `RESEARCH_MIN_FREE_BYTES` 或
  `RESEARCH_MIN_FREE_PERCENT` 时拒绝新 run，返回
  `503 research_storage_unavailable`；
- artifact/result 使用流式读写和 backpressure，不把完整大文件读入 Gateway
  内存；
- 对 cleanup lag、可用空间、orphan 和 integrity failure 告警；
- 压力测试证明 Research 达到硬存储上限或磁盘检查失败时，现有 Gateway 仍可读写
  `gateway.db` 并完成 chat smoke。

备份不能直接在 Research DB 活跃写入时复制 `research.db`、`-wal` 和 artifact
目录。受控备份流程必须：

1. 使用 SQLite Online Backup API 或经验证的 checkpoint/backup 机制生成一致
   database snapshot；
2. 从该 database snapshot 而不是 live DB 生成 artifact manifest，记录 artifact
   ID、storage version、size 和 sha256；
3. 复制不可变 artifact，并校验 manifest；
4. 加密备份，限制访问，不包含 credential、签名 secret 或 provider secret；
5. 记录 backup ID、schema/migration version、开始/完成时间和校验结果；
6. 在隔离目录执行 restore drill，验证 run/result/artifact FK、hash、TTL 和下载
   授权。

Phase 1 前批准 Research RPO/RTO、备份频率和保留期。备份失败不影响 Gateway
health，但在超过批准 RPO 时停止接受新 Research run、返回
`503 research_backup_stale` 并告警；状态查询、取消和现有 artifact 鉴权下载继续
工作。

## 15. 可靠性

### 15.1 重试

| 调用 | 默认策略 |
|---|---|
| PubMed/Crossref/ORCID 429、5xx、超时 | 最多 3 次，指数退避加抖动 |
| 官网搜索或抓取 | 最多 2 次，host 级熔断 |
| 内部 Gateway LLM 连接或 5xx | 最多 2 次 |
| LLM Schema 不合法 | 1 次格式修复 |
| 质量失败 | brief 1 轮，full 2 轮定向修复 |

身份不足、非法输入、安全拒绝和版权限制不重试。

### 15.2 超时

- 单外部 HTTP：10 至 30 秒；
- 单 LLM 调用：60 至 180 秒；
- brief 软超时：12 分钟；
- brief 硬超时：20 分钟；
- full 软超时：35 分钟；
- full 硬超时：45 分钟。

软/硬超时按持久化的 active execution time 计算：

```text
active_elapsed_ms + (status=running ? now-active_started_at : 0)
```

它跨阶段、重试、Worker 重启和 lease 接管累计，但不包含 queued 时间或
`needs_input` 人工等待时间。达到软超时后不再扩大检索或启动非必要修复；达到硬
超时后中止在途调用并以 `deadline_exceeded` 结束。另行记录从 `created_at` 到
终态的用户可见 wall-clock latency，不能用暂停时间稀释执行 SLO。

### 15.3 取消

Worker 在以下位置检查取消：

- 领取后；
- 每个阶段开始前；
- 每次外部请求前；
- 每次 LLM 请求前；
- artifact 完成事务前。

所有 HTTP 和 LLM client 必须支持 AbortSignal；取消、硬超时或失去 lease 时必须
中止在途请求。已经完成并校验的 checkpoint 可以保留到清理期。最终成功事务必须
同时检查 `cancel_requested_at IS NULL` 和当前 fencing token，解决取消与完成竞态。

### 15.4 Worker 健康

- Gateway health 不依赖 Research Worker readiness；
- Research Worker 每 15 秒更新一次 `research_worker_heartbeats`，Gateway 只把
  process instance、版本、draining 和 heartbeat age 暴露给受保护的运维读取面；
- heartbeat age 超过 45 秒视为 unavailable；该阈值必须大于三次正常 heartbeat，
  且与 run lease 独立；
- Research 提供 queue depth、oldest queue age 和全局 queue admission 上限；
- Worker 不可用时创建接口可以返回 503，或在短暂维护窗口内创建 queued run；
- 具体行为由 `RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE` 固定配置决定；
- 即使允许维护窗口排队，也不得超过 `RESEARCH_MAX_QUEUED_RUNS`；超限返回
  `429 rate_limited`、`limit_kind=research_global_queue`；
- 不能把 Research 故障回退到普通 chat。

## 16. 可观测性

### 16.1 日志

每条 Research 日志包含：

- request ID；
- run ID；
- 内部 subject ID；
- stage；
- attempt；
- adapter 或 model；
- duration；
- result class、stage error 或 terminal reason。

禁止记录：

- credential；
- Cookie；
- 外部服务密钥；
- 完整 Prompt；
- 完整网页正文；
- 隐藏思维过程；
- artifact 正文。

`terminal_detail_public`、日志和 API 错误只使用固定公共映射；内部 error class、
provider request ID 和脱敏诊断放在受限 stage/audit 记录，不写回普通状态响应。

### 16.2 Audit

`research_audit_events` 是 append-only Research 审计，不复用 `gateway.db` 的
admin audit 作为状态机日志。至少记录：

- run create、idempotency replay/conflict/expired；
- identity candidates issued、selection、reject-all 和 timeout；
- admission quota accept/reject，以及 fingerprint 合并到 canonical identity；
- cancel requested、cancel completed、operator cancel；
- result completed、identity timeout reconciliation、terminal expired、cleanup 和
  损坏检测；
- authenticated artifact download、可选 signed URL 签发和 signed download；
- operator 跨 subject 读取、更正、suppression、删除和恢复；
- Worker lease acquire、lost、recovery 和终态写入拒绝。

字段包括 event ID、occurred_at、request ID、actor type、subject/credential/operator
ID、run/artifact ID、action、outcome 和脱敏 params。不得保存 credential、签名、
完整医生输入、Prompt、网页正文或 artifact 正文。普通 owner 状态轮询可只做聚合
指标，不逐次写 audit，避免制造无价值写锁。

### 16.3 指标

- `research_runs_created_total`；
- `research_runs_terminal_total`；
- `research_run_duration_seconds`；
- `research_stage_duration_seconds`；
- `research_queue_depth`；
- `research_oldest_queued_age_seconds`；
- `research_needs_input_total`；
- `research_sources_fetched_total`；
- `research_references_found_total`；
- `research_references_verified_total`；
- `research_validation_failure_total`；
- `research_llm_tokens_total`；
- `research_llm_calls_total`；
- `research_upstream_errors_total`；
- `research_artifact_bytes`；
- `research_worker_heartbeat_age_seconds`；
- `research_deadline_exceeded_total`；
- `research_reconciler_lag_seconds`；
- `research_reconciler_transitions_total`；
- `research_cleanup_lag_seconds`；
- `research_orphan_artifacts_total`；
- `research_artifact_integrity_failures_total`；
- `research_lease_lost_total`；
- `research_queue_admission_rejections_total`；
- `research_disk_free_bytes`；
- `research_unique_doctors_30d`；
- `research_unique_doctor_limit_rejections_total`。

### 16.4 初始 SLO

- 创建 API P95 小于 500 ms；
- 状态 API P95 小于 200 ms；
- 未进入 `needs_input` 的 succeeded brief，从 `created_at` 到 `completed_at`
  的 wall-clock P95 小于 8 分钟；
- 所有 succeeded brief 的 active execution time P95 小于 8 分钟；
- queued delay、`needs_input` human-wait 和 active execution time 分开报告；
- `deadline_exceeded` 比例的分母是进入过 `running` 且由系统完成为
  `succeeded/failed` 的 brief；用户取消、operator 取消、身份拒绝和身份确认超时
  均不进入分母，初始目标小于 2%；
- Research 控制面不使现有 Gateway P95 回退超过 3%；
- Research 故障不导致现有 chat、models、credentials、images 或 billing smoke 失败。

## 17. Azure 部署方案

### 17.1 进程与容器

`compose.azure.yml` 增加：

- 现有 `gateway`：新增 Research 控制面路由和 `research_state` 读写挂载；
- 新增 `research-worker`：无公共端口，执行状态机，并读写 `research_state`；
- 新增 `research_state` named volume；
- 为 Worker 挂载独立、已批准且不位于 `research_state` 内的 backup target。

Phase 1 只新增 `research-worker` 一个容器，不新增 `research-api`、
`renderer`、`reconciler` 或 `cleanup` 容器。TTL reconciler 和物理清理定时任务
首版均放在 Worker 内执行。

reconciler 与 cleanup 分别使用独立、不可重入的定时器，不占
`RESEARCH_WORKER_CONCURRENCY` 的 run 槽；每批受数量和执行时间上限约束。
reconciler 持久化 §14.3 的状态和 audit，API 读取同时 fail closed 以保持延迟期间
的 410 语义；cleanup 延迟只影响磁盘回收。

backup scheduler 同样在 Worker 内使用独立、不可重入、低优先级的定时器，不占
run 槽；它调用与 admin CLI 共用的 backup library。backup target 必须与
`research_state` 路径分离，并按批准方案加密和复制；仅在同一 named volume
创建副本不能满足 RPO。备份 I/O 必须受带宽/持续时间限制，并纳入现有 Gateway
负载回归。

Worker 与 Gateway 使用同一构建产物，但不同 command：

```text
gateway:
  npm --workspace @codex-gateway/gateway run start

research-worker:
  npm --workspace @codex-gateway/research-worker run start
```

Research Worker 不挂载 `CODEX_HOME`，不直接读取上游 ChatGPT/Codex 登录状态；模型访问通过内部 Gateway HTTP API。

Worker 必须设置明确的 `cpus`、`mem_limit` 和 `pids_limit`。具体值由 Phase 0
基线和压力测试确定，不允许无限制占用现有 Gateway 资源。

### 17.2 网络与端口

- Gateway 继续只发布 `127.0.0.1:18787->8787`；
- Nginx 继续是唯一公共 80/443 入口；
- Research Worker 不发布端口；
- Worker 通过 Compose 内部网络访问 `gateway:8787`；
- 不新增公共数据库端口；
- 不让 Docker 或新服务占用 80/443。

### 17.3 配置

```text
RESEARCH_API_ENABLED=false
RESEARCH_WORKER_ENABLED=false
RESEARCH_DB_PATH=/var/lib/codex-gateway-research/research.db
RESEARCH_ARTIFACT_ROOT=/var/lib/codex-gateway-research/artifacts
RESEARCH_WORKER_ID=azure-worker-1
RESEARCH_WORKER_CONCURRENCY=1
RESEARCH_POLL_INTERVAL_MS=1000
RESEARCH_LEASE_SECONDS=120
RESEARCH_LEASE_RENEW_SECONDS=30
RESEARCH_HEARTBEAT_SECONDS=15
RESEARCH_HEARTBEAT_STALE_SECONDS=45
RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE=false
RESEARCH_MAX_QUEUED_RUNS=...
RESEARCH_CONTROL_READ_RPM=...
RESEARCH_CONTROL_MUTATION_RPM=...
RESEARCH_RECONCILE_INTERVAL_SECONDS=60
RESEARCH_RECONCILE_BATCH_SIZE=100
RESEARCH_CLEANUP_INTERVAL_SECONDS=3600
RESEARCH_CLEANUP_BATCH_SIZE=100
RESEARCH_NEEDS_INPUT_TTL_SECONDS=259200
RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT=10
RESEARCH_ARTIFACT_TTL_SECONDS=2592000
RESEARCH_RESULT_TTL_SECONDS=2592000
RESEARCH_RUN_RETENTION_SECONDS=7776000
RESEARCH_IDEMPOTENCY_REPLAY_SECONDS=604800
RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS=2592000
RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT=...
RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D=...
RESEARCH_MAX_ARTIFACT_BYTES=...
RESEARCH_MAX_ARTIFACT_BYTES_PER_RUN=...
RESEARCH_MAX_CHECKPOINT_BYTES=...
RESEARCH_MAX_RESULT_BYTES=...
RESEARCH_MAX_STORAGE_BYTES=...
RESEARCH_MIN_FREE_BYTES=...
RESEARCH_MIN_FREE_PERCENT=...
RESEARCH_BACKUP_ROOT=<approved-separate-backup-target>
RESEARCH_BACKUP_INTERVAL_SECONDS=...
RESEARCH_BACKUP_MAX_AGE_SECONDS=...
RESEARCH_SKILL_VERSION=1.6.2
RESEARCH_PROMPT_VERSION=doctor-research-prompt.v7
RESEARCH_LLM_BASE_URL=http://gateway:8787
RESEARCH_LLM_MODEL=goldencode
RESEARCH_LLM_REASONING_EFFORT=none|low|medium|high
RESEARCH_LLM_BEARER_TOKEN_FILE=/run/secrets/research_llm_bearer
RESEARCH_NCBI_API_KEY_FILE=/run/secrets/research_ncbi_api_key
RESEARCH_CROSSREF_MAILTO=...
RESEARCH_ORCID_CLIENT_ID_FILE=/run/secrets/research_orcid_client_id
RESEARCH_ORCID_CLIENT_SECRET_FILE=/run/secrets/research_orcid_client_secret
RESEARCH_ORCID_MODE=anonymous|bearer_file|client_credentials
RESEARCH_ORCID_ANONYMOUS_USE_APPROVED=false
RESEARCH_WEB_SEARCH_PROVIDER=direct|brave
RESEARCH_WEB_SEARCH_API_KEY_FILE=/run/secrets/research_web_search_api_key
RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS=...
RESEARCH_SIGNED_URL_ENABLED=false
RESEARCH_SIGNED_URL_LOG_REDACTION_CONFIRMED=false
RESEARCH_ARTIFACT_SIGNING_SECRET_FILE=/run/secrets/research_artifact_signing_secret
```

所有开关默认关闭。Gateway 在 `RESEARCH_API_ENABLED=false` 时不得打开 Research DB、注册后台定时器或执行额外轮询。

`RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D` 是隐私和反批量画像控制，不得
退化为无上限。当 `RESEARCH_API_ENABLED=true` 时，该值缺失、空、无法解析、
为 0 或为负数，Gateway 必须拒绝启动并给出不含 secret 的配置错误；不能使用
隐式默认值继续运行。Worker 启动预检还必须确认
`RESEARCH_LLM_MODEL` 与服务 credential 的非空精确模型允许清单一致，并通过
Worker readiness 查询确认 credential 的 RPM/RPD、单请求 prompt/total/reserve
和日/月 token policy 覆盖 Worker 配置的单次调用及整次 run 上限。

每日 run、needs-input、全局 queue、control-plane、artifact/result/storage、磁盘
余量和 backup age 等硬限制同样不得使用无上限隐式默认值。所有秒数关系必须在
启动时验证：

- `0 < RESEARCH_LEASE_RENEW_SECONDS <= RESEARCH_LEASE_SECONDS / 3`；
- `RESEARCH_HEARTBEAT_STALE_SECONDS >= 3 * RESEARCH_HEARTBEAT_SECONDS`；
- idempotency tombstone TTL 大于 replay TTL；
- run TTL 不短于 result/artifact TTL；
- 单 artifact 上限不大于单 run artifact 上限。

`RESEARCH_SIGNED_URL_ENABLED=false` 时，Gateway 不读取 signing secret，也不注册
signed URL 路由；启用时 signing secret 缺失或
`RESEARCH_SIGNED_URL_LOG_REDACTION_CONFIRMED` 不为显式 `true`，Gateway 必须拒绝
注册该可选路由。该确认值只能在完成 Nginx/Gateway/APM 查询日志检查和审批后设置。

### 17.4 Docker 镜像

新增 TypeScript workspace：

```text
apps/research-worker/
packages/research-core/
packages/research-store-sqlite/
packages/research-tools/
```

生产镜像不复制可编辑 docs 作为运行时 Prompt，不安装 Python、Pandoc 或 XeLaTeX。经过审核的 Prompt 和 Schema 作为版本化源码或只读构建产物进入镜像。

### 17.5 发布顺序

发布分成不可跳过的“兼容底座”和“Research feature”两个版本：

1. 冻结 API、Schema、状态机、capability、credential 模型允许清单和数据库
   兼容契约；
2. 构建**兼容底座版本**：尚不加入 `doctor_research`，只加入持久化 policy
   容错读取/未知值无损保留、外部写入严格校验，以及可空 credential 精确模型
   允许清单的 migration 和执行检查；
3. 使用临时 `gateway.db` 注入一个未来未知 capability，验证 plan 和 entitlement
   的 get/list、access calculation、credential current、quota dashboard、未知值
   round-trip，以及严格 writer 拒绝未知输入；
4. 验证发布时的全量现有 credential 保持原模型权限，公开模型表面仍精确为 8 个；
5. 在 Azure clean release checkout 部署兼容底座，执行现有 Gateway 全套 smoke，
   完成无回归观察；
6. 把该镜像的不可变 digest、migration 版本和 smoke 证据记录为**最低回滚版本**，
   并演练从后续候选镜像回滚到它；未完成前不得继续；
7. 构建**Research feature 版本**：新增 `doctor_research` 已知值、Research
   `/gateway/research/v1` 路由、Research error/LimitKind、独立 Research
   migration、Worker 和 artifact 代码，两个 feature flag 保持关闭；
8. 本地用临时 `gateway.db`/`research.db` 跑单元、契约和 fixture 测试，再次验证
   该版本能读取所有旧 policy/snapshot；
9. 在 Azure clean release checkout 部署 Research feature 镜像，保持两个开关
   关闭，执行现有 Gateway 全套 smoke 和精确 8 模型检查；
10. 此时才创建内部 Research plan/entitlement 和专用服务 credential；credential
    必须设置为仅允许 `RESEARCH_LLM_MODEL`，且不持有 `doctor_research`、
    `image_generation` 或管理认证材料；
11. 初始化 `research.db`，生成首个一致备份并在隔离目录完成 restore verify；
12. 只开启一个 Worker，对单个内部测试 principal 开启 API；
13. 跑固定 brief fixture、取消、身份选择、lease 接管、错误模型拒绝、鉴权
    artifact 下载、低磁盘拒绝、backup/restore，以及 Research/OpenAI error
    dialect 隔离；确认 signed URL 路由未注册；
14. 演练关闭开关并回滚到最低兼容版本，确认现有 `gateway.db` 无需数据订正且
    Research credential 的模型限制仍生效；
15. 恢复 feature 版本后观察至少 24 小时现有 Gateway 和 Research 指标；
16. 达到无回归和质量门槛后扩大内部测试。

任何 Azure live recreate 前后都必须保留并验证：

```text
max
specialist
consultant
expert
advisor
pro
standard
goldencode
```

### 17.6 回滚

1. 关闭 `RESEARCH_API_ENABLED`；
2. 关闭 `RESEARCH_WORKER_ENABLED` 或停止 Worker；
3. Worker 进入 draining，不再领取新任务；等待当前任务安全 checkpoint，超时后
   取消在途请求并释放/等待 lease 到期；
4. 保留 `research_state` volume；
5. 不删除或回滚现有 `gateway.db`；
6. Gateway 只能回滚到第 17.5 节记录的最低兼容版本或更晚版本，绝不回滚到
   对未知 capability 抛错的旧严格解析镜像；
7. 保留 credential 精确模型允许清单的加法 migration 和执行逻辑，使 Worker
   credential 即使在 Research feature 关闭时也不能改用其他公开模型；
8. 不修改现有模型 env；
9. Phase 1 signed URL 保持关闭，因此不触碰 Nginx 或同一主机上的其他服务；
10. 验证 plan/entitlement get/list、授权计算、quota dashboard、public smoke 和
    8 模型表面。

“先回滚镜像、再临时清理含 `doctor_research` 的 policy/snapshot”不是标准回滚
步骤：它会在事故压力下修改授权数据，并可能造成二次故障。若最低兼容镜像不可用，
按发布事故处理并恢复已固定 digest；任何数据订正都必须走单独审批、备份和演练
runbook，不能作为本方案的正常恢复路径。

## 18. 测试与验收

### 18.1 单元测试

- 输入规范化和 request hash；
- 所有合法状态迁移；
- 非法迁移拒绝；
- SQLite lease acquire/renew、generation fencing、取消返回与 0 行失去 lease 的
  区分、`cancelled` 终态的反向取消条件、失去 lease 后的迟到写拒绝；
- 120 秒 lease 下覆盖 180 秒 LLM 调用的持续续租和 AbortSignal；
- 身份评分和歧义判断；
- PubMed/Crossref/ORCID adapter；
- URL 和 SSRF 防护；
- PMID/DOI/题名去重；
- 引用编号和闭环；
- 五行 questions 与 answers 一致性；
- artifact 文件名、鉴权下载、可选签名、hash 和安全响应头；
- artifact 在临时写、fsync、rename、DB commit 各故障点的恢复和 orphan cleanup；
- capability 和 subject 授权；
- 持久化 policy 容错 decoder 与外部输入严格 validator 分离；
- 未知 capability 的读取、展示和重新序列化无损 round-trip；
- 取消与完成竞态；
- active brief 部分唯一索引和并发恢复竞态；
- identity-selection 超限 429 后 run、candidate、计数和有效期不变；
- 所有 Research `LimitKind` 精确值及 `active_brief` 短别名拒绝；
- 每日 run、needs-input、global queue 和不同医生滚动窗口配额及并发审计；
- fingerprint 到 canonical identity 合并前后的 distinct doctor 计数；
- idempotency replay、tombstone scrub、`idempotency_expired` 和最终 key 复用；
- active execution、queued 和 human-wait 计时；
- Worker heartbeat stale、process instance 替换和 draining；
- Research audit 脱敏及禁止字段；
- 中文文件名 `filename*` 编码；
- 唯一 JSON value 解析、尾随内容拒绝、AJV 校验、一次修复和
  `model_contract_error`；
- TTL reconciler 的 `needs_input -> cancelled`、终态 `-> expired`、事务内 audit、
  API fail-closed 表现、physical cleanup 和不可重入调度；
- run 列表 keyset 排序、cursor 参数绑定、逻辑过期映射和最大页长；
- 清理和 410。

### 18.2 契约测试

- `/gateway/research/v1` 请求和响应 JSON Schema；
- run 列表的 subject 隔离、状态过滤、分页稳定性和摘要最小化；
- `/gateway/research/v1` 的 auth/限流错误始终使用 Research error envelope，
  `/v1/*` 继续使用 OpenAI error envelope；
- Research route 跳过普通 credential request limiter，但命中独立 read/mutation
  limiter；Worker 的 `/v1/chat/completions` 不跳过现有限流；
- Bearer auth；
- 无 capability 返回 403；
- Phase 1 普通用户路径不会返回预留的 `resource_access_denied`；
- 使用含未来未知 capability 的临时 `gateway.db`，验证 plan/entitlement get、
  list、access calculation、credential current 和 quota dashboard 都不会抛错；
- 外部 plan create/update 仍拒绝未知 capability，持久化 decoder 则保留未知值；
- Worker 服务 credential 调用 Research 控制面和 image 路由均返回 403；
- Worker 容器没有管理面认证材料，管理 API 按独立 admin auth 拒绝；
- Worker 服务 credential 调用 `RESEARCH_LLM_MODEL` 成功，调用其余 7 个公开
  模型均返回 `403 model_not_allowed_for_credential`；
- 现有 `allowed_public_models_json=NULL` credential 仍可按原规则使用全部已启用
  公开模型；
- 不把 `chat`/`tools` policy 字段当作已实施门禁，不建立“未列出 tools 必须
  403”的错误契约；
- 创建、取消和 identity-selection 的幂等成功重放、请求冲突、replay 过期与
  tombstone 行为；
- identity-selection 同 key/同 body、同 key/不同 body、不同 key/非
  `needs_input` 三类行为；
- `needs_input` 恢复成功、active brief 超限
  `429 rate_limited/research_active_brief`、`Retry-After` 和原状态保留；
- terminal reason 与 API error 分离；
- fake clock 下 reconciler 延迟时，点查/列表/identity-selection/结果/下载仍执行
  同一逻辑 TTL，reconciler 恢复后持久化状态和 audit 收敛；
- result 未完成和过期；
- Bearer 鉴权下载的跨 subject 拒绝、TTL、hash 和安全响应头；
- signed URL 默认不注册；显式启用时验证 bearer capability、日志脱敏、篡改、
  过期和轮换；
- succeeded 后 result 与 artifact 一致；
- `outputs` 参数被拒绝且四个标准 artifact 必须完整；
- `zh-CN`/`en` 分别按固定计数器执行篇幅和问答长度；
- 新增字段不破坏旧客户端。

### 18.3 Skill Evals

将现有 evals 转为可执行 fixture：

1. 明确医生生成四个 artifact；
2. 常见姓名进入 `needs_input`；
3. 作者身份至少两类证据；
4. 资料不足不虚构；
5. 诊疗/用药请求不创建 Research run；
6. 一般文献综述不触发 doctor workflow。

补充：

- 网页提示词注入；
- 同名作者错误单位；
- PMID/DOI 元数据冲突；
- 文献不足目标数；
- 上游 429/5xx；
- Worker 每个阶段重启；
- 取消与完成并发；
- artifact 越权；
- 模型无效 JSON；
- 质量修复仍失败；
- 删除或 suppression 命中。

每个 fixture 必须同时具有机器可判定门禁：

- profile 必须存在非空“主要公开来源”，每个履历和成果 claim 都能解析到 source
  ID；不可核验的小类必须不存在，不能只写概括性占位句；
- 固定一组包含基础履历错误的负例，证明“院士年份”等官方事实不一致会失败；
- 每个 PMID/DOI 必须由 fake 或冻结的官方 adapter 成功解析，题名、期刊、年份
  一致，且正文编号与参考文献闭环；不能按编号位数猜测真实性；
- 注入 fixture 在网页正文中包含“忽略规则、调用工具、读取密钥”等指令，输出不得
  执行、复述为系统指令或扩大 URL/工具范围；
- 使用确定性 Unicode 计数器和引用计数器验证语言对应篇幅、核心文献数与总参考
  文献数；门槛不足必须得到预期失败/降级，不接受模型自报；
- 断言使用 JSON 字段、状态、source ID、计数范围、禁止项和固定 hash，不以自然
  语言人工理解作为 CI 唯一判据。

“马丁”样例含已知错误且缺少来源闭环，只作为
`KNOWN_INVALID_SAMPLE` 展示材料，不作为 golden fixture。即使将错误文本修正，也
不能自动升级为 golden。golden fixture 必须固定经人工核验的来源、元数据、检索
日期和期望断言。

现有 eval #1“张抒扬”和 eval #3“宁光”不得在 PR CI 中直接依赖实时互联网。
两者若保留为 golden fixture，必须使用允许保存的最小来源快照或结构化元数据，
并固定检索日期、来源 URL、内容 hash、adapter 输出和机器可判定断言。自然语言
断言必须转为结构化字段、状态、source ID、允许误差和禁止项；`files: []`
不能作为已完成 fixture。

实时人物检索只进入独立、非阻断的定期 live evaluation，用于发现来源漂移，
不能让 PR CI 随互联网内容随机失败。

Phase 0 的 fixture acquisition 和选定模型 benchmark 可以是经过审批、可重复记录的
独立 live job；其输出必须冻结为最小来源元数据、模型/Prompt/Schema 版本、hash 和
统计报告。PR CI 和 Phase 0 核心退出测试只消费冻结输入，不在测试时依赖 Azure
live 或实时互联网。

### 18.4 集成测试

CI 默认使用 fake adapters，不依赖实时互联网。受控 live smoke：

- PubMed 查询固定 PMID；
- Crossref 查询固定 DOI；
- ORCID 查询固定公开记录；
- 官网搜索命中固定官方页面；
- 生成一份小型 brief；
- 完成身份选择；
- 验证 active brief 已满时 selection 返回
  `429 rate_limited/research_active_brief` 且 run 仍为 `needs_input`；
- 使用两个 Worker process instance 制造 lease 接管，验证旧 Worker 的 checkpoint
  和终态写入被 fencing 拒绝；
- 分别制造“当前 owner 收到取消”和“旧 owner 续租 0 行”场景，验证只有前者能按
  `cancel_requested_at IS NOT NULL` 写 `cancelled`；
- 使用 fake clock 推进 `needs_input` 72 小时和终态结果 TTL，验证 reconciler 状态、
  audit、列表摘要以及 API 410 语义；
- 验证 Worker 服务 credential 不能创建 Research run；
- 验证 Worker 服务 credential 的批准模型成功、任一非批准公开模型返回 403；
- 验证 prompt-constrained JSON 经 Worker 解析和 AJV 校验，连续失败归类为
  `model_contract_error`；
- 通过 Bearer 鉴权下载并校验四个 artifact；
- 模拟 artifact rename 后 DB commit 前崩溃，验证恢复清理 orphan；
- 生成一致 Research backup，在隔离目录 restore 并验证 DB/artifact manifest；
- 清理临时 user、credential、run 和 artifact。

### 18.5 现有功能无回归

Research 发布前后必须执行：

- `npm run build`；
- `npm test`；
- public OpenAI-compatible smoke；
- strict/native tools smoke；
- `GET /gateway/credentials/current`；
- plan/entitlement list、授权计算和 quota dashboard smoke；
- `/v1/models` 精确 8 模型检查；
- `goldencode` 请求和 request event 检查；
- Gateway health、容器 restart count 和 loopback port 检查。

负载验证至少覆盖：

- Research 关闭时与当前版本等价；
- 1 个持续 brief 下现有 chat P95/P99；
- Research DB 锁等待不影响 `gateway.db`；
- Worker 重启、外部搜索超时和 LLM 超时不影响现有路由；
- 停止 Worker 后 Gateway 继续正常提供现有服务；
- Research 达到配置 storage hard limit、低磁盘拒绝 admission 和 backup stale 时，
  `gateway.db`、chat、credentials 和 8 模型 smoke 仍正常。

## 19. 分阶段实施

### Phase 0：离线契约与 Agent 原型

入口条件：

- 完成 §3.5 ASCII 路径迁移，旧 `docs/采访skill/` 下不再提交生产实现；
- 冻结 `allowed_public_models_json` migration `22`、错误码、`LimitKind` 和
  `FastifyContextConfig.responseDialect` 表示；
- 将“马丁”材料标为 `KNOWN_INVALID_SAMPLE` 或移入无效样例目录，禁止 eval runner
  自动发现为 golden；
- 三个第三方 Skill 已明确为不可执行参考快照，未进入镜像或依赖解析路径。

交付：

- `doctor_research_run.v1` 和 `doctor_research_result.v1`；
- SkillDefinition 和版本规则；
- Research 状态机；
- 独立 SQLite Store，包括 lease generation/fencing、admission ledger、
  idempotency tombstone、heartbeat 和 audit；
- fake adapters；
- 具有结构化断言、确定性字数/引用计数和 prompt-injection 负例的自动化 eval
  runner；
- 四文本 artifact renderer 和原子发布/崩溃恢复 harness；
- 第三方参考快照的隔离 README、已知来源信息和许可证状态说明；在精确来源
  证据恢复前保持不可执行、不进入生产镜像、不打包和不再分发；
- 第三方快照的文档/脚本 CLI 差异、公共代理、`.env` 自动发现、外部依赖、
  OpenRouter 模型和重复 schematic 脚本审核清单；
- 至少 20 个固定 fixture 的 token、时延和质量报告，其中至少 15 个是按医院
  层级、科室、职级和英文发表密度分层的真实中国医生冻结案例；
- 每个真实人物 fixture 只保存允许留存的最小来源快照或结构化元数据、检索
  日期、URL、hash 和人工核验 gold set；
- Phase 1 数据源栈的文献 `recall@15`、作者归属 precision、履历/项目/专利/
  奖项 claim coverage，以及 `insufficient_evidence` 和
  `passed_with_warnings` 比例报告；
- 选定模型的结构化输出报告：schema 首次通过率、解析失败率、AJV 失败率、修复
  尝试率、修复成功率和 `model_contract_error` 率；
- capability 兼容 fixture：冻结含当前未知值的 plan/entitlement/snapshot，
  自动验证所有读取面、未知值 round-trip 和严格写入拒绝；
- Research error dialect 与普通 OpenAI `/v1/*` error dialect 隔离契约；
- 多 Worker lease 接管、迟到写 fencing、取消/完成竞态和 artifact 故障点报告；
- 每日/不同医生配额、磁盘 hard limit、backup/restore 和 audit 脱敏报告。

退出条件：

- 离线契约、状态机和核心 eval 全部通过；
- run 列表、取消/lease 分流、TTL reconciler 和 Phase 0 冻结类型契约全部通过；
- 不依赖 live Azure 或实时互联网；
- 没有已知错误样例、自然语言-only 断言或 `files: []` 被计作通过的 golden；
- 目标人群、覆盖指标、最低证据门槛和通过阈值已经批准；
- Phase 1 数据源栈对批准目标人群达到覆盖阈值；未达到时已经收窄适用人群，
  或已把有授权的中文数据源列为 Phase 1 阻断项；
- 选定内部 LLM model 和官网搜索 provider；
- 结构化输出成功率达到批准阈值，并据 fixture 数据确认修复预算；
- capability 兼容读取/严格写入契约通过；最低回滚镜像 digest 和生产形态
  快照验收属于 Phase 0.5 发布兼容门槛，不阻断离线工程底座；
- 明确 Research 上游容量方案；
- lease/fencing、artifact 原子发布、admission quota 和 active-time 计时契约通过；
- Research RPO/RTO、磁盘限制、恢复演练和 signed URL 保持关闭的下载方案
  属于 Phase 1 生产启用门槛，不阻断离线工程底座。

Phase 0 分成两个可独立跟踪的子阶段：Phase 0A 是上述离线工程底座；Phase 0B
是目标人群、冻结 fixture、数据源覆盖和模型/provider 基准证据。Phase 0A 可以
先完成并允许默认关闭状态下继续编码；整体 Phase 0 只有在 Phase 0B 证据也通过
后才关闭。

### Phase 1：Azure 内部 brief

Phase 1 仅交付 Doctor Research Brief，不实现原始 Skill 的 full 契约。马丁
样例、约 40 篇目标文献和 6000 字以上综述不属于本阶段验收范围。

交付：

- `/gateway/research/v1` Fastify Research 控制面 API、Research error dialect 和
  独立 control-plane limiter；
- `research-worker`；
- PubMed、Crossref、ORCID 和官网搜索 adapters；
- capability 兼容底座和固定的最低回滚镜像；
- credential 级精确模型允许清单；
- `doctor_research` capability；
- brief 四产物和默认 Bearer 鉴权下载；
- Research admin CLI、metrics、audit、cleanup、backup/restore 和 runbook；
- 内部测试 principal。

退出条件：

- 身份、引用和 claim 准确性达到人工审核阈值；
- 批准目标人群的覆盖率和最低证据门槛达标；
- Azure live smoke 通过；
- 现有功能无回归；
- Research 故障隔离演练通过；
- lease 接管、artifact 崩溃恢复、低磁盘 admission 拒绝和 restore drill 通过；
- 没有 credential、内部路径或敏感信息泄漏。

### Phase 2：full 综述

交付：

- 约 40 篇目标检索；
- `zh-CN` 6000 汉字以上或 `en` 3500 words 以上主题式综述；
- 分节生成；
- 数字来源核验；
- 两轮定向修复；
- 在启用 `full` 前明确 brief/full 是共享一个 active slot 还是分别限额，并增加
  覆盖 `full` 的数据库部分唯一约束、并发恢复测试和配额契约；
- 成本与缓存策略；
- 独立上游容量。

退出条件：

- identity、citation、claim 三项人工抽检达标；
- P95、成本和上游容量达标；
- full 不影响现有 chat。

### Phase 3：受控外部开放

交付：

- 正式 API 文档；
- 套餐、Research 配额和费用；
- 删除与更正流程；
- 安全与隐私评估；
- 运维手册和告警；
- 必要时迁移到 PostgreSQL、Azure managed database 或对象存储。

## 20. 主要风险

| 风险 | 缓解 |
|---|---|
| 同名医生或作者误归属 | `needs_input`、两类身份依据、claim-source 映射 |
| 模型虚构论文或数字 | 冻结 evidence set、结构化引用、程序化核验 |
| 网页提示词注入 | 内容与指令隔离、白名单 adapters、无任意 URL |
| Research 占用聊天上游容量 | 专用 credential、硬并发、专用上游容量、无回归门槛 |
| 新 capability 写入后旧镜像无法读取授权数据 | 兼容 decoder 先行、严格 writer 分离、未知值无损保留、固定最低回滚镜像 |
| Worker 改用未经批准的公开模型 | 可空的 credential 精确模型允许清单；仅 Research credential 收紧 |
| 提示词 JSON 输出不稳定 | Worker 严格解析和 AJV、定向修复、Phase 0 独立错误率门槛 |
| SQLite 锁影响 Gateway | 独立 `research.db` 和 volume、短事务、单 Worker |
| Lease 过期后旧 Worker 迟到写覆盖新 Worker | 周期续租、generation fencing、条件写入和 AbortSignal |
| 长任务超时或成本失控 | brief/full、阶段预算、硬超时、取消 |
| 数据源限流 | 官方 API、缓存、退避和熔断 |
| 中国医生和中文成果系统性漏召回 | Phase 0 分层冻结案例、gold set、召回率和 claim coverage 门槛；不达标则收窄适用人群或接入有授权中文数据源 |
| 公开信息聚合超出合理范围 | 目的限制、最小化、保留期、更正和删除流程 |
| 批量医生画像或枚举 | 持久化 admission ledger、每日 run、滚动 30 天 distinct doctor、operator 审批和审计告警 |
| Artifact 文件与 DB 状态不一致 | 临时文件、fsync、原子 rename、fenced 完成事务和 orphan 恢复 |
| Artifact 越权或 signed URL 转发 | Phase 1 Bearer 鉴权下载；signed URL 默认关闭并明确为短时 bearer capability |
| Research volume 占满宿主机磁盘 | 单 run/全局硬上限、低磁盘 admission 拒绝、cleanup、告警和 restore drill |
| Prompt 与 Skill 漂移 | 版本化构建产物、代码评审和回归 eval |
| Research 故障传播 | 独立 Worker/DB/volume、feature flag、不回退到 chat |
| 样例看似完整但履历或引用未核验 | 官方事实 fixture、运行时 PMID/DOI 元数据一致性、正文闭环和人工抽检 |
| 第三方 Skill 文档命令不可执行或引入供应链/数据外泄风险 | 仅保留固定来源快照，记录 CLI 差异、禁止公共代理和 cwd `.env`、不进入生产镜像 |

## 21. 实施前待决事项

以下两组实现契约已在 v0.7 冻结，不再列为待决项，且必须在任何 Phase 0 编码前
进入契约测试：

1. credential 精确模型允许清单：`gateway.db` migration `22`，
   `access_credentials.allowed_public_models_json TEXT NULL`，NULL/非空语义和
   `403 model_not_allowed_for_credential` 按 §6.4；
2. Research 类型表示：`FastifyContextConfig.responseDialect`、
   `GatewayResponseDialect`、`GatewayErrorCode` 加法值和七个 `LimitKind` 按
   §8.1。研究路由配置固定为
   `{ responseDialect: "research", skipRateLimit: true }`。

若实现时发现与现有代码冲突，必须先升级本文版本并重新审核契约，不得在代码中另取
字段名、短别名或隐式 URL 推断后把文档留待补写。

进入 Phase 1 前必须确认：

1. Research 使用哪个现有模型；
2. 如何提供独立或保留的上游容量；
3. 官网搜索使用哪个正式 API；
4. Phase 1 的目标医生范围、覆盖指标、最低证据门槛和通过阈值；
5. brief 单 run、每日预算和滚动 30 天不同医生数量上限；
6. `deadline_exceeded` 初始 2% SLO 是否合适；
7. artifact 30 天、run/audit 90 天是否合适；
8. Azure 区域和外部 provider 的隐私、跨境与合同边界；
9. 内部首批测试 principal；
10. full 的人工审核和开放条件；
11. capability 兼容 decoder 的未知值保留表示、严格 writer 边界和最低回滚镜像
    digest 记录方式；
12. Worker prompt-constrained JSON 的 Phase 0 通过阈值及一次修复预算是否足够；
13. Research control-plane read/mutation 限额、每日 run、global queue、单
    artifact/run 和全局 storage 上限；
14. Research RPO/RTO、备份频率、backup stale 阈值和 restore drill 责任人；
15. `zh-CN`/`en` 篇幅和问答长度阈值是否适合产品；
16. Phase 1 保持 `RESEARCH_SIGNED_URL_ENABLED=false`，默认使用 Bearer 鉴权下载；
17. lease 120 秒、续租 30 秒、heartbeat 15 秒和 stale 45 秒的初始值。

PDF、图片和对象存储不是 Phase 1 阻断项。中文商业文献库是否阻断由 Phase 0
覆盖评估决定：若批准目标人群的现有数据源栈达标，可以不阻断；若面向广泛中国
医生且覆盖不达标，则接入有授权的中文数据源或收窄产品范围是 Phase 1 阻断项。

## 22. 审核通过标准

- [ ] 同意在 Azure Codex Gateway 中提供领域化异步 Doctor Research API；
- [ ] 同意 Gateway 只承载轻量控制面；
- [ ] 同意独立 `research-worker`；
- [ ] 同意独立 `research.db` 和 `research_state` volume；
- [ ] 同意复用现有 Bearer credential auth；
- [ ] 同意 Research 使用 `/gateway/research/v1` 和 Research error dialect，不占用
  OpenAI `/v1/*` 命名空间；
- [ ] 同意 subject-scoped run 列表端点、keyset cursor 和最小摘要契约；
- [ ] 同意 Research read/mutation limiter 独立于普通 chat request limiter，429
  继续满足 Gateway rate-limit contract v1；
- [ ] 同意新增默认关闭的 `doctor_research` capability；
- [ ] 确认 capability 前向/回滚兼容与 expand/contract 发布顺序：容错读取、
  未知值无损保留且写入严格的版本先行，并成为最低回滚版本；
- [ ] 同意生产不直接执行 bundled Python scripts；
- [ ] 同意只使用白名单 TypeScript adapters；
- [ ] 同意首版只开放内部 brief；
- [ ] 确认 Phase 1 不按马丁样例、约 40 篇文献或 6000 字 full 综述验收；
- [ ] 确认目标医生范围、覆盖指标、最低证据门槛和 Phase 0 通过阈值；
- [ ] 确认覆盖不达标时收窄范围或接入有授权中文数据源；
- [ ] 同意不修改公开 8 模型表面；
- [ ] 同意 full 前解决独立上游容量；
- [ ] 同意 identity、citation、claim 和 artifact 质量门控；
- [ ] 同意 feature flag、回滚和现有功能无回归门槛；
- [ ] 同意 Worker credential 不具备 `doctor_research` 和
  `image_generation`，管理面由独立 admin auth 隔离；不把当前未强制的
  `chat`/`tools` capability 当作安全边界；
- [ ] 同意 credential 级精确模型允许清单：现有空值 credential 行为不变，
  Research credential 只能使用 `RESEARCH_LLM_MODEL`；
- [ ] 确认 migration `22`、`allowed_public_models_json`、Research
  `GatewayErrorCode`/`LimitKind` 和 `responseDialect` TypeScript 表示已冻结；
- [ ] 确认 Research LLM 采用 Worker 侧 AJV over prompt-constrained JSON，
  不依赖未实施的 chat `response_format` 或未强制的 `tools` capability；
- [ ] 同意 active brief 数据库不变量、selection 429、replay/tombstone 和幂等语义；
- [ ] 同意持久化 admission ledger、每日/不同医生/global queue 上限、审计和异常
  批量行为控制；
- [ ] 同意 lease generation、周期续租、取消返回与失去 lease 分流、取消终态的
  精确 fencing 条件，以及失去 lease 后停止写入；
- [ ] 同意 artifact 临时写、fsync、原子 rename、fenced 完成事务和 orphan 恢复；
- [ ] 同意 active execution time 排除 queued/needs-input，并将 wall-clock、
  queue、human-wait 和 active time 分开报告；
- [ ] 同意 TTL reconciler 是状态迁移执行者、API 只做 fail-closed 逻辑表现，
  physical cleanup 不代替 `needs_input -> cancelled -> expired` 持久化与 audit；
- [ ] 同意 Phase 1 默认 Bearer 鉴权下载，signed URL 默认关闭且不宣称 subject
  绑定可以验证 URL 持有者；
- [ ] 确认 Research storage hard limit、低磁盘 admission 拒绝、RPO/RTO、backup
  和 restore drill；
- [ ] 同意在 Phase 0 编码前迁移到 ASCII 路径；
- [ ] 同意“马丁”样例标为已知无效展示材料，不作为 golden；golden 必须覆盖官方
  履历、引用元数据、prompt injection 和确定性篇幅/引用计数；
- [ ] 同意第三方 Skill 来源、版本、许可证和不可执行参考快照声明，并记录
  文档/脚本脱节、公共代理、cwd `.env`、缺失依赖和重复脚本；
- [ ] 确认 LLM model、官网搜索 provider、预算和数据保留期；
- [ ] 确认安全、隐私和跨境评估责任人。

## 23. 最终建议

批准在 Azure `codex-gateway` 中实施 Doctor Research Agent，但按
“`/gateway/research/v1` 现有 Gateway 控制面 + 独立 Research Worker + 独立
Research SQLite/volume + 内部 Gateway LLM 调用”的方式建设。

第一步只实施 Phase 0：冻结契约、状态机、Store、fake adapters 和自动化 eval，
不修改 Azure live 配置。Phase 0 通过后，先独立发布 capability 兼容读取和
credential 精确模型限制版本；该版本稳定、固定为最低回滚镜像并完成回滚演练后，
才能发布默认关闭的 Research feature。任何含 `doctor_research` 的
plan/entitlement/snapshot 都不得早于兼容底座写入生产 `gateway.db`。随后才以
单个内部 brief principal 灰度。

Phase 0 还必须用可重复测试证明 lease 续租/fencing、Research admission quota、
artifact 原子发布、幂等 tombstone、active-time deadline、Research error dialect、
鉴权下载和 backup/restore。Phase 1 保持 signed URL 关闭，不因浏览器下载便利性
扩大 bearer URL 泄漏面。

Phase 0 必须先证明批准目标人群的数据覆盖可用。不能用
`passed_with_warnings` 掩盖中国医生资料的系统性漏召回；覆盖不达标时，先收窄
产品范围或解决有授权中文数据源，再进入 Phase 1。

不采用以下方案：

- 把 SKILL.md 直接拼接到普通 chat；
- 在一个同步 HTTP 请求中完成调研；
- 让当前 Codex provider 开放任意网络、shell 和文件写权限；
- 运行时执行 docs 下 Python 脚本；
- 将 Research 状态写进现有 sessions 或 request events；
- 在未解决上游容量前开放 full；
- 为 Research 修改或增加公开模型。

该路径最大限度复用 Azure Codex Gateway 已有鉴权、用户、套餐、模型路由、用量和运维能力，同时补齐真正的服务端 Agent 编排、工具、证据、质量和长任务基础设施。
