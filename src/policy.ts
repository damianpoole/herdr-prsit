import type {Watch, Snapshot, State, Report, Feedback} from './types.js';
export function pending(s: Snapshot, state: State) {
  return s.feedback.filter(i => state.processed[i.key] !== i.fingerprint);
}
export function mergeBlocker(w: Watch, s: Snapshot, state: State): string | undefined {
  if (s.state !== 'OPEN') return `PR is ${s.state.toLowerCase()}`;
  if (s.draft) return 'PR is a draft';
  if (state.job) return 'Repair job is active';
  if (pending(s,state).length) return 'Feedback has not been addressed';
  if (s.unresolved.length) return 'Unresolved review threads';
  if (s.reviewDecision === 'CHANGES_REQUESTED' || s.reviewDecision === 'REVIEW_REQUIRED') return 'Waiting for required review';
  if (!s.checks.length && !w.allowNoChecks) return 'No checks reported (use --allow-no-checks only for repositories without CI)';
  if (s.checks.some(c => !['SUCCESS','NEUTRAL','SKIPPED'].includes(c.state))) return 'Waiting for passing checks';
  if (s.mergeable !== 'MERGEABLE' || s.mergeState !== 'CLEAN') return `GitHub merge state: ${s.mergeState}/${s.mergeable}`;
  return undefined;
}
export function validateReport(raw: unknown, items: Feedback[]): Report {
  if (!raw || typeof raw !== 'object') throw new Error('Agent report must be an object');
  const r = raw as Report;
  if (!['addressed','blocked'].includes(r.outcome) || typeof r.summary !== 'string' || !r.summary.trim() || !Array.isArray(r.responses)) throw new Error('Agent report is missing outcome, summary or responses');
  const keys = new Set<string>();
  for (const response of r.responses) {
    if (!items.some(i => i.key === response.key) || keys.has(response.key) || typeof response.body !== 'string' || !response.body.trim() || response.body.length > 50_000 || typeof response.resolve !== 'boolean') throw new Error('Agent response is invalid or duplicates a feedback item');
    keys.add(response.key);
  }
  if (r.outcome === 'addressed' && items.filter(i => ['thread','comment','review'].includes(i.kind)).some(i => !keys.has(i.key))) throw new Error('Agent omitted a response to feedback');
  return r;
}
