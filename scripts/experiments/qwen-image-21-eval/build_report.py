"""Build a portable comparison report from the original results and visual review."""
import argparse
from html import escape
import json
from pathlib import Path
import statistics

TITLES={'01_photorealism':'雨夜市场写实','02_bilingual_text':'中英双语标题','03_composition':'三色杯构图','04_chinese_poster':'中文科普海报','05_spatial_relations':'数量与空间关系','06_product_label':'产品标签文字','07_illustration':'水彩插画','08_hands_portrait':'人物与双手'}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('artifacts',type=Path)
    args=parser.parse_args()
    root=args.artifacts
    data={}
    for provider in ('llada','qwen'):
        data[provider]=[json.loads(x) for x in (root/f'{provider}-results.jsonl').read_text(encoding='utf-8-sig').splitlines()]
    review_path=root/'visual-review.json'
    reviews=json.loads(review_path.read_text(encoding='utf-8')) if review_path.exists() else {'pairs':[]}
    indexed={(r['test_id'],r['seed']):r for r in reviews['pairs']}
    summary={}
    for provider,rows in data.items():
        compared=[r for r in rows if not r['test_id'].startswith('capability_')]
        successful=[r for r in compared if r.get('http_status')==200]
        durations=[r['elapsed_seconds'] for r in successful]
        summary[provider]={'requests':len(compared),'successes':len(successful),'mean_seconds':statistics.mean(durations),'median_seconds':statistics.median(durations),'min_seconds':min(durations),'max_seconds':max(durations),'peak_board_memory_mib':max(r['peak_gpu_memory_mib'] for r in successful),'max_temperature_c':max(r['max_gpu_temperature_c'] for r in successful)}
        peaks=[r['provider_evaluation']['torch_peak_allocated_mib'] for r in successful if r.get('provider_evaluation')]
        if peaks:
            summary[provider]['peak_torch_allocated_mib']=max(peaks)
    summary['visual_review']=reviews
    (root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    css='''body{margin:0;background:#f3f5f8;color:#16202d;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1500px;margin:auto;padding:28px}h1{font-size:30px;line-height:1.25}h2{margin-top:0}p{max-width:1150px}.card,article{background:white;padding:24px;border-radius:12px;margin:20px 0;box-shadow:0 1px 8px #00000008}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}figure{margin:0;min-width:0}img{width:100%;display:block;background:repeating-conic-gradient(#eee 0% 25%,#fff 0% 50%) 50%/20px 20px;border-radius:5px}figcaption{padding:8px 0;font-weight:600}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #dce3e9}th{background:#eef2f6}.muted{color:#5c6673}.note{background:#edf5ff;padding:12px;border-left:4px solid #3b74ac}details{margin:12px 0}pre{white-space:pre-wrap;word-break:break-word;font:13px/1.6 monospace}.tag{display:inline-block;padding:2px 8px;border-radius:5px;background:#e8eef5;font-size:13px}a{color:#245dab}@media(max-width:800px){main{padding:12px}.pair{grid-template-columns:1fr}.card,article{padding:14px}}'''
    content=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qwen-Image-2.1 与 LLaDA 对比评估</title><style>'+css+'</style><main>']
    content.append('<h1>Qwen-Image-2.1 与 LLaDA-Image-Turbo-FP8</h1><p class="muted">2026-09-22 · star / RTX 6000 Ada 48GB · 私有研究评估</p>')
    content.append('<section class="card"><h2>评估范围与条件</h2><p>8 类提示词 × 2 个固定随机种子；1024×1024；每请求 1 张 PNG；没有提示词改写。两模型使用相同提示词和种子，但相同种子不代表相同初始噪声或构图。</p><p>LLaDA 使用线上现有 FP8 Turbo、4 步、CFG 1，GPU 0 常驻。Qwen 使用官方 BF16、40 步、CFG 1，GPU 1 + 模型 CPU 卸载；GPU 1 同时保留 IndexTTS 的常驻显存。因此耗时反映这两套实际部署配置，不是同精度、同驻留方式的模型架构速度比较。</p><p>耗时为服务器本机 HTTP 请求到完整 JSON/Base64 响应，包含生成和 PNG 编码；预热排除在汇总之外。整卡显存包含同卡其他服务；Qwen 的 PyTorch 分配峰值另行记录。原始 PNG 保留，点击图片可查看全图。</p><p class="note">视觉评价来自单个助手的非盲审查，属于小样本定性评估，不代表独立人类盲测、统计显著性或所有业务场景。</p></section>')
    content.append('<section class="card"><h2>实测性能</h2><table><tr><th>模型</th><th>成功</th><th>平均</th><th>中位数</th><th>范围</th><th>整卡峰值显存</th><th>最高温度</th></tr>')
    for provider,label in [('llada','LLaDA Turbo FP8'),('qwen','Qwen-Image-2.1 BF16')]:
        s=summary[provider]
        content.append(f'<tr><td>{label}</td><td>{s["successes"]}/{s["requests"]}</td><td>{s["mean_seconds"]:.2f}s</td><td>{s["median_seconds"]:.2f}s</td><td>{s["min_seconds"]:.2f}–{s["max_seconds"]:.2f}s</td><td>{s["peak_board_memory_mib"]/1024:.2f} GiB</td><td>{s["max_temperature_c"]:.0f}°C</td></tr>')
    content.append('</table>')
    if 'peak_torch_allocated_mib' in summary['qwen']:
        content.append(f'<p>Qwen 单进程 PyTorch 分配峰值：{summary["qwen"]["peak_torch_allocated_mib"]/1024:.2f} GiB。GPU 1 原有 IndexTTS 约占 8.4 GiB。完整逐请求与 GPU 采样记录见 <a href="summary.json">summary.json</a>、<a href="llada-results.jsonl">LLaDA JSONL</a>、<a href="qwen-results.jsonl">Qwen JSONL</a>。</p>')
    content.append('</section>')
    if reviews.get('conclusion'):
        content.append('<section class="card"><h2>视觉审查结论</h2>'+''.join('<p>'+escape(p)+'</p>' for p in reviews['conclusion'])+'</section>')
    llada={(r['test_id'],r['seed']):r for r in data['llada']}
    qwen={(r['test_id'],r['seed']):r for r in data['qwen']}
    for key,left in llada.items():
        if key not in qwen:
            continue
        right=qwen[key]
        review=indexed.get(key,{})
        content.append('<article><h2>'+escape(TITLES.get(key[0],key[0]))+f' <span class="tag">seed {key[1]}</span></h2><div class="pair">')
        for row,label in [(left,'LLaDA Turbo FP8'),(right,'Qwen-Image-2.1')]:
            path=row['file']
            if not (root/path).exists():
                path=row['provider']+'-review/'+Path(path).stem+'.jpg'
            content.append(f'<figure><a href="{escape(path)}"><img loading="lazy" src="{escape(path)}" alt="{escape(label)}"></a><figcaption>{label} · {row["elapsed_seconds"]:.2f}s</figcaption></figure>')
        content.append('</div>')
        if review:
            content.append('<p class="note">'+escape(review.get('comment',''))+'</p>')
        content.append('<details><summary>提示词、检查标准和结果哈希</summary><pre>'+escape(left['prompt'])+'\n\n'+escape(left.get('criteria') or '')+'\n\nLLaDA SHA256: '+left['sha256']+'\nQwen SHA256: '+right['sha256']+'</pre></details></article>')
    capabilities=[r for r in data['qwen'] if r['test_id'].startswith('capability_') and r.get('http_status')==200]
    if capabilities:
        content.append('<section class="card"><h2>Qwen 附加能力检查</h2><p>以下样本不计入共享文生图比较；当前 LLaDA 公网服务仅提供文生图接口。</p><div class="pair">')
        for row in capabilities:
            path=row['file']
            content.append(f'<figure><a href="{escape(path)}"><img src="{escape(path)}"></a><figcaption>{escape(row["test_id"])} · {row["elapsed_seconds"]:.2f}s</figcaption><p>图像模式 {row["mode"]}；Alpha 范围 {row["alpha_extrema"]}；非完全不透明像素比例 {row["alpha_nonopaque_fraction"]:.2%}</p></figure>')
        content.append('</div></section>')
    content.append('<section class="card"><h2>服务与复现</h2><p>Qwen 服务：star 的 127.0.0.1:8191，systemd 用户单元 qwen-image-21-eval.service。仅用于研究评估，未接入公共 Gateway，未切换现有生图路由。源代码、模型清单与环境版本记录随评估保留。Qwen 使用 Research License；商业服务需要另行授权。</p><p><a href="https://huggingface.co/Qwen/Qwen-Image-2.1">官方模型</a> · <a href="https://github.com/QwenLM/Qwen-Image-2.1/blob/main/LICENSE">Qwen 许可证</a> · <a href="evaluation_plan.json">原始评测计划</a> · <a href="visual-review.json">视觉审查记录</a></p></section></main></html>')
    (root/'comparison.html').write_text('\n'.join(content),encoding='utf-8')
    print(json.dumps({k:v for k,v in summary.items() if k!='visual_review'},ensure_ascii=False,indent=2))

if __name__=='__main__':
    main()
