# Research 简报 120 秒预算发布与翟一帆任务调查

2026-10-12 06:24:31 UTC（北京时间 14:24:31）完成 Research Worker 独立发布，06:24:55 UTC 复核通过。提交：`cdd6a693d97d85716e1ef95059ac41ed4cba2176`，来自已推送的 main。

## 改动及边界

`collectPracticalProfile` 的生成和校验单次预算由 90 秒改为 120 秒。既有收尾预留仍为 10 秒，因此传给私有模型网关的 `x-medcode-request-timeout-ms` 从 80000 改为 110000。整项 Research 的 570 秒硬限时、身份核验预算和真实性规则保持不变。

Worker 镜像为 `codex-gateway-research-worker:cdd6a693d97d85716e1ef95059ac41ed4cba2176`，镜像 ID 为 `sha256:1d43d3230e307ec924b6d0e746ffbd49136e9eeb21e6cc7d96a7757e4f8f122a`；版本标识 `research-timeout-cdd6a693d97d`。公网 Gateway/current 仍为 `c69e3ed38aacd2020744a1fa0fda870a4b5578ca`。模型网关、maintenance 及公网 Gateway 容器 ID 未改变。

## 失败原因与恢复结果

以下时间为北京时间，输入均为翟一帆／亚盛医药／淋巴瘤内科，brief 模式。

| 提交时间 | run_id | 结果 |
| --- | --- | --- |
| 13:22:37 | `drr_02cef39fca5a4df18f2a4128717c1e78` | 身份核验用完 8 次模型调用，`resource_budget_exceeded` |
| 13:37:18 | `drr_ec806e83be8444cb876ec8389de97b87` | 生成综述连续两次在 80 秒终止，13:41:23 报 `upstream_unavailable` |
| 13:47:10 | `drr_73454dab9d5a4585a920d30b32da6c33` | 13:51:48 成功，四份产物存在，大小与 SHA-256 全部匹配 |

超时请求为 `req-444d9851-7b25-43af-b378-d17dab9f2880` 和 `req-1edefb6e-f02f-4c44-b5bd-73e6a68711f8`。私有 Research LLM Gateway 记录 Tencent `glm-5.3` 返回 HTTP 200，首字节分别约 4.3 秒、2.9 秒，最后数据分别在 79.979 秒、79.931 秒；Gateway 在约 80 秒以 `deadline_exceeded / streaming` 终止并返回 504。第二次另有约 30.4 秒准入等待。该错误来自单次执行预算，不能据此认定模型服务未响应。

截至调查时，10 月 5 日以来 brief 模式、6000 output-token 上限的生成/校验调用共 28 次：23 次成功，中位 47.391 秒、P95 67.666 秒、最大 76.108 秒；5 次错误均约 80 秒。这是受旧上限截断的样本，不能证明 110 秒一定足以完成所有失败调用。

## 身份核验问题：待单独优化

第一次运行已读到亚盛医药官方高管页面及官方转载报道，姓名和机构吻合，但审查两次指出“淋巴瘤内科”与企业首席医学官角色不符，要求补充科室任职证据。随后耗尽 8 次模型调用，身份仍未接受。后一次用 5 次模型调用接受了同一姓名和机构，并明确记载科室未核实、角色是首席医学官和肿瘤新药临床开发。

改进应区分任职科室与采访研究方向，对已核实身份和未核实字段给出稳定的处理规则；遇明确冲突应提示更正或补充，避免重复检索后只报预算耗尽。不能仅增加模型调用预算，也不能把肿瘤研发经历当作医院科室任职证据。本次未修改这部分逻辑。

## 发布与验证

- 本地构建通过；Worker/model-client 相关 144 项测试通过，覆盖生成、校验、恢复的 110000 ms 传递。
- 从已提交 Git bundle 在 R760 导出不可变源码，构建一致的全包镜像；Linux 完整测试 99 个文件通过、2 个跳过；1814 项通过、4 项跳过。
- 切换前未完成 Research 任务为 0；检查排空后仍为 0。数据库在线备份校验通过，配置/元数据备份受权限保护，未打印凭证。
- 第一次切换的新 Worker 与合成参数验证通过，但临时发布脚本错误地用字符串包含判断识别 `draining`，将健康响应 `draining:false` 误判为不健康，触发回滚。旧 Worker 镜像及健康状态随后独立核验通过，公网 `ready / draining:false`。修正为布尔值判断，并用 ready/non-draining 与 draining 两种响应验证，第二次切换成功。保留第一次失败证据，不宣称零中断。
- 最终 Worker `healthy`、RestartCount=0、心跳 ready、错误日志计数 0；公网健康在有界轮询内连续两次通过；Research SQLite `quick_check=ok`、外键违规 0。
- 对实际运行镜像验证简报 120000 ms 预算及 10000 ms 收尾预留；合成 model-client 验证请求头 110000；真实私有模型 readiness GET 通过。未生成生产模型调用、未重放用户任务、未创建临时账号/产物。
- 发布前备份：`/opt/codex-gateway-r760/backups/research-worker-cdd6a693d97d-retry1`；首次尝试及构建证据分别保留在同级 `research-worker-cdd6a693d97d`、`release-cdd6a693d97d`。临时传输 bundle 已删除。

验证证明新限制已生效与服务健康；未以真实长耗时模型调用验证超过 80 秒后最终成功，后续应观察自然流量中的超时比例。
