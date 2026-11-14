# GoldenCode 天宽暂停记录

执行时间：2026-09-07 03:13 UTC（北京时间 11:13）。用户要求天宽等待付费后再恢复。

## 生效配置

R760 `goldencode` 文本池只启用 `goldencode-tencent` / `glm-5.3`。
`goldencode-tiankuan` / `official/glm-5.3` 保留配置，`enabled=false`，不会参与首选路由或失败重试。
充值不会自动改变此配置；恢复需要明确的配置变更与验证。

只修改 `/opt/codex-gateway-r760/shared/config/gateway.container.env` 中
`MEDCODE_PUBLIC_MODELS_JSON` 的天宽成员启用字段。验证 Compose 后仅重新创建 Gateway，
使用原镜像，没有构建或发布本地故障切换代码。视觉路由、其他服务和用户密钥未调整。

- current：`b641ebbcc02b616726909fac4bda8ee9e4901981`
- previous：`643235f8b9651ba099b8b48b6453097e16846034`
- 镜像 ID：`sha256:b2d0cedd22d2562a9156a3a0673c1379a9fd318208baf013c159f3f175e5492b`
- 变更前备份：`/opt/codex-gateway-r760/backups/tiankuan-disabled-20260907T031346Z`

备份包括受影响配置、Compose 环境/覆盖文件和在线 Gateway SQLite 快照；配置逐文件校验，
数据库 `quick_check=ok`、外键违规 0。目录权限 0700，文件权限 0600。

## 验证

- 新容器实际环境只启用腾讯；镜像 ID 与变更前一致。
- 公共 HTTPS health 返回 ready；容器 healthy，restart count 0，端口仍为 loopback 18787。
- 腾讯真实文本请求 HTTP 200，观察事件 status=ok，runtime/account/model 均指向腾讯。
  请求 ID：`req-529f77cc-fe81-4516-a8d7-d68c69add320`。
- 腾讯 required 工具调用成功，`multiply` 参数为 17、23，结构与结束状态校验通过。
- 临时凭据撤销后访问返回 401；临时用户 disabled，未撤销凭据 0，未结算预留 0。
- 在线数据库 `quick_check=ok`、外键违规 0；Research 服务保持健康。

验证使用现有双平台 smoke 的腾讯单平台裁剪版。业务断言全部通过；脚本末尾因 PowerShell
管道追加 CR 空行返回非零，退出清理已执行。随后独立只读检查确认请求结果、凭据/用户清理、
预留结算和数据库完整性，未为消除该 shell 报错重复发起收费请求。

## 后续恢复

收到恢复指令后先确认天宽付款与足够业务预算的链路验证，再备份当时配置、将该成员改为
`enabled=true`，校验 Compose 并仅重建 Gateway。避免整份恢复旧环境覆盖后续配置变更。
本地故障切换开关的启用不能绕过成员的 `enabled=false`。
