# Azure Ubuntu VM 容器化部署草案

MVP 部署目标是一台 Azure Ubuntu VM，单实例运行 Gateway。默认采用 Docker Compose 容器化部署；systemd 只负责拉起 compose。高可用、多实例、外置状态属于 v2+。

若目标 VM 已有重要服务，必须先按“非侵入测试模式”执行：[safe-vm-testing.md](./safe-vm-testing.md)

## 推荐拓扑

```text
Internet
  -> Azure NSG 80/443
  -> existing production services

SSH tunnel for test
  -> 127.0.0.1:18787 on VM
  -> gateway container :8787
  -> gateway_state volume
      /var/lib/codex-gateway/gateway.db
      /var/lib/codex-gateway/codex-home
```

## VM 基线

- Ubuntu 24.04 LTS。
- 2 vCPU / 4 GB RAM 起步；Phase 0 可更小，MVP 小圈子建议至少 4 GB。
- OS disk 开启加密。
- NSG 只开放 `22`、`80`、`443`；Gateway 默认只绑定 VM 本机 `127.0.0.1:18787`。
- DNS A 记录指向 VM 公网 IP。

## 为什么容器优先

容器部署更适合 MVP：

- Codex CLI、Node、npm 版本被镜像固定，Azure VM 只需要 Docker。
- Gateway 升级回滚是镜像/compose 级操作。
- 默认测试不启动 Caddy，不接管 80/443。
- 如后续确认 80/443 可接入，再显式启用 `edge` profile 启动 Caddy。
- SQLite 和 `CODEX_HOME` 使用 named volume 持久化，容器重建不丢状态。

风险：

- ChatGPT 登录流程可能需要在容器里用 device-code 或一次性 shell 完成。
- 若 Codex 需要 OS keyring，容器内可能退回文件型 auth cache；该 volume 必须按敏感凭据处理。

## VM 初始化

若 Docker 已安装，把仓库部署到独立目录。已有重要服务的 VM 建议先用测试目录：

```bash
sudo mkdir -p /opt/codex-gateway-test
sudo chown "$USER:$USER" /opt/codex-gateway-test
git clone https://github.com/charlieqf/codex_gateway /opt/codex-gateway-test
cd /opt/codex-gateway-test
cp config/gateway.container.example.env config/gateway.container.env
```

如果 Docker 未安装，不要在共享 VM 上直接安装；先按 [safe-vm-testing.md](./safe-vm-testing.md) 的原生 Node smoke test 验证。

编辑 `config/gateway.container.env`：

```bash
GATEWAY_DOMAIN=gateway.example.com
GATEWAY_PUBLIC_BASE_URL=https://gateway.example.com
```

然后把 `compose.azure.yml` 的 `env_file` 指向实际 env 文件，或在服务器上用同名文件覆盖 example。

## 启动

```bash
docker compose -p codex_gateway_test -f compose.azure.yml build gateway
docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
docker compose -p codex_gateway_test -f compose.azure.yml ps
```

健康检查：

```bash
curl -fsS http://127.0.0.1:18787/gateway/health
```

从本机访问时使用 SSH tunnel：

```bash
ssh -L 18787:127.0.0.1:18787 user@vm-host
curl -fsS http://127.0.0.1:18787/gateway/health
```

## ChatGPT/Codex 登录

登录必须在 gateway container 的持久化 `CODEX_HOME` 下完成。

```bash
docker compose -p codex_gateway_test -f compose.azure.yml exec gateway codex
```

如果浏览器 callback 在 VM 上不可用，Phase 0 优先验证 Codex device-code flow 或 App Server login flow。

完成登录后确认：

- 登录态位于 `gateway_state` volume 中。
- 不把 `auth.json`、token、浏览器 cookie 放进仓库。
- Gateway 客户端配置只包含 gateway URL 和 access credential。

## systemd 管理 compose

安装 unit：

```bash
sudo cp ops/systemd/codex-gateway-compose.service /etc/systemd/system/codex-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-gateway.service
sudo systemctl status codex-gateway.service
```

## TLS 反代

`compose.azure.yml` 中 Caddy 被放在 `edge` profile 下，默认不会启动。只有确认不会影响现有 80/443 服务后，才能显式启用：

```bash
docker compose -p codex_gateway -f compose.azure.yml --profile edge up -d caddy
```

Caddyfile：

```text
{$GATEWAY_DOMAIN} {
  encode zstd gzip
  reverse_proxy gateway:8787 {
    flush_interval -1
  }
}
```

Caddy 自动申请和续期证书。若改用 Nginx，必须确认：

- WebSocket/SSE 不被缓冲。
- `Authorization` header 原样转发。
- access log 不记录完整 credential。

## 备份

最小备份对象：

- Docker volume `codex-gateway_gateway_state` 中的 `gateway.db`。
- `config/gateway.container.env`。
- 不默认备份 Codex 原始登录态；若备份 `codex-home`，必须加密并限制访问。

示例：

```bash
docker run --rm \
  -v codex_gateway_test_gateway_state:/data:ro \
  -v "$PWD/backups:/backup" \
  busybox tar czf /backup/gateway-state-$(date +%Y%m%d-%H%M%S).tgz /data
```

## 原生 systemd Node 部署

如容器内 ChatGPT 登录无法稳定跑通，可退回原生部署：

```bash
sudo useradd --system --create-home --home-dir /var/lib/codex-gateway --shell /usr/sbin/nologin codexgw
sudo mkdir -p /opt/codex-gateway /etc/codex-gateway /var/log/codex-gateway
sudo mkdir -p /var/lib/codex-gateway/codex-home
```

对应 service 草案：

```ini
[Unit]
Description=Codex Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codexgw
Group=codexgw
WorkingDirectory=/opt/codex-gateway
EnvironmentFile=/etc/codex-gateway/gateway.env
Environment=CODEX_HOME=/var/lib/codex-gateway/codex-home
ExecStart=/usr/bin/npm --workspace @codex-gateway/gateway run start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/codex-gateway /var/log/codex-gateway

[Install]
WantedBy=multi-user.target
```
