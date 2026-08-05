# 境内 GoldenCode Gateway 与 Doctor Research 搬迁实施方案

| 项目 | 内容 |
| --- | --- |
| 状态 | R760 正式四容器、私有 Mihomo、DNS-only 直连入口和统一 key 新地址已部署；Research E2E、真实 GLM 与低成本生图已通过；Azure 发钥到 R760 的逐行同步、历史统一 key 对齐和正式发钥 fail-closed 已完成，周期性无人值守对账仍待部署；客户端分批改址、旧模型零用量观察和最终切流仍待关闭；Azure MedEvidence US/PostgreSQL 16 与 TokenBridge/NewAPI 已先行可逆退役，其余 VM 多服务退役另行规划；CN1 边缘保持暗路由且不再是切流方案 |
| 首次编制 | 2026-07-30 |
| 现状更新 | 2026-08-05 |
| 完成窗口 | 原计划 2026-08-01/02，未切流；下一批准维护窗口待确定 |
| 当前生产源 | Azure `gw.instmarket.com.au` |
| 目标环境 | 本地 Dell PowerEdge R760（Ubuntu 22.04） |
| 公网入口 | 客户端显式使用 `https://goldencode.instmarket.com.au:1443`；DNS-only A 记录直达 R760 公网 NAT，外部 `1443` 映射到 R760 Nginx `443` |
| 核心目标 | 单一公共文本模型 `goldencode` + 低成本生图 + 四容器 Doctor Research |

## 1. 结论

本次不是把当前 Azure 八模型环境原样复制到另一台机器，而是建设一个
**仅使用境内 LLM 上游**的目标生产形态，并迁移现有用户、鉴权、Doctor
Research 状态和产物。

迁移后的公共文本模型面只保留 `goldencode`。Azure 当前的 `max`、
`specialist`、`consultant`、`expert`、`advisor`、`pro` 和 `standard`
均不迁移；客户端必须统一发送 `model=goldencode`。图片生成是独立能力，不进入
`/v1/models`，继续通过 `/gateway/images/generations` 提供。

目标端由四个协作容器组成：

1. `gateway`：唯一的公网控制面和 API 服务；
2. `research-llm-gateway`：Doctor Research 专用、非公开的内部 LLM Gateway；
3. `research-worker`：执行身份核验、检索、生成、验证和四文件交付；
4. `research-maintenance`：执行备份、维护和健康检查。

只有 `gateway` 可以通过宿主机 loopback 端口接入 Nginx/TLS。其余三个容器
不得发布宿主机端口。

网管已拒绝公网 `443 -> R760:443`；CN1 边缘方案又受到 Aliyun 备案入口拦截，不能
作为公网切流路径。因此客户端必须修改 URL，当前分批迁移入口为：

```text
消费者 https://goldencode.instmarket.com.au:1443
  -> DNS-only A 记录 117.186.49.26
  -> 公网 NAT（外部 1443 -> R760 192.168.77.242:443）
  -> R760 Nginx（goldencode SNI/TLS）
  -> 127.0.0.1:18787
  -> R760 gateway
```

CN1 现有 `codex_gateway_cn1` loopback Gateway 和已安装的 `gw` 边缘 vhost 均不在
当前直连路径内，不承载 R760 的用户、凭据或 Doctor Research 状态。R760 运行时的
`GATEWAY_PUBLIC_BASE_URL` 已改为
`https://goldencode.instmarket.com.au:1443`；统一 key 解析会返回对应的 `/v1` 和
credential-validation URL。

当前 Azure 生产及其回滚边界在切流验收完成前保持权威。R760 已完成正式
四容器部署并开放独立直连入口，但不会接管 `gw` DNS；尚未修改配置的客户端仍走
Azure。正式用户发钥脚本也继续以 Azure 的 `gw` 入口和 `codex_gateway_test`
状态库为权威源。2026-08-05 已实现 Azure 到 R760 的用户/key/plan 逐行幂等同步：
Azure 的 90 条统一 key 已全部包含在 R760 中，正式发钥会在写 handoff 前强制完成
同步和双端验证。客户端批量改址、周期性无人值守对账及最终状态收口仍是计划态。

由于仍有较多用户使用旧客户端、旧模型和旧入口，Azure Gateway 不能快速下线。
同时，Azure VM 还承载 Answer Generator、PubMed Evidence Set、桌面更新源、
Research staging 及其他辅助路由；MedEvidence US/PostgreSQL 16 和公开
TokenBridge/NewAPI 已于 2026-08-05 先行执行可逆停用，但其数据和同机回滚备份尚未
删除或转移到主机外。VM 全量退役的范围仍显著大于本方案中的 Gateway/Doctor
Research。完整资产登记与首批退役证据见
`docs/implementation/azure-vm-retirement-scope-inventory-2026-08-05.zh-CN.md`，后续
必须另行编制逐组件迁移/替代/退役方案。

Azure 不作为迁移后的永久反向代理，但最终停止或删除必须晚于旧客户端清退、
Azure 发钥状态持续同步、全部共享服务处置和独立停机验收。迁移后 R760 公网 NAT、
本地线路、Nginx 和单机 Gateway 构成新的单点边界，必须建立对应监控和恢复流程；
CN1 不在正式请求链中。

MedEvidence/OpenEvidence 也计划迁往 R760，但不与本次 Gateway/Doctor Research
同时切流。先完成本方案并经过至少 24 小时或一个完整业务周期的稳定观察，再按
MedEvidence 专用迁移方案实施数据库、账号池、代理出口和入口切换。

## 2. 已确认的业务和网络边界

### 2.1 “仅境内”的精确定义

“仅境内”只约束 LLM 上游。百度千帆、腾讯和阿里的直接 `glm-5.2` 均符合这项
地域边界，但当前有效订阅只剩腾讯，因此现行运行策略进一步收窄为：

- 所有公共和内部 `glm-5.2` 服务只允许腾讯直连；
- 阿里和百度因订阅已暂时取消，不得进入 enabled pool，也不得作为 fallback；
- 禁止：OpenRouter、Codex/Max 及其他境外 LLM 路由；
- 不限制 Doctor Research 的证据和身份检索来源。

上述是现行目标策略，不是 Azure 八模型面已经完全达到的事实。2026-08-04 只读审计
确认 Azure 旧 registry 中的 Qianfan/Aliyun/OpenRouter GLM-5.2 路由仍为 enabled，
只是最近 7 天没有请求；`goldencode`、Research、CN1 和 R760 目标池才已腾讯单路。
在受控窗口移除旧模型前，必须把这一差异视为待关闭的策略门槛。

