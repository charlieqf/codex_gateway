# 图片链接刷新独立限流：实现研究与验收方案

日期：2026-09-20。
状态：实现、测试、上线和公网验收均已完成。部署版本 `4b1dc8f`；正式证据见 [发布记录](../operations/r760-vision-read-url-release-2026-09-20.zh-CN.md)。下文保留研究阶段的现状、设计依据和验收基准，最终容量见第 11 节。

## 1. 结论与边界

建议给 **`POST /gateway/vision/assets/:assetId/read-url`** 设置独立限流策略：同一已认证主体 `subject.id` 共用 20 个并发名额，并拥有独立的分钟、日计数。多设备、多会话、同主体的不同 credential 共用这组额度。

在统一 HTTP 限流入口选择一次策略，使用现有算法的独立实例计数。一次刷新只申请一次许可，不进入普通 credential 计数器。普通请求继续使用原来的 credential 策略；该用户目前是并发 4、20 次/分钟、200 次/UTC 日。

20 个名额限制的是 Gateway 尚未收尾的链接刷新工作，不是图片生成、上传、识图推理、模型输出或用户拥有的图片数量。它也不是全站容量上限，更不能保证远端 R2 在收到取消后立即停止处理。

本次 8 张图的刷新可容纳在 20 个名额中。但三个会话各刷新 8 张图可同时产生 24 个请求，仍会限流。因此，20 是建议的初始容量，不能据此承诺客户端今后无需处理并发、排队或重试。

## 2. 实施前代码与实际问题

| 位置 | 当前行为 | 影响 |
|---|---|---|
| `apps/gateway/src/http/rate-limit.ts` | 统一 hook 按 `credential.id` 和 `credential.rate` acquire | 图片刷新和模型请求共用三种计数 |
| `apps/gateway/src/services/rate-limiter.ts` | 一张内存 Map；每个 key 有 active、minuteCount、dayCount | 同一个 key 换 policy 不会得到独立额度 |
| `apps/gateway/src/vision-asset-routes.ts` | read-url 没有特殊限流分类 | 会被普通请求规则拦截 |
| `apps/gateway/src/services/vision-asset-service.ts` | 刷新先验证主体/资产 token，再依次 HEAD ready marker、HEAD 图片元数据 | 每次成功刷新通常有两次串行 R2 查询，不下载完整图片 |
| `apps/gateway/src/index.ts`、`http/client-disconnect.ts` | HTTP 断开即释放 permit | 存储工作若尚未停止，可提前腾出名额 |
| `vision-asset-service.ts` | 有 R2 请求超时，但不接收 HTTP disconnect signal | 客户端断开后原 R2 请求仍可能继续 |

现有限流器在全部检查通过后，才同时增加 active、minuteCount、dayCount；限流拒绝不扣次。release 幂等且只减 active，不退分钟/日次数。分钟为固定 UTC 分钟窗口，日为 UTC 自然日。这些行为可以沿用。

Desktop 源码 `packages/opencode/src/medcode/vision-asset.ts` 中，`refreshedURLs` 用 Set 对本批 asset 去重，随后 `Promise.all` 刷新。不能把同一批的 11 个 image parts 理解为 11 个独立资产，也不能无证据地认定 `refreshMessages` 与 `prepareRequest` 一定重复刷新：rewrite 会去掉 URL 中的资产标记，后续扫描不再从这些已改写 URL 收集到相同资产。

客户端对 HTTP 429/502/503/504 有一次重试，等待上限仅 2 秒；此前还可能发生网络异常重试。因此，过低的分钟限额不会单凭 `Retry-After` 就被当前客户端可靠消化。

## 3. 分类必须由已注册的路由决定

建议新增明确的 route config 字段，例如 `rateLimitProfile: "vision_read_url"`，仅标在该 POST 路由上。未标记的受保护路由继续走普通策略。选择器读取 Fastify 已匹配路由的元数据，不读取客户端指定的类别。

