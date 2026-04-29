# 上游账号重命名需求说明 — subscriptions → upstream_accounts

| Field | Value |
| --- | --- |
| 状态 | Draft |
| 作者 | Charles Feng |
| 日期 | 2026-04-29 |
| 范畴 | 实现层重命名 + 公共字段澄清 |
| 关联 | 后续 plan / entitlement / 计费 / 账号池设计草案 |

## 1. 背景

当前代码、数据模型、文档、CLI 中的 `subscription` 一词承担了两种语义：

1. **当前语义（内部）**：服务端持有的 ChatGPT/Codex 登录态（`CODEX_HOME` 引用的账号），是上游服务侧的资源。
2. **未来语义（用户侧）**：终端用户对网关的"订阅档位"——计划接入的 plan/entitlement 概念，是用户侧的资源。

这两个语义会在同一份文档、同一段代码里争夺 `subscription` 这个词。继续保留双关会让计费、配额、账号池等下一步设计在命名层面持续含糊：用户问"我的订阅"时，调度器在选"我的订阅"，两个意思在 PR、运维 runbook 和审计日志里互相覆盖。

为给后续设计腾出 `subscription` / `plan` / `entitlement` 这一组术语，先把内部语义重命名为 `upstream_account`。本期不引入 plan/entitlement，也不改任何运行时行为。

## 2. 目标

1. 内部语义统一改名：所有指代"上游 ChatGPT/Codex 登录态"的字段、类型、表、变量、日志、文档统一使用 `upstream_account`。
2. `subscription` 一词保留给后续 plan/entitlement 设计；本期不引入新概念，也不引入任何新表。
3. 行为不变：除字段名变化，鉴权、限流、SSE、observation、admin CLI 行为完全保持。
4. 公共合同（OpenAI-compatible `/v1/*`）不受影响；`/gateway/*` 字段同步改名，旧字段保留一个发布周期作为兼容别名。

## 3. 非目标

- 不引入多账号池调度（沿用现有"单条 active 账号"行为）。
- 不引入 plan / entitlement / billing / team_pool 任何新表或新 CLI 命令。
- 不修改 token usage 记账或 rate limit 行为。
- 不重写 admin CLI 命令名（issue / list / rotate / revoke / events / report-usage / audit / trial-check / prune-events 等保持），仅改 JSON 输出字段。
- 不调整 `provider` 字段（仍是 `openai-codex`/`anthropic`/...）。

## 4. 术语对照

| 旧 | 新 | 说明 |
| --- | --- | --- |
| Subscription（语义） | Upstream Account | 上游 AI 服务登录态 |
| `subscriptions`（表） | `upstream_accounts` | SQLite 表 |
| `subscription_id`（列） | `upstream_account_id` | sessions / request_events / 任何外键 |
| `Subscription`（TS 类型） | `UpstreamAccount` | core 包导出 |
| `SubscriptionState` | `UpstreamAccountState` | 取值不变：active / disabled / reauth_required / unhealthy |
| `subscription`（HTTP JSON 对象，公开） | `upstream_account` | `/gateway/status` 响应 |
| `subscription_id`（HTTP JSON 字段，公开） | `upstream_account_label` | 见 §5.4a 公开 vs 内部语义说明 |
| `subscription_id`（admin/observation/DB 字段） | `upstream_account_id` | request_events、admin CLI events/report-usage/audit 输出 |
| `GATEWAY_PUBLIC_SUBSCRIPTION_ID` | `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL` | 环境变量；旧名保留为兼容 |
| `upsertSubscription` / 形参 `subscription` | `upsertUpstreamAccount` / 形参 `upstreamAccount` | core / store / adapter 公开合同 |
| 文档中"订阅"（指上游账号） | "上游账号" | 中文文档 |