该限制也不约束图片生成上游。图片能力按独立的成本、权限、审计和故障转移策略
管理，不得因为保留图片能力而把 OpenRouter 或其他境外 LLM 成员重新加入
`goldencode`。

Doctor Research 可以继续访问经过现有安全适配器约束的 SerpAPI Google、
PubMed、Crossref、ORCID 和医院/机构官网。目标主机必须在切流前验证这些端点
的实际连通性、TLS、延迟和额度；不能因为目标位于境内而默认它们可用。

### 2.2 两套池必须隔离

```text
公网用户
  -> gateway
  -> 公共 goldencode 池
  -> 仅 Tencent glm-5.2

Doctor Research Worker
  -> research-llm-gateway
  -> Research 专用池
  -> 当前仅 Tencent glm-5.2
  -> 长期独立建设 Qianfan / Tencent / Aliyun
```

`research-worker` 不得调用公共 `gateway` 的 `goldencode` 池。公共池与
Research 专用池必须分别管理运行边界；经业务负责人 2026-08-04 明确确认，本次
不要求为两条路径隔离上游凭据，两套池可以引用同一个腾讯 provider key。
即便复用 key，仍须分别管理：

- 服务凭据；
- provider 配置和启用成员；
- 并发和速率；
- sticky 选择；
- cooldown 和健康状态；
- token reservation、用量和成本归属；
- 请求事件和故障诊断。

共享 provider key 意味着两套池共同消耗同一个上游账号的额度、速率和账单，腾讯
侧限流或 key 失效也可能同时影响公共和 Research 路径。该耦合风险已接受，但不能
进一步合并两套 Gateway、服务 bearer token、SQLite 状态或 Worker 路由。

内部服务可以继续把模型标识命名为 `goldencode`，但这只是内部逻辑名称，不能
与公共池共享运行状态或容量。

### 2.3 分阶段上游策略

当前迁移范围：

- 公共 `goldencode` 只启用 `goldencode-tencent`；
- Research 专用池也只启用直接腾讯 `glm-5.2`，保持三路合成所需的
  `maxConcurrent=3`；
- 阿里和百度成员不进入当前有效配置；
- 两条路径均不得配置 OpenRouter。

截至 2026-08-04，公网腾讯成员没有显式 `maxConcurrent`，Research 成员为 3。
这不能解释为共享账号总容量 6；必须取得腾讯账号侧额度/速率/并发证明，并按该证明
为公网池设置明确上限。

长期范围不纳入本周末切流：

- 为 Research 单独准备百度、腾讯和阿里三套凭据及容量；
- 在 `research-llm-gateway` 内启用 Research 专用三家池；
- 完成并发、sticky、故障转移、取消传播、token 账本和连续真实 E2E 验收；
- 不把 Worker 改指向公共池作为过渡方案。

### 2.4 公共模型面和图片能力

迁移后的公开能力边界如下：

- `GET /v1/models` 必须只返回 `goldencode`；
- 文本生成的唯一公共模型 ID 是 `goldencode`，当前后端只允许 Tencent 直连
  `glm-5.2`；
- 其他七个 Azure 文本模型 ID 必须返回 `model_not_found` 或等价拒绝，并在切流前
  完成消费者清单核对；
- 图片仍使用 `/gateway/images/generations`，客户端模型 ID 保持
  `medcode-image-default`，也可以省略该字段使用默认值；
- 目标低成本图片链为 OpenAI `gpt-image-1.5`、xAI
  `grok-imagine-image-quality` 和 Google `gemini-3.1-flash-image`；
- 不得在 R760 配置或调用 `gpt-image-2`；图片事件必须记录实际 provider、上游
  模型、请求状态和用量归属；
- 图片 key、fallback key file 和 prompt-hash secret 仍是私有配置，不得写入
  Git、文档或终端输出。

建议以 `gpt-image-1.5` 作为默认映射，以 xAI 和 Gemini 作为有序 fallback；最终
顺序只有在三条真实 smoke、费用策略和失败转移均通过后才能冻结。当前实现的额外
链是 billing-fallback 语义，不得在未验证代码路径前把它描述为任意错误都会跨
provider 自动切换。图片响应可能明显大于文本响应，因此 CN1 的出口带宽和
请求体/响应体限制必须单独验收。

## 3. 当前状态与目标状态

| 项目 | 当前状态 | 周末目标状态 |
| --- | --- | --- |
| 公网生产 | Azure 八模型 Gateway | 目标端仅公开 `goldencode` 和 Doctor Research API |
| CN1 | 单 Gateway、loopback-only；Nginx 已占用公网 80/443；尚无 `gw` 边缘 vhost | Nginx 承担 `gw:443` 边缘转发；原 loopback Gateway 保持隔离且不处理该流量 |
| Doctor Research | Azure 四容器 | 目标端四容器，职责保持不变 |
| 公共 GoldenCode | Azure `goldencode` 与 CN1 均已收窄为仅 Tencent；Azure 其他旧模型 ID 仍含 Codex/Qianfan/Aliyun/OpenRouter 路由 | R760 仅 Tencent `glm-5.2` |
| 其他公共文本模型 | Azure 另有七个模型 ID | 全部移除，客户端统一使用 `goldencode` |
| 图片生成 | Azure 提供，主路径曾使用 `gpt-image-2` 并有低成本 fallback | 保留 `medcode-image-default`；只允许 `gpt-image-1.5`、xAI 和 Gemini 低成本链 |
| Research LLM | Azure 独立内部 Gateway | R760 独立内部 Gateway，仅 Tencent `glm-5.2` |
| Research 检索 | SerpAPI/PubMed/Crossref/ORCID/官网 | 保持，但必须从目标端实测 |
| 公网边缘 | Azure Nginx/TLS | CN1 `gw:443` -> R760 `goldencode:1443`；消费者 URL 不变 |

## 4. Compose 和持久化边界

目标端必须从同一个已验证的 clean release 构建四个服务，并使用一个明确、独立
的 Compose project。目标已确定为 R760；不得覆盖 CN1 上现有的
`codex_gateway_cn1`，也不得让 CN1 的边缘 vhost 代理到其 `127.0.0.1:18787`。

R760 使用 Compose project `codex_gateway_r760`、发布根目录
`/opt/codex-gateway-r760` 和宿主机 loopback 端口
`127.0.0.1:18787`。正式四容器已经运行；此后任何 Compose 变更前仍须以
`docker compose config --quiet` 复核最终配置，并只重建获准的服务。

目标端至少需要以下六类持久化卷：

