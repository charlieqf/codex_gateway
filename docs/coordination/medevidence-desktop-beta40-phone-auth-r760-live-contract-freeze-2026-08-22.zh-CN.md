# MedEvidence Desktop beta.40 × R760 Phone Auth live contract 冻结签收

| 项目 | 结论 |
| --- | --- |
| 状态 | `contract_frozen` / `desktop_live_acceptance_passed` |
| 冻结时间 | 2026-08-22T03:19:31Z（2026-08-22 13:19:31 AEST） |
| Contract ID | `medevidence-r760-dual-track-phone-auth-v1` |
| 唯一生产 Origin | `https://goldencode.instmarket.com.au:1443` |
| 最低 Phone Auth Desktop | `2.0.0-beta.40` |
| Gateway contract commit | `dc4e86828da32ae0ce8119302b04a68f5bde5569` |
| Desktop acceptance commit | `65eadd000a310e64897e9700def9b8f4e0941be9` |
| Gateway prefix hotfix commit | `5f01efeec34baad26eb5e3e54693bf72c0dd97f9` |
| R760 基础 release | `f7e69eabbc5c1fed484d63f2547af158fc70238e` |
| R760 active Gateway image | `sha256:60f3e70aa12ae1c648a6cfbb73f262234bc44dde60d2e61e28f31d99a2173baf` |

## 1. 冻结对象

双方签收的是 Gateway commit
`dc4e86828da32ae0ce8119302b04a68f5bde5569` 中的完整目录：

```text
docs/contracts/medevidence-r760-dual-track-phone-auth-v1/
```

其中的完整性摘要为：

- `README.md`：`8cc44f4cd2f0e81e2747aa720df75a9fb0096c558cd06396e2456ccc7da9f2e2`
- `fixtures.json`：`44ee80ce8eab7d1dbd22dede4cc9320a9cc9e97a11aea2ac3e1b8a0ea17cbb02`

冻结后不改写这组已签收文件。文件内的 `contract_candidate` 是产物生成时的
状态标签；从本签收记录开始，规范状态由本文件的 `contract_frozen` 冻结证明
确定。这种外部冻结证明保留了双方已经校验的文件字节和 SHA-256，不要求用
修改已签收产物的方式改变其摘要。

## 2. Prefix 热修发布证明

Desktop 首轮联调发现：Phone Auth 响应返回的 `codex_gateway.api_key` 以
`cgw.` 开头，而同一响应的 `key_prefix` 只包含数据库存储前缀，客户端因此
正确拒绝为 `invalid_gateway_response`。

Gateway hotfix 仅把面向客户端的表示规范化为
`cgw.<stored-prefix>`，没有修改数据库、轮换 Key 或改变 Subject/Plan/
entitlement。主线修复 commit 为
`5f01efeec34baad26eb5e3e54693bf72c0dd97f9`；R760 使用基于已部署
`f7e69eabbc5c1fed484d63f2547af158fc70238e` 的最小、无网络 overlay，当前
Gateway image 为：

```text
sha256:60f3e70aa12ae1c648a6cfbb73f262234bc44dde60d2e61e28f31d99a2173baf
```

镜像标签同时记录基础 release、hotfix commit 和 artifact v2。回滚 tag
`codex_gateway_r760-gateway:rollback-prefix-contract-20260822T004000Z`
仍指向变更前镜像。变更前备份为
`/data/codex-gateway-r760/backups/phone-auth-ab-window-20260822T004050Z`，
hotfix 后、窗口开启前的备份为
`/data/codex-gateway-r760/backups/phone-auth-ab-window-20260822T004716Z`；
两者的记录摘要均已复核通过。

## 3. Desktop live acceptance

Desktop beta.40 在真实 R760 上完成 A/B/U 矩阵：

- A：beta.38 legacy Key 接管、原地升级、手机号登录、两次真实聊天、重启恢复、
  登出和 suppression 全部通过；
- B：全新隔离 profile、手机号登录、重启前后两次真实聊天和登出全部通过；
- U：未登记手机号严格返回 `403 phone_not_registered`；
- resolver、bootstrap、`credentials/current`、`account/current` 的 Subject、
  Plan、entitlement、capabilities、URL 和 `cgw.<stored-prefix>` 绑定全部通过；
