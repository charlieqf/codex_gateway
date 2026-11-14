# Gateway 最近 12 小时检查

统计窗口：2026-10-19 21:40:32 至 2026-10-20 09:40:32（北京时间）。UTC 为 10-19 13:40:32 至 10-20 01:40:32。模型统计按请求完成时间计入，避免漏掉跨窗口开始、窗口内结束的长请求；不包含之后新开始的调用。

## 结论

Gateway 当前健康，公网 health=200/ready。最近 12 小时共 354 次已完成模型调用，352 次成功、2 次失败，成功率 99.44%。其中包含 Desktop 团队联调账号的 69 次调用；剔除后业务调用为 285 次、283 次成功，成功率 99.30%。两次失败均为 DealViewer 输出预算耗尽。未发现模型调用最终因连接超时、上游空响应或工具格式校验失败而终止。

成功请求耗时中位数 18.62 秒，P95 36.95 秒，P99 103.66 秒，最长 275.30 秒。成功请求中 4 次超过 60 秒，1 次超过 180 秒，0 次超过 300 秒。

| 最终上游 | 调用数 | 成功 | 失败 |
|---|---:|---:|---:|
| 腾讯 | 38 | 38 | 0 |
| 天宽 | 25 | 25 | 0 |
| TokenSwitch | 290 | 288 | 2 |
| xAI | 1 | 1 | 0 |

该表包含联调调用，按最终上游归属。全部请求共有 360 次上游尝试；不能把自动恢复的中间失败重复计算为用户失败。

## 两次未恢复失败：DealViewer

| 请求 ID | 开始时间（北京时间） | 耗时 | 输出 token | 其中推理 token |
|---|---|---:|---:|---:|
| req-673ec5fc-ca9c-459c-be4f-4fb9cb82330f | 10-20 06:38:59 | 166.38 秒 | 12,000 | 10,297 |
| req-141cceae-074c-4722-bc48-6be6977eb107 | 10-20 06:45:39 | 169.17 秒 | 12,000 | 11,942 |

两笔均为 TokenSwitch / GLM-5.3，调用方 maximum_output_tokens=12000，effective_reasoning_effort=low，上游 HTTP 200、finish_reason=length，Gateway 报 output_length_exceeded。分别只有 4,311 和 177 个可见内容字符。证据指向总输出预算被推理及答案耗尽，不是 Gateway 排队或网络超时。两笔提示词 token 均为 5,229，但 Gateway 未保存对应业务提示词，不能仅凭长度认定业务任务相同。

可转发给 DealViewer：请按上述请求 ID 定位具体任务，记录 max_tokens/max_completion_tokens、finish_reason、completion_tokens 和 reasoning_tokens；先缩小单次任务或要求简短结构化答案。确需长推理时，仅对该类任务提高输出预算并设置成本上限；不要原样无限重试。验收标准为完整可解析结果、finish_reason 非 length，并回传脱敏任务类型、参数及新请求 ID。这两笔已是 low，简单切换到 low 不能解决本例。

## 自动恢复及慢请求

- 4 次 TokenSwitch 返回空内容，finish_reason=sensitive；Gateway 已切换腾讯完成，最终均成功。
- 柯建明的 Word 投稿版生成请求 req-51bb49b3-f39d-4881-83a1-481267fb4b9b：腾讯第一轮 export_document 参数不是合法 JSON，135.33 秒后触发一次修复；第二轮 139.71 秒成功，总计 275.30 秒。不是单纯查找文件，也不是连续 4.6 分钟纯推理。
- 王伊莲的 PPT 请求 req-78e73dcd-beac-46e6-acdd-eb228da872c2：TokenSwitch 第一次 export_document 的 7 个 slide 缺少必填 title，63.33 秒；一次修复后 40.22 秒成功，总计 103.66 秒。Gateway 没有最终拒绝该请求。

上述共 6 次自动恢复全部成功。本轮没有证据支持为这些已恢复请求再增加 Gateway 重试次数。

## 其他异常分类

- Gateway 请求表有 951 条 missing_credential。公网日志出现大量 /admin/、/robots.txt、旧系统路径等探测请求，均被鉴权拒绝；这些没有进入模型执行，不能计为模型服务失败。
- 两条 error_code 为空的请求已定位：Desktop 测试账号于北京时间 08:23:49、08:32:10 探测尚未上线的 /gateway/alphafold/v1/capabilities，HTTP 404，耗时 3/2 毫秒。AlphaFold 08:43 上线后已通过真实公网验收和本次私有 TLS capabilities 检查。
- 冯加育 beta.106 于北京时间 09:31:15 出现 net::ERR_CONNECTION_RESET，updater.download/updater.check 各上报一次；同时间戳，更像同一次下载失败的两条诊断，不能当作两个独立事故。09:31:04 更新检查已成功、随后启动下载；统计截止没有后续下载成功记录。
- 可转发客户端团队：定位 diag_d64b3bee66fd421e950687d52077cc6f / diag_89f7183974a9443eadca0d685faea4b0，检查更新包 URL 和重定向、下载主机/CDN/代理的 reset、下载重试和续传；回传脱敏下载主机、目标版本、网络错误及重试结果。验收为完整下载并通过签名/摘要校验。现有证据不足以定位哪一跳重置连接，不能归因为 Gateway 模型接口。

## 当前基础设施及临床服务

- Gateway 应用版本 43ba3d7536d4795147b84d91f3832ae1ab827a94，容器于 00:42:58 UTC 启动，是已授权 AlphaFold 发布的计划切换；RestartCount=0、OOMKilled=false。
- Nginx 临床配置 b5213615bff75778b2b7eff34268fed4bb0db88e 于 00:46:03 UTC 平滑重载，修复 HTML 压缩导致 Content-Length 丢失；未再次重启 Gateway。
- 当前容器 CPU 1.65%、内存 155.5 MiB / 6 GiB；主机可用内存约 116 GiB。系统盘使用 74.63%、剩余 19.82 GiB，数据盘剩余约 1,253.51 GiB。
- 最近备份 00:37:53 UTC 成功。查询时未结算 token reservation 为 0。检查后新开始的一笔 01:42:00 UTC 请求仍在执行，与 lifecycle active_requests=1/active_work=1 一致，不属于统计窗口，亦非数据库孤立 running 记录。
- EchoNet、EchoNext、AlphaFold 私有接口均通过 CA 验证并返回 HTTP 200 / available=true；窗口内临床审计无 5xx。记录到的 401/404/409/422 包含本次验收的鉴权、隔离、幂等及输入拒绝测试，不能直接等同临床推理故障。
- 当前容器日志只有 7 条工具循环保护的 shadow 提示，明确不改变请求，error/fatal 为 0。Docker 日志仅覆盖本次容器启动后，12 小时判断同时使用持久请求数据库及 Nginx 日志，不能宣称拥有被替换容器的完整日志。
- Nginx 可解析日志窗口内 4,797 条，HTTP 5xx 为 0；流内失败仍可能使用 HTTP 200，因此模型成功率以上面的持久事件为准。临床路由关闭 access_log，单独使用 clinical_audit 检查。

本次仅做只读检查，未重启、修改生产配置或清理生产数据。
