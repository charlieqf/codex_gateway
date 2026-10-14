# TokenSwitch GLM-5.3 三平台接入记录

北京时间 **2026-10-14 08:36:50** 完成配置切换，08:40:27 完成最终核验。公共模型仍为 `goldencode`，现有 Gateway 镜像/代码版本 `94b60aec5974e0aafadf0aeeba05fe045b745da2` 不变。本次复用现有 TokenSwitch 适配器和负载均衡逻辑，没有新增运行代码。

## 生效配置

| 池成员 | runtime | 上游模型 | 状态 |
| --- | --- | --- | --- |
| goldencode-tencent | tencent | glm-5.3 | 启用 |
| goldencode-tiankuan | tiankuan | official/glm-5.3 | 启用 |
| goldencode-tokenswitch | tokenswitch | glm-5.3 | 启用 |

TokenSwitch 使用已有配置体系中的 `https://neolink.com/api/v1`，Key 鉴权与模型列表实测成功，列表返回 glm-5.3。[供应商官方文档](https://neolink.ai/docs/en/instruction-manual/chat/01-openai)说明 OpenAI 兼容聊天接口；本次实际地址与模型以 R760 调用结果为准。

三家适配器的 timeout 均为 900000 毫秒，goldencode 原请求总预算仍为 900000 毫秒，内部重试不重置预算。视觉 xAI 与本地模型配置保持原值。

沿用等权 HRW 会话粘性分配，优先 client_session，其次 credential、subject。3000 个模拟会话的选择结果为腾讯 999、天宽 983、TokenSwitch 1018；这只验证分配函数，不是生产流量统计。不同会话尽量分摊，同一会话尽量固定平台，不能保证每三个请求各发一家。增加成员会使部分已有会话在下一次调用时映射到新成员。既有失败切换规则、尝试次数上限、403 处理和 quota cooldown 均未改变。

仅更新四个受保护环境项：`MEDCODE_PUBLIC_MODELS_JSON`、`MEDCODE_TOKENSWITCH_API_KEY`、`MEDCODE_TOKENSWITCH_BASE_URL`、`MEDCODE_TOKENSWITCH_TIMEOUT_MS`。Key 只保存在 R760 受保护的密钥文件及生产 env 中，权限均为 0600；不进入源码、报告或普通日志。

仓库新增[三平台示例](../../config/gateway.goldencode.three-provider.example.json)，并将两个 env 示例的 TokenSwitch timeout 改为 900000。示例不是完整生产配置，不应整份覆盖包含 vision、本地模型等设置的现网注册表。

## 接入前验证

使用合成内容、不执行实际工具，由现网镜像中的 TokenSwitch 适配器独立调用：

- low 文本标记：HTTP 200，输出匹配，约 0.85 秒。
- high 中文正文：12 行中文逐字一致，无 U+FFFD，约 4.74 秒。
- max 指定 write 工具：中文 content 与文件名精确匹配，无 U+FFFD，约 26.63 秒。
- high 工具结果续接：已有 assistant tool call + tool result 历史正常接受并返回预期标记，约 1.19 秒。
- 额外约 72 万字符合成输入，`max_tokens=128000`：HTTP 200，返回短标记，约 3.56 秒。验证长输入与输出上限参数可接受，没有故意生成 128000 token，也不能据此确认完整上下文边界或复杂长任务性能。

各响应严格 UTF-8 解码通过。low/high/max 参数均可调用，不据此声称各供应商底层推理语义完全相同。有限样本无乱码不保证长期流量零乱码。

现有模型注册表和路由测试共 **36 项通过**；候选注册表由部署镜像的实际解析器与适配器工厂校验通过。未新增业务测试、兜底分支或定时任务。

## 公网自测

通过现有会话散列选中各平台，并只读核对 request_events 实际归因：

| 场景 | Gateway request ID | 用时 | Token |
| --- | --- | ---: | ---: |
| 腾讯文本 | req-a8537e65-23af-464a-987a-5cb746908bb2 | 968 ms | 135 |
| 天宽文本 | req-fa25b2aa-8700-4545-92bb-e04b177a5466 | 8894 ms | 135 |
| TokenSwitch 文本 | req-84f07edb-12f2-48cd-b84d-c6842a86f565 | 728 ms | 134 |
| TokenSwitch 中文 write 参数 | req-590342eb-ac2b-49ad-ac1e-547ac46c2c72 | 1694 ms | 469 |

四笔均成功、无 U+FFFD，均观察到 running progress 与 900000 毫秒预算。TokenSwitch 的文本与工具请求使用同一 client session，路由保持一致。终态 GET 恢复响应与原结果哈希一致；同 call ID 重放结果一致，未增加模型预留记录。没有实际执行 write。

首轮自测因腾讯返回 `OK.` 而测试只接受 `OK` 停止；该请求本身成功。将普通英文标记检查调整为允许句末标点后重新通过，中文工具参数仍逐字严格比较。首轮证据保留在服务器 staging，未将其当作供应商故障。

两轮临时主体均已禁用，有效凭据 0、未结算预留 0；临时 entitlement 取消，撤销凭据访问公网返回 401。保留必要审计记录。

## 备份、切换与回退

- 已 fetch 并确认 main 与 origin/main 同为 `8c0d566`，现网 `94b60ae` 为其祖先；仅复用现网已提交、已验证镜像，不发布脏工作区。
- 配置备份：`/opt/codex-gateway-r760/backups/tokenswitch-20261014T003626Z`，目录 0700，含密钥的 env/candidate 文件 0600。
- 数据库备份：`/data/backups/codex-gateway-daily/tokenswitch-20261014T003626Z`。gateway.db 513146880 bytes，client-events.db 1790742528 bytes；备份 quick_check=ok、外键违规 0。
- 部署锁保护下排空并仅重建 Gateway；四项环境变量差异经过精确核对。镜像、current/previous、挂载、端口和其他项目容器 ID 均保持不变。
- 切换/验证区间约 15 秒（00:36:35.818—00:36:50.813 UTC），不等同于精确公网中断时长。公网在固定 60 秒期限内连续两次 HTTP 200 / ready，无回滚。
- 最终 healthy、restart count 0，Gateway 与 client-events 两个在线数据库 quick_check=ok、外键违规 0。切换后核查日志 error/fatal/warn 均为 0。

若需撤回 TokenSwitch，优先仅禁用该 pool member，并按同样备份、排空、重建与公网验证流程操作；不要恢复数据库覆盖新增业务记录。恢复完整 env 前必须核对期间是否有其他配置变更。

## 脱敏证据

[接入前预检](../../artifacts/tokenswitch-three-provider-20261014/preflight.jsonl)、[长输入预检](../../artifacts/tokenswitch-three-provider-20261014/long-preflight.jsonl)、[配置切换](../../artifacts/tokenswitch-three-provider-20261014/activation.json)、[分配校验](../../artifacts/tokenswitch-three-provider-20261014/routing-validation.json)、[公网收敛](../../artifacts/tokenswitch-three-provider-20261014/public-convergence.json)、[公网自测](../../artifacts/tokenswitch-three-provider-20261014/public-smoke.json)、[最终核验](../../artifacts/tokenswitch-three-provider-20261014/final-verification.json)。服务器操作脚本及首轮自测记录保留在 `/opt/codex-gateway-r760/staging/tokenswitch-20261014/`，临时 `/tmp` 预检脚本已清理。