未改名：
- 用户侧"订阅" / "plan" / "entitlement" 暂未落地；`subscription` 留给该阶段。
- 现有需求/技术文档中已明确指代"用户对 AI 服务持有的付费订阅"段落保持原文，但加一句术语说明，避免读者把它和 `upstream_account` 混。
- 公开错误码 `subscription_unavailable`（`packages/core/src/errors.ts`）**保留原名**。理由：错误码是更紧的对外合同，外部客户端可能已硬编码；本期是命名整理，不动错误码。后续账号池设计若需要更细的语义（如 `account_pool_unavailable`），单独 PR 评估，并和 `subscription_unavailable` 共存或做映射。

关于公开 JSON 字段的语义澄清（重要）：
- 公开字段使用 `upstream_account_label`，表明它是面向外部客户端的标识符（来自环境变量 `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL`），**不是数据库外键**。
- 内部 / admin 字段使用 `upstream_account_id`，对应 `upstream_accounts.id`，是真正的 FK。
- 这样修复了当前 `serializeSession` 用 `publicMetadata.subscriptionId`、observation 用 `session.subscription.id`（`apps/gateway/src/http/observation.ts`）的同名异义。重命名是把这处隐性歧义显性化。
- 后续上游账号池上线后，公开 surface 是否要暴露真实 `upstream_account_id` 单独决定（多账号场景下可能仍只想暴露一个 stable label）。

## 5. 影响面清单

### 5.1 数据模型（packages/store-sqlite）

- 表：`subscriptions` → `upstream_accounts`
- 列：
  - `sessions.subscription_id` → `sessions.upstream_account_id`
  - `request_events.subscription_id` → `request_events.upstream_account_id`
- 索引：随表名/列名同步重命名（SQLite 显式索引需 drop + create，沿用旧索引功能）。
- 新增一条 `schema_migrations` 记录（版本号在当前最大版本之后追加）。

### 5.2 packages/core

- `Subscription` 类型 → `UpstreamAccount`
- `SubscriptionState` → `UpstreamAccountState`
- `BootstrapStore.upsertSubscription` → `upsertUpstreamAccount`
- `GatewaySession.subscriptionId` → `upstreamAccountId`
- `RequestEventRecord.subscriptionId` → `upstreamAccountId`
- `RequestUsageReportRow.subscriptionId` → `upstreamAccountId`
- `CreateGatewaySessionInput.subscriptionId` → `upstreamAccountId`
- `CreateSessionInput` / `ListSessionInput` / `MessageInput` / `CancelInput` 中 `subscription` 字段 → **`upstreamAccount`**（公开合同字段不缩写为泛化的 `account`，避免和未来可能的"用户账户"概念冲突）。
- ProviderAdapter 合同的 `health(sub)` / `refresh(sub)` 形参重命名为 `upstreamAccount`。
- 局部变量内允许使用短名 `account`，仅限函数内部、不出 export。

### 5.3 packages/provider-codex

- 形参与内部变量重命名。
- 测试桩、日志字段同步。

### 5.4 apps/gateway

- 内部 `subscription` 变量、context 字段同步为 `upstreamAccount`。
- `defaultSubscription()` → `defaultUpstreamAccount()`。
- `GatewayPublicMetadata.subscriptionId` → **`upstreamAccountLabel`**（语义改名，明确这是公开 label，不是 DB FK；与 env `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL`、JSON `upstream_account_label` 三处 grep 关键词保持一致）。
- HTTP 响应：见 §6 兼容策略。
- observation：写库字段已通过 core 类型联动，文档同步；observation 中的 `upstream_account_id` 为真实内部 FK，与 `/sessions` 公开响应中的 `upstream_account_label` 不同。
- 环境变量：`GATEWAY_PUBLIC_SUBSCRIPTION_ID` → `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL`，旧名加 deprecation 警告但仍接受。

### 5.4a 公开 vs 内部 `upstream_account_*` 字段语义

当前实现中存在一处**已存在但隐性的**同名异义：

