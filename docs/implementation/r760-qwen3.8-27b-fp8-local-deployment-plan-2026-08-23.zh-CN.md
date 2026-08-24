# R760 Qwen3.8-27B-FP8 本地部署实施方案

> **2026-08-24 最终实施决策（现行权威）**
>
> 阶段 E–G 已按后续客户端产品要求完成，但最终架构不再采用本文早期设计的独立
> `qwen-api` 域名、独立 Gateway、独立 SQLite 或第二套用户 Key。现行契约是在既有权威
> `https://goldencode.instmarket.com.au:1443/v1` 和既有 `medcode` Provider 下并列发布
> `goldencode` 与 `goldencode-local`；同一枚有效 `cgu_live_*`，包括手机号登录取得的统一
> Key，可以明确切换两个模型。raw vLLM 仍保持私有，仅权威 R760 Gateway 经专用 Docker
> 网络访问。本文中与这一决策冲突的“独立域名/独立 Gateway/独立 Key”段落只保留为最初方案
> 与历史风险分析，不再是操作指令。本节、1.2 节和当前 System Status 优先。

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 阶段 A–G 已完成；`goldencode-local` 已通过既有公网 Origin 和既有统一 Key 上线 |
| 编制/更新日期 | 2026-08-23 / 2026-08-24（Sydney） |
| 目标主机 | Dell PowerEdge R760，Ubuntu 22.04 |
| 目标模型 | `Qwen/Qwen3.8-27B-FP8` |
| 推理框架 | 首选 vLLM；SGLang 作为后续对照方案 |
| 生产入口 | `https://goldencode.instmarket.com.au:1443/v1`；raw vLLM 无宿主端口 |
| 目标用户 | 公司内部少量用户；每人独立 API key，经公网 HTTPS 调用 |
| 目标协议 | OpenAI-compatible `GET /v1/models`、`POST /v1/chat/completions`，支持 SSE |
| 公网模型 ID | 既有 `goldencode` 与新增 `goldencode-local` 并列 |
| 隔离原则 | Qwen runtime 独立目录/Compose/私网；复用权威 Gateway/SQLite/手机号登录和统一 Key |

## 1. 结论与实施边界

R760 适合以单张 NVIDIA RTX 6000 Ada 48GB 部署官方
`Qwen/Qwen3.8-27B-FP8`。FP8 权重约为 28.75GiB，能够完整放入 GPU；已验收的运行点限制为
32K 上下文、最多 2 个并发序列，并使用 BF16 KV Cache。模型权重仍为硬件 FP8 W8A8；BF16 KV
是为了避免未校准 FP8 KV scale 的精度风险，实测容量仍足够。64K 是首轮稳定验收后的独立扩容项。
BF16 权重约为 51.75GiB，仅权重就超过本机 GPU 显存，不属于本方案。

本方案的最终目标是把本地模型作为公司内部服务，通过公网 HTTPS 和每人独立 API key 提供
OpenAI-compatible 接口。它不替换现有公网 `goldencode`，也不加入现有 `goldencode` 的
`/v1/models`，不接入 Doctor Research。Qwen 使用独立域名、独立 Gateway 实例、独立 SQLite
和独立密钥库；vLLM 始终只在私有 Docker 网络或临时 loopback 上可达，绝不直接暴露公网。

实施分为七个阶段：

1. 下载并验证官方 FP8 权重；
2. 固定并验证 vLLM 容器镜像；
3. 在 loopback 上启动单卡、低并发实例；
4. 完成模型能力、资源压力和生产共存验收；
5. 为现有 Gateway 代码增加受限的本地 OpenAI-compatible runtime，并部署为独立实例；
6. 经批准后增加独立 SNI 域名、TLS 和 Nginx 路由；
7. 给少量内部用户逐人发放 key，小流量灰度后决定扩大上下文或用户数。

下载权重不等于部署上线。下载阶段不得创建监听端口、占用 GPU 或重建任何现有生产容器。

### 1.1 2026-08-23 阶段 A–D 历史结果

截至 2026-08-23 16:40 UTC，阶段 A 至 D 已完成，阶段 E 至 G 因缺少已批准的公网域名、证书和
Gateway 变更窗口而未执行：

- 官方 ModelScope `master` 权重完整下载到 `/data/models/Qwen3.8-27B-FP8`，共
  30,890,053,596 bytes；66 个 safetensors 分片全部通过结构和本地 SHA-256 校验；
- 官方 vLLM `v0.27.1` 的 Linux/amd64 OCI manifest 和 34 个 blob 均按 SHA-256 校验，随后导入
  本地 Docker；镜像内 `vllm.__version__=0.27.1`；
- 独立 Compose project `qwen38_fp8_local` 已运行，容器 `qwen38-fp8-local` 为 healthy，
  `restart=unless-stopped`，只监听 `127.0.0.1:18000`；
- 当前参数为 FP8 权重、BF16 KV、32K 上下文、`max-num-seqs=2`、文本模式、Qwen reasoning parser
  和 `qwen3_coder` 工具解析器；
- 最终 13 个请求场景均成功：health、models、普通对话、SSE/usage、low/medium/xhigh reasoning、
  required/named/none 工具策略与回填、8K、31.5K 和两路并发；named tool choice 有一项
  `finish_reason` 兼容性提示，见 7.3；
- 五个现有 `codex_gateway_r760` 容器 ID 与启动时间未变，均 healthy、restart count 0；现有
  `goldencode` 公网健康检查仍为 200，无 NVIDIA Xid、OOM、NCCL 或模型致命日志。

当前 raw vLLM 没有用户级 API key 管理，且仅能从 R760 本机回环访问。不得把 `18000` 直接映射到
公网。公网服务仍须完成阶段 E 至 G 的独立 Gateway、逐人 key、配额、审计、TLS 和灰度流程。

### 1.2 2026-08-24 阶段 E–G 实施结果（现行）

后续产品契约要求 MedEvidence 与 GoldenCode Desktop 在同一 `medcode` Provider 下显示
`goldencode`、`goldencode-local`，并让用户继续使用现有 `cgu_live_*` 或手机号登录。该要求
构成对 1.1 及后文独立公网方案的明确重新评审和授权，最终按以下方式实施：

