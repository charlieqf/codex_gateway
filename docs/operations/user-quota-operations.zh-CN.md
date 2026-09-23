# 单用户 Token 额度操作

适用于 R760，给个别用户查额度、重置额度或赠送额度。所有写操作都通过 `scripts/manage-r760-gateway-control.py` 执行：先做经过校验的在线备份，再执行白名单里的管理命令，最后检查完整性。不要直接写 SQL。

## 选择做法

| 需求 | 做法 | 影响范围 |
| --- | --- | --- |
| 当天或当月额度用完，想清零 | Billing 接口 `quota-reset`，清零 day 或 month 窗口 | 只影响该用户当前权益的窗口 |
| 注册送的一次性 100 万 Free 用完了，想再给 100 万 | `reset-free-total`（见[控制面文档](./r760-control-plane-authority.md)） | 只清零该 Free 的终身窗口，上限仍是 100 万 |
| 给个人**赠送**一定数量的 Token | 赠送套餐 `plan_gift_once_<数量>_v1` 加上 `entitlement grant --replace`（见下文） | 只影响该用户 |
| 改所有新购用户的套餐额度 | `set-plan-token-limits` | 所有**新**购买和续费；已发放的权益保留原快照 |

**不要**用手工开通月付或年付来代替赠送，原因有三：
- 额度不受控：月付每天 500 万，一个月最多 1.5 亿。
- 账户会显示为付费会员，但计费侧没有这笔订单。
- 计费系统发购买通知时从不带 `replace_current`，手工开的付费权益会让用户之后的真实购买被拒（409）。

## 1. 找到用户（只读）

- 按手机号：`subjects.phone_number` 是明文，查询时只输出 subject ID，不要打印手机号。短信注册的用户，标签通常是"用户<手机尾号>"，里面没有真名。
- 按姓名：先用 `scripts/query-client-messages.py --user "<姓名>"`，或者查 `subjects.label` / `name`。

## 2. 查看当前权益和用量（只读）

- 权益：查 `entitlements` 表。signup Free 是 `plan_free_once_1m_v1`，`period_kind=unlimited`。
- 用量：查 `entitlement_token_windows`。一次性额度看 `window_kind='period'` 那一行的 `total_tokens`，另外还有 day、month、minute 窗口。
- 管理接口：`GET /gateway/admin/billing/v1/users/<subject>/entitlements`，返回当前权益和历史，但不返回用量。要用公网地址调用，带上 `x-medevidence-client-version` 头和 `GATEWAY_BILLING_ADMIN_TOKEN`（在容器里执行）。**不存在 `GET /users/<subject>` 这个路由**，调用它会返回 401 `invalid_credential`，看起来像 token 错了，其实是路径错了。
- 被额度拦下的请求，在 `request_events.error_code` 里记为 `free_quota_exhausted`。

## 3. 赠送额度

从 `3d4c10a` 起，所有 `plan_gift_once_*` 开头、`period_kind=unlimited`、没有到期时间的权益，都按 Free 类额度处理：
- 和付费的月付、年付可以并存，请求先扣赠送额度。
- 不会和计费系统发来的购买冲突。
- 暂停或取消付费会员时，赠送额度保留。

步骤：

1. **套餐模板**（每种赠送数量建一次）。按 signup Free 的配置复制一份策略，只改 `tokensTotal`，例如 [`config/medevidence.gift-once-10m.token-policy.json`](../../config/medevidence.gift-once-10m.token-policy.json) 和对应的 feature 文件。`plan create` 从**容器内**读取这两个文件，所以要先复制进去：

   ```bash
   ssh ... "docker exec -i codex_gateway_r760-gateway-1 sh -c 'mkdir -p /tmp/gift && cat > /tmp/gift/token-policy.json'" < config/medevidence.gift-once-10m.token-policy.json
   ```

   在 Windows 的 Git Bash 里执行 wrapper 时，一定要加 `MSYS_NO_PATHCONV=1`，否则 `/tmp/...` 参数会被改写成 Windows 路径：

   ```bash
   MSYS_NO_PATHCONV=1 python scripts/manage-r760-gateway-control.py -- plan create --id plan_gift_once_10m_v1 \
     --policy-file /tmp/gift/token-policy.json --feature-policy-file /tmp/gift/feature-policy.json \
     --display-name "Gift · 10,000,000 tokens once" --scope code
   ```

   执行完删除容器里的 `/tmp/gift`。
2. **先核对再发放。** 确认用户没有未结算的预留（`token_reservations.finalized_at IS NULL`），并看一下 signup Free 还剩多少：`--replace` 会替换掉它，剩余部分不会保留。如果剩余较多，就把赠送数量相应加上。
3. **发放：**

   ```bash
   MSYS_NO_PATHCONV=1 python scripts/manage-r760-gateway-control.py -- entitlement grant \
     --user <subject> --plan plan_gift_once_10m_v1 --period unlimited --replace --notes "<原因>"
   ```

   对 `plan create` 和 `entitlement grant`，`--what-if` 只检查命令是否在白名单里，不会实际预演。第一次用新的组合时，建议先在本地临时数据库上用 `apps/admin-cli/dist/index.js --db <tmp>` 跑一遍。
4. **验证：**
   - 新权益 `active`、`period_end` 为空，额度快照里的 `tokensTotal` 正确。
   - 原 Free 变为 `cancelled / replaced`。
   - 之后该用户的请求不再出现 `free_quota_exhausted`。

失败的管理命令会留下一条 `status=error` 的审计记录，但数据没有被写入。

## 记录

- 2026-09-23 02:15 UTC：新建 `plan_gift_once_10m_v1`（总额 1000 万，每分钟 30 万，功能为 chat 和 tools）。
- 2026-09-23 02:17 UTC：为一名 09-22 注册、signup Free 已用 995,285 的用户发放 `ent_e8fa7392…`。发放前他当天有 3 次 `free_quota_exhausted`，发放后请求正常。备份为 `r760-control-pre-control-state-sync-20260923T021652Z-067f6d43.db`。
- 当时线上还是 `3efd505`，赠送权益会被当作普通权益，用户付费时会冲突。02:31 UTC 部署 `3d4c10a` 之后，只读核验确认这张赠送权益已经是该用户当前生效的 Free 类额度（`activeFreeAllowance` 返回它，`isFreeAllowance` 为 true），无需重新发放。
