# Codex Max 请求 SQLite 磁盘放大问题与解决方案（评审稿）

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft / 待审核 |
| 日期 | 2026-07-13 |
| 版本 | v2（已纳入首轮审核意见） |
| 影响环境 | Azure 生产 Gateway `gw.instmarket.com.au` |
| 主要影响模型 | `max`（OpenAI Codex / ChatGPT subscription 路径） |
| 不受影响的主要路径 | `goldencode` 及其他不经过 Codex CLI 的模型 |
| 关联改动 | `110e1be`、`a67b56a` |

## 1. 摘要

生产 Gateway 的 Max 请求存在明显的临时磁盘放大：一个普通的无状态 Max
请求可能创建约 4–5.3 GB 的临时 `state_5.sqlite`，两个并发请求可产生约
8–11 GB 的瞬时占用。请求正常结束时目录会被删除；请求被 SIGKILL、容器重启
或进程异常终止时，临时目录可能残留，最终造成磁盘空间持续下降，并进一步诱发
OOM、SIGKILL、请求中止和容器重启。

这不是模型推理本身正常需要的磁盘空间，而是 Gateway 与 Codex CLI 的集成方式
导致的放大：Gateway 为每个无状态请求创建一个全新的 `sqlite_home`，但同时继续
向 Codex CLI 提供包含大量历史 `sessions/` 的持久 `CODEX_HOME`。Codex CLI 在
新的 SQLite 数据库中回填这些历史 rollout 元数据，因此每个请求都会重复构建一份
数 GB 的线程索引。

推荐修复为：

1. 无状态请求继续使用 `codex exec --ephemeral`，避免写入新的 rollout 文件。
2. 删除“每请求创建临时 `sqlite_home`”的逻辑，让请求复用对应上游账号现有的
   持久 SQLite 状态。
3. 保留 `a67b56a` 已实现的启动时安全清扫，作为旧版本残留和异常退出的兜底，
   但不再依赖清扫解决运行中磁盘放大。
4. 根因修复稳定后，再在独立维护窗口中清理未被 Gateway 原生 session 引用的
   历史 Codex rollout，并离线重建/压缩 Codex SQLite 状态。

## 2. 问题描述

### 2.1 用户可见现象

受影响请求可能表现为：

- 简单文字请求长时间无法生成；
- 客户端出现 `internal server error`、`The operation was aborted` 或高负载提示；
- Gateway 日志出现 `Codex Exec exited with signal SIGKILL`、`terminated`；
- 容器发生重启，`RestartCount` 增长；
- 同一时段多个 Max 请求相互放大资源压力。

### 2.2 已观察到的生产证据

本次调查只读取文件元数据和 SQLite 聚合信息，没有读取或输出用户提示词正文。

观察结果包括：

- 两个已完成的并发 Max 请求，各自临时目录约 5.3 GB；请求结束并删除目录后，
  磁盘可用空间合计恢复约 10 GB。
- 临时目录的绝大多数空间由单一文件占用：
  `codex-gateway-state-<pid>-*/state_5.sqlite`。
- 一个现场样本的 `state_5.sqlite` 大小为 4,043,902,976 字节，其中
  `threads` 表约占 4,029,501,440 字节。
- 该样本 SQLite 使用 4096 字节页、约 987,281 页，`freelist_count=0`，说明
  主要不是空闲页或 WAL 未回收，而是真实写入的数据页。
- `threads` 表中约有 9,968 行，与对应持久 `CODEX_HOME/sessions` 下的 rollout
  文件数量一致，证明新的临时数据库正在回填整个历史目录。
- 字段级长度聚合显示 `title`、`first_user_message`、`preview` 均承载大量历史
  文本。首轮调查记录没有保留足够信息证明单字段逻辑长度与 `dbstat` 物理页大小
  来自同一可直接比较的统计口径和快照，因此本稿不再引用相互矛盾的单字段 GB
  数字；容量结论只采用同一现场样本的数据库大小、`threads` 物理页大小和行数
  对应关系。
