import {mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {exec, home, hash, atomic, optional} from './io.js';
import type {Watch} from './types.js';
import {plain, presentation, activityLabel, watchSnapshot, type WatchSnapshot} from './presentation.js';

export const pluginId = 'herdr-prsit';
export function requireHerdr() {
  if (process.env.HERDR_ENV !== '1') throw new Error('Run inside a Herdr pane (HERDR_ENV=1). Use prsit run --headless without Herdr.');
}
export function currentWorkspace(): string {
  requireHerdr();
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (!workspace) throw new Error('Herdr did not provide HERDR_WORKSPACE_ID; run inside a Herdr workspace.');
  return workspace;
}
export const herdrSession = () => process.env.HERDR_SOCKET_PATH ?? `session:${process.env.HERDR_SESSION ?? 'default'}`;
// Read/create commands return JSON. Report and release commands intentionally
// print nothing on success in Herdr 0.9.1; their exit code is the acknowledgement.
export async function herdrCommand(args: string[]) {
  requireHerdr();
  return exec(process.env.HERDR_BIN_PATH ?? 'herdr', args, {timeout: 5000});
}
export async function herdr(args: string[]) {
  const {stdout} = await herdrCommand(args);
  try {
    const response=JSON.parse(stdout);
    if(!response.result) throw new Error('missing result');
    return response.result;
  } catch {
    throw new Error(`herdr ${args.slice(0,3).join(' ')} returned ${stdout.trim() ? 'invalid' : 'empty'} JSON`);
  }
}

interface Pane {tab_id: string; pane_id: string; terminal_id: string; workspace_id: string; tokens?: Record<string, string>}
type ViewKind = 'watch' | 'dashboard';
interface ViewReceipt {phase: 'opening' | 'open'; pane?: string; terminal?: string}
const receiptPath = (kind: ViewKind, w?: Watch) => join(home(),'herdr-views',`${hash([herdrSession(),kind,w?.id])}.json`);
const identity = (kind: ViewKind, w?: Watch) => ({prsit_home: hash(home()), prsit_view: kind, ...(w ? {prsit_watch:w.id} : {})});
async function panes(): Promise<Pane[]> {
  const result = await herdr(['pane', 'list']);
  if (!Array.isArray(result?.panes)) throw new Error('Herdr returned no panes list');
  return result.panes;
}
export async function findView(w: Watch): Promise<Pane | undefined> {
  const tokens=identity('watch',w);
  return (await panes()).find(p=>p.tokens?.prsit_watch===tokens.prsit_watch && p.tokens?.prsit_home===tokens.prsit_home);
}

export async function openPluginView(kind: ViewKind, workspace: string, focus: boolean, w?: Watch) {
  const path=receiptPath(kind,w);
  const receipt=await optional<ViewReceipt>(path);
  const live=await panes();
  const tokens=identity(kind,w);
  let pane=live.find(p=>Object.entries(tokens).every(([k,v])=>p.tokens?.[k]===v));
  // A successful create is saved before reporting metadata. Missing/expired
  // metadata must never turn a reporting failure into another pane creation.
  pane ??= live.find(p=>p.pane_id===receipt?.pane && p.terminal_id===receipt?.terminal);
  if(!pane) {
    if(receipt?.phase==='opening') throw new Error('A Herdr view creation is pending or its result is unknown; refusing to open a duplicate. Inspect existing PR sitter tabs before resetting its local view receipt.');
    if(receipt)await rm(path,{force:true});
    await mkdir(join(home(),'herdr-views'),{recursive:true,mode:0o700});
    try {await writeFile(path,JSON.stringify({phase:'opening'}),{flag:'wx',mode:0o600});}
    catch(e:any) {if(e.code==='EEXIST')throw new Error('This Herdr view is already being opened; try again shortly.');throw e;}
    try {
      const result=await herdr(['plugin','pane','open','--plugin',pluginId,'--entrypoint',kind,
        '--placement','tab','--workspace',workspace,...(w?['--cwd',w.path]:[]),
        '--env',`PRSIT_HOME=${home()}`,...(w?['--env',`PRSIT_WATCH_ID=${w.id}`]:[]),focus?'--focus':'--no-focus']);
      pane=result?.plugin_pane?.pane;
      if(!pane || typeof pane.pane_id!=='string' || typeof pane.terminal_id!=='string')throw new Error('Herdr returned no plugin pane identity');
    } catch(e) {
      // These explicit server rejections prove no pane was launched. Transport
      // failures and malformed successes retain the claim until reconciled.
      if(/plugin_not_found|plugin_disabled|entrypoint_not_found|workspace_not_found|platform_unsupported/.test(String(e))) await rm(path,{force:true});
      throw e;
    }
  }
  await atomic(path,{phase:'open',pane:pane.pane_id,terminal:pane.terminal_id});
  const saved=w ? await watchSnapshot(w) : undefined;
  await namePluginTab(pane.tab_id,kind==='dashboard'?'PR dashboard':prLabel(w!,activityLabel(saved?.state,saved?.control)));
  await markPluginView(kind,pane.pane_id,w);
  if(focus)await herdrCommand(['plugin','pane','focus',pane.pane_id]);
  return pane.pane_id;
}
export async function namePluginTab(tab: string, label: string) {
  if(typeof tab!=='string' || !tab)throw new Error('Herdr returned no tab ID for naming the plugin view');
  await herdrCommand(['tab','rename',tab,plain(label)]);
}
export async function openView(w: Watch, workspace = currentWorkspace(), focus = true) {
  return openPluginView('watch',workspace,focus,w);
}
export async function markPluginView(kind: ViewKind, pane: string, w?: Watch) {
  await herdrCommand(['pane','report-metadata',pane,'--source',`custom:prsit:${w?.id??'dashboard'}`,
    ...Object.entries(identity(kind,w)).flatMap(([k,v])=>['--token',`${k}=${v}`]),'--ttl-ms','30000']);
}
export const markView = (w: Watch, pane: string) => markPluginView('watch',pane,w);
export async function releasePluginView(kind: ViewKind, pane: string, w?: Watch) {
  const path=receiptPath(kind,w);
  const receipt=await optional<ViewReceipt>(path);
  if(receipt?.pane===pane)await rm(path,{force:true});
  await herdrCommand(['pane','report-metadata',pane,'--source',`custom:prsit:${w?.id??'dashboard'}`,
    '--clear-token','prsit_view','--clear-token','prsit_watch','--clear-token','prsit_home']);
}

function prLabel(w: Watch, stage: string) {
  const name=plain(`PR #${w.number} ${w.owner}/${w.repo}`).slice(0,Math.max(20,77-stage.length));
  return `${name} — ${stage}`;
}

export class SidebarReporter {
  private last = '';
  private refreshed = 0;
  private lastTab = '';
  constructor(private pane: string, private w: Watch) {}
  async update(snapshot: WatchSnapshot, running: boolean, now = Date.now()) {
    const {stage, semantic} = presentation(snapshot, running);
    const value = JSON.stringify([stage, semantic]);
    if (value === this.last && now - this.refreshed < 10_000) return;
    const source = `custom:prsit:${this.w.id}`;
    const label=prLabel(this.w,stage);
    const name=plain(`PR #${this.w.number} ${this.w.owner}/${this.w.repo}`);
    await markView(this.w,this.pane);
    await herdrCommand(['pane', 'report-agent', this.pane, '--source', source, '--agent', 'prsit', '--state', semantic, '--message', stage]);
    await herdrCommand(['pane', 'report-metadata', this.pane, '--source', source, '--agent', 'prsit', '--applies-to-source', source,
      '--display-agent', label, '--title', name,
      ...['idle', 'done', 'working', 'blocked', 'unknown'].flatMap(state => ['--state-label', `${state}=${stage}`]),
      '--token', `prsit_stage=${stage}`, '--ttl-ms', '30000']);
    // Resolve the actual tab on refresh, including after a pane is moved.
    const current=await herdr(['pane','get',this.pane]);
    const tab=current?.pane?.tab_id;
    const tabValue=JSON.stringify([tab,label]);
    if(tabValue!==this.lastTab) {
      await namePluginTab(tab,label);
      this.lastTab=tabValue;
    }
    this.last = value;
    this.refreshed = now;
  }
  async release() {
    this.last = '';
    this.refreshed = 0;
    this.lastTab = '';
    await releasePluginView('watch',this.pane,this.w);
    await herdrCommand(['pane', 'release-agent', this.pane, '--source', `custom:prsit:${this.w.id}`, '--agent', 'prsit']);
    await herdrCommand(['pane', 'report-metadata', this.pane, '--source', `custom:prsit:${this.w.id}`,
      '--clear-token', 'prsit_watch', '--clear-token', 'prsit_home', '--clear-token', 'prsit_stage',
      '--clear-display-agent', '--clear-title', '--clear-state-labels']);
  }
}
