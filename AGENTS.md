# Repository workflow

## 代码偏好

- 简洁、逻辑清晰、无冗余；防御性检查与 fallback 应有明确的边界或兼容需求，避免过度防御、层层兜底、吞错和静默降级。
- 从根因、完整流程和整体设计出发，在正确职责层做最小充分修改；避免局部堆叠补丁、特判或重复补偿。
- 尽量避免自行扩大实施范围，围绕用户明确目标做最小充分实现；除非有明确指示，不擅自新增权限控制、审批、流程、审计、安全特性等设计，也不以“最佳实践”“顺手完善”或假设性风险为由扩展需求。

## 软件工程与开发效率偏好

- 验证范围与改动影响相匹配，优先运行相关模块的定向测试、类型检查或构建；仅在跨模块影响、实际风险、明确的 CI／发布要求或用户要求下扩大到全仓测试和全仓门禁。
- 文档、注释及低风险可逆修改优先通过阅读差异、格式和引用检查验证；不为测试而测试，不编写只复述实现的测试。
- 同一版本、环境和相关输入未变化时，复用已通过的验证结果；只有新改动、失败或未解决的问题才触发重跑或扩大检查。优先增量构建和有效缓存，避免无故 clean、重装依赖或重复构建。
- 避免不必要的 SHA-256 校验和全仓、大目录散列扫描。普通修改核对使用定向 diff、Git 状态或直接内容检查；仅在产物交付完整性、安全要求或备份恢复确有需要时使用散列校验。
- 构建前后主动清理本次任务相关、确认未被占用且可重新生成的旧构建产物和临时文件，节省磁盘空间；删除前核实目标绝对路径及范围，保留用户文件、正在使用的产物、必要回滚版本和恢复备份，避免批量清空仍有效的缓存。
- 优先使用现有脚本、工具和局部命令，批量处理独立检查；不为小改动新增验证框架、重复备份、大量过程报告或额外审批流程。已获授权且范围明确的可重建产物清理无需反复确认。
- 每项检查都应回答与当前改动有关的具体问题；必要检查通过且实际目标已验证后及时收尾，不以增加步骤或反复自证代替工程判断。

## Task entry points

- Use the task-specific fast path in `codex-gateway-ops` for Gateway operations.
  For other procedures, use `docs/operations/runbook-index.md`. Read
  `docs/operations/system-status.md` when current-state evidence is needed;
  its recorded verification does not replace a required live check.
- For a recent 12/24-hour review, start with the fixed read-only command in
  `docs/operations/gateway-service-review.zh-CN.md` and follow its counting rules.
- `docs/README.md` maps active contracts and open work. `docs/archive/` holds
  dated evidence; historical releases, quotas and host states are not current facts.

## One main branch and one development worktree

- The sole development worktree is `C:\work\code\codex-gateway` and its branch
  is `main`. Keep `origin/main` as its upstream.
- Additional branches, development worktrees or development clones require
  an explicit user-approved exception.
- Before changing files, inspect the current branch, `git status`,
  `git worktree list`, and the relationship between `main` and `origin/main`.
  Fetch before integrating remote changes or preparing a release; a cached
  remote-tracking ref is not proof of the current remote state.
- Reconcile divergence on the existing main in place, preserving uncommitted
  work and history; do not replace the checkout to obtain a clean tree.
- Serialize Git mutations and overlapping edits across sessions sharing this
  worktree. Recheck status before committing or removing anything.

## Preserve work and keep changes scoped

- Existing tracked and untracked changes belong to the user. Inspect them and
  preserve unrelated changes; do not sweep them into a commit with `git add -A`.
- Before integration that requires a clean tracked tree, make a verified,
  recoverable backup outside the repository. If a scoped stash is necessary,
  retain it until the restored work has been verified.
- Never use `git reset --hard`, force-remove a dirty worktree, or force-delete
  an unmerged branch to achieve a clean status.
- Use private archives or Git bundles for recovery copies, not backup branches
  or additional development worktrees. Protect backups that contain credentials
  or user data. Do not print their contents.
- Build snapshots, temporary artifacts and immutable release directories are
  not development worktrees; check scope and recovery needs before deleting them
  and do not use them for ongoing development.

## Release discipline

- Before preparing a deployment, reconcile local main, freshly fetched
  origin/main and the actual deployed revision. Include deployed fixes in the
  candidate; never weaken production configuration to accommodate stale code.
- Deploy only an authorized, tested, committed revision from main using a clean,
  immutable artifact. Follow `docs/operations/container-deploy.md` and the relevant
  component runbook for backup, deployment and verification.
- Repository edits alone do not authorize pushing, deploying, restarting services
  or changing production data; use the authorization actually given for the task.
