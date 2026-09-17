# Repository workflow

## One main branch and one development worktree

- The sole development worktree is `C:\work\code\codex-gateway` and its branch
  is `main`. Keep `origin/main` as its upstream.
- Do not create additional branches, Git worktrees, or development clones for
  implementation, review, release preparation, or concurrent agent work unless
  the user explicitly approves an exception.
- Before changing files, inspect the current branch, `git status`,
  `git worktree list`, and the relationship between `main` and `origin/main`.
  Fetch before integrating remote changes or preparing a release; a cached
  remote-tracking ref is not proof of the current remote state.
- If main has diverged, preserve uncommitted work and reconcile the existing
  main in place. Do not solve divergence by silently opening another worktree,
  replacing the checkout, rewriting history, or discarding changes.
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
- Historical build snapshots, temporary artifacts, immutable release staging
  directories, and production release directories are not development worktrees.
  Do not use them for ongoing development or delete them without checking scope
  and recovery needs.

## Release discipline

- Follow the `codex-gateway-ops` skill and the component runbook for Gateway
  operations. Reconcile local main, current origin/main, and the actual deployed
  revision before preparing a deployment; production must not contain fixes
  missing from the proposed release.
- Main may be ahead of production. Never weaken production configuration to
  make stale local code start, and never silently overwrite deployed fixes.
- Deploy only an approved, tested, committed revision from main using a clean,
  immutable release artifact and the controlled backup/verification procedure.
  Do not deploy the dirty development tree.
- Consolidating this repository does not by itself authorize pushing commits,
  deploying, restarting services, or changing production data.
