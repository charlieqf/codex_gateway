# MedCode Phase 1 接入反馈邮件草稿

---

**Subject**：MedCode `/v1/chat/completions` 接入反馈与 Phase 2 对齐（2026-04-23）

---

Hi [MedCode team]，

今天我们完整接入到 MedEvidence CLI / Desktop，并跑了 live 测试。下面是汇总反馈，分三部分：**测试通过项**、**观察到的差异**、**Phase 2 疑问**。

---

## 一、测试通过项

接入路径：`@ai-sdk/openai-compatible`（Vercel ai-sdk 官方包）直接指向 `https://gw.instmarket.com.au/v1`，我们这边**零 adapter 代码**。以下场景全部通过：

- `GET /gateway/health` / `GET /gateway/status` / `GET /v1/models` / `GET /v1/models/medcode`
- 非流式 `POST /v1/chat/completions` —— OpenAI `chat.completion` shape 完整
- 流式 `POST /v1/chat/completions` —— SSE 帧 `chat.completion.chunk` 完美对齐，`data: [DONE]` 收尾
- `system` / `user` / `assistant` / `tool` 四种 role 全部被后端正确消化
- Multi-turn 无状态历史（通过 `messages[]` 传完整历史）被正确理解
- `role: "tool"` + `tool_call_id` 回传工具结果**能闭环**（我方伪造 result，模型后续 turn 正确引用）
- 无 Authorization / 错 key 返回 `401` + `error.code` 为 `missing_credential` / `invalid_credential`，envelope 完整 OpenAI 风格
- Prompt caching 稳定命中（`prompt_tokens_details.cached_tokens` 稳定 10240）

结论：**MedCode 的 OpenAI-compat 层对我们接入 CLI / Desktop 的文本对话场景完全够用。**我们已经把 `medcode/medcode` 注册为 provider，用户可以在模型选择器里看到并选中，通过 `MEDCODE_API_KEY` 环境变量或 `opencode auth login medcode` 填 key。

---

## 二、观察到的差异（希望请确认或更新文档）

### 2.1 `usage` 实际总是返回

通知邮件里提到"某些情况下 usage 可能为 null"。我们在**所有**非流式和流式请求里都稳定收到完整的 `prompt_tokens` / `completion_tokens` / `total_tokens`，甚至包括 `prompt_tokens_details.cached_tokens`。如果这是预期行为，建议更新文档措辞；如果是未来可能出现 null，建议在文档里说明触发条件，便于我们做 UI 降级处理。

### 2.2 `model` 字段不校验

我们用 `{"model":"gpt-4", ...}`（故意传错 model id）请求 `/v1/chat/completions`，仍然返回 200 正常结果，响应里 `"model": "gpt-4"` 原样回显。也就是说 **`model` 字段目前被忽略**，任何字符串都路由到同一个底层模型。

这对我们暂时无伤（我们一直传 `"medcode"`），但：

- 长期建议至少做 allowlist 校验，防止未来新增模型时误路由
- 响应里建议 echo 服务端真实选中的 model id，而不是原样回显 client 传入

### 2.3 `concurrentRequests` 仍为 1

上次沟通里提到会单独把我们这把 key 的 `concurrentRequests` 提到 2 或 4，便于 OpenCode 的后台任务（title 生成、todo 维护、sub-agent 等并行场景）。我们今天实测 `GET /gateway/status` 返回的仍然是：

```json
"rate": { "requestsPerMinute": 10, "requestsPerDay": 200, "concurrentRequests": 1 }
```

请确认是否已经下发，或者告知预计时间。

### 2.4 bwrap 沙箱错误

在 tool-call 场景下（我们传 `tools` array 并要求使用），模型会发 `tool_calls`（finish_reason=`tool_calls` 正确），同时 `content` 里叙述："我尝试在 `/app` 下执行 `ls`，但 bash 工具失败：`bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.`"

看起来你们 server 端在尝试**服务端预执行**工具，但容器的 user namespace 配置有问题导致失败。

两个问题：

