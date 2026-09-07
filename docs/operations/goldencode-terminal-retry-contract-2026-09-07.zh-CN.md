# GoldenCode 最终错误停止自动重试契约

日期：2026-09-07。修复 `840f287b14a9fa7da546dc1213e19e05574bee69` 已推送并上线，
北京时间 14:05 部署完成；服务器原始公网响应已验收。

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
不完整／空上游响应等最终服务错误。上游返回的 429 也带停止标记；
尚未调用上游时的池繁忙，以及 Gateway 自身请求、并发或 token 配额限流保留原限流契约。

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

## 生产发布及公网验收

- current：`840f287b14a9fa7da546dc1213e19e05574bee69`。
- previous：`b4fbed48f9df36ca5bba70be0590997cbac23b4b`。
- 镜像：`sha256:c5b36121831f0ae4e24ef93e3cf49ccffd5ad7d22c71380483a9574ec7cffa98`。
- 证据及配置／数据库备份：`/opt/codex-gateway-r760/backups/terminal-retry-840f287`。
- 从不可变 Git 归档构建，干净 Linux 构建中相同 301 项测试通过（15.37 秒）。
- 已验证配置文件哈希、容器环境和 Research／Mihomo／Qwen 容器 ID 均保持不变，仅重建 Gateway。
- 最终 06:09:11 UTC 检查：Gateway healthy、重启计数 0、schema 27、SQLite quick_check 正常、
  外键违规 0；工作站访问公网 health 为 ready。两批测试账号 disabled、凭据撤销、未结算预留 0，
  撤销凭据访问返回 401，日志未出现测试凭据。

测试直接读取公网 HTTPS 响应，没有插件或客户端补字段。四个工具超时请求均发送
`x-medcode-request-timeout-ms: 1`，严格断言新增字段为数字 `1` 和布尔 `false`，
原 `retryable: true` 及 request ID 保留，没有成功终止帧。

| 场景 | 结果／实际上游尝试 | Gateway request ID |
| --- | --- | --- |
| Chat 非流式工具，总期限 1 ms | 504／0 次 | `req-2c00d2b2-60a2-43b2-9d8d-f4f04ccc25d8` |
| Chat 流式工具，总期限 1 ms | 响应头前 504 JSON／0 次 | `req-6dc21e8f-df99-492d-b286-c00b72789d1a` |
| Responses 非流式工具，总期限 1 ms | 504／1 次 | `req-20a47a26-720d-4ff1-a739-bf7c823b002f` |
| Responses 流式工具，总期限 1 ms | 200 SSE 单个 response.failed／1 次 | `req-5df23077-048c-4139-9cdb-086ac2a65efe` |
| Chat 非流式工具成功 | 200／腾讯 1 次 | `req-bbe3c1d7-72ba-4b35-a738-2cfcc80c54fc` |
| Responses 流式工具成功 | 200／腾讯 1 次 | `req-145d23f3-e094-45d1-90c5-109b5e0a0299` |

两个成功请求均只交付一个有效 multiply 调用，无停止标记，用量与请求事件、预留结算一致。
本次没有执行真实客户端 Shell/write，也不代替关闭插件后的安装包 HTTP 请求数验收。

初轮普通文本总期限测试也通过：`req-969a4580-0002-4870-90c8-b528f8478302` 返回 504、
两个停止字段、腾讯 1 次尝试。随后请求 `req-835eac4c-1d54-4d0a-a7d7-b8bbe69c71b4`
在上游派发前返回池繁忙 429、0 次调用，因此初轮整体未通过，结果保存在 `public-smoke.json`。
代码核对显示普通文本总期限错误会进入现有账号冷却；这不是本次字段缺失的修复范围。
冷却结束后完成上述 6 项复验，见 `public-smoke-final.json`。没有把 429 算作超时验收通过。
其他证据为 `deployment.json` 和 `final-audit.json`。

当前模型总期限为 600000 ms。请求头 `x-medcode-request-timeout-ms` 可指定 1–900000 ms，
实际取请求值与配置期限的较小值；同一 Gateway 请求内切换不重置期限。SSE 每 25 秒发
`:ping` 注释，心跳不是正文或成功终态。1 ms 仅用于验收，不应作为客户端正常请求配置。

回滚使用备份记录中的上一发布和镜像，仅重建 Gateway；不恢复数据库覆盖新增业务记录。
回滚代码会失去此次停止字段；天宽保持禁用。
