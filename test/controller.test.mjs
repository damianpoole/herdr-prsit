import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {stopController,controllerInfo,socketPath} from '../dist/controller.js';

test('stop requests graceful shutdown through the registered controller PID, without a Herdr pane',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'prsit-stop-'));
  const previous=process.env.PRSIT_HOME;process.env.PRSIT_HOME=dir;
  const socket=socketPath();
  t.after(async()=>{if(previous===undefined)delete process.env.PRSIT_HOME;else process.env.PRSIT_HOME=previous;await rm(socket,{force:true});await rm(dir,{recursive:true,force:true});});
  assert.equal(await stopController(),false);
  const moduleUrl=new URL('../dist/controller.js',import.meta.url).href;
  const script=`import {acquire} from ${JSON.stringify(moduleUrl)};import {writeFile} from 'node:fs/promises';const server=await acquire();process.on('SIGTERM',async()=>{await writeFile(process.env.PRSIT_HOME+'/checkpoint','saved');server.close();});console.log('ready');`;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.HERDR_ENV;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env,stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close');
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  await once(child.stdout,'data');
  assert.equal((await controllerInfo()).pid,child.pid);
  assert.equal(await stopController(),true);
  const [code]=await closed;
  assert.equal(code,0);
  assert.equal(await readFile(join(dir,'checkpoint'),'utf8'),'saved');
  assert.equal(await controllerInfo(),undefined);
});
