/**
 * dsh-app-restart - host half.
 *
 * Adds a loopback-only HTTP route family that restarts the whole DeepSeek
 * Harness desktop application (the Electron shell, the Web GUI it hosts, and
 * this cordis Host process):
 *
 *   GET  /api/dsh-app-restart/status    -> availability facts for the button
 *   POST /api/dsh-app-restart/restart   -> graceful quit + automatic relaunch
 *
 * Why an OS-level helper instead of an in-process call: this plugin runs
 * inside the Host child process (Electron in Node mode). app.relaunch() lives
 * in the Electron shell, which offers plugins no restart IPC, so the restart
 * is orchestrated at the operating-system level:
 *
 *   1. spawn a DETACHED relauncher that waits for the app main process to
 *      exit and then reopens the app bundle;
 *   2. trigger a graceful quit through the platform's normal quit path
 *      (macOS: the Quit Apple Event, which the shell treats exactly like
 *      Cmd+Q, including its active-task confirmation dialog);
 *   3. answer the button; the relauncher brings the app back.
 *
 * If the quit never completes (for example the user cancels the task
 * confirmation dialog), the relauncher times out and its final "open" merely
 * focuses the still-running app - a harmless no-op.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isIPv4 } from "node:net";
import { basename, dirname, join } from "node:path";

/** Stable cordis plugin name. */
export const name = "dsh-app-restart";

/** Host services this plugin waits for. */
export const inject = ["webServer"];

/** Route paths; the browser bundle mirrors these literals. */
export const ROUTES = Object.freeze({
  status: "/api/dsh-app-restart/status",
  restart: "/api/dsh-app-restart/restart"
});

/** How long the relauncher waits for the app to exit before giving up (loops x 250ms = 100s). */
const RELAUNCH_MAX_WAIT_LOOPS = 400;
/** Grace period between "main process exited" and reopening the bundle, in ms. */
const RELAUNCH_SETTLE_MS = 600;
/** Bound on awaiting one quit command exit before moving on, in ms. */
const QUIT_COMMAND_TIMEOUT_MS = 3000;
/** The generic bundle id of an electron npm checkout (development). */
const DEV_ELECTRON_BUNDLE_ID = "com.github.Electron";

/** Whether the value is a usable PID. */
function isPid(value) {
  return Number.isSafeInteger(value) && value > 1;
}

/**
 * Strip the executable path down to the macOS app bundle root.
 * @param {string} execPath absolute path of the current process executable
 * @returns {string|null} the .app bundle path, or null when not a packaged app
 */
export function appBundleOf(execPath) {
  const marker = "/Contents/MacOS/";
  const index = execPath.lastIndexOf(marker);
  if (index <= 0) return null;
  const bundle = execPath.slice(0, index);
  if (!bundle.endsWith(".app")) return null;
  if (!existsSync(join(bundle, "Contents", "Resources", "app.asar"))) return null;
  return bundle;
}

/**
 * Locate the packaged resources marker beside a Windows/Linux executable.
 * @param {string} execPath absolute path of the current process executable
 * @returns {string|null} the executable path when it looks like the packaged app
 */
export function packagedExecutableOf(execPath) {
  if (!existsSync(execPath)) return null;
  // Packaged: <root>/resources/app.asar beside the executable; an Electron
  // development checkout carries default_app.asar instead.
  if (!existsSync(join(dirname(execPath), "resources", "app.asar"))) return null;
  return execPath;
}

/**
 * Read the macOS bundle identifier with plutil (bounded).
 * @param {string} bundlePath absolute .app bundle path
 * @returns {Promise<string|null>} the CFBundleIdentifier, or null when unreadable
 */
export function bundleIdOf(bundlePath) {
  const plist = join(bundlePath, "Contents", "Info.plist");
  if (!existsSync(plist)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = execFile(
        "/usr/bin/plutil",
        ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
        { timeout: 3000 },
        (error, stdout) => done(error === null && typeof stdout === "string" && /^[A-Za-z0-9.-]+$/.test(stdout.trim()) ? stdout.trim() : null)
      );
      child.on("error", () => done(null));
    } catch {
      done(null);
    }
  });
}

/**
 * Compute the full restart plan for the current process. Pure: spawns nothing
 * (only bounded reads). Exported for tests.
 * @param {object} [options] platform/execPath/parentPid/bundleId overrides
 * @returns {Promise<object>} plan with availability, display facts, command specs
 */