| 卷 | 内容 | 迁移要求 |
| --- | --- | --- |
| `gateway_state` | `gateway.db`、`client-events.db`、用户/凭据/entitlement 状态 | 一致快照、哈希和 SQLite integrity/FK 验证 |
| `gateway_logs` | Gateway 运行日志 | 可归档迁移；不是启动阻断项 |
| `research_production_state` | `research.db` 和已发布 artifacts | 必须一致迁移并逐文件校验 |
| `research_production_backups` | Research 已验证备份 | 至少迁移一个已验证回滚边界 |
| `research_production_llm_gateway_state` | 内部服务凭据、请求和 reservation 状态 | 必须迁移或按 Runbook 重新 bootstrap，不能混用公共状态 |
| `research_production_llm_gateway_logs` | 内部 LLM Gateway 日志 | 可归档迁移；保留切流前诊断证据 |

迁移 `gateway_state` 时要把其中可能存在的 Codex 登录文件视为敏感凭据。目标
运行时不需要 Codex/Max 路由，但不得通过随意删目录破坏数据库或回滚包。若后续
清理不用的 Codex 状态，应作为切流后的独立、可恢复任务。

## 5. 私有配置和凭据

不得把 env、API key、服务 token 或完整用户 key 写入本文、Git、终端记录或
验收截图。迁移清单只记录变量名、文件名、所有者、权限和哈希。

必须保留或重新建立：

- 公共和 Research 当前使用的 Tencent provider secret；
- 图片默认 provider key、低成本 fallback key file、模型映射和 prompt-hash
  secret；
- 稳定的 Gateway API-key encryption secret；
- 用户、plan、entitlement、billing/admin 所需的非公开配置；
- Doctor Research API/Worker/Maintenance env；
- Research 内部 LLM bearer token 和对应服务凭据；
- Worker-only web-search secret；
- NCBI/Crossref 联系信息、User-Agent 和 ORCID 策略；
- 备份目标加密确认和文件权限。

2026-08-04 已在不输出凭据的前提下补齐 R760 低成本图片变量和 fallback key
文件，并确认目标配置不包含 `gpt-image-2`。公共池和 Research 池均已改为仅腾讯；
架构上两条路径可以复用同一个腾讯 provider key，不要求凭据隔离。

同日只读审计期间，受保护的本地部署配置中一条腾讯 provider credential 曾显示在
操作终端输出中。该值没有写入 Git 或文档，但必须按已暴露处理：切流前确认所有引用
环境、完成轮换并分别做公网/Research Tencent-only smoke。轮换过程不得打印 env、
secret 或 Compose 渲染结果。共享上游账号的总并发、限流和额度仍须独立验收。

目标端私有文件应沿用生产 Runbook 的权限边界：env 为 `0600`，provider/service
secret 为容器运行用户可读的 `0400`。必须使用 `docker compose config --quiet`
验证，不能打印渲染后的环境。

## 6. 宿主机准入条件

在决定使用阿里云 VM 或本地服务器前，必须完成只读检查：

- CPU、内存、swap、磁盘、inode 和 Docker data-root 余量；
- 当前监听端口、Nginx server block、Docker/Compose 版本和 systemd 状态；
- 是否运行 MedEvidence 或其他重要业务；
- 到腾讯 LLM 以及 Research 检索端点的 DNS/TLS/HTTP 连通性；
- Docker 基础镜像可获得性。CN1 首次部署曾出现 Docker Hub 不稳定，必要时应
  使用在 Azure 验证并带哈希的离线镜像包；
- 备份目标是否与业务卷隔离并具备可验证的恢复路径；
- 是否有一个经确认未占用的 loopback 端口用于并行部署。

现有 Compose 限额合计约 3.5 vCPU 和 11 GiB 内存，不含宿主机、Nginx、Docker、
文件缓存和同机业务。专用主机至少应具备 4 vCPU/16 GiB；若与重要业务共享，
建议 8 vCPU/24 GiB 或更高，并以实测余量作为准入依据。未达到资源和磁盘门槛
时不得为了赶周末窗口强行切流。

### 6.1 R760 已完成的基础环境准备（截至 2026-08-04）

- Docker Engine `29.1.3`、Compose `2.40.3` 和 containerd `2.2.1` 已安装；
- Docker data-root 为 `/data/docker`，containerd root 为
  `/data/containerd`，不得回落到系统盘 `/var/lib/containerd`；
- NVIDIA Container Toolkit `1.19.1` 已配置，CUDA 12.8 容器可识别
  RTX 6000 Ada 48 GB；
- 已按 Azure 最新已部署 commit
  `4697fba0b74d2ea8aa0ace0699a6117397ad9b01` 安装 clean release 和四个
  逐 SHA-256 对齐的离线镜像；
- `/opt/codex-gateway-r760/shared/config` 为 `0750`，`shared/secrets` 为
  `0700`；正式 env、secret、最新状态和低成本图片配置已落位；
- 正式 Compose project `codex_gateway_r760` 的四个容器均为 healthy、零重启；
  只有 Gateway 发布 `127.0.0.1:18787`，其余三个服务不发布宿主机端口；现有
  Nginx、PostgreSQL、MedEvidence backend/gateway/worker 均保持 active，两个
  MedEvidence 本地 health 均返回 200；
- Docker Hub/NVIDIA Registry 从 R760 直连不稳定，周末继续采用带 SHA-256 的
  离线镜像包，不把现场拉取镜像作为关键路径；
- 已于 2026-08-01 完成受控重启，当前内核为 `5.15.0-186-generic`，无需再次
  重启以生效该内核。重启后 Nginx、Docker、containerd、PostgreSQL 和现有
  MedEvidence backend/gateway/worker 均恢复 active，本地 `8081/8082` health
  均返回 `200`；但 NVIDIA 内核模块未随新内核加载，`nvidia-smi` 当前不可用，
  在修复并复验驱动前不得把依赖 GPU 的工作负载纳入本次验收。
- 重启还暴露了管理网络未持久化问题：公网映射实际依赖 MAC
  `2c:16:db:aa:99:8d` 的 USB 千兆网卡，而原 Netplan 只管理两张未插线的
  Broadcom 10Gb 网卡。2026-08-03 已增加 root-only 的
  `/etc/netplan/90-r760-management.yaml`，按 MAC 固定
  `192.168.77.242/24`、默认网关 `192.168.77.1` 和已验证的 DNS；两张未插线
  的 10Gb 网卡标记为 optional，USB 管理网卡保持 required。全新 SSH、DNS、
  `systemd-networkd-wait-online`、公网 `:1443` SNI、Azure health 和现有
  MedEvidence health 均已通过；`wait-online` 探针为 `0` 秒完成。完整冷启动
  验收仍应放在独立维护窗口，并以 iDRAC/本地控制台作为最后兜底。
