# AIPAL / PanEcho Gateway v1 客户端契约

契约版本：1，2026-10-01。本文固定客户端开发接口；实际部署、验收及版本另记发布报告。

公网 origin：`https://goldencode.instmarket.com.au:1443`。
前缀：`/gateway/aipal/v1`、`/gateway/panecho/v1`。
所有请求（包括 capabilities 和 source）携带现有用户 `Authorization: Bearer <Key>`。
Gateway 根据真实 Subject 生成 owner；客户端不传 owner、后台 token 或后台地址。
两个服务独立启用、独立额度：试点每用户每 UTC 日 10 个新任务，最多 1 个未完成任务；不扣聊天 token。

## 共同接口

| 方法 / 相对路径 | 成功响应 |
| --- | --- |
| GET /capabilities | 200，schema_version、analysis_profile、available、research_only、retention_seconds、source_path、fields |
| POST /jobs | AIPAL 202、PanEcho 201；相同提交重放 200，返回 job |
| GET /jobs/:id | 200，返回 job |
| POST /jobs/:id/cancel | 202，空 JSON 对象，持久化取消意图 |
| DELETE /jobs/:id | 202，持久化删除意图并立即撤销访问 |
| GET /jobs/:id/result | 200，完成后的结构化结果 JSON |
| GET /jobs/:id/artifacts/:name | 200，原始产物字节，Content-Length / X-Content-SHA256 |
| GET /source | 200，对应后台版本源码 ZIP |

创建必须携带 8–128 字符 `Idempotency-Key`，允许 ASCII 字母、数字及 `_.:-`。
同一服务、Subject、key 的规范化输入相同则返回原任务；输入变化返回 409。
遇到超时或 503，保留原 key 和输入查询/重试；不得自动生成新 key。
已删除或过期的 key 返回 404。后台执行失败不会自动重新推理；用户明确重试时创建新任务。
后台明确拒绝的提交也可能消耗保守的每日提交额度；同一 key 重放不会重复扣次数。

job 字段：`job_id`、`analysis_profile`、`state`、`created_at`、`updated_at`、`expires_at`、
`result_revision`、`progress`，可选 `error`；PanEcho 额外返回 `chunk_bytes`。
时间为 Unix 秒。state 为 uploading、queued、running、completed、failed、cancel_requested、cancelled、deleting、deleted、expired。
只有 completed 的 result_revision=1，并包含不可变 `artifacts:[{name,size,sha256}]`。
progress 的等待阶段可含 `wait_reason`（queued、waiting_memory、waiting_gpu、scheduler_unavailable、recovering）；
按 `poll_after_ms` 轮询，默认 2000 ms。

## AIPAL 创建

profile 固定为 `aipal-adult-research-v1`，输入全部十项原始测量（包括年龄）。

```json
{
  "session_id": "session-example",
  "analysis_profile": "aipal-adult-research-v1",
  "data_policy": "public_or_deidentified",
  "input": {
    "clinical_context": "suspected_acute_leukemia",
    "measurements": {
      "age": {"value": 55, "unit": "years"},
      "WBC_G_L": {"value": 10, "unit": "10^9/L"},
      "Monocytes_G_L": {"value": 0.5, "unit": "10^9/L"},
      "Lymphocytes_G_L": {"value": 1, "unit": "10^9/L"},
      "Platelets_G_L": {"value": 100, "unit": "10^9/L"},
      "MCV_fL": {"value": 90, "unit": "fL"},
      "MCHC_g_L": {"value": 340, "unit": "g/L"},
      "LDH_UI_L": {"value": 300, "unit": "U/L"},
      "Fibrinogen_g_L": {"value": 2.5, "unit": "g/L"},
      "PT_percent": {"value": 80, "unit": "%"}
    }
  }
}
```

禁止未知字段、缺项、非有限数或错误单位；年龄 18–120；WBC 必须大于零；
单核细胞+淋巴细胞不得超过 WBC 的 1.01 倍。PT 秒数、INR 不能替代 PT 百分比。
结果包含 `probabilities:{ALL,AML,APL}`、`highest_probability_class`、测量值及派生单核细胞百分比。
模型没有健康类别，适用范围为成人疑似急性白血病鉴别研究。

