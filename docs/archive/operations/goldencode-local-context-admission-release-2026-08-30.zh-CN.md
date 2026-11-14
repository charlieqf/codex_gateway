# GoldenCode Local 上下文准入生产发布记录（2026-08-30）

## 1. 结论

GoldenCode Local 的精确上下文准入已经在 R760 Gateway 生效。

当最终 `messages + tools` 经真实 vLLM tokenizer 计数后，与请求输出预算之和超过有效
32K 窗口时，Gateway 会在调用生成接口前返回 HTTP 413
`context_compaction_required`。响应包含上下文上限、prompt、输出预算、总量、超出量、
计数来源和恢复动作，供客户端执行“压缩、重建、重新计数、最多重试一次”。

Gateway 不自动改写用户上下文、不静默缩小 `max_tokens`、不自动切换云模型。客户端仍是
压缩恢复流程的责任方。

## 2. 发布边界

| 项目 | 值 |
|---|---|
| Gateway commit | `6a9ae87d34b39809b97e0904e01cb62919bd7e89` |
| R760 `current` | `/opt/codex-gateway-r760/releases/6a9ae87d34b39809b97e0904e01cb62919bd7e89` |
| R760 `previous` | `/opt/codex-gateway-r760/releases/e4f27d31324cbddfb1052b19d4fce2d181afa8be` |
| Gateway image | `sha256:f36bbfa7ca0b719778b3e8b7268bdddb571ff40bcebb799ffa2b8c1976817a8e` |
| 发布镜像标签 | `codex_gateway_r760-gateway:release-6a9ae87d34b3-local-context` |
| 回滚镜像标签 | `codex_gateway_r760-gateway:rollback-pre-local-context-20260830T042812Z` |
| 生产模式 | `MEDCODE_LOCAL_CONTEXT_ADMISSION_MODE=enforce` |
| 备份目录 | `/opt/codex-gateway-r760/backups/pre-local-context-admission-20260830T043123Z` |

本次通过无网络 overlay 构建，仅替换 Gateway 和 core 的编译产物。只 force recreate 了
Gateway；Research LLM Gateway、Research Worker、Research Maintenance、Qwen 和 Mihomo
容器 ID 均未变化。未修改 Nginx、DNS、防火墙、Qwen runtime/config 或数据库 schema。

## 3. 发布前门禁

- 手机认证敏感信息扫描通过。
- TypeScript build 通过。
- 完整自动化测试通过：52 个 test files 通过、1 个跳过；855 个 tests 通过、3 个跳过，
  共 858 个 tests。
- 杜衡外部 fixture 命名回归 3/3 通过。
- `git diff --check` 通过。
- 发布前 Gateway、Research 和 Qwen 健康，重启计数均为 0；Local 准入变量原先未设置。
- 发布前创建受保护配置、三份 SQLite 一致性副本、容器/镜像/发布指针状态和 SHA-256 清单，
  发布后清单复核通过。

## 4. 杜衡案例生产验证

### 4.1 固定案例身份

| 文件 | UTF-8 bytes | SHA-256 |
|---|---:|---|
| `长任务.txt` | 5,978 | `a31d10e15104a608a193f9ad12e320e7e3590c422c67e06e4ab64420401d1019` |
| `教授_科研方向检索.md` | 43,479 | `b454e08debbf2aaccf68bdb6d53f744cb58bc12635d2d0319e80dd25afddd5c4` |

重放使用真实 fixture、真实 57 个工具定义、真实生产 Gateway 和真实 Qwen tokenizer，另用
确定性、隐私安全的 schema/history 开销补齐原客户端未被 Gateway 持久化的部分。它校准到
原事件的 token 边界，但不是原始 wire payload 的逐字节副本。

### 4.2 生产结果

```text
request_id                = req-397950e7-44cc-458c-b31d-dd615c66bc80
http_status               = 413
error_code                = context_compaction_required
context_limit             = 32,768
prompt_tokens             = 24,577
requested_output_tokens   = 8,192
total_tokens              = 32,769
overflow_tokens           = 1
token_count_source        = provider_tokenizer
recommended_action        = compact_and_retry_once
generation_attempted      = false
token_reservation_created = false
```