- `serializeSession`（`apps/gateway/src/index.ts`）返回的 `subscription_id` 取自 `publicMetadata.subscriptionId`（环境变量公开 label），不是 `session.subscriptionId`（内部 FK）。
- observation（`apps/gateway/src/http/observation.ts`）记录的 `subscription_id` 是真实内部 FK。
- 两者用同一个字段名但语义不同。重命名必须借此机会显式区分，否则改名后还是同样的隐性 bug。

本期决议：

| 上下文 | 字段 | 含义 |
| --- | --- | --- |
| `/gateway/status` 响应中的 `upstream_account` 对象 | `upstream_account.label` | 公开标识符，来自 `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL`。**对象形状与旧 `subscription` 对象不同**：旧对象用 `id` 字段名（语义上其实也是 label，仅是历史误命名），新对象改为 `label` 字段名修正语义。其余字段（`provider`、`state`、`detail`）形状一致。 |
| `/sessions` 响应中 `sessions[]` 元素、`POST /sessions` 响应中 `session` 对象 | `upstream_account_label` | 公开标识符。位置与旧字段一致：在 `serializeSession()` 生成的 session 对象内（即 `GET /sessions` 下 `sessions[i].upstream_account_label`、`POST /sessions` 下 `session.upstream_account_label`），**不在响应根**。**字段名与旧 `subscription_id` 不同**，但承载相同值。 |
| Admin CLI 输出（events、report-usage、audit 顶层字段） | `upstream_account_id` | 真实 DB FK，对应 `upstream_accounts.id` |
| Observation 写入 / DB 列 | `upstream_account_id` | 真实 DB FK |

新旧字段语义一致、字段名不同；§6 与 §8 验收以"值等价"而非"字段名等价 / 对象形状等价"为准。

未来如要把真实 FK 暴露给外部客户端（账号池上线后），单独决议；本期不做。

### 5.5 apps/admin-cli

- `events` / `report-usage` / `audit` 等命令 JSON **顶层**字段中 `subscription_id` → `upstream_account_id`（真实 FK）。
- **历史 audit `params` 透传规则**：`audit` 命令输出会原样回放历史记录的 `params_json`。历史行的 `params.subscription_id` 是当时写入的字段名，迁移**不重写**这部分嵌套内容，CLI 也**原样输出**。新写入的 audit 行 `params` 中相关字段一律使用 `upstream_account_id`。
  - 这是 §8 验收"输出中只出现新字段名"的明确例外：例外仅限 `audit.events[].params.*`，且必须是迁移前已存在的历史行；新行不允许。
- 帮助文本同步。
- CLI 顶层 JSON 字段不保留旧别名（消费者只有运维自己）。
- **store 构造期不得向 stdout 写任何内容**：admin CLI 通过 `withStore` / `withAuditedStore` 在 store 构造之后立刻 `printJson` 到 stdout（参考 `apps/admin-cli/src/index.ts` 中 `withStore`、`printJson` 实现）。任何迁移/启动信息一律走 stderr，避免污染 JSON 输出，破坏脚本消费。具体见 §7。

### 5.6 配置 / 部署

- `config/gateway.container.example.env`：替换变量名，注释里说明兼容期。
- `compose.azure.yml` / 相关运维样例：若有引用同步。
- `ops/runbooks/*`：若提及环境变量同步。

### 5.7 文档

- `README.md`：术语段落、API key MVP 段落同步。
- `access-gateway-requirements.md`、`access-gateway-technical-design.md`：内部"subscription"→"upstream account"；保留指代用户侧概念的段落，并在术语表追加澄清。
- `docs/architecture/mvp-blueprint.md` / `openai-codex-adapter.md` / `provider-adapter-contract.md` 同步。
- `docs/operations/system-status.md` / `operational-experience.md` / 相关 runbook 同步。
- `docs/consumer-technical-guide.md` / `medcode-protocol-rfc.md`：仅在指代上游账号处替换。
- `docs/decisions/`：新增一条决议记录此次改名理由及兼容窗口。
- `docs/implementation/roadmap.md` / 现有 implementation 文档：术语同步。