## PanEcho 创建和上传

profile 固定为 `panecho-tte-research-v1`。

```json
{
  "session_id": "session-example",
  "analysis_profile": "panecho-tte-research-v1",
  "data_policy": "public_or_deidentified",
  "input": {
    "format": "video_zip",
    "size": 12345,
    "sha256": "替换为完整文件的64位小写SHA256",
    "acquisition": "2d_tte",
    "roi": [0.24, 0.21, 0.78, 0.8]
  }
}
```

format 为 video、video_zip、dicom_zip；多帧 US DICOM 通过 dicom_zip 提交。
最大 512 MiB，固定 8 MiB 分块；ROI 为归一化 [left,top,right,bottom]，必须排除文字标签。
仅接受同一次检查的 2D TTE cine；不进行自动模态识别或自动脱敏。

| 方法 / 相对路径 | 请求 / 响应 |
| --- | --- |
| GET /jobs/:id/input | `{job_id,chunk_bytes,state,parts:[{index,size,sha256}]}`；以后台已接收块为准 |
| PUT /jobs/:id/input/parts/:index | application/octet-stream、精确 Content-Length、X-Chunk-SHA256；返回 `{index,size,sha256}` |
| POST /jobs/:id/input/complete | 空 JSON 对象，202 返回 job；后台校验整文件后自动推理 |

index 从 0 起；除末块外每块为 8388608 字节；相同块重传成功，不同内容返回 409。
不支持 Transfer-Encoding 或 Content-Encoding。断开传输后先查询 input，再补传缺失块。
complete 可重复调用，不能据网络超时重复创建新任务。

结果 `tasks` 固定 40 项，type 为 regression、binary_classification 或 multi-class_classification，
包含名称及相应数值/概率/单位；保留模型来源、ROI、采样和聚合说明。
产物名：AIPAL 为 result.json、report.csv；PanEcho 另有 preview.png。
不使用 CT 的 study/series 或 bundle.json；不要求客户端制作 CT 离线 HTML。

## 错误、下载和保留

统一错误：`{error:{code,message,retryable},request_id}`。
401 为 Key 缺失/无效；非试点 capabilities 返回 available:false，其余操作 503。
未知、跨 Subject、删除或过期任务均 404；输入/状态/幂等冲突 400/409/413/422；额度或并发限制 429；网络和后台不可用 503。
具体 code 包括 invalid_request、missing_measurements、invalid_unit、invalid_value、inconsistent_differential、
idempotency_conflict、state_conflict、hash_mismatch、chunk_conflict、incomplete_upload、result_not_ready、quota_exceeded、queue_full、worker_restarted。
后台错误文本和私有路径不透传。retryable 表示同一操作可重试，不代表可以自动发起新推理。

全部输入、文件和结果访问最多 24 小时；Gateway 短期输入同样清理，控制墓碑不含检验值。
取消/删除先持久化意图；删除立即阻止查询和下载，物理清理由 star 完成。
客户端断开连接不取消已接受的任务，必须调用 cancel。
下载必须来自已完成任务的 artifacts 清单。客户端写临时文件，核验大小及 SHA256 完整一致后再发布；
流中断、超时或散列不匹配时不得展示部分文件。

## 运维配置

分别使用 GATEWAY_AIPAL_* / GATEWAY_PANECHO_*：MODE（off/pilot）、SUBJECT_IDS、SQLITE_PATH、
STAR_URL、STAR_CA_FILE、STAR_TOKEN_FILE、DAILY_JOBS、ACTIVE_JOBS、CONTROL_TIMEOUT_MS、TRANSFER_TIMEOUT_MS。
默认 off；配置错误只关闭对应服务。独立数据库不得指向 identity/client-events/CT 或另一临床服务数据库。
固定 HTTPS 目的地址、证书验证、独立后台凭据；Nginx 和应用日志脱敏覆盖两组完整路径及查询。
临床数据库包含短期输入，不纳入长期每日/每周备份；发布备份需执行相同输入保留策略。