- `goldencode.instmarket.com.au` 的正式证书已通过 DNS-01 签发并安装到 R760，
  当前有效期至 2026-10-29；R760 Nginx 已具备独立 SNI server block，公网
  `:1443` 可完成证书校验并返回 Gateway health `200`；
- `goldencode.instmarket.com.au:1443` 只作为源站/预演入口，正式客户端 base URL
  仍为 `https://gw.instmarket.com.au`。

### 6.2 磁盘规划

R760 当前存储布局已经具备长期调整余量：

| 文件系统 | 当前布局 | 用途和约束 |
| --- | --- | --- |
| `/` | 100 GiB LVM，约 62 GiB 可用 | 只放 OS、软件和少量系统日志，不放镜像、业务状态或备份 |
| `ubuntu-vg` 未分配空间 | 约 790 GiB | 保留为根卷在线扩容或以后建立独立日志卷的储备，不预先全部分配 |
| `/data` | 独立约 1.8 TiB ext4，约 1.7 TiB 可用 | 容器层、Gateway/Research 状态、PostgreSQL、产物、迁移包和本机备份 |

固定目录边界：

- `/data/docker`：Docker data-root；
- `/data/containerd`：镜像 layer/content；
- `/data/codex-gateway-r760`：Gateway/Research 状态、迁移包和本机备份；
- `/data/postgresql/17/main`：现有 PostgreSQL 17.10 数据目录；不得为
  Gateway/Research 重复安装 PostgreSQL；
- Research 大文件、artifact、临时工作区和备份不得写入容器可写层或 `/tmp`。

根卷使用率达到 70% 时告警、85% 时停止新增部署；`/data` 使用率达到 70% 时
告警、85% 时停止新 Research 任务。Docker 日志继续执行单文件 `50m`、保留
5 个文件的轮转。`/data` 内备份只能用于快速回滚，数据库和关键状态还必须有
一份目标主机之外的校验副本。

### 6.3 2026-07-30 隔离预演结果

使用 commit `29790d2784913bfe14c71e8f72d51ae48748e5e7` 的四个现行镜像，
在独立 project `codex_gateway_r760_rehearsal` 和全新命名卷中完成了接近真实生产
的预演。预演未修改 Nginx、NAT、DNS、PostgreSQL 或现有 MedEvidence 服务；唯一
宿主机发布为 `127.0.0.1:18787`，结束后已执行 `compose down`，当前该端口无监听。

已通过：

- 四容器按内部 LLM Gateway、maintenance、Worker、公共 Research API 的顺序启动，
  全部 healthy、初次运行 0 次重启；
- 内部模型面只有 `goldencode`，真实调用只产生 Aliyun `glm-5.2` 成功事件；
- 公共模型面只有 `goldencode`，15/15 条真实请求成功，事件分布为 Aliyun 7、
  Tencent 6、Qianfan 2；
- maintenance 生成首个 Research SQLite 备份，Worker 发布 ready heartbeat；
- 四容器整栈重启后恢复为 4/4 healthy，失败和成功 run 状态均持久化；
- 第二次真实 Doctor Research E2E 在 217 秒完成，生成 3 个 Markdown 和 1 个
  五行 TXT，下载大小和 SHA-256 均与 manifest 一致；
- 所有临时公网/Research key 均已撤销，临时 entitlement 已取消，临时用户已
  disabled；现有 MedEvidence `8081/8082` 和公网 `:1443/health` 仍返回 200。

预演发现：

1. R760 原先没有宿主机 Node.js，现已从相同镜像安装固定 Node `v24.18.0` 到
   `/opt/codex-gateway-r760/tools/node-v24.18.0`，并建立运维 fallback 路径；
2. 运行镜像不包含 plan policy 示例。新库 bootstrap 必须用一次性 admin 容器把
   release 的 `config/` 只读挂载进去，不能直接假定常驻容器内存在这些 JSON；
3. `research-beta-smoke.mjs` 要求 token 和 request 文件均为规范路径、普通文件且
   权限不宽于 `0600`；仓库中的 `0644` 示例必须先复制到受限临时文件；
4. 第一次同输入 E2E 在 138 秒以 `model_contract_error` 失败。三次 Aliyun 请求
   均成功，但两个并行分片同时违反 `review_abstract_length_contract` 和
   `body_topic_section_minimum`，当前单分片定向修复没有覆盖该组合；同输入第二次
   成功。因此基础设施可用，但应用成功率不能按 1/1 计算；
5. `/data` 是普通 ext4。2026-07-31 经操作人明确决定，R760 本次不建设 LUKS
   或其他磁盘级加密；该决定不再作为导入和 loopback 部署的 no-go 条件。接受的
   剩余风险是本地业务卷和 Research 小时备份不具备磁盘离线加密。补偿措施为：
   宿主机物理和 root 访问控制、env `0600`、secret `999:999/0400`、迁移包
   AES-256 加密、Azure 保留异机加密副本，以及切流前后的哈希和恢复校验。
   `RESEARCH_BACKUP_TARGET_ENCRYPTION_CONFIRMED=true` 在 R760 上仅表示操作人已
   接受这项明确记录的例外，不表示 `/data` 已经加密；
6. Compose 明确提示本地 secret 的声明式 uid/gid/mode 不会自动生效；必须继续
   依赖宿主机 `999:999`、`0400` 元数据并在每次发布前 `stat` 验证。

### 6.4 2026-07-31 正式配置和初步迁移包

- 正式目录的五个 env 和五个 secret 已通过 shared 目录落位；env 为
  `root:root/0600`，provider/service secret 为 `999:999/0400`；
- 正式 Compose `config --quiet` 已通过，四个启用开关仍为 `false`；
- 该 2026-07-31 初始配置的公共模型面成员为 Qianfan/Tencent/Aliyun，Research
  仅启用 Aliyun，且尚无图片配置；这项旧配置已经被 6.5 记录的 2026-08-04
  Tencent-only 正式配置和低成本图片配置取代，不得用于当前启动；
- 已在 Azure 静止门槛下生成初步一致性快照：活动 Research run、公共和内部 LLM
  未结算 reservation 均为 0，四个 SQLite 快照的 integrity/FK 均通过；
- 加密迁移包 SHA-256 为
  `9e282d91211c64610250ff8c2df6f4d861bc9a17ed8eefc3748eaf4dcc56d095`；
  Azure 保留异机副本，R760 副本已通过相同哈希、流式解密和 tar 完整性校验；
- 已创建带正确 Compose project/volume 标签的六个正式命名卷并离线恢复初步
  快照；四个目标数据库的恢复后哈希、integrity/FK 均通过，328 个 Research
  artifact 和已验证备份边界逐文件哈希通过；正式容器数仍为 0，`18787` 未监听；
