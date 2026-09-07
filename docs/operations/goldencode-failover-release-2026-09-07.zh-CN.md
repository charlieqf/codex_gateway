# GoldenCode Gateway 故障切换能力发布与公网验收

日期：2026-09-07。生产仍仅启用腾讯；本文不代表真实双供应商切换已经通过公网验证。

## 发布结果

- 代码提交：`b4fbed48f9df36ca5bba70be0590997cbac23b4b`，已推送 `origin/main`。
- 04:18:20 UTC（北京时间 12:18）部署；04:20:52 UTC（北京时间 12:20）从受控测试账号扩大到全部 `goldencode` 文本请求。
- current：`/opt/codex-gateway-r760/releases/b4fbed48f9df36ca5bba70be0590997cbac23b4b`。
- previous：`/opt/codex-gateway-r760/releases/b641ebbcc02b616726909fac4bda8ee9e4901981`。
- 镜像：`sha256:902aecf1795b106291899dde7d0d010016d46b9715db84d1aeee6c75bb73aca6`。
- 备份及验收证据：`/opt/codex-gateway-r760/backups/failover-b4fbed4`。

使用 Git 提交归档构建，没有打包工作区的无关改动。干净 Linux 构建先编译 workspace 包，
再执行 8 个相关测试文件，364 项通过；生产镜像按仓库 Dockerfile 构建。
预检、配置备份、Gateway/client-events 在线 SQLite 快照及完整性检查通过后，只重建 Gateway。
Research、Mihomo 和 Qwen 容器 ID 保持不变。

最终配置：

| 项目 | 实际值 |
| --- | --- |
| `GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE` | `enforce` |
| `GATEWAY_GOLDENCODE_FAILOVER_SUBJECT_IDS` | 空，即目标模型文本请求全量 |
| `GATEWAY_GOLDENCODE_QUOTA_COOLDOWN_SECONDS` | `0`，P1 未启用 |
| `goldencode-tencent` | enabled，`glm-5.3` |
| `goldencode-tiankuan` | disabled，`official/glm-5.3`，等待付费与明确恢复指令 |

P0 的预算、取消、终态和错误筛选逻辑已启用。池中只有腾讯，不能实际执行腾讯→天宽的转发；
禁用的成员不会被自动恢复。额度冷却独立开关仍关闭。

## 公网验收

所有请求使用 `https://goldencode.instmarket.com.au:1443/v1`，受控服务凭据只在服务器进程内使用。
主验收 10 项通过，放量后 3 项复验通过；同时验证健康、鉴权与凭据撤销。

| 主验收场景 | HTTP / 结果 | Gateway request ID |
| --- | --- | --- |
| Chat Completions 非流式文本 | 200，腾讯 1 次 | `req-db78be3d-c282-4425-b14b-3085192b4365` |
| Chat Completions 非流式工具 | 200，腾讯 1 次 | `req-9e77471c-31ea-4040-8c20-b790cc5942c6` |
| Chat Completions 流式文本 | 200，腾讯 1 次 | `req-4fa8ceab-1d00-4d56-bcd2-32d66fc474a6` |
| Chat Completions 流式工具 | 200，腾讯 1 次 | `req-db30abd6-bd08-4ab2-bace-15cace8470b8` |
| Responses 非流式文本 | 200，腾讯 1 次 | `req-4b671458-85cd-40bd-94ca-08610c4a879c` |
| Responses 非流式工具 | 200，腾讯 1 次 | `req-16e7552e-a825-4eb2-979d-d13f8f2baf9f` |
| Responses 流式文本 | 200，腾讯 1 次 | `req-487aee9f-a328-44fb-b8cb-2a4c69801470` |
| Responses 流式工具 | 200，腾讯 1 次 | `req-2e4f07bc-8ab0-4e52-894b-a659010bad57` |
| 输出预算超过模型上限 | 400 `invalid_request`，0 次上游调用 | `req-52d1e3e2-117d-4a67-abd3-4772b0890eeb` |
| 1 ms 请求总期限 | 504 `upstream_timeout`，0 次上游调用 | `req-e95798ec-19c2-42c0-bf28-559fab3e41b2` |

工具请求均只交付一个 `multiply` 调用，参数为 `a=17,b=23`；没有执行真实客户端 Shell/write。
Chat 流校验单个 `[DONE]`；Responses 流校验单个 `response.completed`，无错误终态。
正常响应、request event 和已结算 token reservation 的用量完全一致。
8 个正常请求实测耗时约 0.96–10.01 秒，此小样本不作为线上延迟基线。

放量后使用另一个测试身份复验：

- required 工具：200、腾讯 1 次、1 个有效工具调用，`req-f3228a73-4da3-4d24-b808-d3611d6c73bc`。
- 超预算：400、0 次上游调用，`req-93a18265-1205-42d0-b4cd-a96c4792eb01`。
- 1 ms 总期限：504、1 次已开始的上游尝试，无后续尝试，`req-f399c4a0-c0c3-49b7-b15c-f33786b89a31`。

两个期限测试的实际尝试数不同，反映定时器与派发的先后顺序；二者均未在截止后启动第二次调用。
它们验证 Gateway 总期限，不等同于客户端主动取消或真实供应商故障切换的公网验证。

## 最终检查与边界

04:22:54 UTC 最终检查：Gateway healthy、重启计数 0；工作站访问公网 health 返回 ready。
Gateway schema 27，`quick_check=ok`、外键违规 0。两个临时用户 disabled，凭据均撤销，
撤销后访问 401，未结算测试预留 0；日志未出现测试凭据。
配置和数据库备份文件为 0600，备份目录为 0700。

服务器证据：`deployment.json`、`public-smoke.json`、`public-smoke-final.json`、`final-audit.json`。
额度状态机和真实双向错误切换已在隔离故障注入测试覆盖；天宽禁用期间无法完成真实双供应商公网验收。
客户端主动取消、实际 Shell/write 执行与去重仍需安装包联调。

客户端协作文字见[联调说明](../coordination/gateway-failover-client-joint-testing-2026-09-07.zh-CN.md)。

## 回滚

优先把 P0 mode 改为 `disabled`，仅重新创建 Gateway；P1 保持 0，天宽保持禁用。
如需二进制回滚，使用备份记录中的上一镜像与上一发布目录。
不要整份恢复当天较早的供应商配置而重新启用天宽；不要恢复数据库快照覆盖上线后的业务记录。
