# Gateway MedEvidence 入口与子密钥一致性防护

日期：2026-09-09。状态：本地候选改动和回归验证完成，未提交、未部署；认证数据兼容修复仍需 v2 完成。

## 问题与改动

`/gateway/unified-keys/resolve` 原先解密请求命中的统一 key 子密钥后，独立按客户端版本选择 CN/R760 入口，无目标认证检查。有效历史 key 因而可能解析成功，随后被所选 MedEvidence 服务拒绝。全量检查还证实 current 标记和持久化入口都不能证明目标兼容性：部分 current 记录仍标注 CN，实际密钥仅在 R760 有效。

新增 `apps/gateway/src/medevidence-runtime-key.ts`。Resolver 完成原有统一 key、Subject、backing credential 和客户端版本检查后，对 Gateway 管理的所选入口，用原记录的子密钥请求 `GET /validate-key`：

- HTTP 200 且 JSON `valid=true` 时返回原凭证组合，并记录成功 resolve 审计。
- HTTP 401/403 或 HTTP 200 且 `valid=false` 属于明确拒绝，返回现有契约 `409 account_migration_required`，并记录请求关联下的统一 key ID、目标入口和错误码。
- 超时、网络失败、429、5xx、重定向，或 200 但没有布尔判定结果，都算“无法验证”（2026-09-23 评审后修订，原为 `503`）。resolver 照常返回凭证，并记录 warn 日志（统一 key ID、入口、原因、上游状态码）；不把它们误报为 key 无效，也不让 MedEvidence 故障牵连 Codex Gateway 凭证。
- 认证请求限制 3 秒、不跟随重定向、不向其他入口发送密钥、不输出上游响应或异常明文、不缓存认证成功。
- 目标认证等待结束后重新检查统一 key、Subject 和 backing credential，保证等待期间的撤销、到期或禁用仍会拒绝。
- 保留原统一 key、原 GoldenCode 和 MedEvidence 子密钥；不查找并替换成另一条 current key，不写兼容认证数据，不改变按版本选择入口的策略。

外部自管入口保留原有行为；本防护仅覆盖固定允许列表中的两个 Gateway 管理入口。

## 验证结果

命令：

```powershell
npx vitest run apps/gateway/src/medevidence-runtime-key.test.ts apps/gateway/src/medevidence-origin-policy.test.ts apps/gateway/src/phone-auth-routes.test.ts apps/gateway/src/index.test.ts
npm run typecheck
node --check scripts/ops/audit-medevidence-key-routing.mjs
git diff --check
```

结果：4 个测试文件、304 项测试通过；修正测试 mock 的 TypeScript 类型后，项目 typecheck 通过，脚本语法和 diff 格式检查通过。

回归覆盖 CN-only 历史 key 与新旧客户端、缺失/陈旧入口元数据、已兼容历史 key、R760-only current key、current CN-only key、401/403、服务故障、连接/响应体超时、原 key 在兼容恢复后重试成功、无自动换 current key，以及认证等待前后的撤销、到期和账号禁用。

保留了工作区原有短信/身份协调等改动。此次代码位于现有脏工作区，发布前应只提取本次改动到独立不可变候选版本并完成发布检查；没有修改线上 release 或服务状态文档。

额外运行 `npm run scan:phone-auth-secrets -- HEAD` 时，扫描器报告 `phone-auth-routes.test.ts:102` 的原有短信测试手机号样例不在其合成号码允许列表中。该行属于本次开始前已有的短信/身份协调改动，本次没有更改它；不能将整个脏工作区标记为敏感信息扫描通过。发布候选隔离后应重新运行该检查。

## 只读盘点工具

`scripts/ops/audit-medevidence-key-routing.mjs` 在 R760 Gateway 容器内运行。默认仅输出元数据；显式 `--probe` 时，在远端内存解密现有子密钥，逐条确认 backing token hash，并验证两个允许入口。两名异步 worker、单次 5 秒超时，同一子密钥与入口去重。输出只有脱敏记录和状态。

```powershell
Get-Content -LiteralPath scripts/ops/audit-medevidence-key-routing.mjs -Encoding UTF8 -Raw |
  ssh -p 7723 -i $env:USERPROFILE\.ssh\id_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes root@117.186.49.26 `
  'docker exec -i codex_gateway_r760-gateway-1 node --input-type=module - --probe'
```

默认范围包括所有有效账户链，不只包含 current 或有手机号的记录。输出的 `scope`、`has_phone`、`test_marker` 供复核筛选，不能把测试识别规则等同于人工确认的完整用户名册。`read_only` 指数据库访问及接口用途；既有认证接口可能自行记录访问日志。

完整范围、记录清单和 v2 工作要求见[协作交接](../outbox/medevidence-key-routing-v2-handoff-2026-09-09.zh-CN.md)。

## 尚未完成的线上工作

防护将错误组合挡在 resolver，并不补齐目标认证记录，也不能更新客户端已缓存的子密钥。需要 v2 先完成 112 条真实用户历史 key 的兼容恢复，并联合处理 155 条 current key 在 CN 被拒绝的旧客户端兼容边界。

此候选让每次 resolve 最多增加 3 秒 MedEvidence 认证延迟。2026-09-23 评审后改为只有明确拒绝才拦截：MedEvidence 不可用时 resolve 照常返回，只是 MedEvidence 侧功能不可用，Codex Gateway 凭证不受影响。代价是故障期间无法挡住“入口与 key 不匹配”，这类请求会在客户端调用 MedEvidence 时才失败。

仍待 MedEvidence 确认：revoked、expired、disabled 等失败是否都返回 401/403。若用其他状态码，会被当作“无法验证”而放行。

当前没有部署，不能把本地防护完成表述为用户故障已整体恢复。发布与真实客户端验收按协作交接中的顺序执行。
