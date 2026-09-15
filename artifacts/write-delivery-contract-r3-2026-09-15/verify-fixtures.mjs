import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {hash,bytes,encode,registry,envelopeCheck,inspectHeaders,responseCheck} from './contract-checks.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=n=>fs.readFileSync(path.join(root,n),'utf8');
const example=JSON.parse(read('success.example.json'));
const fresh=()=>({sse:read('success.sse'),request:{...structuredClone(example.request_context),headers:structuredClone(example.request_headers)},response:{...structuredClone(example.response_context),headers:structuredClone(example.response_headers)},trust:structuredClone(example.trust_context)});
const manifest=i=>JSON.parse(Buffer.from(i.response.headers['X-MedCode-Write-Delivery-Manifest'],'base64url').toString('utf8'));
function updateManifest(i,edit){const m=manifest(i);edit(m);i.response.headers['X-MedCode-Write-Delivery-Manifest']=encode(m);}
function updateLimits(i,side,edit){
 const key=side==='request'?'X-MedCode-Write-Delivery-Limits':'X-MedCode-Accepted-Write-Delivery-Limits';
 const value=JSON.parse(Buffer.from(i[side].headers[key],'base64url').toString('utf8'));edit(value);i[side].headers[key]=encode(value);
}
function events(i){return i.sse.split(/\r?\n\r?\n/).filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));}
function eventBody(i,es){i.sse=es.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n';}
function raw(i,args,split=Math.floor(args.length/2)){
 const es=events(i);es[0].choices[0].delta.tool_calls[0].function.arguments=args.slice(0,split);es[1].choices[0].delta.tool_calls[0].function.arguments=args.slice(split);
 eventBody(i,es);updateManifest(i,m=>{m.arguments_sha256=hash(args);});return i;
}
function editEnvelope(i,edit){const e=structuredClone(example.envelope);edit(e);return raw(i,JSON.stringify(e));}
let passed=0;const results=[];const reviewEvidence={};
function check(name,f){f();passed++;results.push({name,status:'passed'});}
function rejects(name,edit,pattern){check(name,()=>{const i=fresh();edit(i);assert.throws(()=>responseCheck(i),pattern);});}
check('valid full SSE, identity and original usage',()=>{const out=responseCheck(fresh());assert.equal(out.payload,'abc');assert.deepEqual(out.usage,example.upstream_usage_example);});
check('fixed receiver schema bytes',()=>assert.equal(hash(fs.readFileSync(path.join(root,registry.schema_file))),'57b561afab26d73faa7f91908d35195767162fa3cc734ab547faf02b5df9fa11'));
check('local receiver absent from actual request tools',()=>{assert.ok(example.sdk_registered_tools.some(t=>t.function.name==='write_delivery_v1'));assert.deepEqual(example.request_body.tools.map(t=>t.function.name),['write']);assert.deepEqual(example.sdk_active_tools,['write']);assert.ok(!JSON.stringify(example.request_body).includes('write_delivery_v1'));});
check('request schema hash points to registered file',()=>assert.equal(example.request_headers['X-MedCode-Write-Delivery-Schema-SHA256'],registry.schema_sha256));
check('headers use accepted effective limits',()=>assert.deepEqual(inspectHeaders(fresh()).limits,example.limits));
check('append and middle logical chunk remain distinct',()=>{const i=editEnvelope(fresh(),e=>{e.operation='append';e.original_arguments.mode='append';e.original_arguments.chunk={index:2,total:3};});const out=responseCheck(i);assert.equal(out.payload,'abc');assert.deepEqual(out.envelope.original_arguments.chunk,{index:2,total:3});});
check('Unicode BOM escaping preserved',()=>{const i=editEnvelope(fresh(),e=>{const a='\ufeff中😀',b='\\n"end';e.chunks=[{transport_chunk_index:0,offset_bytes:0,content:a},{transport_chunk_index:1,offset_bytes:bytes(a),content:b}];e.payload_utf8_bytes=bytes(a+b);e.payload_sha256=hash(a+b);});assert.equal(responseCheck(i).payload,'\ufeff中😀\\n"end');});
check('surrogate pair split across argument deltas counted correctly',()=>{const e=structuredClone(example.envelope);e.chunks[0].content='😀';e.chunks[1].offset_bytes=4;e.payload_utf8_bytes=5;e.payload_sha256=hash('😀c');const s=JSON.stringify(e),i=raw(fresh(),s,s.indexOf('😀')+1);assert.equal(responseCheck(i).arguments_utf8_bytes,bytes(s));assert.equal(responseCheck(i).payload,'😀c');});
check('ordinary response does not consume body',()=>{const i=fresh();delete i.response.headers['X-MedCode-Write-Delivery-Manifest'];Object.defineProperty(i,'sse',{get(){throw Error('ordinary body consumed');}});assert.deepEqual(responseCheck(i),{kind:'ordinary'});});
check('accepted capability without manifest still does not consume body',()=>{const i=fresh();delete i.response.headers['X-MedCode-Write-Delivery-Manifest'];assert.equal(i.response.headers['X-MedCode-Accepted-Capabilities'],'write-delivery-v1');Object.defineProperty(i,'sse',{get(){throw Error('accepted ordinary body consumed');}});assert.equal(responseCheck(i).kind,'ordinary');});
check('header checks run before body inspection',()=>{const i=fresh();i.response.headers['X-Request-Id']='wrong';Object.defineProperty(i,'sse',{get(){throw Error('body consumed before headers');}});assert.throws(()=>responseCheck(i),/response request ID mismatch/);});
check('explicit length failure stops automatic model repair only in fixture',()=>{const e=JSON.parse(read('a-content-too-long.error.json')).error;assert.equal(e.code,'tool_call_validation_failed');assert.equal(e.automatic_retry_allowed,false);assert.equal(e.transformed_retry_allowed,false);assert.equal(e.retryable,false);});
check('R2 review: padded raw arguments exceed 8MiB with valid manifest hash',()=>{
 const i=fresh(),s=' '.repeat(8388608)+example.arguments_string;raw(i,s,Math.floor(s.length/2));
 reviewEvidence.padded_arguments={arguments_utf8_bytes:bytes(s),response_body_bytes:bytes(i.sse),response_below_12MiB:bytes(i.sse)<12582912,manifest_hash_valid:manifest(i).arguments_sha256===hash(s)};
 assert.ok(reviewEvidence.padded_arguments.response_below_12MiB);assert.throws(()=>responseCheck(i),/raw arguments UTF8 limit exceeded/);
});
rejects('R2 review: manifest request_id differs from actual X-Request-Id',i=>updateManifest(i,m=>{m.request_id='req-other';}),/response request ID mismatch/);
rejects('R2 review: two index-zero choices in same event',i=>{const es=events(i);es[0].choices.push({index:0,delta:{content:'second choice'},finish_reason:null});eventBody(i,es);},/multiple choices/);
rejects('actual response X-Request-Id mismatch',i=>{i.response.headers['X-Request-Id']='req-wrong';},/response request ID mismatch/);
rejects('accepted version mismatch',i=>{i.response.headers['X-MedCode-Accepted-Write-Delivery-Version']='2';},/accepted version/);
rejects('request version mismatch',i=>{i.request.headers['X-MedCode-Write-Delivery-Version']='2';},/request version/);
rejects('accepted capability missing',i=>{delete i.response.headers['X-MedCode-Accepted-Capabilities'];},/accepted capability/);
rejects('request capability missing',i=>{delete i.request.headers['X-MedCode-Client-Capabilities'];},/request capability/);
rejects('unknown schema digest',i=>{i.request.headers['X-MedCode-Write-Delivery-Schema-SHA256']='0'.repeat(64);},/unknown schema digest/);
rejects('stale nonce after actual HTTP resend',i=>{i.request.headers['X-MedCode-Write-Delivery-Nonce']='c29tZS1uZXctcmVxdWVzdA';},/response nonce mismatch/);
rejects('response nonce mismatch',i=>updateManifest(i,m=>{m.request_nonce='b'.repeat(22);}),/response nonce mismatch/);
rejects('trusted subject mismatch',i=>{i.request.subject_id='subj-other';},/trusted subject/);
rejects('request origin mismatch',i=>{i.request.url='https://other.invalid/v1/chat/completions';},/request trusted origin/);
rejects('redirected response origin mismatch',i=>{i.response.url='https://other.invalid/v1/chat/completions';},/response trusted origin/);
rejects('request session mismatch',i=>{i.request.headers['X-MedCode-Client-Session-Id']='other';},/request session/);
rejects('manifest turn mismatch',i=>updateManifest(i,m=>{m.client_turn_id='other';}),/manifest turn/);
rejects('manifest argument digest mismatch',i=>updateManifest(i,m=>{m.arguments_sha256='0'.repeat(64);}),/arguments hash mismatch/);
rejects('manifest delivery identity mismatch',i=>updateManifest(i,m=>{m.delivery_id='other';}));
rejects('missing response limits',i=>{delete i.response.headers['X-MedCode-Accepted-Write-Delivery-Limits'];});
rejects('invalid limit keys',i=>updateLimits(i,'response',l=>{delete l.chunk_count;}),/limit keys/);
rejects('invalid zero limit',i=>updateLimits(i,'response',l=>{l.chunk_count=0;}),/invalid limit/);
rejects('accepted limit greater than request',i=>{updateLimits(i,'request',l=>{l.payload_utf8_bytes=2;});updateLimits(i,'response',l=>{l.payload_utf8_bytes=3;});},/accepted limit exceeds/);
rejects('accepted limit greater than schema registry',i=>{updateLimits(i,'request',l=>{l.payload_utf8_bytes+=1;});updateLimits(i,'response',l=>{l.payload_utf8_bytes+=1;});},/accepted limit exceeds/);
rejects('accepted limit greater than receiver local limit',i=>{i.localLimits={...registry.limits,payload_utf8_bytes:2};},/accepted limit exceeds/);
rejects('actual payload exceeds negotiated lower limit',i=>updateLimits(i,'response',l=>{l.payload_utf8_bytes=2;}),/effective payload limit/);
rejects('actual raw arguments exceed negotiated lower limit',i=>updateLimits(i,'response',l=>{l.arguments_utf8_bytes=bytes(example.arguments_string)-1;}),/raw arguments UTF8 limit/);
rejects('actual response exceeds negotiated lower limit',i=>updateLimits(i,'response',l=>{l.response_body_bytes=bytes(i.sse)-1;}),/effective response body limit/);
rejects('actual chunk count exceeds negotiated lower limit',i=>updateLimits(i,'response',l=>{l.chunk_count=1;}),/effective chunk count/);
rejects('actual UTF16 chunk exceeds negotiated lower limit',i=>updateLimits(i,'response',l=>{l.chunk_utf16_units=1;}),/UTF16 chunk limit/);
rejects('actual serialized chunk exceeds negotiated lower limit',i=>updateLimits(i,'response',l=>{l.chunk_json_utf8_bytes=1;}),/chunk JSON limit/);
rejects('missing transport chunk',i=>editEnvelope(i,e=>{e.chunks.pop();}));
rejects('out-of-order transport chunks',i=>editEnvelope(i,e=>{e.chunks.reverse();}));
rejects('duplicate transport index',i=>editEnvelope(i,e=>{e.chunks[1].transport_chunk_index=0;}));
rejects('wrong offset',i=>editEnvelope(i,e=>{e.chunks[1].offset_bytes=1;}));
rejects('wrong payload hash',i=>editEnvelope(i,e=>{e.payload_sha256='0'.repeat(64);}),/payload hash/);
rejects('operation mismatch',i=>editEnvelope(i,e=>{e.operation='append';}),/operation mismatch/);
rejects('unsupported original done',i=>editEnvelope(i,e=>{e.original_arguments.done=true;}));
rejects('unpaired payload surrogate',i=>editEnvelope(i,e=>{e.chunks[0].content='\ud800';}),/unpaired surrogate/);
rejects('UTF16 limit differs from JSON Schema codepoints',i=>editEnvelope(i,e=>{e.chunks[0].content='😀'.repeat(2001);}),/UTF16 chunk limit/);
rejects('missing DONE',i=>{i.sse=i.sse.replace('data: [DONE]\n\n','');},/incomplete response/);
rejects('DONE before tool finish',i=>{const es=events(i);es.splice(2,1);eventBody(i,es);});
rejects('data after DONE',i=>{i.sse+='data: {}\n\n';},/data after DONE/);
rejects('second tool in same event',i=>{const es=events(i);es[0].choices[0].delta.tool_calls.push({index:1,id:'other',function:{name:'write',arguments:'{}'}});eventBody(i,es);},/single tool delta/);
rejects('wrong choice index',i=>{const es=events(i);es[0].choices[0].index=1;eventBody(i,es);},/choice identity/);
rejects('empty choices without usage',i=>{const es=events(i);delete es[3].usage;eventBody(i,es);},/invalid\/duplicate usage/);
rejects('duplicate usage event',i=>{const es=events(i);es.push(structuredClone(es[3]));eventBody(i,es);},/invalid\/duplicate usage/);
rejects('choice event after finish',i=>{const es=events(i);es.splice(3,0,{...es[0],choices:[{index:0,delta:{content:'late'},finish_reason:null}]});eventBody(i,es);},/choice after finish/);
rejects('truncated arguments with matching hash',i=>raw(i,example.arguments_string.slice(0,-1)));
process.stdout.write(JSON.stringify({passed,review_regression_evidence:reviewEvidence,results,scope:'R3 contract fixture checks; not the production receiver, actual TLS, SDK/file transaction, HTTP middleware or load test'},null,2)+'\n');
