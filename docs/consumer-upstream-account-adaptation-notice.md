# MedCode Gateway 客户端适配说明：上游账号字段重命名

发布日期：2026-04-29

MedCode Gateway 将把公开响应中的“订阅”命名逐步迁移为“上游账号”。这次调整是命名澄清，不改变鉴权方式、模型调用方式、会话语义、限流策略或错误处理主流程。

请客户端尽快完成以下适配。旧字段会保留一个兼容窗口，但已不建议继续依赖。

## 需要适配的字段

### 1. `GET /gateway/status`

新字段：

```json
{
  "upstream_account": {
    "label": "medcode",
    "provider": "medcode",
    "state": "healthy",
    "detail": "MedCode service is available."
  }
}
```

旧字段仍会暂时返回：

```json
{
  "subscription": {
    "id": "medcode",
    "provider": "medcode",
    "state": "healthy",
    "detail": "MedCode service is available."
  }
}
```

客户端应改为读取：

- `upstream_account.label`，替代 `subscription.id`
- `upstream_account.provider`，替代 `subscription.provider`
- `upstream_account.state`，替代 `subscription.state`
- `upstream_account.detail`，替代 `subscription.detail`

注意：新对象使用 `label`，不是 `id`。这个值是公开展示标签，不是数据库主键。

### 2. `POST /sessions` 与 `GET /sessions`

新字段：

```json
{
  "session": {
    "id": "sess_...",
    "subject_id": "trial-user-1",
    "upstream_account_label": "medcode",
    "subscription_id": "medcode"
  }
}
```

客户端应改为读取 `session.upstream_account_label`，替代 `session.subscription_id`。

`subscription_id` 会暂时保留为兼容别名，但它实际承载的是公开 label，不应再被理解为“用户订阅 ID”或内部数据库 ID。

## 不需要适配的接口

OpenAI-compatible 接口不受影响：

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/chat/completions`

这些接口不会新增 `upstream_account` 字段，也不会输出旧的 `subscription` 字段。

## 错误码不变

错误码 `subscription_unavailable` 继续保留。客户端现有的错误处理逻辑不需要改名。

当收到：

```json
{
  "error": {
    "code": "subscription_unavailable"
  }
}
```

仍按“MedCode 上游服务暂不可用，请稍后重试或联系服务管理员”处理。

## 自托管或配置方需要改的环境变量

如果你维护自己的网关部署配置，请改用：

```env
GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL=medcode
```

旧变量仍会暂时兼容：

```env
GATEWAY_PUBLIC_SUBSCRIPTION_ID=medcode
```

但旧变量会触发 deprecated 警告。新旧同时设置时，以 `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL` 为准。

## 建议验证清单

客户端发布前请至少验证：

1. 设置页或健康检查页读取 `GET /gateway/status` 的 `upstream_account.label/state/detail`。
2. 创建会话后保存 `session.id` 的逻辑不变，不再依赖 `session.subscription_id` 做业务判断。
3. 会话列表页如展示服务标签，改读 `sessions[i].upstream_account_label`。
4. OpenAI-compatible 调用路径 `/v1/chat/completions` 回归测试通过。
5. `subscription_unavailable` 错误码仍能被现有错误处理逻辑识别。

## 兼容窗口内的建议实现

为了兼容尚未升级的网关实例，客户端可以在短期内使用 fallback：

```ts
const upstreamAccountLabel =
  session.upstream_account_label ?? session.subscription_id ?? null;

const upstreamAccount =
  status.upstream_account ?? (
    status.subscription
      ? {
          label: status.subscription.id,
          provider: status.subscription.provider,
          state: status.subscription.state,
          detail: status.subscription.detail
        }
      : null
  );
```

新代码不应再新增对 `subscription` / `subscription_id` 的硬依赖。兼容 fallback 应集中封装，方便后续移除。