1. **阶段 E：Gateway 与鉴权。** Gateway 新增受限 `local_openai` runtime，私有上游固定为
   `http://qwen38-fp8:8000/v1`。Qwen adapter 保留 OpenAI tool 历史，不注入云端身份提示，
   支持 SSE、usage、reasoning effort 和工具调用，并把非空工具调用的公开 finish reason
   归一为 `tool_calls`。未来新发 Desktop/Phone Auth 底层凭据默认同时允许两个模型；现有 155
   个 `goldencode`-only 活跃 Desktop 凭据已经逐条通过 Admin CLI 追加本地模型并留下审计记录，
   31 个 unrestricted 活跃凭据无需修改。
2. **阶段 F：公网接入。** 没有新增 DNS、TLS 证书、Nginx vhost、宿主监听或第二 Gateway。
   既有 `goldencode.instmarket.com.au:1443` 已是权威 Origin，Gateway 在其 `/v1/models` 和
   `/v1/chat/completions` 发布两个模型。raw vLLM 已取消 `127.0.0.1:18000` 映射，只在
   `qwen_api_gateway_r760_qwen_private` 网络暴露容器端口 8000；权威 Gateway 同时连接原生产
   网络和该私网。生产代理环境的 `NO_PROXY`/`no_proxy` 已保留原列表并加入两个 Qwen DNS
   别名，避免私网请求误送到 HTTP proxy。
3. **阶段 G：灰度和验收。** R760 loopback 与同一公网 Origin 均通过无 Key/错 Key 401、
   精确双模型 discovery、无效模型 404、两个模型非流式对话、Qwen SSE/usage、required/
   named/none/工具结果回填、事件归属、RPM 429、撤销后 401 和日志 secret/prompt 扫描。
   随后从独立 Windows 工作机使用同一枚临时 `cgu_live_*` 发现两个模型并分别完成公网调用；
   测试统一 Key、底层 Key 和用户均已撤销/禁用和清理。公网完整烟测的本地模型请求 ID 为
   `req-d925ad1a-da5e-4158-b9c8-a879cb497adf`。

当前运行边界：

- Qwen Compose project：`qwen_api_gateway_r760`；容器：`qwen38-fp8-local`；
- vLLM image：`vllm/vllm-openai:v0.27.1-r760-c2f3b1b9`；
- Gateway image：`codex_gateway_r760-gateway:release-531f8d1-local`，image ID
  `sha256:0845a340fd76d289d3c4818936220bfe2921476690a96338e338668d4f20387e`；
- 部署备份：
  `/data/llm-runtime/qwen-api/backups/goldencode-local-20260824T012936Z`；
- 混合健康策略：Qwen 不健康时 Gateway 仍可为 `goldencode` 保持 ready，并在 health 的
  `inference` 字段单独报告 `local_openai` 状态；
- 332 个未过期统一 Key 记录中，有 2 个关联的是实施前已经失效的底层凭据，未擅自恢复；
  其余所有具备有效底层凭据的统一 Key 均可调用两个模型。

回滚本地模型时，不改 DNS/Nginx，也不操作 Doctor Research：使用上述备份恢复权威 Gateway
env、Compose override、SQLite 一致性备份和上一 Gateway image，重建 Gateway 后验证
`goldencode`；随后按需停止 Qwen runtime。已写入用户凭据的额外 allowlist 项本身不路由流量，
可以保留以便前向恢复；若必须回退授权，应通过 Admin CLI 逐条审计修改，禁止无审计批量 SQL。

客户端对接和安装包验收契约见
`docs/goldencode-local-desktop-joint-test-handoff-2026-08-24.zh-CN.md`。

## 2. 官方依据与版本选择

官方资料：

- Qwen FP8 模型卡：<https://huggingface.co/Qwen/Qwen3.8-27B-FP8>
- Qwen3.8 官方仓库：<https://github.com/QwenLM/Qwen3.8>
- ModelScope 官方模型：<https://modelscope.cn/models/Qwen/Qwen3.8-27B-FP8>
- vLLM Qwen3.8-27B 官方配方：<https://recipes.vllm.ai/Qwen/Qwen3.8-27B>
- vLLM FP8 W8A8 支持说明：<https://docs.vllm.ai/en/v0.27.1/features/quantization/fp8/>
- SGLang Qwen3.8-27B 配方：<https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-27B>
- 阿里云 Qwen OpenAI-compatible 调用示例：<https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen>
- vLLM OpenAI-compatible Server 与鉴权边界：<https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/>

已核对的关键事实：

- Qwen3.8-27B 是 27B 稠密多模态模型，语言模型包含 64 层，其中 48 层为 Gated
  DeltaNet、16 层为全注意力；原生上下文为 262,144，可扩展到 1,000,000。
- 官方 FP8 checkpoint 使用 block size 128 的细粒度 FP8 量化，官方说明其评测性能与原始模型接近。
- vLLM 明确支持 NVIDIA Ada（Compute Capability 8.9）上的硬件 FP8 W8A8。
- vLLM 配方要求 vLLM 0.17.0 或更高版本。本次固定官方镜像
  `docker.io/vllm/vllm-openai:v0.27.1`；官方多架构 index digest 为
  `sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967`，
  其中 Linux/amd64 manifest digest 为
  `sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2`。
  启动前仍须核对本地 image ID 和镜像内 `vllm` 版本；禁止使用未固定的 `latest`。
- SGLang 的公开单卡验证包含 RTX PRO 6000 Blackwell，不等同于本机 RTX 6000 Ada。因此第一实施路径选择 vLLM，SGLang 仅作后续性能对照。
- Hugging Face 当前公开模型提交为
  `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a`。R760 到 Hugging Face 的 HTTPS
  直连在本次实施时超时；Qwen 官方明确建议无法访问 Hugging Face 时改用 ModelScope，故当前下载源为官方
  ModelScope `master`。完成后必须生成本地 SHA-256 清单，形成不可变的本地部署边界。
- 官方公网 Qwen 的常规调用形态是 `base_url`、Bearer API key、模型 ID 和
  `/v1/chat/completions`；本服务保持同样的客户端形态，仅替换 base URL、key 和模型 ID。
