# R760 A/S 与 Gateway 入口拆分部署回执

2026-09-15，UTC **04:28:34**（北京时间 12:28:34，Sydney 14:28:34）部署完成；UTC 04:36 完成公网验收、清理与三库审计。用户已授权提交、推送、生产部署和线上冒烟。

## 发布结果与范围

- 运行源码：`8f3e4b00447a5443cfc0433f991bd4047f68f2af`，已推送 `origin/main`。后续提交包含部署工具、冒烟脚本与本回执，不改变运行源码。
- `current` 为上述提交，`previous` 为 `892a76dc12486b400a5d42ce565bcf7f6cebe2a3`；数据库仍为 schema 30，无迁移。
- 镜像：`codex_gateway_r760-gateway:8f3e4b00447a5443cfc0433f991bd4047f68f2af`，ID `sha256:ace98d3138b4bf02bcbe5708d3a918a4ba8f1de0e52ac4488a8e434c9babd47d`。
- `index.ts` 的公开导出保持兼容，工具执行、纠错、配置、鉴权、图片、研究和遥测拆入独立模块。发布提交的入口为 **3,539 行**。之前工作区的 3,577 行包含独立运行密钥改动，该改动及独立账单修改未进入本次发布。
- A 对明确完整的普通 write 内容超长停止网关整次重生成；S 对符合 R3 协商和完整性条件的首次结果进行无损传输。已发生普通工具纠错或供应商切换时，不把累计用量混入首次 S 响应，而是明确返回 A。

**本次为 Gateway 代码部署和测试账号灰度，尚未对正式用户放量。** 生产配置为 `GATEWAY_BOUNDED_WRITE_MODE=delivery`、`GATEWAY_BOUNDED_WRITE_SUBJECT_IDS=subj_NWGR8SNzAnybXZPUro0S3k3p`、`GATEWAY_WRITE_DELIVERY_MAX_CONCURRENT=2`。该合成账号已停用，活动凭据为 0；正式用户继续原有路径。B/C 关闭。扩大灰度仍需客户端接收器、文件事务与联合验收。

## 构建、备份与切换

发布内容来自固定提交，不包含未提交的工作区。完整 Git 归档 SHA256 为 `d9a8eaad7ba21ed06b754cc645297afec7437df0b93a6a0994b78f241804a56b`。完整归档上传及远程 Git 下载发生链路故障后，使用提交差异包和原不可变版本重建，并逐一核对 **1,530 个文件**的 SHA256；全部匹配该提交后才启动构建。

Linux 构建使用 [发布 Dockerfile](../../deploy/r760-bounded-write.Dockerfile)，`npm ci`、`npm run build` 成功，**922 项测试通过、3 项跳过，60 项 R3 契约检查通过**。参见[构建摘要](../../artifacts/bounded-write-release-2026-09-15/build-summary.json)。

保护目录 `/opt/codex-gateway-r760/backups/phone-signup-8f3e4b00447a` 保留三库在线备份、配置副本、旧镜像和构建记录；沿用既有准备脚本的目录命名。三库备份及切换前额外的 Gateway 备份均通过完整性与外键检查。配置和 secret 挂载的属主/权限检查通过。切换只修改 Gateway 镜像和三个明确的 A/S 灰度参数，端口保持 `127.0.0.1:18787->8787`。见[部署摘要](../../artifacts/bounded-write-release-2026-09-15/deployment-summary.json)。

Gateway 为 healthy、重启计数 0；Research Worker、Research LLM Gateway、Research maintenance、Mihomo、Qwen 五个容器 ID 未变化且均 healthy。未改 Nginx、代理出口、网络规则或公网端口。激活失败时脚本恢复旧配置与旧镜像，不回灌运行中的数据库；本次未触发回滚。

## 真实公网冒烟

使用唯一公网 Origin `https://goldencode.instmarket.com.au:1443`，由 Tencent 实际生成。检查生产 HTTP/TLS 响应、SSE、清单、nonce/请求/会话绑定、原始 arguments 摘要、片序、长度和 payload 哈希。普通网络 tools 始终只有 write，不向模型声明接收器。

探针声明内容上限 512 个 code point，提供 1,070 code point / 1,090 UTF-16 units / 1,210 UTF-8 bytes 的中英混合文本和 emoji；协商每片 128 UTF-16 units，得到 9 片。这是有意缩小阈值的协议冒烟，不是线上 12K/32K 上限、1MiB 大文件或混合负载验收。

