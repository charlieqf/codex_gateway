# 历史账号手机号补登记：Gateway 修复回执

2026-09-14。**已于北京时间 16:22:34 部署 R760，运行提交 `892a76d`；固定提交构建、623 项测试及公网 24 项接口检查通过。** 原 Key 登录、bootstrap 和实际模型调用已验收。见[上线记录](../operations/r760-phone-enrollment-release-2026-09-14.zh-CN.md)及[调查回执](./medevidence-sms-login-phone-not-registered-gateway-result-2026-09-14.zh-CN.md)。

## 修复后的行为

历史 Billing Subject 可能已经有 Key 和权益，但没有手机号或 Phone identity。修复前，携带手机号调用 `resolve` 返回 `linked`，再次开户返回 `409 subject_already_exists`，均不补登记，随后手机号登录继续报 `phone_not_registered`。

修复后，身份后台携带已验证手机号，通过以下任一路径关联既有账号时，会复用原当前 Desktop Key 准备 Phone identity：

- `POST /gateway/admin/billing/v1/subjects/resolve`：完成关联及补登记后返回 `200 linked`。
- `POST /gateway/admin/billing/v1/subjects`，顶层带 `phone`：完成补登记后，沿用原有 `409 subject_already_exists` 合同，由后台查询取回原 Subject。

`resolve` 仍可选，没有新增接口或强制调用顺序。原不带 phone 的 Billing 开户和已完成事件的幂等重放保持原有语义。旧开户事件不含 phone 时，不能增加 phone 后重用原幂等键；应使用独立的关联请求。无需向客户端分发 Billing 管理凭据。

当前只有一个业务环境。`provider` 和 `external_user_id` 必须复用既有映射值，不增加环境前缀或更换用户标识来绕过已存在账号。

## 数据与失败处理

- 外部关联、缺失手机号、Phone identity 及审计在同一 SQLite 事务中提交。Key 校验或审计失败时全部回滚。
- 不更换 Subject、不创建/轮换 Key，不修改原 Key 密文、有效期、模型范围、权益快照及用量。重复关联不重写现有 Phone identity 或重复写入补登记审计。
- 仅填补缺失手机号；已有手机号与此次验证号码不同，返回 `identity_conflict`，保留原关联。其他 Subject 或待开户记录占用该手机号时也拒绝绑定。
- 既有 Phone identity 的手机号归属冲突返回 `phone_identity_conflict`；停用身份返回 `phone_login_disabled`；停用账号返回 `account_disabled`。不会自动恢复停用账号或身份。
- 当前 Key 不存在、已过期、已撤销、不可恢复，或 backing credential / 运行时 bundle 不满足 Desktop 登录要求时，返回 `account_migration_required`；不会偷偷另发一把 Key。
- 补登记不授予 Free 或付费权益。已有账号缺少有效聊天权益时，可以完成手机号登记，但后续登录仍按原规则返回 `capability_not_allowed`。`linked` 表示手机号关联与运行时 Key 准备已完成，不替代套餐、额度或客户端验收。

## 验证

最终发布从固定提交 `892a76d` 的 Git 归档构建，Linux `npm ci`、`npm run build`、20 个文件共 623 项测试及 Free/paid 编译产物 smoke 通过，见[构建摘要](../../artifacts/sms-login-pending-20260914/release/build-summary.json)。

公网验收覆盖 resolve 和直接带 phone 开户两条历史账号路径：补登记后返回原 Subject、原 Key；登录及 bootstrap 成功；重复关联幂等；冲突返回 409；原权益及用量保持不变。24 项 HTTP 检查全部通过，`goldencode` 实际请求返回 200，结算 135 token。两个合成测试账号已停用，活动凭据、会话和未结算预留均为 0。见[公网验收](../../artifacts/sms-login-pending-20260914/release/public-smoke.json)及[部署后审计](../../artifacts/sms-login-pending-20260914/release/final-audit.json)。

此前开发工作区 `npm run build` 和 459 项关联测试也通过，见[开发阶段结果](../../artifacts/sms-login-pending-20260914/fix-regression.json)。该次检查包含独立年付修复；本次发布只包含手机号补登记修复，年付改动未随本次发布上线。

验证覆盖：旧式 Billing 账号补手机号、已有手机号补 identity、直接开户的 409 恢复路径、原 Key 登录及 bootstrap、原权益和已消费用量保持不变、重复关联、11 类 Key/运行时异常、停用身份/账号、手机号及待开户冲突、审计失败全事务回滚，以及既有新用户开户、Phone Auth、Billing、额度和 Gateway 路由回归。

```powershell
npm run build
npx vitest run apps/gateway/src/billing-identity-coordination.test.ts apps/gateway/src/phone-auth-routes.test.ts apps/gateway/src/services/phone-auth-service.test.ts apps/gateway/src/index.test.ts packages/store-sqlite/src/index.test.ts packages/store-sqlite/src/phone-auth.test.ts packages/store-sqlite/src/free-paid-quota.test.ts
```

上述开发回归使用本地 SQLite 和测试凭据；上线公网验收使用专门创建的合成账号，消耗 135 token，没有向真实用户发送短信或修改其账号权益。

## 本案恢复边界

本次修复处理已确认的历史账号登记缺口。截图请求对应的目标号码在调查快照中没有 Phone identity，且连续失败时段未见 Gateway 开户/关联入站；没有证据证明该用户一定属于上述历史账号分支。

因此身份后台仍需实际发起正确关联或开户请求。Gateway 无法从公开登录失败的手机号哈希推断外部 user_id，也不会在公开 `login/start` 中自动开户。真实账号恢复后，应由客户端验证登录、bootstrap、实际请求和用量归属；公网合成账号验收不代表原报障账号已经恢复。

调查阶段的 `reproduce-legacy-link.mjs` 和 `legacy-link-reproduction.json` 保留为修复前证据；其断言预期是旧错误行为，修复后应以本回执的回归结果为准。

实现位置：[Billing 路由](../../apps/gateway/src/billing-admin.ts)、[PhoneAuthService 校验](../../apps/gateway/src/services/phone-auth-service.ts)、[关联事务](../../packages/store-sqlite/src/external-identities.ts)、[复用当前 Key 的登记写入](../../packages/store-sqlite/src/phone-auth.ts)、[端到端回归](../../apps/gateway/src/billing-identity-coordination.test.ts)。