- vLLM 虽有 `--api-key`，但官方明确说明它不保护同一进程上的全部端点。因此它不能作为公网
  安全边界；网络隔离和前置 Gateway 鉴权是强制要求。

## 3. R760 当前资源基线

### 3.1 硬件与宿主软件

| 资源 | 已验证状态 | 部署判断 |
| --- | --- | --- |
| GPU | 1 × NVIDIA RTX 6000 Ada Generation，49,140MiB，SM 8.9，PCIe 4.0 x16，300W | 支持官方 FP8；只能单卡 TP1 |
| GPU 驱动 | Ubuntu `nvidia-driver-595`，版本 595.84；NVIDIA DKMS 已覆盖内核 5.15.0-186 和 5.15.0-190 | 可持续跨内核升级；无需为本模型再安装宿主 CUDA Toolkit |
| 容器 GPU | NVIDIA Container Toolkit 1.19.1；CUDA 12.8 容器透传 smoke 已通过 | 可采用 GPU 容器运行 |
| CPU | Intel Xeon Gold 6530，32 核 / 64 线程 | 足够承担 tokenizer、调度和预处理；必须给新容器设 CPU 上限 |
| 系统内存 | 125GiB，总可用约 120GiB，Swap 8GiB 未使用 | 足够下载、装载和页缓存；不得依赖 Swap 承担常态推理 |
| 数据盘 | `/data` 约 1.8TB，总可用约 1.6TB | 模型、Docker 数据和运行缓存统一放在 `/data` |
| 根分区 | `/` 约 98GB，仅约 49GB 可用 | 禁止把模型缓存放在 `/root/.cache` 或根分区 |
| Docker | Docker Root Dir 为 `/data/docker`；Compose 2.40.3 | 镜像层不会挤占根分区；新服务使用独立 project |

### 3.2 现有生产应用基线

当前五个 `codex_gateway_r760` 容器全部健康、restart count 为 0，并且
`.HostConfig.DeviceRequests=null`，即没有任何现有容器申请 GPU。五个容器当前合计使用约
631MiB 内存，并各自具有 CPU/内存限制。端口 8000 和 30000 当前没有监听者。

因此，本地模型不会与现有应用发生直接 GPU 争用。潜在的间接影响包括：

- 首次下载和镜像拉取造成网络与数据盘 IO；
- 模型启动和长输入 prefill 造成 CPU、内存与 GPU 功耗峰值；
- GPU 满载时产生最高约 300W 的额外功耗和散热负载；
- 未设置容器资源上限时，tokenizer、媒体预处理或异常重试可能挤压宿主资源。

所有阶段必须保持现有生产 Compose project、容器 ID、restart count、loopback
Gateway 健康和公网健康不变。

## 4. 容量预算与推荐运行点

### 4.1 GPU 显存

| 项目 | 估算 |
| --- | ---: |
| GPU 总显存 | 约 47.99GiB |
| 官方 FP8 safetensors | 约 28.75GiB |
| 权重装载后的名义余量 | 约 19.24GiB |
| 32K FP8 KV Cache | 约 1GiB |
| 64K FP8 KV Cache | 约 2GiB |
| 262K FP8 KV Cache | 约 8GiB，仅 KV，不含图、激活和 GDN 状态 |
| 1M FP8 KV Cache | 约 30.5GiB，仅 KV，单卡不可行 |
| 最终实测 BF16 KV 预算 | 10.32GiB，156,558 tokens；32K 理论并发 4.78，配置上限仍为 2 |

Qwen3.8 的混合 GDN 架构还需要固定 recurrent state。SGLang 官方给出的量级为每个状态 slot
约 78.4MB（BF16）或 153.9MB（FP32）；此外还要保留视觉编码器、CUDA Graph、激活和框架开销。
因此：

- 第一运行点：32K，1 并发；
- 已通过的第一验收目标：32K，最多 2 并发，FP8 权重配 BF16 KV；
- 稳定后扩容目标：单独把配置改为 64K，再重复完整能力、资源和生产共存验收；
- 262K：只能作为单请求实验项，不能在未实测前对外承诺；
- 1M：不在单张 48GB 卡的实施范围内；
- 第一轮不启用 MTP speculative decoding，先获得稳定基线。

### 4.2 内存与磁盘

系统内存足以容纳下载工具、模型 mmap、容器运行和文件页缓存。新推理容器建议设置
`mem_limit: 80g`、`cpus: 16.0` 和 `shm_size: 16gb`，为现有应用与宿主保留明确余量。

模型目录至少预留 64GB；连同 vLLM 镜像、运行缓存、校验清单和一个后续版本，建议整体预留
150GB。当前 `/data` 的 1.6TB 可用空间满足要求。

## 5. 目录、进程和网络设计

```text
/data/models/Qwen3.8-27B-FP8/          官方权重，只读挂载到推理容器
/data/llm-runtime/modelscope-venv/     隔离的下载工具环境
/data/llm-runtime/qwen38-fp8/          后续 Compose、运行缓存和验收记录
/data/llm-runtime/qwen38-fp8/cache/    vLLM/torch 编译缓存
/data/llm-runtime/qwen-api/            独立 Gateway 配置、SQLite、备份和审计记录
```

### 5.1 目标架构

```text
内部用户 / OpenAI SDK
  -> https://qwen-api.instmarket.com.au:1443/v1
  -> 公网 NAT :1443 -> R760 Nginx :443
  -> 新 SNI vhost（TLS、连接级防护、SSE）
  -> 127.0.0.1:18788
  -> 独立 qwen_api_gateway_r760 Gateway
       - 每人独立 Bearer API key
       - 模型白名单、RPM/RPD/并发/token 限额
       - 撤销、过期、轮换、用量和管理审计
  -> 私有 Docker 网络 http://qwen38-fp8:8000/v1
  -> vLLM（没有 host/public port）
  -> NVIDIA RTX 6000 Ada

现有 goldencode 请求
  -> https://goldencode.instmarket.com.au:1443/v1
  -> 127.0.0.1:18787 -> codex_gateway_r760
  -> 完全保持原状，只列出 goldencode
```

建议域名是方案中的目标值，不表示 DNS、证书或公网路由已经获批。若最终选择其他域名，只替换
Qwen origin，不得复用 `goldencode` 域名下的模型列表或 SQLite。

