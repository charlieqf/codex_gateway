// Authorized release acceptance only. Synthetic subjects; no SMS is sent.
// All credentials and phone values stay in memory. Cleanup uses Billing APIs.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const origin = "https://goldencode.instmarket.com.au:1443";
const admin = process.env.GATEWAY_BILLING_ADMIN_TOKEN;
const provider = process.env.GATEWAY_BILLING_IDENTITY_PROVIDER;
assert.ok(admin && provider, "Billing configuration required");
const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: true });
db.exec("PRAGMA query_only=ON");
const run = `phone_enrollment_smoke_${Date.now()}`;
const report = { checked_at: new Date().toISOString(), checks: [], accounts: [], cleanup: [] };
const accounts = [];
async function call(path, { method = "GET", token, body, event, status = 200 } = {}) {
  const response = await fetch(origin + path, { method, headers: {
    "x-medevidence-client-version": "2.0.0-beta.47",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(event ? { "idempotency-key": event } : {})
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
  const json = response.status === 204 ? {} : await response.json();
  report.checks.push({ path, status: response.status, request_id: response.headers.get("x-request-id"),
    ...(json.error?.code ? { error_code: json.error.code } : {}) });
  assert.ok(response.status === status, `Unexpected HTTP result for ${method} ${path}: ${response.status}`);
  return json;
}
function unusedPhone() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const phone = `199${String(randomInt(100000000)).padStart(8,"0")}`;
    if (!db.prepare("SELECT 1 FROM subjects WHERE phone_number IN (?,?)").get(phone,`+86${phone}`) &&
        !db.prepare("SELECT 1 FROM external_subject_registrations WHERE phone_number=?").get(`+86${phone}`) &&
        !accounts.some(account=>account.phone===phone)) return phone;
  }
  throw new Error("Cannot allocate an unused smoke phone");
}
const snapshot = id => ({
  keys: db.prepare("SELECT * FROM unified_client_keys WHERE subject_id=? ORDER BY id").all(id),
  credentials: db.prepare("SELECT * FROM access_credentials WHERE subject_id=? ORDER BY id").all(id),
  entitlements: db.prepare("SELECT * FROM entitlements WHERE subject_id=? ORDER BY id").all(id),
  usage: db.prepare("SELECT * FROM entitlement_token_windows WHERE entitlement_id IN (SELECT id FROM entitlements WHERE subject_id=?) ORDER BY entitlement_id,window_kind,window_start").all(id)
});
const same = (left,right,message) => assert.ok(JSON.stringify(left)===JSON.stringify(right),message);
let failure;
try {
  await call("/gateway/health");
  for (const kind of ["resolve","direct"]) {
    const account = { kind, externalId: `${run}_${kind}`, phone: unusedPhone() };
    accounts.push(account);
    const created = await call("/gateway/admin/billing/v1/subjects", { method:"POST",token:admin,
      event:`${run}:${kind}:create`,body:{provider,external_user_id:account.externalId,scope_allowlist:["code"]} });
    account.subjectId=created.subject.id; account.key=created.credential.key;
    assert.ok(account.key?.startsWith("cgu_live_"),"Original key missing");
    assert.ok(!db.prepare("SELECT 1 FROM phone_auth_identities WHERE subject_id=?").get(account.subjectId),"Legacy fixture already enrolled");
    const start = new Date(Date.now()-60000), end = new Date(start.getTime()+30*86400000);
    await call("/gateway/admin/billing/v1/entitlement-events", {method:"POST",token:admin,event:`${run}:${kind}:purchase`,
      body:{event_type:"purchase",apply_mode:"apply",provider,external_order_id:`${run}_${kind}_order`,
        external_event_id:`${run}_${kind}_purchase`,subject_id:account.subjectId,plan_id:"plan_paid_monthly_v1",
        period_kind:"monthly",period_start:start.toISOString(),period_end:end.toISOString()}});
    const before = snapshot(account.subjectId);
    const linked = kind === "resolve"
      ? await call("/gateway/admin/billing/v1/subjects/resolve",{method:"POST",token:admin,
          body:{provider,external_user_id:account.externalId,phone:account.phone}})
      : await call("/gateway/admin/billing/v1/subjects",{method:"POST",token:admin,status:409,event:`${run}:${kind}:link`,
          body:{provider,external_user_id:account.externalId,phone:account.phone,scope_allowlist:["code"]}});
    assert.ok(kind === "resolve" ? linked.status === "linked" : linked.error?.code === "subject_already_exists","Enrollment response mismatch");
    same(snapshot(account.subjectId),before,"Enrollment changed existing runtime or rights");
    const identity = db.prepare("SELECT * FROM phone_auth_identities WHERE subject_id=?").get(account.subjectId);
    assert.ok(identity?.state === "active","Enrollment missing");
    await call("/gateway/admin/billing/v1/subjects/resolve",{method:"POST",token:admin,
      body:{provider,external_user_id:account.externalId,phone:account.phone}});
    same(db.prepare("SELECT * FROM phone_auth_identities WHERE subject_id=?").get(account.subjectId),identity,"Replay rewrote identity");
    const session=await call("/gateway/auth/v1/login/start",{method:"POST",body:{phone:account.phone,
      client:"medevidence-desktop",device_id:`${run}_${kind}`,contract_version:1}});
    account.sessionToken=session.access_token;
    assert.ok(session.subject.id===account.subjectId,"Login subject mismatch");
    const bootstrap=await call("/gateway/auth/v1/session/bootstrap",{method:"POST",token:session.access_token,body:{}});
    assert.ok(bootstrap.unified_key.key===account.key,"Bootstrap changed original key");
    const resolved=await call("/gateway/unified-keys/resolve",{method:"POST",token:account.key,body:{}});
    assert.ok(resolved.subject.id===account.subjectId,"Runtime subject mismatch");
    await call("/gateway/credentials/current",{token:resolved.codex_gateway.api_key});
    if(kind === "resolve") {
      const model=await call("/v1/chat/completions",{method:"POST",token:resolved.codex_gateway.api_key,
        body:{model:"goldencode",messages:[{role:"user",content:"Reply only OK."}],max_tokens:256,stream:false}});
      assert.ok(model.choices?.length>0,"Model response missing");
      const usage=db.prepare("SELECT SUM(final_total_tokens) AS used FROM token_reservations WHERE subject_id=? AND finalized_at IS NOT NULL").get(account.subjectId);
      assert.ok(usage.used>0,"Model usage was not finalized");
      report.model_usage={subject_id:account.subjectId,finalized_tokens:usage.used};
    }
    const conflict=await call("/gateway/admin/billing/v1/subjects/resolve",{method:"POST",token:admin,status:409,
      body:{provider,external_user_id:account.externalId,phone:unusedPhone()}});
    assert.ok(conflict.error.code==="identity_conflict","Mismatched phone was not rejected");
    report.accounts.push({kind,subject_id:account.subjectId,enrolled:true,original_key_preserved:true,login_bootstrap:true});
  }
} catch(error) { failure=error; }
finally {
  for(const account of accounts) {
    try {
      account.subjectId ??= db.prepare("SELECT id FROM subjects WHERE external_provider=? AND external_user_id=?").get(provider,account.externalId)?.id;
      if(!account.subjectId) continue;
      if(db.prepare("SELECT 1 FROM phone_auth_identities WHERE subject_id=?").get(account.subjectId))
        await call(`/gateway/admin/billing/v1/phone-auth-identities/${account.subjectId}`,{method:"PATCH",token:admin,body:{state:"disabled"}});
      await call(`/gateway/admin/billing/v1/subjects/${account.subjectId}/disable`,{method:"POST",token:admin,
        event:`${run}:${account.kind}:disable`,body:{reason:"phone_enrollment_smoke_cleanup"}});
      const active=db.prepare("SELECT COUNT(*) AS n FROM access_credentials WHERE subject_id=? AND revoked_at IS NULL").get(account.subjectId).n;
      const unfinished=db.prepare("SELECT COUNT(*) AS n FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL").get(account.subjectId).n;
      const sessions=db.prepare("SELECT COUNT(*) AS n FROM phone_auth_sessions WHERE subject_id=? AND state='active'").get(account.subjectId).n;
      assert.ok(active===0 && unfinished===0 && sessions===0,"Smoke cleanup incomplete");
      report.cleanup.push({subject_id:account.subjectId,disabled:true,active_credentials:active,unfinished_reservations:unfinished,active_sessions:sessions});
    } catch(error) {failure ??= error;}
  }
  db.close();
}
report.assertions=failure ? "failed" : "passed";
// Assertions use only literal descriptions; do not serialize response payloads or tokens.
if(failure) report.error=failure.message;
console.log(JSON.stringify(report));
if(failure) process.exitCode=1;
