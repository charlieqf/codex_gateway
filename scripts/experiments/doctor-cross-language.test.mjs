import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parsePlan,parseSelection,selectCandidates,sourceExcerpt,validateVerification} from './doctor-cross-language.mjs';

const doctor={name:'Example Person',hospital:'示例医院',department:'心脏科'};
const source={sourceId:'s1',url:'https://hospital.example/profile',contentSha256:'abc',untrustedText:'Example Person works in Cardiology at Example Hospital.'};
const match={source_id:'s1',person_name:'Example Person',name_relation:'same_name',person_quote:'Example Person',institution_quote:'Example Hospital',department_quote:'Cardiology',affiliation_quote:source.untrustedText,affiliation_status:'unclear',source_type:'institution_profile'};
const verify=(changes={},request=doctor)=>validateVerification(JSON.stringify({status:'matched',matches:[{...match,...changes}]}),request,[source]);
test('requires quotations from the fetched document',()=>{
 assert.equal(verify().status,'matched');
 assert.equal(verify({institution_quote:'Fabricated Hospital'}).status,'not_found');
 assert.equal(verify({source_id:'invented'}).status,'not_found');
});
test('rejects a different Latin name and uncertain transliteration',()=>{
 assert.equal(verify({person_name:'Another Person'}).status,'not_found');
 assert.equal(verify({name_relation:'uncertain'},{...doctor,name:'伊格赞普尔·珀森'}).status,'not_found');
 assert.equal(verify({name_relation:'transliteration'},{...doctor,name:'伊格赞普尔·珀森'}).status,'matched');
});
test('planner cannot inject URLs/search operators or unbounded candidates',()=>{
 const candidate={name:'Example Person',institution:'Example Hospital',department:'Cardiology',language:'en'};
 assert.equal(parsePlan(JSON.stringify({candidates:[candidate]})).candidates.length,1);
 assert.throws(()=>parsePlan(JSON.stringify({candidates:[{...candidate,institution:'site:attacker.example'}]})));
 assert.throws(()=>parsePlan(JSON.stringify({candidates:Array(3).fill(candidate)})));
});
test('bounded excerpt preserves a distant person window',()=>{
 const text='intro '.repeat(2000)+'Example Person works in Cardiology at Example Hospital.';
 assert.ok(sourceExcerpt({...source,untrustedText:text},[doctor.name]).includes(source.untrustedText));
});
test('candidate cap keeps language-query diversity and prefers profile HTML',()=>{
 const paper={title:'Example Person publication',snippet:'',url:'https://one.example/publications/paper'};
 const profile={title:'Example Person clinic',snippet:'',url:'https://two.example/clinic/profile'};
 const selected=selectCandidates([[paper,{...paper,url:'https://one.example/a.pdf'}],[profile]],['Example Person'],2);
 assert.ok(selected.some(x=>x.url===profile.url));
 assert.equal(selectCandidates([[{...profile,url:'http://127.0.0.1/private'}]],['Example Person']).length,0);
});
test('model can select only observed candidate IDs and hosts',()=>{
 const candidates=[{candidate_id:'C1'}],hosts=['hospital.example'];
 assert.equal(parseSelection('{"source_ids":["C1"],"search_host":"hospital.example"}',candidates,hosts).search_host,'hospital.example');
 assert.throws(()=>parseSelection('{"source_ids":["invented"],"search_host":null}',candidates,hosts));
 assert.throws(()=>parseSelection('{"source_ids":[],"search_host":"127.0.0.1"}',candidates,hosts));
});
test('matrix covers the Cartesian product independently for every profile',()=>{
 for(const file of ['./doctor-cross-language.matrix.json','./doctor-cross-language.blind-matrix.json']){
  const matrix=JSON.parse(readFileSync(new URL(file,import.meta.url),'utf8'));
  assert.deepEqual(matrix.languages,['zh','en']);
  for(const profile of matrix.profiles){
   for(const field of ['name','hospital','department'])for(const language of matrix.languages)assert.ok(typeof profile[field][language]==='string'&&profile[field][language].trim());
   const rows=[];
   for(const name of matrix.languages)for(const hospital of matrix.languages)for(const department of matrix.languages)rows.push({name:profile.name[name],hospital:profile.hospital[hospital],department:profile.department[department]});
   assert.equal(new Set(rows.map(JSON.stringify)).size,8);
   assert.equal(rows.filter(x=>x.name===profile.name.zh).length,4);
  }
 }
});