| 场景 | 结果 | 上游调用 | request ID |
| --- | --- | --- | --- |
| 普通短问答 | 200，有输出 | 1 | `req-8b20e5bb-4fcb-435d-ab7b-8ac2dfa581cb` |
| Responses | 200，completed | 1 | `req-8437134d-5427-4eaf-87d4-e3f3809a9579` |
| 合规短 write，带 S 能力头 | 200，仍为普通 write，无 manifest | 1 | `req-6ca33fcb-f89e-47da-ada5-a61fbb9f8366` |
| S，省略 mode 的覆盖写入 | 200，9 片，原省略语义保留 | 1 | `req-ff4304bd-0978-44b5-8012-15a83a4d58fc` |
| S，append | 200，9 片，append 保留 | 1 | `req-99949191-22df-4546-a925-0624e46147c6` |
| A，无能力头的旧客户端形态 | 502，content_too_long，停止重生成 | 1 | `req-d4e85178-28a1-49da-bf7d-9d9e78e0f68e` |
| A，未知 schema SHA | 502，content_too_long，无 S manifest | 1 | `req-3bc6dc84-33c2-4d15-981e-c5679e929ad3` |

S 两次重组正文均与输入一致，SHA256 均为 `62be6e895c6b63e8978c5175d079ff679e6cb9224b4e1807bd307d72041998d2`，分别约 9.1 秒和 11.8 秒。usage 分别为 998、1,098 tokens，与生产 request_events 一致。A 两次均有 `automatic_retry_allowed=false`、`transformed_retry_allowed=false`、`gateway_retry_attempted=false`。

健康、模型列表、凭据 current、视觉能力接口均为 200；图片生成接口的空 prompt 按预期返回 400。这里验证图片接口参数校验，没有生成图片。完整结果见[公网回执](../../artifacts/bounded-write-release-2026-09-15/public-smoke.json)。

初次长写入探针的上游先返回文本、未调用指定工具，原有纠错后才出现完整超长 write。网关按非首轮条件拒绝 S，返回明确 A，未发生第三次调用。该结果没有记作 S 成功。随后使用明确首轮工具调用的探针完成上述 S 验证，保留前次请求 `req-f4e553b2-0a2b-4a24-9d87-b52fff9ca6bf` 的诊断。首次脚本误用 `/v1/images/generations` 得到 404，修正为现有 `/gateway/images/generations` 后继续；未修改生产路由。

## 数据与测试账号清理

部署后 `gateway.db`、`client-events.db`、`research.db` 均为 quick_check ok、外键错误 0。与部署准备时的备份逐行比较：既有 Subject 990、Credential 999、Unified Key 500、Plan 16、Entitlement 673、Phone identity 284，改动数均为 0。正常用量与审计继续增长，不包含在这组控制记录比较中。

测试账号已通过 Billing API 停用，活动凭据及未结算预留均为 0，临时明文凭据文件已删除；测试审计记录保留。Gateway fatal/error/uncaught/unhandled 计数均为 0。见[清理回执](../../artifacts/bounded-write-release-2026-09-15/cleanup.json)及[最终审计](../../artifacts/bounded-write-release-2026-09-15/final-audit.json)。

## 切换期间的一个在途请求

空闲等待持续 300 秒，期间仍不断有请求进入。说明切换影响后，按用户部署授权执行一次 Gateway 重建。UTC 04:28:23 开始切换，04:28:27 容器启动，04:28:34 公网健康恢复。

当时唯一未完成请求 `req-8462c48d-a173-4bd5-8d1c-f9ca4360e46e` 没有 request_events 完成回执；原预留在 UTC 04:33:05 按既有过期机制以 **estimate 50,159 tokens** 结算。不能据此声称客户端收到完整结果，也不能把该估算值当作供应商实测用量。本次未手工修改该请求的结算；客户端可能需要重试。见[切换请求记录](../../artifacts/bounded-write-release-2026-09-15/cutover-requests.json)。

## 联合验收的剩余边界

此次验证 Gateway 交付及生产接口，没有执行 Desktop 接收器的真实文件写入。Windows 原子替换、权限、格式化/BOM、append 去重、journal/崩溃恢复、历史映射、旧版本混跑及混合负载仍需客户端团队联合验收。不得将 Gateway 200 或哈希一致写成“用户文件已落盘”。下一阶段按 R3 契约选定联合验收账号后扩大 allowlist；不能直接清空 allowlist，因为空列表表示所有账号。
