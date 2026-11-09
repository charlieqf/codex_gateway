# 医学采访字幕服务：待上线变更

本方案尚未执行生产部署。用户已明确批准上线字幕服务并继续安装版验收；随后要求清理跟随当前对话的 `goldencode` 或 `goldencode-d`。先完成该修正的测试，再按既有授权仅切换 Gateway。

## 已准备的变更

- 在现有 Gateway 增加 `/gateway/subtitles/v1/transcriptions` 的提交/查询，以及 `/gateway/subtitles/v1/clean`。
- 复用现有登录凭据和 subject 归属校验；字幕入口暂不计额度，不改变模型、Research、影像等业务。
- 转写由腾讯 ASR 承担；医学清理由固定提示词和有限批次调用当前对话选择的 `goldencode` 或 `goldencode-d`。复用现有公开模型注册表、服务商适配器和账号池，不增加独立清理模型配置。凭据原有模型访问权限继续生效。
- 任务结果以原子 JSON 保存在现有数据卷的字幕子目录；重启继续查询同一任务。没有数据库 schema 变更。
- ASR 不确定提交状态不自动重复提交；过期任务不再次查询可能被复用的厂商 ID。

## 部署输入

| 设置 | 计划值 |
| --- | --- |
| `CODEX_SUBTITLE_STORAGE` | `/var/lib/codex-gateway/subtitles` |
| `CODEX_SUBTITLE_TENCENT_SECRET_ID_FILE` | 新增只读 secret 文件的容器路径 |
| `CODEX_SUBTITLE_TENCENT_SECRET_KEY_FILE` | 新增只读 secret 文件的容器路径 |

腾讯凭据使用字幕工具负责人已提供并通过真实转写验证的账号，在服务器以受保护文件交付，不放入安装包、源码、对话或日志。新增子目录沿用现有 Gateway 数据卷。公网域名、端口、Nginx、防火墙、数据库和其他容器均不变。

## 验证与切换

2026-11-09已核对：线上 revision 为 `ac35987b61bfc0e66c74d3fa6fb256e6302cb148`，本地 `main` 的 `f42d3e6` 包含它且与已 fetch 的 `origin/main` 一致。只提交本次 `apps/gateway/src/subtitles/*`、两处接入文件和本文，保留所有无关脏文件。

初版 `d38e941` 的类型检查、完整容器测试及真实腾讯/内网模型预检已通过，但未切换生产。按用户要求修正后的版本重新验证两种云端模型；初版清理结果不作为新模型的验收证据。正式切换必须使用提交后的不可变归档；先在隔离容器核对路由、身份、重复提交、模型选择、无字幕额度预留、旧接口和既有数据访问。

按照 `docs/operations/container-deploy.md` 备份受影响配置、记录 current/previous，等待自然空闲，再仅重建 Gateway。单实例切换可能短暂中断现有请求，不宣称零停机。用60秒有界轮询要求公网连续两次健康，并核对真实镜像 revision、重启/OOM、日志和旧业务 smoke。

失败时恢复旧配置和旧 Gateway 镜像。旧程序不会使用新增字幕子目录；保留字幕任务数据，不删用户产物。成功后使用安装版登录、上传医学采访、自然语言触发、双 SRT 对照、对话微调、再次审定和烧录完成最终验收。