### 5.2 为什么不用 vLLM 直接发 key

vLLM 原生 key 适合私有网络内的第二道保护，不适合作为本方案的用户管理面：

- 不能为每名用户提供独立撤销、过期、轮换、RPM/RPD、并发和 token 配额；
- 无法按公司用户稳定归属用量和管理审计；
- 官方说明 `--api-key` 不保护同一 HTTP 服务上的全部端点；
- 直接公开推理进程会把框架漏洞、管理/非标准端点和资源耗尽风险直接暴露到公网。

因此，公网只能到 Gateway，不能到 vLLM。vLLM 在最终形态中取消 `ports:`，只保留 Compose
私有网络的 `expose: 8000`。

### 5.3 Gateway 复用范围

现有 Gateway 已具备用户级 Bearer key、模型 allowlist、key 过期/撤销/轮换、请求频率、日请求、
并发、token budget、请求事件和 usage 审计。可以复用这些能力，但不能把本地模型伪装成现有
`openrouter`、`qianfan`、`aliyun`、`tencent` 或 `tokenswitch` runtime；现有适配器包含云厂商
身份提示和错误语义。

上线前应增加一个最小的 `local_openai` runtime：

1. 上游 base URL 只允许配置的私有 Docker DNS 名称，不接受请求传入 URL；
2. 原样保留客户端 `system/user/assistant/tool` 消息语义，不注入 MedCode 或云厂商身份提示；
3. 上游固定 `stream=true` 和 `stream_options.include_usage=true`，正确处理 SSE、取消和 usage；
4. 上游模型名固定为 `/model` 对外映射的 `qwen3.8-27b-fp8`，客户端不得穿透选择任意模型；
5. 支持 Qwen `reasoning_effort` 和 `qwen3_coder` 工具调用，但先通过契约测试；
6. 超时、断流、OOM 和模型繁忙统一映射为 OpenAI-compatible 错误，不向用户返回内部地址或日志；
7. 单元测试覆盖模型 allowlist、非流式、SSE、取消、usage、工具调用和敏感信息脱敏。

该代码构建为独立镜像，运行在独立 Compose project 和 SQLite 上，不替换当前
`codex_gateway_r760-gateway-1`。

### 5.4 对外 API 契约

首版只承诺：

| 能力 | 公网契约 |
| --- | --- |
| 模型列表 | `GET /v1/models`；鉴权后只返回 `qwen3.8-27b-fp8` |
| 对话 | `POST /v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <company-issued-api-key>` |
| 流式 | `stream=true`，标准 SSE，以 `[DONE]` 结束 |
| 模型名 | `qwen3.8-27b-fp8`，不接受本地路径或其他 alias |
| 初始上下文 | 对外 32K；64K 通过压力验收后再变更 |
| 初始输出上限 | 8K tokens |
| 浏览器跨域 | 默认关闭；服务端应用、脚本或 SDK 调用 |

以下调用示例是阶段 E 至 G 完成后的目标契约；截至本文当前状态，示例域名和 company-issued key
尚不可用，不能用 raw `127.0.0.1:18000` 替代公网 Gateway。

调用示例：

```bash
export QWEN_API_KEY='<company-issued-api-key>'
curl -sS https://qwen-api.instmarket.com.au:1443/v1/chat/completions \
  -H "Authorization: Bearer ${QWEN_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.8-27b-fp8",
    "messages": [{"role": "user", "content": "你好，请简要介绍你自己。"}],
    "stream": false,
    "max_tokens": 1024
  }'
```

Python OpenAI SDK：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["QWEN_API_KEY"],
    base_url="https://qwen-api.instmarket.com.au:1443/v1",
    timeout=600,
)

response = client.chat.completions.create(
    model="qwen3.8-27b-fp8",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=1024,
)
print(response.choices[0].message.content)
```

key 只能放在受保护的环境变量或 secret store；不得写入 URL、前端 JavaScript、源代码、工单或
聊天记录。服务端日志只记录 request ID、key prefix、用户 ID、模型、状态、耗时和 token usage，
默认不记录 prompt/response 正文，也不记录完整 Authorization header。

### 5.5 初始用户配额

单张 48GB GPU 的全局并发上限先由 vLLM `--max-num-seqs 2` 控制。每名内部用户建议初始配置：

| 项目 | 初始值 |
| --- | ---: |
| API key 有效期 | 90 天 |
| 每分钟请求 | 6 |
| 每日请求 | 100 |
| 每 key 并发 | 1 |
| 每请求最大 prompt | 24,576 tokens |
| 每请求最大总 token | 32,768 tokens |
| 每日 token | 1,000,000 |
| 每月 token | 10,000,000 |

token/minute 的实现下限为 300,000，因此把它作为防失控上限，而不是吞吐承诺。先给 3 至 5 名
用户灰度；根据 TTFT、decode tokens/s、排队时间和 OOM 数据再调整，不因“用户少”而取消配额。

验收阶段禁止：

- 监听 `0.0.0.0`；
- 修改 Nginx、DNS、防火墙或现有 Gateway provider registry；
- 把模型服务加入 `codex_gateway_r760` Compose project；
- 使用 `network_mode: host` 或宿主 IPC；
- 未固定镜像 digest 就作为长期服务启动；
- 在权重未完整校验时启动 vLLM。
- 复用现有 `goldencode` SQLite、key 加密 secret 或用户 key；
- 向公网发布 vLLM `/health`、`/metrics`、`/docs`、`/invocations` 或任何非 Gateway 路径；
- 在公网请求日志中记录完整 key、prompt 或 response。

## 6. 实施步骤

### 6.1 阶段 A：下载官方权重

实际完成状态：

- 开始时间：2026-08-23 12:36:30 UTC；来源为官方 ModelScope
  `Qwen/Qwen3.8-27B-FP8`，revision `master`；
- 目标目录：`/data/models/Qwen3.8-27B-FP8`；工具为 ModelScope 1.39.1 隔离 venv；
- 最终 ModelScope 扫描为 82/82，下载任务 exit code 0；目录精确大小
  30,890,053,596 bytes，不存在 `.incomplete` 或 `.aria2` 文件；
- 模型结构为 `Qwen3_5ForConditionalGeneration`，索引包含 66 个 safetensors 分片；全部分片
  可读并通过本地 SHA-256 清单；
- 验证报告：`/data/llm-runtime/qwen38-fp8/model-validation.json`，状态 `ok`；
- 只读清单：`/data/llm-runtime/qwen38-fp8/model-download-manifest.sha256`，共 78 行，模式 `0444`；
- 官方 `crc32.txt` 的 77 项中，模型大文件和其余文件匹配；其中 3 个小型元数据文件的 CRC 条目
  已过时。当前文件与 ModelScope `master`、Hugging Face 提交
  `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` 完全一致，验证报告将其作为上游 stale
  metadata 留档，而不是静默忽略；
- 下载过程中未重启或重建任何生产容器，也未改变生产网络、Nginx、DNS、firewall 或 Docker daemon。

检查进度：

```bash
systemctl status qwen38-fp8-download.service --no-pager -l
journalctl -u qwen38-fp8-download.service -n 80 --no-pager -o cat
du -sh /data/models/Qwen3.8-27B-FP8
find /data/models/Qwen3.8-27B-FP8 -type f -name '*.incomplete' -print
```

暂停下载不会删除 partial 文件：

```bash
systemctl stop qwen38-fp8-download.service
```

如任务失败或被暂停，使用相同参数续传：

```bash
systemd-run \
  --unit=qwen38-fp8-download.service \
  --description='Download official Qwen3.8-27B-FP8 from ModelScope' \
  --collect \
  --property=Type=exec \
  --property=Nice=10 \
  --property=CPUQuota=200% \
  --property=MemoryHigh=4G \
  --property=MemoryMax=8G \
  --property=IOSchedulingClass=best-effort \
  --property=IOSchedulingPriority=7 \
  --property=Restart=on-failure \
  --property=RestartSec=60s \
  /data/llm-runtime/modelscope-venv/bin/modelscope download \
    Qwen/Qwen3.8-27B-FP8 \
    --revision master \
    --local-dir /data/models/Qwen3.8-27B-FP8 \
    --max-workers 2
