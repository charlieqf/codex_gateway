# R760 Gateway 发布回执：5165cf7

2026-09-29 深入调查补充：排空检查结束后，03:02:39.231 又准入一笔模型预留，未找到完成事件，后于 03:07:43.455 按估算记入 62,827 Token。另确认固定 5 分钟预留清理会提前结算仍在执行的长请求，迟到的实际用量不会更新已结算记录；窗口内发布前后各有一笔实例。这是用量账本与任务生命周期问题，不能直接解释为现金扣费或应退款数额。未结算预留清零不能证明排空成功。详见 [三项高优先级深入调查](./gateway-priority-investigation-2026-09-29.zh-CN.md)。

2026-09-29 巡检补充：完整 Nginx 日志确认，切换瞬间 03:02:40–03:02:42 UTC 出现 10 次 502（模型 2、诊断 7、credentials/current 1）。下文健康与自测结论适用于切换后，不能解释为发布零中断。等待 Token 预留清零未覆盖所有在途连接或阻止新请求进入；后续需要入口排空和就绪切流。见 [24 小时检查](./gateway-24h-review-2026-09-29.zh-CN.md)。

2026-09-28 **03:02:36–03:02:48 UTC**（北京时间 11:02，悉尼时间 13:02）完成发布。只重建 Gateway，其他服务保持原容器。用户已授权部署与自测。

| 项目 | 验证结果 |
| --- | --- |
| current | `5165cf74becb13c4f90060449934b42588241fad`，发布时与已 fetch 的 origin/main 一致 |
| previous | `3d4c10a85bb3d0aa393d30b6be40bf4777740e84` |
| 镜像 ID | `sha256:57b76d1e277b064816acb2cd344bd88577242ed71148922dbad2e2ca308785f6` |
| 数据库 | schema 35 → 37；quick_check=ok；外键违规 0 |
| 运行状态 | healthy，重启 0，公网 health=ready |
| 运行配置 | 环境变量与端口完全一致；腾讯＋天宽均启用；Free Plan 仍为一次性 500 万 Token |

## 发布内容

`dc147f0` 和 `5165cf7` 提供 [模型调用回执 v1](../../coordination/model-call-recovery-v1.zh-CN.md)：稳定调用 ID、SQLite 回执、查询与原响应回放、防止重复执行，以及独立的查询/新调用限流。migration 36 新建回执表；37 新建容量计数与事务触发器。JSON/SSE 终态统一保存，存储故障或不确定结果禁止同 ID 再次执行。

## 构建、备份与迁移

- 确认线上提交是候选提交的祖先。使用已校验的 Git bundle 导入主机镜像仓库，再以 `git archive` 生成不可变源码与 release；未包含开发工作区的未提交修改。
- 以实际运行的 `3d4c10a` 镜像为 runtime 基础，用仓库 packages overlay 构建。容器内 build 通过，**89 个测试文件通过、2 个跳过；1686 个测试通过、4 个跳过**。
- 在线备份：`/data/backups/codex-gateway-daily/20260928T025224Z`，共 2,118,832,128 字节；Gateway、client-events、imaging-control 三库校验通过。
- 发布与回退记录：`/opt/codex-gateway-r760/backups/release-5165cf74becb/`。旧 override、环境与密钥链接目标的备份及 deployment.json 均受保护，敏感备份权限为 0600。
- 使用备份副本，在断网的候选镜像容器内执行 schema 35→37 两次。数据库完整性与外键检查通过；Plan、权益、凭证、Token 窗口和预留表的行数与内容哈希均未改变。
- 等待在途预留清零后，仅修改 override 的 gateway image 行，使用既有 Compose overlays 执行 Gateway 的 `up --no-deps --no-build --force-recreate --wait`。

## 公网自测

03:03 UTC 使用一个合成注册账户完成全部断言（145 次检查，含限流前的重复查询）：

- 注册、统一 Key resolve 正常，注册 Free 额度为 **5,000,000**。
- 未鉴权查询返回 401，不存在的回执返回 unknown。
- JSON 和 SSE 各执行一次真实模型调用。执行中可查询 running；同时提交相同 ID 返回 `409 model_call_pending`。
- 完成后可查询 completed 和原响应；JSON 字节一致，SSE 数据/事件帧一致，心跳不进入回执。响应包含协议版本和调用 ID，查询禁止缓存。
- 同 ID 重发回放保存的原响应；改变参数返回 `409 model_call_conflict`。每次原始调用仅产生一条模型预留和一次扣费，查询/回放没有新增调用或扣费。
- 无效模型返回 404，回执为 failed，失败结果可原样回放。
- 查询预算耗尽后返回 `429 model_call_query_limited` 和有效 Retry-After；此时新 ID 仍可准入并得到预期的模型校验结果，未被查询限流阻塞。
- 合成账户和 Phone identity 已停用，有效凭证 0，未结算预留 0；停用后的统一 Key resolve 返回 401。审计与已结算用量保留；回执按正常 TTL 清理。

两次冒烟均路由天宽，各消耗 135 Token：

| 响应类型 | 原请求 ID |
| --- | --- |
| JSON | `req-cd3c36a1-8d1a-471c-a27a-b4d18a9a4198` |
| SSE | `req-aea8545a-3e68-4d73-9351-43b01eaf09b2` |

截至 03:04:24 UTC，上线后的请求事件中另有 2 次腾讯模型调用成功；错误级日志为 0。四条回执（两条 completed、两条 failed）共 2,854 字节，容量计数与实际行汇总一致；三个 Research 容器 ID 均未改变。

这是 Gateway 公网协议与存储验证；未运行 Desktop 的完整任务或本地文件恢复流程。

## 回退

旧镜像和旧 release 均保留，旧 override 在上述发布备份目录。若需回退，应恢复 gateway 镜像行、用旧 release 的 Compose 文件仅重建 Gateway，并核对 current/previous。

schema 36/37 为追加表与触发器；旧版本不识别回执协议。回退后客户端必须按能力缺失/结果不确定处理，不能假定原请求未执行并自动换 ID 重发。不要用发布前数据库覆盖线上新产生的用量；数据库还原需要单独的数据恢复决策。