1. 这是**有意的设计**（服务端尝试执行，失败则把失败报告给客户端），还是 **sandbox 配置待修**？
2. 如果是设计意图，是否考虑在 `content` 里就不输出这个执行失败文案？因为对走 client-side tool 路径的接入方（我们就是）这段文案是冗余/误导的 —— 我们会在本地执行同名工具并通过 `role: "tool"` 回传结果。

---

## 三、Phase 2 疑问（影响我们 tool-call 接入策略）

这一块对我们把 MedCode 从"纯文本 coding chat"提升到"真正的 coding agent 后端"影响最大。请帮我们解答几个关键问题。

### 3.1 客户端 `tools` schema 和模型原生工具的关系

实测现象：

- 我们在请求里定义 `tools: [{type:"function", function:{name:"bash", parameters:{...command...}}}]`
- 模型返回 `tool_calls` 里 `function.name` 是 **`shell`** 不是 `bash`，`arguments` 是 `{"command":"/usr/bin/bash -lc ls"}` 格式
- 换成 `read_file`（expect `path` 参数）也一样返回 `shell`

看起来：**模型只调用它自己训练过的原生工具（至少 `shell`），忽略客户端 `tools` schema**。客户端 `tools` 字段当前是装饰性/兼容性存在。

对此想请确认：

1. **你们的原生工具集当前包含哪些？** 我们目前确知 `shell`。是否还有 `read` / `write` / `edit` / `apply_patch` / `grep` / 其他？
2. **每个原生工具的 `arguments` schema 是什么？** 以便我们做 client-side 执行时能正确 parse。
3. **短期路线图倾向哪一种？**
   - (a) 客户端接受 MedCode 原生 tool names，做一层映射（比如 `shell` → OpenCode 的 `bash` 工具）
   - (b) 将来模型会理解客户端 `tools` schema 并据此发 tool_calls

   (a) 的话我们现在就能把 `tool_call: true` 翻开；(b) 的话我们愿意等，毕竟一致的 schema 更清爽。

### 3.2 `tool_call_id` 命名规则

实测里返回的 id 都是 `item_1`、`item_2` 这种。请确认：

1. 是否 **稳定且唯一**？能否作为客户端会话历史持久化的 key？
2. 格式是否会变化（比如将来换成 UUID 或 `call_xxx`）？

### 3.3 `finish_reason` 的完整取值集

目前观察到 `stop` / `tool_calls`。文档没有枚举。请确认完整集合，是否还会出现 `length` / `content_filter` / `error` / 其他？

### 3.4 底层系统 prompt 的披露策略

每次请求 prompt_tokens 基线 ~10500，说明服务端注入了约 10K token 的系统 prompt。虽然 cached_tokens 稳定命中使实际成本很低，但我们希望了解：

1. 这个系统 prompt 的 **内容维度** 是否会对接入方公开（至少知道它覆盖了哪些行为约束，以便我们在 agent 层避免冲突/重复）？
2. 我们传的 `role: "system"` 消息是 **覆盖**、**拼接在之后**，还是 **被忽略**？（测试里我们传 PIRATE 指令，模型遵守了，说明不是被忽略；但不确定与服务端 prompt 的优先级关系）

---

## 四、我们这边的 Phase 1 落地状态

- `medcode` provider 已注册到 MedEvidence Desktop 的 bundled config，用户打开 app 就能看到并选择
- 当前 `tool_call: false`（基于 3.1 的不确定性先保守）
- 完整 live smoke test 已落到代码仓库（`packages/opencode/test/medcode/smoke.test.ts`），未来协议变更时我们会用它做回归
- 用户通过 `MEDCODE_API_KEY` 环境变量或 CLI 的 auth 流程填 key，**不会进仓库**

---

## 五、建议的下一步

1. **我们这边**：等你们对上面 2.3（concurrency）和 3.x（tool-call 策略）的答复，决定是否把 `tool_call: true` 翻开
2. **如果你们方便**：给出 3.1.1 的原生工具清单 + schema，哪怕先是一张表，让我们能开始做映射

有任何测试数据需要我们补充的，随时告诉我们。
