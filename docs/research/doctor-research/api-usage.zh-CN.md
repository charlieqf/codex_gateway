# Doctor Research API 调用说明与注意事项

本文面向 Doctor Research 受限试用的客户端开发者和调用方。生产入口为
`https://gw.instmarket.com.au`。该能力仍处于 `controlled-trial`：只能使用分配给
实名用户且已开通 Doctor Research entitlement 的专用凭据，医学团队完成人工内容
验收前不得扩大用户范围。

## 1. 调用前准备

- 使用 `Authorization: Bearer <key>` 认证。不要将 key 放入 URL、查询参数、源码、
  工单、日志或命令行参数；推荐存入权限受控的文件或
  `DOCTOR_RESEARCH_API_KEY` 环境变量。
- 不要复用普通 Gateway key、共享 key 或其他用户的 key。服务会按用户隔离 run 和
  artifact；无权访问与不存在的资源统一按未找到处理。
- 准备医生的中文展示身份以及 1 至 3 个生产 allowlist 内的 HTTPS 官方来源。
  `literature_identity` 只能填写已经独立核实的 PubMed 英文姓名、医院和科室三元组，
  不得根据中文名自行翻译或猜测。
- 请求是异步任务，不要把创建接口当作长连接同步接口。保存
  `Idempotency-Key`、返回的 `run_id` 和响应 `X-Request-Id`，以便安全重试和排障。

## 2. 接口一览

所有路径都以生产 origin 为基准，均要求 Bearer 凭据。

| 方法与路径 | 用途 | 是否要求 `Idempotency-Key` |
| --- | --- | --- |
| `POST /gateway/research/v1/doctor-runs` | 创建 run | 是 |
| `GET /gateway/research/v1/doctor-runs?limit=20&status=running&cursor=...` | 列出当前用户的 run | 否 |
| `GET /gateway/research/v1/doctor-runs/{run_id}` | 查询状态和进度 | 否 |
| `POST /gateway/research/v1/doctor-runs/{run_id}/identity-selection` | 人工选择或拒绝候选身份 | 是 |
| `POST /gateway/research/v1/doctor-runs/{run_id}/cancel` | 请求取消 | 是 |
| `GET /gateway/research/v1/doctor-runs/{run_id}/result` | 读取成功 run 的 manifest | 否 |
| `GET /gateway/research/v1/artifacts/{artifact_id}/download` | 下载单个产物 | 否 |

列表 `limit` 范围为 1 至 100，默认 20。`status` 必须是服务返回的合法状态；
`next_cursor` 不为空时应原样用于下一页，并保持相同的 status 过滤条件。

## 3. 创建请求

创建请求必须使用 `Content-Type: application/json`，并附带稳定且可复用的
`Idempotency-Key`。key 格式为 `research:` 加字母、数字、点、下划线、冒号或连字符，
总长度不超过 128 字符。

```http
POST /gateway/research/v1/doctor-runs HTTP/1.1
Host: gw.instmarket.com.au
Authorization: Bearer <key>
Idempotency-Key: research:his-user-42:case-20260722-001
Content-Type: application/json
Accept: application/json

{
  "doctor": {
    "name": "陆清声",
    "hospital": "海军军医大学第一附属医院",
    "department": "血管外科",
    "title": "教授、主任医师",
    "city": "上海",
    "official_profile_urls": [
      "https://www.carm.org.cn/gywm/fzjg/zywyh/art/2025/art_8451aeed0bc14fbab6541f37c08b5195.html"
    ],
    "literature_identity": {
      "name": "Lu Qingsheng",
      "hospital": "Changhai Hospital",
      "department": "Vascular Surgery"
    }
  },
  "mode": "brief",
  "language": "zh-CN",
  "options": {
    "publication_years": 5,
    "citation_style": "vancouver"
  },
  "client_reference": "his-case-20260722-001"
}
```

字段约束如下。

