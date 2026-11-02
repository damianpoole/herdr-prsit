import test from "node:test";
import assert from "node:assert/strict";
import { activityLabel, presentation } from "../dist/presentation.js";

test("presentation reflects actual repair stages and never equates agent completion with merge", () => {
  const label = (status, message = "", extra = {}) => activityLabel({ status, message, ...extra });
  assert.equal(activityLabel(), "watching");
  assert.equal(label("preparing"), "preparing repair");
  assert.equal(label("repairing", "", { job: { items: [{ kind: "ci" }] } }), "fixing checks");
  assert.equal(
    label("repairing", "", { job: { items: [{ kind: "conflict" }] } }),
    "resolving conflicts",
  );
  assert.equal(label("publishing"), "publishing fixes");
  assert.equal(
    label("waiting", "Waiting to observe a fresh Codex review", {
      codexReviewRequest: { phase: "requested" },
    }),
    "review requested",
  );
  assert.equal(label("waiting", "Codex review is in progress"), "review in progress");
  assert.equal(label("waiting", "Waiting for required review"), "waiting for review");
  assert.equal(label("waiting", "Waiting for passing checks"), "waiting for checks");
  assert.equal(label("waiting", "Merge submitted; waiting for GitHub/merge queue"), "merge queued");
  assert.equal(label("blocked", "Waiting for checks"), "blocked");
  assert.equal(
    presentation({ state: { status: "repairing" }, control: { mode: "paused" } }, true).semantic,
    "idle",
  );
  assert.equal(presentation({ state: { status: "repairing" } }, false).stage, "controller stopped");
  assert.equal(
    presentation({ state: { status: "merged" }, control: { mode: "paused" } }, false).stage,
    "merged",
  );
  assert.equal(activityLabel(undefined, { mode: "removed" }), "unwatched");
});
