import test from "node:test";
import assert from "node:assert/strict";
import {
  codexStatus,
  parseCodexSummary,
  reviewRequestBody,
  isCodexAuthor,
} from "../dist/codex-status.js";
import { codexReviewBlocker } from "../dist/codex-review.js";
const head = "573d3b5498d7858ec6b5aed551c6b2692cc99ed6";
const user = { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "User" };
const w = { id: "fixture", host: "github.com" };
const at = "2026-10-29T19:45:26Z",
  done = "2026-10-29T19:47:17.989139Z";
function body(patch = {}, security = { status: null }) {
  const data = {
    code_review: {
      commit_sha: head,
      status: "completed",
      has_any_findings: false,
      has_unresolved_findings: false,
      ...patch,
    },
    security_review: security,
  };
  return `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(data)} -->\n\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${done}">${done}</relative-time> |`;
}
const comments = [
  { id: 1, user, body: body() },
  { id: 2, user: { login: "owner" }, body: reviewRequestBody(w, head), created_at: at },
];
const status = codexStatus(w, head, comments);
const snap = {
  head,
  codexSummary: status.summary,
  codexRequestedAt: status.requestedAt,
  codexReactions: [{ id: "thumb", content: "+1", createdAt: "2026-10-29T19:47:21Z", source: "pr" }],
};
const state = { codexReviewRequest: { head, phase: "requested" } };
test("live summary shape and thumbs-up approve exact commit even when eyes was missed", () => {
  assert.equal(isCodexAuthor(user, "github.com"), true);
  assert.equal(codexReviewBlocker(snap, state), undefined);
  assert.equal(status.summary.head, head);
  assert.equal(status.summary.completedAt, done);
});
test("summary approval rejects stale, wrong-head, pending, findings, absent approval and absent request", () => {
  for (const patch of [
    { codexRequestedAt: done },
    { codexRequestedAt: undefined },
    { codexReactions: [] },
    { codexReactions: [{ ...snap.codexReactions[0], createdAt: at }] },
    { codexReactions: [{ content: "eyes" }] },
    { codexSummary: { ...status.summary, head: "a".repeat(40) } },
    { codexSummary: { ...status.summary, status: "in_progress" } },
    { codexSummary: { ...status.summary, clean: false } },
    { codexSummary: { ...status.summary, completedAt: undefined } },
  ])
    assert.ok(codexReviewBlocker({ ...snap, ...patch }, state));
  assert.ok(codexReviewBlocker(snap, {}));
});
test("only authenticated structured status and exact no-findings receipts are informational", () => {
  const receipt =
    "<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. What next?\n\n**Reviewed commit:** `573d3b5498`";
  const cs = [
    ...comments,
    { id: 3, user, body: receipt },
    { id: 4, user: { ...user, id: 123 }, body: body() },
    { id: 5, user, body: "Please fix a bug" },
    { id: 6, user, body: "<!-- codex-review-state:v1 malformed -->" },
    { id: 7, user, body: receipt.replace("573d3b5498", "aaaaaaaaaa") },
    { id: 8, user: { ...user, id: 123 }, body: receipt },
    { id: 9, user, body: receipt.replace("573d3b5498", "invalid") },
    { id: 10, user, body: receipt.replace("Didn't find any major issues.", "Found a bug.") },
  ];
  assert.deepEqual([...codexStatus(w, head, cs).informational], [1, 3, 7]);
  assert.equal(isCodexAuthor({ ...user, login: "someone" }, "github.com"), false);
  assert.equal(isCodexAuthor(user, "enterprise.example"), false);
});
test("historical no-findings receipts stay informational on registration and head changes without approving", () => {
  const receipt = {
    id: 3,
    user,
    body: "<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.\n\n**Reviewed commit:** `573d3b5498`",
  };
  // Each poll recomputes informational IDs, without relying on processed feedback.
  // Start on a different head (registration), revisit the reviewed head, then advance.
  for (const currentHead of ["a".repeat(40), head, "b".repeat(40)]) {
    const current = codexStatus(w, currentHead, [...comments, receipt]);
    assert.ok(current.informational.has(receipt.id));
    assert.ok(
      codexReviewBlocker(
        { ...snap, head: currentHead, codexSummary: current.summary },
        { codexReviewRequest: { head: currentHead, phase: "pending" } },
      ),
    );
    if (currentHead !== head) assert.ok(codexReviewBlocker({ ...snap, head: currentHead }, state));
  }
});
test("malformed or incomplete review metadata cannot prove a clean review", () => {
  assert.equal(
    parseCodexSummary(
      "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {oops} -->",
    ),
    undefined,
  );
  assert.equal(parseCodexSummary(body({ commit_sha: "573d3b5" })), undefined);
  assert.equal(parseCodexSummary(body({ has_any_findings: null })).clean, false);
  assert.equal(parseCodexSummary(body({}, { status: "in_progress" })).clean, false);
  assert.equal(
    parseCodexSummary(
      body(
        {},
        {
          status: "completed",
          commit_sha: head,
          has_any_findings: false,
          has_unresolved_findings: false,
        },
      ),
    ).clean,
    true,
  );
});
