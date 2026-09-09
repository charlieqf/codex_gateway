# MedEvidence 短信运行授权 v2 接口合同

日期：2026-09-09。合同 ID：`medevidence-sms-runtime-v2`；`contract_version=2`。

**状态：Gateway 本地实现与联调候选合同，尚未部署、未完成双方冻结及真实短信／支付验收。** 客户端可用本目录对齐 adapter 和测试。接口合同不等于登录页的用户协议或隐私政策。

- API origin：`https://goldencode.instmarket.com.au:1443`，原有路径保持不变。
- 响应样例：[fixtures.json](./fixtures.json)；内容摘要：[SHA256SUMS](./SHA256SUMS)。
- 开发与验收状态：[Gateway 交付说明](../../outbox/medevidence-sms-runtime-gateway-development-handoff-2026-09-09.zh-CN.md)。
- 临时手机号登录继续使用[现有 v1 合同](../medevidence-internal-phone-auth-v1/README.md)。

## 1. 客户端授权

```http
POST /gateway/auth/v2/runtime/authorize
Authorization: Bearer <外部 access_token>
Content-Type: application/json
X-MedEvidence-Client-Version: <实际 Desktop 版本>
```

```json
{
  "credential_type": "external_access_token",
  "client": "medevidence-desktop",
  "device_id": "desktop-device-example-01",
  "contract_version": 2
}
```

请求体仅接受上述四个字段；device_id 为 1—200 位 ASCII 字母、数字或 `._:-`。请求体上限 4096 字节，token 上限 8192 字符。access_token 只放 Authorization；不传 refresh_token、Phone Session、cgu_live、手机号、subject_id 或外部 user_id。手机号由身份后端在第 3 节的开户协调中提供，JWT 不需要含手机号。

Gateway 验证外部身份后，按配置的 provider 和转换后的 external_user_id 查找 Subject。授权过程读取账户和现有 Key，不开户、不关联手机号、不轮换 Key、不发新权益，也不保存外部 token。权益查询沿用既有到期／预约生效状态推进，可能更新原权益状态与审计记录，不是严格的数据库只读事务。

所有响应带 `Cache-Control: no-store`；返回 `X-Request-ID`，JSON 内 request_id 与其一致。客户端忽略新增响应字段，但严格验证现有身份和运行凭据。

| HTTP / status | 含义 | Desktop 行为 |
| --- | --- | --- |
| 200 / authorized | 账户有效、存在可恢复且有效的 current Desktop Key、backing credential 和 code/chat 权益 | Main 保存／安装同一 Subject 的 Key，使用现有 resolver 与 credential-current 检查运行能力 |
| 200 / account_ready | 账户已识别，当前没有有效 code/chat 运行权益；runtime 为 null | 保留外部登录，可进入支付；回前台或手动刷新时用外部 access_token 再授权 |

共同字段：`contract_version/status/subject/runtime/entitlement/request_id`。

- `subject`：`{id: "subj_...", state: "active"}`。Subject 必须与已有本地短信会话一致；切号由既有客户端流程处理。
- `runtime`：authorized 时包含 `unified_key/unified_prefix/unified_expires_at/resolver_url/capabilities`；account_ready 时必须为 null。
- `unified_key`：完整 `cgu_live_` 加 64 位字母数字；`unified_prefix` 为 `cgu_live_` 加数据库 16 位 prefix，必须是完整 Key 的前缀。
- `unified_expires_at`：该 Key 的真实 UTC RFC3339 到期时间；不是外部 JWT 或本地 7 天会话的期限。
- `resolver_url`：固定为 `https://goldencode.instmarket.com.au:1443/gateway/unified-keys/resolve`。
- `capabilities`：已确认 code/Desktop 凭据和 goldencode 允许范围后的当前权益能力快照，去重且含 chat。请求级模型限制、额度、频率及服务是否配置仍由现有 resolver/current 与模型入口执行；authorized 不保证每个模型请求成功。
- `entitlement`：`state/plan_id/period_kind/period_start/period_end/feature_policy`。state 为 active、none、missing、expired、paused、cancelled 或 scheduled；其余字段没有对应权益时为 null。feature_policy 使用既有公开权益结构。active 权益如不含 code/chat，仍返回 account_ready。
- 有效权益但缺 current Key、恢复材料损坏或凭据关联异常时返回 409，而不是生成另一把 Key。Key 已过期／吊销时返回对应 401。

## 2. 失败与重试

错误体：`{"error":{"code":"...","message":"...","request_id":"..."}}`。不得仅凭 HTTP 401 一律刷新外部 token；先区分 error.code。

