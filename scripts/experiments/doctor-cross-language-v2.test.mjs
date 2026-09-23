import assert from 'node:assert/strict';
import test from 'node:test';
import {applyAudit,createBudgetedSearch,createEvidenceBlocks,normalizeSearchResultUrl,parseSelection,resolveCrossLanguageDoctor,validateProposal} from './doctor-cross-language-v2.mjs';

const doctor={name:'李小明',hospital:'示例医院',department:'心内科'};
const source={sourceId:'s1',url:'https://hospital.example/profile',title:'Profile',untrustedText:'李小明在示例医院心内科工作。'};
const blocks=createEvidenceBlocks([source],[doctor.name]);
const id=blocks[0].block_id;
const matched=()=>({status:'matched',match:{person_name:doctor.name,name_relation:'same_name',institution_name:doctor.hospital,department_name:doctor.department,evidence:{person:[id],institution:[id],department:[id],affiliation:[id]},affiliation_status:'unclear',temporal_evidence:[]},reason:'Supported'});
const audit={person_supported:true,institution_supported:true,department_supported:true,affiliation_supported:true,source_supported:true,temporal_supported:true};

test('three-character Chinese name is accepted with real evidence blocks',()=>{
 const proposal=validateProposal(JSON.stringify(matched()),doctor,blocks);
 const verified=applyAudit(proposal,JSON.stringify(audit),blocks);
 assert.equal(verified.status,'matched');
 assert.equal(verified.matches[0].evidence.person[0].quote,source.untrustedText);
});
test('every non-matched status clears all affirmative matches',()=>{
 for(const status of ['not_found','ambiguous']){
  const proposal=validateProposal(JSON.stringify({...matched(),status,matches:[matched().match]}),doctor,blocks);
  assert.equal(proposal.match,null);
  assert.deepEqual(applyAudit(proposal,'{}',blocks).matches,[]);
 }
});
test('a real quotation cannot override a failed department or affiliation audit',()=>{
 const proposal=validateProposal(JSON.stringify(matched()),doctor,blocks);
 for(const field of ['department_supported','institution_supported','affiliation_supported','source_supported']){
  const verified=applyAudit(proposal,JSON.stringify({...audit,[field]:false}),blocks);
  assert.equal(verified.status,'not_found');assert.deepEqual(verified.matches,[]);
 }
});
test('unsupported appointment timing becomes unclear without inventing dates',()=>{
 const value=matched();value.match.affiliation_status='current';value.match.temporal_evidence=[id];value.match.position='Invented chair';value.match.start_date='1999';
 const proposal=validateProposal(JSON.stringify(value),doctor,blocks);
 const verified=applyAudit(proposal,JSON.stringify({...audit,temporal_supported:false}),blocks);
 assert.equal(verified.status,'matched');assert.equal(verified.matches[0].affiliation_status,'unclear');
 assert.equal(verified.matches[0].position,undefined);assert.equal(verified.matches[0].start_date,undefined);
});
test('invented evidence ID and mismatched Latin identity are rejected',()=>{
 const value=matched();value.match.evidence.person=['invented'];
 assert.equal(validateProposal(JSON.stringify(value),doctor,blocks).status,'not_found');
 const latin={...doctor,name:'Example Person'},different=matched();different.match.person_name='Another Person';
 assert.equal(validateProposal(JSON.stringify(different),latin,blocks).status,'not_found');
});
test('invalid optional search host does not discard selected real sources',()=>{
 const selection=parseSelection('{"source_ids":["C1"],"search_host":"invented.example"}',[{candidate_id:'C1'}],['hospital.example']);
 assert.deepEqual(selection.source_ids,['C1']);assert.equal(selection.search_host,null);assert.equal(selection.ignored_unobserved_host,true);
});
test('URL serialization escapes decode before URL validation',()=>{
 assert.equal(normalizeSearchResultUrl('https://hospital.example/profile?id\\u003d42\\u0026lang\\u003den'),'https://hospital.example/profile?id=42&lang=en');
 assert.throws(()=>normalizeSearchResultUrl('http://localhost/private'));
 assert.throws(()=>normalizeSearchResultUrl('https://user:password@hospital.example/'));
});
test('evidence windows preserve final update information and exact source offsets',()=>{
 const long={...source,untrustedText:'李小明 '+('body '.repeat(5000))+' Last updated 2026-09-07'};
 const result=createEvidenceBlocks([long],[doctor.name]);
 assert.ok(result.some(block=>block.text.includes('Last updated 2026-09-07')));
 assert.ok(result.reduce((sum,block)=>sum+block.text.length,0)<=10500);
 for(const block of result)assert.equal(block.text,long.untrustedText.slice(block.start,block.end));
});

test('extra evidence fields cannot escape the identity contract',()=>{
 const value=matched();value.match.evidence.invented_career=['not-a-real-block'];
 const result=applyAudit(validateProposal(JSON.stringify(value),doctor,blocks),JSON.stringify(audit),blocks);
 assert.deepEqual(Object.keys(result.matches[0].evidence),['person','institution','department','affiliation']);
});

