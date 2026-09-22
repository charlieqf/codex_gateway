# Qwen-Image-2.1 部署与 LLaDA 对比评估

日期：2026-09-22。用户授权下载、部署并与现有 LLaDA-Image-Turbo-FP8 对比。范围为 star 上的私有研究评估服务。

## 部署回执

- 主机：star，Ubuntu 22.04，NVIDIA 570.211.01，2 × RTX 6000 Ada 48GB。
- 目录：`/data/apps/qwen-image-21-eval`。
- 服务：aiuser 的 `qwen-image-21-eval.service`，监听 `127.0.0.1:8191`。
- 模型 ID：`qwen-image-2.1`。BF16，默认 40 步、CFG 1，GPU 1，模型 CPU 卸载。
- 当前部署源码提交：`a4e3a94cff69907ac92975fe499919a6a1ee3851`。从该提交的限定目录生成不可变发布包；没有部署 Gateway 开发目录。
- 发布包 SHA256：`d34fef8f36fe503845a59fc6eea89bc725802fcff3a68bfa3bae173b4c184744`。
- HF 权重参考提交：`790c92633540aa0cb11d9abf19eb46d861714758`。
- star 无法直连 HF，使用官方 ModelScope 镜像并固定各文件版本。28 个文件共 33,131,617,168 字节，逐个校验大小及 SHA256；权重与 tokenizer 的 HF LFS 哈希与镜像一致。
- Diffusers 源码提交：`7263f3317f6b392d62f41e9d75ed9d7e21fc5a5c`，归档 SHA256：`e4a1a88ff1b013f4f606d7234d23ec89dea03a4b50212afd2a56fddbb2878251`。
- Torch 2.8.0 / CUDA 12.8、Transformers 5.17.0、Diffusers 0.41.0.dev0、Accelerate 1.10.1。
- 新 venv 单独安装新依赖，但通过 `--system-site-packages` 只读复用现有 LLaDA 的 Torch 基础环境；它不是完全独立复制的环境。不要删除或原地升级基础环境而不重新验证本服务。
- 单请求执行，PyTorch 分配器上限为 GPU 显存的 58%；入场温度不高于 60°C，生成中达到 85°C 中止。研究服务尚未设置开机自启，`Restart=no`。

现有 LLaDA 继续使用 GPU 0 / `127.0.0.1:8190`。IndexTTS 保留 GPU 1 的约 8.4 GiB 常驻显存。没有修改公共 Gateway 生图路由。R760 只读预检发现现存 NVML 驱动与库版本不一致，本任务没有修改该主机的驱动或生产服务。

## 访问与维护

在 star 上访问 `GET /healthz`、`GET /v1/models` 和 `POST /v1/images/generations`。端点只监听回环地址。工作站可通过 SSH 转发使用：

```powershell
ssh -N -L 8191:127.0.0.1:8191 -p 7722 aiuser@117.186.49.26
```

另开终端运行：

```powershell
$body = @{ model='qwen-image-2.1'; prompt='A red ceramic teapot on a white table'; size='1024x1024'; seed=42; n=1; response_format='b64_json' } | ConvertTo-Json
$result = Invoke-RestMethod http://127.0.0.1:8191/v1/images/generations -Method Post -ContentType 'application/json' -Body $body
[IO.File]::WriteAllBytes((Join-Path $PWD 'qwen-example.png'), [Convert]::FromBase64String($result.data[0].b64_json))
```

已验证的评估尺寸为 1024×1024。局部改图使用本服务扩展字段 `image_b64`，传入参考 PNG 的 Base64。服务繁忙返回 429；GPU 尚未冷却或可用显存不足返回 503。

aiuser 在 star 上的维护命令：

```bash
systemctl --user status qwen-image-21-eval.service
systemctl --user start qwen-image-21-eval.service
journalctl --user -u qwen-image-21-eval.service -n 50 --no-pager
```

回退只需 `systemctl --user stop qwen-image-21-eval.service`，保留权重、发布包和评估记录。无需操作 LLaDA、IndexTTS 或 Gateway。

## 评估方法与产物

共同测试结果：

