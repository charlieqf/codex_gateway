# MedEvidence 短信运行授权 v2：已撤回

日期：2026-09-09。原合同 ID：medevidence-sms-runtime-v2；状态：**withdrawn**。

用户已确认：身份后端返回短信登录成功后，Desktop 用本次手机号调用既有 Gateway v1 领取模型 Key；外部 access_token 用于身份／支付后端。Gateway 不再增加外部 token 验签或用户信息校验前置。

**停止接入 POST /gateway/auth/v2/runtime/authorize。** 本地候选路由、授权服务、外部 verifier 及相应配置已移除；此 v2 从未在本轮部署。没有保留“只解码未验证 JWT 就发 Key”的分支。

当前接入资料：

- [短信后复用手机号 v1：修订通知](../../outbox/medevidence-sms-phone-login-flow-correction-2026-09-09.zh-CN.md)；
- [既有 R760 手机号 v1 合同](../medevidence-r760-dual-track-phone-auth-v1/README.md)及 [fixture](../medevidence-r760-dual-track-phone-auth-v1/fixtures.json)；
- [修订后的 Gateway 交付说明](../../outbox/medevidence-sms-runtime-gateway-development-handoff-2026-09-09.zh-CN.md)。

本目录的 [fixtures.json](./fixtures.json) 现为撤回清单；此前内容保存在 [fixtures.withdrawn-2026-09-09.json](./fixtures.withdrawn-2026-09-09.json)，仅供识别旧交付。原说明与摘要分别为 README.withdrawn-2026-09-09.md、SHA256SUMS.withdrawn-2026-09-09。当前目录入口的摘要在 [SHA256SUMS](./SHA256SUMS)。

正式用户协议和隐私政策链接仍需产品提供，与本次接口方案撤回分开处理。
