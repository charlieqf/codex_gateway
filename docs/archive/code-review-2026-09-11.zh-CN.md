# Gateway 最近提交自审（2026-09-11）

首次审查发现 4 个条件可复现的行为缺陷、1 处交付合同与实现不一致，以及可直接删减的冗余代码。首次审查仅记录问题；后续授权修复和第二轮自审见文末。

## 审查范围与方法

审查对象为干净发布工作树 `C:/work/code/codex-gateway-sms-release`，HEAD `6f7dab4`。
主工作树有大量其他未提交修改，没有把它们混入本次提交审查。

| 功能提交 | 内容 |
| --- | --- |
| `532774d` | 新手机号开户默认每日 10,000 token |
| `31946c9` | 模型和图片请求错误提示 |
| `8dab89d` | 图片限制合同与最多两次的视觉恢复 |
| `9627d4f` | 免费与付费独立记账及权益共存 |

同时检查上述提交之间的交付、部署文档。下文行号以发布工作树为准。复现均使用内存 SQLite、合成账户及固定时间，不读取生产凭据，不调用真实模型。

## 应修复的问题

### R1 / P2：取消事件可能选中未来续费，留下当前暂停套餐

位置：`packages/store-sqlite/src/billing-events.ts:777-784`，新增于 `9627d4f`。

当当前付费权益已暂停，默认查询得到基础 Free 时，`resolveTransitionTarget` 会扫描付费历史，从 `active / paused / scheduled` 中取第一条。列表按创建时间倒序排列，因此新创建的未来续费先于当前暂停的套餐。

复现步骤：购买本月套餐 → 购买下月续费 → 暂停本月套餐 → 发送不带 `entitlement_id` 的 `cancel`。

实测结果：

```json
{
  "cancelledTarget": "future_renewal",
  "currentPaid": "paused",
  "futureRenewal": "cancelled",
  "free": "active"
}
```

影响：支付侧取消当前暂停订阅时，实际取消了另一笔未来权益；当前订阅仍能被恢复。现有合同允许状态变更省略 `entitlement_id`，不能依靠调用方始终显式指定来掩盖这个问题。

建议：默认目标限定为当前有效期的付费权益，并明确 active/paused 优先级；未来 scheduled 权益通过显式 ID 操作。保留 Free 保护，不按历史创建顺序猜目标。

### R2 / P2：重置 Free 会吞掉另一账本尚未完成的实际用量

位置：`packages/store-sqlite/src/token-budget.ts:958-972`，新增关联条件来自 `9627d4f`。

`finalizeActiveReservationsForReset` 新增 `free_entitlement_id` 匹配后，对命中的整条请求设置 `finalized_at` 和零用量。后续模型完成时，`finalizeReservation` 因请求已经结算而直接返回零，不再写实际用量。

复现步骤：先耗尽当日 Free → 发起一个仅预留 5,000 付费 token 的请求 → 重置 Free 的日窗口 → 请求返回 5,000 实际 token。

实测结果：

```json
{
  "freeReservedBefore": 0,
  "expiredByFreeReset": 1,
  "reportedTokens": 5000,
  "recordedTokens": 0,
  "paidUsedAfter": 10000
}
```

最后的 10,000 是此前已结算的付费用量，正在处理的请求整笔丢失。根因是所有带基础 Free 的付费请求都会保存 `free_entitlement_id`，即使其 `free_reserved_tokens=0`。

现有 Billing 重置接口选择当前权益。一个可达场景是付费请求仍在处理，套餐到期或被暂停后回到 Free，支持人员再重置当前 Free；此外，Store 的按权益重置接口本身已直接支持此操作。本次在 Store 层复现，未执行生产重置。

建议：只解除或重置选定账本的分配，保留另一账本以及整条请求的最终实际结算，不应将关联请求直接标记为零用量完成。增加“重置后请求仍返回 usage”的测试；当前测试只检查旧付费用量未被清空，没有检查晚到的结算。

