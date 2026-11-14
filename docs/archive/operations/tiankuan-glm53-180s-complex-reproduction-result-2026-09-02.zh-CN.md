# 天宽 GLM-5.3 约180秒断流受控复现结果

- 执行时间：2026-09-02 10:09–10:12（Australia/Sydney）
- UTC开始时间：2026-09-02T00:09:09.341Z
- 被测平台：天宽 `official/glm-5.3`
- 路径：R760直连天宽OpenAI兼容接口，不经过公共Gateway池和腾讯回退
- 结果：一条复杂长任务受控复现约180秒流不完整故障。本报告提供一例可核查的
  复现证据，不声称每次相同请求都会失败。

## 1. 测试参数

测试使用确定性生成的纯合成依赖图和部署优化任务，不包含生产数据或用户内容。
任务要求模型完成依赖闭包、最优部署波次、容量、故障域、冻结、风险和校验和的
全量交叉验证，然后返回一个完整JSON审计报告。

| 参数 | 值 |
| --- | --- |
| prompt字符数 | 65,000 |
| `reasoning_effort` | `high` |
| `stream` | `true` |
| `max_tokens` | 64,000 |
| 客户端观察上限 | 210,000 ms |
| 请求数 | 1 |

复现程序为
[`scripts/probe-glm53-tiankuan-complex-repro.mjs`](../../../scripts/probe-glm53-tiankuan-complex-repro.mjs)。
程序只输出协议指标和响应哈希，不打印提示词、密钥、推理内容或正文。

固定请求指纹：

- prompt SHA-256：`c3e90581986b5ddc3a9881197f32f73ad11b299805e91ce3a76a50d206f5dc9f`；
- request body SHA-256：`34a706cc39884f7de87f3de1a861be9431fe9d5de2d38f7bada76a4a660037e0`。

运行要求为Node.js 18或更高版本。先免费核对请求指纹：

```bash
node scripts/probe-glm53-tiankuan-complex-repro.mjs --describe
```

然后使用测试Key运行并保留JSONL输出：

```bash
MEDCODE_TIANKUAN_API_KEY="<测试Key>" \
  node scripts/probe-glm53-tiankuan-complex-repro.mjs --execute \
  | tee tiankuan-repro-result.jsonl
```

脚本默认在210秒停止客户端观察；可通过`TIANKUAN_REPRO_TIMEOUT_MS`调整。密钥只从
环境变量读取，不会进入输出。

## 2. 实测结果

| 指标 | 结果 |
| --- | ---: |
| HTTP状态 | 200 |
| 响应头 | 1,762 ms |
| 首原始SSE数据 | 1,764 ms |
| 首推理增量 | 1,764 ms |
| 首可见正文 | 未出现 |
| 最后原始SSE数据 | 180,435 ms |
| 请求结束 | 180,576 ms |
| 原始响应字符 | 713,255 |
| 推理字符 | 36,406 |
| 可见正文字符 | 0 |
| `finish_reason` | 缺失 |
| `[DONE]` | 缺失 |
| usage | 缺失 |
| 客户端超时 | 未触发 |
| 响应SHA-256 | `8ac26e00ea38ddcbebc0c2c200f52c64264c0cd114adc98d76947f86607f756eb` |

第一次运行的连接在约180.58秒由上游结束，探针随后将其分类为
`eof_before_terminal`。该协议形态与Gateway中的
`upstream_incomplete_stream` 相同：HTTP 200，但流在没有正文和正常结束事件时关闭。

本次客服交付使用的结构化结果见
[`tiankuan-glm53-180s-customer-reproduction-result-2026-09-02.json`](./tiankuan-glm53-180s-customer-reproduction-result-2026-09-02.json)。

## 3. 结论

1. 约180秒断流已经由纯合成复杂任务受控复现，不再只是生产观察。该结果证明问题
   可以发生，但不用于推断每次请求的失败概率。
2. 不是客户端210秒超时，因为上游在180.58秒先结束；也不是公共Gateway超时，
   因为本次直连天宽。
3. 不是首字节超时或传统空闲读超时：响应头和推理SSE在1.8秒内到达，随后累计收到
   大量推理数据，最后一段原始SSE位于约180.44秒。
4. 现有证据支持天宽接口链路存在约180秒的请求总时长、流生命周期或模型生成
   时限。具体限制位于天宽前置代理还是其上游模型服务，仍需供应商确认。
5. `max_tokens=64000` 只是请求上限。本次只有36,406个推理字符且没有usage，不能
   证明达到64K token；固定墙钟时间更符合总时限而不是输出token上限。
6. 第一次失败响应没有usage，但请求没有显式设置`stream_options.include_usage`，因此
   “缺少usage”本身不作为协议违规证据。天宽仍需根据服务端计费日志说明该不完整
   请求是否收费以及如何退费。

## 4. 给供应商的复现信息

请天宽按以下条件复测：

- 模型：`official/glm-5.3`；
- OpenAI兼容流式Chat Completions；
- 约65K字符复杂合成输入；
- `reasoning_effort=high`；
- `max_tokens=64000`；
- 服务端在约180秒关闭持续推理中的SSE；
- HTTP 200，但没有可见正文、`finish_reason`、`[DONE]` 或usage。

成功复现开始时间为`2026-09-02T00:09:09.341Z`。常见Trace ID响应头没有返回，
执行时的脚本版本也没有保留SSE payload中的`id`；请天宽按账户、模型和该UTC时间
检索服务端日志。

需要天宽书面确认：请求总时长、模型生成时长和流生命周期限制分别是多少；为何
持续有推理增量仍在约180秒关闭；失败请求是否计费；以及能否提高时限或在到达时限
前返回明确错误和可核对的计费记录。

在限制修复或确认前，长上下文、`high`、64K输出上限的请求不应路由到天宽。
