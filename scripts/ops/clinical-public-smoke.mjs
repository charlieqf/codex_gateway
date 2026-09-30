// Run inside the Gateway container. Existing pilot Keys remain in memory only.
// Phases pre/resume straddle an intentional drained Gateway replacement.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { decryptSecret } from "/app/packages/core/dist/index.js";
import { resolveProviderApiKey } from "/app/apps/gateway/dist/services/provider-secret.js";

const origin = "https://goldencode.instmarket.com.au:1443", phase = process.argv[2] ?? "pre";
const statePath = "/var/lib/codex-gateway/clinical/public-smoke-state.json";
const reportPath = `/var/lib/codex-gateway/clinical/public-smoke-${phase}.json`;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { phase, at: new Date().toISOString(), checks: [], resources: [] };
const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: true }); db.exec("PRAGMA query_only=ON");
const secret = resolveProviderApiKey(process.env, "GATEWAY_UNIFIED_KEY_RECOVERY_KEY").apiKey;
assert.ok(secret, "Existing Key recovery configuration required");
const subjects = process.env.GATEWAY_AIPAL_SUBJECT_IDS.split(","); assert.ok(subjects.length >= 2);
const tokens = subjects.slice(0, 2).map(subject => {
  const row = db.prepare("SELECT token_ciphertext FROM unified_client_keys WHERE subject_id=? AND is_current=1 AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(subject, new Date().toISOString());
  assert.ok(row?.token_ciphertext, "Existing pilot Key required"); return decryptSecret(row.token_ciphertext, secret);
}); db.close();
report.subjects = subjects.slice(0, 2);
const bytes = readFileSync("/var/lib/codex-gateway/clinical/public-echo.avi");
const labs = {
  session_id: "clinical-public-smoke", analysis_profile: "aipal-adult-research-v1", data_policy: "public_or_deidentified",
  input: { clinical_context: "suspected_acute_leukemia", measurements: {
    age: {value:55,unit:"years"}, WBC_G_L:{value:10,unit:"10^9/L"}, Monocytes_G_L:{value:0.5,unit:"10^9/L"},
    Lymphocytes_G_L:{value:1,unit:"10^9/L"}, Platelets_G_L:{value:100,unit:"10^9/L"}, MCV_fL:{value:90,unit:"fL"},
    MCHC_g_L:{value:340,unit:"g/L"}, LDH_UI_L:{value:300,unit:"U/L"}, Fibrinogen_g_L:{value:2.5,unit:"g/L"}, PT_percent:{value:80,unit:"%"}
  } }
};
const echo = { session_id: "clinical-public-smoke", analysis_profile: "panecho-tte-research-v1", data_policy: "public_or_deidentified",
  input: { format: "video", size: bytes.length, sha256: sha(bytes), acquisition: "2d_tte", roi: [0.24,0.21,0.78,0.8] } };
const prefix = mode => `/gateway/${mode}/v1`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(mode, path, { method="GET", body, account=0, key, expected=200, headers={}, raw=false }={}) {
  const response=await fetch(origin+prefix(mode)+path,{method,headers:{
    authorization:`Bearer ${tokens[account]}`,"x-medevidence-client-version":"2.0.0-beta.88",
    ...(body!==undefined ? {"content-type":Buffer.isBuffer(body)?"application/octet-stream":"application/json"}:{}),
    ...(key?{"idempotency-key":key}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const evidence={mode,path,method,status:response.status,request_id:response.headers.get("x-request-id")};report.checks.push(evidence);
  assert.equal(response.status,expected,`${mode} ${method} ${path}`);
  if(raw){const data=Buffer.from(await response.arrayBuffer());return{bytes:data,headers:response.headers};}
  const value=await response.json();if(value.error)evidence.error_code=value.error.code;return value;
}
async function wait(mode,id,states,timeout=180000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const job=await call(mode,`/jobs/${id}`);if(states.includes(job.state))return job;assert.ok(!["failed","cancelled","expired"].includes(job.state),`Unexpected ${mode} state`);await sleep(500);}
  throw new Error("poll_deadline");
}
async function cross(mode,id){
  for(const suffix of ["","/result","/artifacts/result.json"])await call(mode,`/jobs/${id}${suffix}`,{account:1,expected:404,headers:{"x-clinical-owner":"a".repeat(64)}});
  await call(mode,`/jobs/${id}/cancel`,{method:"POST",body:{},account:1,expected:404});
  await call(mode,`/jobs/${id}`,{method:"DELETE",account:1,expected:404});
}
async function download(mode,job){
  for(const item of job.artifacts){const data=await call(mode,`/jobs/${job.job_id}/artifacts/${item.name}`,{raw:true});
    assert.equal(Number(data.headers.get("content-length")),item.size);assert.equal(data.headers.get("x-content-sha256"),item.sha256);assert.equal(data.bytes.length,item.size);assert.equal(sha(data.bytes),item.sha256);
    report.resources.push({mode,job_id:job.job_id,name:item.name,size:item.size,sha256:item.sha256});}
}
async function erase(mode,id){await call(mode,`/jobs/${id}`,{method:"DELETE",expected:202});await call(mode,`/jobs/${id}`,{expected:404});await call(mode,`/jobs/${id}/artifacts/result.json`,{expected:404});}
async function lostResponse(mode,input,key){
  const data=Buffer.from(JSON.stringify(input));await new Promise((resolve,reject)=>{
    const request=httpsRequest(origin+prefix(mode)+"/jobs",{method:"POST",headers:{authorization:`Bearer ${tokens[0]}`,"content-type":"application/json","content-length":data.length,"idempotency-key":key}},res=>{
      if(![200,201,202].includes(res.statusCode)){res.destroy();request.destroy();reject(new Error("create_not_accepted"));return;}res.destroy();request.destroy();resolve();
    });request.on("error",reject);request.setTimeout(10000,()=>request.destroy(new Error("response_deadline")));request.end(data);
  });report.checks.push({mode,operation:"accepted_response_discarded"});
}
async function partialUpload(id){
  await new Promise(resolve=>{
    const request=httpsRequest(origin+prefix("panecho")+`/jobs/${id}/input/parts/0`,{method:"PUT",headers:{authorization:`Bearer ${tokens[0]}`,"content-type":"application/octet-stream","content-length":bytes.length,"x-chunk-sha256":sha(bytes)}},res=>res.destroy());
    request.on("error",()=>resolve());request.write(bytes.subarray(0,32768));setTimeout(()=>{request.destroy();resolve();},300);
  });await sleep(800);const status=await call("panecho",`/jobs/${id}/input`);assert.equal(status.parts.length,0);report.checks.push({mode:"panecho",operation:"interrupted_partial_chunk_not_committed"});
}
async function upload(id){
  const opts={method:"PUT",body:bytes,headers:{"content-length":String(bytes.length),"x-chunk-sha256":sha(bytes)}};
  const part=await call("panecho",`/jobs/${id}/input/parts/0`,opts);assert.equal(part.sha256,sha(bytes));
  await call("panecho",`/jobs/${id}/input/parts/0`,opts);
  const status=await call("panecho",`/jobs/${id}/input`);assert.equal(status.parts.length,1);assert.equal(status.parts[0].sha256,sha(bytes));
}
let state;
try{
  if(phase==="pre"){
    state={run:randomUUID(),echo_id:null,resources:[]};writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
    for(const mode of ["aipal","panecho"]){const cap=await call(mode,"/capabilities");assert.equal(cap.available,true);
      const unauth=await fetch(origin+prefix(mode)+"/capabilities");assert.equal(unauth.status,401);report.checks.push({mode,operation:"missing_key_401"});
      const source=await call(mode,"/source",{raw:true});assert.equal(sha(source.bytes),source.headers.get("x-content-sha256"));}
    const key=state.run+":aipal";await lostResponse("aipal",labs,key);
    const job=await call("aipal","/jobs",{method:"POST",body:labs,key});state.resources.push({mode:"aipal",id:job.job_id});writeFileSync(statePath,JSON.stringify(state));
    await call("aipal","/jobs",{method:"POST",body:{...labs,session_id:"changed"},key,expected:409});await cross("aipal",job.job_id);
    const done=await wait("aipal",job.job_id,["completed"]);const result=await call("aipal",`/jobs/${job.job_id}/result`);assert.equal(Object.keys(result.probabilities).length,3);await download("aipal",done);await erase("aipal",job.job_id);
    await call("aipal","/jobs",{method:"POST",body:labs,key,expected:404});
    const echoJob=await call("panecho","/jobs",{method:"POST",body:echo,key:state.run+":echo",expected:201});state.echo_id=echoJob.job_id;state.resources.push({mode:"panecho",id:echoJob.job_id});writeFileSync(statePath,JSON.stringify(state));
    await partialUpload(echoJob.job_id);await upload(echoJob.job_id);report.checks.push({mode:"panecho",operation:"ready_for_gateway_restart",job_id:echoJob.job_id});
  }else if(phase==="resume"){
    state=JSON.parse(readFileSync(statePath,"utf8"));const id=state.echo_id;
    const before=await call("panecho",`/jobs/${id}`);assert.equal(before.state,"uploading");const status=await call("panecho",`/jobs/${id}/input`);assert.equal(status.parts[0].sha256,sha(bytes));
    const replay=await call("panecho","/jobs",{method:"POST",body:echo,key:state.run+":echo"});assert.equal(replay.job_id,id);
    await call("panecho",`/jobs/${id}/input/complete`,{method:"POST",body:{},expected:202});await call("panecho",`/jobs/${id}/input/complete`,{method:"POST",body:{},expected:202});
    const done=await wait("panecho",id,["completed"]);const result=await call("panecho",`/jobs/${id}/result`);assert.equal(result.tasks.length,40);await cross("panecho",id);await download("panecho",done);await erase("panecho",id);
    const cancel=await call("panecho","/jobs",{method:"POST",body:echo,key:state.run+":cancel",expected:201});state.resources.push({mode:"panecho",id:cancel.job_id});writeFileSync(statePath,JSON.stringify(state));
    await upload(cancel.job_id);await call("panecho",`/jobs/${cancel.job_id}/input/complete`,{method:"POST",body:{},expected:202});
    await wait("panecho",cancel.job_id,["running"]);await call("panecho",`/jobs/${cancel.job_id}/cancel`,{method:"POST",body:{},expected:202});await wait("panecho",cancel.job_id,["cancelled"]);await erase("panecho",cancel.job_id);
    for(const route of ["/v1/models","/gateway/imaging/v1/capabilities"]){const r=await fetch(origin+route,{headers:{authorization:`Bearer ${tokens[0]}`,"x-medevidence-client-version":"2.0.0-beta.88"},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);report.checks.push({operation:"existing_route_regression",path:route,status:r.status});}
  }else if(phase==="cleanup"){
    state=JSON.parse(readFileSync(statePath,"utf8"));for(const resource of state.resources){try{await call(resource.mode,`/jobs/${resource.id}`,{method:"DELETE",expected:202});}catch{await call(resource.mode,`/jobs/${resource.id}`,{expected:404});}}
    unlinkSync(statePath);report.checks.push({operation:"smoke_state_removed"});
  }else throw new Error("unknown_phase");
  report.ok=true;
}catch(error){report.ok=false;report.failure=error.code??error.name;process.exitCode=1;}
finally{writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));}
