import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {mkdir, readFile} from 'node:fs/promises';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {Harness, createRegistry, defineExtension, defineTask, defineDoc, configure,
  type TaskRuntime, type RunningTask, type ConversationId} from '@earendil-works/pi-durable';
import {CodingTools} from '@earendil-works/pi-durable/tools';
import {NodeExecutionEnv} from '@earendil-works/pi-durable/env/node';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import type {Models} from '@earendil-works/pi-ai';
import type {Watch, State, Snapshot, Job} from './types.js';
import {atomic, optional, json, log, watchDir, exec, hash} from './io.js';
import {GitHub} from './github.js';
import {prepare, validateChanges, push} from './git.js';
import {pending, mergeBlocker, validateReport} from './policy.js';
import {confirmPublication} from './publication.js';
import {modelRef, prompt, runNative, runOpenCode} from './agent.js';

export const initialState = (): State => ({phase:'poll', processed:{}, attempts:{}, nextPoll:0, message:'Registered', status:'watching'});
export interface Control {mode:'running'|'paused'|'removed'; retryAt?:number}
export interface Services {
  github: (w:Watch)=>GitHub;
  prepare: typeof prepare; validateChanges: typeof validateChanges; push: typeof push;
  native: typeof runNative; opencode: typeof runOpenCode;
}
const defaults: Services = {github:w=>new GitHub(w),prepare,validateChanges,push,native:runNative,opencode:runOpenCode};
const Meta = defineDoc<{task:number|null}>({kind:'prsit.meta',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({task:null}),checkpointWhen:()=>true});