```

下载完成门槛：

1. 任务以 exit code 0 结束；
2. 目录中不存在 `*.incomplete`；
3. `config.json`、tokenizer、chat template、模型索引和全部 safetensors 均存在；
4. safetensors 总大小与官方模型仓库量级一致；
5. ModelScope 的 `crc32.txt` 校验通过；若上游小型元数据 CRC 已过时，必须逐项证明当前文件同时
   等于 ModelScope `master` 和固定 Hugging Face 提交，并在验证报告记录，不能直接跳过；
6. 生成并保护本地 SHA-256 清单：

```bash
cd /data/models/Qwen3.8-27B-FP8
find . -type f -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  > /data/llm-runtime/qwen38-fp8/model-download-manifest.sha256
chmod 0444 /data/llm-runtime/qwen38-fp8/model-download-manifest.sha256
```

### 6.2 阶段 B：固定 vLLM 镜像

本次 R760 直连 Docker Hub 的 manifest/pull 超时，因此没有修改 Docker daemon、Mihomo 或生产网络。
实施路径是通过现有私有代理读取 Docker Registry 官方 manifest，固定上述 digest，逐 blob 下载并校验
SHA-256，生成 OCI layout 后导入本机 Docker。锁文件、原始 manifest 和下载报告均保存在：

```text
/data/llm-runtime/qwen38-fp8/vllm-v0.27.1-lock.json
/data/llm-runtime/qwen38-fp8/vllm-v0.27.1-index.json
/data/llm-runtime/qwen38-fp8/vllm-v0.27.1-amd64-manifest.json
/data/llm-runtime/qwen38-fp8/vllm-v0.27.1-download-report.json
```

实际导入结果：

- OCI 下载报告在 2026-08-23 16:01:14 UTC 完成，34 个 blob 全部通过 SHA-256，压缩数据合计
  9,110,690,483 bytes；原始 OCI layout 保留在
  `/data/llm-runtime/qwen38-fp8/vllm-v0.27.1-oci`；
- 官方 OCI config digest 为
  `sha256:e0cfcfcb9b86e2c2d0d52a93689773f20f380cb8e050a24ce550c44f6f55c5eb`；
- R760 的旧版 Skopeo Docker API 客户端不兼容当前 Docker daemon，因此先把已验证 OCI 转为
  Docker archive，再由当前 Docker CLI 执行 `docker load`；archive manifest 仍引用上述原始
  config，镜像标签和构建 commit 均与官方 `v0.27.1` 一致；
- Docker 导入后的本地镜像为 `vllm/vllm-openai:v0.27.1-r760-c2f3b1b9`，本地 image ID 为
  `sha256:d37823220133779c5dc62c6c0b4f8b46d5197b9e49d5adfb3448381e557a62c6`；Docker 在导入
  未压缩 layer 时重建了本地配置 ID，因此本地 ID 不等于 OCI config digest；来源通过原始 OCI、
  archive manifest、镜像 labels、`vllm.__version__=0.27.1` 和 GPU 容器 smoke 共同固定；
- 成功导入并验收后，精确删除了 21,562,848,768-byte 中间 Docker archive，释放约 20.1GiB；
  已验证 OCI layout 保留，可重新生成该 archive。

能够直连 Docker Hub 的环境可在非业务高峰执行：

```bash
docker manifest inspect vllm/vllm-openai:v0.27.1
docker pull vllm/vllm-openai:v0.27.1
docker image inspect vllm/vllm-openai:v0.27.1 \
  --format '{{index .RepoDigests 0}}'
