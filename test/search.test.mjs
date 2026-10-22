import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { HistoryIndex, ftsQuery } from '../src/search.mjs';
import { sourceParts, searchParts } from '../src/content.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
const header = (id, cwd = 'C:\\Project', started = timestamp) => ({type:'session',version:3,id,cwd,timestamp:started});
const message = (id, parentId, text, role = 'assistant') => ({type:'message',id,parentId,timestamp,message:{role,content:role==='assistant'?[{type:'text',text}]:text}});
const jsonl = entries => entries.map(e=>JSON.stringify(e)).join('\n')+'\n';
function setup(t) {
  const base = mkdtempSync(join(tmpdir(),'pi-history-contract-'));
  const root = join(base,'sessions');mkdirSync(root);
  const index = new HistoryIndex(join(base,'index.db'));
  t.after(()=>{index.close();rmSync(base,{recursive:true,force:true});});
  return {base,root,index};
}

test('independent workers can initialize and sync the same cold cache', async t => {
  const base = mkdtempSync(join(tmpdir(), 'pi-history-concurrent-')), workers = [];
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); rmSync(base, {recursive:true,force:true}); });
  const root = join(base, 'sessions'); mkdirSync(root);
  writeFileSync(join(root, 'a.jsonl'), jsonl([header('a'), message('a1', null, 'needle')]));
  const source = `
    const {parentPort, workerData} = require('node:worker_threads');
    (async () => {
      const {HistoryIndex} = await import(workerData.module);
      parentPort.postMessage('ready');
      await new Promise(resolve => parentPort.once('message', resolve));
      const index = new HistoryIndex(workerData.db);
      let result;
      try {
        const sync = await index.sync(workerData.root);
        result = {complete: sync.complete, hits: index.search({query:'needle'}).conversation.hits.length};
      } finally { index.close(); }
      parentPort.postMessage(result); parentPort.close();
    })();`;
  for (let round = 0; round < 2; round++) {
    const batch = Array.from({length:4}, () => new Worker(source, {eval:true, workerData:{
      module: new URL('../src/search.mjs', import.meta.url).href, root, db:join(base, `index-${round}.db`)
    }}));
    workers.push(...batch);
    await Promise.all(batch.map(w => once(w, 'message')));
    const finished = batch.map(w => Promise.all([once(w, 'message'), once(w, 'exit')]));
    batch.forEach(w => w.postMessage('start'));
    for (const [[result], [code]] of await Promise.all(finished)) {
      assert.equal(code, 0); assert.deepEqual(result, {complete:true,hits:1});
    }
  }
});

// Content is shared, while source references and scope remain properties of each occurrence.
test('fork copies collapse without hiding divergent work or changing source scope/date', async t=>{
  const {root,index}=setup(t);
  const a=message('a',null,'shared needle','user');
  const b=message('b','label','first decision needle');
  writeFileSync(join(root,'a.jsonl'),jsonl([header('origin'),a,{type:'label',id:'label',parentId:'a',timestamp,targetId:'a',label:'point'},b]));
  writeFileSync(join(root,'b.jsonl'),jsonl([header('fork','C:\\Project\\Child','2026-01-10T00:00:00Z'),a,{...b,parentId:'a'},message('c','b','divergent decision needle')]));
  assert.equal((await index.sync(root)).complete,true);
  assert.equal(index.db.prepare('SELECT count(*) n FROM doc').get().n,3);
  const result=index.search({query:'shared needle'}).conversation.hits;
  assert.equal(result.length,1);assert.equal(result[0].copies,2);assert.equal(result[0].sessionId,'origin');
  assert.equal(index.search({query:'needle',session:'fork'}).conversation.hits.length,3);
  assert.equal(index.search({query:'shared',cwd:'c:/PROJECT/child/'}).conversation.hits[0].sessionId,'fork');
  assert.equal(index.search({query:'shared',cwd:'C:\\Project',descendants:true}).conversation.hits[0].copies,2);
  assert.equal(index.search({query:'shared',excludeSession:'origin'}).conversation.hits[0].sessionId,'fork');
  assert.equal(index.search({query:'shared',since:'2026-01-05'}).conversation.hits.length,0);
  assert.deepEqual(index.search({since:'2026-01-05'}).sessions.map(s=>s.sessionId),['fork']);
});

