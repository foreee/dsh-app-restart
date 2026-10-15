import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "./react-env/node_modules/react/index.js";
import TestRenderer, { act } from "./react-env/node_modules/react-test-renderer/index.js";

const nodeRequire = createRequire(import.meta.url);
const react = await import("./react-env/node_modules/react/index.js");

// ---- minimal ModuleLoader harness ----
let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    }
  }
};
const bundleSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function("window", bundleSource)(globalThis.window);
assert.equal(loaded.id, "dsh-app-restart", "bundle registers under its package id");

const exports = loaded.factory((spec) => {
  if (spec === "react") return react;
  throw new Error("unexpected require: " + spec);
});
assert.deepEqual(exports.inject, ["slots", "locale"]);
assert.equal(exports.NS, "dsh-app-restart");

// ---- fake client context ----
const dictionaries = new Map();
let activeLang = "zh";
const t = (key) => {
  for (const lang of activeLang === "zh" ? ["zh", "en"] : ["en", "zh"]) {
    const dict = dictionaries.get(lang);
    if (dict && dict[key] !== undefined) return dict[key];
  }
  return key;
};
const registrations = [];
const injectCalls = [];
const effects = [];
const ctx = {
  locale: {
    bind: () => t,
    register: (ns, dicts) => {
      for (const [lang, dict] of Object.entries(dicts)) dictionaries.set(lang, { ...(dictionaries.get(lang) ?? {}), ...dict });
      return () => {};
    }
  },
  slots: {
    inject: (slotName, registerFactory) => {
      injectCalls.push({ slotName, registerFactory });
      return () => {};
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    }
  },
  effect: (fn, label) => {
    effects.push(label);
    const dispose = fn();
    return dispose;
  }
};

exports.apply(ctx);
assert.ok(effects.includes("dsh-app-restart: dictionaries"), "dictionaries registered via effect");
assert.ok(effects.includes("dsh-app-restart: settings section"), "section injected via effect");
assert.equal(injectCalls.length, 1);
assert.equal(injectCalls[0].slotName, "settings.section");
const entry = injectCalls[0].registerFactory();
const registration = registrations.at(-1);
assert.equal(registration.options.name, "settings.section");
assert.equal(registration.options.id, "app-restart");
assert.equal(registration.options.order, 100);
const labelElement = registration.options.label();
assert.ok(React.isValidElement(labelElement), "label is a react element (glyph + text)");
assert.equal(labelElement.props.className, "dar-navlabel", "label carries the nav marker class");
let labelTree;
await act(async () => {
  labelTree = TestRenderer.create(labelElement);
});
const glyph = labelTree.root.findByType("svg");
assert.equal(glyph.props.viewBox, "0 0 16 16", "glyph is a 16x16 svg");
assert.equal(glyph.findAllByType("polyline").length, 1, "glyph has the arrowhead polyline");
assert.equal(glyph.findAllByType("path").length, 1, "glyph has the circular-arc path");
const labelText = labelTree.root.findByType("span").props.children.filter((c) => typeof c === "string").join("");
assert.equal(labelText, activeLang === "zh" ? "应用重启" : "Restart App", "label text localized");

// ---- component interaction flow ----
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (path, init) => {
  requests.push({ path: String(path), method: init?.method ?? "GET" });
  if (String(path).endsWith("/status")) {
    return { ok: true, json: async () => ({ available: true, platform: "darwin", appName: "DeepSeek Harness", reason: null }) };
  }
  if (String(path).endsWith("/restart")) {
    return { ok: true, json: async () => ({ ok: true, detail: "apple-event delivered" }) };
  }
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
};

let renderer;
await act(async () => {
  renderer = TestRenderer.create(React.createElement(registration.component, { t }));
});
const button = () => renderer.root.findAll((node) => node.type === "button")[0];
// idle after status fetch
assert.ok(!button().props.disabled, "idle button enabled");
assert.equal(button().props.children, "重启应用");

// click -> armed
await act(async () => {
  button().props.onClick();
});
assert.equal(button().props.className, "dar-button dar-button-armed", "armed styling");
assert.equal(button().props.children, "再次点击确认重启");

// confirm -> restarting, POST issued
await act(async () => {
  button().props.onClick();
});
assert.deepEqual(requests, [
  { path: "api/dsh-app-restart/status", method: "GET" },
  { path: "api/dsh-app-restart/restart", method: "POST" }
], "status GET then restart POST");
const restarting = renderer.root.findAll((node) => node.type === "div" && Array.isArray(node.props.children) && node.props.children.some((c) => c && c.props && c.props.disabled === true));
assert.ok(restarting.length > 0, "disabled button while restarting");

globalThis.fetch = originalFetch;

// ---- unavailable status shows note, no button ----
globalThis.fetch = async () => ({ ok: true, json: async () => ({ available: false, reason: "not-packaged-app" }) });
await act(async () => {
  renderer = TestRenderer.create(React.createElement(registration.component, { t }));
});
const buttons = renderer.root.findAllByType("button");
assert.equal(buttons.length, 0, "no restart button when unavailable");
const notes = renderer.root.findAll((node) => node.type === "div" && node.props.className === "dar-note");
assert.equal(notes.length, 1);
assert.equal(notes[0].props.children, "未检测到打包的桌面应用（开发模式？）。");
globalThis.fetch = originalFetch;

// ---- host restart route failure surfaces the error ----
globalThis.fetch = async (path, init) => {
  if (String(path).endsWith("/status")) return { ok: true, json: async () => ({ available: true, reason: null }) };
  return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
};
await act(async () => {
  renderer = TestRenderer.create(React.createElement(registration.component, { t }));
});
const primary = () => renderer.root.findAll((node) => node.type === "button")[0];
await act(async () => {
  primary().props.onClick();
});
await act(async () => {
  primary().props.onClick();
});
const errors = renderer.root.findAll((node) => node.type === "div" && node.props.className === "dar-error");
assert.ok(errors.some((node) => String(node.props.children).includes("重启失败: boom")), "failure message rendered");
globalThis.fetch = originalFetch;

console.log("client.test.mjs: all assertions passed");
