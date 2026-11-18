import { Link } from "../_libs/@tanstack/react-router+[3...].mjs";
import { require_jsx_dev_runtime } from "../_libs/react.mjs";
import { Film } from "../_libs/lucide-react.mjs";
import { Lock } from "../_libs/lucide-react4.mjs";
// node_modules/.nitro/vite/services/ssr/assets/routes-DThznvTs.js
var import_jsx_dev_runtime = require_jsx_dev_runtime();
var _jsxFileName = "/app/applet/src/routes/index.tsx?tsr-split=component";
function HomePage() {
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("main", {
		className: "min-h-screen bg-[#090B10] flex items-center justify-center px-6 py-12",
		children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
			className: "max-w-lg w-full bg-[#11151E] border border-white/10 rounded-xl p-8 sm:p-10",
			children: [
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
					className: "flex items-center gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
						className: "w-10 h-10 rounded-lg bg-rose-600/15 border border-rose-500/30 flex items-center justify-center text-rose-400",
						children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Film, { className: "w-5 h-5" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 8,
							columnNumber: 13
						}, this)
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 7,
						columnNumber: 11
					}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h1", {
						className: "text-2xl font-semibold tracking-tight text-white",
						children: "Player"
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 10,
						columnNumber: 11
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 6,
					columnNumber: 9
				}, this),
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
					className: "mt-4 text-sm sm:text-base text-slate-300 leading-relaxed",
					children: [
						"Reprodutor dedicado para episódios por link individual. Abra uma URL no formato",
						" ",
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("code", {
							className: "text-xs font-mono text-slate-200 bg-white/5 px-1.5 py-0.5 rounded border border-white/10",
							children: "/e/identificador"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 15,
							columnNumber: 11
						}, this),
						" ",
						"para reproduzir diretamente um episódio cadastrado."
					]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 13,
					columnNumber: 9
				}, this),
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
					className: "mt-8 pt-6 border-t border-white/10 flex items-center justify-between gap-4",
					children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
						className: "text-xs text-slate-400",
						children: "Acesso público somente por link direto"
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 22,
						columnNumber: 11
					}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Link, {
						to: "/admin",
						className: "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors whitespace-nowrap shrink-0",
						children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Lock, { className: "w-4 h-4" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 26,
							columnNumber: 13
						}, this), "Administração"]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 25,
						columnNumber: 11
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 21,
					columnNumber: 9
				}, this)
			]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 5,
			columnNumber: 7
		}, this)
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 4,
		columnNumber: 10
	}, this);
}
export { HomePage as component };
