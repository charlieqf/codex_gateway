# 腾讯 GLM-5.3 后付费切换与王伊莲故障核对

2026-09-29 10:11:13 UTC（北京时间 18:11:13）完成配置切换；10:15:28 UTC 完成验证与清理核对。

## 故障结论

王伊莲在北京时间 17:52:01–18:03:32 有 8 次 `goldencode` 请求被腾讯拒绝，HTTP 403，供应商错误码 `403001`、类型 `permission_error`。腾讯说明为“套餐包被禁用或无调用权限”，Gateway 映射为用户看到的“模型处理服务的接入配置异常”。

已确认腾讯套餐通道故障，不能仅据该错误认定额度耗尽；未取得腾讯控制台剩余额度或套餐停用原因。同期她的 5 次天宽请求成功。腾讯失败请求均只有一次供应商尝试，未在该请求内切换成功。

代表请求：

| 北京时间 | Gateway request ID | 结果 |
| --- | --- | --- |
| 17:52:01 | `req-b133d16d-67fe-4f91-bdfd-81e95b5a1f87` | 腾讯 403001 |
| 17:59:16 | `req-d84e145c-3b41-4d00-9b29-5d3bda98280f` | 腾讯 403001 |
| 18:03:32 | `req-c7136835-822d-482b-a9db-fba30a8f6c00` | 腾讯 403001 |

## 授权与变更

用户最初要求额度用完后使用其提供的后付费 Key。在告知套餐停用原因尚未确认、新 Key 已实测可用后，用户明确选择“直接切换后付费，恢复腾讯调用”。

仅修改生产受保护文件 `/opt/codex-gateway-r760/shared/config/gateway.container.env` 的两个变量：

- `MEDCODE_TENCENT_TOKENHUB_API_KEY`：替换为用户提供的后付费凭据。
- `MEDCODE_TENCENT_TOKENHUB_BASE_URL`：由 `https://tokenhub.tencentmaas.com/plan/v3` 改为 `https://tokenhub.tencentmaas.com/v1`。

接口地址依据[腾讯 API 使用说明](https://cloud.tencent.com/document/product/1823/130078)，并由 R760 实际调用验证。新 Key 直连 `glm-5.3` 返回 HTTP 200、精确测试标记及 `stop`，使用 25 tokens，供应商 request ID 为 `473b6e37-a213-4856-a520-006756a811a2`。此测试证明调用可用，不证明账单价格或旧套餐余额。

公共模型、腾讯/天宽池配置、路由和故障切换政策保持不变。没有修改真实用户权益或客户端 Key。新供应商凭据通过 SSH 标准输入传递，只写入生产受保护配置及受保护恢复文件，未写入本地仓库或本地脚本。

## 执行与备份

- 操作前检查唯一 `main` 工作树，fetch 后 `main...origin/main` 为 `0 / 0`；线上提交 `752221dc900651757fcf00b312a2f27762ded656` 是本地 main 的祖先。保留已有未提交工作，无代码发布、提交或推送。
- 沿用线上不可变发布及镜像 `sha256:11a1774097c65e26097c46a73b8dccbae62f9f0729d2d54f56e5064de2fdbc86`。
- 备份目录：`/opt/codex-gateway-r760/backups/tencent-postpaid-20260929T101049Z`。目录 0700，文件 0600；配置复制后校验 SHA-256 一致。
- `gateway.db` 在线快照 444,633,088 bytes；`client-events.db` 在线快照 1,702,998,016 bytes。两份快照均 `quick_check=ok`、外键违规 0；完整摘要保存在受保护的 `manifest.json`。
- 持有部署锁，调用当前发布的 drain 脚本，确认 `active_requests=0`、`active_work=0` 后仅重建 Gateway。排空阶段会关闭新模型请求准入，不宣称零停机。
- 使用线上容器标签指定的 Compose 文件；配置校验通过，解析后的 Compose 差异仅为两个腾讯变量。重建禁止拉取或构建镜像。
- 生效后核对运行时环境差异恰为上述两个变量；镜像、current/previous 指针、端口及其余项目容器 ID 均不变。公网健康在 60 秒期限内连续两次 HTTP 200、ready、draining=false，采样耗时 0.28 / 1.31 秒。

## 验证

通过公网入口使用隔离的临时 service 身份，核对响应及 Gateway 供应商归因：

| 场景 | 结果 | Tokens | Gateway request ID |
| --- | --- | ---: | --- |
| 腾讯文本 | HTTP 200，`tencent / glm-5.3 / ok` | 152 | `req-f118410b-fd2b-4707-838c-47af3baab0a5` |
| 腾讯 required tool | HTTP 200，单个 `multiply(a=17,b=23)` | 375 | `req-04569d20-1272-44bb-9353-3dcbfa757e80` |
| 天宽文本 | HTTP 200，`tiankuan / official/glm-5.3 / ok` | 153 | `req-348992e2-4301-4554-94b4-6b4d139bd778` |

首次自测的精确文本断言未通过，但 HTTP 为 200、腾讯事件为 ok、响应有 20 字符；未把这次自测记为全流程通过。随后明确提示不加标点，并允许测试标记后的句点，三项公网检查通过。

Gateway healthy、restart count 0；切换后日志扫描未见供应商错误，新 Key 未出现在日志中。线上两个数据库均 `quick_check=ok`、外键违规 0。

两次自测账号 `tencent-postpaid-smoke-20260929T101226Z`、`tencent-postpaid-smoke-20260929T101358Z` 均 disabled，未撤销凭据 0，未结算预留 0；凭据撤销后公网请求均返回 401。自测凭据仅在内存中使用。

受保护备份目录内保存 `result.json`、`health-probes.json` 和 `post-verification.json`。本次未重放王伊莲的业务任务，未验证长上下文性能；用户可以重新发起失败的模型请求。

## 回退边界

回退前先确认配置没有新增变化，只恢复本次两个腾讯变量，并沿用当前发布执行排空、Gateway 重建及公网有界健康检查。旧套餐通道仍存在 403001，恢复旧配置不代表恢复业务。不得用数据库快照覆盖切换后的业务记录。
