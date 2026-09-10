import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const filename=resolve('packages/research-agent/dist/workflow.js');
const code=readFileSync(filename,'utf8').replace(/(from\s+["'])(\.[^"']+)(["'])/gu,
  (_,a,s,b)=>a+new URL(s,pathToFileURL(filename)).href+b)+'\nexport {selectIdentityEvidence,resolveIdentity};';
const mod=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const doctor={name:'Alice Example',hospital:'Example University Hospital',department:'Cardiology',orcid:null};
const run={runId:'drr_00000000000000000000000000000000',input:{doctor}};
const context={run,input:{policy:{maximumSourceTextCharacters:20000}}};
const source={sourceId:'src_synthetic_directory',url:'https://faculty.example.edu.cn/people',title:'Example University Hospital staff',accessedAt:'2026-09-10T00:00:00.000Z',contentSha256:'0'.repeat(64),discoveryKinds:['doctor_identity'],untrustedText:'Example University Hospital staff directory. Alice Example: Department of Nephrology. Bob Example: Department of Cardiology.'};
const evidence=mod.selectIdentityEvidence(context,null,[source],1);
const identity=mod.resolveIdentity(run,evidence);
console.log(JSON.stringify({kind:'synthetic_offline_counterexample',network_requests:0,requested:doctor,source_text:source.untrustedText,expected_identity_resolved:false,actual_identity_resolved:Boolean(identity),decisions:evidence.sourceDecisions,match_basis:evidence.officialSources.map(s=>s.identityMatchBasis)},null,2));
