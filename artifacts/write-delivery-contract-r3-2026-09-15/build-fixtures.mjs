import {createHash} from 'node:crypto';
import fs from 'node:fs';
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const compact=value=>JSON.stringify(value);
const parametersSource=fs.readFileSync(new URL('./write-delivery-v1.parameters.schema.json',import.meta.url));
const parameters=JSON.parse(parametersSource.toString('utf8'));
const schemaSha256=hash(parametersSource);
const manifestSchema=JSON.parse(fs.readFileSync(new URL('./delivery-manifest.schema.json',import.meta.url),'utf8'));
const limits={chunk_utf16_units:4000,chunk_json_utf8_bytes:32768,chunk_count:256,payload_utf8_bytes:1048576,arguments_utf8_bytes:8388608,response_body_bytes:12582912};
const envelope={version:1,delivery_id:'delivery-example-1',original_tool_call_id:'call-example-1',original_tool_name:'write',original_arguments:{filePath:'C:/workspace/example.txt'},operation:'overwrite',payload_utf8_bytes:3,payload_sha256:hash('abc'),transport_chunk_count:2,chunks:[{transport_chunk_index:0,offset_bytes:0,content:'ab'},{transport_chunk_index:1,offset_bytes:2,content:'c'}]};
const args=compact(envelope);
const manifest={version:1,request_id:'req-contract-example-1',request_nonce:'MTIzNDU2Nzg5MGFiY2RlZg',client_session_id:'ses-contract-example',client_turn_id:'turn-contract-example',delivery_id:envelope.delivery_id,tool_call_id:envelope.original_tool_call_id,tool_name:'write_delivery_v1',arguments_sha256:hash(args)};
const b64=value=>Buffer.from(compact(value),'utf8').toString('base64url');
const requestHeaders={'X-MedCode-Client-Capabilities':'write-delivery-v1','X-MedCode-Write-Delivery-Version':'1','X-MedCode-Write-Delivery-Schema-SHA256':schemaSha256,'X-MedCode-Write-Delivery-Nonce':manifest.request_nonce,'X-MedCode-Write-Delivery-Limits':b64(limits),'X-MedCode-Client-Session-Id':manifest.client_session_id,'X-MedCode-Client-Turn-Id':manifest.client_turn_id};
const responseHeaders={'Content-Type':'text/event-stream','X-Request-Id':manifest.request_id,'X-MedCode-Accepted-Capabilities':'write-delivery-v1','X-MedCode-Accepted-Write-Delivery-Version':'1','X-MedCode-Accepted-Write-Delivery-Limits':b64(limits),'X-MedCode-Write-Delivery-Manifest':b64(manifest)};
const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
const base={id:'chatcmpl-example',object:'chat.completion.chunk',created:1789430400,model:'goldencode'};
const split=Math.floor(args.length/2);
const events=[
 {...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:envelope.original_tool_call_id,type:'function',function:{name:'write_delivery_v1',arguments:args.slice(0,split)}}]},finish_reason:null}]},
 {...base,choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:args.slice(split)}}]},finish_reason:null}]},
 {...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
 {...base,choices:[],usage}
];
const sse=events.map(e=>'data: '+compact(e)+'\n\n').join('')+'data: [DONE]\n\n';
const error={error:{message:"Tool 'write' arguments invalid: data/content must NOT have more than 12000 characters",type:'server_error',code:'tool_call_validation_failed',param:null,retryable:false,request_id:'req-limit-example',contract_version:1,failure_kind:'schema_mismatch',transformed_retry_allowed:false,recommended_action:'use_bounded_file_write',retry_contract_version:1,automatic_retry_allowed:false,tool_validation_contract_version:1,tool_validation:{kind:'content_too_long',tool_name:'write',keyword:'maxLength',instance_path:'/content',schema_path:'#/properties/content/maxLength',limit_code_points:12000,actual_code_points:14000,actual_utf16_units:14000,actual_utf8_bytes:14000,gateway_retry_attempted:false,remaining_budget_ms:277000,stop_reason:'write_delivery_not_negotiated'}}};
const originalWriteSchema={type:'object',additionalProperties:false,required:['filePath','content'],properties:{filePath:{type:'string'},content:{type:'string',maxLength:12000},mode:{enum:['overwrite','append']},chunk:parameters.properties.original_arguments.properties.chunk}};
const ordinaryTool={type:'function',function:{name:'write',parameters:originalWriteSchema}};
const registry={version:1,capability:'write-delivery-v1',tool_name:'write_delivery_v1',schema_file:'write-delivery-v1.parameters.schema.json',schema_sha256:schemaSha256,limits};
const requestBody={model:'goldencode',stream:true,messages:[{role:'user',content:'Synthetic file delivery contract example.'}],tools:[ordinaryTool],tool_choice:'auto'};
const origin='https://goldencode.instmarket.com.au:1443';
const example={
  status:'R3 A/S development contract; abc is a protocol illustration, not a real oversize recovery or deployment claim',
  limits,request_headers:requestHeaders,
  sdk_registered_tools:[ordinaryTool,{type:'function',function:{name:'write_delivery_v1',description:'Local SDK receiver only; excluded from activeTools and every ordinary HTTP tools array.',parameters}}],
  sdk_active_tools:['write'],request_body:requestBody,schema_registry:registry,
  request_context:{url:origin+'/v1/chat/completions',subject_id:'subj-contract-fixture'},
  response_context:{url:origin+'/v1/chat/completions',status:200},
  trust_context:{origin,subject_id:'subj-contract-fixture',client_session_id:manifest.client_session_id,client_turn_id:manifest.client_turn_id},
  response_headers:responseHeaders,manifest,envelope,arguments_string:args,upstream_usage_example:usage
};
const files={'schema-registry.json':JSON.stringify(registry,null,2)+'\n','success.example.json':JSON.stringify(example,null,2)+'\n','success.sse':sse,'a-content-too-long.error.json':JSON.stringify(error,null,2)+'\n'};
process.stdout.write(JSON.stringify(files));
