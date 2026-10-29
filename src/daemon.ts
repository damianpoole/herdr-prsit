import {createServer, createConnection, type Server} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {unlink, mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {home, hash, watches, optional, atomic, watchDir, log} from './io.js';
import {models,closeModels} from './agent.js';
import {openRuntime, type Control} from './runtime.js';
import {openView, requireHerdr} from './herdr.js';
export const socketPath=()=>join(tmpdir(),`prsit-${process.getuid?.()??'user'}-${hash(home()).slice(0,16)}.sock`);
export async function ping():Promise<boolean> {
  return new Promise(resolve=>{
    const socket=createConnection(socketPath());
    socket.setTimeout(1000);
    const finish=(value:boolean)=>{socket.destroy();resolve(value);};
    socket.on('data',()=>finish(true));socket.on('error',()=>finish(false));socket.on('timeout',()=>finish(false));
    socket.on('connect',()=>socket.write('ping\n'));
  });
}
export async function acquire():Promise<Server> {
  const server=createServer(s=>{s.end(JSON.stringify({pid:process.pid})+'\n');});
  const listen=()=>new Promise<void>((resolve,reject)=>{
    const error=(e:Error)=>{server.removeListener('listening',ready);reject(e);};
    const ready=()=>{server.removeListener('error',error);resolve();};
    server.once('error',error);server.once('listening',ready);server.listen(socketPath());
  });
  try {await listen();} catch(e:any) {
    if(e.code!=='EADDRINUSE')throw e;
    if(await ping())throw new Error('A prsit controller is already running for this state directory');
    // Only an unresponsive, pre-existing socket is eligible for stale cleanup.
    await unlink(socketPath()).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});
    await listen();
  }
  return server;
}
export async function daemon(headless=false) {
  if(!headless)requireHerdr();
  await mkdir(home(),{recursive:true,mode:0o700});
  const lock=await acquire();
  const active=new Map<string,Awaited<ReturnType<typeof openRuntime>>>();
  let stopped=false;
  const stop=()=>{stopped=true;};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    const m=await models();
    console.log(`herdr-prsit running. State: ${home()}\nRegister PRs from another pane with prsit watch <url>. Ctrl+C saves progress.`);
    while(!stopped) {
      for(const w of await watches()) {
        const control=await optional<Control>(join(watchDir(w),'control.json'));
        if(control && control.mode!=='running') {
          if(active.has(w.id)){await active.get(w.id)!.close();active.delete(w.id);await log(w,control.mode);}
          continue;
        }
        if(active.has(w.id))continue;
        try {
          active.set(w.id,await openRuntime(w,m));
          if(!headless && !(await optional(join(watchDir(w),'pane.json')))) {
            try {await openView(w);} catch(e){await log(w,`Could not open Herdr view: ${String(e)}. Use prsit open ${w.id}.`);}
          }
        } catch(e) {await log(w,`Could not open runtime: ${String(e)}`);await atomic(join(watchDir(w),'control.json'),{mode:'paused'});}
      }
      await delay(1000);
    }
  } finally {
    await Promise.allSettled([...active.values()].map(r=>r.close()));
    await closeModels();
    await new Promise<void>(resolve=>lock.close(()=>resolve()));
    await unlink(socketPath()).catch(()=>{});
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