export async function resolveRestartPlan(options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const parentPid = options.parentPid ?? process.ppid;

  const base = {
    platform,
    execPath,
    parentPid,
    parentPidValid: isPid(parentPid),
    available: false,
    reason: null
  };
  if (!base.parentPidValid) return { ...base, reason: "no-parent-process" };

  if (platform === "darwin") {
    const appPath = appBundleOf(execPath);
    if (appPath === null) return { ...base, reason: "not-packaged-app" };
    const appName = basename(appPath).replace(/\.app$/u, "");
    const bundleId = options.bundleId !== undefined ? options.bundleId : await bundleIdOf(appPath);
    if (bundleId === DEV_ELECTRON_BUNDLE_ID) {
      return { ...base, appPath, appName, bundleId, reason: "development-electron" };
    }
    const quit = [];
    if (typeof bundleId === "string") {
      quit.push({ file: "/usr/bin/osascript", args: ["-e", 'tell application id "' + bundleId + '" to quit'], kind: "apple-event" });
    }
    quit.push({ file: "/usr/bin/osascript", args: ["-e", 'tell application "' + appName.replace(/["\\]/gu, "") + '" to quit'], kind: "apple-event" });
    return {
      ...base,
      available: true,
      reason: null,
      appPath,
      appName,
      bundleId,
      relaunch: {
        file: "/bin/bash",
        args: [
          "-c",
          'n=0; while [ "$n" -lt ' + RELAUNCH_MAX_WAIT_LOOPS + ' ] && kill -0 "$1" 2>/dev/null; do sleep 0.25; n=$((n+1)); done; sleep 0.6; open "$2"',
          "dsh-app-restart-relauncher",
          String(parentPid),
          appPath
        ],
        kind: "bash-detached"
      },
      quit
    };
  }

  if (platform === "win32") {
    const exePath = packagedExecutableOf(execPath);
    if (exePath === null) return { ...base, reason: "not-packaged-app" };
    return {
      ...base,
      available: true,
      reason: null,
      appPath: exePath,
      appName: basename(exePath, ".exe"),
      relaunch: {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "$i=0; while($i -lt " + RELAUNCH_MAX_WAIT_LOOPS + " -and (Get-Process -Id $env:DSH_RESTART_PID -ErrorAction SilentlyContinue)){ Start-Sleep -Milliseconds 250; $i++ }; Start-Sleep -Milliseconds " + (RELAUNCH_SETTLE_MS + 200) + "; Start-Process -FilePath $env:DSH_RESTART_EXE"
        ],
        env: { DSH_RESTART_PID: String(parentPid), DSH_RESTART_EXE: exePath },
        kind: "powershell-detached"
      },
      quit: [{ file: "taskkill.exe", args: ["/PID", String(parentPid)], kind: "wm-close" }]
    };
  }

  if (platform === "linux") {
    const exePath = packagedExecutableOf(execPath);
    if (exePath === null) return { ...base, reason: "not-packaged-app" };
    return {
      ...base,
      available: true,
      reason: null,
      appPath: exePath,
      appName: basename(exePath),
      relaunch: {
        file: "/bin/bash",
        args: [
          "-c",
          'n=0; while [ "$n" -lt ' + RELAUNCH_MAX_WAIT_LOOPS + ' ] && kill -0 "$1" 2>/dev/null; do sleep 0.25; n=$((n+1)); done; sleep 0.6; nohup "$2" >/dev/null 2>&1 &',
          "dsh-app-restart-relauncher",
          String(parentPid),
          exePath
        ],
        kind: "bash-detached"
      },
      quit: [{ kind: "signal", signal: "SIGTERM", pid: parentPid }]
    };
  }

  return { ...base, reason: "unsupported-platform" };
}

/** Public projection of a plan served by the status route (no command specs). */
export function publicPlan(plan) {
  return {
    available: plan.available,
    reason: plan.reason,
    platform: plan.platform,
    appName: plan.appName,
    appPath: plan.appPath,
    bundleId: plan.bundleId,
    parentPid: plan.parentPid
  };
}

//#region trust fence (mirrors the official plugin family loopback guard)

/** Whether a host string names the loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return isIPv4(hostname) && hostname.startsWith("127.");
}

/** Whether a socket address is loopback. */
function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1") return true;
  return isIPv4(address) && address.startsWith("127.");
}

/**
 * Request-level trust fence: loopback socket AND loopback Host header, plus
 * browser same-origin markers. The socket address is authoritative;
 * X-Forwarded-For is never trusted. Paired remote devices are deliberately
 * not allowed here: only the machine's own GUI may restart the app.
 * @param {import("node:http").IncomingMessage} request incoming request
 * @returns {boolean} whether the request may enter the restart routes
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket && request.socket.remoteAddress)) return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

//#endregion

//#region restart orchestration

const JSON_HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8" });

/** Serialize one JSON body. */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Await a child exit within the deadline.
 * @returns {Promise<"exit"|"timeout">} how the wait ended
 */
function awaitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.once("exit", () => done("exit"));
    child.once("error", () => done("exit"));
    setTimeout(() => done("timeout"), timeoutMs);
  });
}