- `codex-pro-1` 对应持久目录中约有 9,968 个 rollout JSONL，合计约
  3.77 GB；另一个上游账号的持久目录约有 10,848 个 rollout JSONL，合计约
  4.96 GB。

这些数据说明：临时空间增长与当前请求的提示词大小并不成比例，主要来自对历史
会话的重复索引，而不是当前 Max 回答本身。

## 3. 当前实现与根因

### 3.1 当前无状态请求路径

`CodexProviderAdapter.message()` 使用 Gateway session id 的
`sess_stateless_` 前缀判断无状态请求。当前逻辑会：

1. 在系统临时目录中执行 `mkdtempSync(...)`；
2. 把该目录作为请求级 `config.sqlite_home`；
3. 保持 `CODEX_HOME` 指向上游账号的持久登录目录；
4. 通过包装脚本把调用转换为 `codex exec --ephemeral`；
5. 请求结束后在 `finally` 中递归删除临时目录。

这里还有一个必须在实现时解除的耦合：当前 `createClient()` 不是根据
`ephemeral` 布尔值设置 `CODEX_GATEWAY_EPHEMERAL`，而是根据
`runtimeStateDir` 是否存在设置该环境变量。也就是说，当前第 2 步和第 4 步实际
共享同一个触发条件。如果只删除临时目录和 `sqlite_home`，环境变量会静默消失，
包装脚本将不再注入 `--ephemeral`，无状态请求会重新向 `sessions/` 持久化
rollout。这会加速历史目录增长，形成与本次修复目标相反的回归。

涉及位置：

- `packages/provider-codex/src/codex-adapter.ts`：无状态判断、临时目录创建与删除；
- `packages/provider-codex/src/codex-adapter.ts`：`config.sqlite_home` 注入；
- `scripts/codex-gateway-exec.sh`：`--ephemeral` 注入。

### 3.2 为什么 `--ephemeral` 没有阻止本问题

Codex 官方命令说明中，`--ephemeral` 的语义是本次运行不把 session rollout
持久化到磁盘。它不会让 Codex 忽略 `CODEX_HOME/sessions` 中已经存在的历史文件，
也不会阻止一个新的 SQLite 状态库从历史 rollout 回填线程元数据。

因此：

- `--ephemeral` 能防止历史文件继续快速增加；
- 但“持久 `CODEX_HOME` + 每请求全新 `sqlite_home`”仍会让旧历史在每个请求中
  被重新索引；
- 两者解决的是不同问题，不能用 `--ephemeral` 代替 SQLite 生命周期设计。

### 3.3 根因链路

完整链路如下：

```text
Max 无状态请求
  -> Gateway 创建全新的请求级 sqlite_home
  -> CODEX_HOME 仍指向持久上游账号目录
  -> Codex CLI 发现 CODEX_HOME/sessions 中存在约一万个历史 rollout
  -> 新 state_5.sqlite 对全部历史执行回填
  -> 单请求写入约 4–5.3 GB
  -> 并发请求各自重复一份
  -> 正常结束时删除；异常结束时形成残留
  -> 磁盘压力导致 SIGKILL / 请求中止 / 容器重启
```

### 3.4 责任边界

该问题主要属于 Gateway 集成设计回归：commit `110e1be` 引入了请求级
`sqlite_home`，却没有考虑 Codex CLI 会从持久 `CODEX_HOME/sessions` 回填历史。

Codex CLI 的回填策略和 `threads` 表中多个大文本字段的重复保存放大了影响，但
Gateway 不应为每个外部 API 请求反复触发一次全量历史回填。因此根因修复应优先
落在 Gateway 的状态目录生命周期设计上，而不是等待上游 CLI 改变。上游关于
“共享认证、隔离 `CODEX_HOME`”的功能请求已被关闭为 `not planned`，也进一步
支持在 Gateway 侧完成本次修复。

## 4. 已上线缓解措施及其边界

commit `a67b56a` 已增加启动时安全清扫：

- 新目录名包含 Gateway PID；
- 只扫描系统临时目录第一层；
- 只匹配严格的 Gateway 目录命名格式；
- 跳过仍存活 PID 对应的目录；
- 跳过符号链接、文件和不符合规则的目录；
- 兼容旧版无 PID 目录，并设置最小年龄保护；
- Gateway 启动、开始监听前执行清扫。

