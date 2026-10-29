import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openRuntime } from "../dist/runtime.js";
const clean = {
  head: "abc",
  state: "OPEN",
  draft: false,
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  reviewDecision: "APPROVED",
  headBranch: "fix",
  headRepo: "owner/repo",
  baseBranch: "main",
  checks: [{ name: "test", state: "SUCCESS", url: "" }],
  feedback: [],
  unresolved: [],
  title: "Fixture PR",
};
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "prsit-test-"));
  process.env.PRSIT_HOME = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const w = {
    id: "fixture",
    url: "https://github.com/owner/repo/pull/1",
    host: "github.com",
    owner: "owner",
    repo: "repo",
    number: 1,
    path: dir,
    remote: "origin",
    agent: "pi",
    model: "faux/fixture",
    interval: 600000,
    merge: "squash",
    allowNoChecks: false,
    test: null,
    maxAttempts: 3,
    timeout: 30000,
    created: Date.now(),
  };
  return { dir, w };
}
async function until(fn) {
  for (let i = 0; i < 250; i++) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error("Timed out");
}
async function status(dir) {
  try {
    return JSON.parse(await readFile(join(dir, "fixture", "status.json"), "utf8"));
  } catch {
    return {};
  }
}
test("unchanged PR uses durable sleep; restarting preserves deadline without model calls", async (t) => {
  const { dir, w } = await setup(t);
  let reads = 0;
  const gh = {
    snapshot: async () => {
      reads++;
      return { ...clean, checks: [{ name: "test", state: "PENDING" }] };
    },
  };
  let r = await openRuntime(w, createModels(), { github: () => gh });
  await until(async () => (await status(dir)).status === "waiting");
  const deadline = (await status(dir)).nextPoll;
  await r.close();
  assert.equal(reads, 1);
  r = await openRuntime(w, createModels(), { github: () => gh });
  await delay(100);
  assert.equal(reads, 1);
  assert.equal((await status(dir)).nextPoll, deadline);
  await r.close();
});
test("merge is head checked and confirmed on GitHub", async (t) => {
  const { dir, w } = await setup(t);
  let merged = false;
  let received;
  const gh = {
    snapshot: async () => ({ ...clean, state: merged ? "MERGED" : "OPEN" }),
    merge: async (s) => {
      received = s.head;
      merged = true;
    },
  };
  const r = await openRuntime(w, createModels(), { github: () => gh });
  try {
    await until(async () => (await status(dir)).status === "merged");
    assert.equal(received, "abc");
  } finally {
    await r.close();
  }
});
test("new feedback immediately before merge prevents merge", async (t) => {
  const { dir, w } = await setup(t);
  let reads = 0,
    merges = 0;
  const gh = {
    snapshot: async () => ({
      ...clean,
      feedback:
        ++reads === 1 ? [] : [{ key: "new", fingerprint: "x", kind: "comment", body: "wait" }],
    }),
    merge: async () => {
      merges++;
    },
  };
  const r = await openRuntime(w, createModels(), { github: () => gh });
  try {
    await until(async () => (await status(dir)).status === "waiting");
    assert.equal(merges, 0);
  } finally {
    await r.close();
  }
});
test("native Pi Durable actually executes a coding tool, publishes, resolves, and merges", async (t) => {
  const { dir, w } = await setup(t);
  const m = createModels();
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "fixture" }],
    tokensPerSecond: 100000,
  });
  m.setProvider(faux.provider);
  const item = {
    key: "thread:one",
    fingerprint: "original",
    kind: "thread",
    body: "Please fix",
    threadId: "one",
    commentId: 1,
    canResolve: true,
  };
  let merged = false,
    resolved = false,
    pushes = 0,
    responses = 0;
  faux.setResponses([
    (context) => {
      const text = JSON.stringify(context.messages);
      const match = text.match(/write a JSON report to ([^ ]+) with/);
      assert.ok(match);
      return fauxAssistantMessage(
        fauxToolCall("write", {
          path: match[1],
          content: JSON.stringify({
            outcome: "addressed",
            summary: "Fixture validated",
            responses: [{ key: item.key, body: "Fixed and verified", resolve: true }],
          }),
        }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Done."),
  ]);
  const gh = {
    snapshot: async () => ({
      ...clean,
      state: merged ? "MERGED" : "OPEN",
      feedback: resolved ? [] : [item],
      unresolved: resolved ? [] : ["one"],
    }),
    ciLogs: async () => "",
    respond: async () => {
      responses++;
      resolved = true;
    },
    merge: async () => {
      merged = true;
    },
  };
  const r = await openRuntime(w, m, {
    github: () => gh,
    prepare: async () => dir,
    validateChanges: async () => clean.head,
    push: async () => {
      pushes++;
    },
  });
  try {
    await until(async () => (await status(dir)).status === "merged");
    assert.equal(pushes, 1);
    assert.equal(responses, 1);
    assert.equal(faux.state.callCount, 2);
  } finally {
    await r.close();
  }
});
test("publication interrupted after push resumes without rerunning the agent", async (t) => {
  const { dir, w } = await setup(t);
  const item = { key: "comment:1", fingerprint: "a", kind: "comment", body: "fix" };
  let remoteHead = "abc",
    agentCalls = 0,
    pushEffects = 0,
    resolved = false,
    release;
  let gate = new Promise((r) => {
    release = r;
  });
  const gh = {
    snapshot: async () => ({ ...clean, head: remoteHead, feedback: resolved ? [] : [item] }),
    ciLogs: async () => "",
    respond: async () => {
      resolved = true;
    },
    merge: async () => {},
  };
  const deps = {
    github: () => gh,
    prepare: async () => dir,
    validateChanges: async () => "def",
    native: async (_h, _w, j) => {
      agentCalls++;
      await writeFile(
        join(dir, w.id, "jobs", j.id, "report.json"),
        JSON.stringify({
          outcome: "addressed",
          summary: "Done",
          responses: [{ key: item.key, body: "Fixed", resolve: false }],
        }),
      );
    },
    push: async () => {
      if (remoteHead !== "def") {
        pushEffects++;
        remoteHead = "def";
      }
      await gate;
    },
  };
  let r = await openRuntime(w, createModels(), deps);
  await until(() => remoteHead === "def");
  // Let the in-flight external effect return while close cancels the phase commit.
  const closing = r.close();
  release();
  await closing;
  gate = Promise.resolve();
  r = await openRuntime(w, createModels(), deps);
  try {
    await until(() => resolved);
    assert.equal(agentCalls, 1);
    assert.equal(pushEffects, 1);
  } finally {
    await r.close();
  }
});
test("native model work resumes after shutdown without repeating a committed tool", async (t) => {
  const { dir, w } = await setup(t);
  const item = {
    key: "comment:recover",
    fingerprint: "once",
    kind: "comment",
    body: "Repair once",
  };
  const m = createModels(),
    faux = fauxProvider({ provider: "faux", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
  m.setProvider(faux.provider);
  let reportPath,
    secondStarted = false,
    resolved = false;
  faux.setResponses([
    (context) => {
      reportPath = JSON.stringify(context.messages).match(/write a JSON report to ([^ ]+) with/)[1];
      return fauxAssistantMessage(
        fauxToolCall("write", {
          path: reportPath,
          content: JSON.stringify({
            outcome: "addressed",
            summary: "Committed tool",
            responses: [{ key: item.key, body: "Handled", resolve: false }],
          }),
        }),
        { stopReason: "toolUse" },
      );
    },
    (_context, options) =>
      new Promise((resolve) => {
        secondStarted = true;
        const finish = () =>
          resolve(fauxAssistantMessage("Interrupted", { stopReason: "aborted" }));
        if (options.signal?.aborted) finish();
        else options.signal?.addEventListener("abort", finish, { once: true });
      }),
  ]);
  const gh = {
    snapshot: async () => ({
      ...clean,
      checks: [{ state: "PENDING", name: "ci" }],
      feedback: [item],
    }),
    ciLogs: async () => "",
    respond: async () => {
      resolved = true;
    },
  };
  const deps = {
    github: () => gh,
    prepare: async () => dir,
    validateChanges: async () => clean.head,
    push: async () => {},
  };
  let runtime = await openRuntime(w, m, deps);
  await until(() => secondStarted);
  const report = await readFile(reportPath, "utf8");
  await runtime.close();
  const restored = createModels(),
    next = fauxProvider({ provider: "faux", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
  restored.setProvider(next.provider);
  next.setResponses([fauxAssistantMessage("Finished after restart")]);
  runtime = await openRuntime(w, restored, deps);
  try {
    await until(() => resolved);
    assert.equal(next.state.callCount, 1);
    assert.equal(await readFile(reportPath, "utf8"), report);
  } finally {
    await runtime.close();
  }
});

test("stale post-push reads settle without blocking or rerunning the agent", async (t) => {
  const { dir, w } = await setup(t);
  const item = { key: "comment:stale", fingerprint: "a", kind: "comment", body: "fix" };
  let agentCalls = 0,
    pushes = 0,
    reads = 0,
    responses = 0,
    merged = false;
  const gh = {
    snapshot: async () => ({
      ...clean,
      head: pushes && ++reads > 2 ? "def" : "abc",
      state: merged ? "MERGED" : "OPEN",
      feedback: responses ? [] : [item],
    }),
    ciLogs: async () => "",
    respond: async () => {
      responses++;
    },
    merge: async () => {
      merged = true;
    },
  };
  const r = await openRuntime(w, createModels(), {
    github: () => gh,
    prepare: async () => dir,
    validateChanges: async () => "def",
    native: async (_h, _w, j) => {
      agentCalls++;
      await writeFile(
        join(dir, w.id, "jobs", j.id, "report.json"),
        JSON.stringify({
          outcome: "addressed",
          summary: "Done",
          responses: [{ key: item.key, body: "Fixed", resolve: false }],
        }),
      );
    },
    push: async () => {
      pushes++;
    },
  });
  try {
    await until(async () => (await status(dir)).status === "merged");
    assert.equal(agentCalls, 1);
    assert.equal(pushes, 1);
    assert.equal(responses, 1);
  } finally {
    await r.close();
  }
});

test("retry of blocked publication survives restart and never reruns the agent", async (t) => {
  const { dir, w } = await setup(t);
  const item = { key: "comment:blocked", fingerprint: "a", kind: "comment", body: "fix" };
  let agentCalls = 0,
    remote = "abc",
    responses = 0,
    merged = false;
  const gh = {
    snapshot: async () => ({
      ...clean,
      head: remote,
      state: merged ? "MERGED" : "OPEN",
      feedback: responses ? [] : [item],
    }),
    ciLogs: async () => "",
    respond: async () => {
      responses++;
    },
    merge: async () => {
      merged = true;
    },
  };
  const deps = {
    github: () => gh,
    prepare: async () => dir,
    validateChanges: async () => "def",
    native: async (_h, _w, j) => {
      agentCalls++;
      await writeFile(
        join(dir, w.id, "jobs", j.id, "report.json"),
        JSON.stringify({
          outcome: "addressed",
          summary: "Done",
          responses: [{ key: item.key, body: "Fixed", resolve: false }],
        }),
      );
    },
    push: async () => {
      if (remote !== "def") {
        remote = "unexpected";
      }
    },
  };
  let r = await openRuntime(w, createModels(), deps);
  await until(async () => (await status(dir)).status === "blocked");
  const blocked = await status(dir);
  assert.equal(responses, 0);
  assert.equal(merged, false);
  await r.close();
  remote = "def";
  await writeFile(
    join(dir, w.id, "control.json"),
    JSON.stringify({ mode: "running", retryAt: blocked.blockedAt + 1 }),
  );
  r = await openRuntime(w, createModels(), deps);
  try {
    for (let i = 0; i < 500 && (await status(dir)).status !== "merged"; i++) await delay(20);
    assert.equal((await status(dir)).status, "merged");
    assert.equal(agentCalls, 1);
    assert.equal(responses, 1);
  } finally {
    await r.close();
  }
});