/** Minimal, deterministic environment for helper processes. */
function helperEnv(platform) {
  const path = platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\"
    : "/usr/bin:/bin:/usr/sbin:/sbin";
  return { PATH: path };
}

/**
 * Spawn the detached relauncher.
 * @param {object} plan a resolved plan with a relaunch spec
 * @returns {import("node:child_process").ChildProcess} the unref'ed child
 */
export function spawnRelauncher(plan) {
  const child = spawn(plan.relaunch.file, plan.relaunch.args, {
    detached: true,
    stdio: "ignore",
    env: { ...helperEnv(plan.platform), ...plan.relaunch.env }
  });
  child.unref();
  return child;
}

/**
 * Deliver the quit request through the platform's normal quit path.
 * @param {object} plan a resolved plan with quit specs
 * @returns {Promise<{delivered: boolean, detail: string}>} outcome
 */
export async function deliverQuit(plan) {
  for (const spec of plan.quit) {
    if (spec.kind === "signal") {
      try {
        process.kill(spec.pid, spec.signal);
        return { delivered: true, detail: "signal " + spec.signal };
      } catch (error) {
        return { delivered: false, detail: "signal failed: " + (error instanceof Error ? error.message : String(error)) };
      }
    }
    let child;
    try {
      child = spawn(spec.file, spec.args, { stdio: "ignore", env: helperEnv(plan.platform) });
    } catch {
      continue; // try the next fallback
    }
    const outcome = await awaitExit(child, QUIT_COMMAND_TIMEOUT_MS);
    if (outcome === "timeout") {
      // Still running: on macOS this means the Apple Event was delivered and
      // the shell is quitting (or showing its confirmation dialog). Leave it.
      return { delivered: true, detail: "apple-event delivered" };
    }
    if (child.exitCode === 0) {
      return { delivered: true, detail: "quit command exited cleanly" };
    }
    // Nonzero exit: try the next fallback.
  }
  return { delivered: false, detail: "no quit command succeeded" };
}

//#endregion

//#region cordis plugin

/** One restart request in flight; guards against double clicks. */
let restartInFlight = false;

/**
 * Mount the status and restart routes.
 * @param {object} ctx host plugin context carrying webServer
 * @param {object} [config] plugin config: { enabled?, dryRun? }
 */
export function apply(ctx, config = {}) {
  if (config && config.enabled === false) return;
  const dryRun = Boolean(config && config.dryRun);
  const log = (level, message) => {
    try {
      if (ctx.logger && typeof ctx.logger[level] === "function") ctx.logger[level]("dsh-app-restart: " + message);
    } catch {}
  };

  let planPromise = null;
  const plan = () => {
    planPromise = planPromise ?? resolveRestartPlan();
    return planPromise;
  };

  const routes = [
    {
      kind: "exact",
      path: ROUTES.status,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed: " + req.method });
        try {
          writeJson(res, 200, publicPlan(await plan()));
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    {
      kind: "exact",
      path: ROUTES.restart,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed: " + req.method });
        if (restartInFlight) return writeJson(res, 409, { error: "a restart is already being performed" });
        restartInFlight = true;
        try {
          const current = await plan();
          if (!current.available) {
            writeJson(res, 503, { error: "restart unavailable: " + current.reason, reason: current.reason });
            return;
          }
          if (dryRun) {
            log("info", "dry run: " + JSON.stringify(publicPlan(current)));
            writeJson(res, 200, { ok: true, dryRun: true, plan: publicPlan(current) });
            return;
          }
          log("info", "restarting app: pid " + current.parentPid + " -> " + current.appPath);
          const relauncher = spawnRelauncher(current);
          const delivery = await deliverQuit(current);
          if (!delivery.delivered) {
            relauncher.kill();
            log("warn", "restart failed: " + delivery.detail);
            writeJson(res, 500, { error: "could not ask the application to quit: " + delivery.detail });
            return;
          }
          writeJson(res, 200, { ok: true, detail: delivery.detail });
        } catch (error) {
          log("warn", "restart error: " + (error instanceof Error ? error.stack : String(error)));
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        } finally {
          restartInFlight = false;
        }
      }
    }
  ];

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    log("info", "routes mounted" + (dryRun ? " (dry-run)" : ""));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-app-restart: routes");
}

//#endregion
