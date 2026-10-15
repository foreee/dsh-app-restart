import assert from "node:assert/strict";
import { apply, ROUTES, publicPlan } from "../lib/index.js";

// ---- fake cordis context ----
const registered = [];
const disposed = [];
const logs = [];
const ctx = {
  webServer: {
    register: (route) => {
      registered.push(route);
      return () => {
        disposed.push(route.path);
      };
    }
  },
  effect: (fn, label) => {
    const dispose = fn();
    effects.push(label);
    effectDisposers.push(dispose);
    return dispose;
  },
  logger: {
    info: (message) => logs.push("info " + message),
    warn: (message) => logs.push("warn " + message)
  }
};
const effects = [];
const effectDisposers = [];

// enabled:false -> nothing mounted
apply({ ...ctx, effect: () => {} }, { enabled: false });
assert.equal(registered.length, 0, "enabled:false mounts nothing");

// mount with dryRun
apply(ctx, { dryRun: true });
assert.equal(registered.length, 2, "two routes registered");
assert.deepEqual(registered.map((r) => r.path).sort(), [ROUTES.restart, ROUTES.status].sort());
assert.deepEqual(effects, ["dsh-app-restart: routes"]);

const status = registered.find((r) => r.path === ROUTES.status);
const restart = registered.find((r) => r.path === ROUTES.restart);

/** Fake req/res pair; returns { status, body }. */
async function call(route, req) {
  let captured = {};
  const res = {
    writeHead: (s, h) => {
      captured.status = s;
      captured.headers = h;
    },
    end: (body) => {
      captured.body = body;
    }
  };
  await route.handler(req, res);
  return { status: captured.status, body: captured.body ? JSON.parse(captured.body) : undefined };
}

const loopbackReq = (over = {}) => ({
  method: "GET",
  socket: { remoteAddress: "127.0.0.1" },
  headers: { host: "127.0.0.1:19387" },
  ...over
});

// The plan resolves from the CURRENT process; point it at the real installed
// app for this test (restored afterwards).
const realExecPath = process.execPath;
process.execPath = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";

// status: happy path on this machine (real packaged app)
const status1 = await call(status, loopbackReq());
assert.equal(status1.status, 200);
assert.equal(status1.body.available, true, "real desktop app detected");
assert.equal(status1.body.appName, "DeepSeek Harness");
assert.equal(status1.body.bundleId, "com.deepseek.dsh");
assert.ok(status1.body.appPath.endsWith(".app"));

process.execPath = realExecPath;

// status: wrong method
assert.equal((await call(status, loopbackReq({ method: "POST" }))).status, 405);
// status: non-loopback
assert.equal((await call(status, loopbackReq({ socket: { remoteAddress: "10.0.0.8" } }))).status, 403);
// status: cross-site fetch blocked
assert.equal((await call(status, loopbackReq({ headers: { host: "127.0.0.1:19387", "sec-fetch-site": "cross-site" } }))).status, 403);

// restart: dryRun answers ok with the plan, spawns nothing
process.execPath = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
const restart1 = await call(restart, loopbackReq({ method: "POST" }));
assert.equal(restart1.status, 200);
assert.equal(restart1.body.ok, true);
assert.equal(restart1.body.dryRun, true);
assert.equal(restart1.body.plan.available, true);
assert.ok(logs.some((l) => l.startsWith("info dsh-app-restart: dry run")));

// restart: wrong method
assert.equal((await call(restart, loopbackReq())).status, 405);
// restart: non-loopback
assert.equal((await call(restart, loopbackReq({ socket: { remoteAddress: "192.168.9.9" }, method: "POST" }))).status, 403);

// A Host running under plain node (execPath not inside an .app) reports
// honest unavailability — fresh plugin instance because the plan is cached.
process.execPath = "/opt/homebrew/bin/node";
const plainRegistered = [];
const plainCtx = {
  webServer: { register: (route) => {
    plainRegistered.push(route);
    return () => {};
  } },
  effect: (fn) => fn(),
  logger: {}
};
apply(plainCtx, {});
const plainStatus = plainRegistered.find((r) => r.path === ROUTES.status);
const statusNode = await call(plainStatus, loopbackReq());
assert.equal(statusNode.status, 200);
assert.equal(statusNode.body.available, false, "plain node is not the packaged app");
assert.equal(statusNode.body.reason, "not-packaged-app");
process.execPath = realExecPath;

// unmount disposes both routes
assert.equal(effectDisposers.length, 1, "one effect owns the routes");
effectDisposers[0]();
assert.deepEqual(disposed.sort(), [ROUTES.restart, ROUTES.status].sort(), "unmount removes both routes");
console.log("host-routes.test.mjs: all assertions passed");