## 6. 公共字段兼容策略

`/gateway/*` 已被外部客户端（MedCode 集成方）消费，需要平滑过渡。

| 路由 / 字段 | 兼容策略 |
| --- | --- |
| `GET /gateway/status` 响应顶层 `subscription` 对象 | 同时返回 `upstream_account`（新）和 `subscription`（旧别名）。**两对象形状不同**：旧对象保留原字段集 `{ id, provider, state, detail }`；新对象修正语义为 `{ label, provider, state, detail }`。`upstream_account.label` 与 `subscription.id` 承载相同值；`provider` / `state` / `detail` 形状一致。验收以"语义等价"为准，不要求字段名等价。旧对象标 deprecated。 |
| `GET /sessions` 中 `sessions[].subscription_id`、`POST /sessions` 中 `session.subscription_id` | 由 `serializeSession()` 同时输出 `upstream_account_label` 和 `subscription_id`（旧别名），位置与旧字段一致（在 session 对象内，**不在响应根**），两者承载相同值。 |
| `/v1/*`（OpenAI-compatible） chat/completions、models 等业务响应 | 不输出 subscription/upstream_account 字段，无需兼容。 |
| `/v1/*` 错误响应中 `error.code = "subscription_unavailable"` | **保留原值**。错误码是更紧的对外合同；本期是命名整理，不动错误码。后续若需要 `account_pool_unavailable` 这类更细的语义，单独 PR 评估，做共存或映射。 |
| `GATEWAY_PUBLIC_SUBSCRIPTION_ID` env | 启动时若仅设置旧名，使用旧名并打 deprecation 警告；新旧（`GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL`）都设置时以新名为准；都缺省时 fallback 到 `providerName`，不变。 |
| Admin CLI JSON 输出 | 第一版直接切到新名（`upstream_account_id`），不留旧别名。 |
| Audit 历史记录 | 历史行不重写；新行使用新字段名。 |

兼容期限：保留至下一个内部 trial 完整周期结束（建议绑定 §11 中确定的具体日期），之后单独 PR 移除旧别名。

`docs/consumer-technical-guide.md` 增补一节："上游账号字段重命名时间表"，列出兼容窗口与切换截止日期，并明确 `upstream_account_label`（公开 label）与 `upstream_account_id`（DB FK）的语义差异。

## 7. 数据迁移

新增一条 SQLite migration（版本号紧随当前最大版本），单事务内完成：

```sql
ALTER TABLE subscriptions RENAME TO upstream_accounts;
ALTER TABLE sessions RENAME COLUMN subscription_id TO upstream_account_id;
ALTER TABLE request_events RENAME COLUMN subscription_id TO upstream_account_id;

DROP INDEX IF EXISTS idx_request_events_subscription_started;  -- 若存在
-- 视实际索引名重建
```

要求：
- 迁移幂等：旧库已经迁移过的版本能识别并跳过。
- 迁移可前向：从未应用过的旧库自动升级到新 schema。
- 迁移不写 down：当前阶段 pre-prod，不维护回滚 SQL；回退靠备份。
- 迁移期间不允许写入：运维流程中给出停机窗口（实际只有 ALTER，秒级）。
- **迁移日志通道**：store 构造期不得写 stdout。**该约束只为保护 admin CLI 的 stdout JSON 合同**——CLI 走 stdout 输出 JSON（参考 `apps/admin-cli/src/index.ts`），任何 stdout 噪声都会破坏 `events` / `report-usage` / `audit` 等命令的 JSON 解析。gateway 自身没有这种合同，其 logger destination 不在本期约束范围内。具体规则：
  - `SqliteGatewayStore` 构造与迁移过程**默认静默**，不写 stdout 也不写 stderr。
  - 是否输出由调用方通过可选 logger 注入决定（`new SqliteGatewayStore({ path, logger })`）。logger 默认 noop。
  - admin CLI 默认不注入 logger（保持 JSON 输出洁净）；可通过 `--verbose` 全局选项注入一个 **stderr** logger，开发时使用。
  - gateway 启动时把 Fastify/Pino logger 的子 logger 传给 store；迁移信息按 Pino 默认行为落到进程 stdout（与 HTTP access log 同一通道）。这是 Fastify 默认行为，本期不改。
  - 验证迁移结果用 `SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 5`，而不是依赖启动日志。runbook 同步说明该验证步骤。