- 该包是历史初步快照，不替代 6.5 已完成的最新在线快照恢复，也不替代切流前的
  最终写入冻结和增量核对。

### 6.5 2026-08-04 正式 loopback 部署结果

- 正式部署基线 release 为
  `/opt/codex-gateway-r760/releases/4697fba0b74d2ea8aa0ace0699a6117397ad9b01`，
  当时四个镜像 ID 与 Azure 当前四容器逐一一致。旧 release、旧镜像标签和
  `/data/codex-gateway-r760/backups/pre-4697fba-20260804T0145Z`
  继续作为本次部署的本机回滚边界。
- 2026-08-04 图片归因补丁发布后，`current` 已指向
  `/opt/codex-gateway-r760/releases/43e118eb00083ee44164329568a62941169ee78c`，
  `previous` 指向上述 `4697fba` 基线；仅 public Gateway 被重建，三个 Research
  容器 ID 未变化。当前 Gateway 镜像为
  `sha256:11edd786e8b06f2b7ddc600d829503e3368bf971fd44f15618b76f34afed17f0`。
  因 R760 无可用基础镜像缓存且 Docker Hub 不稳定，本次采用已验证旧 Gateway
  镜像叠加本地完整 build/test 后的 Gateway/core `dist`，并以 `--network=none`
  生成不可变候选镜像；这不是以后常规发布中完整 Dockerfile 重建的替代品。
- 从运行中的 Azure 通过 SQLite 在线快照取得最终空闲窗口，恢复公共 Gateway、
  Research、内部 LLM Gateway、artifacts、已验证备份和图片 fallback key 文件。
  四个数据库均为 `integrity=ok`、外键违规 0，恢复时 active run 和 unfinished
  reservation 均为 0，artifact 大小和 SHA-256 全部一致。
- 公共 `/v1/models` 只返回 `goldencode`，pool 只有
  `goldencode-tencent / tencent / glm-5.2`；Qianfan、Aliyun 和 OpenRouter 均不在
  enabled 配置中。真实公共文本 smoke 返回 200，事件只落到腾讯。
- Research 内部 pool 与公共 pool 保持不同 Gateway/SQLite/服务 bearer 边界，
  但当前也只包含 `goldencode-tencent / tencent / glm-5.2`，并保留
  `maxConcurrent=3`。Worker 为 `doctor-research-skill.1.6.104`，ready heartbeat
  和 maintenance 备份 `drb_d206cec62645458db6f1e2a750dbc1e6` 均成功。
- 三个真实 Research 任务均在一次 lease 内达到 `succeeded`，每个任务生成 4 个
  artifact；其中两次完整客户端 E2E 分别在 179 秒和 183 秒完成并逐文件验证大小
  和 SHA-256。中间一次服务端同样成功并生成 4 个 artifact，但最初的临时 smoke
  key 只有 `rpm=4`，因此客户端下载阶段收到一次 429；把测试 key 调整为
  `rpm=120` 后完整链通过。三轮共 15 次业务 LLM 调用全部是 Tencent
  `glm-5.2`，无 Aliyun、Qianfan 或 OpenRouter 尝试。
- 三个 E2E key 均已 revoked，entitlement 均已 cancelled，临时用户均 disabled；
  无临时目录、active run 或 unfinished reservation 残留。四容器、R760 Nginx、
  公网源站 `:1443`、MedEvidence `8081/8082` 均通过回归。
- 已把 CN1 当前 Mihomo `v1.19.23` 二进制、32 个内嵌节点的当前配置、选择缓存和
  GeoIP 数据通过双 SSH 加密中继复制到 R760；源配置没有在线 `proxy-provider`
  依赖，CN1 `/run` 中的敏感临时快照在目标哈希验收后已删除。R760 以独立基础设施
  容器运行 Mihomo，只加入 `codex_gateway_r760_default` 私网，不发布宿主机端口；
  容器使用只读根文件系统、`cap_drop=ALL`、`no-new-privileges` 和自动重启。该容器
  不改变 Doctor Research 的四业务容器边界。
- 只有 public Gateway 配置 `HTTP_PROXY`/`HTTPS_PROXY=http://mihomo:7890`；Research
  LLM Gateway、Worker 和 maintenance 均无代理变量。`NO_PROXY` 精确覆盖腾讯、
  境内/内部服务和 loopback。停用 Mihomo 的故障注入期间，真实 `goldencode`
  请求仍成功落到 `goldencode-tencent / tencent / glm-5.2`，证明 LLM 未绕境外代理。
- 公共 `medcode-image-default -> gpt-image-1.5` 已真实生成 48,148 字节 JPEG，xAI
  `grok-imagine-image-quality` 的 provider 级 smoke 已真实生成 54,381 字节 JPEG；
  有效模型映射和真实事件中仍不存在 `gpt-image-2`。Gemini 尚未通过：Google 返回
  `FAILED_PRECONDITION / User location is not supported for the API use`，对复制节点中
  21 个当前 alive 候选逐一做 OpenAI/xAI/Gemini 目录探针后结果相同。临时
  loopback controller 已删除，config/cache 已在生产重启前按探测前哈希恢复；后续 cache/GeoIP
  属于可变运行态，持续完整性校验只覆盖静态二进制和 R760 派生配置。必须增加一个
  Google 支持地区的专用节点并完成 Gemini 实图。图片事件的实际 provider/upstream model
  归因已随 `43e118e` 部署：真实图片事件
  `req-72502774-9ad4-4b49-a797-ef50c43c289e` 为
  `openai-api / medcode-image-default / gpt-image-1.5 / ok`，配对文本事件为
  `tencent / goldencode / glm-5.2 / ok`。临时 key、entitlement、用户和 reservation
  均已清理。OpenAI 路径的归因门槛已关闭；低成本图片三模型总门槛仍受 Gemini
  出口地区阻塞，不得改用 OpenEvidence 住宅代理。
- 本次部署没有修改 CN1 Nginx、DNS 或公网 `gw`；公网
  `gw.instmarket.com.au` 仍解析到 Azure。

### 6.6 CN1 边缘入口准备状态和实测

2026-08-03 已完成只读基线和 CN1 到 R760 源站的连通性测量，尚未修改 CN1
Nginx、证书或 DNS：

- CN1 Nginx 已 active/enabled 并监听公网 `80/443`，现有配置测试通过；Certbot
  和续期 timer 已存在；
- CN1 根文件系统约 99 GiB、尚有约 80 GiB 可用，14 GiB 内存中约 13 GiB
  available，当前负载很低，作为 Nginx 边缘代理有足够余量；
- 现有 `codex_gateway_cn1-gateway-1` 仍健康并只绑定
  `127.0.0.1:18787`；它与新的 `gw` 边缘 vhost 必须保持隔离；
