# GoldenCode 最终错误停止自动重试契约

日期：2026-09-07。实现与本地验证完成，生产发布验收记录随后补充。

## 问题与证据

客户端报告同一次操作在 Gateway 超时后发送三个 HTTP 请求。现有错误分类
`retryable: true` 无法表达 Gateway 已结束本次供应商故障处理。
客户端 `2.0.0-beta.69.local.1` 于北京时间 13:39:04–13:39:15，用测试插件为真实响应
补入下述两个字段后，支持码 `T:EEC49015` 只产生一个 HTTP 请求，自动重试预算消耗为 0。
插件没有增加响应头；触发条件是请求头 `x-medcode-request-timeout-ms: 1`。

R760 已核实请求 `req-0934a784-cf59-441c-90ce-10b215f2f1db`：
`upstream_timeout`，腾讯实际调用 1 次。原服务器响应缺少停止自动重试字段。

## 冻结的响应契约

保持真实 HTTP 状态、错误码、`retryable` 分类和 `x-request-id`，只在最终 `error` 对象增加：

```json
{
  "error": {
    "message": "MedCode service timed out.",
    "type": "server_error",
    "code": "upstream_timeout",
    "param": null,
    "retryable": true,
    "request_id": "req-example",
    "retry_contract_version": 1,
    "automatic_retry_allowed": false
  }
}
```

版本必须是数字 `1`，允许标记必须是布尔值 `false`。没有新增响应头。
客户端停止当前模型请求的自动恢复与重试；此标记优先于 502/503/504、SDK 可重试分类及
Retry-After。用户之后明确重新执行仍按新请求准入。

覆盖 `/v1/chat/completions` 与 `/v1/responses` 的非流式和流式：

- 尚未输出响应头时保留原 HTTP 错误状态及 JSON 错误体。
- Chat 已开始 SSE 时只发送一个 `data: {"error": ...}`，不再发送成功 `[DONE]`。
- Responses 已开始 SSE 时在 `response.failed` 的 `response.error` 内携带相同字段，
  不发送 `response.completed`。

## 设置范围

沿用已启用的 GoldenCode P0 范围：目标腾讯／天宽池、文本请求、已命中启用开关及用户范围。
在最终错误序列化中设置字段，适用于总超时、供应商失败后没有备选、实际调用预算耗尽、
无可用池成员，以及不完整／空上游响应等最终服务错误。上游 429 也带停止标记；
Gateway 自身请求、并发或 token 配额限流保留原限流契约。

上下文压缩、输出截断及工具参数变换恢复继续使用各自契约，不增加本次停止标记，
也不使用 `recovery_owner=client` 表达供应商失败。成功响应不带停止标记，内部失败尝试
不提前发送给客户端。没有新增重试器、数据库字段或配置开关。

字段不承诺实际发生两次供应商调用；腾讯单链路无备选时可以只有一次。
未命中 P0 的模型／请求继续原行为。忽略新增字段的旧客户端仍可能自行重试，
Gateway 单请求预算不能保证其整个用户轮次最多两次供应商调用。

## 验证

本地 3 个相关文件共 301 项测试通过，`npm run typecheck` 和 `git diff --check` 通过。
包含 Chat／Responses × 流式／非流式 × 文本／工具的双失败、总期限、天宽禁用场景，
以及已交付文本后的单个 SSE 错误。断言真实供应商调用数、终态字段类型、request ID、
没有成功终止帧、成功与变换恢复不被误标记。安装包的最终复验仍需客户端关闭测试插件后执行。

生产保持腾讯单链路，天宽停用；真实双供应商公网切换仍待付费恢复后补验。
