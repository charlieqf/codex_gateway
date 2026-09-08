# Gateway 异常流统计及超时分类修复

日期：2026-09-08。状态：修复 `6640d0e` 已于北京时间 19:11 部署 R760，19:19 完成验收。详见[发布记录](../operations/r760-timeout-observability-release-2026-09-08.zh-CN.md)。

## 修复结果

腾讯等 OpenAI-compatible 上游在响应流中超时、断开或出现无效 JSON 时，现在保留已收到的 HTTP 状态、安全过滤后的上游请求 ID、已处理 SSE 数据的长度/哈希，以及数值形式的流进展记录。异常摘要不会再退回只有 67/71 字符的标准化错误事件。

每次上游尝试的 `streamProgress` 包括：

- `responseBytes`、`responseChunks`：适配器从响应体读取的字节和数据块数量，包括保活或尚未拼成完整 SSE 帧的数据。
- `firstResponseByteMs`、`lastResponseByteMs`：本次上游调用开始后，适配器首次/最后一次读取响应体数据的毫秒数。
- `sseDataEvents`：处理到的非 `[DONE]` 数据帧数量；无效 JSON 帧在解析报错前也会计入。
- `reasoningChars`：推理内容的字符统计。
- `observedToolCallCount`、`toolArgumentBytes`：上游已开始发送的原生工具调用数量及累计参数大小，包含未完成的调用。
- 可选 `reportedUsage`：上游已经报告的 usage，仅作为诊断保留；不会因为异常前的 usage 帧改变现有失败请求计费逻辑。

`toolCallCount` 继续表示已经交付给调用链的完整工具调用，未完成的参数不会被执行或发给客户端。原始推理内容、工具参数和响应正文不会通过这些新增字段持久化。

新字段存入现有 `request_events.upstream_attempts_json`，无需数据库迁移；管理员消息诊断 JSON 在 `gateway_requests[].upstream_attempts[].stream_progress` 返回相应统计。CLI 读取的上游尝试也保留 `streamProgress`。普通推理 API 不暴露新增内部诊断字段。

## 超时语义

| 触发 | 分类 | 对外错误码 |
| --- | --- | --- |
| `UND_ERR_BODY_TIMEOUT` | `network / body_timeout`，保留实际阶段和已收到的 HTTP 状态 | `upstream_timeout` |
| `UND_ERR_HEADERS_TIMEOUT` | `network / headers_timeout` | `upstream_timeout` |
| Gateway 总期限 | `gateway / deadline_exceeded` | `upstream_timeout` |
| 客户端取消 | `client / client_aborted` | `client_aborted` |

`network` 在这里表示传输层观察到的超时，不等于已经证明供应商或中间网络哪一方承担根因。

响应体超时即使发生在上游 HTTP 200 之后，仍记作 `terminal_source=transport_error`，不会误记为正常供应商响应结束，也不会错误标记客户端/Gateway 已发起取消。请求响应头已经提交时，流式响应可以保持 HTTP 200 并输出错误帧；未提交时返回 HTTP 504。

没有调整 600 秒总期限、底层读取期限、模型路由或重试策略；流中超时仍不启用自动供应商切换。

## 验证

`npm run build` 和 `git diff --check` 通过。

以下 7 个测试文件已验证，共 448 项不同测试通过：

- `packages/core/src/provider-failure.test.ts`
- `apps/gateway/src/services/openai-compatible-provider.test.ts`
- `apps/gateway/src/services/provider-stream.test.ts`
- `apps/gateway/src/services/native-tool-failover.test.ts`
- `apps/gateway/src/http/observation.test.ts`
- `packages/store-sqlite/src/index.test.ts`
- `apps/gateway/src/index.test.ts`

覆盖部分推理/工具参数后超时、客户端取消、无效 JSON、未完成的 SSE 帧、响应头超时、安全请求 ID、取消标记、SQLite 读写、管理员诊断查询以及普通/流式响应的公开错误契约。