| 字段 | 要求 |
| --- | --- |
| `doctor.name` | 必填，2 至 100 个字符 |
| `doctor.hospital` / `doctor.department` | 受限试用均必填，各不超过 200 个字符 |
| `doctor.title` / `doctor.city` | 可选，各不超过 100 个字符 |
| `doctor.orcid` | 可选，必须是校验位正确的标准 ORCID；仅在部署已批准 ORCID 访问时使用 |
| `doctor.official_profile_urls` | 生产直连模式必填，1 至 3 个互不重复、allowlist 内、无凭据和 fragment 的 HTTPS URL |
| `doctor.literature_identity` | 可选；如使用，`name`、`hospital`、`department` 三项必须一起提供并已核实 |
| `mode` | 当前只能是 `brief` |
| `language` | `zh-CN` 或 `en` |
| `options.publication_years` | 1 至 10 的整数 |
| `options.citation_style` | 当前只能是 `vancouver` |
| `client_reference` | 可选，不超过 128 个字符；建议使用调用方稳定且不含敏感信息的病例引用 |

服务会拒绝未声明字段，字段名必须严格使用上述 snake_case。完整无密钥示例见
[`request.example.json`](request.example.json)。

### 幂等与重试

- 一个逻辑创建操作固定使用一个 `Idempotency-Key`。相同 key、相同请求体会重放同一
  接收结果；相同 key、不同请求体返回 `409 idempotency_conflict`。
- 创建响应不确定（连接在收到响应前中断）时，必须用原 key 和完全相同的 JSON
  重试。不要换新 key，否则可能创建重复 run。
- mutation（创建、身份选择、取消）不要自动换 key 重试；只可在请求语义不变时复用
  原 key。客户端不得同时为同一病例并发创建多个 run。

## 4. 查询状态和人工身份确认

创建成功返回 HTTP 202 和 `run_id`。建议每 5 秒查询一次状态，不要高频轮询。

- `queued`、`running`：继续轮询。
- `needs_input`：暂停自动流程。向有权限的人展示
  `input_required.candidates` 的姓名、医院、科室、城市和来源，人工确认后才能提交。
- `succeeded`：读取 `/result` 并校验、下载全部产物。
- `failed`、`cancelled`、`expired`：终态。记录 `terminal_reason`、
  `terminal_detail_public` 和 `request_id`，不得把它们当成部分成功。

选择经过人工确认的候选：

```http
POST /gateway/research/v1/doctor-runs/{run_id}/identity-selection
Authorization: Bearer <key>
Idempotency-Key: research:identity:{run_id}:dc_xxx
Content-Type: application/json

{"candidate_id":"dc_0123456789abcdef"}
```

如果所有候选都不正确，应明确拒绝，不要选择“最像”的候选：

```json
{"action":"reject_all"}
```

身份选择也使用独立、稳定的幂等 key。`needs_input_expires_at` 到期前没有人工决定时，
run 会按取消终止。

## 5. 等待上限和取消

整个 run 必须在创建后 10 分钟内到达终态。当前 Worker 硬截止为 570 秒；推荐客户端
等待上限为 590 秒，从而为终态查询和结构化错误留出余量。客户端自己的 590 秒等待
到期并不代表服务端 run 已被取消，之后仍可按 `run_id` 查询；只有确实不再需要任务时
才调用取消接口。

```http
POST /gateway/research/v1/doctor-runs/{run_id}/cancel
Authorization: Bearer <key>
Idempotency-Key: research:cancel:{run_id}
Content-Type: application/json

{}
```

取消是请求语义，调用后继续查询直到 `cancelled` 或其他终态。已经进入不允许取消的
终态时返回 `409 invalid_run_transition`。

## 6. 结果与文件完整性

只有状态为 `succeeded` 才能读取 `/result`。成功 manifest 必须同时满足：

- `schema_version` 为 `doctor_research_result.v1`，`run_id` 与请求一致；
- 恰好 4 个不同 kind：`profile`、`review`、`questions`、`answers`；
- 恰好 3 个 `.md` 和 1 个 `.txt`；问题 TXT 恰好包含 5 个非空行；
- 每个 artifact ID、文件名和同源相对 `download_url` 均合法；
- 下载响应的 `Content-Type`、`Content-Length`、`size_bytes` 和本地计算的
  SHA-256 全部与 manifest 一致。

任何一个文件缺失、越界、哈希不一致或内容契约失败，都必须判定整个结果不可发布。
应先下载到私有临时目录，四个文件全部验证后再原子发布；不要直接信任服务端文件名，
也不要在失败时保留或展示半成品。

## 7. HTTP 错误处理

错误响应使用结构化 `error.code` 和 `error.message`。常见状态：

