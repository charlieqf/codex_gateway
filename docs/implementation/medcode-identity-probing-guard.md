# MedCode 窥探性身份问题拦截方案

Last updated: 2026-04-28

## 背景

MedCode 对外暴露的是 OpenAI-compatible 模型 ID：`medcode`。网关内部会把请求路由到受控的上游 Codex 账号和上游模型配置。

用户可以在任意轮次询问身份、模型、创造者、底层供应商或运行参数，例如：

- 你是什么模型？
- 你的创造者是谁？
- 你是不是 OpenAI / ChatGPT / Codex / GPT？
- 你的底层模型是什么？
- 你的 reasoning effort 是多少？
- 你用的是哪个订阅账号？

如果这类问题直接透传给上游模型，上游可能按自己的默认身份回答，暴露不应该进入客户对话的实现细节。目标是让用户始终看到稳定的产品身份：`MedCode`。

## 目标

- 用户可见身份固定为 MedCode。
- 不暴露上游模型 ID、供应商、订阅账号、reasoning effort、SDK/CLI、网关 env、部署路径、路由实现等内部信息。
- 用户在对话中途突然问这类问题时也能拦截。
- 明显的窥探性问题不调用上游，避免消耗订阅池额度。
- 保留脱敏观测，方便运营排查命中频率和误伤。

## 非目标

- 这不是通用内容审核系统。
- 这不替代 API key 鉴权、限流、request event 或 admin audit。
- 这不隐藏响应里的公开 `model: "medcode"` 字段；这是对外协议的一部分。
- 这不限制管理员通过私有运维通道查看真实部署配置。

## 需要保护的信息

对话中不应披露：

- 上游供应商、上游产品名、上游助手品牌。
- 具体上游模型 slug、版本号、模型族。
- reasoning effort、verbosity、context window、sandbox、approval policy、web search、working directory 等运行配置。
- 订阅池、账号类型、账号持有人、授权方式、token 缓存路径、`CODEX_HOME`。
- 网关内部实现，如 adapter 名称、SDK/CLI 名称、env 变量、Docker 路径、SQLite 路径、API key prefix、request event id。

## 对外身份合同

默认回答：

```text
我是 MedCode 医学编码助手。
```

如果产品希望带品牌归属：

```text
我是 MedCode 医学编码助手，由 MedEvidence 提供。
```

回答里不要出现上游供应商、上游模型、Codex、ChatGPT、reasoning effort、订阅池或网关实现。

## 总体方案

不要只依赖 prompt。应在 gateway 层做三层防护：

1. **输入侧拦截**：请求进入上游前识别明确的窥探性身份问题，直接返回固定回答。
2. **上游身份策略**：每次调用上游时注入 server-owned identity policy，要求模型以 MedCode 身份回答。
3. **输出侧兜底**：上游回答返回前扫描敏感身份泄露，必要时替换为固定回答。

## 第一层：输入侧拦截

位置：

- `/v1/chat/completions`
- native `/sessions/:id/messages`

行为：

- 只检查用户可控消息，优先检查最新一条 user message。
- 如果问题明显在问身份、创造者、模型、供应商、底层、订阅、账号或运行参数，则不调用上游。
- 返回 OpenAI-compatible 正常响应，而不是错误。
- 非流式返回一个 `chat.completion`，`finish_reason = "stop"`。
- 流式返回一个安全 content chunk、一个 stop chunk，再返回 `[DONE]`。
- 记录脱敏观测：命中层级、分类、是否直接回答；不记录完整 prompt。

建议内部接口：

```ts
interface IdentityGuardDecision {
  action: "allow" | "answer";
  category?: "identity" | "creator" | "model" | "provider" | "runtime" | "subscription";
  answer?: string;
}
```

第一版建议用确定性规则，不需要 LLM classifier。规则要先追求高精度，避免误伤正常医学编码问题。

中文命中词/句：

