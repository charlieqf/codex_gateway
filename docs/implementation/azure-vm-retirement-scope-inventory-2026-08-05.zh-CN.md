# Azure VM 退役前服务与组件范围登记

| 项目 | 内容 |
| --- | --- |
| 状态 | 范围已登记；MedEvidence US + PostgreSQL 16 与 TokenBridge/NewAPI 已完成可逆停用并标记退役；Desktop 权威更新源已迁移到 Cloudflare R2，Azure 只保留回滚副本；其余组件的详细搬迁/退役方案待单独设计 |
| 登记日期 | 2026-08-05 |
| 当前主机角色 | GoldenCode 旧客户端兼容入口，以及多项 MedEvidence/配套服务的共享生产主机；不再是 Gateway 控制或用量权威源 |
| 目标 | 在未来设计 Azure VM 全量退役方案时，逐项决定迁移、替代、归档或明确退役，避免只搬 Codex Gateway 后误删仍在使用的组件 |

## 1. 当前结论

Azure VM 不能在近期仅因 R760 Gateway 已可用而直接下线或删除。仍有较多用户使用
旧客户端、旧模型和 `https://gw.instmarket.com.au`；同时，这台 VM 还承载多项不属于
R760 四容器 Gateway/Doctor Research 边界的服务。

2026-08-05 已先行退役两组确认无近期业务使用的独立组件：MedEvidence US（含 public/
internal web、两类 Worker 和本机 PostgreSQL 16）以及 TokenBridge/NewAPI。两组均只做
可逆停用和防误启动标记，数据、配置、容器、证书和回滚备份尚未删除；这不改变 Azure
Gateway、Doctor Research、Answer Generator、PubMed Evidence Set 和其他辅助路由仍需
继续运行和另行处置的结论。

截至 2026-08-06，`updates.instmarket.com.au` 的权威 Desktop 更新源已迁移到 Cloudflare R2
bucket `goldencode-updates`，公网 URL 保持不变。Azure 的 Nginx 配置与 `/var/www` 静态
文件只保留为临时回滚副本，不再用于发布或判断发布成功。Azure 退役不再需要再次搬迁
Desktop feed，但仍需归档或明确删除回滚副本，并证明 R2 凭据、bucket、自定义域名、
历史回滚对象和恢复手册不依赖 Azure 主机。

自 2026-08-06 起，正式用户发钥、用户启停、key 状态、Plan/entitlement 和用量查询
以 R760 为权威。Azure 的 `https://gw.instmarket.com.au` 只保留旧客户端兼容流量。
迁移期必须满足以下硬约束：

- 所有仍有效、未过期且未撤销的 Azure 历史 key 均可在 R760 使用；
- 以后通过正式脚本在 R760 创建的 key，必须在交付用户前镜像并验证到 Azure；
- 用户启停、key 撤销/更新、plan 和 entitlement 变更只在 R760 发起，并沿
  `R760 -> Azure` 镜像；禁止直接写 Azure；
- 2026-08-05 新增的两个 Azure key 已完成一次受控、逐行、单事务同步，并已用相同
  交付 key 在 Azure/R760 公网入口完成 resolve、credential、entitlement、模型面和
  生图能力验证。R760 写前备份保存在目标主机；本文不记录用户、手机号、key prefix
  或完整 key；
- 同日已实现并首次执行自动逐行对账。工具补入 9 条依赖记录，Azure 的 90 条统一
  key 现已全部包含在 R760 的 90 条统一 key 中；R760 独有的 7 组预演
  subject/credential/entitlement 记录被保留，第二次只读运行报告零差异；
- 正式发钥脚本现在固定执行“R760 创建 -> Azure 兼容镜像 -> 同一 key 双端公网
  验证 -> 写入 R760 地址 handoff”，任一步失败都不交付；
- Azure 旧入口产生的 request event、已结算 token reservation 和审计记录按不可变
  主键去重归并到 R760。因 Azure 很快退役，不建设周期调度；权威报表前及 Azure
  最终停写后必须手工归并。

本文件只登记退役范围和依赖，不提前决定每项服务必须原样搬到 R760。后续方案应对
每项分别作出“迁移到 R760 / 使用其他长期托管 / 归档后退役 / 确认废弃”的明确决定。

