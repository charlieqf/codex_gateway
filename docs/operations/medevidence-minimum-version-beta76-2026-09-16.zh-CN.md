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
请求不受影响。`desktop` credential 或已登记 Phone identity 的旧客户端可回退读取
`X-MedCode-Client-App-Version`，因此正式版 `1.9.116` 会稳定得到 426。Phone Session
路径只接受明确的 `X-MedEvidence-Client-Version`，不信任旧通用版本头。版本头是兼容性
策略信号，不是防篡改证明；门禁目标是停止支持旧客户端，而不是对修改版客户端做安全认证。

响应示例：

```json
{
  "error": {
    "code": "client_upgrade_required",
    "message": "A newer MedEvidence Desktop version is required. Download the latest version: https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe",
    "request_id": "<request-id>",
    "minimum_version": "2.0.0-beta.76",
    "download_url": "https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe"
  }
}
```

`message` 内也保留完整 URL，确保只展示旧错误文本的客户端仍能看到下载地址。Desktop
应优先把结构化 `download_url` 渲染为会话内升级提示/卡片和可点击下载按钮；不要把普通
上游模型错误伪装成升级错误。

## 上线顺序

镜像与配置分两步切换：

1. 先部署支持 `medevidence_all` 的 Gateway 镜像，保持现有 `auth_only`、最低版本和下载地址
   不变；确认健康、重启次数、数据库完整性以及其他容器均未变化。
2. 再做一次独立的受保护配置变更，只允许修改上述三个 Desktop version gate 键，渲染完整
   Compose 配置后只 recreate Gateway，并逐项核对容器内最终值。

不要在镜像发布脚本里顺带拼接环境变量，也不要用“当前容器全部环境变量”等价于“Compose
重新渲染的全部环境变量”这一假设做哈希断言；镜像默认环境和 Compose 注入来源不同，会造成
误判。配置切换前保存原 override、其哈希和当前容器 ID，任一检查失败即恢复原 override 并
recreate 旧配置。

切换后的最小验证矩阵：

- Phone Session 缺少新版头：426，响应文本和 `download_url` 都包含公网安装包；
- `desktop` credential + `X-MedCode-Client-App-Version: 1.9.116`：426；
- `X-MedEvidence-Client-Version: 2.0.0-beta.76`：越过版本门禁；
- `service` / `operator` credential：不受非 Phone Session 门禁影响；
- 未识别为 MedEvidence 的共享 Gateway 客户端：不受 `medevidence_all` 影响；
- health ready、restart count 为 0、其他容器 ID 不变。

## 手机登录与权益快速恢复

本次上线不引入跨 Subject、Phone identity、Key 和 entitlement 的组合写命令。这几个状态
目前没有一个对外暴露的共同事务边界；把它们包装成一个命令会产生“全部成功”的错觉，后半段
失败时却可能已经写入前半段。

支持人员先通过现有只读 admin/Billing 查询确认以下四项，并且不得输出手机号、完整 Key 或密文：

- Subject 状态；
- Phone identity 状态及其 current unified Key 关联；
- backing Desktop credential 是否未撤销、未过期；
- 当前 chat entitlement 是否为 `active`，或明确选中的既有 entitlement 是否为 `paused`。

只修复被确认异常的层，每一步完成后立即复验。Subject 被停用时，先预演再使用现有的
backup-first、带审计控制脚本：

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- enable-user <subject-id>
python scripts/manage-r760-gateway-control.py -- enable-user <subject-id>
```

Phone identity 单独被停用时，使用已有 Billing Admin API；该操作只恢复 Phone 登录状态：

```http
PATCH /gateway/admin/billing/v1/phone-auth-identities/<subject-id>
Authorization: Bearer <billing-admin-token>
Content-Type: application/json

{"state":"active"}
```

现有 chat entitlement 明确为 `paused` 时，必须显式选择该 entitlement；不要猜测 Plan，
也不要新增权益：

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- entitlement resume <entitlement-id>
python scripts/manage-r760-gateway-control.py -- entitlement resume <entitlement-id>
```

控制脚本对每次 CLI 写入执行只读预检、在线 SQLite 备份、写入、完整性/FK 检查和复验；
Phone identity PATCH 走既有 Billing 审计。每个动作保持独立、结果可见，不把多次写入声称为
一个原子恢复。不得清零用量、创建新 Plan/entitlement 或复活 revoked/expired Key；Key bundle
不健康时必须停止，使用受控 Billing Key rotation 流程，不能用临时扩权绕过。

## 系统性故障回退

如果 beta.76 的手机登录出现系统性故障，先保留数据库和全部用户权益，回退到前一份
受保护配置并只 recreate Gateway。紧急兼容可临时恢复 `auth_only`；这会重新允许旧 Key
业务路径，因此必须记录批准、开始时间和恢复 `medevidence_all` 的截止时间。不得通过
停用真实 Subject、撤销真实 Key、改变 Plan/entitlement 或恢复旧数据库来回退版本门禁。