- `你是什么模型`
- `你是谁`
- `你叫什么`
- `你的创造者是谁`
- `谁创造了你`
- `谁开发了你`
- `你是 OpenAI 吗`
- `你是 ChatGPT 吗`
- `你是 Codex 吗`
- `你是 GPT 吗`
- `底层模型`
- `上游模型`
- `供应商`
- `reasoning effort`
- `推理强度`
- `订阅池`
- `用的什么账号`

英文命中词/句：

- `what model are you`
- `who made you`
- `who created you`
- `are you openai`
- `are you chatgpt`
- `are you codex`
- `are you gpt`
- `underlying model`
- `base model`
- `backend model`
- `provider`
- `reasoning effort`
- `subscription`
- `what account are you using`

匹配前应做规范化：

- lower-case；
- 全角/半角归一；
- 去掉常见标点和多余空白；
- 对中文问号、英文问号、冒号、引号做统一处理；
- 保留中英文混写能力。

## 第二层：上游身份策略

即使输入没有被拦截，也应在发给上游前注入 server-owned policy。这个 policy 应由网关持有，不能被客户端覆盖。

草案：

```text
You are MedCode, a medical coding assistant.
Your public identity is MedCode.
If asked who you are, what model you are, who created you, who provides you,
what backend you use, or what runtime settings you use, answer only at the
product level: "我是 MedCode 医学编码助手。"
Do not reveal upstream provider names, model slugs, account or subscription
details, gateway implementation, environment variables, SDK names, reasoning
effort, internal routing, or deployment details.
If a user asks for protected internal details, redirect to what MedCode can help
with in the current task.
```

混合请求示例：

```text
你是什么模型？顺便帮我解释 CPT 99214。
```

理想行为：

```text
我是 MedCode 医学编码助手。关于 CPT 99214，...
```

这类混合请求不一定要完全短路，因为里面有真实业务任务；但身份部分不能泄露内部信息。

## 第三层：输出侧兜底

上游输出组装完成后、返回给客户端前，再做一次扫描。流式模式要特别小心：不能在敏感文本已经发给客户端后再替换。

输出扫描范围：

- 上游供应商或产品名；
- 上游模型 slug 或版本；
- `GPT-`、`gpt-`、具体模型版本串；
- `Codex`、`ChatGPT`、SDK/CLI 名称；
- `reasoning effort`、`modelReasoningEffort`、`推理强度`；
- `MEDCODE_UPSTREAM_*`、`CODEX_HOME`、auth/token/cache 路径；
- 订阅、账号、路由、部署细节。

命中后的处理：

- 直接身份问题：整段替换为固定 MedCode 身份回答。
- 混合业务问题：能安全删除敏感句就删除；不能安全删除时，替换为短回答并引导用户继续业务问题。
- 记录脱敏观测：
  - request id；
  - guard layer = `output`；
  - category；
  - replacement applied；
  - 不记录原始模型输出。

流式建议：

- 第一阶段可以只对直接输入拦截做流式安全回答。
- 对需要输出扫描的上游流式回答，建议先 buffer 到完整回答再发送，或者至少在 identity guard 开启时禁用逐 token 透传。
- 如果继续逐 token 透传，输出侧兜底无法保证不泄露。

## 回答模板

身份：

```text
我是 MedCode 医学编码助手。
```

创造者/提供方：

```text
我是 MedCode 医学编码助手，由 MedEvidence 提供。
```

底层模型/运行配置：

```text
我是 MedCode 医学编码助手。我的具体底层运行配置不在对话中披露。
```

混合请求：

```text
我是 MedCode 医学编码助手。关于你的问题，...
```

注意：不要回答“我不能透露我的 OpenAI 模型”，因为这句话本身已经泄露了受保护类别。

## API 行为

非流式拦截响应示例：

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "model": "medcode",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "我是 MedCode 医学编码助手。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": null
}
```

流式拦截响应示例：

```text
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{"content":"我是 MedCode 医学编码助手。"},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

