import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appBundleOf, packagedExecutableOf, resolveRestartPlan, isLoopbackRequest, publicPlan, ROUTES } from "../lib/index.js";

// ---------- appBundleOf ----------
const tmp = mkdtempSync(join(tmpdir(), "dsh-restart-test-"));
// packaged macOS app
const app = join(tmp, "DeepSeek Harness.app");
mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
writeFileSync(join(app, "Contents", "Resources", "app.asar"), "x");
const exe = join(app, "Contents", "MacOS", "DeepSeek Harness");
writeFileSync(exe, "x");
assert.equal(appBundleOf(exe), app, "resolves packaged .app bundle");
assert.equal(appBundleOf("/tmp/definitely-not-here.app/Contents/MacOS/helper"), null, "missing app.asar rejected");
assert.equal(appBundleOf("/usr/local/bin/node"), null, "plain binary rejected");

// dev electron checkout (Electron.app without app.asar)
assert.equal(appBundleOf("/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), null, "dev electron rejected (no app.asar)");

// ---------- packagedExecutableOf (win/linux shape, created on this fs) ----------
const winRoot = join(tmp, "app-root");
mkdirSync(join(winRoot, "resources"), { recursive: true });
writeFileSync(join(winRoot, "resources", "app.asar"), "x");
const fakeExe = join(winRoot, "DeepSeek Harness.exe");
writeFileSync(fakeExe, "x");
assert.equal(packagedExecutableOf(fakeExe), fakeExe, "resolves packaged exe");
assert.equal(packagedExecutableOf(join(tmp, "missing.exe")), null, "missing exe rejected");

// ---------- resolveRestartPlan: darwin packaged ----------
const plan = await resolveRestartPlan({
  platform: "darwin",
  execPath: exe,
  parentPid: 4242,
  bundleId: "com.deepseek.dsh"
});
assert.equal(plan.available, true, "darwin packaged available");
assert.equal(plan.appPath, app);
assert.equal(plan.appName, "DeepSeek Harness");
assert.equal(plan.bundleId, "com.deepseek.dsh");
assert.equal(plan.relaunch.file, "/bin/bash");
assert.equal(plan.relaunch.args[0], "-c");
assert.equal(plan.relaunch.args[3], "4242", "parent pid passed to relaunch script");
assert.equal(plan.relaunch.args[4], app, "app path passed to relaunch script");
assert.ok(plan.relaunch.args[1].includes("open"), "relaunch uses open");
assert.equal(plan.quit[0].file, "/usr/bin/osascript");
assert.equal(plan.quit[0].args[1], 'tell application id "com.deepseek.dsh" to quit');
assert.ok(plan.quit[1].args[1].includes('tell application "DeepSeek Harness" to quit'));

// ---------- resolveRestartPlan: dev electron ----------
const devPlan = await resolveRestartPlan({
  platform: "darwin",
  execPath: "/x/Electron.app/Contents/MacOS/Electron",
  parentPid: 10,
  bundleId: "com.github.Electron",
});
assert.equal(devPlan.available, false);
assert.equal(devPlan.reason, "not-packaged-app");

// forced dev-bundle id on a packaged path
const forcedDev = await resolveRestartPlan({ platform: "darwin", execPath: exe, parentPid: 10, bundleId: "com.github.Electron" });
assert.equal(forcedDev.available, false);
assert.equal(forcedDev.reason, "development-electron");

// ---------- resolveRestartPlan: no parent ----------
const noParent = await resolveRestartPlan({ platform: "darwin", execPath: exe, parentPid: 1 });
assert.equal(noParent.available, false);
assert.equal(noParent.reason, "no-parent-process");

// ---------- resolveRestartPlan: win32 ----------
const winPlan = await resolveRestartPlan({ platform: "win32", execPath: fakeExe, parentPid: 55 });
assert.equal(winPlan.available, true);
assert.equal(winPlan.relaunch.file, "powershell.exe");
assert.equal(winPlan.relaunch.env.DSH_RESTART_PID, "55");
assert.equal(winPlan.relaunch.env.DSH_RESTART_EXE, fakeExe);
assert.ok(winPlan.relaunch.args.join(" ").includes("Start-Process -FilePath $env:DSH_RESTART_EXE"));
assert.deepEqual(winPlan.quit, [{ file: "taskkill.exe", args: ["/PID", "55"], kind: "wm-close" }]);

// ---------- resolveRestartPlan: linux ----------
const linPlan = await resolveRestartPlan({ platform: "linux", execPath: fakeExe, parentPid: 66 });
assert.equal(linPlan.available, true);
assert.deepEqual(linPlan.quit, [{ kind: "signal", signal: "SIGTERM", pid: 66 }]);
assert.ok(linPlan.relaunch.args[1].includes("nohup"));

// unsupported platform
const unsup = await resolveRestartPlan({ platform: "freebsd", execPath: exe, parentPid: 7 });
assert.equal(unsup.available, false);
assert.equal(unsup.reason, "unsupported-platform");

// ---------- publicPlan projection ----------
const pub = publicPlan(plan);
assert.deepEqual(Object.keys(pub).sort(), ["appName", "appPath", "available", "bundleId", "parentPid", "platform", "reason"]);
assert.equal(pub.relanch ?? pub.relaunch, undefined, "command specs not exposed");

// ---------- isLoopbackRequest ----------
const baseReq = {
  socket: { remoteAddress: "127.0.0.1" },
  headers: { host: "127.0.0.1:19387" }
};
assert.equal(isLoopbackRequest(baseReq), true, "plain loopback allowed");
assert.equal(isLoopbackRequest({ ...baseReq, headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" } }), true, "same-origin allowed");
assert.equal(isLoopbackRequest({ ...baseReq, headers: { host: "127.0.0.1:19387", origin: "http://evil.example" } }), false, "cross origin blocked");
assert.equal(isLoopbackRequest({ ...baseReq, headers: { host: "127.0.0.1:19387", "sec-fetch-site": "cross-site" } }), false, "cross-site blocked");
assert.equal(isLoopbackRequest({ ...baseReq, socket: { remoteAddress: "192.168.1.9" } }), false, "lan blocked");
assert.equal(isLoopbackRequest({ ...baseReq, socket: { remoteAddress: "::ffff:127.0.0.1" } }), true, "ipv4-mapped loopback allowed");
assert.equal(isLoopbackRequest({ ...baseReq, headers: { host: "my-host.example" } }), false, "non-loopback host header blocked");

// ---------- routes constants ----------
assert.equal(ROUTES.status, "/api/dsh-app-restart/status");
assert.equal(ROUTES.restart, "/api/dsh-app-restart/restart");

rmSync(tmp, { recursive: true, force: true });
console.log("plan.test.mjs: all assertions passed");