该措施可以安全回收异常退出后的残留，降低“空间只增不减”的风险，但不能阻止
正在运行的两个请求同时占用 8–11 GB。因此它是必要的防御层，不是根因修复。

## 5. 方案比较

### 5.1 方案 A：复用上游账号现有 SQLite，保留 `--ephemeral`（推荐）

改造内容：

- 无状态请求不再创建请求级临时目录；
- 不再设置请求级 `config.sqlite_home`；
- `CODEX_HOME` 继续指向当前上游账号的持久目录；
- 继续设置 `CODEX_GATEWAY_EPHEMERAL=1`，包装脚本继续使用
  `codex exec --ephemeral`；
- 原生可恢复 session 路径保持不变。

优点：

- 直接消除每请求 4–5.3 GB 的全量回填；
- 不复制、不移动认证状态，不引入 refresh token 一致性问题；
- 复用 Codex 默认的持久状态模型，代码改动最小；
- 回滚简单，不需要修改数据库 schema；
- 已有原生 session resume 能力可以继续使用。

风险：

- 多个 Codex 进程可能同时访问同一个账号的持久 SQLite；
- 需要用真实并发 smoke 验证当前 Codex 版本的 WAL/锁行为；
- 现有持久 SQLite 和历史 rollout 仍占用固定空间，需第二阶段清理。

该共享模式并非完全新的风险面：原生可恢复 session 当前不设置请求级
`sqlite_home`，已经在复用对应上游账号的持久 SQLite。方案 A 是把无状态请求
纳入现有模式，新增风险主要来自无状态请求的并发数量和访问组合，而不是首次启用
共享数据库。真实并发 smoke 仍必须保留，不能仅凭原生 session 已工作就推定通过。

风险控制：

- 上线前执行同一上游账号的双请求并发测试；
- 监控 `database is locked`、SQLite migration/open 错误和 Codex 退出码；
- 未通过并发测试时不部署到生产，转用方案 B，而不是恢复每请求空数据库。

### 5.2 方案 B：每上游账号使用固定的 stateless SQLite 目录（备选）

为每个上游账号配置一个长期存在的 stateless `sqlite_home`，所有无状态请求复用
该目录，而不是每请求新建。

优点：

- 将原生 session SQLite 与无状态请求的运行状态分开；
- 全量回填最多发生一次，不会按请求倍增；
- 可在每账号并发为 1 的条件下进一步降低锁竞争。

缺点：

- 首次初始化仍可能回填现有全部历史，额外固定占用约 4–5 GB/账号；
- 仍需要处理同一固定 SQLite 的并发；
- 配置、迁移和运维复杂度高于方案 A。

适用条件：方案 A 的真实并发测试确认共享现有 SQLite 会产生不可接受的锁冲突。

### 5.3 方案 C：独立的 stateless `CODEX_HOME`（长期强隔离备选）

为每个上游账号再准备一个完全独立、无历史 session 的 stateless
`CODEX_HOME`，并在该目录中单独完成一次 ChatGPT/Codex 登录。

优点：

- 认证、配置、session、SQLite 全部隔离；
- stateless home 中没有历史 rollout，可从根本上避免回填旧会话；
- 适合未来把无状态 API 与原生可恢复 session 做严格运行域分离。

缺点：

- 每个上游账号需要额外设备登录和独立认证生命周期；
- 运维、reauth、健康检查和账号池配置都要扩展；
- 同一 ChatGPT 账号的多个登录状态需分别管理；
- 不适合作为本次故障的最低风险热修复。

禁止通过复制或周期同步 `auth.json` 实现方案 C。ChatGPT OAuth refresh token
存在轮换语义，多个认证文件副本可能互相失效。若采用独立 `CODEX_HOME`，应在每个
目录中独立登录，不应复制或软链接认证文件。

### 5.4 方案 D：只做启动清扫或定时删除（不接受）

