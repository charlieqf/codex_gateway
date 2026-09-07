# Gateway 上线后客户端联调说明

2026-09-07 终态契约补充（优先按本段复验）：

Gateway 已上线 `840f287`，超时等供应商最终错误现在由服务器直接返回
`error.retry_contract_version: 1`（数字）及 `error.automatic_retry_allowed: false`（布尔值），
保留原 `retryable: true`、HTTP 状态及 request ID，没有新增响应头。公网已验证 Chat／Responses
流式和非流式工具请求的 1 ms 总超时，以及正常工具调用成功时不带停止标记。
请关闭补字段测试插件，用 `2.0.0-beta.69.local.1` 按原条件复测，确认一次操作只有一个 HTTP 请求、
自动重试预算消耗为 0；附支持码及 Gateway request ID 回传。可对照服务器原始 504 样本
`req-20a47a26-720d-4ff1-a739-bf7c823b002f`。
详细范围、初轮池繁忙结果及复验证据见[终态契约及发布记录](../operations/goldencode-terminal-retry-contract-2026-09-07.zh-CN.md)。

常规安装包联调范围：

Gateway 已上线 `840f287`；此前 `b4fbed4` 的公网文本、工具调用、Chat Completions／Responses 流式及非流式请求、参数错误和总超时返回已自测通过，本次补齐停止自动重试字段。当前 `goldencode` 仍只启用腾讯 GLM-5.3，天宽等待付费后恢复，真实跨平台切换需届时补测。请客户端安排实际安装包联调：确认流式回复完整、每轮只处理一次最终状态；取消能中止 HTTP 请求且不会自动重启；只有收到完整有效的工具调用后才执行 Shell/write，并验证重复事件、断线恢复不会重复执行本地操作；总超时与 Gateway 请求期限衔接，避免叠加无界重试。异常请附客户端版本、支持码／turn ID、session/message/tool-call ID、Gateway `x-request-id`、发生时间及本地工具是否已经执行。供应商切换由 Gateway 负责，客户端继续请求 `goldencode`，无需自行选择腾讯或天宽。

联调地址：`https://goldencode.instmarket.com.au:1443/v1`。

验证边界：本次公网自测确认腾讯单链路及工具调用合同，未验证真实客户端本地副作用，也未验证
腾讯／天宽两家之间的实际公网切换；当前额度冷却 P1 未启用。
请求证据、当前开关和回滚说明见[发布记录](../operations/goldencode-failover-release-2026-09-07.zh-CN.md)。
