# GoldenCode 腾讯与天宽双平台恢复

2026-09-24 10:12:19 UTC（北京时间 18:12:19）完成。用户提供新的天宽 key，明确要求恢复腾讯与天宽负载均衡。

## 生效配置

| 成员 | 模型 | 状态 |
| --- | --- | --- |
| `goldencode-tencent` | `glm-5.3` | enabled |
| `goldencode-tiankuan` | `official/glm-5.3` | enabled |

公共模型仍为 `goldencode`，Desktop provider 为 `medcode`。沿用 `hrw_sticky`，依次使用 client session、credential、subject 作为粘性键。不同会话分摊到两平台，同一会话尽量固定平台；不是逐请求轮询，也不保证短窗口严格各占一半。

仅修改受保护的 `gateway.container.env` 中 `MEDCODE_TIANKUAN_API_KEY` 和 `MEDCODE_PUBLIC_MODELS_JSON` 的天宽成员 `enabled` 字段。新 key 在操作机仓库外用 Windows 用户绑定加密保存，生产配置和含 key 的备份均限制权限，文档不记录 key 值。

P0 `GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE=enforce` 保持不变；P1 quota cooldown 仍为 0。此次没有对真实供应商注入故障，不据此声称双向故障切换已完成生产验收。

## 备份与执行

- `main` 与 fetch 后 `origin/main` 一致，均为 `7263028ebe3ed4791678321b11c1b41bebf50077`；线上 `3d4c10a` 是其祖先。保留现有工作区改动。
- 沿用已发布、已测试的 `3d4c10a85bb3d0aa393d30b6be40bf4777740e84`，镜像 `sha256:5058c887a15ea76756fff83f66294189491d5761bb393c2945df1bf3af4d3f59`。未发布本地代码。
- 备份：`/opt/codex-gateway-r760/backups/tiankuan-restored-20260924T101149Z`，目录 0700、配置和数据库 0600。配置逐文件 SHA-256 一致；两个在线 SQLite 快照均 `quick_check=ok`、外键违规 0。
- `gateway.db`：421072896 bytes，SHA-256 `49f653566a48d50ef944ecde280e91d7e890677a8c83cadd01162cca296296af`。
- `client-events.db`：1661308928 bytes，SHA-256 `f669b0fc64dd6674a5a268b02c46facfb082c98086a08ea3355aae2827a16e44`。
- 用当前镜像离线解析候选模型注册表，通过 Compose 校验；确认未结算请求为 0 后，仅重建 Gateway。运行时核对只有上述两个环境变量变化，镜像、current/previous 指针及其他运行中容器 ID 均不变。

## 验证

新 key 从 R760 直连天宽：模型列表 HTTP 200 且含 `official/glm-5.3`；实际调用 HTTP 200，精确返回测试标记、`finish_reason=stop`，消耗 31 tokens。

公网现有双平台 smoke 通过，随后只读核对事件归因：

| 场景 | 结果 | Gateway request ID |
| --- | --- | --- |
| 腾讯文本 | HTTP 200，`tencent / glm-5.3 / ok`，144 tokens | `req-c4a22a76-1070-4964-91c4-a0b6cd42280d` |
| 天宽文本 | HTTP 200，`tiankuan / official/glm-5.3 / ok`，150 tokens | `req-869f6c24-6cae-43b1-87e2-46862e129631` |
| 天宽 required tool | HTTP 200，单个 `multiply(a=17,b=23)`，374 tokens | `req-13796e44-ee32-494c-8bc3-a9b43902d19c` |

Gateway healthy、restart count 0，公网 health ready；线上数据库 `quick_check=ok`、外键违规 0。测试账号 `goldencode-dual-provider-smoke-20260924T101206Z` 已 disabled，未撤销凭据 0、未结算预留 0，撤销后请求返回 401。测试临时目录由 smoke 清理，日志测试凭据扫描通过。

服务器备份目录保存 `result.json` 和 `public-smoke.txt`。本次未验证长任务性能或人为断流，不改变之前长任务测试的结论。

## 回退

如需停用天宽，优先仅把当前配置中该成员改回 `enabled=false`，校验后仅重建 Gateway。若回退完整配置，必须先确认恢复后没有其他配置变更；不得恢复数据库快照覆盖新增业务记录。恢复使用当前发布目录和镜像，不回退 Gateway 代码或其他服务。
