import {setTimeout as delay} from 'node:timers/promises';
import type {Snapshot} from './types.js';

// GitHub's PR view may lag behind a successful Git push. Only the original
// head is an expected stale read; another commit must never be accepted.
export async function confirmPublication(
  snapshot: () => Promise<Snapshot>, original: string, expected: string,
  signal?: AbortSignal,
  wait: () => Promise<void> = () => delay(1000, undefined, {signal}),
): Promise<Snapshot> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const fresh = await snapshot();
    if (fresh.state !== 'OPEN') throw new Error(`PR is now ${fresh.state}`);
    if (fresh.head === expected) return fresh;
    if (fresh.head !== original)
      throw new Error(`PR head changed after push: expected ${expected}, observed ${fresh.head}`);
    if (attempt === 10)
      throw new Error(`GitHub has not confirmed the push: expected ${expected}, still reports ${fresh.head}. Retry to resume publication without rerunning the agent.`);
    await wait();
  }
}
