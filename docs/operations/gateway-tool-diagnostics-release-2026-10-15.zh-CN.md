# 工具参数诊断增强发布记录

Gateway 已于北京时间 2026-10-15 08:04:02 部署 `3d2d4e046a53e39d336caa5c797a072104cdf041`，08:04:22 完成部署后核验。代码已推送 main；从已提交版本的干净归档构建，只替换 Gateway。

## 生效范围

- 工具参数校验失败时，在既有 upstream attempt JSON 中保留工具名、输入字节数、JSON 语法错误位置或 schema 校验问题。最多保存 8 条校验问题，字符串有长度上限。
- 新增诊断不保存参数正文、解析器原始错误片段或可能包含用户字典键的 instancePath；不扩展公共错误响应字段。
- 自动补 format 的实验分支、2,048 tokens 特殊预算和专用恢复分支已在提交前撤除。重试、渠道路由、超时、计费及原有错误消息保持不变。数据库 schema 仍为 41。
- 此次属于诊断增强，未证明能降低长尾延迟或提高工具调用成功率。解析器不提供错误位置时，offset 为 null。

## 验证

本地构建和 69 项相关测试通过。干净 Linux 全量测试：1,867 项通过、4 项跳过。集成测试覆盖 JSON/SSE 恢复行为不变、两次尝试的诊断归属与计费、动态字典键不进入新增诊断以及诊断大小上限。

候选镜像及已部署容器内均执行了编译产物自测：缺失字段、JSON 错误位置、敏感字典键排除、公共错误序列化及内存 SQLite 逐次保存均通过。该自测没有调用付费上游，没有写生产数据库，也没有创建测试账户。没有在线诱导真实模型生成错误参数；真实恢复流程由隔离的 HTTP 集成测试验证。

公网限时探针连续两次 HTTP 200 / ready，Windows 外部复查亦为 ready、非 draining。容器 healthy，RestartCount=0；六个数据库 quick_check=ok、外键违规数为 0。核验日志 warn/error/fatal 均为 0。环境变量、8 个受保护输入文件、端口及其余 Compose 服务容器身份均保持不变。

## 发布与恢复依据

前版本 `94b60aec5974e0aafadf0aeeba05fe045b745da2` 已确认为本次版本祖先。镜像为 `sha256:6cc803519cd000082a7129b4ef12a21084528f3680caf8e63ea26f232d4a587a`；current 指向新版本，previous 指向该前版本。

数据库备份：`/data/backups/codex-gateway-daily/20261014T235755Z`。旧配置、受保护输入备份及恢复材料：`/opt/codex-gateway-r760/backups/release-3d2d4e046a53/`，含凭据的材料仅保存在服务器受保护目录。

切换使用部署锁、请求排空、固定镜像和受控回滚流程。00:03:44.117 至 00:04:02.557 UTC 的约 18.4 秒包含排空、替换与验证，不等同于精确中断时长。没有发生回滚。首次构建命令因旧版 Docker 不支持 `--progress` 而退出；移除该显示参数后构建成功，未变更 Docker 配置。

## 脱敏证据

- [构建与全量测试](../../artifacts/gateway-tool-diagnostics-release-20261015/build-summary.json)
- [切换结果](../../artifacts/gateway-tool-diagnostics-release-20261015/cutover-summary.json)
- [公网收敛](../../artifacts/gateway-tool-diagnostics-release-20261015/cutover-public-health.json)
- [部署产物诊断自测](../../artifacts/gateway-tool-diagnostics-release-20261015/deployed-smoke.json)
- [环境、健康及数据库核验](../../artifacts/gateway-tool-diagnostics-release-20261015/final-verification.json)