```

把得到的 digest 写入受控 Compose 文件，例如：

```text
vllm/vllm-openai@sha256:<verified-digest>
```

如果 Docker Hub 从 R760 不可达，不得改动 Docker daemon、Nginx 或生产网络来绕过下载问题；
使用逐 blob 校验的受控 OCI 导入流程，并把源 manifest digest、本地 image ID 和导入报告一起留档。

### 6.3 阶段 C：创建独立 Compose 运行面

建议文件：

```text
/data/llm-runtime/qwen38-fp8/compose.yml
```

建议配置基线：

```yaml
services:
  qwen38-fp8:
    image: vllm/vllm-openai:v0.27.1-r760-c2f3b1b9
    pull_policy: never
    container_name: qwen38-fp8-local
    # 首轮以 restart: "no" 启动；完整验收通过后已改为以下持久化策略。
    restart: unless-stopped
    ports:
      - "127.0.0.1:18000:8000"
    volumes:
      - /data/models/Qwen3.8-27B-FP8:/model:ro
      - /data/llm-runtime/qwen38-fp8/cache:/cache
    environment:
      HF_HUB_OFFLINE: "1"
      TRANSFORMERS_OFFLINE: "1"
      VLLM_NO_USAGE_STATS: "1"
      HF_HOME: /cache/huggingface
      XDG_CACHE_HOME: /cache/xdg
      TORCHINDUCTOR_CACHE_DIR: /cache/torchinductor
    shm_size: 16gb
    mem_limit: 80g
    cpus: 16.0
    pids_limit: 4096
    gpus: all
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=8g,mode=1777
    stop_grace_period: 2m
    healthcheck:
      test: ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 20m
    logging:
      driver: json-file
      options:
        max-size: 50m
        max-file: "5"
    command:
      - /model
      - --served-model-name
      - qwen3.8-27b-fp8
      - --tensor-parallel-size
      - "1"
      - --dtype
      - auto
      - --quantization
      - fp8
      - --max-model-len
      - "32768"
      - --kv-cache-dtype
      - bfloat16
      - --gpu-memory-utilization
      - "0.86"
      - --max-num-seqs
      - "2"
      - --language-model-only
      - --reasoning-parser
      - qwen3
      - --enable-auto-tool-choice
      - --tool-call-parser
      - qwen3_coder
```

第一轮如果只验证文本和工具调用，可临时增加 `--language-model-only` 以释放视觉编码器资源。需要验证图片输入时移除该参数并重新执行完整的显存和共存验收。

若启动在 CUDA Graph capture 阶段 OOM，先增加 `--enforce-eager`，而不是提高
`--gpu-memory-utilization`。若仍然 OOM，则把 `--max-model-len` 降为 32768、把
`--max-num-seqs` 降为 1。不得通过 CPU offload 把明显的性能问题包装成生产可用。

启动前先渲染校验，不输出任何现有生产环境变量：

```bash
cd /data/llm-runtime/qwen38-fp8
docker compose -p qwen38_fp8_local -f compose.yml config --quiet
docker image inspect vllm/vllm-openai:v0.27.1-r760-c2f3b1b9 >/dev/null
docker compose -p qwen38_fp8_local -f compose.yml up -d
```

### 6.4 阶段 D：启动观察

```bash
docker compose -p qwen38_fp8_local -f compose.yml ps
docker logs --tail 200 qwen38-fp8-local
nvidia-smi
curl -fsS http://127.0.0.1:18000/health
curl -fsS http://127.0.0.1:18000/v1/models
```

启动阶段持续观察：

- GPU 显存、利用率、温度、功耗与 Xid；
- 宿主 `MemAvailable`、Swap、load average 和 `/data` 空间；
- 新容器 OOM、重启、CUDA Graph 和 kernel fallback；
- 现有五个生产容器的 ID、health 和 restart count；
- loopback 与公网 Gateway health。

实际启动记录：

- vLLM 解析到 `Qwen3_5ForConditionalGeneration`，模型权重由
  `TritonFp8BlockScaledMMKernel` 加载；66 个分片首次加载耗时 12.38 秒，权重占用
  27.64GiB 显存；
- FP8 权重 + BF16 KV 的首次图编译约 70.25 秒，总 engine 初始化约 135.73 秒；编译缓存保存后，
  同配置重启会直接载入 AOT 缓存；
- 最终 BF16 KV 预算为 10.32GiB、156,558 tokens，32K 理论最大并发 4.78；服务上限仍固定为 2；
- idle 时 GPU 显存约 39.2GiB（`nvidia-smi` 约 40,162MiB），无 OOM；
- vLLM 对 RTX 6000 Ada 使用通用 W8A8 Block FP8 kernel 配置，功能正确，但日志提示性能可能低于
  有专用调优矩阵的 GPU；该项作为后续性能优化，不是上线阻断项；
- `min_frames`/`max_frames` 的 Transformers docstring 日志属于文本模式初始化噪声；模型明确以
  `--language-model-only` 运行，未启用视觉输入。

### 6.5 阶段 E：实现并部署独立 Qwen API Gateway

此阶段必须在代码评审和自动化测试通过后进行。建议变更范围仅包括：

- `PublicModelConfig.runtime` 新增 `local_openai`；
- 新增或抽取通用 OpenAI-compatible chat adapter，去除云厂商身份注入；
- 新增 `MEDCODE_LOCAL_OPENAI_BASE_URL`、`MEDCODE_LOCAL_OPENAI_TIMEOUT_MS` 和可选的内部
  upstream key file；
- 为该 runtime 增加 registry、dispatcher、SSE、取消、usage、工具调用、错误脱敏测试；
- 增加独立的 `qwen_api_gateway_r760` Compose profile，不修改现有生产 Compose project。

建议公共模型 registry：

```json
{
  "qwen3.8-27b-fp8": {
    "displayName": "Qwen3.8 27B FP8 (R760)",
    "runtime": "local_openai",
    "upstreamModel": "qwen3.8-27b-fp8",
    "contextWindow": 32768,
    "maxContextWindow": 32768,
    "upstreamContextWindow": 65536,
    "maxOutputTokens": 8192,
    "enabled": true
  }
}
```

独立实例的关键配置边界：

```text
GATEWAY_PUBLIC_BASE_URL=https://qwen-api.instmarket.com.au:1443
GATEWAY_PUBLIC_PROVIDER_NAME=qwen-local
GATEWAY_PUBLIC_PROVIDER_DISPLAY_NAME=Qwen Internal
GATEWAY_REQUIRE_ENTITLEMENT=0
MEDCODE_PUBLIC_MODEL_ID=qwen3.8-27b-fp8
MEDCODE_LOCAL_OPENAI_BASE_URL=http://qwen38-fp8:8000/v1
MEDCODE_LOCAL_OPENAI_TIMEOUT_MS=900000
```

`GATEWAY_SQLITE_PATH`、`GATEWAY_API_KEY_ENCRYPTION_SECRET`、管理 token 和备份路径必须属于
Qwen 独立实例。不得复制现有 `goldencode` SQLite 或 secret。最终 Compose 中：

- 只有 Qwen Gateway 发布 `127.0.0.1:18788:8787`；
- vLLM 删除临时的 `127.0.0.1:18000:8000` 映射，只 `expose: 8000`；
- 两个容器只加入 `qwen_api_gateway_r760` 的私有网络；
- Qwen Gateway 的上游目标固定为 `http://qwen38-fp8:8000/v1`；
- 先 `restart: "no"` 验收，稳定后再单独批准 `unless-stopped` 和开机恢复顺序；
- Gateway readiness 必须依赖本地模型可用，但模型故障不得导致现有 `goldencode` 被重启。

