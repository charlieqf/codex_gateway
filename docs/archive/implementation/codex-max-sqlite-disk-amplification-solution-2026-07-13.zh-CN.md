# Codex Max 请求 SQLite 磁盘放大问题与解决方案

| 项目 | 内容 |
| --- | --- |
| 状态 | 已实施并完成生产验证 |
| 日期 | 2026-07-13 |
| 版本 | v3（根据生产反证改用 rollout 隔离方案） |
| 影响环境 | Azure 生产 Gateway `gw.instmarket.com.au` |
| 主要影响模型 | `max`（OpenAI Codex CLI 路径） |
| 不受此根因影响的路径 | `goldencode` 及其他不经过 Codex CLI 的模型 |
| 最终实现 commit | `e58877e` |
| 已否决并回滚的 commit | `729dee2`；由 `a208e30` 回滚 |

## 1. 结论

一个简单的无状态 Max 请求曾为每次调用创建全新的请求级 `sqlite_home`。Codex CLI
会从持久 `CODEX_HOME/sessions/` 中约一万个历史 rollout 回填新 SQLite，因此单个
请求可临时写入约 4–5.3 GB，两个请求会各自重复一份。这不是当前提示词或模型回答
正常需要的空间，而是历史状态被重复索引。

首轮评审推荐的“方案 A”是取消请求级 `sqlite_home`、复用账号的持久 SQLite，同时
继续使用 `--ephemeral`。该方案已经按评审意见完整实现并在本地通过测试，但生产
实测证明不可接受：放大写入没有消失，而是从临时 SQLite 转移到了持久 SQLite/WAL，
并导致简单 Max 请求 600 秒无输出。因此方案 A 已立即回滚，不得再次实施。

最终方案保留以下两项原有行为：

1. 无状态请求继续使用请求级临时 `sqlite_home`，隔离并发写入；
2. `CODEX_GATEWAY_EPHEMERAL=1` 继续让包装脚本注入 `codex exec --ephemeral`。

同时在 Gateway 启动、开始监听前，将 24 小时前且未被 Gateway 原生 session 引用的
rollout 从各账号 `CODEX_HOME/sessions/` 原子移动到同一 Docker volume 内的隔离区。
这样新临时 SQLite 只能看到少量近期或被引用文件，不再回填数 GB 历史。

生产验证结果：

- 三个串行 Max smoke 全部成功，临时 state 峰值约 18.8 MB；
- 两个并发 Max smoke 全部成功，两个临时目录合计峰值约 13.1 MB；
- 两套持久 SQLite 的 `threads` 行数、主文件大小和 WAL 大小在请求前后不变；
- GoldenCode 的真实 Codex App `/v1/responses` 工具调用闭环成功；
- 容器 `RestartCount=0`、`OOMKilled=false`，无锁冲突、SIGKILL 或残留预留。

## 2. 根因与生产证据

### 2.1 原始链路

```text
Max 无状态请求
  -> Gateway 创建新的请求级 sqlite_home
  -> CODEX_HOME 仍指向持久账号目录
  -> Codex CLI 扫描 CODEX_HOME/sessions 中全部历史 rollout
  -> 新 state_5.sqlite 回填约一万个 threads
  -> 单请求产生约 4–5.3 GB 临时数据库
  -> 并发请求重复放大
  -> 异常退出时残留；磁盘/内存压力进一步诱发 SIGKILL 和重启
```

现场聚合数据只读取文件元数据和 SQLite 行数，没有读取或输出提示词正文：

| 账号 | rollout 文件数 | rollout 总字节 | Gateway provider session 引用 |
| --- | ---: | ---: | ---: |
| `sub_openai_codex_dev` | 10,848 | 4,963,498,152 | 1 |
| `codex-pro-1` | 9,968 | 3,767,159,037 | 0 |
| 合计 | 20,816 | 8,730,657,189 | 1 |

