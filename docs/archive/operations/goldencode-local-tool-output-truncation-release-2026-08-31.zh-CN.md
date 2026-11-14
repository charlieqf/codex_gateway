# GoldenCode Local 工具输出截断修复与 R760 验证记录（2026-08-31）

## 1. 结论

Gateway commit `14935735f92f631e16355d62944feaef479f2921` 已部署到 R760。

当原生工具调用的参数 JSON 无效、且 provider usage 已到本次请求的最大输出 token 时，Gateway
现在立即返回结构化、由客户端恢复的错误，不再进入同模型 validation repair：

```text
HTTP                     = 502
error.code               = tool_call_output_truncated
failure_kind             = confirmed_output_limit
retryable                = false
transformed_retry_allowed = true
recommended_action       = compact_and_generate_in_chunks
recovery_owner           = client
```

杜衡自然语言长 HTML 的当前客户端源码 E2E 仍失败，但失败点已经前移并明确为客户端恢复问题：客户端
显示执行过 compaction，随后重建出的请求仍为 `25,472 + 8,192 = 33,664` tokens，Gateway 在
provider 生成前 531 ms 返回 `context_compaction_required`；客户端没有继续 transformed retry，最终
0 次 write、1 个 `ContextOverflowError`。

## 2. 发布边界

| 项目 | 值 |
|---|---|
| Gateway commit | `14935735f92f631e16355d62944feaef479f2921` |
| 分支 | `main`，已推送到 `origin/main` |
| R760 `current` | `/opt/codex-gateway-r760/releases/14935735f92f631e16355d62944feaef479f2921` |
| R760 `previous` | `/opt/codex-gateway-r760/releases/6a9ae87d34b39809b97e0904e01cb62919bd7e89` |
| Gateway image | `sha256:caaaba9354c519510f242d812f35b09454567fcd3c9d0dd6bb33b2b3d4d11ead` |
| 发布镜像 tag | `codex_gateway_r760-gateway:release-14935735f92f-tool-output` |
| 回滚镜像 tag | `codex_gateway_r760-gateway:rollback-pre-tool-output-20260831T105717Z` |
| 备份 | `/data/codex-gateway-r760/backups/pre-tool-output-truncation-20260831T105717Z` |

本次使用当前生产镜像作为 base，进行 `--network=none` 编译产物 overlay 构建；仅覆盖
`apps/gateway/dist`，仅 force recreate Gateway。Qwen、Research LLM Gateway、Research Worker、
Research Maintenance 和 Mihomo 容器 ID 均保持不变；未修改 Nginx、DNS、防火墙、端口、模型、
provider 配置或数据库 schema。

## 3. 实现与自动化门禁

变更位于：

- `apps/gateway/src/index.ts`
- `apps/gateway/src/services/provider-stream.ts`
- 对应的 `index.test.ts` 与 `provider-stream.test.ts`

判定只在 `invalid_json` 且 `completionTokens >= maximumOutputTokens` 时启用；Gateway 把最后一次
attempt 标记为 `outputLimitHit=true`、`truncationConfidence=confirmed`、
`gatewayRecoveryAction=error`，然后返回 `tool_call_output_truncated`。该分支位于同模型 validation
retry 计划之前。

发布前通过：

- 聚焦测试：2 files，225 tests 全部通过；
- 完整测试：52 files 通过、1 file 跳过；858 tests 通过、3 tests 跳过；
- `npm run typecheck`；
- `npm run scan:phone-auth-secrets -- origin/main`；
- `git diff --check`；
- `npm run build`。

杜衡失败形状测试固定了两次真实观测：

| 事件 | prompt tokens | completion tokens | malformed Write bytes | provider attempts |
|---|---:|---:|---:|---:|
| `req-b717…` replay | 23,553 | 8,192 | 24,024 | 1 |
| `req-eb2c…` replay | 23,703 | 8,192 | 22,209 | 1 |

两条回归均要求 HTTP 502 `tool_call_output_truncated`，且禁止第二次 provider 调用。

## 4. 部署与回滚证据

发布前 `current=6a9ae87…`、Gateway/Qwen/Research 均 healthy、重启数为 0；Gateway、
client-events、Research 三份 SQLite 均 `quick_check=ok`、外键错误为 0，且当时没有未完成 token
reservation 或运行中的 Research run。

成功切换前有两个 preflight 脚本错误，均发生在 `cutover_started` 之前，生产 `current`、容器与流量
没有改变：第一次为只读 Research audit 的 SQL 引号传递错误，第二次为候选 release 尚未建立指向
shared protected config 的 symlink。修正后才执行正式 cutover。两份不完整 preflight 目录和对应的
冗余 rollback tags 已精确删除；成功备份与 rollback tag 保留。

成功备份包含 protected config、current/previous、旧镜像与容器身份、pre/post DB audit、
`gateway.db`、`client-events.db` 及 WAL/SHM。`SHA256SUMS` 全量复核通过。

## 5. 发布后健康与兼容性

- 公网 `/gateway/health`：`ready`；Local inference：`healthy`；
- 无 Key `/v1/models`：401；
- Gateway：healthy、`RestartCount=0`、只发布 `127.0.0.1:18787->8787`；
- Qwen：healthy、`RestartCount=0`、无宿主机 published port；
- Research 三个容器 healthy，未重建；
- 最终 Gateway/client-events/Research SQLite 均 `quick_check=ok`、外键错误为 0；
- 最终未完成和已过期未完成 token reservation 均为 0；
- 临时 smoke active credential 与 enabled subject 均为 0；
- 发布后日志审计：fatal/uncaught 0、长格式 key/private-key marker 0、原始验证 prompt 0。

严格云端工具兼容 smoke 全部通过并清理：

