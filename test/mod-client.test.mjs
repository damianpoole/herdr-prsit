import test from "node:test";
import assert from "node:assert/strict";
import { invocation, call, watchArgs } from "../mods/prsit/client.js";

test("mod invokes backend with argv, preserving spaces/quotes without shell evaluation", async () => {
  const config = {
    command: "/node path/node",
    args: ["/backend's path/cli.js"],
    stateHome: "/state ' with spaces",
  };
  const args = watchArgs({
    pr: "123",
    repo: "/repo ' ; echo bad",
    model: "provider/model",
    test: "npm test",
    interval: "30s",
  });
  const request = invocation(config, args);
  assert.equal(request.command, "env");
  assert.deepEqual(request.args.slice(0, 3), [
    "PRSIT_HOME=/state ' with spaces",
    config.command,
    config.args[0],
  ]);
  assert.deepEqual(request.args.slice(3), [
    "watch",
    "123",
    "--repo",
    "/repo ' ; echo bad",
    "--model",
    "provider/model",
    "--test",
    "npm test",
    "--interval",
    "30s",
  ]);
  await call(
    async (command, actual) => {
      assert.equal(command, request.command);
      assert.deepEqual(actual, request.args);
      return { code: 0, stdout: "registered\n", stderr: "" };
    },
    config,
    args,
  );
});

test("mod rejects missing registration fields, bad config, failed commands, and mismatched API", async () => {
  assert.throws(() => watchArgs({ pr: "", repo: "/repo" }), /Supply/);
  assert.throws(() => watchArgs({ pr: "--help", repo: "/repo" }), /positive PR/);
  assert.throws(() => invocation({ args: [42] }, []), /configuration/);
  await assert.rejects(
    call(async () => ({ code: 1, stderr: "permission denied", stdout: "" }), {}, ["watch", "1"]),
    /permission denied/,
  );
  await assert.rejects(
    call(async () => ({ code: 0, stdout: '{"version":2}', stderr: "" }), {}, ["snapshot"], true),
    /Unsupported/,
  );
  await assert.rejects(
    call(async () => ({ code: 0, stdout: "not json", stderr: "" }), {}, ["snapshot"], true),
    SyntaxError,
  );
});