一个临时 SQLite 样本的 `threads` 行数与对应账号 rollout 文件数一致，且 `threads`
表占据绝大部分物理页，证明空间来自历史回填，而非 WAL 空洞或当前请求正文。

### 2.2 为什么只保留 `--ephemeral` 不够

`--ephemeral` 防止本次运行新增持久 rollout，但不会让 Codex 忽略
`CODEX_HOME/sessions/` 中已经存在的历史文件，也不会禁止新 SQLite 从这些文件回填。
它能限制未来增长，却不能消除已有历史对新数据库初始化的影响。

### 2.3 `CODEX_GATEWAY_EPHEMERAL` 的实现陷阱

当前 adapter 根据 `runtimeStateDir` 是否存在设置 `CODEX_GATEWAY_EPHEMERAL`，不是根据
独立的 `ephemeral` 布尔值设置。直接删除临时目录逻辑会让该环境变量静默消失，
包装脚本不再注入 `--ephemeral`，无状态请求反而会持续写入 `sessions/`。

方案 A 实现时已经按评审要求解除过该耦合；但由于方案 A 被生产反证并整体回滚，
当前最终方案有意保留 `runtimeStateDir -> CODEX_GATEWAY_EPHEMERAL` 的原行为。后续如果
再次重构 adapter，仍必须把这项耦合作为强制回归测试点。

## 3. 已否决方案 A 的生产反证

commit `729dee2` 曾实施：

- 无状态请求不再创建请求级 `sqlite_home`；
- `createClient` 改用独立 `ephemeral` 布尔值；
- `--ephemeral` 保持启用；
- 本地构建与 285 项测试通过。

生产单请求 `req-0416005e-654c-43fb-bac5-1ba099c28b85` 的结果：

- 600 秒仍无响应字节，最终为 `client_aborted`；
- 主账号持久 `state_5.sqlite` 从 4,377,800,704 字节增长到
  6,563,540,992 字节；
- WAL 逻辑大小增长到 6,593,858,152 字节；
- `threads` 行数保持 10,833，说明增长发生在 Codex 内部回填/更新路径，并非只新增
  一条当前请求线程；
- 没有请求级临时目录，证明放大只是转移到共享持久状态，而非被消除。

处置：终止仅属于本次 smoke 的已知进程，释放预留，回滚到稳定 release，然后用
`a208e30` 回滚代码提交。持久 WAL 后续在无 Codex 子进程时通过
`PRAGMA wal_checkpoint(TRUNCATE)` 安全回收，系统盘可用空间约增加 6 GB。

结论：不得把“共享持久 SQLite”或“每账号固定但仍从完整 sessions 回填的 SQLite”
作为热修复。方案 B 如果仍能看到完整历史，也只会把数 GB 放大从每请求成本改成固定
初始化成本，并未解决根因数据源。

## 4. 最终实现

### 4.1 文件与启动流程

commit `e58877e` 包含：

- `scripts/archive-unreferenced-codex-rollouts.mjs`：只读规划和可回滚归档；
- `tests/archive-unreferenced-codex-rollouts.test.mjs`：安全边界测试；
- `scripts/gateway-entrypoint.sh`：Gateway 监听前运行归档；
- `Dockerfile`：把工具和入口脚本放入运行镜像；
- `compose.azure.yml`：生产启用 24 小时最小年龄和固定隔离路径。

启动顺序：

```text
容器启动
  -> entrypoint 调用归档工具 --from-env --apply
  -> 从 upstream account 配置解析 id -> CODEX_HOME
  -> 从 gateway.db 只读加载 provider_session_ref
  -> 扫描各 CODEX_HOME/sessions
  -> 生成并 fsync 0600 manifest
  -> 同卷 rename 到 codex-rollout-quarantine
  -> 启动 Gateway 并开始监听
```

生产配置：

