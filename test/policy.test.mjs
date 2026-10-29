import test from "node:test";
import assert from "node:assert/strict";
import { mergeBlocker, pending, validateReport } from "../dist/policy.js";
import { parsePR } from "../dist/github.js";
import { repoIdentity } from "../dist/git.js";
import { initialState } from "../dist/runtime.js";
const w = { allowNoChecks: false };
const clean = {
  state: "OPEN",
  draft: false,
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  reviewDecision: "APPROVED",
  checks: [{ state: "SUCCESS" }],
  feedback: [],
  unresolved: [],
};
test("only a clean reviewed current snapshot passes the merge gate", () => {
  assert.equal(mergeBlocker(w, clean, initialState()), undefined);
  for (const patch of [
    { draft: true },
    { state: "CLOSED" },
    { mergeable: "UNKNOWN" },
    { mergeState: "BLOCKED" },
    { reviewDecision: "REVIEW_REQUIRED" },
    { reviewDecision: "CHANGES_REQUESTED" },
    { checks: [] },
    { checks: [{ state: "PENDING" }] },
    { checks: [{ state: "FAILURE" }] },
    { unresolved: ["thread"] },
    { feedback: [{ key: "x", fingerprint: "new" }] },
  ])
    assert.ok(mergeBlocker(w, { ...clean, ...patch }, initialState()));
  assert.ok(mergeBlocker(w, clean, { ...initialState(), job: { id: "active" } }));
  assert.equal(
    mergeBlocker({ allowNoChecks: true }, { ...clean, checks: [] }, initialState()),
    undefined,
  );
});
test("edited feedback retriggers but unchanged feedback is not repeated", () => {
  const state = { ...initialState(), processed: { x: "old" } };
  assert.equal(
    pending({ ...clean, feedback: [{ key: "x", fingerprint: "old" }] }, state).length,
    0,
  );
  assert.equal(
    pending({ ...clean, feedback: [{ key: "x", fingerprint: "new" }] }, state).length,
    1,
  );
});
test("reports require complete, unique responses with exact keys", () => {
  const items = [{ key: "thread:a", kind: "thread" }];
  const valid = {
    outcome: "addressed",
    summary: "Fixed and tested",
    responses: [{ key: "thread:a", body: "Fixed in abc", resolve: true }],
  };
  assert.deepEqual(validateReport(valid, items), valid);
  for (const report of [
    null,
    {},
    { ...valid, responses: [] },
    { ...valid, responses: [...valid.responses, ...valid.responses] },
    { ...valid, responses: [{ key: "wrong", body: "a", resolve: true }] },
  ])
    assert.throws(() => validateReport(report, items));
});
test("repository identities handle SSH and HTTPS without shell evaluation", () => {
  assert.equal(repoIdentity("git@github.com:Owner/Repo.git"), "github.com/owner/repo");
  assert.equal(repoIdentity("https://github.com/Owner/Repo.git"), "github.com/owner/repo");
  assert.equal(repoIdentity("ssh://git@github.com/Owner/Repo.git"), "github.com/owner/repo");
  assert.equal(parsePR("https://github.com/Owner/Repo/pull/12").number, 12);
  for (const bad of [
    "http://github.com/a/b/pull/1",
    "https://user:secret@github.com/a/b/pull/1",
    "https://github.com/a/b/issues/1",
  ])
    assert.throws(() => parsePR(bad));
});