- 四次聊天均只有一次 transport attempt、一个 Gateway Request ID，最终为
  `completed / ok`，没有客户端多余重试。

用于双方关联的 Gateway Request ID 为：

```text
resolver/current:
req-fb3e1bfd-5c3a-469f-b8b0-89d99350116f
req-e8985cc0-9609-405d-b94c-da87b852b7f3

chat:
req-54d46a1d-a1f3-4f29-b17d-5a00c8d175f7
req-cb6419be-69b2-4a6b-ad3c-e098c19b42fa
req-be3d2a7c-4bda-47c0-836e-9369210fda2d
req-2f8ca271-9a5c-42bf-8546-9e0064f82e42

unknown phone:
req-70fc8e11-cb82-494a-b9d3-342a8642bcfa
```

Desktop 权威签收文档：

```text
C:\work\code\medevidence-opencode-stable\docs\outbox\medevidence-desktop-beta40-phone-auth-r760-live-acceptance-2026-08-22.zh-CN.md
```

签收时 Desktop `dev` 与 `origin/dev` 均为
`65eadd000a310e64897e9700def9b8f4e0941be9`；beta.40 安装包 SHA-256 为
`0dd8a6dc8ef28a06adba4d5428759c708233aa1bda8e8cb2731c489107056d95`。

## 4. 自动关窗与运行时终态

replacement window 从 `2026-08-22T00:49:54Z` 到
`2026-08-22T02:49:54Z`。到期后的 Gateway 权威审计结果：

- timer service：`Result=success`、`ExecMainStatus=0`，timer 已 inactive；
- public/loopback health：`disabled / disabled / null`；
- 两个合成 A/B Phone identity 均为 disabled；
- 8 个相关 Phone Session 均为 revoked，活动 Refresh Token 为 0；
- Gateway、Research Worker、Research maintenance、Research LLM Gateway
  全部 healthy，restart count 均为 0；
- active Gateway image 仍为本文件记录的 hotfix digest；timer 没有回滚 hotfix；
- live Gateway SQLite `quick_check=ok`，foreign-key error 为 0。

Desktop 主机策略未允许物理删除六个隔离测试 profile，因此没有执行部分删除。
所有可能建立的产品 Session 已通过产品边界登出或从未建立；这不构成 Gateway
活动身份或 Session 残留。

## 5. 权威数据与计量不变量

以 hotfix 后、窗口开启前备份与关窗后的 R760 live database 做只读、逐行比较：

- A/B 的 `subjects`、全部 `access_credentials`、全部
  `unified_client_keys`、全部 `entitlements` 和引用的 `plans` 精确相等；
- 没有 token/quota window 行丢失，没有任何数值回退；
- 四个 chat Request ID 均只在窗口后出现，全部 `status=ok`、无错误、无限流；
- 恰有四个对应 reservation，全部 finalized，open reservation 为 0；
- request event usage 与 reservation final usage 完全相等：prompt 141,772、
  completion 48、total 141,820、cached 88,384、estimated 0、requests 4；
- `entitlement_token_windows` 的 minute/day/month 三个窗口各自都只增加上述
  四次正常业务请求的同一组用量；没有认证、resolve 或重试被错误计费。

因此，Subject、Plan、entitlement、Key、capability 和既有用量均保持不变；
唯一允许的权威状态变化是四次真实、成功、可计费聊天所产生的额度消耗。

## 6. 签收结论与仍保留的业务闸门

Gateway 与 Desktop 已签收同一份 live contract。beta.40 Phone Auth 技术合同可
进入正式客户端发布流程；beta.38 及其他旧客户端继续使用原有
`cgu_live_*`，不受 Phone Auth 开关影响。

当前生产默认状态仍为 `disabled / disabled`。本次技术签收不等于授权批量启用
Phone Auth，也不授权预登记真实用户。任何真实用户预登记都必须由业务 owner
明确批准手机号与既有 Subject 的映射，并继续满足“未知手机号不自动创建账户、
Key、Plan 或 entitlement”的冻结合同。