```yaml
CODEX_GATEWAY_ROLLOUT_ARCHIVE_ON_START: "1"
CODEX_GATEWAY_ROLLOUT_ARCHIVE_ROOT: /var/lib/codex-gateway/codex-rollout-quarantine
CODEX_GATEWAY_ROLLOUT_ARCHIVE_MIN_AGE_HOURS: "24"
```

### 4.2 安全边界

工具在以下任一条件下拒绝移动：

- Gateway session 引用了未配置的上游账号；
- 任一 `provider_session_ref` 找不到对应 rollout 文件；
- `CODEX_HOME`、`sessions/`、数据库或隔离根不是预期的真实文件/目录；
- 扫描路径下出现符号链接；
- 隔离根与任一 `CODEX_HOME` 重叠；
- 隔离根与 sessions 不在同一文件系统，无法保证原子 rename；
- 文件从规划到移动之间的 inode、设备号、大小或 mtime 发生变化；
- 目标文件或 manifest 已存在。

始终保留：

- 所有被 Gateway `provider_session_ref` 引用的 rollout；
- 24 小时内更新的 rollout；
- `auth.json`、`config.toml`、SQLite、Gateway DB 和其他非 JSONL 文件；
- 无法明确分类的对象。

归档清单只记录路径、账号、大小和 mtime，不记录或打印 JSONL 内容。清单权限为
`0600`。启动阶段不删除文件。

### 4.3 失败策略

单次归档内部是 fail-closed：安全检查失败时不继续移动候选文件。入口脚本记录明确
warning，但允许 Gateway 启动，避免一次历史引用异常直接造成整个生产入口不可用。
因此运维必须对 `Codex rollout startup archive failed` 设置告警；出现该日志时应暂停
高并发 Max 流量并人工处理，而不是忽略。

如果移动过程中发生极少见的部分失败，已 fsync 的 manifest 保留完整计划；已移动
文件仍在同卷隔离区，未移动文件仍在原路径，可依据清单恢复或继续处置，不会删除。

## 5. 生产实施记录

### 5.1 上线前 dry-run

2026-07-13 dry-run 结果：

| 分类 | 文件数 | 字节数 |
| --- | ---: | ---: |
| 总 rollout | 20,816 | 8,730,657,189 |
| 被引用并保留 | 1 | 29,537 |
| 24 小时内并保留 | 56 | 13,536,352 |
| 候选 | 20,759 | 8,717,091,300 |

dry-run 的引用数、候选数和字节数与此前独立只读盘点一致。

### 5.2 启动归档

新 release：`/home/qian/codex-gateway-release-e58877e-20260713T123104Z`。

容器启动时成功移动 20,759 个候选文件、8,717,091,300 字节，生成：

```text
/var/lib/codex-gateway/codex-rollout-quarantine/
  manifest-20260713T123334217Z.json
```

归档后源目录计数：

- 主账号：16 个（1 个引用文件 + 15 个新文件）；
- Plus 账号：41 个新文件；
- 隔离区：20,759 个 rollout。

### 5.3 功能与并发验证

VM 和本地均完成 `npm run build`；完整测试为 16 个 test files、292/292 tests passed。

公开 Max smoke：

- 普通非流式：`req-ab49e97e-b522-457d-8dd5-5d0bf2301f9d`；
- 工具历史：`req-86f76f49-1f69-4a08-bc46-f3d6e102d59d`；
- 流式：`req-3b89ec58-88d5-464a-a51d-9edf41b3763c`；
- 三项均成功；临时 state 峰值 18,812,928 字节、最多 1 个目录。

双 Max 并发：

- `req-cec28f11-b379-4c10-a265-1437c163b421`；
- `req-ac012337-c103-40b0-be3e-726d9f3df91a`；
- 两项均成功；临时 state 合计峰值 13,119,488 字节、最多 2 个目录；
- 远低于评审设定的 512 MiB 暂停阈值；
- 无 `database is locked` 或其他 SQLite 错误。

