# R760 部署对齐 main `0bfb985`（模型 JSON 统一 + 文档修正）

2026-09-12 02:38:34 UTC（北京时间 10:38:34、悉尼时间 12:38:34）上线。

## 发布范围

- 部署提交：`0bfb98589bb90ef2315e3321866d12bd21ab6fcf`（远端 `main` 头，已推送）。
- previous：`45465ee13ebf7b629e24821385b5bc064b6423f2`（免费额度一次性化发布）。
- 代码差异（`45465ee..0bfb985`）：gateway/core/store-sqlite 运行时零改动；变更为
  research-agent 的模型 JSON 解析统一（新增 `model-json.ts`，四个 agent 统一引用）、
  付费/免费配额文档修正、评审记录与发布脚本。schema 仍为 30，无数据库迁移。
- 镜像：`codex-gateway-research-practical:0bfb985…`（`sha256:d54c3176bebdc36d4ff95cd6cc83b0d196369f233b80ac6a38042b3d0c8f339c`）。
  先以 `deploy/r760-phone-signup.Dockerfile` 从固定提交全量构建
  （`codex_gateway_r760-gateway:0bfb985…`，verify 阶段 576 + 28 项测试、编译路由冒烟通过），
  再以 `deploy/r760-research-practical.Dockerfile` 叠加 gateway/worker/core/store-sqlite/research-agent
  的 dist 层。源码归档 SHA-256：`6577575ef3f6b1c9bfc3bd85f4a882e94826a98c639291ebf307479c19278f73`。
- 执行入口：`scripts/ops/deploy-research-practical-r760.py` 的 `prepare` / `activate`
  （沿用实用资料发布模式：配置指纹校验、无未结算任务、三库在线备份、单事务切换、
  双服务 `--force-recreate --wait`）。

## 部署验证

- prepare 输出 `configuration_valid: true`（含私有 Research LLM Gateway 凭据预检）。
- 镜像内冒烟：`model-json` 模块解析 fence JSON、strict 变体抛错、worker runtime 可导入。
- 切换后 Gateway 与 Research Worker 均运行新镜像、healthy、重启 0；revision 标签均为
  `0bfb985…`；`RESEARCH_WORKER_VERSION=research-practical-0bfb98589bb9`。
  research-llm-gateway、research-maintenance、mihomo、qwen 容器未动且健康。
- 公网 health=ready；三库 `quick_check=ok`、外键违规 0；未结算 research 任务 0。
- Gateway 日志仅一条启动时已知的 `codex-home/sessions` ENOENT 告警（旧容器同样存在，非本次引入）。
- 公网业务冒烟（`billing-quota-review-public-smoke.mjs`，合成账户，全部 19 项检查通过）：
  开户/resolve/月付购买/进行中重置 409/真实模型调用（399 token 全部计入一次性 Free）/默认取消
  未来续费保留/年付日 6M 月 200M/管理页 HTML/清理停用吊销全绿，断言 `passed`。

## 备份与证据

- 备份目录：`/opt/codex-gateway-r760/backups/research-practical-0bfb98589bb9`
  （gateway.db 306,913,280 字节、client-events.db 1,357,275,136 字节、research.db 24,268,800 字节，
  均已验证完整性；deployment.json、proposed.override.yml、activation.json）。
- staging 目录：`/opt/codex-gateway-r760/staging/0bfb985…`（源码、build.log、agent-verify.log、
  overlay-build.log、research-release-build.json）。
- 合成冒烟账户 `subj_i2Rlz9m4fg_xC2k6dUQ-EvbS` 已停用，凭据全部吊销，未结算预留为零。

## 备注

- 本次变更对 Doctor Research 工作流是行为中性重构（解析容错统一），不需要重新验收
  研究质量；如后续出现解析类回归，优先检查 `model-json.ts` 的 fence 策略。
- 遗留事项不变：`docs/outbox/medevidence-free-once-quota-contract-2026-09-11.zh-CN.md`
  待发送 MedEvidence；runtime-key 防护仍为工作区 WIP，等待 v2 认证兼容恢复后再评估。
