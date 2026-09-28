# Gateway 模型调用回执与恢复 v1

状态：2026-09-28 实现与修复随本次提交交付，尚未上线。适用于 SQLite Gateway；没有 SQLite 回执存储的实例不提供此能力。

## 请求与能力识别

客户端在 `POST /v1/chat/completions` 中携带 `X-MedCode-Call-Id: <13位Unix毫秒时间戳>_<UUID>`，并在发送前将 ID 持久化到本次模型步骤。每个新逻辑步骤使用新 ID；不确定结果时先查询原 ID。该协议不覆盖 `/v1/responses`、图片上传或其他端点。

正常经过回执准入的 POST 响应返回：

```text
X-MedCode-Model-Call-Contract-Version: 1
X-MedCode-Call-Id: <原调用ID>
```

版本头表示实例支持协议，不是模型成功或回执一定可恢复的证明。查询接口也返回版本头；鉴权、HTTP 解析、版本门禁或回执限流等前置拒绝可能没有 POST 接受头。旧实例忽略请求头、查询返回 404/405 时，客户端不得假定原请求未执行，也不得据此自动换 ID 重发。

同 ID 的键空间是 `(subject_id, scope, call_id)`。同主体、同 scope 的有效新凭据可以读取旧凭据的回执；不同主体或 scope 查询都返回 unknown，不泄露记录信息。所有接口继续执行正常鉴权。

## 查询与状态

`GET /gateway/model-calls/:id` 使用正常 Bearer 鉴权，成功查询返回 HTTP 200，响应禁止缓存：

```json
{
  "version": 1,
  "id": "<call_id>",
  "state": "completed",
  "request_id": "<原模型请求request_id>",
  "response": {
    "status": 200,
    "headers": {"content-type": "text/event-stream; charset=utf-8"},
    "body": "data: ...\n\ndata: [DONE]\n\n"
  }
}
```

`response` 是存储的原响应，不是新的模型输出。JSON 回包保存 JSON 文本；SSE 保存数据/事件帧，省略无语义的 heartbeat 注释。保留内容类型、原 request ID、MedCode 协议头、Retry-After 和 Gateway 限流类型/来源。查询响应自身的 `x-request-id` 标识本次查询，JSON 内的 `request_id` 与 `response.headers.x-request-id` 标识原调用。

| state | 含义 | 客户端动作 |
| --- | --- | --- |
| running | 当前进程仍持有执行中的调用 | 在任务剩余预算内轮询 |
| completed | 成功终态且原响应可回放 | 消费原结果，不重复调用模型 |
| failed | 明确失败且原响应可回放 | 按原错误契约和重试预算处理 |
| unknown | 没有回执，或因断连、进程退出、写入失败、容量限制等无法确认/恢复 | 不把它当成未执行，不自动换 ID 重做 |
| expired | 已过回执保留期 | 明确提示旧结果无法恢复，不用原 ID 重做 |

HTTP 200 的 SSE 也可能包含终态错误，这时查询状态是 `failed`，`response.status` 仍保留 200。不得只靠 HTTP 状态判断模型成功。客户端恢复后仍需通过自身的消息/工具调用记录防止重复消费，尤其不能再次执行已经产生副作用的工具。

同 ID POST 不会重新进入模型执行：completed/failed 回放原响应；running 返回 409 `model_call_pending`；unknown 返回 409 `model_call_unconfirmed`；expired 返回 409 `model_call_expired`。这些协议错误携带 `retry_contract_version: 1` 和 `automatic_retry_allowed: false`。明确失败后是否允许使用新 ID 发起新调用，取决于原错误的契约和任务预算，不由 failed 状态单独决定。

## 指纹约束

同 ID POST 必须保持执行语义一致，否则返回 409 `model_call_conflict`。JSON 对象字段顺序不影响指纹，数组顺序仍有意义。完整正文参与绑定，包括模型、消息、工具、生成参数及图片引用；不会擅自忽略图片签名 URL 的变化。

以下请求头参与指纹：

- `x-medcode-request-timeout-ms`
- `x-medcode-vision-recovery-contract`
- `x-medcode-client-capabilities`
- `x-medcode-client-session-id`、`x-medcode-client-turn-id`
- `x-medcode-write-delivery-version`、`x-medcode-write-delivery-schema-sha256`
- `x-medcode-write-delivery-nonce`、`x-medcode-write-delivery-limits`

session/turn ID 与文件交付 manifest 绑定，不能当作普通日志头忽略。客户端版本、message ID、turn code 等纯观测头和鉴权凭据不参与指纹。新增影响执行的协议头时，Gateway 必须同步更新白名单和测试。

## 限流、存储和中断

带 call ID 的 POST 在正常鉴权后先通过独立回执流量保护，再查询/原子准入；只有新调用继续进入模型频次、并发和 token 准入。缓存回放、冲突、状态查询不占模型额度。新调用若被模型限流拒绝，原 429 会保存为 failed；同 ID 回放仍是该 429，不会在限流恢复后偷偷执行。没有 call ID 的请求保持原流程。

回执准入、回放和查询共享每主体每分钟 120 次、每 UTC 日 10,000 次、短操作并发 4 的保护。新调用在数据库准入完成后释放回执并发，不会在模型执行期间占住查询槽。429 `model_call_query_limited` 返回实际限流窗口计算的 `Retry-After`；客户端应遵守，并同时受任务总 deadline 约束。回执保护本身的拒绝不创建新回执。

新 ID 时间戳必须处于服务端当前时间的前 5 分钟至后 1 分钟窗口内；已存在的 ID 不再做新调用时间窗口校验。客户端应在实际模型步骤准备发送时创建 ID，保持机器时钟正确。

回执从准入起保留 24 小时，之后清除响应并保留约 7 天墓碑；每分钟清理一次。旧 ID 即使墓碑清除，也不能越过新 ID 时间窗口重新执行。单条序列化回执上限 8 MiB，全局响应存储预算 256 MiB；JSON 转义和头信息也占预算。超过限制会保留防重记录并报告 unknown，而不是删除记录允许重做。当前 unknown 没有进一步细分的公共 reason 字段，不保证所有合法模型输出都能恢复。

原子准入写入失败时，模型不会执行。终态回执写入失败时，Gateway 记录错误并尽力完成原响应传输；原已准入记录仍阻止同 ID 重做，查询表现为 unknown。模型执行仍绑定连接生命周期；断连不意味着任务会继续在后台完成。进程退出后遗留的 running 记录按 unknown 处理。

成功 DONE 和明确失败的终态响应在交付终止帧/错误 JSON 前保存。日志关联 call ID、原 request ID、回放及持久化状态，不打印响应内容。这里保证的是逻辑调用的重复准入受控，Gateway 内部的双平台重试和客户端工具副作用各有独立的责任边界。

## 发布顺序

先按 Gateway 发布流程部署、验证协议，再发布依赖能力的客户端。migration 36 追加独立表；部署前执行数据库备份和迁移演练。保留期属于在线回执逻辑，不等于数据库备份和磁盘页同步擦除。回退到不支持协议的旧服务时，客户端应回到 unknown 的保守处理；不得借回退自动重发未确认的调用。