### R3 / P2：管理页把仍有 Free 的用户显示为额度耗尽

位置：`packages/store-sqlite/src/quota-dashboard.ts:369-373`、`:1331-1357`、`:1427-1428`。这是 `9627d4f` 改变用量结构后遗漏适配的调用方。

服务端统计及页面筛选都只检查顶层 minute/day/month；渲染也没有显示 `free_allowance`。现在顶层 day/month 是付费账本，任一付费余额为零不代表用户不能继续使用 Free。

复现：付费周期额度耗尽，UTC 次日 Free 恢复，然后生成管理页数据并申请 1,000 token。

```json
{
  "paidRemaining": 0,
  "freeRemaining": 10000,
  "dashboardExhausted": 1,
  "requestActuallyAllowed": true
}
```

影响：支持人员看不到独立免费余额，并会把仍能使用的用户归入额度耗尽筛选。这个问题在 Gateway 自带管理页，不涉及客户端源码。

建议：展示免费、付费日额和付费周期余额；将技术限速与可用额度分开判断，同时更新服务端汇总和浏览器筛选。年付 `limit=null` 时也应保留已用量展示。

### R4 / P2：缺少 Free 模板时，付费成功但基础 Free 被静默省略

位置：`packages/store-sqlite/src/free-allowance.ts:48-50`，新增于 `9627d4f`。

当账户从未有过 Free，`ensureFreeAllowance` 遇到 Free 模板不存在或不是 active 会直接返回。付费购买随后仍以 applied 成功提交，没有错误、告警或缺失标识。迁移调用同一个函数，也不会留下需要补齐的状态。

在只安装月付模板的内存数据库中复现：

```json
{
  "applied": true,
  "eventStatus": "applied",
  "entitlements": [
    { "planId": "plan_paid_monthly_v1", "state": "active" }
  ]
}
```

这是新环境或配置缺失时的条件缺陷，不表示当前 R760 缺少 Free 模板。对已经明确暂停或取消的用户 Free 权益，应继续尊重其状态；那与公共模板配置缺失是两个不同情况。

建议：把公共 Free 模板作为零售套餐启用的配置前提，或在事务内通过既有开户工厂初始化；缺失时明确失败，不能把只完成部分权益的结果当成完整成功。这处静默降级属于应收紧的过度兜底。

### R5 / P2：交付合同声称缺失 usage 不扣费，Free 工厂却按估算扣费

位置：`docs/outbox/medevidence-free-paid-quota-contract-2026-09-10.zh-CN.md:73`，与 `packages/core/src/phone-signup.ts:21` 不一致。

新增合同写“当前公开 Free／付费模板为 none”。但 `phoneSignupFreePlan()` 返回 `missingUsageCharge: "estimate"`；自动开户使用该工厂创建不存在的 Free 模板。

直接使用真实工厂创建 Free，预留 7,000 token 后以无 usage 结算：

```json
{
  "policy": "estimate",
  "charged": 7000,
  "used": 7000,
  "remaining": 3000
}
```

影响：依据交付文档接入的团队会认为这种失败或超时不会扣额度，实际可能消耗新用户一天大部分 Free。分账测试手写的 Free 策略是 none，没有使用开户工厂，掩盖了这个差异。

归因边界：estimate 行为原来就存在；本次新增问题是交付合同作了不准确的保证，不能把既有估算策略描述成本次新引入的扣费 bug。本次未查询每个生产权益快照，不能据此宣称全部存量用户都采用 estimate。

建议：先使合同如实反映模板与快照；若产品规则决定失败缺失 usage 不扣费，再调整新发放策略并单独处理存量快照。不要借文档修正自动变更已有用户权益。

## 冗余、抽象及兜底判断