## 2. Azure VM 当前服务范围

以下状态先来自 2026-08-05 的只读主机盘点，随后按业务负责人指令执行了两组可逆
退役。表内明确区分“仍运行”“已停止观察”和“尚待迁移/决策”。

| 服务或组件 | 当前运行边界 | 关键状态/依赖 | 后续必须决定 |
| --- | --- | --- | --- |
| Codex Gateway 正式生产 | Docker Compose project `codex_gateway_test`；公网 Nginx `gw.instmarket.com.au:443` -> `127.0.0.1:18787` | 旧客户端、旧入口和八模型兼容面仍有真实用户；Gateway SQLite 保存用户、凭据、统一 key、plan、entitlement、用量和客户端事件 | 保持兼容多久；何时缩成代理或切走；最终状态、用量和审计如何同步/归档 |
| Doctor Research 正式生产 | 同一 project 内的 `gateway`、`research-llm-gateway`、`research-worker`、`research-maintenance` 四容器及独立持久卷 | R760 已部署对应四容器，但 Azure 与 R760 现已分别产生运行写入 | 最终增量核对、artifact/数据库归并、停写和回滚边界 |
| Doctor Research staging | Docker Compose project `codex-gateway-research-staging`，含 staging Gateway、Worker、maintenance 和独立状态/备份/日志卷 | 不属于正式四容器数据卷；删除 VM 会同时删除 staging 能力和历史验证边界 | 在 R760 重建隔离 staging，或归档后明确退役 |
| MedEvidence US 服务 | 已停止：`medevidence-v2.service`、`medevidence-v2-worker.service`、`medevidence-v2-internal.service`、`medevidence-v2-internal-worker.service`；本机 PostgreSQL 16 `main` cluster | 退役前主库 `requests=0`、`jobs=0`，最近 30 天请求/任务/事件均为 0，最后运行事件为 2026-05-25。四个应用 unit 已 `disabled` 并以 `RefuseManualStart=yes` + 缺失 allow marker 防误启动；PostgreSQL 两个 unit 已 `masked`，`8081/8083/5432` 无监听。Nginx 默认 IP vhost 未删除，但其旧 upstream 已停止。数据和配置均保留 | 进入停机观察；制作主机外副本并完成恢复演练后，才可决定删除旧 US 数据、unit、vhost 和 PostgreSQL 16。CN1 中残留的 US URL 也应在单独维护中清理，不能再把该节点称为恢复路径 |
| MedEvidence Answer Generator | `medevidence-answer-generator.service`，loopback `127.0.0.1:8092`；通过 `gw.instmarket.com.au/medevidence-answer-generator/internal` 暴露内部路由 | MedEvidence v2 的生成链依赖其服务 token、release、env 和网关 allowlist | R760 systemd/容器运行形态、内部 URL、调用方配置、release gates 和回滚方案 |
| PubMed Evidence Set Browser | `pubmed-evidence-set-browser.service`，loopback `127.0.0.1:8091`；Azure 公网 IP 下有 `/pubmed-evidence-set/` 路由 | 应用、模型和数据目录约 19 GiB；还关联本地 PostgreSQL 辅助库、发布标记和访问控制 | 大文件传输方式、CPU/GPU 依赖、数据库/模型校验、内部与公网路由是否保留 |
| Desktop 更新源回滚副本 | 权威源为 Cloudflare R2 bucket `goldencode-updates` 与自定义域名 `updates.instmarket.com.au`；Azure 只保留既有 Nginx 配置和 `/var/www` 静态副本 | 公网 URL 未变，四条 feed 由 R2 提供；GitHub Releases 保存固定版本归档。Azure 静态文件不再是发布权威，也不应接收常规 feed 切换 | 盘点并归档 Azure 回滚副本；验证 R2 凭据、对象清单、回滚恢复和域名/TLS 完全独立后，决定删除 Azure vhost、证书与静态目录 |
| TokenBridge/NewAPI | 已停止：Docker project `tokenbridge_poc` 的 NewAPI、MySQL 8.4、Redis 7 三容器；原 bind mount 仍在 `/opt/newapi-reseller/{newapi,mysql,redis}` | 数据库业务日志最后时间为 2026-05-11，最近 30 天日志和 token 访问均为 0。三个容器状态为 `exited`、restart policy 为 `no`，`13000/13306/16379` 无监听。Nginx 已切到独立 retired vhost，强制 SNI/公网 IP 验证返回 HTTP 410；操作工作站的普通 DNS 查询已无 A 记录。容器、bind data、证书和原 active vhost 均保留 | 保持 410/停机观察；完成主机外备份和恢复演练、确认无漏流量后，才删除容器/project、bind data、原 vhost、证书及残留 DNS 配置 |
| 旧 Imagegen/静态辅助路由 | Nginx `imagegen.conf`，包含 Azure 公网 IP、`/images`、`/thumbs`、`/hotmail` 和 PubMed 相关路由 | 可能同时包含旧动态 upstream 和静态文件；与 R760 新的低成本图片 API 不是同一个迁移对象 | 逐条核对访问日志、upstream 和静态文件归属，禁止因已有 R760 图片能力而直接删除 |