test('sync handles appends, rewrites, renames and incomplete or failed files transactionally', async t=>{
  const {root,index}=setup(t);let path=join(root,'a.jsonl');
  const first=[header('a'),message('a1',null,'before')];
  writeFileSync(path,jsonl(first));await index.sync(root);
  assert.equal((await index.sync(root)).changed,0);
  const second=message('a2','a1','appended');const third=JSON.stringify(message('a3','a2','trailing'));
  appendFileSync(path,jsonl([second])+third.slice(0,30));
  let sync=await index.sync(root);assert.equal(sync.appended,1);assert.equal(sync.complete,false);assert.ok(sync.pendingBytes>0);
  assert.equal(index.search({query:'appended'}).conversation.hits.length,1);
  assert.equal(index.search({query:'trailing'}).conversation.hits.length,0);
  appendFileSync(path,third.slice(30)+'\n');
  sync=await index.sync(root);assert.equal(sync.appended,1);assert.equal(sync.complete,true);
  writeFileSync(path,jsonl([header('a'),message('a1',null,'afterx'),second,JSON.parse(third)]));
  const future=new Date(Date.now()+1000);utimesSync(path,future,future);
  sync=await index.sync(root);assert.equal(sync.changed,1);assert.equal(sync.appended,0);
  assert.equal(index.search({query:'before'}).conversation.hits.length,0);
  assert.equal(index.search({query:'afterx'}).conversation.hits.length,1);
  const renamed=join(root,'renamed.jsonl');renameSync(path,renamed);path=renamed;
  sync=await index.sync(root);assert.equal(sync.complete,true);assert.equal(sync.removed,1);
  assert.equal(index.search({query:'afterx'}).conversation.hits[0].sessionFile,renamed);
  appendFileSync(path,'{bad}\n');
  sync=await index.sync(root);assert.equal(sync.errors.length,1);assert.equal(sync.complete,false);
  assert.equal(index.search({query:'afterx'}).conversation.hits.length,1);
  rmSync(path);sync=await index.sync(root);assert.equal(sync.removed,1);
  assert.equal(index.db.prepare('SELECT count(*) n FROM doc').get().n,0);
});

