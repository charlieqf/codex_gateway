# Research 简报可靠性修复发布回执

Research Worker 已于 **2026-10-24 21:13:09 UTC（北京时间 10-25 05:13:09）** 完成更新，21:17:21 UTC 最终复核通过。

## 发布内容

- 提交：`9db1efa7329287903e09f0d87232d050a2805453`，已推送 main，从干净提交归档构建。
- Worker 镜像：`codex-gateway-research-worker:9db1efa7329287903e09f0d87232d050a2805453`；镜像 ID：`sha256:6625798621435b5b58f511d579fa9d61f97b71a5e88f31ae01b6d2313171a003`。
- 医学问题的学术性及维度覆盖交由编辑按语义审核；六次简报调用中预留两次用于审核及一次有界格式修复；读取持久化总预算，细分契约失败、证据不足和预算不足。引用校验及明确批准要求继续保留。详见[修复说明](./research-profile-reliability-fix-2026-10-24.zh-CN.md)。
- 本次只重建 Research Worker。公网 Gateway 保持 `954eb3bedca6648405fa419d232cdb4a43dbe8fc`；maintenance、私有 LLM Gateway 也未重建。未增加数据库迁移，未改变用户套餐及额度，历史六条失败任务未改写或重新排队。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 干净 Linux 构建及全量测试 | 108 个测试文件通过；2,093 项测试通过、4 项跳过 |
| 部署后故障回归 | 在实际 Worker 内执行 8 项脚本化检查，全部通过 |
| 医学问题误拦 | 原误拦的五个专业问题原样进入语义审核 |
| 最终审核格式错误 | 根对象后附加字段、代码块后附加说明，均由预留第六次调用完成修复 |
| 负例及恢复边界 | 多份 JSON、缺少批准、虚构引用仍拒绝；恢复 checkpoint 不重置重试次数；总预算不足不发起新作者调用 |
| 公网真实任务 | 翟一帆／亚盛医药／淋巴瘤／省略科室，145 秒成功，共 8 次模型调用，阶段记录无调用错误 |
| 幂等行为 | 同键补传 `department:null` 返回同一任务；同键修改主题返回 409 |
| 结果交付 | 五组问答；人物简介、综述、问题、问答四份文件均通过公网下载、字节数与 SHA-256 校验 |
| 服务状态 | 四个容器均 healthy，RestartCount=0，无 OOM；Worker 心跳 ready |
| 公网健康 | 切换后及最终检查均连续两次 HTTP 200、ready、draining=false |
| 数据完整性 | 13 个运行目录数据库及 6 个保留备份快照 quick_check=ok、外键异常 0；测试清理后 Research 再次校验通过 |
| 发布后日志 | 截至最终复核，Gateway、Worker、私有 LLM Gateway 的结构化日志没有 warning/error；没有活动 Research 任务 |

公网任务 ID：`drr_e81a42814b47446faa1276dea42c069c`。结果为 `passed_with_warnings`，提示 `practical_profile_scope_limited`。本次证明真实生成和交付链路可用，未对生成内容作独立医学事实核查，也不能以单次成功推算自然流量成功率。

首次自测脚本遗漏客户端版本头，被现有兼容性检查以 426 拒绝，未创建 Research 任务；补齐客户端版本头后完整自测通过。两个临时账户均已停用、凭证撤销、权益取消、临时套餐停用；公网再次使用已撤销凭证返回 401，未留下未结算预留。

## 发布保护及清理

发布前核对 main 包含公网 Gateway `954eb3b` 和旧 Worker `088f11a`。旧 Worker 的 165 个源码文件与其不可变发布目录一致，依赖锁文件未变。Worker 专用 Dockerfile 固定旧镜像 ID 作为依赖基底，并从本次完整构建复制 Worker 及 packages，完成模块加载验证。

- Gateway 数据备份：`/data/backups/codex-gateway-daily/20261024T210754Z`，约 2.57 GB。
- 发布准备记录：`/opt/codex-gateway-r760/backups/release-9db1efa73292`。
- Worker 部署记录、原覆盖配置、Research 数据备份：`/opt/codex-gateway-r760/backups/research-worker-9db1efa73292`。另保存测试清理前的 Research 备份。
- 等待没有未完成 Research 任务后，仅切换 Worker 镜像和版本标记。17 个受保护配置／密钥文件的哈希、权限及属主保持一致；挂载、端口、其余三个容器 ID 均保持一致。未触发回滚。
- `current` 仍指向 Gateway `954eb3b`，`previous` 仍为 `25e021f`。Worker 的 Compose 工作目录指向本次不可变发布目录；如需回退 Worker，应使用其专用备份恢复覆盖配置及旧 Worker，不能直接把公网 Gateway 的 current 当作 Worker 版本。
- 成功测试任务已过期处理，四个测试文件及对应结果、来源、引用和 checkpoint 已清理；任务、阶段、预算及审计记录保留。未推进全局 TTL，未清理其他用户任务。

脱敏自测摘要见[发布证据](./evidence/research-profile-release-2026-10-25.json)。完整操作回执位于本地 `.task-artifacts/research-release-20261025/`，不包含凭证；服务器受保护部署记录不得原样对外转发。
