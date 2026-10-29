import test from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../dist/github.js";
const w = { host: "github.com", owner: "o", repo: "r", number: 1 };
test("thread and nested comment pagination are complete", async () => {
  const gh = new GitHub(w);
  let pages = 0,
    nested = 0;
  gh.graphql = async (query, vars) => {
    if (vars.id) {
      nested++;
      return {
        node: {
          comments: { nodes: [{ id: "c2", body: "second" }], pageInfo: { hasNextPage: false } },
        },
      };
    }
    pages++;
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: vars.cursor ? "two" : "one",
                isResolved: false,
                comments: {
                  nodes: [{ id: "c1", body: "first" }],
                  pageInfo: { hasNextPage: !vars.cursor, endCursor: "nested" },
                },
              },
            ],
            pageInfo: { hasNextPage: !vars.cursor, endCursor: "outer" },
          },
        },
      },
    };
  };
  const threads = await gh.threads();
  assert.equal(threads.length, 2);
  assert.equal(threads[0].comments.nodes.length, 2);
  assert.equal(pages, 2);
  assert.equal(nested, 1);
});
test("replayed thread response does not post twice, but retries resolution", async () => {
  const gh = new GitHub(w);
  const comments = [];
  let resolved = false,
    posts = 0,
    resolutions = 0;
  gh.threads = async () => [
    { id: "thread", isResolved: resolved, viewerCanResolve: true, comments: { nodes: comments } },
  ];
  gh.api = async (_p, body) => {
    posts++;
    comments.push(body);
  };
  gh.graphql = async () => {
    resolutions++;
    if (resolutions === 1) throw new Error("network lost");
    resolved = true;
    return {};
  };
  const item = { kind: "thread", threadId: "thread", commentId: 12 };
  await assert.rejects(() => gh.respond(item, "Fixed", true, "operation"), /network lost/);
  await gh.respond(item, "Fixed", true, "operation");
  assert.equal(posts, 1);
  assert.equal(resolutions, 2);
});
test("lack of resolution permission never silently marks feedback resolved", async () => {
  const gh = new GitHub(w);
  gh.threads = async () => [
    {
      id: "t",
      isResolved: false,
      viewerCanResolve: false,
      comments: { nodes: [{ body: "<!-- herdr-prsit:op -->" }] },
    },
  ];
  await assert.rejects(
    () => gh.respond({ kind: "thread", threadId: "t" }, "Fixed", true, "op"),
    /does not permit/,
  );
});

test("Codex reactions use paginated PR and exact request-comment sources and only the bot", async () => {
  const gh = new GitHub(w),
    paths = [];
  gh.pages = async (path) => {
    paths.push(path);
    return [
      {
        id: 1,
        content: "+1",
        created_at: "2026-10-29T19:00:00Z",
        user: { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "Bot" },
      },
      { id: 2, content: "+1", user: { login: "someone", type: "User" } },
      { id: 3, content: "+1", user: { login: "chatgpt-codex-connector[bot]", type: "User" } },
    ];
  };
  const reactions = await gh.codexReactions([
    { id: 5, body: "@codex review" },
    { id: 6, body: "Please fix this" },
  ]);
  assert.deepEqual(paths, [
    "repos/o/r/issues/1/reactions",
    "repos/o/r/issues/comments/5/reactions",
  ]);
  assert.equal(reactions.length, 2);
  assert.equal(reactions[0].id, "1");
  assert.notEqual(reactions[0].source, reactions[1].source);
  gh.pages = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(() => gh.codexReactions([]), /unavailable/);
});

test("Codex re-review requests reconcile a lost response and track marked comment reactions", async () => {
  const gh = new GitHub({ ...w, id: "watch" }),
    comments = [];
  let posts = 0,
    head = "abc",
    state = "open";
  gh.pages = async () => comments;
  gh.api = async (path, body) => {
    if (!body) return { state, head: { sha: head } };
    assert.equal(path, "repos/o/r/issues/1/comments");
    posts++;
    comments.push({ id: 41 + posts, ...body });
    if (posts === 1) throw new Error("response lost after posting");
  };
  await assert.rejects(() => gh.requestCodexReview("abc"), /response lost/);
  await gh.requestCodexReview("abc");
  assert.equal(posts, 1);
  assert.match(comments[0].body, /^@codex review\n\n<!-- herdr-prsit:codex-review:[a-f0-9]+ -->$/);
  head = "def";
  await gh.requestCodexReview("def");
  assert.equal(posts, 2);
  await assert.rejects(() => gh.requestCodexReview("abc"), /head changed/);
  state = "closed";
  await assert.rejects(() => gh.requestCodexReview("def"), /closed/);
  assert.equal(posts, 2);
  const paths = [];
  gh.pages = async (path) => {
    paths.push(path);
    return [];
  };
  await gh.codexReactions([...comments, { id: 99, body: "@codex review\n\nPlease also fix this" }]);
  assert.deepEqual(paths, [
    "repos/o/r/issues/1/reactions",
    "repos/o/r/issues/comments/42/reactions",
    "repos/o/r/issues/comments/43/reactions",
  ]);
});

test("real Codex reaction identity is accepted even when GitHub labels it User", async () => {
  const gh = new GitHub(w);
  gh.pages = async () => [
    {
      id: 609749654,
      content: "+1",
      created_at: "2026-10-29T19:47:21Z",
      user: { login: "chatgpt-codex-connector[bot]", id: 199175422, type: "User" },
    },
  ];
  assert.equal((await gh.codexReactions([])).length, 1);
});