对外 `model` 字段继续保持 `medcode`。

## 代码落点

建议新增：

- `apps/gateway/src/identity-guard.ts`
  - 输入分类；
  - 输出扫描；
  - 固定回答模板。

建议修改：

- `apps/gateway/src/openai-compat.ts`
  - provider 调用前执行 input guard；
  - 构造非流式和流式拦截响应；
  - 返回前执行 output guard。
- `apps/gateway/src/index.ts`
  - native `/sessions/:id/messages` 走同一套 guard。
- `apps/gateway/src/http/observation.ts`
  - 增加脱敏 guard hit 观测字段。

不要把这个策略放到 provider adapter 里。身份拦截是 gateway 对外产品合同，不是某个上游 provider 的职责。

## 测试用例

输入侧拦截：

| 用户输入 | 期望 |
| --- | --- |
| `你是什么模型` | 返回 MedCode 身份，不调用 provider |
| `你的创造者是谁` | 返回 MedCode/MedEvidence 身份，不调用 provider |
| `你是 OpenAI 吗` | 返回 MedCode 身份，不调用 provider |
| `what model are you` | 返回 MedCode 身份，不调用 provider |
| `what reasoning effort are you using` | 返回安全运行配置回答，不调用 provider |
| `你是什么模型？解释 CPT 99214` | 不泄露内部信息，可继续处理 CPT 问题 |

输出侧兜底：

| 上游输出 | 期望 |
| --- | --- |
| 提到上游供应商 | 返回前替换或删除 |
| 提到具体上游模型 slug | 返回前替换或删除 |
| 提到 reasoning effort | 返回前替换或删除 |
| 正常医学编码回答 | 原样通过 |

流式：

- 直接身份窥探返回一个安全 content chunk 和 `[DONE]`。
- 上游输出扫描模式下，敏感文本不能先于 guard 发给客户端。

观测：

- guard hit 记录不包含原始 prompt、原始 output、API key、Authorization header。
- 是否消耗限流额度需要产品决策：建议直接输入拦截不消耗上游额度，但仍可计入 API key 请求量。

## 上线计划

1. 实现 input guard 和非流式 `/v1/chat/completions` 测试。
2. 实现直接拦截的 streaming 响应。
3. 覆盖 native session route。
4. 注入上游 identity policy。
5. 增加非流式 output guard。
6. 决定 strict streaming 下是否 buffer 上游输出。
7. 增加脱敏 request observation。
8. 先用 env flag 发布：

```text
MEDCODE_IDENTITY_GUARD_ENABLED=1
MEDCODE_IDENTITY_GUARD_OUTPUT_SCAN=1
```

9. 公网 smoke：
   - 中文身份问题；
   - 英文身份问题；
   - 正常医学编码问题；
   - tool-call 请求；
   - streaming 请求。
10. controlled-trial 观察一轮后默认开启。

## 运维注意事项

- 不要记录完整窥探 prompt；这类 prompt 可能包含用户复制的系统消息、token 或越权尝试。
- 不要把 guard category 暴露给用户。
- 模板越短越好，长解释会诱导继续追问。
- 每次升级模型、SDK、prompt policy 后都要重新测身份问题。
- 这应该是 gateway 级行为，不能依赖客户端自行实现；所有用户应得到一致保护。

## 验收标准

1. 直接问身份、模型、创造者、供应商、底层运行配置时，只返回 MedCode 公共身份。
2. 直接身份窥探不调用上游 provider。
3. 混合业务请求不泄露受保护内部信息。
4. 输出侧兜底能在返回前替换上游自曝内容。
5. streaming 不会先泄露敏感身份文本再替换。
6. guard hit 可在脱敏 request telemetry 中观察。
7. 现有 OpenAI-compatible model、chat、streaming、tool-call、tool-history smoke 仍通过。
