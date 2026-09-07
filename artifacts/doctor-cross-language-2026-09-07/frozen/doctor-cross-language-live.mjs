// Run inside an isolated container using the existing Research image/network.
// Only read-only secret mounts and a diagnostic output directory are needed.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadResearchWorkerConfig} from '/app/apps/research-worker/dist/config.js';
import {fetchBoundedJson,fetchApprovedWebDocument} from '/app/packages/research-agent/dist/safe-http.js';
import {GatewayResearchModelClient} from '/app/packages/research-agent/dist/model-client.js';
import {resolveCrossLanguageDoctor} from './doctor-cross-language.mjs';

const inputFile=process.argv[2]??'/diagnostic/matrix.json';
const outputFile=process.argv[3]??'/diagnostic/matrix-result.json';
const c=loadResearchWorkerConfig(process.env);
const client=new GatewayResearchModelClient({...c.llm,bearerToken:fs.readFileSync(c.llm.bearerTokenFile,'utf8').trim(),readinessRequirements:{maximumPromptTokensPerCall:c.workflowPolicy.maximumInputTokensPerCall,maximumOutputTokensPerCall:c.workflowPolicy.maximumOutputTokensPerCall,callsPerRun:c.workflowPolicy.budgets.llmCalls,maximumTokensPerRun:c.workflowPolicy.budgets.inputTokens+c.workflowPolicy.budgets.outputTokens}});
const apiKey=fs.readFileSync(c.webSearchApiKeyFile,'utf8').trim();
const data=JSON.parse(fs.readFileSync(inputFile,'utf8'));
const cases=[];
if(Array.isArray(data))data.forEach((doctor,index)=>cases.push({case_id:String(index),doctor}));
else for(const profile of data.profiles)for(const name of data.languages)for(const hospital of data.languages)for(const department of data.languages){
 cases.push({case_id:`${profile.id}-${name}-${hospital}-${department}`,doctor:{name:profile.name[name],hospital:profile.hospital[hospital],department:profile.department[department]},expected_name:profile.name.en,chinese_name_status:profile.chinese_name_status,negative_controls:[name,hospital,department].every(x=>x==='en')});
}
const documentCache=new Map(),results=Array(cases.length).fill(null);
fs.mkdirSync(path.join(path.dirname(outputFile),'sources'),{recursive:true});
const flush=()=>fs.writeFileSync(outputFile,JSON.stringify(results,null,2));
async function runCase(index){
 const item=cases[index],searches=[],runId='drr_'+randomUUID().replaceAll('-','');
 const search=async(query,signal)=>{
  const url=new URL('https://serpapi.com/search.json');url.search=new URLSearchParams({engine:'google',q:query,api_key:apiKey,num:'10'}).toString();
  const response=await fetchBoundedJson({url,signal,timeoutMs:20000,maximumBytes:2000000});const body=response.value;
  if(body.error&&!(body.search_metadata?.status==='Success'&&body.error==="Google hasn't returned any results for this query."))throw Error('search_provider_error');
  const found=(body.organic_results??[]).slice(0,10).map(r=>({title:r.title??'',url:r.link,snippet:r.snippet??''}));searches.push({query,results:found});return found;
 };
 const fetchDocument=async(value,signal)=>{
  const hit=documentCache.has(value);
  if(!hit)documentCache.set(value,(async()=>{
   const url=new URL(value),host=url.hostname.replace(/^www\./u,'');
   const d=await fetchApprovedWebDocument({url,signal,allowedDomains:[host],timeoutMs:10000,maximumBytes:1000000,userAgent:c.adapterOptions.userAgent});
   const source={sourceId:'src_web_'+createHash('sha256').update(d.url).digest('hex').slice(0,24),url:d.url,title:d.title,untrustedText:d.text,contentSha256:d.contentSha256,accessedAt:new Date().toISOString()};
   fs.writeFileSync(path.join(path.dirname(outputFile),'sources',source.contentSha256+'.json'),JSON.stringify(source));return source;
  })());
  return {...await documentCache.get(value),source_cache_hit:hit};
 };
 try{
  const result=await resolveCrossLanguageDoctor({doctor:item.doctor,search,fetchDocument,generate:input=>client.generate({...input,runId}),signal:AbortSignal.timeout(240000),onEvent:e=>console.log(JSON.stringify({case_id:item.case_id,...e})),verifyAgainst:item.negative_controls?[{...item.doctor,hospital:'Unrelated Example Hospital 9XYZ'},{...item.doctor,department:'Ophthalmology'}]:[]});
  // Fixture expected_name is evaluation metadata and is never sent to the model.
  result.sources=result.sources.map(({untrustedText,...source})=>source);
  results[index]={...item,...result,run_id:runId};
 }catch(error){results[index]={...item,...error.diagnosticRecord,error:{name:error.name,code:error.code??null,message:error.message},searches,run_id:runId};}
 flush();console.log(JSON.stringify({case_complete:item.case_id,status:results[index].verification?.status??'error',elapsed_ms:results[index].elapsed_ms,error:results[index].error?.name}));
}
let next=0;
await Promise.all(Array.from({length:2},async()=>{while(next<cases.length){const index=next++;await runCase(index);}}));
console.log(JSON.stringify({total:results.length,matched:results.filter(r=>r.verification?.status==='matched').length,errors:results.filter(r=>r.error).length}));
