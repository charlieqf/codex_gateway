# goldencode-d 发布验收记录

2026-10-23 03:15:27 UTC 完成发布，03:19:45 UTC 完成最终复核。
运行版本：`954eb3bedca6648405fa419d232cdb4a43dbe8fc`；上一版本：
`25e021f79fb07c28e40ae9be7cd728573788a064`。
镜像：`sha256:bcfa4f1b8a68c00e8c4aefbc76fa1a9f2ed40ebf58b8133847e0bb7370a2e7ab`。

## 已上线行为

- 公共模型列表保留 `goldencode`、`goldencode-local`，新增 `goldencode-d`。
- `goldencode` 保留腾讯、天宽、TokenSwitch 三家 GLM-5.3 及现有视觉路由。
- `goldencode-d` 使用腾讯 `deepseek-v4.1-flash-1017` 和天宽 `deepseek-v4.1-flash`
  的独立会话粘性池。天宽实际返回版本为 `deepseek-v4-1-flash-260910`；不承诺均为 1017。
- 两个云端公共模型均支持 low/high/max，默认 high，兼容 none→low、medium→high。
  DeepSeek 显式向上游传递思考开关和强度；未新增公共视觉路由或不思考档位。
- schema 44 将恰好为旧标准双模型列表的凭据扩展为三模型，保留自定义限制。
  新用户默认三模型；不修改 Plan、余额、已用量、有效期或现有 Key 值。

客户端交付文档：
[模型切换及推理强度适配说明](../outbox/goldencode-model-switching-client-guide-2026-10-23.zh-CN.md)。
Desktop UI 尚需客户端团队按该文档实现并完成安装包验收。

## 发布前验证

业务实现提交 `1c11405`，发布脚本提交 `954eb3b`。构建和运行包取自提交归档，
未包含本地工作区既有的其他文档或脚本改动。最终镜像在已测试业务镜像上仅更新运维脚本及版本标签。

- 本地构建通过。完整本地测试仅有一个既有 500ms 性能阈值在并发运行时超时，单独重跑通过。
- 干净 Linux 构建与完整测试通过：108 文件通过、2 文件跳过；2078 测试通过、4 跳过。
- 新模型集成测试涵盖双向故障切换、Chat/Responses、流式/非流式、工具和授权限制。
- 生产 SQLite 只读备份的迁移演练：保留 32 张表、700316 行，扩展 392 条标准凭据；
  除版本表与目标模型列表外所有既有字段逐行摘要一致，quick_check=ok，外键错误 0。
- 最终候选镜像真实上游预检 11 次通过：两家 DeepSeek 工具调用、跨供应商工具结果续接、
  Chat/Responses 流式响应和三家 GLM 回归；使用内存数据库，不写生产用户数据。
- 额外直测两家 DeepSeek 的 low/high/max 与关闭思考均成功，非法档位均返回 400。
  该测试确认接口接受及基本行为，不是不同强度的质量、耗时或 Token 预算基准测试。

预检脚本曾因 Responses 消息缺少 type、将 error:null 误判为错误、含供应商名称的测试标记
触发现有身份保护而失败；修正测试脚本后最终镜像预检全部通过。没有为通过测试修改身份保护。

## 切换与回退准备

发布已推送 main。R760 直连 GitHub 拉取停滞后，使用验证过的增量 Git bundle，
其 main 精确指向目标提交，前置对象为上一生产版本。标准准备脚本创建两个不可变目录：

```text
/opt/codex-gateway-r760/releases/954eb3bedca6648405fa419d232cdb4a43dbe8fc
/opt/codex-gateway-r760/staging/954eb3bedca6648405fa419d232cdb4a43dbe8fc/src
```

已验证数据库备份：`/data/backups/codex-gateway-daily/20261023T025615Z`，约 2.55 GB。
受保护的配置与发布状态备份：`/opt/codex-gateway-r760/backups/release-954eb3bedca6`。
该目录含凭据环境备份，保持私有，不能打印或提交其内容。

