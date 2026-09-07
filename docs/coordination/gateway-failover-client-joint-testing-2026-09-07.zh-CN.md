# Gateway 上线后客户端联调说明

可直接转发：

Gateway 已上线 `b4fbed4`，公网文本、工具调用、Chat Completions／Responses 的流式及非流式请求、参数错误和总超时返回均已自测通过，用量记录一致。当前 `goldencode` 仍只启用腾讯 GLM-5.3，天宽等待付费后恢复，真实跨平台切换需届时补测。请客户端安排实际安装包联调：确认流式回复完整、每轮只处理一次最终状态；取消能中止 HTTP 请求且不会自动重启；只有收到完整有效的工具调用后才执行 Shell/write，并验证重复事件、断线恢复不会重复执行本地操作；总超时与 Gateway 请求期限衔接，避免叠加无界重试。异常请附客户端版本、支持码／turn ID、session/message/tool-call ID、Gateway `x-request-id`、发生时间及本地工具是否已经执行。供应商切换由 Gateway 负责，客户端继续请求 `goldencode`，无需自行选择腾讯或天宽。

联调地址：`https://goldencode.instmarket.com.au:1443/v1`。

验证边界：本次公网自测确认腾讯单链路及工具调用合同，未验证真实客户端本地副作用，也未验证
腾讯／天宽两家之间的实际公网切换；当前额度冷却 P1 未启用。
请求证据、当前开关和回滚说明见[发布记录](../operations/goldencode-failover-release-2026-09-07.zh-CN.md)。
