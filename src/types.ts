export interface Watch {
  id: string;
  url: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
  path: string;
  remote: string;
  agent: "pi" | "opencode";
  model: string;
  interval: number;
  merge: "squash" | "merge" | "rebase";
  allowNoChecks: boolean;
  test: string | null;
  maxAttempts: number;
  timeout: number;
  created: number;
}
export interface Feedback {
  key: string;
  fingerprint: string;
  kind: "thread" | "comment" | "review" | "ci" | "conflict";
  body: string;
  threadId?: string;
  commentId?: number;
  canResolve?: boolean;
}
export interface Snapshot {
  head: string;
  state: string;
  draft: boolean;
  mergeable: string;
  mergeState: string;
  reviewDecision: string;
  headBranch: string;
  headRepo: string;
  baseBranch: string;
  checks: { name: string; state: string; url: string }[];
  feedback: Feedback[];
  unresolved: string[];
  title: string;
}
export interface Report {
  outcome: "addressed" | "blocked";
  summary: string;
  responses: { key: string; body: string; resolve: boolean }[];
}
export interface Job {
  id: string;
  snapshot: Snapshot;
  items: Feedback[];
  worktree: string;
  conversation?: number;
  started: number;
  result?: Report;
  publishHead?: string;
}
export type State = {
  blockedAt?: number;
  processed: Record<string, string>;
  attempts: Record<string, number>;
  job?: Job;
  nextPoll: number;
  message: string;
  status: string;
} & (
  | { phase: "poll" }
  | { phase: "prepare" }
  | { phase: "repair" }
  | { phase: "publish" }
  | { phase: "sleep" }
);
