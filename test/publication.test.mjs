import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmPublication} from '../dist/publication.js';

test('post-push confirmation has a bounded wait and reports both SHAs',async()=>{
  let reads=0,waits=0;
  await assert.rejects(()=>confirmPublication(async()=>{reads++;return {state:'OPEN',head:'old'};},'old','new',undefined,async()=>{waits++;}),/expected new, still reports old/);
  assert.equal(reads,11);assert.equal(waits,10);
});
test('unexpected commits and closed PRs block immediately',async()=>{
  for(const snapshot of [{state:'OPEN',head:'other'},{state:'CLOSED',head:'new'}]) {
    await assert.rejects(()=>confirmPublication(async()=>snapshot,'old','new',undefined,async()=>assert.fail('must not wait')),/PR head changed|PR is now CLOSED/);
  }
});
test('shutdown aborts post-push confirmation before another read',async()=>{
  const controller=new AbortController();let reads=0;
  await assert.rejects(()=>confirmPublication(async()=>{reads++;return {state:'OPEN',head:'old'};},'old','new',controller.signal,async()=>controller.abort()),{name:'AbortError'});
  assert.equal(reads,1);
});