创建独立 SQLite 后，给每位用户单独发 key。建议通过新 Compose 中的受控 admin-cli service
执行，下面是参数基线；命令输出包含一次性完整 key，只能在受保护的运维终端运行和交付：

```bash
docker compose -p qwen_api_gateway_r760 -f compose.yml run --rm qwen-admin \
  issue \
  --user <employee-id> \
  --user-label '<employee-display-name>' \
  --label '<employee-device-or-app>' \
  --scope code \
  --credential-class service \
  --expires-days 90 \
  --rpm 6 \
  --rpd 100 \
  --concurrent 1 \
  --tokens-per-minute 300000 \
  --tokens-per-day 1000000 \
  --tokens-per-month 10000000 \
  --max-prompt-tokens 24576 \
  --max-total-tokens 32768 \
  --reserve-tokens 8192 \
  --missing-usage-charge reserve \
  --allowed-public-models qwen3.8-27b-fp8 \
  --no-entitlement-check
```

每人、每设备或每服务一个 key；不得共享“部门公共 key”。离职、设备丢失或疑似泄漏时立即
revoke，轮换时允许不超过 24 小时的双 key grace period。每周检查 active key、异常 401/429、
usage 和长时间请求；每月清理过期 key，保留审计记录。

### 6.6 阶段 F：增加独立公网入口

这是显式维护变更，只有在阶段 E loopback 验收通过、域名所有者和维护窗口批准后执行：

1. 为 `qwen-api.instmarket.com.au` 增加指向现有 R760 公网 NAT 的 DNS 记录；
2. 申请并验证只覆盖批准域名的 TLS 证书和续期路径；
3. 新增独立 Nginx SNI vhost，upstream 仅为 `127.0.0.1:18788`；
4. 沿用现有外部 `:1443 -> R760 Nginx :443` NAT，不开放 18000、18788 或新的宿主入站端口；
5. 只代理 `/v1/models`、`/v1/chat/completions` 和批准的最小 health 路径，其余返回 404；
6. 对 SSE 设置 `proxy_buffering off`、HTTP/1.1、合理的 15 分钟 read/send timeout；
7. 设置请求体大小、每 IP 连接/突发限制和未鉴权失败速率限制；不得用这些限制替代用户 key 配额；
8. 默认不设置 CORS；如未来有浏览器应用，必须由公司后端代持 key 或另做短期凭据代理。

变更前备份 Nginx 配置、证书清单、Qwen Compose/config、SQLite 和 key 加密 secret；备份内容
mode 600，校验可读且不得打印 secret。`nginx -t` 通过后才 reload，不 restart。新 vhost 的
server name、证书和 upstream 必须显式核对，禁止影响 `goldencode` vhost。

### 6.7 阶段 G：公网灰度

先签发一个 1 天期临时 smoke key，并从独立公网网络验证：

1. 无 Authorization 和错误 key 均返回 401；
2. `/v1/models` 只返回 `qwen3.8-27b-fp8`；
3. 错误模型返回 404 `model_not_found`；
4. 非流式对话返回 `usage` 和 request ID；
5. SSE 正常输出、以 `[DONE]` 结束，客户端断开能取消上游；
6. 工具调用和 tool-result follow-up 契约正确；
7. 超过 RPM、RPD、并发或 token 限额时返回 429；
8. revoke 后旧 key 立即失效；日志中不存在完整 key、Authorization、prompt 或 response；
9. Nginx 不能转发 `/invocations`、`/metrics`、vLLM `/health` 或任意未列路径；
10. 现有 `goldencode` 公网、loopback、容器 ID、health、restart count 和延迟基线无回归。

临时 smoke key 验收后立即 revoke。随后只给 3 至 5 名内部用户灰度一周；未达到共存和性能
门槛前，不扩大用户数、不提高全局并发、不把上下文从 32K 调到 64K。

## 7. 验收矩阵

### 7.1 模型能力

1. `/health` 和 `/v1/models` 返回成功；
2. 非 thinking 文本请求成功；
3. `reasoning_effort=low/medium/xhigh` 分别可用；
4. streaming 正常结束；
5. required、named、none 和 follow-up 工具调用结构正确；
6. 当前 32K 配置依次验证 8K 和接近 32K 的输入；64K 必须先变更服务配置，再重复完整验收，不能把越界失败误判为模型失败；
7. 若启用视觉层，分别验证单图、多图，并设置图像数量和尺寸上限；
8. 记录 TTFT、prefill tokens/s、decode tokens/s、峰值显存和输出正确性。

### 7.2 资源与共存

必须同时满足：

- GPU 无 Xid/NVRM 错误；
- 32K、并发 2 的当前目标场景不发生 GPU OOM；
- 宿主不出现新增或持续增长的 Swap，`MemAvailable` 保持至少 24GiB；少量既有 Swap 使用量须留档；
- 根分区不因模型或缓存增长；
- `/data` 保持至少 150GB 安全余量；
- 五个现有生产容器仍健康、restart count 不增加；
- `http://127.0.0.1:18787/gateway/health` 和公网
  `https://goldencode.instmarket.com.au:1443/gateway/health` 均正常；
- 不出现新的非批准公网监听；
- 下载、镜像拉取和压力测试不在生产高峰并行执行。

### 7.3 2026-08-23 实际验收结果

最终 BF16 KV 配置的报告位于：

```text
/data/llm-runtime/qwen38-fp8/self-test-report.json
/data/llm-runtime/qwen38-fp8/final-audit.txt
```

