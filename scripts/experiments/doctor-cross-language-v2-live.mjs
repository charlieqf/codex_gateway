// Run only in the isolated Research-image diagnostic container.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadResearchWorkerConfig} from '/app/apps/research-worker/dist/config.js';
import {fetchBoundedJson,fetchApprovedWebDocument} from '/app/packages/research-agent/dist/safe-http.js';
import {GatewayResearchModelClient} from '/app/packages/research-agent/dist/model-client.js';
import {createBudgetedSearch,resolveCrossLanguageDoctor} from './doctor-cross-language-v2.mjs';

const inputFile=process.argv[2]??'/diagnostic/matrix.json';
const outputFile=process.argv[3]??'/diagnostic/result.json';
const config=loadResearchWorkerConfig(process.env);
const client=new GatewayResearchModelClient({...config.llm,bearerToken:fs.readFileSync(config.llm.bearerTokenFile,'utf8').trim(),readinessRequirements:{maximumPromptTokensPerCall:config.workflowPolicy.maximumInputTokensPerCall,maximumOutputTokensPerCall:config.workflowPolicy.maximumOutputTokensPerCall,callsPerRun:config.workflowPolicy.budgets.llmCalls,maximumTokensPerRun:config.workflowPolicy.budgets.inputTokens+config.workflowPolicy.budgets.outputTokens}});
const apiKey=fs.readFileSync(config.webSearchApiKeyFile,'utf8').trim();
const data=JSON.parse(fs.readFileSync(inputFile,'utf8'));
const cases=[];
if(Array.isArray(data))data.forEach((doctor,index)=>cases.push({case_id:'pilot'+index,doctor}));
else if(Array.isArray(data.cases))cases.push(...data.cases);
else for(const profile of data.profiles)for(const name of data.languages)for(const hospital of data.languages)for(const department of data.languages){
 cases.push({case_id:`${profile.id}-${name}-${hospital}-${department}`,doctor:{name:profile.name[name],hospital:profile.hospital[hospital],department:profile.department[department]},negative_controls:[name,hospital,department].every(x=>x==='en')});
}
const resumeFile=path.join(path.dirname(inputFile),'resume-result.json');
const results=fs.existsSync(resumeFile)?JSON.parse(fs.readFileSync(resumeFile,'utf8')):Array(cases.length).fill(null),sourceRoot=path.join(path.dirname(outputFile),'sources');
if(results.length!==cases.length||results.some((result,index)=>result&&result.case_id!==cases[index].case_id))throw Error('resume_input_mismatch');
fs.mkdirSync(sourceRoot,{recursive:true});
const hashes=Object.fromEntries(['doctor-cross-language-v2.mjs','doctor-cross-language-v2-live.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(new URL(file,import.meta.url))).digest('hex')]));
const bootstrapFile=path.join(path.dirname(inputFile),'retrieval-cache.json');
const bootstrap=fs.existsSync(bootstrapFile)?JSON.parse(fs.readFileSync(bootstrapFile,'utf8')):{searches:[],sources:[]};
const documentCache=new Map(bootstrap.sources.map(source=>[source.url,source]));
const budget=createBudgetedSearch({cachedEntries:bootstrap.searches,maximumRequests:data.maximum_new_search_requests??20,onUsage:usage=>fs.writeFileSync(path.join(path.dirname(outputFile),'search-usage.json'),JSON.stringify(usage)),fetchSearch:async(query,signal)=>{
 const url=new URL('https://serpapi.com/search.json');url.search=new URLSearchParams({engine:'google',q:query,api_key:apiKey,num:'10'}).toString();
 const response=await fetchBoundedJson({url,signal,timeoutMs:20000,maximumBytes:2000000}),body=response.value;
 if(body.error&&!(body.search_metadata?.status==='Success'&&body.error==="Google hasn't returned any results for this query."))throw Error('search_provider_error');
 return (body.organic_results??[]).slice(0,10).map(result=>({title:result.title??'',url:result.link,snippet:result.snippet??''}));
}});
async function runCase(index){
 if(results[index])return;
 const item=cases[index],runId='drr_'+randomUUID().replaceAll('-','');
 const search=budget.search;
 const fetchDocument=async(value,signal)=>{
  if(documentCache.has(value)){
   const source=documentCache.get(value);
   fs.writeFileSync(path.join(sourceRoot,source.contentSha256+'.json'),JSON.stringify(source));
   return {...source,source_cache_hit:true};
  }
  const url=new URL(value),document=await fetchApprovedWebDocument({url,signal,allowedDomains:[url.hostname.replace(/^www\./u,'')],timeoutMs:10000,maximumBytes:1000000,userAgent:config.adapterOptions.userAgent});
  const source={sourceId:'src_web_'+createHash('sha256').update(document.url).digest('hex').slice(0,24),url:document.url,title:document.title,untrustedText:document.text,contentSha256:document.contentSha256,accessedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(sourceRoot,source.contentSha256+'.json'),JSON.stringify(source));
  documentCache.set(value,source);return {...source,source_cache_hit:false};
 };
 try{
  const result=await resolveCrossLanguageDoctor({doctor:item.doctor,search,fetchDocument,generate:input=>client.generate({...input,runId}),signal:AbortSignal.timeout(360000),onEvent:event=>console.log(JSON.stringify({case_id:item.case_id,...event})),verifyAgainst:item.negative_controls?[{...item.doctor,hospital:'Unrelated Example Hospital 9XYZ'},{...item.doctor,department:'Ophthalmology'}]:[]});
  result.sources=result.sources.map(({untrustedText,...source})=>source);
  results[index]={...item,...result,run_id:runId,implementation_sha256:hashes};
 }catch(error){results[index]={...item,...error.diagnosticRecord,error:{name:error.name,code:error.code??null,message:error.message},run_id:runId,implementation_sha256:hashes};}
 fs.writeFileSync(outputFile,JSON.stringify(results,null,2));
 console.log(JSON.stringify({case_complete:item.case_id,status:results[index].verification?.status??'error',elapsed_ms:results[index].elapsed_ms,error:results[index].error?.name}));
}
let next=0;
const boundaries=data.sealed_case_count?[data.sealed_case_count,cases.length]:[cases.length];
for(const boundary of boundaries)await Promise.all(Array.from({length:2},async()=>{while(next<boundary){const index=next++;await runCase(index);}}));
console.log(JSON.stringify({total:results.length,matched:results.filter(result=>result.verification?.status==='matched').length,errors:results.filter(result=>result.error).length,search_usage:budget.usage}));
