# Qwen 生图与编辑接口改进（2026-11-05）

状态：Gateway `749c5086f74919b1abeda9d1357de9145f8e7b0b` 已于 2026-11-04 21:51:20 UTC 部署，公网实际生图和参考图编辑验证通过；Desktop dev 改动尚未发布。生产模型、GPU worker、套餐快照与环境配置未改动。详见[线上发布回执](../archive/operations/qwen-image-editing-release-2026-11-05.zh-CN.md)。

## 功能与约束

- 新增 `1536x512`，严格 3:1。Qwen 返回尺寸必须与请求相同，否则报上游响应错误，不拉伸成目标比例。原有尺寸继续可用。
- 新增一个参考图输入，可用于原始 logo 参考或编辑已生成图片。只接受单帧 PNG/JPEG/WebP，原始文件最多 4 MiB、最多 4,194,304 像素。Gateway 校验完整解码后才提交 GPU；不接收远程 URL。
- Qwen `low/medium/high` 对应 30/40/50 步，省略或 `auto` 保持 40 步。确认上游实际回传步数后返回参数。增加步数表示增加计算量，不保证中文、logo 或布局更准确。
- 初版一次仅一张参考图；不支持同时传入原始 logo 和待编辑横幅。像素级 logo 保真、确定性中文排版、多参考图仍不在此版范围。
- 带参考图或 3:1 请求不会回退到未接通这些能力的云端模型。

## Gateway 合约

认证方式沿用当前 Bearer 凭据。新增 `GET /gateway/images/capabilities`，返回当前账户与实际主提供方共同允许的能力；响应 `Cache-Control: no-store`，与凭据查询一样不扣模型请求额度。参考图和横幅仅在 Qwen 为直接主提供方时开放。未授权或未配置的能力返回 `null`。

```json
{
  "model": "medcode-image-default",
  "reference_images": {
    "max_count": 1,
    "max_bytes": 4194304,
    "max_pixels": 4194304,
    "formats": ["png", "jpeg", "webp"]
  },
  "quality_steps": { "low": 30, "medium": 40, "high": 50 },
  "banner_size": "1536x512"
}
```

`POST /gateway/images/generations` 请求新增字段（其他字段沿用）：

```json
{
  "model": "medcode-image-default",
  "prompt": "保留参考图标，将标题按两行排版……",
  "size": "1536x512",
  "quality": "medium",
  "output_format": "png",
  "reference_image": { "b64_json": "<原始图片文件的标准 Base64，无 data URL 前缀>" }
}
```

Qwen 成功响应新增：

```json
{
  "generation_parameters": {
    "size": "1536x512",
    "quality": "medium",
    "inference_steps": 40,
    "reference_images": 1,
    "mode": "edit"
  }
}
```

`size` 是最终输出尺寸；原有 `1080x1080` 方形输出别名仍按原流程等比例转换。`reference_images` 表示实际提交 Qwen 的参考数量；步数需上游确认，原生尺寸需解析输出 PNG 确认。

路由请求体限制为 6 MiB，参考原文件限制为 4 MiB。已只读核实生产 goldencode Nginx 总限制为 20 MiB，无需调整。原有具备 `1536x1024` 的图像套餐可使用像素更少的 `1536x512`，保留存量套餐快照；仍检查图片能力、模型、质量与输出格式权限。能力查询单独公布新横幅尺寸。

## Desktop 接法

共享 image 工具新增：

- `reference_image`：本地原图路径，按现有文件访问权限处理真实路径，读取并传输实际图片字节。
- `edit_latest: true`：读取本会话最近生成图片的字节作为参考图，提示词描述修改。旧会话与原生 V2 均支持；V2 从持久化 SessionFiles 获取，摘要压缩后仍可编辑。
- `save_latest` 继续仅保存，不生图。上述三个模式互斥；原图缺失、路径为空或过大时明确失败，不降级成文字生图。
- 参考图或 3:1 先查能力端点，旧 Gateway 返回 404 或不支持时不发送生成请求。响应未确认参考数量／横幅尺寸时报告失败，不自动重试。
- 工具结果及 metadata 返回实际步数、尺寸和参考数量。提示说明中文逐字内容、换行和检查要求，不把增加步数表述为保证出版质量。

## 真实 Qwen 验证

使用现有私有调度池，固定 seed 20261105，顺序执行三次，未绕过调度、未重启服务。每次均 HTTP 200、PNG 1536×512：

| 场景 | 步数 | 总耗时 | GPU 峰值占用 | GPU 最高温度 |
| --- | ---: | ---: | ---: | ---: |
| 中文横幅生成 | 40 | 53.02 秒 | 17,382 MiB | 64°C |
| 将该横幅作为参考继续编辑 | 50 | 59.65 秒 | 20,448 MiB | 74°C |
| 相同 seed／提示词的快速草稿 | 30 | 47.20 秒 | 17,384 MiB | 73°C |

视觉检查：40 步样图“桌面版使用指南”“检索 · 阅读 · 写作”清晰、两行布局正确；编辑后保留文字、图标和基本布局，标题改为深青色，但背景增加纹理，未完全满足保持白底的要求，标题放大也不明显。这证明编辑链路与尺寸可用，不证明原始 logo 逐像素保真，也不是 30/40/50 步质量排名。样图使用测试图标，并非用户原始 MedEvidence logo。

本地证据目录：`.task-artifacts/image-quality-20261105/`，包括 `banner.png/json`、`edit.png/json`、`draft.png/json`。不包含密钥；保留测试输出，不把用户对话和其他运维证据加入提交。

验证后两个 worker 均 ready、无占用，GPU 温度 44°C；Gateway healthy、重启次数 0、OOMKilled=false。

## 验证与发布顺序

验证结果：

- Gateway `npm run typecheck` 通过；全量 `npm test` 为 113 个文件通过、2 个文件跳过，2275 项通过、4 项跳过。末轮能力查询的额度豁免与模型授权检查改动后，接口／Qwen／请求额度三个文件的 516 项回归再次通过。
- Desktop 包内 `bun typecheck` 通过；新旧会话、排队、取消等 17 项通过，原有 215 秒长等待测试按配置跳过。末轮空路径与上游参考确认保护的 3 项针对性测试通过，其中 1 项为新增测试。
- 两仓库本任务文件 `git diff --check` 通过。保留原有无关工作区改动；Gateway 随后已提交、推送并部署，客户端仍未发布。
- 修复边界测试发现的长 Base64 正则栈溢出，改为有界长度检查和解码后标准 Base64 回编码一致性检查，覆盖恰好 4 MiB 和超限情况。

先发布已测试的 Gateway 提交，再发布 Desktop；旧 Desktop 可继续文字生图，新 Desktop 面对旧 Gateway 会拒绝尚未支持的编辑请求。GPU worker 已支持尺寸、参考图和步数，本次无需升级 worker。Gateway 若部署需重启，遵守连续 5 分钟模型与长任务自然空闲窗口，心跳和凭据查询允许；不以强制清空任务制造窗口。
