import test from "node:test";
import assert from "node:assert/strict";
import { startController } from "../dist/app.js";
import { home } from "../dist/io.js";

test("start reconnects without creating a terminal when controller already exists", async () => {
  assert.deepEqual(
    await startController({
      ping: async () => true,
      exec: async () => {
        assert.fail("must not launch");
      },
      delay: async () => {},
    }),
    { running: true, started: false },
  );
});

test("start launches one independent hc controller with explicit executable and state", async () => {
  const calls = [];
  let probes = 0;
  const result = await startController({
    ping: async () => ++probes > 2,
    exec: async (...args) => {
      calls.push(args);
    },
    delay: async () => {},
  });
  assert.deepEqual(result, { running: true, started: true });
  assert.equal(calls.length, 1);
  const [command, args] = calls[0];
  assert.equal(command, "hc");
  assert.ok(args.includes("--no-parent"));
  assert.ok(args.includes("--bg"));
  assert.ok(args.includes(`PRSIT_HOME=${home()}`));
  assert.ok(args.includes(process.execPath));
  assert.deepEqual(args.slice(-2), ["run", "--headless"]);
  assert.ok(!args.includes("--keep"));
  assert.ok(!args.includes("--label"));
});

test("a concurrent launch can reconnect but never blindly retries launch", async () => {
  let probes = 0,
    launches = 0;
  const result = await startController({
    ping: async () => ++probes > 2,
    exec: async () => {
      launches++;
      throw new Error("name already used");
    },
    delay: async () => {},
  });
  assert.equal(launches, 1);
  assert.deepEqual(result, { running: true, started: false });
});

test("start reports launch and readiness failures instead of claiming success", async () => {
  await assert.rejects(
    startController({
      ping: async () => false,
      exec: async () => {
        throw new Error("hc missing");
      },
      delay: async () => {},
    }),
    /hc missing/,
  );
  await assert.rejects(
    startController({
      ping: async () => false,
      exec: async () => {},
      delay: async () => {},
    }),
    /did not become ready/,
  );
});