| HTTP | error.code | 客户端处理 |
| --- | --- | --- |
| 400 | invalid_request | 修正合同／设备 ID，不自动重试 |
| 401 | external_token_invalid / external_token_expired | 按既有单飞刷新规则刷新外部会话；失败则重新短信登录 |
| 401 | expired_credential / revoked_credential | 模型 Key 失效，停止安装／使用该 Key；重新短信登录不能续期或解除吊销 |
| 403 | account_disabled | 账户停用，停止运行 |
| 409 | identity_link_required | 后端尚未完成关联；保留外部会话并提示账户尚未就绪，不让 Desktop 调用 Admin API |
| 409 | account_pending | 原开户业务正在处理；保留外部会话，可有限重试 |
| 409 | identity_conflict | 存在冲突，由后台处理；不自动改绑或开户 |
| 409 | account_migration_required | Gateway 需检查 Key 恢复／凭据准备；不要求用户输入历史 Key |
| 426 | client_upgrade_required | 展示既有版本门禁的 minimum_version、download_url；最低版本取部署配置 |
| 429 | auth_rate_limited | 按 Retry-After 与 error.retry_after_seconds 延迟重试 |
| 503 | service_unavailable | 外部授权未配置或 Gateway 暂不可用；保留外部登录并提示稍后重试 |
| 503 | identity_service_unavailable | 身份接口超时、不可用或响应不符合合同；与明确 token 失效区分 |

接口限制为每 IP 每分钟 60 次、每 device_id 每分钟 30 次，各最多 4 个并发；当前 limiter 为进程内实现。错误不触发手机号临时登录自动降级。

建议联调客户端对 account_pending 和短暂 503 最多自动重试 3 次，间隔 2/5/10 秒并加少量随机延迟；切号／退出即取消。此退避是客户端建议，服务端不启动后台轮询。account_ready 沿用当前回前台／手动刷新行为，不循环开户。

**客户端同步项：** 2026-09-08 adapter 的 safeCode 尚未明确区分 identity_link_required、identity_conflict、expired_credential、revoked_credential；需补可理解提示与正确重试分类。成功响应结构和 v2 路径保持客户端已实现的格式。

## 3. 身份后端开户前协调（服务端接口）

身份团队现有“首次手机号登录自动创建外部用户”保持不变。在执行 Gateway 开户前，身份后端用已验证手机号调用：

```http
POST /gateway/admin/billing/v1/subjects/resolve
Authorization: Bearer <既有 Billing Admin 凭据>
Content-Type: application/json
```

```json
{
  "provider": "medevidence_billing",
  "external_user_id": "medevidence_test_21",
  "phone": "13800138000"
}
```

上述手机号、ID 仅为测试样例。请求只接受这三个字段；provider 必须等于当前配置，external_user_id 使用既有 Billing 字符规则。phone 支持既有中国大陆手机号归一化。Desktop 不持有 Admin 凭据。

| 200 status | subject | 后续操作 |
| --- | --- | --- |
| linked | `{id,state}` | 已复用原账户；保存 subject.id，继续既有权益／订单逻辑，不再 create |
| create_ready | null | 确认没有原手机号 Subject，已持久化开户准备状态；调用原 POST /subjects |
| account_pending | null | 原创建事件尚未完成；复用原 Idempotency-Key 和完全相同请求体重试 create |

resolve 本身按 provider/external_user_id 幂等，不需要另造 Idempotency-Key。已建立稳定映射后，不因请求手机号变化自动切换 Subject。手机号多账户、同 provider 下另一外部 ID 已绑定该账户或并发占用冲突返回 409 identity_conflict；停用／归档账户返回 403 account_disabled，不删除后复用。

仅对配置的 external provider，POST /subjects 新增“必须先 resolve”的要求；其他 provider 保留原开户入口。协调记录在 SQLite 中持久化，调用上游前绑定固定业务事件；同事件可恢复，换 key 返回 account_pending，同 key 改 body 返回 idempotency_conflict。上游成功但本地失败时继续使用原事件，避免重新生成开户业务。放弃未完成开户需受控排查，本轮不提供自动过期释放或删除接口。

旧账户关联只增加外部身份别名，保留原 Subject 主字段、Key、权益与用量。随后原 `GET /subjects?provider=...&external_user_id=...` 也能查到这个 Subject。新开户的 phone_number 来源于开户准备记录。

原开户／轮换公开合同继续有效：完整 credential.key 仅首次成功响应返回，幂等 replay 不再次返回明文。配置恢复密钥后，新 Key 在 Gateway 保存可恢复密文并标为 current；以后短信运行授权可恢复同一把 Key。受控轮换同步更新已登记手机号身份的 current Key；不会把新短信用户自动登记为临时手机号登录用户。

## 4. 已确认的 ID 转换与环境配置

身份团队 2026-09-09 提供的 `_get_external_user_id(user_id: int)` 代码：

| 身份后端 APP_ENV | external_user_id | Gateway GATEWAY_EXTERNAL_AUTH_USER_ID_PREFIX |
| --- | --- | --- |
| 严格等于 prod | `str(user_id)`，如 `21` | 显式空字符串 |
| 其他值，包括测试／未设置 | `medevidence_test_{user_id}`，如 `medevidence_test_21` | `medevidence_test_` |

这确认了第二个外部问题的转换规则。截图没有展示 provider；已有开户协作使用 `medevidence_billing`，联调与该环境实际开户请求核对即可。不要把测试前缀改成另一个 provider 来替代它。

