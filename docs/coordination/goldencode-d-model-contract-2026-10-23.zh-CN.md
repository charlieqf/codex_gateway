# GoldenCode DeepSeek 模型合同

实现目标：在保留 `goldencode` 和 `goldencode-local` 的同时，增加 `goldencode-d`。
本文是候选版本合同；上线状态以部署验收记录和鉴权后的 `GET /v1/models` 为准。

| 公共 ID | 上游 | 用途 |
| --- | --- | --- |
| `goldencode` | 腾讯 GLM-5.3、天宽 official/glm-5.3、TokenSwitch GLM-5.3 | 原有云端模型 |
| `goldencode-d` | 腾讯 deepseek-v4.1-flash-1017、天宽 deepseek-v4.1-flash | DeepSeek V4.1 Flash 通用文本／工具模型 |
| `goldencode-local` | 原有本地运行时 | 保留现有入口及限制 |

客户端应从鉴权后的 `/v1/models` 读取列表。Chat Completions 和 Responses 的
`model` 填 `goldencode-d`，不加 `medcode/` 前缀；客户端若使用 provider/model
记法，`medcode/` 是客户端 provider 名。默认模型仍为 `goldencode`。

## 调用和路由

- 两个云端模型使用独立模型池；不跨 GLM／DeepSeek 系列故障切换。
- DeepSeek 使用现有等权 HRW 会话粘性分配，优先 client session、其次 credential、subject。
  同一会话尽量固定；保留既有故障切换开关、共享调用预算、取消及已输出内容限制。
- `reasoning_effort`（Chat）或 `reasoning.effort`（Responses）支持 low/high/max，默认 high。
  为保持客户端兼容，none 映射为 low、medium 映射为 high；不宣称 none 关闭推理。
- 配置上限为 200,000 上下文、128,000 最大输出，以上线后 `/v1/models` 为准。
- 本次 DeepSeek 入口提供文本和客户端 function tools；未配置视觉路由，不宣称图片能力。
  `goldencode` 的既有视觉路由保持原配置。
- 客户端回传完整可见消息、assistant tool_calls 和 tool 结果。云端适配器沿用
  现有对话文本重建机制，以 system/user 消息调用上游；不原样重放上游 assistant
  推理消息，不保存或向客户端暴露私有 reasoning_content。每轮由所选模型重新推理。
- 1017 与 260910 是不同版本；`goldencode-d` 不保证每次都是 1017。
  审计继续记录 public_model_id、upstream_model、runtime 和逐次尝试。

## 会话中切换模型

客户端在下一次请求改变 `model`，并继续回传完整可见消息和工具结果即可。
正在执行的请求仍归属于原模型；建议在一轮完成后切换。需要立即切换时，应先取消旧请求，
确认其终态后发起新请求，使用新的 model-call ID；不可用同一幂等调用 ID 更换模型重放。
保持 client session ID 可维持各模型池内部的会话亲和性，但两个池不共享上游缓存或隐式状态。
切换不重置用户额度，工具执行结果也不能因切换而重复执行。

从 `goldencode` 的视觉会话切到本次文本／工具版 `goldencode-d` 时，不能直接发送含图片的历史。
客户端应保留原模型，或明确移除图片后让用户继续；不能静默丢弃图片语义。

## 授权和迁移

新建真实用户及电话身份准备默认获得三个模型。数据库迁移 44 只将恰好包含
`goldencode` 和 `goldencode-local` 的旧标准凭据扩展为三个模型（包括旧顺序不同的列表）。
不限模型的凭据保持不限；仅 goldencode、仅 local、以及其他自定义列表不扩大权限。
迁移不修改密钥、过期时间、Plan、权益快照、余额、额度和已用量。受限业务 Key 如需
增加 DeepSeek，应另行显式授权。

## 发布要求

将 `config/gateway.goldencode.three-provider.example.json` 中的 **goldencode-d 单个条目**
合并到现网 registry；不能整份覆盖，现网 GLM、local、vision 配置必须完整保留。
沿用两家既有密钥、base URL 和 900000 ms 超时。备份后从已测试的 main 提交部署，
验证迁移、三个模型可见、两家真实工具往返、Chat/Responses 流式及非流式、GLM 回归和
临时测试凭据清理。配置回退只移除新增条目；不恢复数据库覆盖上线后业务记录。

客户端选择器若写死了列表，需要加入 `goldencode-d`；Gateway 仓库不包含 Desktop UI。