| 请求 | 是否可使用这 20 个名额 | 计数来源 |
|---|---|---|
| POST `/gateway/vision/assets/:assetId/read-url` | 是 | 独立图片刷新实例，以 subject.id 为 key |
| POST `/gateway/vision/assets` | 否 | 原 credential 策略 |
| POST `/gateway/vision/assets/:assetId/complete` | 否 | 原 credential 策略 |
| DELETE `/gateway/vision/assets/:assetId` | 否 | 原 credential 策略 |
| GET `/gateway/vision/capabilities` | 否 | 原 credential 策略 |
| `/v1/chat/completions` 等模型请求，包括带图片输入 | 否 | 原 credential 策略及原 token/权益规则 |
| 图片生成、编辑接口 | 否 | 原有规则 |
| 错误方法、未注册路径、相似路径 | 否 | 原有路由及错误处理规则 |

实现时给 `vision_read_url` 配置增加启动期约束：只能用于上述 method + 路由模板，不能同时配置 public、skipAuth 或 skipRateLimit。未知 profile 应报配置错误。这样将来复制路由配置时，也不能静默扩大受益范围。

不用 `url.includes("vision")`、宽泛 `/gateway/vision/` 前缀、Content-Type、model 字段或请求头决定类别。查询字符串、assetId、伪造 header/body 都不能更换预算。签名资产的主体归属、有效期、ready marker、元数据校验保持执行。

## 4. 只保留一套计数算法、一次准入决策

建议的数据流：

```text
已认证请求
  → 读取已匹配路由的 rateLimitProfile
  → 选一个 limiter、一个 key、一个 scope、一个 policy
  → acquire 一次
  → 获准则执行业务；被拒则使用现有统一 429 响应
  → 请求与其后台工作均结束后 release 一次
```

独立实例应在 Gateway 启动时创建一次并长期共享，不能每次请求或每个 session 新建。普通实例保持原 key；图片实例以 subject.id 为 key。资产 ID、消息 ID、会话 ID、手机号都不适合作为图片预算 key。

选择器的结果可表达为：

```ts
// 设计示意，非已实现接口
type SelectedRateLimit = {
  limiter: RequestRateLimiter;
  key: string;
  scope: "credential" | "subject";
  policy: RateLimitPolicy;
};

// 普通请求：existingLimiter / credential.id / credential / credential.rate
// 图片刷新：visionReadUrlLimiter / subject.id / subject / visionReadUrlPolicy
```

**需要一次小而明确的内部接口整理：**现有限流器名为 `CredentialRateLimiter`，输入字段叫 credentialId，错误中的 scope 又硬编码为 credential。底层实际上已经被电话/IP/Research 等合成 key 使用。建议将内部输入整理为 `key + scope + policy`，类/接口相应改为通用请求限流器名称；state Map、检查顺序、窗口、prune、release 算法保持不变。其他调用点做机械适配，保留原 key、原 scope 和行为。不要把 subjectId 塞进名为 credentialId 的字段，再在响应层补丁式修改 scope。

这属于仓库内部接口变更：需同步其使用者与测试，但不改数据库 credential.rate、不改 Plan 快照、不更改 Billing HTTP 合同。内部 reset 的 key 命名也同步整理，Billing 对外仍返回原 credential_id 等字段。

图片 profile 应在普通分支的 `!credential.id || !credential.rate` 提前返回之前处理。图片限流依赖已认证的 subject；不能因为某种合法身份没有普通 credential.rate，就意外无限制。普通分支的既有兼容行为保持原样。缺少所需身份上下文的图片请求不得进入存储服务。

### 计数含义

- 一次获准进入 read-url 的 HTTP 请求，图片分钟计数 +1、日计数 +1、active +1；两次内部 HEAD 不重复扣次。
- 普通预算三项均不变。普通模型请求也不能占用或增加图片预算。
- 图片侧 429 不增加分钟/日计数；已获准后发生无效资产、权限/业务拒绝、R2 失败、超时或客户端断开，不退已扣次数。
- 每次客户端重新发起并被接受的重试算新请求；不是每张图片每天只计一次。这样失败重试也不能绕过频率保护。
- 当前全局 preHandler 早于 handler 中的权益与参数验证。维持这一顺序意味着已获准、随后被业务拒绝的请求仍计次；“图片次数”不是“成功签发数”。未通过入口身份认证的请求不进入该计数。
- 账户两把 key、多个设备或会话共用图片预算，不能通过换 key 再获得 20 个名额。不同主体互不挤占；普通请求的计数维度仍为 credential。

### 运行与运维语义