该方案只能删除已结束进程留下的目录，无法阻止活跃请求同时占用数 GB。磁盘可能
在清扫触发前已经耗尽，而且错误删除活跃目录会破坏正在执行的请求。

### 5.5 方案 E：直接删除整个持久 `CODEX_HOME`（不接受）

会同时删除认证状态、原生 session、配置和 Codex 管理的 SQLite 数据，可能导致：

- 两个上游账号都需要重新授权；
- Gateway 原生 session 无法恢复；
- refresh token 或登录状态丢失；
- 无法审计哪些用户会话被破坏。

历史清理必须在备份和引用分析后进行，不能把整个 `CODEX_HOME` 当缓存删除。

## 6. 推荐实现设计

### 6.1 Provider 适配器改造

对 `sess_stateless_` 请求：

1. 不调用 `mkdtempSync()`；
2. 不向 `codexConfigForRequest()` 传入请求级 runtime 目录；
3. 不设置 `config.sqlite_home`；
4. 将 `createClient()` 的第二个参数从 `runtimeStateDir` 改为独立的
   `ephemeral: boolean`（或等价的命名 options 字段）；
5. 将 `CODEX_GATEWAY_EPHEMERAL` 的判断条件从 `runtimeStateDir` 是否存在改为
   `ephemeral` 布尔值；
6. 继续向 Codex SDK 环境传入当前账号的 `CODEX_HOME`；
7. 删除请求结束时针对 runtime 目录的 `rmSync()`，因为新请求不再创建该目录。

目标代码关系应明确保持为：

```ts
const ephemeral = input.session.id.startsWith("sess_stateless_");
const client = this.createClient(input.reasoningEffort, ephemeral);

// createClient(reasoningEffort, ephemeral)
const env = {
  ...process.env,
  CODEX_HOME: this.options.codexHome,
  ...(ephemeral ? { CODEX_GATEWAY_EPHEMERAL: "1" } : {})
};
```

`codexConfigForRequest()` 在本方案中只处理 reasoning/image 等请求配置，不再通过
runtime 目录间接决定是否启用 `--ephemeral`。这一解耦是本次实现的强制要求，
不能只依赖单元测试偶然发现回归。

对于原生 Gateway session：

- 保持当前 `startThread` / `resumeThread` 逻辑；
- 保持 `providerSessionRef` 行为；
- 不改变 session stickiness 和上游账号选择。

### 6.2 启动清扫的保留策略

`cleanupStaleCodexRuntimeStateDirs()` 至少保留两个生产发布周期，用于：

- 清除旧镜像遗留目录；
- 处理回滚到旧版后再升级的残留；
- 对历史无 PID 命名目录继续提供保守清理。

新版本正常运行不应再创建 `codex-gateway-state-*` 目录。观察期结束后可以另行审核
是否移除清扫逻辑；本次修复不移除。

### 6.3 测试调整

Provider 单元测试至少覆盖：

- stateless 请求设置 `CODEX_GATEWAY_EPHEMERAL=1`；
- stateless 请求不再传入 `config.sqlite_home`；
- stateless 请求不创建 `codex-gateway-state-*` 临时目录；
- `minimal` reasoning 仍正确设置 `model_reasoning_effort=none` 和图片功能开关；
- resumable session 不设置 ephemeral 标志，仍可 resume；
- 异常、abort、stream error 路径不会产生新的临时状态目录。

Gateway 集成测试至少覆盖：

- `/v1/chat/completions` 非流式 Max；
- `/v1/chat/completions` 流式 Max；
- `/v1/responses` 非流式和流式 Codex 路径；
- client abort 后 token reservation 正确 finalize/release；
- 原生 `/sessions/:id/messages` 第二轮恢复；
- GoldenCode 请求仍使用 GLM 路径，不进入 Codex adapter。

## 7. 历史数据清理方案（第二阶段，独立审核）

根因修复与历史清理不得在同一个不可回滚步骤中完成。建议先部署运行时修复并观察，
再安排独立维护窗口释放固定占用。

### 7.1 清理前置条件

