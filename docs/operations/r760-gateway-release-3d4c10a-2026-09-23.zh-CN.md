# R760 Gateway 发布回执：3d4c10a（赠送额度按 Free 类处理）

**2026-09-23 02:31:32 UTC** 开始割接。本次只重建 Gateway，Research Worker 仍运行 `3efd505` 的 Gateway 镜像，没有重建。

| 项目 | 状态 |
| --- | --- |
| `current` | `3d4c10a85bb3d0aa393d30b6be40bf4777740e84` |
| `previous` | `3efd50541278735836eeeb608244f628a31b913c` |
| 数据库 | schema 35，没有迁移 |

## 内容

`3d4c10a` 把所有 `plan_gift_once_*` 开头、`period_kind=unlimited`、没有到期时间的权益，都按 Free 类额度处理：
- 和付费会员并存，请求先扣赠送额度。
- 不和计费系统发来的购买冲突；计费系统从不带 `replace_current`。
- 暂停或取消付费会员时，赠送额度保留。

起因是 02:17 UTC 按用户要求给一名用户发放了 1000 万赠送额度。在旧代码下，那张赠送权益会被当成普通权益，用户之后付费购买会被 409 拒绝。操作方法见[单用户 Token 额度操作](./user-quota-operations.zh-CN.md)。

## 过程与验证

- 源码：这次 R760 能连上 GitHub，由准备脚本直接 fetch。准备阶段从当前发布目录复刻了 5 个 config 链接和 3 个 secrets 链接，并做了一次数据库备份：`/data/backups/codex-gateway-daily/20260923T022623Z`，2.03 GB，已校验。
- 构建：基础镜像是 `3efd505`，镜像内测试 87 个文件通过、2 个跳过，1661 个用例通过。在断网的临时容器里确认两点：`isFreeAllowancePlan("plan_gift_once_10m_v1")` 返回 true，Worker 的模块图能正常导入。
- 割接：override 里 research-worker 也用 `3efd505` 这个镜像，所以割接脚本改为**只替换 gateway 服务块里的镜像行**。等 1 个进行中的请求结束后才切换。检查全部通过：
  - healthy，重启 0，端口不变，环境变量没有变化，其他容器没有重建。
  - 公网健康 ready，`quick_check=ok`，外键违规 0，没有启动归档告警。
- 冒烟：`billing-quota-review-public-smoke.mjs` 20 项全部通过，模型请求 `req-96443ca7-ef77-4df1-9288-828990a861e4`（397 token，计入 Free）。合成账户已停用，有效凭证 0，未结算预留 0。
- 针对这次改动的核对：用新代码只读查询那名受赠用户。`activeFreeAllowance` 返回的就是这张赠送权益（`plan_gift_once_10m_v1`，总额 1000 万），`isFreeAllowance` 为 true。也就是说，他之后付费购买不会再冲突。
- 割接后观察到 02:33 UTC：14 个请求全部成功，resolve 正常，错误日志 0。

## 回退

本次没有数据库迁移。回退时只要把 override 里 gateway 块的镜像行改回 `3efd505`，然后用 `previous` 发布目录只重建 gateway。回退后，赠送权益会重新被当成普通权益，购买冲突的问题也会回来。
