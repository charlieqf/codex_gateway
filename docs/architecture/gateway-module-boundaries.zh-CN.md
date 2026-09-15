# Gateway 入口与模块边界

更新：2026-09-15。

`apps/gateway/src/index.ts` 保留 `buildGateway`、HTTP 路由注册、请求生命周期编排和直接启动入口。独立策略、配置解析、提供商构造、工具执行、错误序列化与遥测不再放进入口文件。本次拆分由 8,630 行降至 3,577 行，新增模块最大 657 行。

## 职责分配

以下路径均相对于 `apps/gateway/src/`。

| 模块 | 职责 |
| --- | --- |
| `gateway-options.ts` | Gateway 的公开配置类型；入口继续转导出原有类型 |
| `runtime/env.ts`、`runtime/auth-config.ts` | 环境参数解析、鉴权模式与生产启动约束 |
| `runtime/gateway-state.ts` | 默认存储、开发身份、公开元数据、存储能力判断 |
| `runtime/chat-providers.ts` | 对话与视觉适配器构造、本地推理健康判断 |
| `runtime/upstream-accounts.ts` | 上游账号与公共模型池组装、账号运行状态记录 |
| `runtime/image-providers.ts` | 图片提供商与计费备用账号配置 |
| `runtime/research.ts` | 研究运行时、存储隔离、来源配置与就绪要求 |
| `services/native-client-tools.ts` | 原生工具收集、校验、重试与 A/S 结果衔接 |
| `services/native-tool-policy.ts` | 工具选择、文件任务判断、重试决策和纠错提示 |
| `services/strict-client-tools.ts` | 严格 JSON 工具输出的解析与修复流程 |
| `services/client-tool-types.ts`、`services/client-tool-output.ts` | 工具执行类型、调用 ID、输出和 usage 转换 |
| `services/write-delivery.ts` | A/S 协商、超长写入分类和无损交付；固定 schema 单独存放 |
| `services/chat-request-shaping.ts`、`services/reasoning-policy.ts` | 请求形状、运行时归属、亲和性与推理参数策略 |
| `services/image-execution.ts` | 图片请求取消、账号选择、失败判断与备用执行 |
| `services/client-key-auth.ts` | 统一密钥鉴权、订阅暂停校验与审计 |
| `services/client-event-ingest.ts` | 客户端事件关联、补链、去重与限流参数 |
| `http/gateway-errors.ts` | HTTP、SSE 和 Responses 错误响应 |
| `http/provider-telemetry.ts` | 提供商错误、流摘要、usage 与客户端请求头归属 |

## 维护约束

- 新模块不得以值导入依赖 `index.ts`；共享类型使用 `import type`，避免入口和服务循环加载。
- `buildGateway`、`validateRuntimeEnvironment` 与四个公开配置类型继续从 `index.ts` 导出，保持已有调用方兼容。
- 路由负责组装依赖和推进生命周期；可独立解释、复用或验证的策略进入所属服务模块。
- 后续拆路由时，按路由族定义依赖接口；避免传入一个可访问全部内部状态的上下文对象。

## 拆分验证

以拆分前的当前工作区为基准，逐一比对 248 个顶层声明；除新增 `export` 和换行格式外，声明内容一致，包括 `buildGateway` 函数体。拆分不覆盖已有运行密钥校验和 A/S 开发改动。新增模块之间不存在值导入循环，服务模块不反向引用入口。

验证结果：`npm run typecheck` 通过；`npx vitest run apps/gateway/src` 共 812 项通过、3 项跳过（38 个测试文件通过、1 个跳过）。这项重构不要求修改生产配置。