- 根因修复已部署并稳定运行至少一个观察窗口；
- Gateway 无活跃 Max/Codex 请求；
- 容器健康且 `RestartCount` 稳定；
- 已对 Docker volume 和两个上游账号 `CODEX_HOME` 做可恢复备份；
- 已导出 Gateway `sessions.provider_session_ref` 及其 `upstream_account_id`；
- 已建立 provider session ref 到 rollout 文件的映射；
- 未能确认是否被引用的文件一律保留。

### 7.2 可清理对象

- 未被任何 Gateway 原生 session 引用的旧 rollout JSONL；
- 已确认属于历史 stateless API 请求、且不需要恢复的 rollout；
- 旧版 `codex-gateway-state-*` 残留目录；
- 在停止相关 Codex 进程后确认无用的旧 SQLite sidecar/备份文件。

### 7.3 必须保留的对象

- `auth.json` 及其他认证状态；
- 当前配置文件和上游账号目录权限；
- 被 `sessions.provider_session_ref` 引用的 rollout；
- 未完成引用核对的历史文件；
- Gateway 自身的 `gateway.db`、`client-events.db` 及审计数据。

### 7.4 SQLite 处理原则

- 不在 Codex/Gateway 运行中删除或替换 `state_5.sqlite`；
- 不直接修改 Codex 内部 `threads` 表或回填状态字段；
- 不依赖手工 SQL 删除部分行来绕过回填；
- 在维护窗口停止相关进程后，保留带时间戳的原文件和 sidecar；
- 由相同版本 Codex CLI 从保留的 rollout 集合重建状态，再验证 session resume；
- 只有完成恢复演练和业务验证后，才删除旧备份以真正释放磁盘。

## 8. 上线计划

### 阶段 0：代码与配置预检

1. 确认工作树中的无关文档改动不被覆盖或提交。
2. 执行 `npm run build` 和完整 `npm test`。
3. 确认 Azure live env 仍包含 8 个公开模型及 GoldenCode 四平台配置。
4. 确认容器仍只发布 `127.0.0.1:18787->8787`，不改 Nginx、端口或防火墙。

### 阶段 1：部署运行时根因修复

1. 在无活跃 Codex 请求窗口构建新镜像。
2. 仅重建 Gateway 容器，不修改 Nginx、Docker daemon 或其他服务。
3. 检查 `/gateway/health`、容器 health、端口绑定和 `RestartCount`。
4. 检查 `/v1/models` 仍完整返回 8 个模型。

### 阶段 2：功能 smoke

公共 smoke 中涉及临时 key 的签发和撤销仍须顺序执行，避免 admin SQLite 写锁。

至少验证：

- `GET /gateway/credentials/current`；
- Max 非流式与流式请求；
- Responses Codex 路径；
- GoldenCode 请求，并核对上游仍为 GLM-5.2 四平台池；
- 原生 session 两轮 resume；
- 临时 key 和临时用户清理完成。

### 阶段 3：并发磁盘专项验证

并发测试只并行发送业务请求；临时 key 的创建和清理保持串行。

1. 使用一个已创建的临时测试 key 同时发送两个小型 Max 请求；
2. 在请求前、请求中和请求后记录：
   - 根文件系统可用空间；
   - 容器 writable layer 大小；
   - `/tmp/codex-gateway-state-*` 数量与大小；
   - 持久 `state_5.sqlite`、WAL 大小；
   - 通过只读聚合查询记录持久 `threads` 表请求前后的行数；
   - 对比两个请求前后持久 `state_5.sqlite` 大小和 `threads` 行数差异，确认
     `--ephemeral` 是否仍写入少量线程元数据；
   - Codex 子进程数量和退出状态；
   - 容器 `RestartCount`、OOMKilled 状态；
3. 查询两个请求的 `request_events`，确认状态和上游账号归属；
4. 串行撤销临时 key 并禁用临时用户。

## 9. 验收标准

必须同时满足：

1. 新版 stateless 请求不再创建新的 `codex-gateway-state-*` 请求目录。
2. 两个并发小型 Max 请求期间，不再出现每请求约 4–5.3 GB 的
   `state_5.sqlite`。