人工 SSE 复现脚本已改为修复后断言：

```powershell
node --import tsx docs/outbox/r760-medcode-timeout-repro-2026-09-08.mjs
```

三个场景均通过。示例：总期限场景收到 11 帧/1,178 字节后报错，现在保留 HTTP 200、上游 ID、19 个推理字符和 183 字节未完成工具参数；未交付任何不完整工具调用。

## R760 部署后自测

先核对部署记录中的提交号、`current` 指向的发布目录和运行容器版本一致，并确认公共健康接口正常：

```powershell
Invoke-RestMethod https://goldencode.instmarket.com.au:1443/gateway/health
```

然后在本地仓库执行下列命令，把自测脚本通过标准输入交给 R760 容器内的独立 Node 进程。`--runtime-root=/app` 直接加载容器内已编译的 Gateway 模块，无需安装 tsx 或开发依赖。

```powershell
Get-Content -Encoding UTF8 -Raw docs/outbox/r760-medcode-timeout-repro-2026-09-08.mjs |
  ssh -p 7723 -i $env:USERPROFILE\.ssh\id_ed25519 `
    -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes `
    root@117.186.49.26 `
    'docker exec -i -w /app codex_gateway_r760-gateway-1 node --input-type=module - --runtime-root=/app'
if ($LASTEXITCODE -ne 0) { throw 'R760 timeout self-test failed' }
```

这是人工 SSE 流测试：在独立进程内注入响应和异常，不调用真实供应商、不接入生产数据库，也不改变在线 Gateway 的超时配置。总期限场景使用 350 毫秒期限，不需要等待十分钟。通过标准为退出码 0、输出 `"assertions": "passed"`，且三个场景满足：

| 场景 | 通过标准 |
| --- | --- |
| `deadline` | 对外 `upstream_timeout`，内部 `deadline_exceeded`；保留上游 HTTP 200、请求 ID 和已收到的字节、推理、工具参数统计；完整工具交付数为 0 |
| `body_timeout` | 对外 `upstream_timeout`，内部 `body_timeout`，保留 `UND_ERR_BODY_TIMEOUT` 以及上游 HTTP 200、请求 ID、流进度；完整工具交付数为 0 |
| `completed` | 正常交付 1 个完整工具调用，保留对应流进度 |

这一步验证容器内运行版本的适配器、期限处理与统计收集器。HTTP 路由、取消标记、SQLite 和管理员 JSON 链路由前述 `apps/gateway/src/index.test.ts` 回归覆盖。

最后通过一条上线后正常 Desktop 请求关联的管理员 JSON 查看 `gateway_requests[].upstream_attempts[].stream_progress`：应有非零 `response_bytes` 和 `sse_data_events`，首末读取时间有值且顺序正确。管理员页面默认隐藏名称或 ID 含 smoke 的测试账号，因此这一步应使用普通账号的受限只读查询；smoke 请求可直接核验 SQLite。按正常请求实际行为验收，不要求每条请求都有推理或工具参数。

若上线后出现新的实际超时，按请求 ID 检查 R760 请求记录：响应体超时应为 `upstream_failure_kind=body_timeout`、`terminal_source=transport_error`，且未发生其他取消时 `cancel_requested=false`、`cancel_observed=false`；Gateway 总期限应为 `deadline_exceeded`、`gateway_deadline`。在已经收到上游数据的情况下，应保留实际 HTTP 状态及流进度。只看客户端 HTTP 200 或“超时”提示不足以完成这项验收。

容器命令也可以在本地构建后预检：

```powershell
node docs/outbox/r760-medcode-timeout-repro-2026-09-08.mjs --runtime-root=.
```

## 生产状态与后续

修复已部署并对新请求生效；配置和其他服务保持一致，临时测试凭据已撤销并完成清理。历史失败时已经丢失的统计无法补回。此修复解决诊断缺失和分类问题，不能单独保证腾讯长请求不再触及总期限。