## 8. 验收标准

- [ ] `git grep -i subscription -- '*.ts' '*.json' '*.sql'` 在源码中仅剩兼容字段别名声明（`subscription`/`subscription_id` 公开输出与 env var 旧名 fallback）、`subscription_unavailable` 错误码、注释中明确指代用户侧 plan 概念之处，及历史 audit 字段读取。
- [ ] 公开错误码集合 `gatewayErrorCodes` 仍包含 `subscription_unavailable`，并有显式注释说明它是公开兼容字段。
- [ ] 现有所有单元测试、集成测试、e2e smoke 通过。
- [ ] 新增迁移测试：`v_old → v_new` 自动升级；列名替换后对旧数据保留完整。
- [ ] 新增 store 单元测试：`SqliteGatewayStore` 构造与迁移期间 `process.stdout.write` 的 spy 调用次数为 0（直接证明源码中没有 `console.log` / `process.stdout.write` / 其他 stdout 写入路径，而不是只证明注入的 logger 没污染 stdout）。
- [ ] 新增 admin CLI JSON 洁净测试：在一个未迁移的旧库上执行 `events --limit 1`，捕获子进程 stdout 后能 `JSON.parse` 成功；stderr 内容（含 deprecation 警告）独立、不进 stdout。
- [ ] 在新 / 旧 env 下 `npm run dev:gateway` 都能启动；旧 env 启动时通过 Fastify/Pino server logger 输出一条 deprecation 警告（warn 级别），含旧 env 名与新 env 名。注：gateway 的 logger 默认 destination 是 stdout（Fastify+Pino 默认行为），本期不改这点；stdout 洁净要求**仅适用于 admin CLI JSON 输出**，gateway 没有此约束。
- [ ] `/gateway/status` 同时返回 `upstream_account` 和 `subscription`：`upstream_account.label === subscription.id`（语义等价）；其余字段 `provider` / `state` / `detail` 形状一致；不要求两对象 key 集合相同（这是有意的，目的是修正 `subscription.id` 历史误命名为 `upstream_account.label`）。
- [ ] `GET /sessions` 中 `sessions[i]` 元素与 `POST /sessions` 中 `session` 对象同时含 `upstream_account_label` 和 `subscription_id`（旧别名），两者值一致；新字段位于 session 对象内，**不在响应根**。
- [ ] Observation / Admin CLI 中的 `upstream_account_id` 是真实 DB FK，与公开响应中的 `upstream_account_label` / `subscription_id` / `upstream_account.label` 字段名不同，对应不同语义；测试覆盖此区分。
- [ ] Admin CLI `events` / `report-usage` / `audit` **顶层**字段中只出现新字段名 `upstream_account_id`（真实 FK）；help 文本同步。
- [ ] Admin CLI `audit` 输出中 `events[].params` 嵌套字段允许出现历史 `subscription_id`（仅限迁移前已存在的行）；新写入的 audit 行 `params` 中相关字段一律使用 `upstream_account_id`。该例外在 §5.5 已声明，验收测试需覆盖"历史 params 透传 + 新 params 用新名"。
- [ ] README、需求 / 技术 / MVP 文档、operations runbook 中无残留旧术语（除明确兼容性段落和错误码段落）。
- [ ] `docs/consumer-technical-guide.md` 含字段切换时间表，并说明 `upstream_account_label`（公开 label）与 `upstream_account_id`（DB FK）的语义差异。
- [ ] `docs/decisions/` 新增一条决议。

## 9. 风险与回退

