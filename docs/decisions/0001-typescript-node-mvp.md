# ADR 0001: MVP 使用 TypeScript + Node.js

## 状态

Accepted

## 背景

MVP 的关键不在高吞吐，而在 provider 可行性验证、HTTP/SSE 网关、JSON-RPC/SDK 包装、CLI 管理工具和类型化 adapter 合同。

OpenAI Codex SDK 当前以 TypeScript server-side 使用路径最直接，本机也已具备 Node.js/npm/Codex CLI。

## 决策

MVP 使用 TypeScript + Node.js + npm workspaces。

## 影响

- Phase 0 可以直接验证 `@openai/codex-sdk` 和 Codex App Server。
- Gateway、Admin CLI、adapter contract 共用同一套类型。
- Azure Ubuntu VM 部署默认使用 Docker Compose；systemd 负责管理 compose 生命周期。
- 若后续 streaming proxy 成为性能瓶颈，可把局部组件迁移到 Rust；不在 MVP 前置。