test('replacement and removal retire text atomically without losing fork copies', async t=>{
  const base=mkdtempSync(join(tmpdir(),'pi-history-retirement-')),root=join(base,'sessions'),db=join(base,'index.db');mkdirSync(root);
  let index=new HistoryIndex(db);
  t.after(()=>{index.close();rmSync(base,{recursive:true,force:true});});
  const a=join(root,'a.jsonl'),b=join(root,'b.jsonl'),shared=message('shared',null,'shared needle','user');
  const call={type:'message',id:'call',parentId:'shared',timestamp,message:{role:'assistant',content:[{type:'toolCall',id:'inspect',name:'inspect',arguments:{note:'retired call'}}]}};
  const output={type:'message',id:'output',parentId:'call',timestamp,message:{role:'toolResult',toolCallId:'inspect',toolName:'inspect',content:[{type:'text',text:'retired output'}]}};
  writeFileSync(a,jsonl([header('a'),shared,call,output,message('answer','output','retired answer')]));
  writeFileSync(b,jsonl([header('fork'),shared,message('fork-answer','shared','fork needle')]));
  await index.sync(root);
  const replacement=jsonl([header('a'),shared,message('replacement','shared','replacement needle')]);
  writeFileSync(a,replacement);
  await index.indexFile(a); // commit the file, then stop before sync can finish
  assert.equal(index.db.prepare('SELECT count(*) n FROM doc').get().n,3);
  index.close();index=new HistoryIndex(db);
  const recovered=await index.sync(root);
  assert.equal(recovered.changed,0);assert.equal(recovered.complete,true);
  assert.equal(index.db.prepare('SELECT count(*) n FROM doc').get().n,3);
  for(const table of ['conversation','tool_io']) assert.equal(index.db.prepare(`SELECT count(*) n FROM ${table} WHERE ${table} MATCH 'retired'`).get().n,0);
  assert.equal(index.search({query:'shared'}).conversation.hits[0].copies,2);
  writeFileSync(a,jsonl([header('a'),message('tentative',null,'uncommitted evidence')])+'{bad}\n');
  await assert.rejects(index.indexFile(a));
  assert.equal(index.search({query:'replacement'}).conversation.hits.length,1);
  assert.equal(index.search({query:'shared'}).conversation.hits[0].copies,2);
  assert.equal(index.search({query:'uncommitted'}).conversation.hits.length,0);
  rmSync(a);await index.sync(root);
  const remaining=index.search({query:'shared'}).conversation.hits[0];
  assert.equal(remaining.copies,1);assert.equal(remaining.sessionId,'fork');
  rmSync(b);await index.sync(root);
  for(const table of ['doc','occurrence','conversation','tool_io']) assert.equal(index.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.deepEqual(index.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('identical summary previews do not hide distinct conclusions', async t=>{
  const {root,index}=setup(t);
  const shared='Needle was reviewed. '+ 'Context remains unchanged. '.repeat(60);
  const summaries=['Keep the feature enabled.','Keep the feature disabled.'].map((conclusion,i)=>({
    type:'compaction',id:`summary${i}`,parentId:i?'summary0':'prompt',timestamp,
    summary:shared+conclusion,firstKeptEntryId:'prompt'
  }));
  writeFileSync(join(root,'a.jsonl'),jsonl([header('a'),message('prompt',null,'Question.','user'),...summaries]));
  await index.sync(root);
  const result=index.search({query:'needle',limit:2}).conversation;
  assert.equal(result.hits.length,2);
  assert.equal(result.hits[0].excerpt,result.hits[1].excerpt);
  assert.deepEqual(new Set(result.hits.map(h=>h.entryId)),new Set(['summary0','summary1']));
  assert.equal(result.more,false);
});

test('descendant scopes preserve POSIX case, Windows normalization and directory boundaries', async t=>{
  const {root,index}=setup(t);
  const projects={
    lower:'/home/work',child:'/home/work/child',upper:'/home/WORK/child',neighbor:'/home/worker',
    windows:'C:\\Work',windowsChild:'C:\\WORK\\Child',
    unicode:'/home/🧪work/child'
  };
  for(const [id,cwd] of Object.entries(projects)) writeFileSync(join(root,id+'.jsonl'),jsonl([header(id,cwd),message(id,null,'needle')]));
  await index.sync(root);
  const sessions=options=>index.search(options).sessions.map(s=>s.sessionId).sort();
  assert.deepEqual(sessions({cwd:'/home/work',descendants:true}),['child','lower']);
  assert.deepEqual(sessions({cwd:'/home/work'}),['lower']);
  assert.deepEqual(sessions({cwd:'c:/work/',descendants:true}),['windows','windowsChild']);
  assert.deepEqual(sessions({cwd:'/home/🧪work',descendants:true}),['unicode']);
  assert.deepEqual(index.search({query:'needle',cwd:'/home/work',descendants:true}).conversation.hits.map(h=>h.sessionId).sort(),['child','lower']);
});

test('ranked sections truncate independently at fifty hits', async t=>{
  const {root,index}=setup(t), path=join(root,'a.jsonl');
  const entries=[header('a')];let parent=null;
  for(let i=0;i<51;i++){
    const id=`e${String(i).padStart(2,'0')}`;
    entries.push(message(id,parent,i<50?'short needle':'substantive '.repeat(2000)+'needle'));parent=id;
  }
  for(let i=0;i<2;i++){
    const call=`call${i}`, result=`result${i}`;
    entries.push({type:'message',id:call,parentId:parent,timestamp,message:{role:'assistant',content:[{type:'toolCall',id:call,name:'inspect',arguments:{command:'inspect'}}]}});
    entries.push({type:'message',id:result,parentId:call,timestamp,message:{role:'toolResult',toolName:'inspect',toolCallId:call,content:[{type:'text',text:'needle output'}]}});parent=result;
  }
  writeFileSync(path,jsonl(entries));await index.sync(root);
  const first=index.search({query:'needle',limit:50});
  assert.equal(first.conversation.hits.length,50);
  assert.equal(first.conversation.more,true);
  assert.deepEqual(first.conversation.hits.map(h=>h.entryId),Array.from({length:50},(_,i)=>`e${String(i).padStart(2,'0')}`));
  assert.equal(first.tools.hits.length,2);assert.equal(first.tools.more,false);
  assert.deepEqual(index.search({query:'needle substantive'}).conversation.hits.map(h=>h.entryId),['e50']); // narrowing reaches the truncated hit
});

test('browse listing uses a total order', async t=>{
  const {root,index}=setup(t);
  for(let i=6;i>=0;i--){
    const id=`s${i}`;writeFileSync(join(root,id+'.jsonl'),jsonl([header(id),message(id,null,'text')]));
  }
  await index.sync(root);
  for(const options of [{tool:'missing'},{query:'  ',tool:''},{reasoning:true}]) assert.throws(()=>index.search(options),/require.*query/i);
  for(const tool of ['missing','']) {
    const filtered=index.search({query:'text',tool});
    assert.deepEqual(filtered.conversation.hits,[]);assert.deepEqual(filtered.tools.hits,[]);
  }
  const options={cwd:'C:/Project',excludeSession:'s2',reasoning:false};
  const first=index.search({...options,limit:2});
  assert.deepEqual(first.sessions.map(s=>s.sessionId),['s0','s1']);assert.equal(first.more,true);
  const all=index.search({...options,limit:6});
  assert.deepEqual(all.sessions.map(s=>s.sessionId),['s0','s1','s3','s4','s5','s6']);assert.equal(all.more,false);
});

test('failed root traversal preserves indexed evidence', async t=>{
  const {root,index}=setup(t);
  writeFileSync(join(root,'a.jsonl'),jsonl([header('a'),message('a1',null,'retained')]));await index.sync(root);
  rmSync(root,{recursive:true});
  const sync=await index.sync(root);assert.equal(sync.complete,false);assert.equal(sync.removed,0);
  assert.equal(index.search({query:'retained'}).conversation.hits.length,1);
});

test('query and content boundaries: complete text, typed evidence, no opaque data or recall echoes', async t=>{
  const {root,index}=setup(t);
  const tool={type:'message',id:'tool',parentId:'a',timestamp,message:{role:'assistant',content:[{type:'thinking',thinking:'reasononly'},{type:'toolCall',id:'call',name:'write',arguments:{content:'begin\ninteriorneedle\nend'}}]}};
  const recall={type:'message',id:'recall',parentId:'tool',timestamp,message:{role:'toolResult',toolName:'recall',content:[{type:'text',text:'echo'}]}};
  const wrapper={...recall,id:'wrapper',message:{...recall.message,toolName:'codemode',nestedCalls:{complete:true,calls:[{name:'session_search'}]}}};
  assert.equal(searchParts(recall).length,0);assert.equal(searchParts(wrapper).length,0);
  assert.equal(sourceParts(recall).length,1);
  const mixed={...wrapper,message:{...wrapper.message,nestedCalls:{complete:true,calls:[{name:'session_search'},{name:'read'}]}}};
  assert.equal(searchParts(mixed).length,1);
  const identifiers=message('identifiers','recall','getSessionDir C++ C#');
  const blocks={...message('blocks','identifiers',''),message:{role:'assistant',content:[{type:'text',text:'firstblock'},{type:'text',text:'lastblock'}]}};
  writeFileSync(join(root,'a.jsonl'),jsonl([header('a'),message('a',null,'word '.repeat(100000)+'middlephrase zebra tail'),tool,recall,identifiers,blocks]));await index.sync(root);
  assert.equal(index.search({query:'getSessionDir'}).conversation.hits.length,1);
  assert.equal(index.search({query:'SessionDir'}).conversation.hits.length,0);
  assert.equal(index.search({query:'session'}).conversation.hits.length,0);
  const punctuation=index.search({query:'"C++"'}).conversation.hits[0];
  assert.match(punctuation.excerpt,/\[C\]\+\+ \[C\]#/);
  assert.equal(index.search({query:'firstblock lastblock'}).conversation.hits.length,0);
  assert.equal(index.search({query:'interiorneedle'}).tools.hits.length,1);
  const deepHit = index.search({query:'middlephrase zebra'}).conversation.hits[0];
  assert.ok(deepHit.offset > 490000);
  assert.ok(deepHit.excerpt.includes('[middlephrase]'));
  assert.equal(index.search({query:'"middlephrase zebra"'}).conversation.hits.length,1);
  assert.equal(index.search({query:'middlephrase absent'}).conversation.hits.length,0);
  assert.equal(index.search({query:'reasononly'}).conversation.hits.length,0);
  assert.equal(index.search({query:'reasononly',reasoning:true}).conversation.hits.length,1);
  assert.equal(index.search({query:'echo'}).tools.hits.length,0);
  assert.equal(ftsQuery('needle OR absent'),'"needle" AND "OR" AND "absent"');
  assert.throws(()=>ftsQuery('"unclosed'),/Unclosed/);
});
