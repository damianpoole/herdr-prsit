import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {herdr, pluginId, currentWorkspace, openPluginView, namePluginTab} from './herdr.js';
import {controllerInfo, viewWorkspace} from './controller.js';
import {home} from './io.js';

export async function pluginAction(action: string) {
  if (!['start', 'dashboard'].includes(action)) throw new Error(`Unknown plugin action: ${action}`);
  if (action === 'start' && await controllerInfo()) throw new Error('A controller is already running. Open the PR sitter dashboard to inspect it.');
  const workspace = action === 'start' ? currentWorkspace() : await viewWorkspace();
  if(action==='dashboard'){await openPluginView('dashboard',workspace,true);return;}
  const result=await herdr(['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', action === 'start' ? 'controller' : 'dashboard',
    '--placement', 'tab', '--workspace', workspace, '--env', `PRSIT_HOME=${home()}`, '--focus']);
  await namePluginTab(result?.plugin_pane?.pane?.tab_id,'PR sitter');
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  pluginAction(process.argv[2] ?? '').catch(e => {console.error(`prsit: ${e.message}`);process.exitCode=1;});
}
