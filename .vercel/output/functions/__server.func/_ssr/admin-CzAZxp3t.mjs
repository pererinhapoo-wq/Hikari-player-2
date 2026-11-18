import { __toESM } from "../_runtime.mjs";
import { Route$3, adminCreateEpisodeFn, adminDeleteEpisodeFn, adminLoginFn, adminLogoutFn, adminUpdateEpisodeFn } from "./router-CQpxJLCG.mjs";
import { normalizeVideoSource, validateHttpUrl } from "./video-sources-BYrFRAqI.mjs";
import { require_react, useRouter } from "../_libs/@tanstack/react-router+[...].mjs";
import { require_jsx_dev_runtime } from "../_libs/react.mjs";
import { TriangleAlert } from "../_libs/lucide-react5.mjs";
import { Check, Copy, ExternalLink, Eye, EyeOff, LogOut, Pencil, Plus, Trash2 } from "../_libs/lucide-react2.mjs";
import { Film } from "../_libs/lucide-react.mjs";
// node_modules/.nitro/vite/services/ssr/assets/admin-CzAZxp3t.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_dev_runtime = require_jsx_dev_runtime();
var _jsxFileName = "/app/applet/src/routes/admin.tsx?tsr-split=component";
var EMPTY_FORM = {
	title: "",
	poster_url: "",
	video_url: "",
	video_url_2: "",
	video_url_3: "",
	video_url_4: "",
	video_url_5: ""
};
var PLAYER_SLOTS = [
	{
		field: "video_url",
		slot: 1,
		label: "Player 1",
		required: true
	},
	{
		field: "video_url_2",
		slot: 2,
		label: "Player 2",
		required: false
	},
	{
		field: "video_url_3",
		slot: 3,
		label: "Player 3",
		required: false
	},
	{
		field: "video_url_4",
		slot: 4,
		label: "Player 4",
		required: false
	},
	{
		field: "video_url_5",
		slot: 5,
		label: "Player 5",
		required: false
	}
];
function formatDatePtBr(iso) {
	try {
		return new Intl.DateTimeFormat("pt-BR", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric"
		}).format(new Date(iso));
	} catch {
		return iso;
	}
}
function countEpisodeSources(ep) {
	return [
		ep.video_url,
		ep.video_url_2,
		ep.video_url_3,
		ep.video_url_4,
		ep.video_url_5
	].filter((u) => Boolean(u && u.trim())).length;
}
function AdminPage() {
	const router = useRouter();
	const initialState = Route$3.useLoaderData();
	const [password, setPassword] = (0, import_react.useState)("");
	const [showPassword, setShowPassword] = (0, import_react.useState)(false);
	const [loginError, setLoginError] = (0, import_react.useState)(null);
	const [loginBusy, setLoginBusy] = (0, import_react.useState)(false);
	const [editingId, setEditingId] = (0, import_react.useState)(null);
	const [form, setForm] = (0, import_react.useState)(EMPTY_FORM);
	const [formError, setFormError] = (0, import_react.useState)(null);
	const [saveBusy, setSaveBusy] = (0, import_react.useState)(false);
	const [savedBanner, setSavedBanner] = (0, import_react.useState)(null);
	const [copiedId, setCopiedId] = (0, import_react.useState)(null);
	const [confirmDeleteId, setConfirmDeleteId] = (0, import_react.useState)(null);
	const [deleteBusyId, setDeleteBusyId] = (0, import_react.useState)(null);
	const [posterPreviewError, setPosterPreviewError] = (0, import_react.useState)(false);
	const posterValidation = (0, import_react.useMemo)(() => {
		if (!form.poster_url.trim()) return null;
		return validateHttpUrl(form.poster_url);
	}, [form.poster_url]);
	const copyLink = async (id, url) => {
		try {
			await navigator.clipboard.writeText(url);
			setCopiedId(id);
			window.setTimeout(() => {
				setCopiedId((current) => current === id ? null : current);
			}, 2e3);
		} catch {}
	};
	const handleLogin = async (e) => {
		e.preventDefault();
		setLoginError(null);
		setLoginBusy(true);
		try {
			const res = await adminLoginFn({ data: { password } });
			if (!res.ok) {
				setLoginError(res.error ?? "Falha ao autenticar.");
				return;
			}
			setPassword("");
			await router.invalidate();
		} catch (err) {
			setLoginError(err instanceof Error ? err.message : "Erro ao validar senha.");
		} finally {
			setLoginBusy(false);
		}
	};
	const handleLogout = async () => {
		await adminLogoutFn();
		setEditingId(null);
		setForm(EMPTY_FORM);
		setSavedBanner(null);
		await router.invalidate();
	};
	const handleEditStart = (ep) => {
		setEditingId(ep.id);
		setForm({
			title: ep.title,
			poster_url: ep.poster_url,
			video_url: ep.video_url,
			video_url_2: ep.video_url_2 ?? "",
			video_url_3: ep.video_url_3 ?? "",
			video_url_4: ep.video_url_4 ?? "",
			video_url_5: ep.video_url_5 ?? ""
		});
		setFormError(null);
		setPosterPreviewError(false);
		window.scrollTo({
			top: 0,
			behavior: "smooth"
		});
	};
	const handleCancelEdit = () => {
		setEditingId(null);
		setForm(EMPTY_FORM);
		setFormError(null);
		setPosterPreviewError(false);
	};
	const handleSaveEpisode = async (e) => {
		e.preventDefault();
		setFormError(null);
		setSaveBusy(true);
		try {
			if (editingId) {
				const res = await adminUpdateEpisodeFn({ data: {
					id: editingId,
					...form
				} });
				if (!res.ok) {
					setFormError(res.error);
					return;
				}
				setSavedBanner({
					title: res.episode.title,
					publicUrl: res.episode.public_url,
					action: "updated"
				});
				setEditingId(null);
				setForm(EMPTY_FORM);
			} else {
				const res = await adminCreateEpisodeFn({ data: form });
				if (!res.ok) {
					setFormError(res.error);
					return;
				}
				setSavedBanner({
					title: res.episode.title,
					publicUrl: res.episode.public_url,
					action: "created"
				});
				setForm(EMPTY_FORM);
			}
			setPosterPreviewError(false);
			await router.invalidate();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Erro ao salvar episódio.");
		} finally {
			setSaveBusy(false);
		}
	};
	const handleConfirmDelete = async (id) => {
		setDeleteBusyId(id);
		try {
			const res = await adminDeleteEpisodeFn({ data: { id } });
			if (!res.ok) setFormError(res.error);
			else {
				if (editingId === id) handleCancelEdit();
				setConfirmDeleteId(null);
				await router.invalidate();
			}
		} finally {
			setDeleteBusyId(null);
		}
	};
	const missingEnvItems = [];
	if (!initialState.databaseConfigured) missingEnvItems.push("DATABASE_URL");
	if (!initialState.passwordConfigured) missingEnvItems.push("PLAYER_ADMIN_PASSWORD");
	if (!initialState.secretConfigured) missingEnvItems.push("PLAYER_SESSION_SECRET");
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
		className: "min-h-screen bg-[#090B10] text-slate-100",
		children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("header", {
			className: "border-b border-white/10 bg-[#0D1018]",
			children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
				className: "max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8",
				children: [
					/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
						className: "text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0",
						children: "Player"
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 224,
						columnNumber: 11
					}, this),
					/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("nav", {
						className: "hidden sm:flex items-center gap-6 text-sm text-slate-400",
						children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
							className: "text-slate-200 whitespace-nowrap shrink-0",
							children: "Administração"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 229,
							columnNumber: 13
						}, this)
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 228,
						columnNumber: 11
					}, this),
					/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
						className: "flex items-center gap-3 shrink-0",
						children: initialState.authenticated ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
							type: "button",
							onClick: handleLogout,
							className: "inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-white/10 text-slate-200 hover:bg-white/5 transition-colors whitespace-nowrap shrink-0 cursor-pointer",
							children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(LogOut, { className: "w-3.5 h-3.5" }, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 234,
								columnNumber: 17
							}, this), "Sair"]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 233,
							columnNumber: 43
						}, this) : /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
							className: "text-xs text-slate-400 whitespace-nowrap shrink-0",
							children: "Área restrita"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 236,
							columnNumber: 27
						}, this)
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 232,
						columnNumber: 11
					}, this)
				]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 223,
				columnNumber: 9
			}, this)
		}, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 222,
			columnNumber: 7
		}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("main", {
			className: "max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6",
			children: [missingEnvItems.length > 0 && /* @__PURE__ */ (void 0)("section", {
				className: "bg-[#11151E] border border-amber-500/30 rounded-xl p-5",
				children: /* @__PURE__ */ (void 0)("div", {
					className: "flex items-start gap-3",
					children: [/* @__PURE__ */ (void 0)(TriangleAlert, { className: "w-5 h-5 text-amber-400 shrink-0 mt-0.5" }, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 247,
						columnNumber: 15
					}, this), /* @__PURE__ */ (void 0)("div", {
						className: "space-y-1.5 text-sm",
						children: [/* @__PURE__ */ (void 0)("h2", {
							className: "font-semibold text-white",
							children: "Configuração de ambiente pendente"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 249,
							columnNumber: 17
						}, this), /* @__PURE__ */ (void 0)("p", {
							className: "text-slate-300",
							children: [
								"Defina as variáveis de ambiente no servidor e execute",
								" ",
								/* @__PURE__ */ (void 0)("code", {
									className: "font-mono text-xs bg-white/5 px-1.5 py-0.5 rounded",
									children: "migrations/0001_player_episodes.sql"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 254,
									columnNumber: 19
								}, this),
								" ",
								"no seu banco Neon antes de usar em produção:",
								" ",
								/* @__PURE__ */ (void 0)("span", {
									className: "font-mono text-xs text-amber-300",
									children: missingEnvItems.join(" · ")
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 258,
									columnNumber: 19
								}, this)
							]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 252,
							columnNumber: 17
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 248,
						columnNumber: 15
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 246,
					columnNumber: 13
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 245,
				columnNumber: 40
			}, this), !initialState.authenticated ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("section", {
				className: "max-w-md mx-auto pt-8",
				children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("form", {
					onSubmit: handleLogin,
					className: "bg-[#11151E] border border-white/10 rounded-xl p-7 space-y-5",
					children: [
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h1", {
							className: "text-xl font-semibold text-white",
							children: "Acesso administrativo"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 270,
							columnNumber: 17
						}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
							className: "mt-1 text-sm text-slate-400",
							children: [
								"Informe a senha definida em",
								" ",
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("code", {
									className: "font-mono text-xs text-slate-300",
									children: "PLAYER_ADMIN_PASSWORD"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 275,
									columnNumber: 19
								}, this),
								" ",
								"para gerenciar episódios."
							]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 273,
							columnNumber: 17
						}, this)] }, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 269,
							columnNumber: 15
						}, this),
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("label", {
							htmlFor: "admin-password",
							className: "block text-xs font-medium text-slate-300 mb-1.5",
							children: "Senha administrativa"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 283,
							columnNumber: 17
						}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
							className: "relative",
							children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("input", {
								id: "admin-password",
								type: showPassword ? "text" : "password",
								required: true,
								autoComplete: "current-password",
								value: password,
								onChange: (e) => setPassword(e.target.value),
								placeholder: "Digite a senha do painel",
								className: "w-full h-11 px-3.5 pr-11 rounded-lg bg-[#090B10] border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 287,
								columnNumber: 19
							}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
								type: "button",
								onClick: () => setShowPassword((prev) => !prev),
								"aria-label": showPassword ? "Ocultar senha" : "Mostrar senha",
								className: "absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-400 hover:text-white cursor-pointer",
								children: showPassword ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(EyeOff, { className: "w-4 h-4" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 289,
									columnNumber: 37
								}, this) : /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Eye, { className: "w-4 h-4" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 289,
									columnNumber: 70
								}, this)
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 288,
								columnNumber: 19
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 286,
							columnNumber: 17
						}, this)] }, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 282,
							columnNumber: 15
						}, this),
						loginError && /* @__PURE__ */ (void 0)("p", {
							className: "text-sm text-rose-400",
							role: "alert",
							children: loginError
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 294,
							columnNumber: 30
						}, this),
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
							type: "submit",
							disabled: loginBusy,
							className: "w-full h-11 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-60 text-sm font-medium text-white transition-colors cursor-pointer",
							children: loginBusy ? "Entrando..." : "Entrar"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 298,
							columnNumber: 15
						}, this)
					]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 268,
					columnNumber: 13
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 267,
				columnNumber: 40
			}, this) : /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
				className: "grid grid-cols-1 lg:grid-cols-12 gap-8 items-start",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("section", {
					className: "lg:col-span-5 bg-[#11151E] border border-white/10 rounded-xl p-6 space-y-5",
					children: [
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
							className: "flex items-center justify-between gap-4",
							children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h1", {
								className: "text-lg font-semibold text-white",
								children: editingId ? "Editar episódio" : "Novo episódio"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 307,
								columnNumber: 17
							}, this), editingId && /* @__PURE__ */ (void 0)("button", {
								type: "button",
								onClick: handleCancelEdit,
								className: "text-xs text-slate-400 hover:text-white transition-colors cursor-pointer whitespace-nowrap",
								children: "Cancelar edição"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 310,
								columnNumber: 31
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 306,
							columnNumber: 15
						}, this),
						savedBanner && /* @__PURE__ */ (void 0)("div", {
							className: "p-4 rounded-lg bg-emerald-950/40 border border-emerald-500/30 space-y-2.5",
							children: [/* @__PURE__ */ (void 0)("div", {
								className: "text-xs font-medium text-emerald-300",
								children: savedBanner.action === "created" ? `Episódio "${savedBanner.title}" cadastrado.` : `Episódio "${savedBanner.title}" atualizado.`
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 316,
								columnNumber: 19
							}, this), /* @__PURE__ */ (void 0)("div", {
								className: "flex items-center gap-2",
								children: [/* @__PURE__ */ (void 0)("input", {
									type: "text",
									readOnly: true,
									value: savedBanner.publicUrl,
									"aria-label": "Link público gerado",
									className: "flex-1 min-w-0 h-9 px-2.5 rounded bg-[#090B10] border border-white/10 text-xs font-mono text-slate-200"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 320,
									columnNumber: 21
								}, this), /* @__PURE__ */ (void 0)("button", {
									type: "button",
									onClick: () => void copyLink("banner", savedBanner.publicUrl),
									className: "h-9 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer",
									children: copiedId === "banner" ? /* @__PURE__ */ (void 0)(import_jsx_dev_runtime.Fragment, { children: [/* @__PURE__ */ (void 0)(Check, { className: "w-3.5 h-3.5" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 323,
										columnNumber: 27
									}, this), "Copiado"] }, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 322,
										columnNumber: 48
									}, this) : /* @__PURE__ */ (void 0)(import_jsx_dev_runtime.Fragment, { children: [/* @__PURE__ */ (void 0)(Copy, { className: "w-3.5 h-3.5" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 326,
										columnNumber: 27
									}, this), "Copiar Link"] }, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 325,
										columnNumber: 31
									}, this)
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 321,
									columnNumber: 21
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 319,
								columnNumber: 19
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 315,
							columnNumber: 31
						}, this),
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("form", {
							onSubmit: handleSaveEpisode,
							className: "space-y-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("label", {
									htmlFor: "ep-title",
									className: "block text-xs font-medium text-slate-300 mb-1.5",
									children: "Título do episódio"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 335,
									columnNumber: 19
								}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("input", {
									id: "ep-title",
									type: "text",
									required: true,
									maxLength: 200,
									value: form.title,
									onChange: (e) => setForm({
										...form,
										title: e.target.value
									}),
									placeholder: "Ex.: Episódio 01 - O Início",
									className: "w-full h-10 px-3 rounded-lg bg-[#090B10] border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 338,
									columnNumber: 19
								}, this)] }, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 334,
									columnNumber: 17
								}, this),
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", { children: [
									/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("label", {
										htmlFor: "ep-poster",
										className: "block text-xs font-medium text-slate-300 mb-1.5",
										children: "Imagem de capa (URL)"
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 345,
										columnNumber: 19
									}, this),
									/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("input", {
										id: "ep-poster",
										type: "url",
										required: true,
										value: form.poster_url,
										onChange: (e) => {
											setPosterPreviewError(false);
											setForm({
												...form,
												poster_url: e.target.value
											});
										},
										placeholder: "https://cdn.exemplo.com/capas/ep01.jpg",
										className: "w-full h-10 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 348,
										columnNumber: 19
									}, this),
									posterValidation && !posterValidation.valid && /* @__PURE__ */ (void 0)("p", {
										className: "mt-1 text-xs text-rose-400",
										children: posterValidation.error
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 355,
										columnNumber: 67
									}, this),
									posterValidation?.valid && !posterPreviewError && /* @__PURE__ */ (void 0)("div", {
										className: "mt-2.5 aspect-video w-full rounded-lg overflow-hidden border border-white/10 bg-[#090B10]",
										children: /* @__PURE__ */ (void 0)("img", {
											src: posterValidation.normalizedUrl,
											alt: "Prévia da capa",
											referrerPolicy: "no-referrer",
											onError: () => setPosterPreviewError(true),
											className: "w-full h-full object-cover"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 357,
											columnNumber: 23
										}, this)
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 356,
										columnNumber: 70
									}, this)
								] }, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 344,
									columnNumber: 17
								}, this),
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
									className: "pt-2 border-t border-white/10 space-y-3.5",
									children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
										className: "flex items-center justify-between",
										children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
											className: "text-xs font-medium text-slate-200",
											children: "Fontes de vídeo (até 5 URLs)"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 363,
											columnNumber: 21
										}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
											className: "text-[11px] text-slate-500",
											children: "MP4 · WebM · HLS · Mux · Bunny · Maximaimg · Embed"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 366,
											columnNumber: 21
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 362,
										columnNumber: 19
									}, this), PLAYER_SLOTS.map(({ field, slot, label, required }) => {
										const value = form[field] ?? "";
										const trimmed = value.trim();
										const check = trimmed ? validateHttpUrl(trimmed) : null;
										const normalized = trimmed ? normalizeVideoSource(trimmed, slot) : null;
										return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
											className: "flex items-center justify-between gap-2 mb-1",
											children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("label", {
												htmlFor: `ep-${field}`,
												className: "text-xs font-medium text-slate-300",
												children: [
													label,
													" ",
													required ? "" : "(opcional)"
												]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 383,
												columnNumber: 27
											}, this), normalized ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
												className: "text-[11px] font-mono text-slate-400",
												children: normalized.formatLabel
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 386,
												columnNumber: 41
											}, this) : check && !check.valid ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
												className: "text-[11px] text-rose-400",
												children: "URL inválida"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 388,
												columnNumber: 63
											}, this) : null]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 382,
											columnNumber: 25
										}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("input", {
											id: `ep-${field}`,
											type: "url",
											required,
											value,
											onChange: (e) => setForm({
												...form,
												[field]: e.target.value
											}),
											placeholder: slot === 1 ? "https://..." : `URL alternativa (${label})`,
											className: "w-full h-10 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 392,
											columnNumber: 25
										}, this)] }, field, true, {
											fileName: _jsxFileName,
											lineNumber: 381,
											columnNumber: 24
										}, this);
									})]
								}, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 361,
									columnNumber: 17
								}, this),
								formError && /* @__PURE__ */ (void 0)("p", {
									className: "text-sm text-rose-400",
									role: "alert",
									children: formError
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 400,
									columnNumber: 31
								}, this),
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
									className: "pt-2 flex items-center gap-3",
									children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
										type: "submit",
										disabled: saveBusy || !initialState.databaseConfigured,
										className: "flex-1 h-11 px-4 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-sm font-medium text-white inline-flex items-center justify-center gap-2 transition-colors cursor-pointer",
										children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Plus, { className: "w-4 h-4" }, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 406,
											columnNumber: 21
										}, this), saveBusy ? "Salvando..." : editingId ? "Salvar alterações" : "Cadastrar episódio"]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 405,
										columnNumber: 19
									}, this)
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 404,
									columnNumber: 17
								}, this)
							]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 333,
							columnNumber: 15
						}, this)
					]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 305,
					columnNumber: 13
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("section", {
					className: "lg:col-span-7 bg-[#11151E] border border-white/10 rounded-xl overflow-hidden",
					children: [
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
							className: "px-6 py-4 border-b border-white/10 flex items-center justify-between gap-4",
							children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h2", {
								className: "text-base font-semibold text-white",
								children: "Episódios cadastrados"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 417,
								columnNumber: 19
							}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
								className: "text-xs text-slate-400 mt-0.5 tabular-nums",
								children: [
									initialState.episodes.length,
									" ",
									initialState.episodes.length === 1 ? "episódio" : "episódios",
									" · Base pública",
									" ",
									/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
										className: "font-mono text-slate-300",
										children: initialState.publicBaseUrl
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 424,
										columnNumber: 21
									}, this)
								]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 420,
								columnNumber: 19
							}, this)] }, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 416,
								columnNumber: 17
							}, this)
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 415,
							columnNumber: 15
						}, this),
						initialState.errorMessage && /* @__PURE__ */ (void 0)("div", {
							className: "px-6 py-4 border-b border-white/10 bg-rose-950/30 text-sm text-rose-300",
							children: initialState.errorMessage
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 431,
							columnNumber: 45
						}, this),
						initialState.episodes.length === 0 ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
							className: "px-6 py-14 text-center",
							children: [
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Film, { className: "w-9 h-9 text-slate-600 mx-auto mb-3" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 436,
									columnNumber: 19
								}, this),
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
									className: "text-sm font-medium text-slate-200",
									children: "Nenhum episódio cadastrado ainda"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 437,
									columnNumber: 19
								}, this),
								/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
									className: "mt-1 text-xs text-slate-400",
									children: "Preencha o formulário ao lado para gerar o primeiro link de reprodução."
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 440,
									columnNumber: 19
								}, this)
							]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 435,
							columnNumber: 53
						}, this) : /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("ul", {
							className: "divide-y divide-white/10",
							children: initialState.episodes.map((ep) => {
								const sourceCount = countEpisodeSources(ep);
								const isDeleting = confirmDeleteId === ep.id;
								const isBusyDeleting = deleteBusyId === ep.id;
								return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("li", {
									className: "px-6 py-4 hover:bg-white/[0.02] transition-colors space-y-3",
									children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
										className: "flex items-start justify-between gap-4",
										children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
											className: "min-w-0",
											children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h3", {
												className: "text-sm font-semibold text-white truncate",
												children: ep.title
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 451,
												columnNumber: 29
											}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
												className: "mt-1 text-xs text-slate-400 tabular-nums",
												children: [
													sourceCount,
													" ",
													sourceCount === 1 ? "fonte" : "fontes",
													/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
														"aria-hidden": "true",
														children: " · "
													}, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 457,
														columnNumber: 31
													}, this),
													formatDatePtBr(ep.created_at)
												]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 454,
												columnNumber: 29
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 450,
											columnNumber: 27
										}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
											className: "flex items-center gap-1.5 shrink-0",
											children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
												type: "button",
												onClick: () => handleEditStart(ep),
												"aria-label": `Editar ${ep.title}`,
												className: "h-8 px-2.5 rounded-lg border border-white/10 text-xs text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap",
												children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Pencil, { className: "w-3.5 h-3.5" }, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 464,
													columnNumber: 31
												}, this), "Editar"]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 463,
												columnNumber: 29
											}, this), isDeleting ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
												className: "flex items-center gap-1",
												children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
													type: "button",
													disabled: isBusyDeleting,
													onClick: () => void handleConfirmDelete(ep.id),
													className: "h-8 px-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-medium text-white cursor-pointer whitespace-nowrap",
													children: isBusyDeleting ? "Excluindo..." : "Confirmar"
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 469,
													columnNumber: 33
												}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
													type: "button",
													onClick: () => setConfirmDeleteId(null),
													className: "h-8 px-2 rounded-lg border border-white/10 text-xs text-slate-300 hover:bg-white/5 cursor-pointer",
													children: "Cancelar"
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 472,
													columnNumber: 33
												}, this)]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 468,
												columnNumber: 43
											}, this) : /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
												type: "button",
												onClick: () => setConfirmDeleteId(ep.id),
												"aria-label": `Excluir ${ep.title}`,
												className: "h-8 px-2.5 rounded-lg border border-white/10 text-xs text-rose-300 hover:bg-rose-500/10 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap",
												children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Trash2, { className: "w-3.5 h-3.5" }, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 476,
													columnNumber: 33
												}, this), "Excluir"]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 475,
												columnNumber: 40
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 462,
											columnNumber: 27
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 449,
										columnNumber: 25
									}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
										className: "flex items-center gap-2",
										children: [
											/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("input", {
												type: "text",
												readOnly: true,
												value: ep.public_url,
												"aria-label": `Link público de ${ep.title}`,
												className: "flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-[#090B10] border border-white/10 text-xs font-mono text-slate-300"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 484,
												columnNumber: 27
											}, this),
											/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("button", {
												type: "button",
												onClick: () => void copyLink(ep.id, ep.public_url),
												className: "h-9 px-3 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer",
												children: copiedId === ep.id ? /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(import_jsx_dev_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Check, { className: "w-3.5 h-3.5 text-emerald-400" }, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 487,
													columnNumber: 33
												}, this), "Copiado"] }, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 486,
													columnNumber: 51
												}, this) : /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(import_jsx_dev_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Copy, { className: "w-3.5 h-3.5" }, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 490,
													columnNumber: 33
												}, this), "Copiar Link"] }, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 489,
													columnNumber: 37
												}, this)
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 485,
												columnNumber: 27
											}, this),
											/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("a", {
												href: `/e/${encodeURIComponent(ep.id)}`,
												target: "_blank",
												rel: "noreferrer",
												className: "h-9 px-3 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0",
												children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(ExternalLink, { className: "w-3.5 h-3.5" }, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 495,
													columnNumber: 29
												}, this), "Abrir"]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 494,
												columnNumber: 27
											}, this)
										]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 483,
										columnNumber: 25
									}, this)]
								}, ep.id, true, {
									fileName: _jsxFileName,
									lineNumber: 448,
									columnNumber: 22
								}, this);
							})
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 443,
							columnNumber: 26
						}, this)
					]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 414,
					columnNumber: 13
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 303,
				columnNumber: 7
			}, this)]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 243,
			columnNumber: 7
		}, this)]
	}, void 0, true, {
		fileName: _jsxFileName,
		lineNumber: 220,
		columnNumber: 10
	}, this);
}
export { AdminPage as component };
