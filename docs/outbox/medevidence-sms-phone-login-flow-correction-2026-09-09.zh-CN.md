# 短信登录后复用 Gateway 手机号登录：修订通知

2026-09-09。用户确认：真实短信登录成功后，Desktop 以同一手机号复用 Gateway phone-auth v1 领取模型 Key，外部 token 留在身份／支付链路；先前外部 token 换 Key 的 v2 候选合同撤回。

随后确认的新用户自动开户、每日 100 万 token 免费权益及手机号登录准备已部署 R760，公网验收通过。当前细节统一见[Gateway 联调说明](./medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md)。

| 登录标签 | 流程 |
| --- | --- |
| 短信登录 | 手机号＋真实验证码 → 身份后端；后台关联／开户 → Desktop 使用手机号 v1 → cgu_live Key |
| 临时登录 | 已登记手机号 → 原 Gateway v1 → 原 cgu_live Key；无外部支付 token |

无需外部 JWT 密钥或 userinfo 校验接口。固定 123456 已取消，自动开户姓名可空，手机号独立保存。旧用户不降级、不重复开户、不重置用量。

外部 token 和 Gateway Phone Session 分开管理。支付使用外部会话，不要求已取得模型 Key。v1 拒绝尚未准备的账户时，客户端保留外部已登录状态并展示模型未就绪，不使用旧 v2 runtime:null 或虚构 Subject。

此前三份文件已更新撤回／修订状态：v2 README 为撤回公告、fixtures.json 为撤回清单，[交付说明](./medevidence-sms-runtime-gateway-development-handoff-2026-09-09.zh-CN.md) 指向本轮联调文档。原 v2 fixture SHA-256 970fdf9b2b9b352da90a3e873647a86b3d676ba0679c7ebf9e1ae90ae8a106e5 仅作历史识别。

正式协议链接、真实短信和支付验收仍由相应团队完成。客户端代码及安装包由客户端团队交付，本轮 Gateway 发布不代表客户端验收已经完成。
