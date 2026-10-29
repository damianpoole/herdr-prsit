import { hash } from "./io.js";
import type { Watch, Snapshot } from "./types.js";

type Comment = {
  id: number;
  body: string;
  created_at?: string;
  user?: { id?: number; login?: string; type?: string };
};
export function isCodexAuthor(user: Comment["user"], host: string) {
  if (user?.login !== "chatgpt-codex-connector[bot]") return false;
  // GitHub currently labels this integration account as User in REST responses.
  return host === "github.com" ? user.id === 199175422 : user.type === "Bot";
}
export const reviewRequestBody = (w: Watch, head: string) =>
  `@codex review\n\n<!-- herdr-prsit:codex-review:${hash([w.id, head])} -->`;
export function parseCodexSummary(body: string): Snapshot["codexSummary"] {
  if (!body.startsWith("<!-- codex-pull-request-review-summary -->")) return;
  const match = body.match(/<!-- codex-review-state:v1 (\{[^\n]*\}) -->/);
  if (!match) return;
  try {
    const state = JSON.parse(match[1]),
      review = state.code_review,
      security = state.security_review;
    if (!review || !/^[a-f0-9]{40}$/.test(review.commit_sha) || typeof review.status !== "string")
      return;
    // Use the code-review completion time, not the comment's edit time: a later
    // security review or metadata update must not make an old code review fresh.
    const completedAt = body.match(
      /^\|[^|\n]*\*\*Code Review\*\*[^|\n]*\|[^|\n]*\*\*Completed\*\*[^|\n]*<relative-time datetime="([^"]+)"/m,
    )?.[1];
    const clean =
      review.has_any_findings === false &&
      review.has_unresolved_findings === false &&
      (security?.status === null ||
        (security?.status === "completed" &&
          security.commit_sha === review.commit_sha &&
          security.has_any_findings === false &&
          security.has_unresolved_findings === false));
    return { head: review.commit_sha, status: review.status, clean, completedAt };
  } catch {
    return;
  }
}
export function codexStatus(w: Watch, head: string, comments: Comment[]) {
  const trusted = comments.filter((c) => isCodexAuthor(c.user, w.host));
  const summaries = trusted
    .map((c) => ({ comment: c, summary: parseCodexSummary(c.body) }))
    .filter((c) => c.summary);
  const latest = summaries.sort((a, b) => b.comment.id - a.comment.id)[0]?.summary;
  const request = comments
    .filter((c) => c.body === reviewRequestBody(w, head))
    .sort((a, b) => b.id - a.id)[0];
  const informational = new Set(summaries.map((c) => c.comment.id));
  for (const c of trusted) {
    // Only suppress this specific no-findings receipt, not arbitrary bot prose.
    const reviewed = c.body.match(/\*\*Reviewed commit:\*\* `([a-f0-9]{10,40})`/)?.[1];
    if (
      c.body.startsWith(
        "<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.",
      ) &&
      reviewed &&
      head.startsWith(reviewed)
    )
      informational.add(c.id);
  }
  return { summary: latest, requestedAt: request?.created_at, informational };
}
