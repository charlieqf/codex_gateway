# 生图固定首选模型与排队容量发布回执

2026-09-29，代码 `752221dc900651757fcf00b312a2f27762ded656` 已提交并推送至 `origin/main`。star pool/broker 于 **05:19:58 UTC** 完成升级，R760 Gateway 于 **05:20:41 UTC（北京时间 13:20:41）** 完成切换。后续文档提交不改变运行制品版本。

## 生效内容

- 公网生图继续使用 `medcode-image-default`，实际首选为本地 `qwen-image-2.1`。运行容器解析得到后备列表为空；生产显式设置 `MEDCODE_IMAGE_FALLBACK_ENABLED=0`，保留原有后备密钥。
- 现有 FIFO 保留两个执行名额、十个等待名额，总在途容量 12；pool health 返回 `queue_capacity=10`，broker 同步使用新容量与期限校验。CT 优先、共享资源锁、温度准入和 11264 MiB 主机内存预留保持原值，不能保证始终有两张 GPU 可执行。
- 排队 600 秒、pool 总期限 780 秒、实际执行最多 180 秒；Qwen 请求 790 秒、Gateway 生图总预算 810 秒。Gateway 停止宽限 910 秒，pool systemd 停止宽限 810 秒。
- Gateway 生产环境差异仅三项：关闭回退、Qwen 等待 790000 毫秒、生图请求总预算 810000 毫秒。Nginx、端口、其他项目容器不变；现有 Nginx 读写超时 3600 秒，无须修改。

## 制品、备份与验证

- Gateway 镜像：`sha256:11a1774097c65e26097c46a73b8dccbae62f9f0729d2d54f56e5064de2fdbc86`。从已提交的不可变版本构建，构建内测试 **1711 通过、4 跳过**（93 个测试文件通过、2 个跳过）。star 对同一提交的 Linux 测试 **56 项全通过**。
- Gateway `previous` 保留 `b03a0c5633b5ad867c1f820b89d6a5e3ef2538ac`。发布元数据、配置原件、构建日志及探针保存在 R760 `/opt/codex-gateway-r760/backups/release-752221dc9006/`；发布前数据库备份为 `/data/backups/codex-gateway-daily/20260929T050828Z`。这些受保护文件可能包含凭据，不应公开。
- star 备份 `/data/apps/star-gpu-scheduler/backups/image-752221dc9006-v2/` 保留旧 wheel、unit、配置和 SQLite 备份。三个 Python 环境安装包均与候选源码逐文件哈希一致。两个 Qwen worker、RADAR、IndexTTS 的 PID 与发布前一致；仅 pool/broker 重启。
- 切换后连续两次公网健康 200、ready、非 draining。05:28 UTC 复核 Gateway、pool、broker 正常，重启计数均为 0；Gateway、client-events、scheduler、RADAR 四库 quick_check 均为 ok，外键错误均为 0。

## 维护过程与边界

首次 star 切换遇到现有 systemd unit 为 0444，只读文件原地写入失败，自动回滚也在恢复 unit 时被同一问题阻断。随后恢复旧 pool/broker 并开放 Gateway，确认旧服务 ready；将操作脚本改为在 unit 目录内原子替换、保留原权限，再次受控排空后完成升级。worker、RADAR 和 IndexTTS 全程未重启。后续遇到只读 unit 应在维护前验证替换方法，不应在停止服务后才尝试原地覆盖。

Nginx 的 05:15:00–05:20:42 UTC 统计窗口记录 **14 次 503**，涉及登录/刷新、凭据、诊断和管理 Plan 请求，不能描述为零中断；这一统计不是受影响用户数。切换后至 05:28 UTC 未观察到该公网日志中的 5xx。

公网自测 **159 项检查通过**：真实 Qwen 生图、JSON/SSE 文本调用、原响应恢复、同 ID 去重且仅结算一次、查询限流与新请求隔离、诊断去重、R2 上传/读取/删除。文本两次实际路由为天宽，不据此宣称腾讯也完成了本次实调。合成账号已禁用、凭据全部撤销、临时月付权益已取消，未完成 token reservation 为 0。

真实生图 `req-4a77de3b-3d46-4eda-97a2-110098241bc7` 耗时 **63.083 秒**，返回 JPEG 15294 字节，事件记录为 `qwen-image / qwen-image-2.1 / ok`。人工查看本张图片，“心脏、肺、肝脏”三个中文标签可读且与提示一致；这一简单样本不代表复杂文字质量全面验收。图片作为合成测试证据保存在受保护发布备份及本地 review-artifacts，容器临时图片已删除；05:32:24 UTC 再次确认公网 ready。

此前两次验收脚本请求分别被 Free 套餐权限（403）和不支持的 `quality=medium`（400）拒绝，均未调用图片模型；这是测试夹具错误，不计为模型故障。两次合成账号均已禁用并撤销凭据，第二次临时月付权益已取消。

本次未在生产提交 13 个真实 GPU 任务做压力测试，也未完成客户端 15 分钟端到端等待验收。并发边界由离线集成测试和生产配置共同验证。固定模型可以避免自动换模型带来的质量变化，不能保证模型永不生成错字。

客户端需按 [通知](../outbox/image-primary-queue-client-notice-2026-09-29.zh-CN.md) 将生图等待调整至至少 900 秒、限制本机在途数量、避免结果不确定后的自动重发。通知供用户转发，未代发消息。
