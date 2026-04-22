# OpenAI Codex Adapter 方案

本文以 ChatGPT/Codex 订阅作为 MVP 第一 provider 示例。

## 官方资料结论

官方文档显示：

- Codex CLI 可以通过 ChatGPT 订阅或 API key 登录。
- Codex CLI/IDE 的 ChatGPT 登录会缓存本地凭据，活跃使用时会自动刷新。
- Codex SDK 可在服务端程序中控制本地 Codex agent。
- Codex App Server 暴露 account、thread、rate limit 等 JSON-RPC 能力，并支持 ChatGPT 登录、device-code 登录和实验性的外部 ChatGPT token 模式。

参考：[docs/references/openai-codex-docs.md](../references/openai-codex-docs.md)

## MVP 推荐路径

优先验证 `Codex App Server` 路径：

```text
Gateway process
  -> provider-codex adapter
    -> local Codex app-server / SDK
      -> CODEX_HOME=/var/lib/codex-gateway/codex-home
        -> ChatGPT subscription auth cache
```

设计理由：

- ChatGPT subscription 登录态只在 Azure VM 的服务用户目录中。
- 终端客户端只拿 gateway access credential。
- App Server 已暴露 account/rateLimits/thread 类接口，适合映射 adapter contract。
- 若后续需要 CI/API key 路径，可以增加 `provider-openai-api` 或在 adapter 内拆 auth mode。

## 服务端凭据目录

Azure VM 上固定：

```text
/var/lib/codex-gateway/
  gateway.db
  codex-home/
    auth.json or OS credential backing store
```

约束：

- `codex-home` 归 `codexgw` 服务用户所有，权限 `0700`。
- 不进入 Git、不进入日志、不打包到 release artifact。
- 管理命令只展示 auth mode、account email hash、plan type、rate-limit 摘要，不展示 token。

## Adapter 能力映射

| Gateway adapter | Codex path |
| --- | --- |
| `health` | `account/read` + 最短 no-op 状态检查 |
| `refresh` | `account/read(refreshToken=true)` 或捕获 401 后触发重新授权 |
| `create` | start/resume Codex thread |
| `message` | run thread prompt，转换增量事件 |
| `list` | 若 Codex thread history 可枚举则映射；否则使用网关 Session Store |
| `cancel` | App Server/SDK cancel |
| `normalize` | 401 => `provider_reauth_required`，429 => `rate_limited` |

## Phase 0 风险

| 风险 | 处理 |
| --- | --- |
| ChatGPT subscription auth cache 不适合长驻服务端托管 | 改用 OpenAI API key provider 做 MVP，Codex adapter 留作本地 code scope |
| App Server thread/list 能力不足 | 网关侧保存 `providerSessionRef` 和消息上下文 |
| Codex 输出事件不是稳定公开合同 | 只依赖官方 SDK/App Server 暴露的稳定层；不解析私有缓存文件 |
| Scope 无法限制 Codex 本地工具 | `medical` scope 不走 Codex 工具执行路径；`code` scope 才允许 Codex local agent |

## 重要边界

本 adapter 不绕过 ChatGPT/Codex 登录流程，不复制用户浏览器 cookie，不解析非公开 token 格式。Phase 0 只验证官方支持的 CLI/SDK/App Server 集成面。