test('person token substrings cannot assemble a different identity',()=>{
 const requested={...doctor,name:'Ann Smith'},value=matched();value.match.person_name=requested.name;
 const unrelated=blocks.map(block=>({...block,text:'Annabelle Jones and Robert Smith work in different hospitals.'}));
 assert.equal(validateProposal(JSON.stringify(value),requested,unrelated).status,'not_found');
});

test('malformed optional time evidence drops timing while retaining auditable identity',()=>{
 const value=matched();value.match.affiliation_status='former';value.match.temporal_evidence=['Explanation mentioning '+id];
 const result=validateProposal(JSON.stringify(value),doctor,blocks);
 assert.equal(result.status,'matched');assert.equal(result.match.affiliation_status,'unclear');
 assert.deepEqual(result.match.temporal_evidence,[]);
});

test('incomplete model matches remain unresolved and allow retrieval refinement',()=>{
 const value=matched();value.match.department_name='';value.match.evidence.department=[];
 const result=validateProposal(JSON.stringify(value),doctor,blocks);
 assert.equal(result.status,'not_found');assert.equal(result.match,null);
});

test('shared search cap counts failures and prevents concurrent overspending',async()=>{
 let requests=0;
 const budget=createBudgetedSearch({maximumRequests:2,cachedEntries:[{query:'cached',results:[]}],fetchSearch:async(query)=>{requests++;if(query==='failed')throw Error('network');return [];}});
 await budget.search('cached');assert.equal(requests,0);
 await assert.rejects(budget.search('failed'));
 const results=await Promise.allSettled([budget.search('fresh'),budget.search('fresh'),budget.search('third')]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'fulfilled');
 assert.equal(results[2].reason.code,'experiment_search_budget_exhausted');
 assert.equal(requests,2);assert.equal(budget.usage.new_requests,2);
});

test('search quota failure cannot become a doctor not-found result',async()=>{
 let modelCalls=0;
 await assert.rejects(resolveCrossLanguageDoctor({doctor,signal:AbortSignal.timeout(1000),search:async()=>{const error=Error('quota');error.statusCode=429;throw error;},fetchDocument:async()=>{throw Error('must not fetch');},generate:async()=>{modelCalls++;return {text:JSON.stringify({candidates:[{name:'Example Person',institution:'Example Hospital',department:'Cardiology',language:'en'}]}),usage:{}};}}),error=>{
  assert.equal(error.code,'search_provider_unavailable');assert.equal(error.diagnosticRecord.verification,undefined);
  assert.ok(error.diagnosticRecord.searches.every(item=>item.http_status===429));return true;
 });
 assert.equal(modelCalls,1);
});

test('an identity result does not certify current employment even when models agree',()=>{
 const value=matched();value.match.affiliation_status='current';value.match.temporal_evidence=[id];
 const verified=applyAudit(validateProposal(JSON.stringify(value),doctor,blocks),JSON.stringify(audit),blocks);
 assert.equal(verified.status,'matched');assert.equal(verified.matches[0].affiliation_status,'unclear');
 assert.deepEqual(verified.matches[0].temporal_evidence,[]);
});

test('exhausted optional search still reads cached candidates and requires semantic audit',async()=>{
 for(const supported of [true,false]){
  let fetched=0;
  const results=[{url:source.url,title:'Example profile',snippet:'Doctor at hospital'}];
  const budget=createBudgetedSearch({maximumRequests:0,cachedEntries:[
   {query:'"Example Person" Example Hospital',results},
   {query:'"Example Person" Cardiology profile',results}
  ],fetchSearch:async()=>{assert.fail('No new provider request is allowed');}});
  const run=resolveCrossLanguageDoctor({doctor,signal:AbortSignal.timeout(1000),search:budget.search,
   fetchDocument:async()=>{fetched++;return {...source,untrustedText:source.untrustedText.repeat(4)};},
   generate:async({stage})=>{
    const responses={
     discover_identity:{candidates:[{name:'Example Person',institution:'Example Hospital',department:'Cardiology',language:'en'}]},
     select_identity_sources:{source_ids:['C1'],search_host:'hospital.example'},
     resolve_identity:matched(),resolve_identity_audit:{...audit,department_supported:supported},
     refine_identity_search:{candidates:[]}
    };
    assert.ok(stage in responses,stage);
    return {text:JSON.stringify(responses[stage]),usage:{}};
   }
  });
  if(supported){
   const result=await run;
   assert.equal(result.verification.status,'matched');
   assert.equal(result.searches.filter(item=>item.error_code==='experiment_search_budget_exhausted').length,1);
  }else await assert.rejects(run,error=>{
   assert.equal(error.code,'search_incomplete');
   assert.deepEqual(error.diagnosticRecord.unresolved_verification.matches,[]);return true;
  });
  assert.equal(fetched,1);assert.equal(budget.usage.new_requests,0);
 }
});