GoldenCode：使用临时 `cgu_live` key 和真实 Codex CLI，以
`https://gw.instmarket.com.au/v1`、`wire_api="responses"`、`model="goldencode"`
完成一次 `shell_command` 及工具结果后续回合，exit code 0。临时 unified key、backing
Gateway key 和测试用户均已清理。

### 5.4 持久状态前后对比

| 数据库 | smoke 前 threads | smoke 后 threads | 主文件前后 | WAL 前后 |
| --- | ---: | ---: | ---: | ---: |
| 主账号 | 10,833 | 10,833 | 6,563,639,296 B（不变） | 0 B（不变） |
| Plus | 9,930 | 9,930 | 4,941,266,944 B（不变） | 0 B（不变） |

最终现场：

- 容器 healthy，`RestartCount=0`，`OOMKilled=false`；
- 无 Codex 子进程、无临时 state 目录、无 active token reservation；
- 启动后日志未出现 SIGKILL、aborted、OOM 或 archive failure；
- 根分区约 123 GB，已用 82 GB，可用 42 GB，使用率 67%。

## 6. 效果与边界

本方案已经消除“每个请求重复索引 8.7 GB 历史 rollout”的触发条件，但需准确理解：

- 同卷 rename 不会释放隔离文件本身的 8.72 GB；它的直接作用是让 Codex 初始化时
  看不到这些文件，并保留可回滚能力；
- 本次约 6 GB 的真实空间回收来自残留 WAL checkpoint；
- 两个持久 `state_5.sqlite` 仍合计约 11.5 GB，本次没有删除线程或 VACUUM；
- 隔离区暂未删除，需经过观察期、恢复抽查和独立批准后才能真正释放 8.72 GB；
- 启动清扫不是持续定时任务。原生 session 产生的新 rollout 在超过 24 小时后，需
  下次容器启动才会进入归档评估；无状态请求因 `--ephemeral` 不应新增 rollout；
- 原生 session resume 的唯一现有引用文件已保留，但上线验证重点是无状态 Max 和
  GoldenCode；删除隔离区前仍应做一次该原生 session 的恢复抽查。

## 7. 回滚与恢复

代码回滚可重新部署稳定 release：

```text
/home/qian/codex-gateway-release-a67b56a-20260713T095100Z
```

代码回滚不会自动把隔离 rollout 移回 `sessions/`。如需恢复历史文件：

1. 停止 Max/Codex 请求并确认没有 Codex 子进程；
2. 保留隔离目录和 manifest 副本；
3. 逐条按 manifest 的 `destination -> source` 反向 rename；
4. 目标已存在、源路径越界或文件元数据不符时停止，不覆盖；
5. 恢复后先验证被引用的原生 session，再恢复流量。

不得复制/软链接 `auth.json`，不得删除整个 `CODEX_HOME`，不得直接手工修改 Codex
内部 `threads` 表。

## 8. 后续待审核事项

- [ ] 观察至少一个稳定窗口，确认 Max 临时 state 继续保持在 512 MiB 以下。
- [ ] 对已保留的原生 `provider_session_ref` 做 resume 抽查。
- [ ] 为启动日志中的 archive failure、SIGKILL、OOM 和容器重启增加告警。
- [ ] 审核隔离区保留期限和最终删除步骤；删除前保留 manifest 并完成恢复抽查。
- [ ] 独立设计持久 `state_5.sqlite` 的离线重建/压缩，不在运行中删表或 VACUUM。
- [ ] 将“双 Max 并发 + 临时 state 峰值”加入 Codex CLI 升级回归。

## 9. 最终决策

- [x] 否决共享持久 SQLite 的方案 A，生产反证已记录。
- [x] 保留请求级临时 SQLite 和 `--ephemeral`。
- [x] 通过引用保护、24 小时 grace、同卷隔离和 manifest 控制历史 rollout 可见集。
- [x] 启动阶段不删除 rollout，不触碰认证文件和 Gateway DB。
- [x] 512 MiB 验收阈值已通过。
- [ ] 隔离区删除和持久 SQLite 重建另行审核。