- CN1 通过 R760 公网 NAT 访问
  `https://goldencode.instmarket.com.au:1443` 时，SNI 和证书校验通过；正式 Gateway
  未启动，因此源站返回预期 `502`。本次测量使用显式地址解析；截至该次检查，
  `goldencode` 尚无可供普通解析使用的公开 A 记录；
- 30 次全新 HTTPS 连接采样中，TCP p50/p95 为 `10.09/10.89 ms`，TCP+TLS
  p50/p95 为 `26.22/26.89 ms`，收到源站即时响应的总耗时 p50/p95 为
  `43.81/45.54 ms`；这是冷连接网络/TLS 数据，不是应用处理时长；
- 启用 upstream keepalive 和 TLS session reuse 后，稳态额外开销预计主要是一轮
  约 10 ms 的 CN1-R760 往返。对秒级/分钟级 LLM 和异步 Research 请求通常可忽略，
  但健康检查、图片大响应和 artifact 下载仍须实测；
- 公网 ICMP 不响应，不能以 ping 作为 no-go；正式健康检查必须使用 HTTPS。

2026-08-04 经明确授权完成了 CN1 边缘安装和不切 DNS 暗测：

- 已备份原 Nginx 配置到
  `/opt/codex-gateway-cn1/backups/pre-gw-edge-20260804T182835+1000`；
- 已安装 Cloudflare DNS 插件，以权限受限 Token 完成 Let's Encrypt staging、正式
  ECDSA 证书签发和 `certbot renew --dry-run`；凭据仅保存在 root-owned `0600`
  文件，续期 timer 和校验后 reload hook 正常；
- 已启用仅匹配 `gw.instmarket.com.au` 的非默认 vhost，上游固定为
  `117.186.49.26:1443`，并强制验证
  `goldencode.instmarket.com.au` SNI/证书；CN1 本机 loopback Gateway 未进入路径；
- 从另一台阿里云主机强制解析到 CN1 的全链暗测通过 health、credential self-check、
  仅 `goldencode` 模型面、非流式、SSE、客户端断开恢复、Research 结果与 artifact
  大小/SHA-256，以及低质量 `medcode-image-default` 实图；
- 但悉尼公网探针在 HTTP 收到 Aliyun `Server: Beaver / Non-compliance ICP Filing`
  403，HTTPS 在到达 Nginx 前被重置；Azure 到 CN1 的 HTTPS 也被重置。该公网入口/
  备案阻断是新的硬性 no-go，必须解决并从独立公网客户端复测后才能切 DNS；
- `gw.instmarket.com.au` 仍解析到 Azure `4.242.58.89`，本轮没有切流。

随后因 CN1 公网备案阻断无法在当前条件下消除，正式入口决策改为客户端显式改址：

- 已创建 DNS-only `A` 记录
  `goldencode.instmarket.com.au -> 117.186.49.26`，悉尼、CN1、Azure 和权威 DNS
  解析均一致；公网 `:1443` TLS/health 返回 200；
- 外部 `117.186.49.26:1443` 由路由器映射到 R760 `192.168.77.242:443`，R760
  Nginx 再转发到 `127.0.0.1:18787`；
- R760 `GATEWAY_PUBLIC_BASE_URL` 已切换到
  `https://goldencode.instmarket.com.au:1443`。完整 base、Research overlay、R760
  override Compose 校验通过后仅重建了 `gateway`，三个 Research 容器 ID 未变，四个
  服务均 healthy、零重启；
- 受限明文备份和 SHA-256 清单位于
  `/data/codex-gateway-r760/backups/pre-public-base-url-20260804T103816Z`；
- 真实 `cgu_live` resolve 返回新的 `/v1` 地址；credential validation、仅
  `goldencode` 模型面、Tencent GLM-5.2 chat、Research 鉴权列表和低质量
  `medcode-image-default` JPEG 均从普通公网直连验证成功；
- CN1 vhost 保留为暗配置/审计记录，不再作为当前切流路径。

CN1 边缘 vhost 的硬性配置边界：

以下边界只描述已经安装的暗路由；除非未来先解决 Aliyun 公网入口问题并重新批准，
不得据此把 `gw` DNS 切到 CN1。

- 只匹配 `gw.instmarket.com.au`，不得成为默认 vhost，也不得覆盖现有站点；
- CN1 终止 `gw` 证书，向 R760 继续使用 HTTPS；必须启用
  `proxy_ssl_server_name` 并把源站 SNI/校验名固定为
  `goldencode.instmarket.com.au`；
- 启用 HTTP/1.1 upstream keepalive 和 TLS session reuse，不做响应缓存；
- SSE/长请求必须关闭请求和响应缓冲，设置覆盖 Gateway/Doctor Research 上限的
  read/send timeout，并验证客户端取消可以传递到 R760；
- 保留并规范 `X-Forwarded-For`、`X-Forwarded-Proto`、`Host` 和
  `X-Request-Id`；R760 应以 `GATEWAY_PUBLIC_BASE_URL` 生成 `gw` 公网地址；
- DNS 切流时 `gw` 应直接解析到 CN1，避免额外启用具有固定长请求超时的 CDN
  代理；CN1 upstream 必须在“固定 R760 NAT 地址 + 显式 SNI”或“新增 DNS-only
  `goldencode` 源站记录”之间明确选择，不能依赖当前不存在的普通解析；切流后
  再把 R760 `:1443` 限制为仅 CN1 和批准的运维来源可达；
- CN1 是迁移后的公网单点。必须监控 CN1 Nginx、证书到期、CN1-R760 HTTPS、
  R760 Gateway health、带宽和错误率，并保留配置级恢复手册。

### 6.7 旧模型消费者与腾讯容量审计

2026-08-04 只读审计覆盖 Azure 公网与独立 Research LLM Gateway 最近 30 天事件。
结论为当前 no-go：

- 七个非 `goldencode` 模型仍有 7,406 次请求和 507,102,322 观测/估算 token；
- 最近 24 小时仍有 5 名 active 消费者使用 `max`/`pro`，最近 7 天有 9 名；
- Azure 旧 registry 的 Qianfan/Aliyun/OpenRouter GLM-5.2 路由仍为 enabled，当前
  Azure 整体尚未满足腾讯单路策略；
- 腾讯公网与 Research 合计 998 次请求、56,555,349 观测/估算 token，历史重叠
  并发峰值为 3；
- 腾讯单路切换后的公网样本已成功，但该时段 Research 为零请求，不能证明两条路径
  同时加压时的共享账号容量；
