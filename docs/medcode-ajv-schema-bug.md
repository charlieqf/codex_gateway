# MedCode Gateway Bug：strict tools 模式下 Ajv 拒绝 draft 2020-12 schema

| | |
| --- | --- |
| **提交日期** | 2026-04-24 |
| **提交方** | MedEvidence 工程团队 |
| **影响版本** | 截至 2026-04-24 的 `gw.instmarket.com.au` strict client-defined tools 实现 |
| **严重级别** | 中高 —— 默认开启 tool_call 的客户端 100% 复现 |
| **建议优先级** | P1（阻塞 MedCode + 任何支持 tool-call 的客户端集成） |

---

## 一句话总结

向 `POST /v1/chat/completions` 提交 `tools: [...]` 时，网关 Ajv 对每个 `function.parameters` schema 做校验，**无法解析默认的 `$schema: "https://json-schema.org/draft/2020-12/schema"` 引用**，直接返回错误：

```
tools[0].function.parameters is not valid JSON Schema: no schema with key
or ref "https://json-schema.org/draft/2020-12/schema"
```

客户端（ai-sdk / OpenCode / 任何从 Zod 生成 schema 的工具链）默认都带这个 `$schema` ref。**请求直接失败，模型根本没机会响应。**

## 复现步骤

### 复现用例

任一非空 `tools` 数组的 chat.completions 请求。最小复现：

```bash
curl -sS https://gw.instmarket.com.au/v1/chat/completions \
  -H "Authorization: Bearer <MEDCODE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "medcode",
    "messages": [
      {"role": "user", "content": "List files in current dir via a tool"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "bash",
          "description": "Run a shell command",
          "parameters": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": { "command": { "type": "string" } },
            "required": ["command"],
            "additionalProperties": false
          }
        }
      }
    ]
  }'
```

### 实际响应

HTTP 400（推测）+ body 含：

```text
tools[0].function.parameters is not valid JSON Schema: no schema with key
or ref "https://json-schema.org/draft/2020-12/schema"
```

### 期望响应

正常走 strict tools 流程 —— 要么返回 `finish_reason: "tool_calls"` + bash 调用，要么返回普通文本回复。不应该因 `$schema` 字段的存在而 reject。

## 根因分析（推测）

MedCode 网关使用 [Ajv](https://ajv.js.org/) 校验 client-defined `tools[].function.parameters` 是否为合法 JSON Schema。

- **Ajv v6** 默认仅支持 draft-07
- **Ajv v8** 默认支持 draft-07 + draft-2019-09
- **Draft 2020-12** 需要手动安装：
    ```js
    import Ajv2020 from "ajv/dist/2020"
    const ajv = new Ajv2020()
    // 或 Ajv 8 + addMetaSchema
    import addMetaSchema2020 from "ajv/dist/refs/json-schema-2020-12"
    ajv.addMetaSchema(addMetaSchema2020)
    ```

当前 MedCode 网关的 Ajv 实例**没有加载 draft-2020-12 metaschema**，导致任何引用该 draft 的 schema 都无法解析。

## 影响面

**100% 复现** —— 任何使用以下工具链的客户端：

| 客户端 | 默认产生 `$schema: draft 2020-12`? |
| --- | --- |
| Vercel ai-sdk (`@ai-sdk/openai-compatible`) | ✅ |
| OpenAI Node.js SDK（新版） | ✅ |
| Zod → JSON Schema（`zod-to-json-schema` 默认） | ✅（默认 target）|
| `@hey-api/openapi-ts` 生成的 client | ✅ |

这覆盖了 OpenCode / Continue / Cline / Cursor / 任何从 Zod 生成工具 schema 的集成方。MedEvidence Desktop 是其中一个。

### 我们观察到的具体症状

- 用户在 MedEvidence Desktop 里选 MedCode 模型 + build agent 发任何消息时，CLI / 对话面板出现：
    ```
    Error: tools[0].function.parameters is not valid JSON Schema: no
    schema with key or ref "https://json-schema.org/draft/2020-12/schema"
    ```
- 请求失败，模型无响应，exit 正常但 stdout 只有错误行
- 如果设 model `tool_call: false` 绕过（**注**：目前 OpenCode 并未真正按此 flag 剥除 tools，见下）问题也解决不了
- 我们前一次测试（v1.6.3 发布前）同样配置是能通过的 —— **疑似你们最近收紧了 Ajv 或改动了校验库版本**

## 最小修复建议

在你们 Ajv 实例初始化处增加一行（具体看版本）：

### Ajv 8

```ts
import Ajv from "ajv"
import addMetaSchema2020 from "ajv/dist/refs/json-schema-2020-12/schema"
const ajv = new Ajv({ /* ... */ })
ajv.addMetaSchema(addMetaSchema2020)
```

### Ajv 2020 专用入口（推荐）

```ts
import Ajv2020 from "ajv/dist/2020"
const ajv = new Ajv2020({ /* 原有 options */ })
```

这个入口自带 draft-2020-12 metaschema 注册，**零其他行为变化**。

### 额外建议（可选）

同时支持 draft-07 / 2019-09 / 2020-12，使用 `ajv.addMetaSchema(...)` 注册所有三个。最佳兼容。

## 临时 workaround（如果短期内不能修）

- 接入方可以在发送前**剥掉** `parameters.$schema` 字段（仅客户端 opt-in，社区工具链不会默认做这个）
- 接入方可以把 `parameters` 整个字段转成**不带 `$schema` 的 POJO**后再发

对我们 MedEvidence 这边：我们可以在 MedcodeAuthPlugin 的 `chat.params` hook 里加一层 sanitize，但这算不上体面修复，也会让其他客户端继续踩坑。

## 建议联系渠道

请在修复后通知我们，我们会：
1. 在 `packages/opencode/test/integration/cli-t2-medcode.test.ts` 移除跳过标记
2. 在 MedEvidence Desktop 发布 note 里确认兼容性回归
3. 更新用户验证指南里相关段落

## 附录：我们这边已经做了的事

1. 加了 `docs/cli-integration-test-plan.md` 完整测试计划
2. Tier 2（MedCode 基础聊天）目前因为上述 bug **跳过 tool-enabled 路径**，只测 chat 本身
3. Tier 3/4（medevidence / pubmed 工具）用 tool_call: true 复现此 bug，等你们修复后开放

---

**期望时间线**：尽快。这个 bug 导致任何使用默认 ai-sdk 的接入方都**无法使用 MedCode tool calling**。
