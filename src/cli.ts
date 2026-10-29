#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {readFile, mkdir, writeFile, open} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {home, watches, findWatch, optional, atomic, watchDir, exec, hash} from './io.js';
import {GitHub} from './github.js';
import {discover} from './git.js';
import {resolvePR} from './pr.js';
import {models, modelRef} from './agent.js';
import {daemon, ping} from './daemon.js';
import {openView} from './herdr.js';
import type {Watch, State} from './types.js';
import type {Control} from './runtime.js';

const help=`herdr-prsit — durable PR babysitting in your terminal

  prsit run [--headless]                    Run the controller inside Herdr
  prsit watch <number | URL> [options]    Register a PR for autonomous repair and merge
  prsit status [--json]                     Show all watches
  prsit open <watch ID | PR number>         Open a live view in a new Herdr workspace
  prsit logs <watch ID | PR number> [-f]     Show the activity log
  prsit pause <watch>                       Checkpoint and pause work
  prsit resume <watch>                      Resume checkpointed work
  prsit retry <watch>                       Retry blocked work using a fresh job
  prsit unwatch <watch>                     Stop watching; retain worktrees and history
  prsit doctor                             Check dependencies, GitHub and model access
  prsit models                             List configured, available Pi models

Watch options:
  --repo <path>       Local checkout (default: current repo, then remembered mapping)
  --agent pi|opencode Default: pi (native Pi Durable)
  --model <id>        provider/model-id (default: your Pi default model)
  --interval <15m>    GitHub polling interval; accepts s, m, h (default: 15m)
  --merge <squash>    squash, merge, or rebase
  --test <command>   Validation command to run independently before publication
  --max-attempts <3> Maximum automatic repairs of the same feedback key
  --timeout <30m>    Maximum duration of each repair
  --allow-no-checks  Permit merging a repository that has no checks

Registration authorizes commits, pushes, review replies, thread resolution, and merge.
State: PRSIT_HOME or $XDG_STATE_HOME/herdr-prsit. Requires Node >=22.19, git, gh.
`;
export function duration(value:string) {
  const m=value.match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
  if(!m)throw new Error('Duration must include s, m, or h (for example 15m)');
  const result=Number(m[1])*({s:1000,m:60000,h:3600000}[m[2]]!);
  if(!Number.isFinite(result)||result<1000)throw new Error('Duration must be at least 1s');
  return result;
}
export async function main(args=process.argv.slice(2)) {
  const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},json:{type:'boolean'},headless:{type:'boolean'},
    repo:{type:'string'},agent:{type:'string'},model:{type:'string'},interval:{type:'string'},merge:{type:'string'},
    test:{type:'string'},'max-attempts':{type:'string'},timeout:{type:'string'},'allow-no-checks':{type:'boolean'},
    follow:{type:'boolean',short:'f'},
  }});
  const command=p[0];
  if(v.help||!command){console.log(help);return;}
  if(command==='run'){await daemon(v.headless);return;}
  if(command==='watch') {
    if(!p[1])throw new Error('Supply a PR number or full PR URL');
    const pr=await resolvePR(p[1],v.repo);
    const id=hash(pr.url.toLowerCase()).slice(0,12);
    const existing=(await watches()).find(w=>w.id===id);
    if(existing)throw new Error(`Already registered as ${id}; use resume or retry`);
    const identity=`${pr.host}/${pr.owner}/${pr.repo}`;
    let location;
    if(v.repo)location=await discover(v.repo,identity);
    else {
      try {location=await discover(process.cwd(),identity);} catch(e) {
        const known=(await watches()).find(w=>`${w.host}/${w.owner}/${w.repo}`.toLowerCase()===identity.toLowerCase());
        if(!known)throw new Error(`Cannot locate this repository. Run inside its checkout or pass --repo <path>. ${String(e)}`);
        location=await discover(known.path,identity);
      }
    }
    const agent=v.agent??'pi';if(!['pi','opencode'].includes(agent))throw new Error('Agent must be pi or opencode');
    const settings=await optional<Record<string,any>>(join(process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi/agent'),'settings.json'));
    let model=v.model??process.env.PRSIT_MODEL;
    if(!model&&agent==='pi'&&settings?.defaultProvider&&settings.defaultModel)model=`${settings.defaultProvider}/${settings.defaultModel}`;
    if(!model)throw new Error('Pass --model provider/model-id, set PRSIT_MODEL, or configure a Pi default model');
    if(agent==='pi') {
      const ref=modelRef(model);const m=await models();
      if(!m.getModel(ref.provider,ref.modelId))throw new Error(`Unknown Pi model: ${model}`);
      if(!(await m.getAvailable(ref.provider)).some(x=>x.id===ref.modelId))throw new Error(`No configured authentication for ${model}; log in with Pi or set the provider environment variable`);
    }
    const merge=v.merge??'squash';if(!['squash','merge','rebase'].includes(merge))throw new Error('Merge must be squash, merge or rebase');
    const attempts=Number(v['max-attempts']??3);if(!Number.isSafeInteger(attempts)||attempts<1)throw new Error('max-attempts must be a positive integer');
    const w:Watch={...pr,id,...location,agent:agent as Watch['agent'],model,interval:duration(v.interval??'15m'),merge:merge as Watch['merge'],
      allowNoChecks:v['allow-no-checks']??false,test:v.test??null,maxAttempts:attempts,timeout:duration(v.timeout??'30m'),created:Date.now()};
    const snap=await new GitHub(w).snapshot();if(snap.state!=='OPEN')throw new Error(`PR is ${snap.state}`);
    await mkdir(join(home(),'watches'),{recursive:true,mode:0o700});
    // Exclusive creation prevents two terminal clients registering the same PR twice.
    await writeFile(join(home(),'watches',`${id}.json`),JSON.stringify(w,null,2),{flag:'wx',mode:0o600});
    console.log(`Watching ${pr.url}\nID: ${id}\nRepo: ${w.path}\nAgent: ${agent} (${model})\nPoll: ${w.interval/60000} minutes`);
    if(!await ping())console.log('Start the controller in a Herdr pane: prsit run');
    return;
  }
  if(command==='status') {
    const active=await ping();
    const list=await Promise.all((await watches()).map(async w=>({id:w.id,url:w.url,agent:w.agent,model:w.model,
      control:await optional<Control>(join(watchDir(w),'control.json'))??{mode:'running'},
      state:await optional<State>(join(watchDir(w),'status.json'))??{status:'registered',message:'Waiting for controller'}})));
    if(v.json)console.log(JSON.stringify({controllerRunning:active,watches:list},null,2));
    else {console.log(`Controller: ${active?'running':'stopped'}`);for(const x of list)console.log(`${x.id}  ${x.control.mode==='running'?x.state.status:x.control.mode}  ${x.url}\n  ${x.state.message}`);}
    return;
  }
  if(['pause','resume','retry','unwatch'].includes(command)) {
    const w=await findWatch(p[1]??'');
    await atomic(join(watchDir(w),'control.json'),{mode:command==='pause'?'paused':command==='unwatch'?'removed':'running',...(command==='retry'?{retryAt:Date.now()}:{} )});
    console.log(`${command}: ${w.url}`);return;
  }
  if(command==='open'){console.log(`Herdr pane: ${await openView(await findWatch(p[1]??''))}`);return;}
  if(command==='logs') {
    const w=await findWatch(p[1]??'');let offset=0;let stop=false;
    const finish=()=>{stop=true;};process.on('SIGINT',finish);process.on('SIGTERM',finish);
    try {do {
      try {const f=await open(join(watchDir(w),'events.log'),'r');try{const size=(await f.stat()).size;if(size<offset)offset=0;
        while(offset<size){const b=Buffer.alloc(Math.min(size-offset,65536));const {bytesRead}=await f.read(b,0,b.length,offset);if(!bytesRead)break;process.stdout.write(b.subarray(0,bytesRead));offset+=bytesRead;}}finally{await f.close();}}
      catch(e:any){if(e.code!=='ENOENT')throw e;}
      if(v.follow&&!stop)await delay(300);
    }while(v.follow&&!stop);}finally{process.removeListener('SIGINT',finish);process.removeListener('SIGTERM',finish);}return;
  }
  if(command==='models'){for(const m of await (await models()).getAvailable())console.log(`${m.provider}/${m.id}`);return;}
  if(command==='doctor') {
    for(const [bin,args] of [['git',['--version']],['gh',['--version']],['herdr',['--version']]] as const){try{console.log((await exec(bin,[...args])).stdout.split('\n')[0]);}catch(e){console.log(String(e));}}
    console.log(`Node ${process.version}; Herdr pane: ${process.env.HERDR_ENV==='1'?'yes':'no'}`);
    try{console.log(`GitHub: ${(await exec('gh',['api','user','--jq','.login'])).stdout.trim()}`);}catch(e){console.log(String(e));}
    console.log(`Configured Pi models: ${(await (await models()).getAvailable()).length}`);return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(`prsit: ${e.message}`);process.exitCode=1;});