- 公网池无显式 `maxConcurrent`，且供应商账号侧最大并发、RPM、TPM、额度、余额和
  有效期尚未取得证据。

详细方法、消费者清单和关闭条件见
`docs/operations/goldencode-cutover-audit-2026-08-04.zh-CN.md`。在旧模型连续 24 小时
零使用、腾讯账号容量证明与 R760 双路径并发验证、provider credential 轮换完成前，
不得删除旧模型或切换公网 DNS。

## 7. 原定 2026-07-30 至 2026-08-02 计划与下一窗口

日期按澳大利亚悉尼时间记录；中国境内主机时间早 2 小时。本周末日期在两地均为
8 月 1 日和 8 月 2 日。

截至 2026-08-04，准备、正式状态同步、R760 SNI/TLS、网络持久化、正式四容器
loopback 部署以及 CN1 `gw` vhost/证书暗测已完成，但旧模型消费者迁移、腾讯账号
容量证明、provider credential 轮换、CN1 公网备案/入口阻断、正式 DNS 和切流均未
关闭。因此 8 月 1/2 日是原定窗口记录，
不得补记为已完成；剩余门槛、最终冻结同步、图片出口和切流步骤应移到下一次批准的
维护窗口，并在执行前重新生成时间戳和检查清单。

### 周四 7 月 30 日：范围冻结

1. 合入本文和相关文档修订。
2. 目标主机已确认使用本地 R760，不再以 CN1 作为本次目标。
3. 确认目标主机管理员、DNS/TLS 操作人和周末切流授权人。
4. 原短期池策略后于 2026-08-04 修订为：所有 GLM-5.2 路径仅腾讯。
5. 记录当前 Azure release、四容器镜像、数据库和备份边界。
6. 确认现有 CN1 单容器不被计划态误操作。

### 周五 7 月 31 日：预检和发布包准备

1. 复核已完成的 R760 资源、磁盘、端口、服务和运行时预检记录。
2. 使用已确定的 Compose project、发布根目录和 loopback 端口。
3. 复核已暂存的同一 clean release 四个镜像、离线包和 SHA-256。
4. 准备不入库的 env/secret 文件并核对权限。
5. 从目标端验证腾讯 LLM、SerpAPI、PubMed、Crossref、ORCID/官网访问。
6. 生成并验证 Azure 最新在线数据库/Artifact 备份；保留切流前再次同步能力。
7. 如需 DNS 切换，提前降低 TTL；没有 DNS 权限或回退能力则判定 no-go。

### 周六 8 月 1 日：目标端部署和不切流验证

1. 在独立项目和 loopback 端口启动四容器，不改公网 DNS。
2. 按顺序启动内部 LLM Gateway、maintenance、Worker，最后启用公共 Gateway
   的 Research API。
3. 导入一致状态快照；验证数据库哈希、SQLite integrity/FK 和 Artifact manifest。
4. 确认四容器 healthy、零意外重启，且仅 `gateway` 发布 loopback 端口。
5. 验证公共 `/v1/models` 只返回 `goldencode`。
6. 验证公共真实请求只产生 Tencent `glm-5.2` 成功事件。
7. 验证内部 `/v1/models` 只返回 `goldencode`，Research 请求事件全部落到
   `goldencode-tencent`，没有公共池、Aliyun、Qianfan 或 OpenRouter 调用。
8. 启用并验证独立图片路由：客户端只使用 `medcode-image-default`，分别证明
   `gpt-image-1.5`、`grok-imagine-image-quality` 和
   `gemini-3.1-flash-image` 的成功或受控 fallback，且零 `gpt-image-2` 事件。
9. 鉴于 7 月 30 日预演出现 1 次多分片契约失败，必须完成至少连续两次真实
   Doctor Research E2E 成功：每次均恰好 3 个 Markdown + 1 个五行 TXT，manifest、
   大小和 SHA-256 全部一致；任一次 `model_contract_error` 都重新计数并进入评审。
10. 在不改正式 DNS 的前提下安装 CN1 独立 `gw` vhost/证书，通过本地解析完成
    CN1 -> R760 的 health、SSE、非流式、图片和 artifact smoke；不得代理到 CN1
    本机 loopback Gateway。
11. 执行目标端备份和网络隔离恢复验证。
12. 清理所有临时 key、用户、entitlement、reservation 和测试文件。

周六任何硬门槛失败，周日不得切流；Azure 继续提供生产服务。

### 周日 8 月 2 日：最终同步、切流和观察

1. 确认 Azure、目标端和回滚责任人均在线。
2. 阻止产生分叉写入：进入批准的短维护窗口或采用明确的写入冻结方案。
3. 对 Gateway 数据库、Research 数据库和 artifacts 做最终一致同步并复验。
4. 先通过本地 hosts、受限临时入口或目标 Nginx loopback 完成最后 smoke。
5. 切换 `gw.instmarket.com.au` DNS 到 CN1，并由 CN1 专用 SNI vhost 转发到
   `https://goldencode.instmarket.com.au:1443`；不得同时接受两端独立写入。
   消费者继续使用 `https://gw.instmarket.com.au`，不增加显式端口，也不复用
   `r760.instmarket.com.au` 的 MedEvidence server block。
6. 验证公网 health、凭据自检、`/v1/models`、Tencent-only GoldenCode、Doctor
   Research 创建/轮询/结果/四文件下载和取消路径，以及低成本图片生成/fallback。
7. 连续观察容器 restart/OOM、内存/磁盘/PID、错误率、首字节/总时长、Tencent
   公共和 Research token 使用、CN1-R760 延迟和图片流量带宽。
8. 在周日结束前作出“继续运行目标端”或“回切 Azure”的明确决定。

## 8. 验收门槛

只有全部满足时才算完成搬迁：

- 四个容器 healthy，零非预期重启；
- 只有 `gateway` 通过 loopback 接入公网 Nginx；
- 公共模型面只有 `goldencode`；
- 其他七个 Azure 文本模型均不可用，所有已知消费者已改用 `goldencode`；
- 公共和 Research 的 GLM-5.2 事件均只落到 Tencent，无 Aliyun、Qianfan 或
  OpenRouter 事件；
- `/gateway/images/generations` 继续接受 `medcode-image-default`，低成本三模型链
  通过，且请求事件中没有 `gpt-image-2`；
- Worker 只调用内部 `research-llm-gateway`；
- Research 专用池只产生 Tencent GLM-5.2 事件；
- SerpAPI/PubMed/Crossref 及必要官网检索成功；
- 至少连续两次真实 Doctor Research 均生成恰好四个校验一致的文件；
- 所有仍有效的 Azure 历史及后续发放 key、用户状态、plan 和 entitlement 已同步
  到 R760；API-key 双端自检通过；