## 3. 共同宿主机依赖

任何完整退役方案还必须覆盖下列共享组件，而不能只复制应用目录：

- Nginx vhost、location 优先级、访问控制、请求体/长请求限制和 public route；
- `gw.instmarket.com.au`、`tokenbridge.instmarket.com.au` 及其他仍由 Azure 承担的入口之
  DNS、TLS 证书和续期/退役；`updates.instmarket.com.au` 已由 Cloudflare R2 承担，
  Azure 对应 vhost/证书只属于回滚清理范围；
- Docker images、Compose release、named volumes、已停用但仍保留的 bind-mounted MySQL/Redis 数据和日志；
- 已停用的 PostgreSQL 16 主库、辅助/历史数据库、备份和恢复证明；
- systemd unit、env 文件、服务用户、目录 owner/mode 和 restart policy；
- `/var/www` Desktop 回滚副本和其他静态资产的文件清单、大小及 SHA-256；
- 监控、timer/watchdog、备份、审计日志以及主机之外的可恢复副本；
- 调用方中的硬编码域名、端口、路径、服务 token、IP allowlist 和回调 URL。

所有 env、API key、数据库密码、服务 bearer token、Cookie、代理凭据和完整用户 key
都只能通过受控私有配置迁移；仓库文档只记录变量名、文件角色、权限和校验摘要。

## 4. R760 权威端与 Azure 兼容门槛

迁移期以 R760 为正式权威源，且不得使用整库覆盖。控制状态使用
`scripts/sync-r760-azure-gateway-state.py`，用量使用
`scripts/sync-azure-r760-gateway-usage.py`；当前实现如下：

1. 默认命令为只读 dry-run，逐表报告 insert/update/unchanged/target-only 数量；
   `--apply` 才允许写入。它不复制整库，也不删除 R760 独有记录。
2. 控制面从 R760 单向镜像 `plans`、`subjects`、`access_credentials`、`entitlements`、
   `unified_client_keys`、`upstream_v2_bindings`、`billing_events` 和
   `billing_subject_events`；请求、用量、session 和本地 audit 不参与复制。
3. 写前强制核对两端 schema、`quick_check`、外键和
   `GATEWAY_API_KEY_ENCRYPTION_SECRET` 非明文 SHA-256；自然键或不可变密文冲突时
   在事务开始前 fail closed。
4. 每次控制面有差异的 apply 先通过 SQLite backup API 生成 Azure 一致快照，保存到
   `/home/qian/codex-gateway-backups/r760-authority-mirror`，核对 SHA-256/完整性；随后以
   `BEGIN IMMEDIATE` 单事务补行/更新，并再次逐行和 FK/完整性校验。
5. 正式发钥脚本已改为 R760 创建 -> Azure 兼容镜像 -> 同一 key 双端 resolve/
   credential validation -> 成功后才生成 R760 地址的 handoff；同步或验证失败会
   禁用本次部分创建的 R760 subject，并尽力把禁用状态再次镜像到 Azure。
