# Safe VM Testing

用于已有重要服务的 Azure Ubuntu VM。目标是在不影响现有应用的前提下验证 Codex Gateway。

## 硬性规则

- 不绑定 `0.0.0.0:80` 或 `0.0.0.0:443`。
- 不修改 NSG、防火墙、Nginx、Caddy、Apache 或已有 reverse proxy。
- 不重启 Docker daemon、Nginx、Caddy、数据库或业务服务。
- 不运行 `docker compose down`，除非带明确 project name 且只针对本项目。
- 不写入 `/var/www`、`/etc/nginx`、`/etc/caddy`、现有 app 目录。
- 不把 VM 密码、ChatGPT token、Codex `auth.json` 写入仓库或脚本。

## 只读探测清单

首次接入 VM 只运行只读命令：

```bash
hostname
whoami
uname -a
pwd
df -h
free -h
ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker compose ls
systemctl --type=service --state=running --no-pager
```

如任一命令不可用，只记录结果，不安装、不修复。

## 非侵入部署模式

如果 Docker 已安装，使用独立目录、独立 compose project、独立 volume：

```bash
mkdir -p /opt/codex-gateway-test
cd /opt/codex-gateway-test
docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
```

默认端口：

```text
VM 127.0.0.1:18787 -> gateway container 8787
```

本机访问：

```bash
ssh -L 18787:127.0.0.1:18787 user@vm-host
curl http://127.0.0.1:18787/gateway/health
```

## Docker 未安装时

已有重要服务的 VM 上不要为了测试直接安装 Docker。Docker 安装可能改变 iptables/network 行为；必须先确认维护窗口和回滚方案。

短期可使用原生 Node smoke test，只监听本机地址：

```bash
mkdir -p "$HOME/codex-gateway-test"
cd "$HOME/codex-gateway-test"
git clone https://github.com/charlieqf/codex_gateway .
bash ops/scripts/install-user-node.sh
bash ops/scripts/native-smoke.sh
```

另一个 SSH session 用 tunnel 验证：

```bash
ssh -L 18787:127.0.0.1:18787 user@vm-host
curl http://127.0.0.1:18787/gateway/health
```

停止测试只需 `Ctrl+C`，不会注册 systemd service，不会写入现有业务目录。

## Phase 0 Codex Probe

在共享 VM 上只用用户目录做 provider 验证：

```bash
cd "$HOME/codex-gateway-test"
export NODE_HOME="$HOME/.local/codex-gateway-node"
export PATH="$NODE_HOME/bin:$PATH"
export CODEX_HOME="$HOME/codex-gateway-state/codex-home"
mkdir -p "$CODEX_HOME"
chmod 700 "$HOME/codex-gateway-state" "$CODEX_HOME"

npm run probe:codex -- --codex-home "$CODEX_HOME"
```

如果需要登录 ChatGPT/Codex 订阅，使用同一个隔离 `CODEX_HOME`：

```bash
./node_modules/.bin/codex login --device-auth
npm run probe:codex -- --codex-home "$CODEX_HOME" --run
```

这一步不需要监听端口，不需要改 Nginx，不需要 `sudo`。

## 清理测试部署

只停止本项目 gateway，不删除 volume：

```bash
docker compose -p codex_gateway_test -f compose.azure.yml stop gateway
```

确认要删除本项目测试容器和网络：

```bash
docker compose -p codex_gateway_test -f compose.azure.yml rm -f gateway
```

删除 volume 只有在确认不需要保留 SQLite 和 Codex 登录态后才执行：

```bash
docker volume ls | grep codex_gateway_test
docker volume rm codex_gateway_test_gateway_state codex_gateway_test_gateway_logs
```

## 上 80/443 前置条件

必须先确认：

1. 当前 80/443 没有承载重要业务，或已有反代可以安全新增 path/host route。
2. 有 DNS 子域名可以单独指向 Gateway。
3. 已备份现有反代配置。
4. Gateway 已在 SSH tunnel 模式下通过基本验收。
