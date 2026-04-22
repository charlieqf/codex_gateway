# Runbook Index

MVP 运维流程将按以下顺序补齐：

当前状态和访问方式：

1. [System Status](./system-status.md)
2. [Environment Access](./environment-access.md)
3. [Operational Experience](./operational-experience.md)

MVP 运维流程待补齐：

1. Azure Ubuntu VM 首次部署。
2. ChatGPT/Codex provider 重新授权。
3. Access credential 签发。
4. Access credential 应急吊销。
5. Access credential 例行轮换。
6. SQLite 备份与恢复。
7. Gateway 升级与回滚。
8. 性能测量和首包延迟记录。

当前详细部署草案见：[azure-ubuntu-vm.md](./azure-ubuntu-vm.md)
共享 VM 非侵入操作规则见：[safe-vm-testing.md](./safe-vm-testing.md)

本机 Codex 已创建 `codex-gateway-ops` skill，用于后续自动加载运维流程和本机私有访问细节。该 skill 不提交到仓库。
