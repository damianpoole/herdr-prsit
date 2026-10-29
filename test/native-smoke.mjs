// Opt-in integration smoke test: uses your configured provider; no GitHub writes.
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {models,closeModels} from '../dist/agent.js';
import {openRuntime} from '../dist/runtime.js';
import {exec} from '../dist/io.js';
import {git} from '../dist/git.js';
const model=process.env.PRSIT_SMOKE_MODEL;
if(!model)throw new Error('Set PRSIT_SMOKE_MODEL=provider/model-id; this test makes real model requests.');
const dir=await mkdtemp(join(tmpdir(),'prsit-native-smoke-'));
process.env.PRSIT_HOME=join(dir,'state');
const remote=join(dir,'remote.git'),repo=join(dir,'repo');
await exec('git',['init','--bare','--initial-branch=main',remote]);await exec('git',['clone',remote,repo]);
await git(repo,'config','user.name','PRsit smoke test');await git(repo,'config','user.email','prsit-test@example.invalid');
await writeFile(join(repo,'sum.cjs'),'module.exports = (a, b) => a - b;\n');
await writeFile(join(repo,'test.cjs'),"require('node:assert/strict').equal(require('./sum.cjs')(2, 3), 5);\n");
await git(repo,'add','.');await git(repo,'commit','-m','Smoke fixture');await git(repo,'push','origin','main');
await git(repo,'switch','-c','fix');await git(repo,'push','origin','fix');
const head=await git(repo,'rev-parse','HEAD');await git(remote,'update-ref','refs/pull/1/head',head);
const w={id:'smoke',url:'https://github.com/fixture/prsit-smoke/pull/1',host:'github.com',owner:'fixture',repo:'prsit-smoke',number:1,path:repo,remote:'origin',agent:'pi',model,interval:60000,merge:'squash',allowNoChecks:false,test:`${JSON.stringify(process.execPath)} test.cjs`,maxAttempts:2,timeout:180000,created:Date.now()};
let merged=false,replied=false;
const feedback={key:'comment:1',fingerprint:'sum',kind:'comment',body:'sum.cjs should add two numbers. Please fix the subtraction, run test.cjs, and commit the correction.'};
const gh={snapshot:async()=>({head:await git(remote,'rev-parse','refs/heads/fix'),state:merged?'MERGED':'OPEN',draft:false,mergeable:'MERGEABLE',mergeState:'CLEAN',reviewDecision:'APPROVED',headBranch:'fix',headRepo:'fixture/prsit-smoke',baseBranch:'main',checks:[{name:'fixture',state:'SUCCESS',url:''}],feedback:[feedback],unresolved:[],title:'Fix sum'}),ciLogs:async()=>'',respond:async()=>{replied=true;},merge:async()=>{merged=true;}};
const runtime=await openRuntime(w,await models(),{github:()=>gh});
try {
  const deadline=Date.now()+210000;
  while(!merged&&Date.now()<deadline){
    try{const s=JSON.parse(await readFile(join(process.env.PRSIT_HOME,w.id,'status.json'),'utf8'));if(s.status==='blocked')throw new Error(s.message);}catch(e){if(e.code!=='ENOENT')throw e;}
    await delay(250);
  }
  if(!merged||!replied)throw new Error('Smoke test did not finish');
  const result=await git(remote,'show','refs/heads/fix:sum.cjs');
  if(!result.includes('+'))throw new Error('Correction was not pushed');
  console.log('PASS: real native model repaired code, committed, passed validation, pushed to the local fixture, and completed the workflow.');
} finally {await runtime.close();await closeModels();console.log(`Smoke artifacts: ${dir}`);}