- `400`：字段、URL、幂等 key 或请求体无效；修正请求，不要原样循环重试。
- `401` / `403`：凭据无效、用户未启用或无 entitlement；不得改用共享凭据绕过。
- `404`：run/artifact 不存在或当前用户不可见；两种情况不会向客户端区分。
- `409`：幂等冲突、幂等窗口过期或状态转换无效；先核对原 key、原请求和 run 状态。
- `410`：run 或 result 已过保留期。
- `429`：配额、并发或读取速率限制；只对安全的 GET 按整数 `Retry-After` 有界重试。
- `503`：Worker、存储或研究能力暂不可用；保存请求 ID，并在有界退避后重试。创建
  请求如结果不确定，仍必须复用原幂等 key 和请求体。

排障记录应包含时间、HTTP 状态、`error.code`、`run_id`、`client_reference`、
`Idempotency-Key` 的非敏感调用方引用和 `X-Request-Id`，但绝不能包含 Bearer key、
医生未公开个人数据或完整产物内容。

## 8. Python 示例

仓库中的 `scripts/doctor-research-demo.py` 只使用 Python 标准库，完成创建、5 秒轮询、
有界 GET 重试、质量/warning 校验、严格 manifest 校验、同源认证下载、SHA-256 校验和
原子发布。推荐从 JSON 请求文件调用：

```powershell
Copy-Item docs/research/doctor-research/request.example.json .\request.json
# 编辑 request.json，使用已核实身份和稳定 client_reference。
python scripts/doctor-research-demo.py `
  --request-file .\request.json `
  --api-key-file C:\private\doctor-research.key `
  --idempotency-key research:his-user-42:case-20260722-001 `
  --output-dir .\doctor-research-output
```

也可用 `DOCTOR_RESEARCH_API_KEY` 环境变量代替 `--api-key-file`，两者不能同时使用。
POSIX key 文件权限必须为 `0600` 或更严格。示例故意不提供命令行 token 参数，拒绝
redirect、非 loopback 明文 HTTP、符号链接 key/request 文件和不安全文件名。

示例遇到 `needs_input` 时退出码为 2，并打印候选 ID，但不会自动选择；应由业务系统
按第 4 节完成人工确认。其他失败退出码为 1，成功为 0。默认等待 590 秒，最大可显式
配置为 600 秒。成功事件还会输出 `quality_status` 和去重后的 `warnings`；调用方应保存并
展示 warning，而不是因为已经下载到文件就把它静默丢弃。

命令行逐字段方式仍受支持，查看完整参数：

```powershell
python scripts/doctor-research-demo.py --help
```

## 9. 质量与业务边界

Doctor Research 会对身份、引用、数字、证据等级、安全和四文件完整性 fail-closed。
不能通过客户端重试、删除诊断或放宽校验把失败包装为成功。医学团队维护的 Skill 仍是
业务权威来源。`1.6.73` 受控试用策略继续按原目标生成，但把纯篇幅完整度拆成“目标值”
和“最低发布线”，以免证据闭合且结构完整的边界短文仅因少量字数不足而整单失败：

| 内容 | 原生成目标 | `controlled-trial` 最低发布线 |
| --- | ---: | ---: |
| 综述正文合计 | 6000 | 5000 |
| 引言 | 800 | 640 |
| 每个主题小节 | 600 | 450 |
| 证据综合与争议 | 800 | 640 |
| 局限与展望 | 600 | 450 |
| 结论 | 200 | 160 |

低于目标但达到最低发布线时，run 只能以 `passed_with_warnings` 发布，并在
`quality.warnings` 返回一个或多个下列代码：

- `controlled_trial_review_content_below_target`
- `controlled_trial_introduction_below_target`
- `controlled_trial_topic_section_below_target`
- `controlled_trial_synthesis_below_target`
- `controlled_trial_limitations_below_target`
- `controlled_trial_conclusion_below_target`

这项策略不减少章节数量，不放宽 300–500 字摘要、5 问 5 答、身份归属、引用闭合、
逐段引用、数值证据、因果/证据等级、安全过滤或恰好 3 MD + 1 TXT/SHA-256 门槛；缺章节
仍然失败且不发布半成品。带软篇幅 warning 的文件仍需进入医学人工复核。代表病例接受
标准和最终四文件内容验收继续由医学团队决定；自动化和 SHA-256 通过只证明工程完整性，
不替代医学内容人工审核，也不得据此扩大 `controlled-trial` 用户范围。
