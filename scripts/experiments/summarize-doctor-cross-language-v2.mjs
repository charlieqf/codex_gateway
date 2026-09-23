// Mechanical results only; semantic accuracy requires independent review.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const [inputFile,sourceDirectory,outputFile]=process.argv.slice(2);
if(!inputFile||!sourceDirectory||!outputFile)throw Error('Usage: node summarize-doctor-cross-language-v2.mjs result.json sources summary.json');
const results=JSON.parse(fs.readFileSync(inputFile,'utf8'));
const cases=[],integrityErrors=[],counts={};
let inputTokens=0,outputTokens=0,totalTokens=0,modelResponses=0,selectedQuotes=0,blocksChecked=0;
for(const result of results){
 if(!result)continue;
 const sourceMap=new Map(result.sources.map(source=>{
  const file=path.join(sourceDirectory,source.contentSha256+'.json');
  return [source.sourceId,fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null];
 }));
 const check=(block,stage)=>{
  const source=sourceMap.get(block.source_id);
  if(!source||source.url!==block.url||source.untrustedText.slice(block.start,block.end)!==(block.text??block.quote)){
   integrityErrors.push({case_id:result.case_id,stage,block_id:block.block_id});
  }
 };
 for(const [stage,blocks] of Object.entries(result.evidence_snapshots??{final:result.evidence_blocks??[]})){
  for(const block of blocks){check(block,stage);blocksChecked++;}
 }
 for(const match of result.verification?.matches??[])for(const quotes of Object.values(match.evidence))for(const quote of quotes){check(quote,'selected_quote');selectedQuotes++;}
 const status=result.verification?.status??'error';counts[status]=(counts[status]??0)+1;
 for(const call of result.calls??[]){modelResponses++;inputTokens+=call.usage?.promptTokens??0;outputTokens+=call.usage?.completionTokens??0;totalTokens+=call.usage?.totalTokens??0;}
 cases.push({case_id:result.case_id,status,error:result.error??null,elapsed_ms:result.elapsed_ms,model_responses:result.calls?.length??0,search_requests:result.searches?.length??0,readable_sources:result.sources.length,fetch_failures:result.fetch_failures?.length??0,recovery_attempted:!!result.recovery,controls:(result.controls??[]).map(control=>({status:control.verification.status,matches:control.verification.matches?.length??null,reason:control.verification.reason}))});
}
const times=cases.map(item=>item.elapsed_ms).filter(Number.isFinite).sort((a,b)=>a-b);
const groups={};
for(const item of cases){const id=item.case_id.replace(/-(zh|en)-(zh|en)-(zh|en)$/u,'');groups[id]??={total:0,matched:0,errors:0};groups[id].total++;groups[id].matched+=item.status==='matched'?1:0;groups[id].errors+=item.error?1:0;}
const summary={scope:'mechanical_results_not_independent_accuracy',result_sha256:createHash('sha256').update(fs.readFileSync(inputFile)).digest('hex'),scheduled:results.length,completed:cases.length,counts,groups,model_usage:{returned_responses:modelResponses,prompt_tokens:inputTokens,completion_tokens:outputTokens,total_tokens:totalTokens},elapsed_ms:{median:times.length?times[Math.floor(times.length/2)]:null,maximum:times.at(-1)??null},integrity:{checked_blocks:blocksChecked,checked_selected_quotes:selectedQuotes,errors:integrityErrors,raw_html_hash_recomputed:false},cases};
fs.writeFileSync(outputFile,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({completed:summary.completed,counts,groups,model_usage:summary.model_usage,integrity_errors:integrityErrors.length}));