| 项目 | 结果 |
| --- | --- |
| `/health`、`/v1/models` | 通过，HTTP 200 |
| 非 thinking 对话 | 0.495 秒，正确返回“FP8本地服务正常。”，usage 完整 |
| SSE | 0.418 秒，TTFE 约 0.18 秒，收到 `[DONE]` 和最终 usage |
| `reasoning_effort=low/medium/xhigh` | 分别约 5.28/3.88/3.99 秒；均在 `message.reasoning` 返回推理内容，答案正确 |
| required tool call + follow-up | 工具名和 JSON 参数正确，工具结果回填后正确输出 21°C |
| named / none tool choice | named 返回正确函数和参数；none 返回 `NO_TOOL` 且无 tool call |
| 8K 输入 | 约 7,988 prompt tokens，2.86 秒，正确完成 |
| 接近 32K 输入 | 约 31,460 prompt tokens，11.94 秒，正确完成，无 OOM |
| 两路并发 | 两个请求均 200，总墙钟 0.393 秒 |
| 新容器 | healthy、restart count 0、OOM=false，只监听 `127.0.0.1:18000` |
| GPU | idle 约 40,162/49,140MiB；长上下文测试利用率可达 100%；无 Xid/NVRM/OOM |
| 宿主 | `MemAvailable` 约 116GiB；Swap 仅约 6MiB；`/data` 清理中间 archive 后约 1.6TiB 可用 |
| 原生产容器 | 五个 ID 和 StartedAt 未变，全部 healthy、restart count 0 |
| 原公网网关 | `https://goldencode.instmarket.com.au:1443/gateway/health` 为 200 |

`http://127.0.0.1:18787/health` 在无凭据探测时返回 401，表示现有 Gateway 可达且鉴权仍生效；
这不是健康下降。最终审计还确认无模型致命日志、NCCL error 或新的公网监听。

已知 OpenAI-compatible 细节：vLLM 0.27.1 对 named tool choice 返回了正确非空 `tool_calls`，但
`finish_reason` 为 `stop`；required tool choice 的 `finish_reason` 正确为 `tool_calls`。阶段 E 的
Gateway 契约测试必须覆盖该差异，并在向公网返回前按非空 `tool_calls` 归一化 finish reason，或升级到
已证明修复该行为的固定 vLLM 版本。不能假设所有 OpenAI SDK 都会忽略这一差异。

### 7.4 不通过条件

出现以下任一项即停止扩大负载并回滚本地模型容器：

- GPU Xid、驱动复位、持续 thermal throttling；
- 生产容器重启或健康下降；
- Gateway/Research 延迟或错误率出现明确回归；
- Swap 持续增长或宿主 `MemAvailable` 低于 24GiB；
- 32K、并发 1 在 `--enforce-eager` 下仍无法稳定运行；
- vLLM 使用非预期的慢速 fallback，导致吞吐无法满足内部交互要求；
- 模型或容器需要修改现有生产网络才能运行。

## 8. 回滚与清理

回滚顺序必须从公网向 GPU 收敛，且不得操作现有 `codex_gateway_r760` project：

1. 禁止继续发 key，并 revoke 全部 Qwen smoke/pilot key；
2. 从 Nginx enabled 配置中撤下 Qwen 独立 vhost，`nginx -t` 后 reload；
3. 验证 Qwen 域名不再到达 Gateway，同时 `goldencode` 仍正常；
4. 停止独立 Qwen Gateway；
5. 等待活动请求归零后停止 vLLM；
6. 保留 SQLite、审计、配置、manifest 和模型权重，等待复盘决定。

仅停止本地推理服务：

```bash
cd /data/llm-runtime/qwen38-fp8
docker compose -p qwen38_fp8_local -f compose.yml down
```

最终双容器 project 的停止命令以获批 Compose 文件为准，建议：

```bash
cd /data/llm-runtime/qwen-api
docker compose -p qwen_api_gateway_r760 -f compose.yml stop qwen-gateway
docker compose -p qwen_api_gateway_r760 -f compose.yml stop qwen38-fp8
```

验证回滚：

```bash
nvidia-smi
ss -lnt | grep ':18000 ' || true
ss -lnt | grep ':18788 ' || true
curl -fsS http://127.0.0.1:18787/gateway/health
docker ps --format '{{.Names}}|{{.Status}}'
```

`down` 不删除模型权重和运行记录。权重目录只有在业务负责人明确批准、确认无部署或复现实验需要后才能另行删除；本方案不授权删除。

下载阶段的回滚只需停止 `qwen38-fp8-download.service`。partial 文件保留以便续传，也不得在未确认精确路径前执行递归删除。

公网回滚时保留 DNS 还是删除 DNS 由域名负责人决定；无论哪种方式，入口必须明确返回不可用，
不得静默回退到 raw vLLM，也不得把流量临时导入 `goldencode` Gateway。

## 9. 上线批准点与后续决策

本文给出了目标架构和操作顺序，但不自动授权公网变更。需要分别批准：

1. 新 `local_openai` runtime 的代码、测试和独立镜像；
2. `qwen-api.instmarket.com.au` 域名、证书和现有 NAT/SNI 复用；
3. Nginx vhost reload 维护窗口；
4. 第一批内部用户名单、key 有效期和配额；
5. 故障告警接收人；本地模型已在完整验收后采用 `unless-stopped`，任何改动仍须单独评审。

完成 32K、并发 2 的稳定验收和一周 32K 公网灰度后，再分别决策：

1. 是否启用视觉编码器；
2. 是否测试 MTP speculative decoding；
3. 是否评估单请求 262K；
4. 是否把对外上下文从 32K 提升到 64K；
5. 是否扩大内部用户数或提高全局并发；
6. 是否增加 `/v1/responses` 等额外兼容接口。

以上扩容项仍属于后续变更。2026-08-24 已单独完成并批准“权威 Gateway/SQLite/统一 Key
复用、Qwen runtime 私网隔离”的重新评审，结果以文首和 1.2 节为准。Doctor Research 未接入
Qwen；raw vLLM 端口仍不得公开。任何进一步扩大上下文、并发、模态或公网接口的方案仍需
重新评审，不能从本次双模型上线自动推导授权。
