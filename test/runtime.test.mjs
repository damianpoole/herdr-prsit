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

test("Codex cycle survives restart and is checked again before merge", async (t) => {
  const { dir, w } = await setup(t);
  w.requireCodexReview = true;
  w.interval = 150;
  const eyes = { id: "1", content: "eyes", createdAt: "2026-10-29T19:00:01Z", source: "pr" };
  const thumb = { id: "2", content: "+1", createdAt: "2026-10-29T19:00:02Z", source: "pr" };
  let reactions = [],
    merged = false;
  const gh = {
    requestCodexReview: async () => {},
    snapshot: async () => ({
      ...clean,
      codexReactions: reactions,
      state: merged ? "MERGED" : "OPEN",
    }),
    merge: async () => {
      merged = true;
    },
  };
  let r = await openRuntime(w, createModels(), { github: () => gh });
  try {
    await until(async () => (await status(dir)).codexReview?.head === "abc");
    reactions = [eyes];
    await until(async () => (await status(dir)).codexReview?.cycle?.eyes === "1");
    await r.close();
    reactions = [thumb];
    r = await openRuntime(w, createModels(), { github: () => gh });
    await until(async () => (await status(dir)).status === "merged");
    assert.equal(merged, true);
  } finally {
    await r.close();
  }
});
test("Codex approval removed in the final snapshot prevents merging", async (t) => {
  const { w } = await setup(t);
  w.requireCodexReview = true;
  w.interval = 100;
  let reads = 0,
    merges = 0;
  const eyes = { id: "1", content: "eyes", createdAt: "2026-10-29T19:00:01Z", source: "pr" };
  const thumb = { id: "2", content: "+1", createdAt: "2026-10-29T19:00:02Z", source: "pr" };
  const gh = {
    requestCodexReview: async () => {},
    snapshot: async () => ({
      ...clean,
      codexReactions: ++reads === 3 ? [eyes] : reads === 4 ? [thumb] : [],
    }),
    merge: async () => {
      merges++;
    },
  };
  const r = await openRuntime(w, createModels(), { github: () => gh });
  try {
    await until(() => reads >= 5);
    assert.equal(merges, 0);
  } finally {
    await r.close();
  }
});

test("post-push Codex request survives interruption without duplicates or losing its baseline", async (t) => {
  const { GitHub } = await import("../dist/github.js");
  const { dir, w } = await setup(t);
  w.requireCodexReview = true;
  w.interval = 100;
  const item = { key: "comment:fix", fingerprint: "first", kind: "comment", body: "Fix this" };
  const comments = [];
  let remote = "abc",
    agentCalls = 0,
    posts = 0,
    responded = false,
    merged = false,
    reactions = [];
  let release;
  const posted = new Promise((resolve) => {
    release = resolve;
  });
  const gh = new GitHub(w);
  gh.snapshot = async () => ({
    ...clean,
    head: remote,
    state: merged ? "MERGED" : "OPEN",
    feedback: responded ? [] : [item],
    codexReactions: reactions,
  });
  gh.ciLogs = async () => "";
  gh.respond = async () => {
    responded = true;
  };
  gh.pages = async () => comments;
  gh.api = async (_path, body) => {
    if (!body) return { state: "open", head: { sha: remote } };
    const saved = await status(dir);
    assert.equal(saved.codexReview.head, "def");
    assert.equal(saved.job.codexReviewBaselineSaved, true);
    assert.equal(responded, true);
    posts++;
    comments.push({ id: 1, ...body });
    reactions = [
      { id: "eyes", content: "eyes", createdAt: "2026-10-29T19:00:01Z", source: "request" },
    ];
    await posted;
  };
  gh.merge = async () => {
    merged = true;
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
          summary: "Fixed",
          responses: [{ key: item.key, body: "Fixed", resolve: false }],
        }),
      );
    },
    push: async () => {
      remote = "def";
    },
  };
  let r = await openRuntime(w, createModels(), deps);
  try {
    await until(() => posts === 1);
    const closing = r.close();
    release();
    await closing;
    r = await openRuntime(w, createModels(), deps);
    await until(async () => (await status(dir)).codexReview?.cycle?.eyes === "eyes");
    assert.equal(posts, 1);
    assert.equal(agentCalls, 1);
    assert.equal(merged, false);
    reactions = [
      { id: "thumb", content: "+1", createdAt: "2026-10-29T19:00:02Z", source: "request" },
    ];
    await until(async () => (await status(dir)).status === "merged");
    assert.equal(posts, 1);
  } finally {
    release();
    await r.close();
  }
});

