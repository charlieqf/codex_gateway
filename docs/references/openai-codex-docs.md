# OpenAI Codex 官方资料摘记

本页记录 2026-04-22 设计时核验过的官方资料，方便后续追溯。具体实现前仍应重新核验当前文档。

## 资料

- Codex CLI: https://developers.openai.com/codex/cli
- Codex Authentication: https://developers.openai.com/codex/auth
- Codex SDK: https://developers.openai.com/codex/sdk
- Codex App Server: https://developers.openai.com/codex/app-server
- Using Codex with your ChatGPT plan: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan/
- OpenAI Docs MCP: https://developers.openai.com/learn/docs-mcp

## 对本项目有影响的结论

- Codex CLI 可用 ChatGPT subscription 登录，也可用 API key 登录。
- ChatGPT Plus、Pro、Business、Edu、Enterprise 等计划包含 Codex；实际 rate limit 依计划变化。
- Codex CLI/IDE 会缓存登录信息；文件型缓存含 access token，必须按密码处理。
- ChatGPT 登录路径会在活跃使用时自动刷新 token，但服务端长期托管能力仍需 Phase 0 实测。
- Codex SDK 可由服务端 TypeScript 程序控制本地 Codex agent。
- Codex App Server 暴露 account login/read、rateLimits/read、thread/run 等 JSON-RPC 能力，是 provider adapter 的优先验证入口。

