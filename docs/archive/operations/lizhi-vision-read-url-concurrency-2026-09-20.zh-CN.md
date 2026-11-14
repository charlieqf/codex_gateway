# 李智图片读取链接刷新触发并发限制（2026-09-20）

## 结论

用户看到的 `Concurrent request limit reached: 4 of 4 requests are active.` 已定位到北京时间 **2026-09-20 10:04:03–10:04:04**。

Desktop beta.77 在同一模型回合发送前，一次并行刷新 8 个历史图片资产的 read URL。Gateway 的图片资产接口共用当前凭据的并发限制 4：前 4 个请求占用名额，后 4 个立即返回 429，其中 2 个约 1 秒后重试仍收到 429，最终客户端回合失败。

这里的 4 是图片预处理 HTTP 请求数，不能据此推断用户启动了 4 个模型任务。本回合选择的是云端 `goldencode`；与此前该账号 `goldencode-local` 的摘要上下文超限是两个不同故障。

## 定位信息

- 账号：李智，`subj_Gma1NmklYSPn12bQS_QKnJIB`。
- 凭据 ID：`cred_15WBIvZGrcLSUMDECLIpLA`。
- 客户端：`medevidence-desktop 2.0.0-beta.77`。
- 会话：`ses_f48d4afa9ffeaVoa0LL0ogp6US`。
- 用户回合：`msg_0bc8e5f4c001A9efjqB2lxz3si`。
- 支持码：**`T:QY16EDQZ`**。
- 路由：`POST /gateway/vision/assets/:assetId/read-url`。
- 凭据并发限制：4。该限制按 credential ID 计数。

证据来自 R760 只读 SQLite 查询、限定 request ID 的 Gateway 容器日志，以及 Desktop 源码 tag `v2.0.0-beta.77`（`ced671af9323e3565276915f723c6155a7e07c05`）。本文不保存完整资产 ID、签名 URL、手机号或凭据。

## 时间线

所有时间为北京时间。

| 时间 | 事件 |
| --- | --- |
| 10:04:03.094 | 客户端开始 `research` 回合，public model 为 `goldencode` |
| 10:04:03.156 | 客户端请求形状记录 98 条消息、11 个图片部分；此记录早于最终图片投影/刷新，不等于 11 次 read-url 请求 |
| 10:04:03.433–.447 | 4 个 read-url 请求进入，分别占用并发名额 |
| 10:04:03.450–.482 | 另外 4 个不同资产的 read-url 请求返回 HTTP 429，`limit_kind=concurrency` |
| 10:04:04.497–.504 | 其中 2 个资产再次请求，仍返回 HTTP 429 |
| 客户端 10:04:04.407 | provider request 记录 `VisionAssetError` |
| 客户端 10:04:04.413 | agent turn 终态为 error |
| Gateway 10:04:04.532–.547（由起始时间与耗时计算） | 首批 4 个请求均记录为 `client_aborted`，耗时约 1.1 秒 |

客户端与 Gateway 为不同机器的时钟，因此跨机器毫秒时间不用于判断严格先后。单看 Gateway 记录，第二批重试发生时首批请求仍未结束。

实际日志统计为 **8 个不同资产、10 次 read-url 请求、6 次 429**。首批 4 次被中止不能解释为成功刷新了 URL。

首批占用请求：

| Request ID | 开始时间 | 耗时 ms | 结果 |
| --- | --- | ---: | --- |
| `req-a4c05846-77dd-47f5-abc4-77f8fd6eea70` | 10:04:03.433 | 1099 | client_aborted |
| `req-d85c26f0-5bd5-4903-a980-43b9eaf94b73` | 10:04:03.440 | 1104 | client_aborted |
| `req-a4105594-6e1f-4ad2-bd9d-d826cb30d9f4` | 10:04:03.444 | 1103 | client_aborted |
| `req-45b5a251-2dba-4550-8346-132c0a9c189b` | 10:04:03.447 | 1099 | client_aborted |

429 请求：

```text
req-4413620a-6e50-48d7-a002-bed292a3d36b
req-b1153ee5-7465-447b-91f1-af2772356cfc
req-4e1f1e49-9eb6-4851-8e00-d93b53c40987
req-3c1eff94-acce-4c68-a933-9352b47ca4f3
req-5fea9ab2-8d6f-40de-9021-fcb1430b1f79
req-29e493dc-d949-4ce1-86f3-2845ae29e38f
```

Gateway 没有找到该用户回合对应的模型生成请求记录，客户端明确在图片准备阶段失败。该轮的 429 不属于模型供应商生成阶段。

## 实现原因

Desktop beta.77 的 `packages/opencode/src/medcode/vision-asset.ts`：

- `refreshedURLs` 对去重资产集合直接使用 `Promise.all`，没有批次或并发队列。
- `readURL` 为每个资产分别请求 Gateway。
- `gatewayRequest` 对 429 等状态等待后重试一次；没有等待同一凭据其他资产请求释放名额的协调机制。
- `session/llm.ts` 的视觉 `prepareStep` 调用 `refreshMessages`，刷新失败会阻断模型请求。

Gateway 的 `vision-asset-routes.ts` 给 read-url 路由使用普通凭据限流，未跳过 `rateLimitHook`。`InMemoryCredentialRateLimiter` 的 active 按 credential ID 共享，图片请求也占用名额。`createReadUrl` 包含 R2 ready marker / 对象 metadata 检查，存在异步在途时间，因此单回合的资产并发即可填满 4 个名额。

客户端的无界批量刷新与接口的凭据并发策略不匹配，是本次失败的直接原因。现有证据不足以将请求被中止进一步归因为用户主动点击停止；回合失败后的取消也可能产生相同记录。

## 是否长期占满

首批 4 个请求均已有 `client_aborted` 终态，源码在客户端断连时调用 `releaseRateLimit`。查询时该用户无未结算 token reservation；但 reservation 并非内存并发计数，不能用它直接宣称 active=0。

截至本轮查询，当天并发拒绝仍只有上述 6 次，最后一条为 10:04:04.504。10:11:54 之后该账号在另一会话已有 5 次 `goldencode` 请求成功，另有生图成功记录。因此没有持续全额占满或需要靠重启释放的证据。

## 修复方向与临时恢复

客户端应按凭据协调图片 read-url 请求，限制同时在途数，为其他请求预留空间；相同资产的并发刷新合并，并在有效期内复用仍可用的 URL。429 按 Retry-After 和总体截止时间进入队列，不让同一批重试再次争抢相同名额。多个会话共享凭据时也应共享该调度。

Gateway 可另行评估为视觉资产元数据接口设置独立、受限的并发/速率预算，避免和模型生成争用同一计数；不应直接取消限流。单纯提高当前账号上限不能从机制上解决无界请求扇出。

用户可先在新会话只带必要图片继续任务；对原会话原样重试仍可能一次刷新同一批历史资产。

本次仅调查和新增本文，未修改账号限额、客户端实现或生产配置，未部署、重启或重放用户模型请求。