当前 Desktop 固定调用短信测试站点，Gateway 应使用测试前缀。Gateway 本身的运行环境不能用来猜身份后端的 APP_ENV；同一次授权不依次尝试两种前缀。测试用独立测试手机号／账户，不能将两个环境相同数字 user_id 视为同一人。

Gateway 当前每个进程只配置一个外部身份环境。切到生产时同时对齐 Desktop 身份地址、Gateway verifier 配置和 ID 前缀。前缀负责账户命名，不负责证明 token 来自哪个环境；验签密钥或固定受保护接口必须与该身份环境匹配。如果两个身份环境共用 HS256 密钥且 token 没有环境 claim，本地验签无法区分环境，不能宣称隔离已验证。

## 5. 外部 access_token 接入适配器

身份团队已说明“JWT，服务端校验，非法 token 报 code=401”。调用他们现有受保护功能时，该功能自身会校验；不需要先单独请求一个新“校验服务”。Gateway 接受外部登录并签发运行授权时，仍需配置实际可用的接入方式：

| 模式 | 本地已实现的能力 | 启用所需资料 |
| --- | --- | --- |
| disabled，默认 | v2 返回 503；现有 v1 继续工作 | 无 |
| hs256 | 使用明确配置的 HS256 密钥验签，拒绝 refresh、过期、错误算法／签名；检查已约定的 issuer/audience | 该环境允许我们使用的验签配置与密钥交付；不能从示例 token 推导密钥 |
| userinfo | 一次调用既有受保护用户信息接口，取得该 token 的用户身份；没有额外的预校验请求 | 固定 HTTPS URL、GET/POST、实际响应示例；当前 adapter 候选结构为 `{code:200,data:{user_id}}` |

userinfo 候选 adapter 区分 HTTP 401/403、HTTP 200 中 code=401、超时／错误响应；5 秒超时，16 KiB 响应上限，不跟随重定向。它核对服务端返回 user_id 与 JWT claim 一致后才接受；单纯解码 JWT 不构成验真。对方尚未提供这个接口的实际地址／返回体，不能仅填猜测 URL 就宣称完成接入。

两个 adapter 当前依据原始样例支持 `user_id/token_type=access/exp`；配置的 issuer/audience 非空时强制匹配。HS256 本地验签不能感知身份后端的提前撤销，撤销语义须以其接入规范为准；Gateway 自身 Subject 停用和 Key 吊销仍即时生效。

| 配置项 | 约定 |
| --- | --- |
| GATEWAY_EXTERNAL_AUTH_MODE | disabled / hs256 / userinfo |
| GATEWAY_EXTERNAL_AUTH_PROVIDER | 该环境实际开户 provider；配置后启用 resolve 和该 provider 的开户前协调要求，即使 mode=disabled 也生效 |
| GATEWAY_EXTERNAL_AUTH_USER_ID_PREFIX | 必须显式设置；生产为空，非生产为 medevidence_test_ |
| GATEWAY_EXTERNAL_AUTH_HS256_SECRET 或其 _FILE | hs256 模式必须提供，至少 32 字节；使用既有受控密钥注入 |
| GATEWAY_EXTERNAL_AUTH_USERINFO_URL / _METHOD | userinfo 模式固定 HTTPS 地址；METHOD 默认 GET，另支持 POST |
| GATEWAY_EXTERNAL_AUTH_ISSUER / _AUDIENCE | 按身份方实际约定设置，未提供时不虚构 |
| GATEWAY_UNIFIED_KEY_RECOVERY_KEY 或其 _FILE | 使用既有 Key 恢复密钥，不生成新值替换旧密钥 |
| GATEWAY_API_KEY_ENCRYPTION_SECRET | 既有 backing 凭据加密密钥 |
| GATEWAY_PUBLIC_BASE_URL | 本合同 API origin |

先完成 backend resolve 接入，再启用 external provider 的强制开户协调。启用 v2 时缺少必要存储／恢复配置将启动失败；默认关闭时不会把测试 verifier 注入生产。数据库新增 migration 28；部署须按既有备份／迁移流程进行，本轮未执行生产迁移。

## 6. 正式协议与联合验收

用户协议和隐私政策仍需产品提供可访问的正式 HTTPS 地址，分别配置客户端 `MEDEVIDENCE_AUTH_TERMS_URL`、`MEDEVIDENCE_AUTH_PRIVACY_URL`。不能用本接口文档或 example.com 代替。当前客户端缺少这两个地址时，会禁用两个新登录表单；已有会话恢复不受影响。

真实验收必须覆盖：旧用户首次短信登录保留原账户与 Key；新用户开户／无权益／同账号到账后授权；测试与生产 ID 隔离；外部 token 失效／刷新；临时手机号入口；真实 captcha、短信、支付 A/B 隔离、通知 Subject、Sidecar 模型调用及本地账户历史隔离。本地测试和 fixture 不替代这些证据。
