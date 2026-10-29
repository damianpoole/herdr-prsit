import test from "node:test";
import assert from "node:assert/strict";
import { observeCodexReview } from "../dist/codex-review.js";
import { mergeBlocker } from "../dist/policy.js";
import { initialState } from "../dist/runtime.js";
const watch = { requireCodexReview: true, allowNoChecks: true };
const clean = {
  head: "abc",
  state: "OPEN",
  draft: false,
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  reviewDecision: "",
  checks: [],
  feedback: [],
  unresolved: [],
  codexReactions: [],
};
const reaction = (id, content, seconds, source = "pr") => ({
  id,
  content,
  createdAt: `2026-10-29T19:00:${seconds}Z`,
  source,
});
const eyes = reaction("eyes", "eyes", "01");
const thumb = reaction("thumb", "+1", "02");
function step(state, reactions, patch = {}) {
  const snap = { ...clean, codexReactions: reactions, ...patch };
  observeCodexReview(snap, state);
  return mergeBlocker(watch, snap, state);
}
test("opt-in requires an observed fresh cycle and never reuses preexisting approval", () => {
  const s = initialState();
  assert.ok(step(s, [thumb]));
  assert.ok(step(s, [eyes, thumb]));
  assert.ok(step(s, [thumb]));
  assert.equal(step(s, [reaction("fresh", "+1", "03")]), undefined);
  assert.ok(step(s, [])); // Removing the approval revokes it.
  assert.equal(mergeBlocker({ allowNoChecks: true }, clean, initialState()), undefined);
});
test("eyes and thumb must belong to the same source and have valid ordered timestamps", () => {
  for (const bad of [
    reaction("x", "+1", "00"),
    { ...thumb, createdAt: "invalid" },
    { ...thumb, source: "comment" },
  ]) {
    const s = initialState();
    step(s, []);
    step(s, [eyes]);
    assert.ok(step(s, [bad]));
  }
  const s = initialState();
  step(s, []);
  step(s, [eyes]);
  assert.ok(step(s, [eyes, thumb]));
  assert.equal(step(s, [thumb]), undefined);
});
test("head changes invalidate the cycle; old eyes cannot become a new cycle", () => {
  const s = initialState();
  step(s, []);
  step(s, [eyes]);
  assert.ok(step(s, [eyes], { head: "def" }));
  assert.ok(step(s, [thumb], { head: "def" }));
  assert.ok(step(s, [eyes], { head: "def" }));
  assert.ok(step(s, [thumb], { head: "def" }));
  const freshEyes = reaction("new-eyes", "eyes", "03");
  assert.ok(step(s, [freshEyes], { head: "def" }));
  assert.equal(step(s, [reaction("new-thumb", "+1", "04")], { head: "def" }), undefined);
});
test("checkpoint round trips preserve the cycle and every other gate still applies", () => {
  let s = initialState();
  step(s, []);
  step(s, [eyes]);
  s = JSON.parse(JSON.stringify(s));
  assert.equal(step(s, [thumb]), undefined);
  for (const patch of [
    { draft: true },
    { state: "CLOSED" },
    { mergeState: "BLOCKED" },
    { reviewDecision: "REVIEW_REQUIRED" },
    { reviewDecision: "CHANGES_REQUESTED" },
    { checks: [{ state: "FAILURE" }] },
    { unresolved: ["thread"] },
    { feedback: [{ key: "x", fingerprint: "new" }] },
    { codexReactions: undefined },
  ])
    assert.ok(step(s, [thumb], patch));
  assert.ok(
    mergeBlocker({ ...watch, allowNoChecks: false }, { ...clean, codexReactions: [thumb] }, s),
  );
});
test("a second review invalidates an earlier thumb even on the same head", () => {
  const s = initialState();
  step(s, []);
  step(s, [eyes]);
  assert.equal(step(s, [thumb]), undefined);
  step(s, [thumb, reaction("second", "eyes", "03")]);
  assert.ok(step(s, [thumb]));
  assert.equal(step(s, [reaction("second-thumb", "+1", "04")]), undefined);
});
