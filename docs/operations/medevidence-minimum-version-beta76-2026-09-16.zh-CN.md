# MedEvidence Desktop 最低版本 beta.76 上线与恢复手册

日期：2026-09-16。

## 决策与公网证据

最低支持版本固定为 `2.0.0-beta.76`，`1.9.116` 和所有更低版本均拒绝访问
MedEvidence Gateway 业务路径。

公网 beta 更新源当前声明：

```text
version: 2.0.0-beta.76
path: medevidence-desktop-win-x64.exe
size: 151319735
releaseDate: 2026-09-15T06:32:21.604Z
```

稳定公网安装包地址：

```text
https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe
```

上线前必须再次确认 `latest.yml` 仍为 `2.0.0-beta.76` 或更高，且安装包 HEAD 为
`200`。`GATEWAY_DESKTOP_DOWNLOAD_URL` 使用上述稳定公网地址，使登录、对话、图片、
Research 和 Vision 的 `426 client_upgrade_required` 都返回同一个可操作下载链接。

## 生产配置

```text
GATEWAY_PHONE_AUTH_MODE=transition
GATEWAY_DESKTOP_VERSION_GATE=medevidence_all
GATEWAY_MINIMUM_DESKTOP_VERSION=2.0.0-beta.76
GATEWAY_DESKTOP_DOWNLOAD_URL=https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe
```

`medevidence_all` 覆盖 Phone Session、resolver、credentials/current、`/v1/*`、
Research、image generation 和 Vision Asset 路径。它只作用于下列请求：

- Phone Session 路径；
- 明确携带 `X-MedEvidence-Client-Version` 的请求；
- `desktop` credential；
- 已登记 Phone identity 的 Subject。

显式 `service`、`operator` credential 豁免；未识别为 MedEvidence 的共享 Gateway
请求不受影响。已登记的旧客户端可通过 `X-MedCode-Client-App-Version` 识别，因此
`1.9.116` 会稳定得到 426，而不是落入缺失版本的不确定分支。

响应示例：

```json
{
  "error": {
    "code": "client_upgrade_required",
    "message": "A newer MedEvidence Desktop version is required.",
    "request_id": "<request-id>",
    "minimum_version": "2.0.0-beta.76",
    "download_url": "https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe"
  }
}
```

Desktop 应把该结构渲染为会话内升级提示/卡片，并提供可点击下载按钮；不要把普通
上游模型错误伪装成升级错误。

## 手机登录与权益快速恢复

恢复命令默认只诊断。它验证同一个 Subject 上的 Phone identity、current Desktop
统一 Key、backing credential 和 chat entitlement，不输出手机号、密钥或密文。

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- `
  restore-medevidence-access <subject-id> `
  --reason "support ticket <id>"
```

如果诊断只发现 Subject/Phone identity 被停用，执行：

```powershell
python scripts/manage-r760-gateway-control.py -- `
  restore-medevidence-access <subject-id> `
  --reason "support ticket <id>"
```

如果现有 chat entitlement 为 `paused`，必须显式选择该 entitlement；命令不会猜测
Plan，也不会新增权益：

```powershell
python scripts/manage-r760-gateway-control.py -- `
  restore-medevidence-access <subject-id> `
  --reason "support ticket <id>" `
  --resume-entitlement <entitlement-id>
```

正式执行顺序为：只读预检、在线 SQLite 备份、恢复写入、完整性/FK 检查、只读复验。
所有变化写入 admin audit；Phone identity 和 entitlement 另写各自审计。该路径只恢复
已有状态，不清零用量、不撤销 Session 以外的旧 Key、不创建新 Plan/entitlement，也不
复活 revoked/expired/unrecoverable Key。Key bundle 不健康时必须停止，使用受控 Billing
Key rotation 流程，不能用临时扩权绕过。

## 系统性故障回退

如果 beta.76 的手机登录出现系统性故障，先保留数据库和全部用户权益，回退到前一份
受保护配置并只 recreate Gateway。紧急兼容可临时恢复 `auth_only`；这会重新允许旧 Key
业务路径，因此必须记录批准、开始时间和恢复 `medevidence_all` 的截止时间。不得通过
停用真实 Subject、撤销真实 Key、改变 Plan/entitlement 或恢复旧数据库来回退版本门禁。