6. 用户禁用、plan 可变状态、entitlement 和 key 撤销/更新由安全 wrapper 在 R760
   执行并立即镜像：

   ```powershell
   python scripts\manage-r760-gateway-control.py -- disable-user <user>
   ```

7. 双运行期间的 token 用量按 request/reservation 主键去重归并到 R760，token window
   只应用新增/结算差量；不能直接把两份包含共同历史快照的数据相加。权威查询前执行：

   ```powershell
   python scripts\sync-azure-r760-gateway-usage.py --apply
   python scripts\check-daily-usage-health.py --format json
   ```

完整操作规则见 `docs/operations/r760-control-plane-authority.md`。下列首次自动 apply
证据属于 2026-08-05 的旧方向历史基线，继续保留用于审计：

首次自动 apply 的写前备份为
`/data/backups/codex-gateway/r760-pre-control-state-sync-20260805T092941Z.db`；其
mode 为 `0400`、SHA-256 为
`9ad2d4bc4112f27f62f3165eaf8d5a9a9f71eedd2074b2b73c685fd0a84bda23`，
`quick_check=ok` 且外键违规为 0。工具应用 9 行后重新导出 Azure 对账为零差异，并用
一把现有有效 handoff key 完成 Azure/R760 双端公网验证。

2026-08-06 权威方向切换已实际执行：R760 的一次受控 entitlement 清理写入触发
R760→Azure 镜像，Azure 写前备份完成，21 行演练依赖记录一次收敛，随后控制干跑为
零。Azure 兼容用量的两个固定窗口累计向 R760 去重补入 2,759 条 request event、
775 条已结算 reservation 和 111 条 admin audit；每个窗口第二次 plan 均为零差异，
两端 open reservation 均为 0，R760 写前备份、quick check 和外键检查通过。一把现有
正式 handoff key 在镜像后完成双端验证。本文不记录用户身份或任何完整 key。

## 5. 后续搬迁方案必须回答的问题

稍后编制的详细方案至少应逐项回答：

1. 组件的业务所有者、调用方、真实流量、数据敏感性和允许停机时间是什么；
2. 目标是 R760、其他长期托管还是明确退役，为什么；
3. 代码、env/secret、数据库、静态文件、模型、日志和历史审计如何迁移与校验；
4. 域名、标准 443、显式 `:1443`、Nginx 路由及客户端硬编码如何处理；
5. 如何完成不切流预演、真实 E2E、性能/容量、备份恢复和回滚演练；
6. 每项服务停止 Azure 写入、切流、观察、回滚和最终删除的门槛是什么；
7. Azure VM 停机前，如何证明没有遗漏公网 vhost、systemd unit、容器、数据库、
   timer、静态目录或仍有流量的旧客户端。

## 6. Azure VM 最终删除前的总门槛

在以下条件全部满足前，不得删除 Azure VM：

- 旧客户端、旧模型和旧入口已完成迁移，或已由经过验证的兼容入口继续承接；
- 所有历史有效 key 已在 R760 验证；新 key 只在 R760 创建并完成 Azure 兼容镜像；
- 本文每一项服务都有明确的迁移、替代或退役结论，并完成对应验收；
- 所有运行数据库、静态更新文件、Research artifacts、必要日志和审计记录都有
  主机外校验副本，并至少完成一次恢复演练；
- Cloudflare R2 bucket、发布凭据、自定义域名、对象清单和回滚恢复流程已由非 Azure
  操作环境验证，Azure Desktop 回滚副本已有明确归档或删除决定；
- 所有域名、TLS、更新 feed、内部服务 URL、客户端和 allowlist 已切换并从独立
  网络验证；
- Azure 停止接收新写入后完成最终用量增量归并与零差异干跑，观察期内没有漏流量
  或未完成任务；
- 已形成可审计的停机清单，并先执行可恢复的停机观察，再执行 VM 删除。

## 7. 2026-08-05 首批退役执行记录

退役前只读证据：

- MedEvidence US 主库 `requests=0`、`jobs=0`，`request_events=133`，最后事件时间
  `2026-05-25T07:03:01Z`；最近 30 天四项均为 0；
- TokenBridge/NewAPI MySQL `logs=23`，最后业务日志时间 `2026-05-11 11:53:46`，
  最近 1/7/30 天均为 0；12 个 token 中最近 30 天访问数为 0；
