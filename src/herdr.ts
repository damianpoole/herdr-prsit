import {exec, quote, home, optional, atomic, watchDir} from './io.js';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import type {Watch} from './types.js';
export function requireHerdr() {
  if (process.env.HERDR_ENV !== '1') throw new Error('Run prsit run inside a Herdr pane (HERDR_ENV=1). For an unattended/test host use --headless.');
}
export async function openView(w: Watch) {
  requireHerdr();
  const result = JSON.parse((await exec('herdr', ['workspace','create','--cwd',w.path,'--label',`prsit #${w.number}`,'--no-focus'])).stdout);
  const pane = result.result?.root_pane?.pane_id;
  if (typeof pane !== 'string') throw new Error('Herdr returned no root pane ID');
  await atomic(join(watchDir(w),'pane.json'), {pane, workspace:result.result.workspace});
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  await exec('herdr', ['pane','run',pane,`PRSIT_HOME=${quote(home())} ${quote(process.execPath)} ${quote(cli)} logs ${quote(w.id)} --follow`]);
  return pane;
}