- required tool：`req-ac579d71-641e-4add-9354-7f45df99e527`；
- named tool：`req-7fd3c0d0-7125-4d83-90c0-5d6806e5e1cd`；
- `tool_choice=none`：`req-fbe40235-9e20-4920-97b7-b215afb484c7`；
- tool follow-up：`req-53e440c6-3531-44bf-85ee-15977e91cb50`。

发布后 Local 快速恢复 smoke：

```text
request_id        = req-37675d5d-cb3a-42c6-879c-9fd9580f84bb
status            = 200
duration          = 2.924 s
finish_reason     = stop
prompt/completion = 50 / 33
```

旧 `smoke-goldencode-local.sh` 已通过模型表面、Local/Cloud、SSE 和 required/named/none/follow-up
工具链，随后在自身 RPM=1 的 rate-limit 断言处失败；临时用户和凭证已清理。该差异不在本次截断
代码路径内，不能据此判定截断修复回归。

## 6. 杜衡自然语言 HTML 客户端 E2E

运行的是客户端团队当前两轮优化后的未提交工作树，测试名：
`completes Du Heng's natural-language long HTML task with GoldenCode Local`。

```text
Desktop source commit = 2ac458386a (v2.0.0-beta.61) + dirty client changes
session_id            = ses_fa88270efffeSYFJoOhSeq5yr3
support_code          = T:T3AH7GMN
duration              = 85,980 ms
completed writes      = 0
assistant errors      = 1 ContextOverflowError
```

同一 client turn 的成功请求链：

- `req-b8436dfe-14f6-4dc2-8364-775a3769cf12`：read，1 attempt；
- `req-5de407cc-74dc-4a4d-beb6-10ad38ed8f05`：compaction summary，1 attempt；
- `req-52d9ba88-1a5a-4a3c-8b0d-bc7a7ac8ac3e`：bash，1 attempt；
- `req-b683916e-67ab-4d47-9730-c01fc6278f8b`：再次 read，1 attempt。

终止请求：

```text
request_id              = req-302686b2-8d9a-4b88-8d81-667655fe7149
status/error            = 413 context_compaction_required
duration                = 531 ms
prompt tokens           = 25,472
requested output tokens = 8,192
total/context           = 33,664 / 32,768
overflow                = 896
provider attempts       = 0
token reservation       = none
```

UI 截图在测试失败时已保存并进行人工检查：页面明确显示 compaction、只读到截断的源文件、随后执行
read-only shell 长度检查，并显示 `Compact earlier context and retry once` 错误；没有 write、没有输出
HTML。Playwright 结果目录随后未能稳定保留该截图，因此本次没有可提交的长期 screenshot artifact；
这是 harness artifact-retention 缺口，不改变请求与数据库证据。

此外，客户端 E2E 的 `bun run typecheck:e2e` 当前有 4 个 harness 类型错误，均为把普通 `object`
直接访问为 `chunk.index/chunk.total`。Playwright 可运行，但 release gate 本身仍非 clean。

## 7. 自行设计的长输出验证

为分离“上下文准入”“模型首轮吞吐”“工具 JSON 截断”三种情况，顺序运行了四种真实 R760
`goldencode-local` 任务：

| request | 输入/输出形状 | 结果 | attempts | 结论 |
|---|---|---|---:|---|
| `req-27e47a4c-55e8-43cf-9889-1ba1e638db5f` | 小 prompt，8,192 output，强制超长 artifact | 418.713 s，`output_length_exceeded` | 1 | 模型耗尽上限但未形成 tool call；无修复重试 |
| `req-4e729dfb-14ac-48a9-83ed-ba2205664fa6` | 简化 fixed paragraph，8,192 output | 600.032 s，`upstream_timeout` | 1 | 模型首轮本身未完成；无修复重试，暴露独立吞吐风险 |
| `req-ee268deb-4d4d-4d03-9f31-fc03217e8495` | 4,096 output，要求 30K | 294.147 s，HTTP 200 | 1 | 模型只写 4,765 字符，未遵守长度要求 |
| `req-36acf899-68a8-43c4-ae73-292a983767ac` | 19,972-char read result，4,096 output，再 write | 536.024 s，`tool_call_output_truncated` | 1 | 14,990-byte write 参数达到 4,096 token 上限后立即返回客户端恢复协议 |

最后一条生产事件：

```text
prompt/completion/total  = 11,069 / 4,096 / 15,165
tool                     = write
maxToolArgumentBytes     = 14,990
outputLimitHit           = true
truncationConfidence     = confirmed
gatewayRecoveryAction    = error
gatewayRecoveryOwner     = client
upstreamAttemptCount     = 1
upstreamRecoveryAttempts = 0
```

该 live replay 的 provider `finish_reason=length`，证明生产结构化协议和单 attempt；杜衡原事件特有的
`finish_reason=tool_calls + invalid_json + completion=max` 精确分支由两条自动化 replay 固定。由于
R760 Qwen 当前大工具输出吞吐，8,192-token read replay 无法稳定在 600 秒内完成，因此没有伪称
生产 live replay 已逐字重现原 provider finish reason。

## 8. 客户端团队交接结论

R760 Gateway 已不再对“malformed tool JSON + output token ceiling”做同模型 repair；生产长输出也
证明 terminal error 只有一个 upstream attempt。杜衡任务的新失败发生在 Gateway 生成前：客户端
compaction 后仍提交 `25,472 prompt + 8,192 output`，超过 32,768 窗口 896 tokens，然后把明确可恢复的
`context_compaction_required` 终止成 Assistant error，且 0 次 write。因此下一步应由客户端修复
compaction/rebuild/chunking 状态机，而不是继续改 Gateway 重试。