Gateway 约 208 ms 完成拒绝。事件记录为 `status=error`、
`error_code=context_compaction_required`、`public_model=goldencode-local`、
`runtime=local_openai`；该 request ID 没有 token reservation，证明请求在生成前被拦截。

重放脚本准备阶段曾有两次 harness 失败：一次为 Node CJS/ESM 模式不明确，一次为复用了已禁用
的合成用户。两次均发生在业务请求发出前，临时材料已清理；改为显式 ESM 和唯一合成用户后，
一次生产重放通过。

## 5. 兼容性和回归验证

原始生产 smoke 完整通过：

- 无 Key/错误 Key 返回 401；
- `/v1/models` 精确暴露两个公开模型；
- `goldencode` 与 `goldencode-local` 非流式请求返回 200；
- Local SSE、usage、required/named/none/follow-up tools 通过；
- 429 限流、凭证撤销 401 和日志敏感信息扫描通过。

代表性成功请求：

- Local：`req-db36ed91-8b92-4257-a7f9-0fe1f58b29f7`
- Cloud：`req-9e4ea44f-d0a3-4c39-b36f-3e8057111d57`

增强 smoke 进一步确认 Local model metadata：

```text
context_window                         = 32768
max_output_tokens                      = 8192
context_error_contract_version         = 1
context_overflow_recovery              = compact_and_retry_once
```

增强 smoke 后续的一次 `goldencode` 控制调用遇到 Tencent provider-origin 503。按测试约束只做
一次聚焦控制重试，`req-02cf5c14-f321-4261-92ea-b0b146fa83a2` 返回 200；结合此前完整 smoke
通过，判断为瞬时上游网络异常，而非本次 Local 准入发布回归。

## 6. 发布后审计

- 公网和 loopback health 均为 ready。
- Gateway 与 Qwen 均为 healthy，重启计数为 0。
- Gateway 仅监听宿主机 `127.0.0.1:18787`；宿主机没有暴露 Qwen `18000`。
- `gateway.db`、`client-events.db`、`research.db` 均通过 `quick_check`，外键错误为 0。
- smoke/杜衡案例的临时用户、凭证、未结 token reservation 和服务器 fixture 文件均为 0。
- 发布后 tokenizer failure 数为 0。
- 发布暂存目录已在验证 current、镜像、备份清单和服务健康后精确删除；release、镜像和备份保留。
- 最终审计时 `/data` 可用约 1.63 TB，`MemAvailable` 约 116.6 GiB。

## 7. 回滚边界

如后续发现发布回归，应按 R760 发布 runbook 执行仅 Gateway 回滚：

1. 先确认目标仍为本记录中的 `current`、活动镜像和 Gateway 容器。
2. 使用备份目录中的 `predeploy-state.txt`、受保护 env/override 副本和 SHA-256 清单确认回滚输入。
3. 将 `current` 恢复到本记录中的 `previous`，使用已保留的 rollback image，仅重建 Gateway。
4. 若本次新增环境变量本身需要撤销，从备份恢复 Gateway env/override；不要修改 Qwen 或 Research。
5. 复核公网/loopback health、双模型 smoke、数据库完整性、容器 ID 边界和临时凭证清理。

回滚不是自动动作，需要在确认异常属于本次发布后由运维执行。

## 8. 尚未完成的客户端门禁

Gateway 上线不代表客户端工作已经完成。Desktop 仍需：

- 发送前发现最终请求超过 Local 32K，显示非阻塞“正在自动整理”状态；
- 压缩后保留当前任务、关键进度和待办；
- 基于最终 payload 重新构造并重新计数，最多 transformed retry 一次；
- 相同 payload 不重试；已有可见输出或工具副作用时不自动重放；
- 压缩后仍无最低输出空间时，再提示新建会话、缩短任务或手动切换模型；
- 用杜衡两条长任务完成安装版 Desktop Live E2E 后再发布客户端。
