# MedEvidence R760 Phone Auth 系统性恢复结果（2026-08-24）

## 结论

本次恢复已在唯一权威端 R760 完成。恢复范围不再按
`external_provider=manual_trial` 筛选，也不要求用户提供 `cgu_live_*`
前缀或完整 key。判断标准改为账户本身的权威数据：

- Subject、backing credential 与统一 key 仍有效；
- 存在允许 `code`/`chat` 的当前 entitlement；
- 发放时绑定的中国大陆手机号可从 Subject、发放外部 ID 或既有管理审计中唯一确定；
- legacy direct 账户虽然没有 `unified_client_keys` 行，但原 Gateway credential、
  MedEvidence API key、Plan 和用量归属均仍有效、可恢复。

执行后，所有同时满足“有效账户链、有效 chat entitlement、唯一且受支持的大陆手机号”
的 Subject 都有 active Phone Auth identity，缺口为 0。

## 根因

2026-08-22 的首轮生产迁移以 `manual_trial` provider 为业务范围，未覆盖其他 provider，
也未覆盖 2026 年 4 月发放、尚未建立 opaque unified-key 行的 legacy direct 账户。
此外，少量真实账户的 `subjects.phone_number` 为空，但发放外部 ID 仍保留完整手机号；
另有一条原始发放记录把手机号写错，并同时传播到了 Gateway 与 MedEvidence principal。

因此，要求用户逐个报告 key 前缀只能绕过症状，不能修复权威数据缺口，也无法覆盖所有用户。

## 实施范围

本次事务式恢复完成：

- 9 个 legacy direct 账户复用原 Subject、原 Gateway credential、原 MedEvidence API key、
  原 Plan、原 entitlement 和原用量归属，新增可恢复的兼容 `cgu_live_*` 与 Phone identity；
- 3 个已有有效 cgu 的账户从发放外部 ID 自动恢复唯一手机号，保留全部旧 key，新增可恢复
  current key 与 Phone identity；
- Gateway 共更正/补齐 4 条手机号，其中 1 条为原始发放错误更正，3 条来自发放外部 ID；
- MedEvidence 对应同步更正/补齐 4 条 principal 手机号，所有写入均有精确旧值前置条件；
- 未撤销或缩短任何旧 key，未替换 Subject，未改变 Plan、entitlement、配额或历史用量。

写入前 dry-run 与实际事务结果一致：

```text
Gateway phone updates                         4
existing-cgu identities                       3
legacy-direct identities                      9
new active identities                        12
active identities before / after        154 / 166
required legacy targets ready               9 / 9
eligible valid subjects missing identity        0
quick_check                                    ok
foreign-key errors                              0
```

写入后再次运行同一计划，结果为 0 phone update、0 existing-cgu action、
0 legacy action；9 个 legacy 目标全部显示 already ready，证明恢复流程幂等。

## 全量审计口径

恢复后有 185 个 Subject 具备未撤销、未过期、可解密验证且 backing scope 为 `code` 的
统一运行时 bundle：

- 166 个 active Phone identity；
- 2 个明确 disabled 的 Phone Auth E2E A/B 测试 identity；
- 10 个没有当前可用 chat entitlement；
- 7 个无法从当前 Subject、发放外部 ID 或管理审计中得到唯一且受支持的大陆手机号，
  包括测试/工具账户、重复历史别名、非大陆手机号及不完整原始号码。

另有 1 个 active unified bundle 的 backing scope 为 `medical`，不是 Desktop `code`
登录账户，不计入上述 185 个 code-capable Subject。

重复历史别名没有被强行绑定到第二个 Subject；同一自然人的权威现用 Subject 已有 active
identity，避免手机号映射冲突。任何未来数据修复仍应以权威发放记录为依据，不应要求用户
提供 key 前缀。

## 备份与回滚边界

写入前备份：

```text
/data/codex-gateway-r760/backups/phone-auth-systemic-recovery-20260824T044351Z
```

目录权限为 `0700`，包含：

- `gateway.db`：在线 SQLite backup，`0400`；
- `medevidence-api-principals-and-keys.sql.gz`：PostgreSQL
  `api_principals`/`api_keys` 数据备份，`0400`；
- `SHA256SUMS`：`0400`，两项复核均通过。

备份 SQLite 的 `quick_check=ok`、foreign-key error 为 0；PostgreSQL dump 通过
`gzip -t`。生产写入也通过事务后 `quick_check` 与 foreign-key 检查。

恢复期间没有重启或重建 Gateway、Research、MedEvidence 或 PostgreSQL。Gateway
restart count 保持 0。若需要回滚，应优先执行单独审阅的定向逆向事务；不得在正常流量继续
增长后直接覆盖整个 SQLite 文件。

## 真实用户验收

按业务方要求，选定的两个真实用户都从外部客户端网络完成：

- 手机号 login `200`；
- session bootstrap `200`；
- account current `200`，Plan 为原有内部高配额图像 Plan，包含 `chat` capability；
- unified resolve `200`；
- Gateway `credentials/current` `200`；
- MedEvidence no-key `/validate-key` 严格返回 `401 missing_api_key`；
- 对应 MedEvidence key `/validate-key` `200`；
- `/health/details?summary=1` `200`；
- logout `204`，登出后旧 access token 再 bootstrap 返回
  `401 access_token_invalid`。

关键 Gateway 请求：

```text
public health  req-1a59ec5d-6d7e-418d-8c77-8671641f6d73

user A login   req-2237ba98-94b3-4085-942c-764ad2618a3b
user A boot    req-dba8af48-1e04-447f-9923-c6928cdddfb9
user A account req-62726824-c367-482c-9a02-9236a8b1dcf0
user A resolve req-24967f8d-2a22-47a4-85d9-946c60922238
user A logout  req-b9a6d987-1995-4622-9d1b-f81ce8d08fbf

user B login   req-7cc65f2a-45d4-4a34-aa14-47016e2cb1db
user B boot    req-4305e32b-c0bf-4956-bc2e-3b27df4b36d1
user B account req-446480b1-7e7c-4a89-9965-974d601ec467
user B resolve req-402a73b8-6887-49f2-af3a-07e1e239adb8
user B logout  req-b920c1d7-498e-42b5-8c05-ff6d49c2fb34
```

验收设备最终分别为 0 active Session、0 active Refresh Token；首次校验脚本中途因只读
no-key 响应字段断言不匹配而退出的额外 user A Session 也已由 `finally` 登出并确认清理。
