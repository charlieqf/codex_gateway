// Development contract validator for fixtures. This is not the production streaming adapter.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
const root=path.dirname(fileURLToPath(import.meta.url));
export const hash=s=>createHash('sha256').update(s,'utf8').digest('hex');
export const bytes=s=>Buffer.byteLength(s,'utf8');
export const encode=o=>Buffer.from(JSON.stringify(o),'utf8').toString('base64url');
export const registry=JSON.parse(fs.readFileSync(path.join(root,'schema-registry.json'),'utf8'));
const schemaBytes=fs.readFileSync(path.join(root,registry.schema_file));
assert.equal(hash(schemaBytes),registry.schema_sha256,'registered schema file bytes changed');
const ajv=new Ajv({allErrors:true,strict:false});
const validateEnvelope=ajv.compile(JSON.parse(schemaBytes.toString('utf8')));
const validateManifest=ajv.compile(JSON.parse(fs.readFileSync(path.join(root,'delivery-manifest.schema.json'),'utf8')));
const limitKeys=Object.keys(registry.limits).sort();
function decode(s,maxBytes){
 assert.ok(typeof s==='string'&&s.length<=Math.ceil(maxBytes*4/3)+4&&/^[A-Za-z0-9_-]+$/.test(s),'invalid encoded header');
 const b=Buffer.from(s,'base64url');assert.equal(b.toString('base64url'),s,'noncanonical header encoding');
 assert.ok(b.length<=maxBytes,'header limit');
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
}
function limits(value){
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),limitKeys,'limit keys');
 for(const k of limitKeys)assert.ok(Number.isSafeInteger(value[k])&&value[k]>0,'invalid limit '+k);
 return value;
}
function capability(h,name){return (h.get(name)??'').split(',').map(x=>x.trim()).includes(registry.capability);}
export function inspectHeaders({request,response,trust,localLimits=registry.limits}){
 const req=new Headers(request.headers),res=new Headers(response.headers);
 if(!res.has('X-MedCode-Write-Delivery-Manifest'))return {kind:'ordinary'};
 assert.equal(response.status,200,'S HTTP status');
 assert.equal(new URL(request.url).origin,trust.origin,'request trusted origin');
 assert.equal(new URL(response.url).origin,trust.origin,'response trusted origin');
 assert.equal(new URL(request.url).protocol,'https:','HTTPS request required');
 assert.equal(new URL(response.url).protocol,'https:','HTTPS response required');
 assert.equal(request.subject_id,trust.subject_id,'trusted subject mismatch');
 assert.ok(trust.subject_id&&trust.client_session_id&&trust.client_turn_id);
 assert.equal(req.get('X-MedCode-Client-Session-Id'),trust.client_session_id,'request session');
 assert.equal(req.get('X-MedCode-Client-Turn-Id'),trust.client_turn_id,'request turn');
 assert.ok(capability(req,'X-MedCode-Client-Capabilities'),'request capability');
 assert.ok(capability(res,'X-MedCode-Accepted-Capabilities'),'accepted capability');
 assert.equal(req.get('X-MedCode-Write-Delivery-Version'),'1','request version');
 assert.equal(res.get('X-MedCode-Accepted-Write-Delivery-Version'),'1','accepted version');
 assert.equal(req.get('X-MedCode-Write-Delivery-Schema-SHA256'),registry.schema_sha256,'unknown schema digest');
 assert.equal((res.get('Content-Type')??'').split(';')[0].trim().toLowerCase(),'text/event-stream','S content type');
 const offered=limits(decode(req.get('X-MedCode-Write-Delivery-Limits'),2048));
 const accepted=limits(decode(res.get('X-MedCode-Accepted-Write-Delivery-Limits'),2048));
 limits(localLimits);
 for(const k of limitKeys)assert.ok(accepted[k]<=Math.min(offered[k],localLimits[k],registry.limits[k]),'accepted limit exceeds request/local/schema '+k);
 const manifest=decode(res.get('X-MedCode-Write-Delivery-Manifest'),4096);
 assert.ok(validateManifest(manifest),JSON.stringify(validateManifest.errors));
 const nonce=req.get('X-MedCode-Write-Delivery-Nonce')??'';
 assert.ok(/^[A-Za-z0-9_-]{22,64}$/.test(nonce),'nonce format');
 const nonceBytes=Buffer.from(nonce,'base64url');
 assert.ok(nonceBytes.length>=16&&nonceBytes.toString('base64url')===nonce,'nonce bytes');
 assert.equal(manifest.request_nonce,nonce,'response nonce mismatch');
 assert.equal(manifest.request_id,res.get('X-Request-Id'),'response request ID mismatch');
 assert.equal(manifest.client_session_id,trust.client_session_id,'manifest session');
 assert.equal(manifest.client_turn_id,trust.client_turn_id,'manifest turn');
 assert.equal(manifest.tool_name,registry.tool_name,'manifest tool name');
 return {kind:'delivery',manifest,limits:accepted};
}
export function validUnicode(s){
 for(let i=0;i<s.length;i++){
  const c=s.charCodeAt(i);
  if(c>=0xd800&&c<=0xdbff){const n=s.charCodeAt(++i);assert.ok(n>=0xdc00&&n<=0xdfff,'unpaired surrogate');}
  else assert.ok(c<0xdc00||c>0xdfff,'unpaired surrogate');
 }
}
export function envelopeCheck(e,effective=registry.limits){
 limits(effective);assert.ok(validateEnvelope(e),JSON.stringify(validateEnvelope.errors));
 assert.equal(e.operation,e.original_arguments.mode??'overwrite','operation mismatch');
 if(e.original_arguments.chunk?.total!==undefined)assert.ok(e.original_arguments.chunk.index<=e.original_arguments.chunk.total);
 assert.equal(e.transport_chunk_count,e.chunks.length);
 assert.ok(e.chunks.length<=effective.chunk_count,'effective chunk count');
 let payload='',offset=0;
 e.chunks.forEach((c,i)=>{
  assert.equal(c.transport_chunk_index,i,'transport index');assert.equal(c.offset_bytes,offset,'offset');
  validUnicode(c.content);assert.ok(c.content.length<=effective.chunk_utf16_units,'UTF16 chunk limit');
  assert.ok(bytes(JSON.stringify(c))<=effective.chunk_json_utf8_bytes,'chunk JSON limit');
  offset+=bytes(c.content);assert.ok(offset<=effective.payload_utf8_bytes,'effective payload limit');payload+=c.content;
 });
 assert.equal(e.payload_utf8_bytes,offset,'payload byte count');assert.equal(e.payload_sha256,hash(payload),'payload hash');
 return payload;
}
// Counts actual decoded argument-string UTF-8 bytes across deltas, including whitespace.
// A surrogate pair split between deltas is counted once, without replacement characters.
function appendArguments(state,part,maximum){
 assert.equal(typeof part,'string','arguments delta must be a string');
 for(let i=0;i<part.length;i++){
  const c=part.charCodeAt(i);
  if(state.high){assert.ok(c>=0xdc00&&c<=0xdfff,'unpaired argument surrogate');state.high=false;state.bytes+=4;}
  else if(c>=0xd800&&c<=0xdbff){state.high=true;}
  else {assert.ok(c<0xdc00||c>0xdfff,'unpaired argument surrogate');state.bytes+=c<0x80?1:c<0x800?2:3;}
  assert.ok(state.bytes<=maximum,'raw arguments UTF8 limit exceeded');
 }
 state.parts.push(part);
}
export function responseCheck(input){
 const accepted=inspectHeaders(input);
 // This return must not inspect or consume an ordinary response body.
 if(accepted.kind==='ordinary')return accepted;
 assert.equal(typeof input.sse,'string','fixture body expected');
 const {manifest,limits:effective}=accepted;
 assert.ok(bytes(input.sse)<=effective.response_body_bytes,'effective response body limit');
 const state={parts:[],bytes:0,high:false};
 let id,name,done=false,finish=false,usage,completionID,model;
 let callSeen=false,roleSeen=false;
 for(const block of input.sse.split(/\r?\n\r?\n/).filter(x=>x.trim())){
  const lines=block.split(/\r?\n/).filter(x=>x.length&&!x.startsWith(':'));
  if(!lines.length)continue;
  assert.ok(!done,'data after DONE');
  assert.ok(lines.every(l=>l.startsWith('data:')),'unsupported S event field');
  const data=lines.map(l=>l.slice(5).replace(/^ /,'')).join('\n');
  if(data==='[DONE]'){assert.ok(finish,'DONE before finish');done=true;continue;}
  const event=JSON.parse(data);
  assert.ok(event&&typeof event==='object'&&!Array.isArray(event));
  assert.equal(event.object,'chat.completion.chunk');
  assert.ok(typeof event.id==='string'&&event.id.length>0);
  assert.ok(typeof event.model==='string'&&event.model.length>0);
  if(completionID===undefined){completionID=event.id;model=event.model;}
  assert.equal(event.id,completionID,'completion ID changed');assert.equal(event.model,model,'model changed');
  assert.ok(Array.isArray(event.choices),'choices array required');
  assert.ok(event.choices.length<=1,'multiple choices in one event');
  if(event.choices.length===0){
   assert.ok(finish,'usage event before finish');
   assert.ok(usage===undefined&&event.usage&&typeof event.usage==='object','invalid/duplicate usage event');
   for(const k of ['prompt_tokens','completion_tokens','total_tokens'])assert.ok(Number.isSafeInteger(event.usage[k])&&event.usage[k]>=0,'invalid usage');
   usage=event.usage;continue;
  }
  assert.ok(event.usage===undefined||event.usage===null,'usage must use its own empty-choices event');
  assert.ok(!finish,'choice after finish');
  const choice=event.choices[0];assert.equal(choice.index,0,'choice identity');
  assert.ok(choice.delta&&typeof choice.delta==='object'&&!Array.isArray(choice.delta),'delta object');
  const delta=choice.delta;
  assert.ok(Object.keys(delta).every(k=>['role','content','tool_calls'].includes(k)),'unknown S delta');
  if(delta.role!==undefined){assert.equal(delta.role,'assistant');assert.ok(!roleSeen,'duplicate role');roleSeen=true;}
  if(delta.content!==undefined&&delta.content!==null)assert.equal(typeof delta.content,'string');
  if(delta.tool_calls!==undefined){
   assert.ok(Array.isArray(delta.tool_calls)&&delta.tool_calls.length===1,'single tool delta required');
   const call=delta.tool_calls[0];assert.equal(call.index,0,'extra tool identity');callSeen=true;
   assert.ok(call.function&&typeof call.function==='object'&&!Array.isArray(call.function));
   if(call.id!==undefined){assert.ok(id===undefined,'duplicate tool ID');assert.ok(typeof call.id==='string'&&call.id.length);id=call.id;}
   if(call.type!==undefined)assert.equal(call.type,'function');
   if(call.function.name!==undefined){assert.ok(name===undefined,'duplicate tool name');name=call.function.name;assert.equal(name,registry.tool_name,'non-receiver tool');}
   assert.ok(id&&name,'argument delta before tool identity');
   if(call.function.arguments!==undefined)appendArguments(state,call.function.arguments,effective.arguments_utf8_bytes);
  }
  if(choice.finish_reason!==undefined&&choice.finish_reason!==null){
   assert.equal(choice.finish_reason,'tool_calls');assert.ok(callSeen&&id&&name,'finish without tool');finish=true;
  }
 }
 assert.ok(done&&finish&&callSeen,'incomplete response');assert.ok(!state.high,'unpaired final argument surrogate');
 assert.equal(id,manifest.tool_call_id,'call ID binding');assert.equal(name,manifest.tool_name);
 const args=state.parts.join('');assert.equal(bytes(args),state.bytes);
 assert.equal(hash(args),manifest.arguments_sha256,'arguments hash mismatch');
 const envelope=JSON.parse(args);assert.equal(envelope.delivery_id,manifest.delivery_id);assert.equal(envelope.original_tool_call_id,id);
 return {kind:'delivery',payload:envelopeCheck(envelope,effective),envelope,manifest,usage,arguments_utf8_bytes:state.bytes};
}