- `apps/gateway/src/billing-admin.ts:2449` 的 `publicWindowSnapshot` 已无调用方，可以删除。`:2423` 的 `publicTokenUsageSnapshot` 只透传公共函数，调用处可以直接使用 `publicTokenUsage`，无需保留一层同义封装。
- `free-allowance.ts` 在 SQL、TypeScript 判断以及新发放默认值中重复列出产品 ID。可以集中少量常量，新发放默认值复用 `phoneSignupFreePlanId`；历史识别名单和历史迁移仍需保持明确，没必要扩展成通用套餐规则引擎。
- 视觉恢复在普通流式、普通非流式、原生工具路径分别组织执行；工具路径还使用通用类型的 `runVisionRequestRecovery`。这里存在重复的期限、结果汇总逻辑，但本次没有复现超出两次调用的缺陷。适合小范围收敛，不建议为两个调用名额引入新的通用状态机、策略注册器或更多开关。
- 幂等写锁、双额度原子预留、保留历史权益快照、统一重试预算以及旧账本导入拒绝双账本记录，都有实际一致性约束，不应为了减少行数删除。

## 验证及剩余范围

- 发布工作树相关既有测试：5 个文件 110 项通过；Gateway `index.test.ts` 全部 289 项通过，合计 399 项。
- 发布工作树 `npm run build`（TypeScript 构建及类型检查）通过。
- 五个针对性内存复现覆盖上述 R1–R5。测试数据及连接随进程关闭，无生产账户、权益或 Key 操作。
- R1、R2 是状态组合与晚到结算缺口；R3 是读模型遗漏；R4 是异常配置被静默降级；R5 是测试替身与真实产品工厂不一致。
- 本次是代码自审，未把生产事故发生情况作为结论，也没有重新执行真实短信、支付或 EXE 联调。
- 建议修复次序：先 R1/R2，再 R3/R4，随后同步合同与真实模板并删除死代码。既有测试通过不能替代这些针对性场景。


## 修复与第二轮自审（2026-09-11）

以下是后续授权实施的结果；上面的发现与复现保留为历史依据。

| 项目 | 修复与回归 |
| --- | --- |
| R1 | 默认取消只选择当前付费或当前周期暂停权益；保留下月 scheduled 续费，显式 ID 仍可取消未来权益；没有当前付费目标返回 404。 |
| R2 | 同一事务检查双账本关联的未结算请求；冲突返回 409 quota_reset_conflict，保留请求、两份账本和请求次数；晚到的实际用量正常结算，完成后可重试重置。 |
| R3 | 管理页显示独立免费日、付费日及付费周期用量；服务端统一计算耗尽标记供汇总和筛选使用；不限额窗口仍显示已用及预留量。 |
| R4 | 缺失 Free 模板时复用现有手机开户工厂初始化；明确 deprecated 且需新发 Free 时，409 plan_inactive 并回滚整个权益事件；已有历史快照和明确暂停／取消的 Free 保持原状态。 |
| R5 | 实测 R760 公共 Free 模板为 estimate，月付和年付为 none。修正交付合同，分账测试改用真实 Free 工厂并验证缺失 usage 的 7,000 token 估算结算；不变更现有模板或快照。 |

已删除 Billing 的无用窗口序列化函数和纯透传包装，集中公共产品识别名单。未为视觉重试另建通用状态机。

第二轮逐项检查了目标选择、事务回滚、零免费预留但仍关联 Free 的请求、日及周期重置、Billing HTTP 请求次数、管理页汇总／筛选和无限额度展示。关键行为均有回归证据，未发现新的阻断发布问题。

本地 TypeScript 构建通过，六个相关测试文件共 412 项通过。管理页测试执行真实页面生成的渲染函数并检查脚本语法，不等同于浏览器布局或 Desktop 验收。修复提交 `77c6404` 已部署 R760，600 项 Linux 回归及公网业务自测通过；详见[发布报告](operations/r760-quota-review-fixes-release-2026-09-11.zh-CN.md)，其中另列本次发现的既有 Research maintenance 故障。