连续业务请求使 15 分钟内未获得 30 秒自然空闲窗口。随后使用提交 `108a7ab` 的运维脚本
受控排空，等待现有请求结束再替换，仅重建 Gateway；未强制中断现有请求。
排空开始 03:14:30 UTC，发布完成 03:15:27 UTC，维护约 58 秒。
Nginx 在该区间记录 17 次 503、3 次 502，其中 4 次来自健康探测，
另有 12 次 credentials/current、4 次其他路由失败；不能宣称零停机。

只向原 registry 合并 D 条目，运行环境其他值逐项一致；20 个其他受保护文件的内容与权限
保留，端口保留，另外 3 个项目容器 ID 保留。新旧 env/override 已备份。
current 指向新版本，previous 指向旧版本。脚本具备配置/镜像回退及有期限的公网恢复验证；
若后续回退，不用旧数据库覆盖上线后的业务记录。此次无需回退。

## 公网验收

通过正式域名、正常鉴权、独立合成主体和限额 Plan 发起，脚本不执行工具副作用。
使用已提交的 `4344072` 公网验收脚本；它修正了测试 call ID 格式并增加回执/冲突验证，
未更改生产服务代码。03:16 UTC 的 14 次实际模型调用全部 HTTP 200、状态 ok，
每次均核对实际供应商，避免被回退到另一供应商掩盖问题。

| 验收内容 | 结果 |
| --- | --- |
| 鉴权模型目录 | 三个公共模型及长度元数据正确 |
| 两家 DeepSeek 非流式工具调用 | 中文结构化参数正确 |
| 腾讯→天宽、天宽→腾讯工具结果续接 | Responses 返回期望标记 |
| 两家 DeepSeek Chat/Responses 流式文本 | 完整终态、无错误帧，high/max 参数落账正确 |
| 腾讯、天宽、TokenSwitch GLM | 原有三家真实调用通过 |
| 同一 session 的 GLM→DeepSeek→GLM | 完整历史续接、low 档保持、期望标记保持 |
| 三次切换步骤的回执查询及同参数重放 | completed，原响应一致，无新增预留/扣费 |
| 三次同 ID 改模型 | 409 model_call_conflict，无新增预留/扣费 |

切换链请求 ID：

```text
GLM      req-44d4a29d-6d24-45d0-b71e-ee0e5d1ffaef
DeepSeek req-665efd44-5dde-4339-bd74-f524e5331a64
GLM      req-8c44b21d-afe5-4043-a0e9-ca81b57911c6
```

14 条模型额度预留全部结算，共 4423 Tokens，与请求事件逐项一致。
测试主体已 disabled，凭据全部 revoked，Plan deprecated，权益取消，pending reservations=0；
撤销后的公网鉴权返回 401。保留审计记录，运行容器内临时 JSON 报告已删除。

## 最终状态与证据

- 容器 healthy，RestartCount=0；公网 ready，draining=false，正常业务恢复。
- schema=44；gateway、client-events、imaging、aipal、panecho、echonet、echonext、
  alphafold3、research 共 9 个数据库 quick_check=ok，外键错误均 0。
- 从排空开始到复核时的新 Gateway 结构化日志没有 warn/error/fatal 记录。
- 标准预检、实际公网切换、计费及回执验收通过；未进行 Desktop UI/安装包验收，
  也未在生产对正常供应商注入故障。故障切换由集成测试覆盖。

受保护证据在上述 staging 目录：`preflight.log`、`reasoning-effort-probes.json`、
`public-smoke.json`、`public-smoke.log`、`cutover-health-observer.json`、
`cutover-edge-errors.json`、`final-verification.json`。
配置变更及收敛探测证据在 backup 目录：`deepseek-deployment.json`、`deepseek-public-health.json`。
Linux 全套测试和迁移副本演练记录保留在 `staging/goldencode-d-1c11405`；数据库副本目录为 0700。