for (const [enabled, published] of [
  [false, "def"],
  [true, "abc"],
]) {
  test(`no extra post-push Codex request when enabled=${enabled} and published=${published}`, async (t) => {
    const { dir, w } = await setup(t);
    w.requireCodexReview = enabled;
    const item = { key: "comment:fix", fingerprint: "first", kind: "comment", body: "Fix this" };
    let responded = false,
      remote = "abc",
      requests = 0;
    const gh = {
      snapshot: async () => ({
        ...clean,
        head: remote,
        checks: [{ state: "PENDING" }],
        feedback: responded ? [] : [item],
        codexReactions: [],
      }),
      ciLogs: async () => "",
      respond: async () => {
        responded = true;
      },
      requestCodexReview: async () => {
        requests++;
      },
    };
    const r = await openRuntime(w, createModels(), {
      github: () => gh,
      prepare: async () => dir,
      validateChanges: async () => published,
      native: async (_h, _w, j) => {
        await writeFile(
          join(dir, w.id, "jobs", j.id, "report.json"),
          JSON.stringify({
            outcome: "addressed",
            summary: "Done",
            responses: [{ key: item.key, body: "Handled", resolve: false }],
          }),
        );
      },
      push: async () => {
        remote = published;
      },
    });
    try {
      await until(async () => (await status(dir)).status === "waiting");
      assert.equal(responded, true);
      assert.equal(requests, enabled ? 1 : 0);
    } finally {
      await r.close();
    }
  });
}

test("startup with an existing thumbs-up requests a fresh review and remembers it across restart", async (t) => {
  const { dir, w } = await setup(t);
  w.requireCodexReview = true;
  w.interval = 100;
  const old = { id: "old", content: "+1", createdAt: "2026-10-29T19:00:00Z", source: "pr" };
  let reactions = [old],
    requests = 0,
    merged = false;
  const gh = {
    snapshot: async () => ({
      ...clean,
      codexReactions: reactions,
      state: merged ? "MERGED" : "OPEN",
    }),
    requestCodexReview: async (head) => {
      const saved = await status(dir);
      assert.equal(head, "abc");
      assert.equal(saved.codexReviewRequest.phase, "pending");
      assert.deepEqual(saved.codexReview.seen, ["old"]);
      requests++;
    },
    merge: async () => {
      merged = true;
    },
  };
  let r = await openRuntime(w, createModels(), { github: () => gh });
  try {
    await until(async () => (await status(dir)).status === "waiting");
    assert.equal(requests, 1);
    assert.equal(merged, false);
    await r.close();
    r = await openRuntime(w, createModels(), { github: () => gh });
    reactions = [
      old,
      { id: "eyes", content: "eyes", createdAt: "2026-10-29T19:00:01Z", source: "request" },
    ];
    await until(async () => (await status(dir)).codexReview?.cycle?.eyes === "eyes");
    reactions = [
      old,
      { id: "new", content: "+1", createdAt: "2026-10-29T19:00:02Z", source: "request" },
    ];
    await until(async () => (await status(dir)).status === "merged");
    assert.equal(requests, 1);
  } finally {
    await r.close();
  }
});

test("a new external head gets its own request, while draft PRs do not", async (t) => {
  const { dir, w } = await setup(t);
  w.requireCodexReview = true;
  w.interval = 100;
  let head = "abc",
    draft = true;
  const requests = [];
  const gh = {
    snapshot: async () => ({ ...clean, head, draft, codexReactions: [] }),
    requestCodexReview: async (value) => {
      requests.push(value);
    },
  };
  const r = await openRuntime(w, createModels(), { github: () => gh });
  try {
    await until(async () => (await status(dir)).message === "Draft PR");
    assert.deepEqual(requests, []);
    draft = false;
    await until(() => requests.length === 1);
    head = "def";
    await until(() => requests.length === 2);
    await until(async () => (await status(dir)).status === "waiting");
    assert.deepEqual(requests, ["abc", "def"]);
  } finally {
    await r.close();
  }
});