export async function openRuntime(w:Watch, models:Models, overrides:Partial<Services>={}): Promise<{harness:Harness;close:()=>Promise<void>}> {
  const services={...defaults,...overrides};
  const github=services.github(w);
  const dir=watchDir(w);
  await mkdir(dir,{recursive:true,mode:0o700});
  let harness: Harness;
  let closing=false;
  const environments = new Map<string,NodeExecutionEnv>();
  type R = TaskRuntime<null,State,null,object>;
  type T = RunningTask<null,State,null>;
  async function transition(r:R,s:State) {
    await r.commit(()=>({status:'running',checkpoint:JSON.parse(JSON.stringify(s))}),ctx);
    await atomic(join(dir,'status.json'),{...s,updated:Date.now()});
  }
  async function sleep(r:R,s:State,until:number) {
    await r.sleepUntil(until,JSON.parse(JSON.stringify(s)),ctx);
    await atomic(join(dir,'status.json'),{...s,updated:Date.now()});
  }
  async function phase(t:T,r:R,body:(s:State)=>Promise<void>) {
    const s=structuredClone(t.state.checkpoint);
    try {
      if(s.blockedAt) {
        const c=await optional<Control>(join(dir,'control.json'));
        if((c?.retryAt ?? 0) > s.blockedAt) {
          if(s.phase==='publish' && s.job?.publishHead && s.job.result) {
            await log(w,'Retry requested; resuming saved publication without rerunning the agent');
            await transition(r,{...s,blockedAt:undefined,status:'publishing',message:'Resuming saved publication'});
          } else {
            await log(w,'Retry requested; retaining previous worktree and transcript');
            await transition(r,{...s,phase:'poll',job:undefined,blockedAt:undefined,attempts:{},status:'watching',nextPoll:0});
          }
        } else await sleep(r,s,Date.now()+5000);
        return;
      }
      await body(s);
    } catch(e) {
      if(closing || r.signal.aborted) throw e;
      const message=e instanceof Error ? e.message : String(e);
      await log(w,message);
      const failure:State={...s,message,status:s.phase==='poll'?'retrying':'blocked'};
      if(s.phase!=='poll') failure.blockedAt=Date.now();
      await sleep(r,failure,Date.now()+(failure.blockedAt?5000:w.interval));
    }
  }
  const Supervisor=defineTask<null,State,null>({
    name:'prsit.supervisor',version:1,initial:initialState,
    phases:{
      poll:(t,r)=>phase(t,r,async s=>{
        const snap=await github.snapshot();
        if(snap.state!=='OPEN') {
          await log(w,`PR ${snap.state.toLowerCase()}`);
          await r.commit(()=>({status:'terminal',outcome:{status:'completed',result:null}}),ctx);
          await atomic(join(dir,'status.json'),{...s,status:snap.state.toLowerCase(),message:`PR ${snap.state.toLowerCase()}`,updated:Date.now()});
          return;
        }
        if(snap.draft) { await sleep(r,{...s,status:'waiting',message:'Draft PR',phase:'poll',nextPoll:Date.now()+w.interval},Date.now()+w.interval); return; }
        const items=pending(snap,s);
        if(items.length) {
          const exhausted=items.find(i=>(s.attempts[i.key]??0)>=w.maxAttempts);
          if(exhausted) {
            await sleep(r,{...s,status:'blocked',message:`Retry limit reached for ${exhausted.key}`,blockedAt:Date.now()},Date.now()+5000); return;
          }
          for(const i of items) s.attempts[i.key]=(s.attempts[i.key]??0)+1;
          const job:Job={id:randomUUID(),snapshot:snap,items,worktree:'',started:Date.now()};
          await log(w,`Repair ${job.id}: ${items.map(i=>i.key).join(', ')}`);
          await transition(r,{...s,phase:'prepare',job,status:'preparing',message:`Preparing ${items.length} feedback items`});
          return;
        }
        const blocker=mergeBlocker(w,snap,s);
        if(!blocker) {
          // Read again immediately before the head-guarded GitHub merge operation.
          const fresh=await github.snapshot();
          const changed=fresh.head!==snap.head || mergeBlocker(w,fresh,s);
          if(!changed) {
            await log(w,`Submitting merge for ${fresh.head}`);
            await github.merge(fresh);
            const after=await github.snapshot();
            if(after.state==='MERGED') {
              await r.commit(()=>({status:'terminal',outcome:{status:'completed',result:null}}),ctx);
              await atomic(join(dir,'status.json'),{...s,status:'merged',message:'Merged on GitHub',updated:Date.now()});
              await log(w,'Merged on GitHub'); return;
            }
            await sleep(r,{...s,phase:'poll',status:'waiting',message:'Merge submitted; waiting for GitHub/merge queue',nextPoll:Date.now()+w.interval},Date.now()+w.interval); return;
          }
        }
        const next=Date.now()+w.interval;
        await sleep(r,{...s,phase:'poll',status:'waiting',message:blocker??'PR changed before merge; will check again',nextPoll:next},next);
      }),
      prepare:(t,r)=>phase(t,r,async s=>{
        const j=s.job!;
        j.worktree=await services.prepare(w,j.snapshot,j.id);
        await prompt(w,j,await github.ciLogs(j.snapshot));
        if(w.agent==='pi') {
          await r.commit(async tx=>{
            const child=await tx.createConversation({ownership:{kind:'task',taskId:r.taskId}});
            await configure(tx,child.id,{model:modelRef(w.model),cwd:j.worktree,instructions:'You are a careful coding agent. Follow repository instructions, verify fixes, and report blockers honestly.'});
            return {status:'running',checkpoint:{...s,phase:'repair',job:{...j,conversation:child.id},status:'repairing',message:'Agent repairing PR'}};
          },ctx);
        } else await transition(r,{...s,phase:'repair',status:'repairing',message:'OpenCode repairing PR'});
      }),
      repair:(t,r)=>phase(t,r,async s=>{
        const j=s.job!;
        const text=await readFile(join(dir,'jobs',j.id,'prompt.txt'),'utf8');
        await atomic(join(dir,'status.json'),{...s,updated:Date.now()});
        if(w.agent==='pi') await services.native(harness,w,j,text);
        else await services.opencode(w,j,text,r.signal);
        const report=validateReport(await json(join(dir,'jobs',j.id,'report.json')),j.items);
        if(report.outcome==='blocked') throw new Error(`Agent needs attention: ${report.summary}`);
        j.result=report;
        // This SHA is durable before any external publication occurs.
        j.publishHead=await services.validateChanges(j);
        if(w.test) await exec('/bin/sh',['-c',w.test],{cwd:j.worktree,timeout:w.timeout,signal:r.signal});
        if(await services.validateChanges(j)!==j.publishHead) throw new Error('Validation changed the worktree head');
        await log(w,`Agent completed: ${report.summary}`);
        await transition(r,{...s,phase:'publish',status:'publishing',message:'Publishing validated fixes'});
      }),
      publish:(t,r)=>phase(t,r,async s=>{
        const j=s.job!;
        if(await services.validateChanges(j)!==j.publishHead) throw new Error('Worktree changed after validation');
        const current=await github.snapshot();
        if(current.state!=='OPEN') throw new Error(`PR is now ${current.state}`);
        await services.push(w,j,j.publishHead!,current.head);
        const fresh=await confirmPublication(()=>github.snapshot(),j.snapshot.head,j.publishHead!,r.signal);
        for(const reply of j.result!.responses) {
          const item=j.items.find(i=>i.key===reply.key)!;
          const live=fresh.feedback.find(i=>i.key===item.key);
          if(live && live.fingerprint!==item.fingerprint) continue; // Edited feedback needs another pass.
          if(!live && item.kind==='thread') continue; // Already resolved externally.
          await github.respond(item,reply.body,reply.resolve,hash([w.id,j.id,item.key]));
        }
        for(const item of j.items) {
          // A failed check with no code change must get another bounded attempt, not disappear.
          if(!['ci','conflict'].includes(item.kind)) s.processed[item.key]=item.fingerprint;
        }
        await log(w,`Published ${j.publishHead}; checking GitHub again`);
        await transition(r,{...s,phase:'poll',job:undefined,status:'watching',message:'Fixes published; waiting for fresh checks',nextPoll:0});
      }),
      sleep:(t,r)=>phase(t,r,s=>sleep(r,{...s,phase:'poll'},s.nextPoll)),
    },
    abort:async(_t,r,c)=>{await r.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),c);},
  });
  const registry=createRegistry();
  registry.install(CodingTools);
  registry.install(defineExtension({name:'prsit',tasks:[Supervisor]}));
  harness=await Harness.open(await openNodeSqliteStorage(join(dir,'durable.sqlite')),{models,registry,
    env:target=>{const cwd=target.cwd??w.path;let env=environments.get(cwd);if(!env){env=new NodeExecutionEnv({cwd});environments.set(cwd,env);}return env;},
    onReport:(_error,report)=>{void log(w,`Runtime report: ${report.type}`);},
  },ctx);
  const root=await harness.root(ctx);
  await root.commit(async tx=>{
    const meta=await tx.doc(Meta,root.id);
    if(!meta.task) meta.task=await tx.createTask(Supervisor,null,{ownership:{kind:'conversation'}});
  },ctx);
  harness.resume();
  return {harness,close:async()=>{closing=true;await harness.close(ctx);for(const env of environments.values())await env.cleanup(ctx);}};
}
