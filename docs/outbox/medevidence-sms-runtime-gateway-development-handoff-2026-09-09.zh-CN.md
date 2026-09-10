# MedEvidence 短信登录：Gateway 交付说明

2026-09-10，修订 5。沿用兼容 5 月原样开户、resolve 可选的接口。新开户默认免费权益临时调整为每日 1 万 token（`plan_free_daily_10k_v1`）；此前已发放的每日 100 万 token 和其他既有权益不变。直接提供 phone 或可选两步流程均支持新用户免费权益及 Phone identity。发布状态见 Gateway 当前运行状态和本轮上线记录。

完整合同、示例、错误和重试规则统一维护在[Gateway 联调说明](./medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md)，以该文档为准。

当前流程：Desktop 完成身份后端短信登录，再复用 Gateway 手机号 v1 领取模型 Key；外部 token 仅用于身份／支付后端。临时登录仍使用相同 v1，面向已登记账户。

此前发出的 medevidence-sms-runtime-v2 合同、fixture 和旧交付说明已撤回。Gateway 从未部署过该 v2 路由，当前代码不包含外部 token verifier 或 GATEWAY_EXTERNAL_AUTH_* 接入要求；归档仅供历史识别。

兼容修订取消 subjects/resolve 强制前置：5 月原样 POST /subjects 继续按旧 Billing 规则开户；传可选 phone 时，由 Gateway 内部关联或创建手机号账户，准备 Key、免费权益及手机号身份。可选的 resolve → subjects 流程继续支持。旧账户保留原 Subject、姓名、Key 和权益。

本地与 Linux 镜像内类型检查和 344 项测试通过。公网地址仍为 https://goldencode.instmarket.com.au:1443，见[兼容修订上线记录](../operations/r760-billing-create-compatibility-release-2026-09-09.zh-CN.md)。

客户端需按 SMS→v1 重新验证，并移除 v2 授权及支付前必须已有模型 Key／subjectId 的前提。原客户端 65 项测试不代表本轮真实联调完成。身份后端手机号开户可直接发送 phone 字段，resolve 为可选。产品仍需提供正式协议链接，真实短信和支付验收由相关团队共同完成。