- PostgreSQL 的本地连接仅来自 MedEvidence US 的 public/internal gunicorn 与两个
  Worker；Answer Generator、PubMed Evidence Set 和四个 Codex/Research 容器均未引用
  PostgreSQL URL 或 `8083`。

执行结果：

- MedEvidence 四个 unit 于 `2026-08-05T06:19:04Z` 停止并禁用；PostgreSQL 16
  `main` cluster 状态为 `down`，两个 PostgreSQL unit 已 `masked`；
- TokenBridge/NewAPI 于 `2026-08-05T06:22:05Z` 停止，三个容器均为 `exited` 且
  restart policy 为 `no`；retired vhost 返回 HTTP 410；
- `/etc/ops-retired/medevidence-us-postgresql16.retired`、
  `/etc/ops-retired/tokenbridge-newapi.retired` 和
  `/opt/newapi-reseller/RETIRED.md` 明确记录“已退役、未删除、未经批准勿启动”；
- Azure 回滚目录为
  `/home/qian/azure-retirement-backups/20260805T061540Z`，其中包含退役前配置归档、
  PostgreSQL 全量逻辑备份（约 86 MiB）、停库冷备（约 206 MiB）、NewAPI MySQL
  逻辑备份和 TokenBridge bind-data 冷备（约 21 MiB）；gzip/tar 与 SHA-256 清单均通过；
- 上述副本仍位于同一 Azure OS disk，只能支持应用级快速回滚，不构成主机故障灾备。
  Azure VM 删除前仍必须复制到主机外并完成实际恢复演练。

保护性回归结果：Nginx、Docker、Answer Generator、PubMed Evidence Set 均为 active；
其 loopback health 与 Azure Codex Gateway health 均返回 200；Azure 正式四个
Codex/Research 容器保持 healthy；旧 `gw` 和 R760 `goldencode:1443` 公网 health 均
返回 200。Research staging `18788` 与旧 imagegen `18000` 监听也保持不变。

## 8. 2026-08-06 Desktop 更新源迁移记录

- 权威托管切换为 Cloudflare R2 bucket `goldencode-updates`，公网域名继续使用
  `https://updates.instmarket.com.au`，所以已经配置该域名的客户端无需仅因托管迁移
  改变 feed URL。
- GitHub `charlieqf/medevidence-app` 继续保存按版本固定的公开 release assets；R2
  的品牌/渠道安装包键表示当前版本，会随下一次发布更新。
- MedEvidence `v2.0.0-beta.26` 的 R2 `latest.yml`、EXE、blockmap 和版本历史文件按
  incoming/rollback 边界发布。安装包 HEAD、Range、完整 SHA-256/SHA-512 及 GitHub
  字节一致性通过；R2 回滚前缀为
  `_rollback/pre-v2.0.0-beta.26-20260806T085139Z/`。
- 四条 feed 的版本指针校验通过。MedEvidence `desktop-updates/changelog/` 尾斜杠
  别名已补齐；当次聚合站点校验仍发现 GoldenCode
  `goldencode-desktop-updates/changelog/` 返回 404，而精确
  `changelog/index.html` 可访问。该缺口不影响自动更新 feed，但应在单独获准的静态
  站点维护中补齐。
- Azure 同步副本仅用于临时回滚。以后先发布并验证 R2，再按需要同步 Azure；Azure
  同步结果不得替代 R2 公网发布证据，也不得在未获回滚授权时把 DNS 切回 Azure。

## 9. 相关文档

- `docs/implementation/domestic-gateway-doctor-research-migration-plan-2026-07-30.zh-CN.md`
- `docs/operations/system-status.md`
- `docs/operations/environment-access.md`
- `docs/operations/goldencode-cutover-audit-2026-08-04.zh-CN.md`
- MedEvidence 仓库：`docs/desktop-release-r2.md`
- MedEvidence 仓库：`docs/desktop-release-history.md`
- MedEvidence 仓库：`docs/hardware/本地化迁移方案-CN-OE后端迁移R760-2026-07-02.md`
- MedEvidence 仓库：`docs/vm-access.md`