独立次数第一版沿用现有内存窗口，不需要为图片新增 SQLite 日志表、Redis、定时归零任务或另外一套限流算法。重启会清空这些计数，多 Gateway 进程不会自动共享；它是单进程运行保护，不是可跨重启追溯的计费账本。若部署变为多副本，需要另行处理原有和新增限流的一致性。

现有 Billing request quota reset 仍只操作普通 credential limiter，不暗中清除图片预算，且不清 active。若以后需要独立清除图片分钟/日额度，应有明确的资源类别和主体范围；本次不顺带增加管理 API。

## 5. 必须处理的取消与释放问题

本地复现已证明：当前 HTTP disconnect signal 已 aborted 时，R2 fetch 的 signal 仍未 aborted；旧 HEAD 尚在等待，同一 credential 的替代请求已能申请刚释放的名额。仅把并发值改成 20，会保留这一空隙。

推荐将“请求结束”和“业务工作结束”明确关联，而不是靠延迟几秒再 release：

1. read-url 服务增加可传入的 AbortSignal，并沿 `createReadUrl → readyMarkerExists / verifyObjectMetadata → headObject → authenticatedRequest` 传递。
2. R2 请求合并客户端取消与现有超时 signal。启动第一条请求前、两次 HEAD 之间均检查取消，避免断开后继续下一条 HEAD。客户端取消保持 client_aborted 归因，不能被 catch 统一改成存储 503；正常存储失败保持原错误合同。
3. 统一 HTTP permit 生命周期支持一个工作持有期：read-url handler 在第一次 await 前登记持有，finally 归还。HTTP 结束/断开只是请求释放；持有期未结束时先取消工作，待工作 Promise 实际收尾后才真正 release。普通路由不登记持有，释放时机保持原状。
4. 该小型生命周期对象负责幂等和唯一释放，onResponse、disconnect、finally 不各自维护计数。也不新增第二个图片并发 semaphore，以免出现两处 active 不一致。
5. 验证断开早于 acquire、早于 handler、发生在两个 HEAD 之间及超时同时到达的情况。已取消请求不得再次开始工作或留下后申请的 permit；监听器和 timer 必须清理。

生命周期规则可简化为：`releaseRequested && pendingWork === 0` 时释放底层 permit。没有登记工作时，仍然等价于现有 release。必须在持有登记时检查该 permit 是否已结束，并检查请求 signal，不能把“已释放名额”重新变成工作持有。

当前 R2 默认超时是**每条请求** 30 秒，两个串行 HEAD 不能宣称整个刷新最多 30 秒。本次先沿用既有超时配置并打通取消，不顺带重写全部存储超时体系。若测试发现需要整个刷新的 deadline，再作为明确的行为变化评审。

## 6. 分钟/日阈值如何确定

并发 20、每分钟 M、每日 D 是三个独立参数，不能都设置为 20，也不能继续借用普通用户的 20/200。

当前单次模型请求图片上限为 8。以本次用户的普通预算作估算：

| 假设 | 正常刷新量 | 留 2 倍余量的候选值 |
|---|---:|---:|
| 20 次模型 HTTP 调用/分钟，每次都刷新 8 个资产 | 160 次/分钟 | 320 次/分钟 |
| 200 次模型 HTTP 调用/UTC 日，每次都刷新 8 个资产 | 1600 次/日 | 3200 次/日 |

因此 `concurrentRequests=20, requestsPerMinute=320, requestsPerDay=3200` 可以作为**针对这一使用档位的测试候选**。2 倍是容量余量假设，不是对所有失败、网络重试、准备后未发送模型请求的严格上界。不能把这组数直接宣布为全体用户已验证的生产默认值：普通额度更高、每天不限次、多 credential 合计使用量更大的主体需要额外评估。

实现上建议有一个集中解析和校验的 visionReadUrlPolicy，以及可注入的 limiter/clock。并发默认候选 20；分钟/日必须为明确、有限的正整数，拒绝 NaN、负数、0、空值被误解为无限制。配置只在启动时解析，不在每次请求临时读取环境。三个参数使用相同 `VISION_READ_URL` 配置前缀，不能借用图片生成参数。

不要在 acquire 时用当前 key 的模型额度动态乘 8：同一主体换 key 会令同一个图片桶使用不同上限，且 key 的付费/免费额度变化会隐式改变资源保护。若需要按套餐区分，后续应给主体解析一个稳定策略；本次先选择明确的统一策略并核对适用用户范围。

