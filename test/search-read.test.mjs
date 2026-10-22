import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryIndex} from '../src/search.mjs';
import {readSession} from '../src/read.mjs';

test('search opens deep tool-argument evidence directly, with references stable across rebuilds', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pi-history-roundtrip-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=join(dir,'sessions');mkdirSync(root);
  const timestamp='2026-01-01T00:00:00.000Z';
  const content='🔹 ordinary line\n'.repeat(4000)+'x'.repeat(10000)+' deepIdentifier exact evidence\n';
  const records=[
    {type:'session',version:3,id:'session-a',cwd:'C:\\Project',timestamp},
    {type:'message',id:'prompt',parentId:null,timestamp,message:{role:'user',content:'Write the verified implementation.'}},
    {type:'message',id:'call',parentId:'prompt',timestamp,message:{role:'assistant',content:[{type:'toolCall',id:'tool-call',name:'write',arguments:{path:'source.txt',content}}]}}
  ];
  writeFileSync(join(root,'a.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const references=[];
  for(let rebuild=0;rebuild<2;rebuild++){
    const index=new HistoryIndex(join(dir,`index-${rebuild}.db`));
    let hit;
    try {await index.sync(root);hit=index.search({query:'deepIdentifier exact evidence'}).tools.hits[0];}
    finally {index.close();}
    const {sessionId,entryId,part,offset}=hit;
    references.push({sessionId,entryId,part,offset});
    assert.ok(offset>60000);
    assert.match(hit.excerpt,/deepIdentifier/);
    assert.equal(hit.excerptTruncated,true);
    const read=await readSession(hit.sessionFile,{entryId,part,offset,maxChars:2000});
    assert.match(read.text,/deepIdentifier exact evidence/);
    assert.ok(read.text.length<=2000);
  }
  assert.deepEqual(references[0],references[1]);
});

test('each preview and offset belongs to the hit source in both sections', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pi-history-hydration-')),root=join(dir,'sessions');mkdirSync(root);
  const index=new HistoryIndex(join(dir,'index.db'));
  t.after(()=>{index.close();rmSync(dir,{recursive:true,force:true});});
  const timestamp='2026-01-01T00:00:00.000Z';
  const bodies={short:'needle short',long:'prefix '.repeat(1000)+'needle long',
    small:'needle small',large:'padding '.repeat(1000)+'needle large'};
  const records=[{type:'session',version:3,id:'session-a',cwd:'C:\\Project',timestamp}];let parentId=null;
  const add=(id,message)=>{records.push({type:'message',id,parentId,timestamp,message});parentId=id;};
  add('prompt',{role:'user',content:'Inspect both sources.'});
  for(const id of ['short','long']) add(id,{role:'assistant',content:[{type:'text',text:bodies[id]}]});
  add('calls',{role:'assistant',content:['small','large'].map(id=>({type:'toolCall',id,name:'inspect',arguments:{path:id+'.txt'}}))});
  for(const id of ['small','large']) add(id,{role:'toolResult',toolName:'inspect',toolCallId:id,content:[{type:'text',text:bodies[id]}]});
  writeFileSync(join(root,'a.jsonl'),records.map(r=>JSON.stringify(r)+'\n').join(''));await index.sync(root);
  const seen=[];
  const page=index.search({query:'needle',limit:2});
  assert.equal(page.conversation.more,false);assert.equal(page.tools.more,false);
  for(const hit of [...page.conversation.hits,...page.tools.hits]){
    seen.push(hit.entryId);
    assert.equal(hit.offset,bodies[hit.entryId].indexOf('needle'));
    assert.ok(hit.excerpt.includes(`[needle] ${hit.entryId}`));
    assert.ok(hit.excerpt.length<600); // Native token-budget clipping is still truncation.
    assert.equal(hit.excerptTruncated,bodies[hit.entryId].length>600);
    const read=await readSession(hit.sessionFile,{entryId:hit.entryId,part:hit.part,offset:hit.offset,maxChars:2000});
    assert.ok(read.text.includes(`needle ${hit.entryId}`));
    assert.ok(read.spans.some(s=>!s.preview&&s.entryId===hit.entryId&&s.part===hit.part&&s.from<=hit.offset&&s.to>hit.offset));
  }
  assert.deepEqual(seen.sort(),Object.keys(bodies).sort());
});
