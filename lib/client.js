window.__ModuleLoader__.load({
	id: "dsh-app-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/dictionaries.js
		/** Locale namespace owned by this plugin. */
		const NS = "dsh-app-restart";
		const zh = {
			"nav": "应用重启",
			"title": "重启应用",
			"description": "退出并重新启动 DeepSeek Harness 桌面应用。有进行中的任务时，应用会先弹出确认。",
			"restart": "重启应用",
			"confirmRestart": "再次点击确认重启",
			"cancel": "取消",
			"restarting": "正在退出并重启应用，窗口即将关闭…",
			"failed": "重启失败",
			"loadError": "无法获取应用状态",
			"retry": "重试",
			"reason.not-packaged-app": "未检测到打包的桌面应用（开发模式？）。",
			"reason.development-electron": "当前为开发模式 Electron，未接 packaged 应用。",
			"reason.no-parent-process": "未找到桌面应用主进程。",
			"reason.unsupported-platform": "当前平台暂不支持。",
			"reason.unknown": "当前环境不支持。"
		};
		const en = {
			"nav": "Restart App",
			"title": "Restart application",
			"description": "Quits and relaunches the DeepSeek Harness desktop app. Active tasks are confirmed first by the app itself.",
			"restart": "Restart application",
			"confirmRestart": "Click again to confirm restart",
			"cancel": "Cancel",
			"restarting": "Quitting and restarting the app; the window will close…",
			"failed": "Restart failed",
			"loadError": "Could not load the application status",
			"retry": "Retry",
			"reason.not-packaged-app": "No packaged desktop app detected (development mode?).",
			"reason.development-electron": "Running a development Electron, not the packaged app.",
			"reason.no-parent-process": "Desktop app main process not found.",
			"reason.unsupported-platform": "This platform is not supported yet.",
			"reason.unknown": "Not available in this environment."
		};
		//#endregion
		//#region src/client/styles.js
		/** Inject the section stylesheet once (same pattern as official plugin CSS). */
		const CSS = ".dar-section{padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}"
			+ ".dar-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}"
			+ ".dar-description{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}"
			+ ".dar-buttons{margin-top:12px;display:flex;align-items:center;gap:10px}"
			+ ".dar-button{box-sizing:border-box;height:36px;padding:0 16px;border:none;border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}"
			+ ".dar-button:hover{filter:brightness(1.06)}"
			+ ".dar-button:disabled{opacity:.5;cursor:default;filter:none}"
			+ ".dar-button-armed{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}"
			+ ".dar-button-ghost{box-sizing:border-box;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary)}"
			+ ".dar-button-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".dar-note{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}"
			+ ".dar-error{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}"
			/* Nav label carrying our own glyph: flex row matching the shell nav rhythm. */
			+ ".dar-navlabel{display:inline-flex;align-items:center;gap:6px}"
			+ ".dar-navlabel svg{width:16px;height:16px;flex:none;display:block}"
			/* The settings shell renders a fallback gear as a direct svg child of the
			 * nav button for ids it does not know. Hide exactly that gear in OUR button
			 * (matched through the unique label class) and let our own glyph show. */
			+ "button:has(span.dar-navlabel)>svg{display:none}";
		const CSS_TAG_ID = "dsh-app-restart/section.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-app-restart";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/api.js
		/** Document-relative API paths (the GUI is served with a <base href>). */
		const API = {
			status: "api/dsh-app-restart/status",
			restart: "api/dsh-app-restart/restart"
		};
		/** Fetch the restart availability facts. */
		async function fetchStatus() {
			const response = await fetch(API.status);
			const body = await response.json().catch(() => undefined);
			if (!response.ok) throw new Error(typeof (body && body.error) === "string" ? body.error : "HTTP " + response.status);
			return body;
		}
		/** Request the restart. */
		async function requestRestart() {
			const response = await fetch(API.restart, { method: "POST" });
			const body = await response.json().catch(() => undefined);
			if (!response.ok) throw new Error(typeof (body && body.error) === "string" ? body.error : "HTTP " + response.status);
			return body;
		}
		//#endregion
		//#region src/client/section.js
		const { createElement: h, useCallback, useEffect, useRef, useState } = react;
		/** Auto-disarm delay for the confirmation state, in ms. */
		const CONFIRM_RESET_MS = 6000;
		/** Stroke props shared with the app's outline icon set (16px, 1.5 stroke). */
		const NAV_ICON_PROPS = {
			viewBox: "0 0 16 16",
			width: 16,
			height: 16,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.5,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": true
		};
		/**
		 * The restart glyph: a circular arrow (rotate-cw), outline styled to sit
		 * beside the shell's Fluent icons in the settings navigation.
		 */
		function RestartGlyph(props) {
			return h("svg", { ...NAV_ICON_PROPS, ...props },
				h("polyline", { points: "15.33 2.67 15.33 6.67 11.33 6.67" }),
				h("path", { d: "M13.66 10a6 6 0 1 1-1.41-6.24L15.33 6.67" })
			);
		}
		/**
		 * Nav label as a React element: our restart glyph plus the localized text.
		 * The settings shell resolves label thunks verbatim and renders the value
		 * inside the nav row, so an element replaces the fallback gear visually
		 * (the gear itself is hidden through the dar-navlabel CSS rule above).
		 * @param {Function} tt translate function bound to this namespace
		 * @returns the label element
		 */
		function NavLabel(tt) {
			return h("span", { className: "dar-navlabel" }, h(RestartGlyph), tt("nav"));
		}
		/**
		 * Map a host unavailability reason to copy.
		 * @param {Function} t translate function
		 * @param {string} reason host reason code
		 */
		function reasonText(t, reason) {
			const key = "reason." + (reason ?? "unknown");
			const text = t(key);
			return text === key ? t("reason.unknown") : text;
		}
		/**
		 * The Settings section: restart facts plus the guarded restart button.
		 * @param {object} props composed slot props (t comes from the entry inject)
		 * @returns the section element tree
		 */
		function RestartSection(props) {
			const { t = (key) => key } = props;
			const [status, setStatus] = useState(null);
			const [loadFailed, setLoadFailed] = useState(false);
			const [phase, setPhase] = useState("idle");
			const [errorText, setErrorText] = useState("");
			const armedAtRef = useRef(0);
			const load = useCallback(() => {
				let cancelled = false;
				setLoadFailed(false);
				fetchStatus().then((value) => {
					if (!cancelled) setStatus(value);
				}).catch(() => {
					if (!cancelled) {
						setStatus(null);
						setLoadFailed(true);
					}
				});
				return () => {
					cancelled = true;
				};
			}, []);
			useEffect(load, [load]);
			useEffect(() => {
				if (phase !== "confirm") return;
				armedAtRef.current = Date.now();
				const timer = setTimeout(() => {
					setPhase((current) => (current === "confirm" && Date.now() - armedAtRef.current >= CONFIRM_RESET_MS - 50 ? "idle" : current));
				}, CONFIRM_RESET_MS);
				return () => clearTimeout(timer);
			}, [phase]);
			const onRestartClick = useCallback(() => {
				setErrorText("");
				setPhase("confirm");
			}, []);
			const onCancelClick = useCallback(() => {
				setPhase("idle");
			}, []);
			const onConfirmClick = useCallback(() => {
				setPhase("restarting");
				requestRestart().then(() => {
					setErrorText("");
				}).catch((error) => {
					setErrorText(error instanceof Error ? error.message : String(error));
					setPhase("error");
				});
			}, []);
			const available = status !== null && status.available === true;
			const busy = phase === "restarting";
			return h("div", { className: "dar-section" },
				h("div", { className: "dar-title" }, t("title")),
				h("div", { className: "dar-description" }, t("description")),
				loadFailed ? h("div", { className: "dar-error" }, t("loadError")) : null,
				status !== null && !available
					? h("div", { className: "dar-note" }, reasonText(t, status.reason))
					: null,
				available ? h("div", { className: "dar-buttons" },
					h("button", {
						type: "button",
						className: phase === "confirm" ? "dar-button dar-button-armed" : "dar-button",
						disabled: busy,
						onClick: phase === "confirm" ? onConfirmClick : onRestartClick
					}, phase === "confirm" ? t("confirmRestart") : phase === "restarting" ? t("restarting") : t("restart")),
					phase === "confirm" ? h("button", {
						type: "button",
						className: "dar-button-ghost",
						disabled: busy,
						onClick: onCancelClick
					}, t("cancel")) : null
				) : null,
				phase === "error" && errorText !== "" ? h("div", { className: "dar-error" }, t("failed") + ": " + errorText) : null
			);
		}
		//#endregion
		//#region src/client/index.js
		/** Required services (cordis fiber inject waiting). */
		const inject = ["slots", "locale"];
		/**
		 * Mount the settings section.
		 * @param {object} ctx client root context (slots + locale services)
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-app-restart: dictionaries");
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "app-restart",
				order: 100,
				label: () => NavLabel(t),
				locale: NS,
				inject: () => ({ t })
			}, RestartSection)), "dsh-app-restart: settings section");
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