并发 20 表示每主体最多 20 个在执行的刷新。由于两条 HEAD 串行，一批 20 个成功刷新通常总共 40 次 HEAD，不能直接说同时 40 个。固定分钟窗口在边界可连续接纳两个窗口的额度；多主体总 R2 压力仍需在受控环境压测。不要以局部单元测试代替 R2 容量验证。

## 7. 错误合同与观测

复用现有 `rate_limited`、`limit_kind=concurrency|request_minute|request_day`、Retry-After、request_id、rate_limit_contract_version=1 和统一错误生成函数。图片额度的 `limit.scope` 应为 subject；普通请求仍为 credential。第一版无需新增三种 LimitKind 或要求客户端升级解析协议。

增加结构化观测字段 `rate_limit_profile=vision_read_url`，至少记录路由模板、limit_kind、scope、maximum、used、request_id、耗时、取消与拒绝结果，用于区分图片频率保护和普通模型额度。已有 request_events 中的 limit_kind 本身不能表明资源类别，不能声称现在已能从该字段独立统计所有图片刷新。

日志使用路由模板，不输出完整 asset token、签名 URL 或 Authorization。若只新增结构化日志，应明确保留期，不能将内存计数和日志当作长期计费记录。

## 8. 修改范围与避免堆叠

| 修改单元 | 必要变化 |
|---|---|
| `services/rate-limiter.ts` 与内部调用者 | 通用 key/scope 命名；算法不复制、不改变其他消费者语义 |
| `http/context.ts`、`http/rate-limit.ts` | route profile、单一策略选择、统一 acquire/429、工作持有与释放 |
| `gateway-options.ts`、`index.ts`、集中策略解析模块 | 创建一个图片 limiter，解析一次 policy，配置约束，连接既有钩子 |
| `vision-asset-routes.ts` | 仅 read-url 标记 profile，持有工作周期并传递 signal |
| `services/vision-asset-service.ts` | 取消信号沿只读查询路径传播、保留正确错误归因 |
| 对应测试及限流运维说明 | 验证独立额度、权限、路由、计数、取消与兼容性 |

分开验证“内部接口整理保持行为”“新增 profile 与隔离”“取消生命周期”三个变化，最后统一集成测试。未验证全部完成前不发布一个仅跳过旧限流的中间版本。

不要在 handler 加第二次 acquire、用 skipRateLimit 绕开后忘了补保护、事后退普通次数、全局提升 credential 并发、复制 rate-limiter.ts、每张图建立独立 20 名额、增加一套日历归零任务、为此次修复扩建批量刷新/缓存/排队框架。现有 dirty 工作树中的其他修改要单独保留，本方案不要求夹带发布。

## 9. 必须满足的验收条件

| 类别 | 必须验证 |
|---|---|
| 原事故 | 8 个有效资产同时刷新均能进入；普通模型计数不增加；随后普通模型请求可进入 |
| 并发边界 | 挂起 20 个刷新，第 21 个 429；普通 4 个仍可进入；普通第 5 个仍按原限制拒绝 |
| 双向隔离 | 普通分钟/日/并发耗尽不阻止合法刷新；图片任一额度耗尽不阻止仍有额度的普通请求 |
| 分钟和日 | fake clock 验证到边界归零、UTC 午夜、Retry-After；被拒不扣次、已接纳失败计次、两次 HEAD 只扣一次 |
| 主体维度 | 同主体两个 key 合计只有 20；不同主体独立；key 轮换不会清图片预算 |
| 路由与权限 | 创建、complete、删除、生成、模型请求不能借用额度；伪造 header/body/路径无效；失效身份、越权/篡改资产不访问 R2 |
| 配置 | profile 方法/路径不匹配或与 skip/public 冲突时启动失败；配置非法时不能静默无限制 |
| 生命周期 | 成功、4xx、5xx、异常、超时、断开都最终释放一次；断开后旧工作未收尾时不得额外准入；不继续第二次 HEAD |
| 竞争时序 | onResponse/disconnect/finally 重复到达不超放；acquire 前后取消不泄漏；没有永久占位 |
| 兼容性 | Billing reset、电话/IP/device、Research、client events、普通流式响应和原错误合同保持行为 |