3. 专项测试期间非预期磁盘增量目标不超过 512 MiB；超过该阈值暂停上线并分析。
4. 持久 `threads` 行数和 `state_5.sqlite` 大小的变化已记录并可解释：允许存在与
   当前两个请求对应的少量元数据变化，但不得出现历史全量回填或持续无界增长。
5. 不出现 `database is locked`、SQLite migration/open error。
6. 不出现 SIGKILL、OOMKilled、`The operation was aborted` 或容器重启。
7. Max 流式和非流式请求均成功，客户端能持续收到流式事件。
8. `/v1/responses` Codex 路径成功。
9. 原生 session 能继续第二轮 resume，`provider_session_ref` 不丢失。
10. 两个上游 Codex 账号认证健康，没有 refresh-token/reauth 错误。
11. `/v1/models` 仍返回完整 8 模型；GoldenCode smoke 成功且没有进入 Codex 路径。
12. 启动安全清扫继续通过现有安全边界测试。

## 10. 回滚与失败处理

### 10.1 方案 A 出现共享 SQLite 锁冲突

不要直接恢复“每请求新建空 SQLite”的旧设计。处理顺序：

1. 停止专项 Max 并发测试，保留日志和 SQLite 元数据；
2. 确认 Gateway 与其他模型仍健康；
3. 切换到方案 B：每上游账号固定 stateless SQLite 目录；
4. 在受控环境完成一次初始化和并发验证后再部署；
5. 在确认磁盘有足够余量前，不允许旧镜像承接并发 Max 流量。

### 10.2 出现认证问题

- 不从另一个目录复制旧 `auth.json`；
- 先根据日志区分 refresh token、rate limit 和普通上游错误；
- 只有出现明确 refresh-token 证据时，才使用仓库 reauth 脚本；
- reauth 后执行账号级 verify-only/probe，再恢复流量。

### 10.3 数据清理回滚

- 根因修复部署不修改历史 rollout，因此可以独立回滚代码；
- 第二阶段清理必须保留完整、带时间戳的离线备份；
- 任一原生 session resume 失败时，停止删除动作并恢复对应 rollout 和 SQLite；
- 在恢复演练通过前不删除最后一份备份。

## 11. 监控与后续改进

建议补充以下观测：

- Gateway 启动时记录安全清扫的目录数和错误数，不记录文件内容；
- 按上游账号记录 Codex inflight 和退出原因；
- 监控容器 writable layer、根分区可用空间和 inode；
- 对 `state_5.sqlite`、WAL 和 `sessions/` 大小设置日级趋势告警；
- 对 SIGKILL、OOMKilled、容器重启设置即时告警；
- 在 Codex SDK/CLI 升级验证中加入“双 Max 并发 + 磁盘增量”回归测试；
- 评估为 Max 增加模型级全局并发保护，避免单 VM 资源被大量请求耗尽。

## 12. 审核决策项

请审核人明确确认：

首轮审核意见对以下六项均建议同意；复选框仍保留给项目负责人作最终确认。

- [ ] 同意方案 A 作为首选根因修复。
- [ ] 同意继续保留 `--ephemeral` 和启动安全清扫。
- [ ] 同意将历史数据清理拆分为独立维护阶段。
- [ ] 同意并发专项验证的 512 MiB 暂定磁盘增量阈值。
- [ ] 若方案 A 出现锁冲突，同意优先转方案 B，而不是回滚到每请求临时 SQLite。
- [ ] 不允许复制/软链接 `auth.json`，也不允许直接删除整个 `CODEX_HOME`。

## 13. 参考资料

- Codex developer commands：`--ephemeral` 表示本次执行不持久化 session rollout：
  <https://learn.chatgpt.com/docs/developer-commands#codex-exec>
- Codex configuration reference：`sqlite_home` 是 Codex 保存 SQLite-backed state
  DB 的目录：
  <https://learn.chatgpt.com/docs/config-file/config-reference#configtoml>
- OpenAI Codex 官方仓库关于独立 `CODEX_HOME` 与认证隔离的说明；该功能请求已被
  上游关闭为 `not planned`：
  <https://github.com/openai/codex/issues/15410>