- **风险 1**：外部客户端依赖 `/gateway/status` 的 `subscription` 字段。
  - 缓解：保留兼容别名；提前在 `consumer-technical-guide.md` 通知；deprecation 周期跨过下一次内部 trial。
- **风险 2**：SQLite migration 在已有 db 上执行失败（如 SQLite 版本过旧不支持 RENAME COLUMN）。
  - 缓解：上线前在 ops 备份 db；migration 单事务；如失败保留旧库回滚。`ALTER TABLE ... RENAME COLUMN` 需 SQLite 3.25+，部署目标 Node 内置 sqlite 已满足。
- **风险 3**：env var 改名导致部署脚本失效。
  - 缓解：兼容旧名 + 警告；`compose.azure.yml` 同步改样例；运维窗口手动验证。
- **风险 4**：半迁移状态（数据库改了但代码没改完，反之亦然）。
  - 缓解：S1–S4 在同一 PR 落（见 §10），避免发布跨界半态。
- **回退路径**：迁移失败 → 恢复 db 备份；代码层面 git revert 该 PR；env var 旧名仍可用，无需运维额外动作。

## 10. 实施阶段

| 步骤 | 内容 | PR 边界 |
| --- | --- | --- |
| S1 | core 类型重命名；store schema migration 落地（含表/列/索引）；SQLite 测试同步 | 同一 PR |
| S2 | provider-codex 形参与日志同步；adapter 测试同步 | 同一 PR |
| S3 | gateway 内部变量、context、observation、env var 解析；HTTP 响应双字段输出 | 同一 PR |
| S4 | admin CLI 输出字段切换；help 同步；CLI 测试同步 | 同一 PR |
| S5 | 文档与 runbook 全面替换；新增 decision；consumer guide 增补时间表 | 同一 PR |
| S6 | 兼容期结束后单独 PR：移除 `/gateway/status` 等公共字段旧别名、移除 env var 旧名兼容 | 独立 PR |

S1–S5 建议合并到一个 PR；半改状态会让审阅与回退都很难。S6 单独 PR，时间窗口在 §11 决定后写入 changelog。

## 11. 待定

- **兼容期长度**：旧公共字段别名保留多久？建议绑定一个具体日期（例如下一次内部 trial 结束 + 14 天），写入 `docs/consumer-technical-guide.md` 字段切换时间表。
- **是否在本次 migration 同时整理 `health_json` / `cooldown_until` 字段语义注释**：不改 schema 本身，只改注释。倾向"是"，避免下次再动一次表。
- **Audit 历史记录字段是否回填**：当前历史 audit 行 params 中含 `subscription_id` 字段，是否在迁移时统一回填为 `upstream_account_id`？倾向"不回填，只前向写新名"，保证历史日志不可变。
- **TypeScript 类型别名是否保留一段时间**（如 `export type Subscription = UpstreamAccount`）：当前包尚未发布到 npm registry，仅 workspace 内部使用，倾向硬切；若未来要外发包再单独评估。
- **公开 label 字段名最终选择**：`upstream_account_label` vs `upstream_account.label`（嵌入对象） vs `upstream_account_id`（接受同名异义）。本草稿采用 `upstream_account_label`（顶层）和 `upstream_account.label`（status 嵌套对象内）。后续 review 可能调整。
- **`subscription_unavailable` 错误码长期归宿**：本期保留。若后续账号池设计引入 `account_pool_unavailable`：是双码并存（按 HTTP 语义二选一）、还是把旧码标 deprecated 后窗口下线？决策延后到账号池 PR。

---

附：本期完成后，`subscription` 这个词在仓库里只剩三种合法用途：
1. 公共字段兼容别名（带 deprecation 标注，S6 移除）；
2. 公开错误码 `subscription_unavailable`（明确保留，注释说明）；
3. 后续 plan/entitlement 设计文档中明确指代"用户对网关的订阅"概念。

这之后的每一处新写 `subscription`，要么属于 1–3 之一，要么默认指用户侧。