计数与并发测试必须使用屏障或可控 Promise，不能依赖 sleep 后“应该在执行”。断开测试至少有一个真实本地 HTTP socket，不能只用 inject 成功路径推断断开安全。存储用可取消 fake fetch 测试边界；生产 R2 压测是另一个有明确负载范围的步骤。

现有 `vision-asset-routes.test.ts` 只注入身份上下文，没有装全局 rateLimitHook，单独给它增加几个 handler 测试不足以证明隔离。需要使用真实 Gateway hook 顺序的集成测试，并对普通模型计数与图片计数同时断言。

## 10. 研究阶段完成的验证（实施前）

现有 5 个测试文件 58 项通过：rate-limiter、client-disconnect、error-response、vision-asset-routes、vision-asset-service。

另运行 index.test.ts 中 7 项相关集成基线，全部通过：Billing request/token reset、client messages 独立限流、messages/diagnostics 分桶、vision broker 注册、请求事件/限流记录、图片请求断开、流式 chat 断开。其余 283 项未在本次筛选运行。

历史组件复现脚本针对实施前的 `078d890` 接口：`.codex-tmp/vision-read-url-rate-research-20260920.ts`。下面命令记录当时的执行方式；新版本的接口和已修复行为应以正式回归测试验证：

```powershell
node --import tsx .codex-tmp/vision-read-url-rate-research-20260920.ts
```

四组实测均符合预期：

1. 用缩小的 8 次分钟阈值复现：8 次图片刷新耗尽共享计数，下一普通请求被拒；日计数也累计 8。
2. 同 key 仅改用 20 并发 policy：已有 4 个普通请求时只能再接纳 16 个图片请求，证明只换上限没有隔离。
3. 现有算法的两个独立实例：20 个图片任务与 4 个普通任务可同时持有；两侧次数分别为 20、4；重复释放图片许可不影响普通任务。
4. 使用真实 R2VisionAssetService + 真实 HTTP 限流/断开组件、模拟存储传输：HTTP 已取消，R2 signal 未取消，旧工作仍 pending，但替代请求已获准。此为组件复现，尚非完整 socket 集成验收。

这些是**现状与设计依据验证**，不是新功能已完成的验收。本次未修改生产实现、用户额度、数据库或部署状态；没有使用真实 R2 凭据或外部存储调用。正式实施仍需补齐上表测试并评估最终 M/D 与全站容量。

## 11. 实施时的容量选择与留存核对

2026-09-20 实施前只读核对活动 credential：286 个 key / 284 个主体使用 20/200/4；还有 30/600/8、30/不限日/1、20/500/4、30/1000/4、60/200/4、60/5000/8、120/不限日/10 等档位。原 320/3200 候选不足以覆盖这些档位。

统一图片资源保护的初始值据此选择 **20 并发、1920 次/分钟、80000 次/UTC 日**：分钟按已见最高 120 RPM × 8 图 × 2 倍余量；日按已见最高有限 5000 RPD × 8 图 × 2 倍余量。它不随请求所带 key 改变；不限普通日次数的账户仍受这个有限的图片资源保护上限约束。这不是套餐权益扣减，也不是已证明的最大存储吞吐量，需结合受控 R2 测试与上线后观测复核。

配置名为 `GATEWAY_VISION_READ_URL_CONCURRENT_REQUESTS`、`GATEWAY_VISION_READ_URL_REQUESTS_PER_MINUTE`、`GATEWAY_VISION_READ_URL_REQUESTS_PER_DAY`；省略时使用上述初值，非法值启动失败。

R760 当前 Docker 日志按 json-file、50 MB × 5 个文件轮转；图片操作日志随其保留，不能承诺固定天数。新增日志与 read-url 请求日志使用路由模板，隐藏 asset token、查询参数和签名链接。

03:13 UTC 开始的生产 R2 有界预检使用 40 张临时 68-byte PNG：8 并发、20 并发、两个主体合计 40 并发均成功，刷新 p95 分别为 1655 / 1700 / 1833 ms。共 68 次刷新，40 个临时资产均已删除，没有 Gateway 账户写入或模型调用。这验证当前存储路径在该短时负载下可用，不代表全站持续容量；旧 Gateway 的 HTTP 限流未在该存储预检中更改。
