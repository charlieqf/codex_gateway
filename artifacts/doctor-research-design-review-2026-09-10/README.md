# 身份核验同页人物错配反例

2026-09-10 在去预置工作树的已有构建中执行一次，运行源码冻结点为 `a67d2d3`。这是合成的离线负例，不包含真实医生，不调用搜索、HTTP 抓取或模型；新增 SerpAPI 请求为 0。

输入请求 Alice / 心内科，但来源明确写 Alice / 肾内科、Bob / 心内科。来源使用虚构的 `.edu.cn` 域名。现有逻辑仍返回身份成立，证明窗口关键词共现可能跨人物拼接科室。

- [复现脚本](identity-cross-person-repro.mjs)：从 `.tmp/review-identity-negative.mjs` 原样归档；在内存中暴露两个内部函数，不改动构建文件或运行源码。
- [观察结果](identity-cross-person-observed.json)：将本轮已观察到的控制台 JSON 归档；不是另一次运行结果。
- [构建文件与脚本哈希](provenance.json)：归档时读取已有文件计算。

在对应源码、依赖及构建已经就绪的仓库根目录，可执行：

```powershell
node artifacts/doctor-research-design-review-2026-09-10/identity-cross-person-repro.mjs
```

脚本是诊断复现，不是断言通过的回归测试。修复后应将该输入纳入正式负例，期望 `actual_identity_resolved` 为 false。脚本依赖当前构建中的内部函数名，后续重构时需要调整入口。

边界：此结果证明已有核验函数的关系判断错误，不证明生产用户已经收到错误报告，也不是公网端到端复现。`workflow.ts` 在 `8efd541` 与 `a67d2d3` 之间无差异，但生产构建没有在本轮重新执行该反例。