| 项目 | LLaDA-Image-Turbo-FP8 | Qwen-Image-2.1 |
| --- | ---: | ---: |
| 成功生成 | 16/16 | 16/16 |
| 平均本机 HTTP 耗时 | 13.64 秒 | 58.52 秒 |
| 中位数耗时 | 13.69 秒 | 58.65 秒 |
| 耗时范围 | 12.93–14.20 秒 | 56.91–60.04 秒 |
| 指定文字全部正确 | 2/6 | 5/6 |
| 文字、排版且无额外文字 | 1/6 | 4/6 |
| 物体数量与相对位置正确 | 2/4 | 4/4 |
| 完整空间题要求（含平行） | 0/2 | 0/2 |
| 逐对主观偏好 | 2 对 | 9 对 |
| 整卡峰值显存 | 29.18 GiB | 25.34 GiB，含 IndexTTS |
| 最高记录温度 | 69°C | 81°C |

其余 5 对判为平局。Qwen 的 PyTorch 分配峰值为 16.42 GiB；整卡峰值包含其他进程，不宜直接比较模型显存效率。16 次请求均成功，只能说明这轮单请求评估稳定，不能推断生产负载稳定性。

本次 Qwen 更擅长中文海报、英文商品标签与物体计数，但也出现双语漏字、斜杠被画出、人物裁脸和铅笔未严格平行。LLaDA 的优势是速度，且部分人物构图更贴近提示词。建议继续让 LLaDA 承担快速生图，保留 Qwen 用于重视文字及构图控制的研究评估；本次未切换默认路由。

另做了两项 Qwen 附加检查，不纳入上述 16 对样本：

- 透明背景：57.42 秒；RGBA Alpha 范围 0–255，四角完全透明，57.02% 像素 Alpha ≤5，59.58% 像素非完全不透明。主体为抱蓝书的小熊猫，检查通过。
- 局部改图：60.78 秒；把左侧红杯改为黄色，视觉上保留白杯、蓝杯、形状、摆位、背景与视角。未编辑区域并非逐像素不变；检查通过。

首个改图请求记录了 Torch 磁盘内核缓存目录缺失的警告。评估完成后已补建可写缓存子目录；上述耗时保留原始结果，没有为消除该影响重跑或挑选样本。服务本身成功完成全部请求。

8 类题目 × 2 个固定种子，每模型 16 张，1024×1024，同提示词、无改写、每请求一张 PNG。两套部署分别使用 LLaDA FP8 Turbo 4 步 GPU 常驻和 Qwen BF16 40 步 CPU 卸载，因此属于实际部署配置对比。

计时从服务器本机 HTTP 请求到完整 JSON/Base64 响应，包含生成和 PNG 编码。预热排除。每次请求前等待 GPU 不高于 58°C 且利用率不高于 5%；降温时间不计入单请求耗时。因此结果不表示连续吞吐量或并发能力。

视觉审查由单个助手查看原始 PNG 及缩小联系表完成，非盲测、非独立人类评审。不使用原计划五分制评分，改为逐对理由和可核对的文字、数量、位置检查。相同种子不代表两个模型的初始噪声或构图相同。双语标题题用斜杠分隔三行，存在提示歧义，须结合原图解释。

完整产物：`C:\work\code\.task-artifacts\qwen-image-21-20260922`。最终指标见 `summary.json`；图册见 `comparison.html`；逐请求耗时、显存、温度、PNG SHA256 见两个 `*-results.jsonl`；逐图评价见 `visual-review.json`。服务器保留 `/data/apps/qwen-image-21-eval/results` 原始结果及 `state` 部署证据。

浏览器图册预览未完成：CUA 初始化失败，随后浏览器渲染操作被自动审批以 `blocked by policy` 拒绝。原图视觉检查、文件哈希、完整样本覆盖及 HTML 本地引用可单独校验，结果写入 `validation.json`。

## 上游资料与使用范围

Qwen-Image-2.1 的权重采用 [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE)，允许研究和评估，商业使用需要单独许可。本次服务保持私有研究用途。官方资料：[模型卡](https://huggingface.co/Qwen/Qwen-Image-2.1)、[代码仓库](https://github.com/QwenLM/Qwen-Image-2.1)。

部署与评估源码位于 `scripts/experiments/qwen-image-21-eval`。本任务提交只包含该目录及此回执，未推送远端；仓库原有未提交工作保持原样。