- 数据库和 artifacts 一致，备份及隔离恢复通过；
- 无 active run、unfinished reservation、临时 key 或测试文件残留；
- `gw:443 -> CN1 -> goldencode:1443 -> R760` 两段 TLS、SSE、长请求、取消、图片和
  artifact 下载均已实测；客户端 URL 保持不变；
- 从阿里云体系外的独立公网客户端访问 CN1 `gw:443`，不得再出现
  `Non-compliance ICP Filing`、TLS reset 或其他到达 Nginx 前的入口拦截；
- CN1 和 R760 的证书续期、双层健康检查、日志关联、带宽告警和回切路径均已实测。

## 9. 回滚触发和步骤

出现以下任一情况立即停止切流或回切 Azure：

- 数据库/Artifact 哈希、integrity 或 FK 失败；
- 现有用户 key 或 entitlement 无法验证；
- 四容器健康、Worker heartbeat 或 maintenance backup 不稳定；
- 公共和 Research 任一路径出现非 Tencent GLM-5.2 事件；
- 目标公开了 `goldencode` 之外的文本模型，或任何图片请求调用 `gpt-image-2`；
- Research 请求进入公共池，或 Research 不再保持 Tencent-only；
- Doctor Research 无法在硬截止内完成严格四文件验收；
- DNS/TLS、外部检索、磁盘或内存不满足门槛；
- 无法证明两端没有分叉写入。

回滚时：

1. 停止目标端接收新写入，但保留容器、卷和日志用于取证；
2. 将 `gw` DNS 路由恢复到 Azure，并停用 CN1 新增边缘 vhost 的流量入口；
3. 验证 Azure public health、八模型面和 Doctor Research；
4. 记录目标端已接收的请求和数据边界，禁止盲目反向覆盖 Azure；
5. 在独立复盘后决定重试，不因周末期限删除任何卷或回滚镜像。

该 Azure 回切只适用于切流后的临时观察期。Azure 正式下线后不得再把它作为
永久边缘代理或默认回滚；届时 CN1 故障需要通过修复 CN1、启用预先建设的第二
边缘入口，或执行另一个明确批准的灾备方案恢复。

## 10. 本周末明确不做

- 不建设 Research 专用三家池；
- 不让 Worker 临时复用公共 `goldencode`；
- 不迁入 OpenRouter、Codex/Max、Azure 其余七个文本模型或 `gpt-image-2`；
- 不移除图片生成；图片只迁移已确认的低成本三模型链；
- 不在未完成只读端口检查时覆盖现有 CN1 Compose project；
- 不删除 Azure 生产、旧 CN1 数据卷或已验证回滚边界；
- 不在迁移同时进行无关数据库 schema、业务契约或医学 Skill 改造。
- 不在同一个维护窗口切换 MedEvidence/OpenEvidence；其本地 PostgreSQL、账号池、
  代理出口和客户端入口按第二阶段单独验收。

## 11. 实施前待确认项

以下项目用于关闭分批客户端迁移和最终 Azure 下线；已完成项保留为验收记录：

1. **已完成并改为历史暗路由**：CN1 `gw.instmarket.com.au` 证书、独立 SNI
   vhost、upstream keepalive、长请求超时、SSE/取消和证书续期验证；Aliyun
   `Non-compliance ICP Filing`/境外 TLS reset 使该路径不再承担本次切流；
2. **已完成**：DNS-only `goldencode` A 记录、独立公网多网络解析/TLS/health、真实
   resolver/chat/Research list/低成本图片验证；
3. **已完成**：R760
   `GATEWAY_PUBLIC_BASE_URL=https://goldencode.instmarket.com.au:1443` 生效，完整
   Compose 校验和 Gateway-only recreate 通过；
4. 所有消费者必须同时改为
   `base_url=https://goldencode.instmarket.com.au:1443/v1` 和
   `model=goldencode`，逐一确认其网络允许外连 `1443`；至少完成一个零旧模型用量
   观察窗口后，再移除/禁用 Azure 旧 registry 的其他七个文本模型及非腾讯 LLM
   路由；
5. 确认公共和 Research 使用的腾讯账号总额度、RPM、TPM 和并发能够覆盖两条路径，
   为公网池设置明确 `maxConcurrent`，并完成 R760 两条路径同时加压验证；
6. 架构上不要求凭据隔离；但 2026-08-04 终端暴露事件要求在切流前轮换腾讯
   provider credential，核对所有引用环境并完成公网/Research smoke；
7. R760 私有 Mihomo、Gateway-only 代理、Tencent 精确 `NO_PROXY`、零宿主机端口、
   自动重启、OpenAI 实图和 xAI 实图已经验证；图片事件实际 provider 与 upstream
   model 的修复已部署并通过真实 OpenAI 事件验证。继续补充一个 Google 支持地区的
   节点并完成 Gemini 实图；完成前低成本图片三模型门槛仍为 no-go；
8. 最终数据同步期间采用何种写入冻结方式；
9. 迁移后的备份是否有目标主机之外的副本；
10. R760 公网 NAT/线路、单层证书续期、端到端 health、带宽和日志关联的监控负责人；
11. 多分片同时违反输出契约时，是在下一窗口前补充有界修复，还是将任何复现视为
   no-go；未作决定前不得把单次成功当作稳定性通过。
12. **发钥主链已完成，周期调度待完成**：正式发钥继续以 Azure 为权威；
    `scripts/sync-azure-r760-gateway-state.py` 已实现保留 R760 独有数据的逐行幂等
    同步、写前一致性备份、schema/secret/FK/完整性门槛和二次零差异对账。历史
    Azure-only 统一 key 已补齐，Azure 的 90 条统一 key 已全部包含在 R760 中；正式
    发钥脚本现在强制同步并以同一 key 做 Azure/R760 双端 resolve/credential/
    entitlement/image 验证，失败不写交付文件。仍需安装周期性无人值守只读对账，
    在此之前每次用户启停、撤销/轮换或 plan/entitlement 变更后必须手工 apply。
    文档不得记录完整 key 或用户隐私。

## 12. 相关文档

- `docs/operations/system-status.md`
- `docs/operations/cn1-goldencode-gateway.md`
- `docs/operations/r760-mihomo-image-egress.md`
- `docs/operations/goldencode-cutover-audit-2026-08-04.zh-CN.md`
- `docs/implementation/azure-vm-retirement-scope-inventory-2026-08-05.zh-CN.md`
- `docs/research/doctor-research/README.md`
- `docs/research/doctor-research/production-runbook.md`
- `docs/operations/environment-access.md`
- `compose.azure.yml`
- `compose.research-production.yml`
- `config/research.production.goldencode.example.json`
