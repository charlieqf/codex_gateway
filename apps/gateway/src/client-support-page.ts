export function renderClientSupportPage(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>客户端故障报告</title><style>
body{font:15px system-ui;margin:24px;color:#20242b;background:#f7f8fa}main{max-width:1400px;margin:auto}
input,button{font:inherit;padding:8px;margin:4px;border:1px solid #bdc5d0;border-radius:5px}button{cursor:pointer}
table{border-collapse:collapse;width:100%;background:white}td,th{text-align:left;padding:9px;border-bottom:1px solid #ddd;word-break:break-all}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:16px}#status{min-height:24px}label{display:inline-block}
</style><main><a href="/gateway/admin/client-messages">客户端消息与用量</a><h1>客户端故障报告</h1>
<p>已验证报告按首次提交的账号查询。匿名报告请使用支持编号查询；诊断详情保留 7 天，摘要保留 30 天。未关联到记录不代表请求未到达 Gateway。</p>
<label>管理 Token <input id="token" type="password" autocomplete="off"></label><br>
<label>手机号 <input id="phone" type="tel" autocomplete="off"></label>
<label>支持编号 <input id="report" size="38"></label>
<label>开始时间 <input id="since" type="datetime-local"></label>
<label>结束时间 <input id="until" type="datetime-local"></label><button id="search">查询</button>
<p id="status" role="status"></p><table><thead><tr><th>接收时间</th><th>支持编号 / 故障编号</th><th>归属</th><th>版本 / 操作 / 错误</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table>
<h2>报告详情与 Gateway 关联记录</h2><pre id="detail">选择一条报告查看详情。</pre></main><script>
const el=id=>document.getElementById(id);
const status=text=>{el('status').textContent=text};
async function api(path,body){
 const response=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+el('token').value.trim(),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok){const result=await response.json();throw new Error(result.error?.code||String(response.status))}return response;
}
function button(label,action){const b=document.createElement('button');b.textContent=label;b.onclick=()=>action().catch(e=>status('请求失败：'+e.message));return b}
async function search(){
 const query={limit:100};for(const [input,key] of [['phone','phone'],['report','report_id']]){if(el(input).value.trim())query[key]=el(input).value.trim()}
 for(const key of ['since','until'])if(el(key).value)query[key]=new Date(el(key).value).toISOString();
 status('正在查询…');const data=await(await api('/gateway/admin/client-support/query',query)).json();el('rows').replaceChildren();el('detail').textContent='选择一条报告查看详情。';
 for(const report of data.reports){const tr=document.createElement('tr');
  for(const value of [new Date(report.received_at).toLocaleString(),report.report_id+' / '+report.failure_id,report.identity==='verified'?report.subject_id:'匿名（账号标记未验证）',report.app_version+' / '+report.operation+' / '+report.error_code]){const td=document.createElement('td');td.textContent=value;tr.append(td)}
  const actions=document.createElement('td');actions.append(button('详情',async()=>{const detail=await(await api('/gateway/admin/client-support/query',{report_id:report.report_id})).json();el('detail').textContent=JSON.stringify(detail.reports[0]??null,null,2)}));
  if(report.diagnostics_available)actions.append(button('下载诊断',async()=>{const response=await api('/gateway/admin/client-support/'+report.report_id+'/diagnostics');const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download='support-'+report.report_id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}));
  tr.append(actions);el('rows').append(tr);
 }status('已返回 '+data.reports.length+' 条（最多 100 条）；可缩小时间范围继续查询。');
}
el('search').onclick=()=>search().catch(e=>status('请求失败：'+e.message));
</script></html>`;
}
