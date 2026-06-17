const {
	Plugin,
	PluginSettingTab,
	Modal,
	Setting,
	Notice,
	requestUrl,
	normalizePath,
	TFile,
	ItemView,
} = require("obsidian");

const VIEW_TYPE_PAPER_DASHBOARD = "treasure-hub-dashboard";

const PAGE_DASHBOARD = "dashboard";
const PAGE_LIBRARY = "library";

const DEFAULT_PAPER_SEARCH_TYPE = "paper";
const PAPER_SEARCH_TYPES = [
	{ value: "paper", label: "PAPER" },
	{ value: "keywords", label: "KEYWORDS" },
	{ value: "lab", label: "LAB" },
	{ value: "affiliation", label: "AFFILIATION" },
	{ value: "author", label: "AUTHOR" },
];

const STYLE_ORIGINAL = "original";
const DEFAULT_CUSTOM_STYLE_FOLDER_PATH = "Treasure Hub/Themes";
const CUSTOM_STYLE_ELEMENT_ID = "treasure-hub-custom-style";
const BUILTIN_STYLE_ELEMENT_ID = "treasure-hub-builtin-style";
const DEFAULT_THEME_FILE_NAME = "default-theme.css";
const SETTINGS_EXPORT_SCHEMA_VERSION = 1;
const SETTINGS_EXPORT_FILE_PREFIX = "treasure-hub-settings";
const DEFAULT_SETTINGS = {
	templatePath: "Templates/Paper Summary.md",
	markdownFolderPath: "Papers/Summaries",
	pdfFolderPath: "Papers/PDFs",

	// Custom dashboard style settings.
	// original = built-in styles only; otherwise this stores the path of a
	// Markdown note inside customStyleFolderPath. The note must contain one or
	// more fenced ```css code blocks.
	customStyleFolderPath: DEFAULT_CUSTOM_STYLE_FOLDER_PATH,
	activeStylePath: STYLE_ORIGINAL,

	// 是否在主页面 Dashboard 中展示 Overview 统计模块
	// 默认开启，保持原有显示效果
	showDashboardOverview: true,

	// 是否在 Paper Library 中展示论文笔记 image 元属性对应的图片
	// 默认开启
	showPaperLibraryImages: true,
};

const DEFAULT_TEMPLATE = `---
read: false
title:
authors:
labs:
affiliation:
arxiv:
pdf_url:
pdf:
image:
Date:
key_words:
the_truth:
---

# ⭐ Contributions and Significance  



# ✒️ Methodology  



# 💡 Insights



# 🔬 Experiments



# 📰 Related Papers  
`;

module.exports = class TreasureHubPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.customStyleEl = null;
		this.builtinStyleEl = null;
		this.customStyleReloadTimer = null;
		this.autoOpenDashboardTimer = null;
		this.dashboardRefreshSuppressedUntil = 0;
		this.customStyleFiles = [];
		await this.refreshCustomStyleFiles();
		await this.applyActiveStyle();
	
		this.paperRelationGraphLeaf = null;
		this.paperGraphTargetGroupQuery = "";

		this.registerView(
			VIEW_TYPE_PAPER_DASHBOARD,
			(leaf) => new PaperDashboardView(leaf, this)
		);

		this.openDashboardOnLayoutReady();

		this.addRibbonIcon("library", "Open Treasure Hub Dashboard", async () => {
			await this.activateDashboard(PAGE_DASHBOARD);
		});

		this.addCommand({
			id: "open-treasure-hub-dashboard",
			name: "Open Treasure Hub Dashboard",
			callback: async () => {
				await this.activateDashboard(PAGE_DASHBOARD);
			},
		});

		this.addCommand({
			id: "open-paper-library",
			name: "Open Paper Library",
			callback: async () => {
				await this.activateDashboard(PAGE_LIBRARY);
			},
		});

		this.addCommand({
			id: "reload-active-custom-style",
			name: "Reload active dashboard style from Markdown",
			callback: async () => {
				await this.refreshCustomStyleFiles();
				await this.applyActiveStyle({ showNotice: true });
				await this.refreshOpenDashboards();
			},
		});

		this.addCommand({
			id: "copy-treasure-hub-settings-json",
			name: "Copy Treasure Hub settings JSON",
			callback: async () => {
				await this.exportSettingsToClipboard();
			},
		});

		this.addCommand({
			id: "import-treasure-hub-settings-from-json",
			name: "Import Treasure Hub settings from pasted JSON",
			callback: () => {
				new PaperSettingsJsonImportModal(this.app, this, async (jsonText) => {
					return await this.importSettingsFromJsonText(jsonText, {
						sourceName: "pasted JSON",
					});
				}).open();
			},
		});

		this.addCommand({
			id: "export-treasure-hub-settings",
			name: "Download Treasure Hub settings JSON file",
			callback: () => {
				this.exportSettingsToFile();
			},
		});

		this.addCommand({
			id: "import-paper-from-pdf-url",
			name: "Import paper from PDF URL",
			callback: () => {
				new PaperImportModal(this.app, this, async (pdfUrl, downloadPdf) => {
					await this.importPaper(pdfUrl, downloadPdf);
					await this.refreshOpenDashboards();
				}).open();
			},
		});

		this.addCommand({
			id: "import-papers-from-pdf-urls",
			name: "Import papers from PDF URLs",
			callback: () => {
				new PaperBatchImportModal(this.app, this, async (pdfUrls, downloadPdf, onProgress) => {
					const result = await this.importPapers(pdfUrls, downloadPdf, onProgress);
					await this.refreshOpenDashboards();

					return result;
				}).open();
			},
		});

		this.settingTab = new TreasureHubSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.scheduleDashboardRefresh();
				this.handleVaultStyleChange(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.handleVaultStyleChange(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.scheduleDashboardRefresh();
				this.handleVaultStyleChange(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", async (file, oldPath) => {
				this.scheduleDashboardRefresh();
				await this.handleVaultStyleRename(file, oldPath);
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", () =>
				this.scheduleDashboardRefresh()
			)
		);
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PAPER_DASHBOARD);
	
		this.paperRelationGraphLeaf = null;
		this.paperGraphTargetGroupQuery = "";
	
		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}

		if (this.customStyleReloadTimer) {
			window.clearTimeout(this.customStyleReloadTimer);
			this.customStyleReloadTimer = null;
		}

		if (this.autoOpenDashboardTimer) {
			window.clearTimeout(this.autoOpenDashboardTimer);
			this.autoOpenDashboardTimer = null;
		}

		this.removeInjectedStyles();
	}

	openDashboardOnLayoutReady() {
		this.app.workspace.onLayoutReady(() => {
			if (this.autoOpenDashboardTimer) {
				window.clearTimeout(this.autoOpenDashboardTimer);
			}

			this.autoOpenDashboardTimer = window.setTimeout(async () => {
				this.autoOpenDashboardTimer = null;

				try {
					await this.activateDashboard(PAGE_DASHBOARD);
				} catch (error) {
					console.error(
						"treasure-hub: failed to open dashboard on startup",
						error
					);
				}
			}, 0);
		});
	}

	async activateDashboard(page = PAGE_DASHBOARD) {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAPER_DASHBOARD)[0];

		if (!leaf) {
			leaf = this.app.workspace.getLeaf(true);

			await leaf.setViewState({
				type: VIEW_TYPE_PAPER_DASHBOARD,
				active: true,
				state: {
					page,
				},
			});
		}

		await this.app.workspace.revealLeaf(leaf);

		if (leaf.view instanceof PaperDashboardView) {
			await leaf.view.setPage(page);
		}
	}

	scheduleDashboardRefresh() {
		if (this.isDashboardRefreshSuppressed()) {
			return;
		}

		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
		}

		this.refreshTimer = window.setTimeout(async () => {
			this.refreshTimer = null;

			if (this.isDashboardRefreshSuppressed()) {
				return;
			}

			await this.refreshOpenDashboards();
		}, 400);
	}

	isDashboardRefreshSuppressed() {
		return Date.now() < (this.dashboardRefreshSuppressedUntil || 0);
	}

	suppressDashboardRefresh(durationMs = 1600) {
		this.dashboardRefreshSuppressedUntil = Math.max(
			this.dashboardRefreshSuppressedUntil || 0,
			Date.now() + durationMs
		);

		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	async refreshOpenDashboards() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAPER_DASHBOARD);

		for (const leaf of leaves) {
			if (leaf.view instanceof PaperDashboardView) {
				await leaf.view.refreshDataAndRender();
			}
		}
	}

	updateOpenDashboardsReadStatus(paper, read) {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAPER_DASHBOARD);

		for (const leaf of leaves) {
			if (leaf.view instanceof PaperDashboardView) {
				leaf.view.updateReadStatusInPlace(paper, read);
			}
		}
	}

	updateOpenDashboardsPaperDeleted(path) {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAPER_DASHBOARD);

		for (const leaf of leaves) {
			if (leaf.view instanceof PaperDashboardView) {
				leaf.view.removePaperInPlace(path);
			}
		}
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		const baseData =
			loadedData && typeof loadedData === "object" && Object.keys(loadedData).length > 0
				? loadedData
				: await this.loadLegacyPaperOrganizationSettings();

		this.settings = Object.assign({}, DEFAULT_SETTINGS, baseData || {});

		try {
			this.settings.customStyleFolderPath = sanitizeVaultFolderPath(
				this.settings.customStyleFolderPath || DEFAULT_SETTINGS.customStyleFolderPath
			) || DEFAULT_SETTINGS.customStyleFolderPath;
		} catch (error) {
			console.warn("treasure-hub: invalid custom style folder path", error);
			this.settings.customStyleFolderPath = DEFAULT_SETTINGS.customStyleFolderPath;
		}

		if (!this.settings.activeStylePath) {
			this.settings.activeStylePath = STYLE_ORIGINAL;
		}

		if (
			this.settings.activeStylePath !== STYLE_ORIGINAL &&
			!this.isPathInsideCustomStyleFolder(this.settings.activeStylePath)
		) {
			this.settings.activeStylePath = STYLE_ORIGINAL;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async loadLegacyPaperOrganizationSettings() {
		try {
			const adapter = this.app && this.app.vault ? this.app.vault.adapter : null;
			const legacyPath = ".obsidian/plugins/paper-organization/data.json";

			if (!adapter || !(await adapter.exists(legacyPath))) {
				return null;
			}

			const raw = await adapter.read(legacyPath);
			const parsed = JSON.parse(raw);

			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return null;
			}

			console.info("treasure-hub: loaded legacy Paper Organization settings as initial settings.");
			return parsed;
		} catch (error) {
			console.warn("treasure-hub: failed to load legacy Paper Organization settings", error);
			return null;
		}
	}

	getExportableSettings(settings = this.settings) {
		const source = settings || {};
		return {
			templatePath:
				source.templatePath || DEFAULT_SETTINGS.templatePath,
			markdownFolderPath:
				source.markdownFolderPath || DEFAULT_SETTINGS.markdownFolderPath,
			pdfFolderPath:
				source.pdfFolderPath || DEFAULT_SETTINGS.pdfFolderPath,
			customStyleFolderPath:
				this.getCustomStyleFolderPathFromSettings(source),
			activeStylePath:
				source.activeStylePath || STYLE_ORIGINAL,
			showDashboardOverview:
				source.showDashboardOverview !== false,
			showPaperLibraryImages:
				source.showPaperLibraryImages !== false,
		};
	}

	createSettingsExportPayload() {
		return {
			schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
			pluginId: this.manifest && this.manifest.id ? this.manifest.id : "treasure-hub",
			pluginName: this.manifest && this.manifest.name ? this.manifest.name : "Treasure Hub",
			pluginVersion: this.manifest && this.manifest.version ? this.manifest.version : "",
			exportedAt: new Date().toISOString(),
			settings: this.getExportableSettings(),
		};
	}

	createSettingsExportJson() {
		return JSON.stringify(this.createSettingsExportPayload(), null, 2);
	}

	async exportSettingsToClipboard() {
		const json = this.createSettingsExportJson();
		const copied = await copyTextToClipboard(json);

		if (copied) {
			new Notice("Treasure Hub settings JSON copied to clipboard.");
			return { copied: true, json };
		}

		new Notice("Clipboard copy is unavailable. Copy the JSON manually from the dialog.");
		new PaperSettingsJsonExportModal(this.app, json).open();

		return { copied: false, json };
	}

	exportSettingsToFile() {
		const json = this.createSettingsExportJson();
		const filename = `${SETTINGS_EXPORT_FILE_PREFIX}-${formatDateForFileName(Date.now())}.json`;

		downloadTextFile(filename, json, "application/json");
		new Notice(`Treasure Hub settings exported: ${filename}`);

		return JSON.parse(json);
	}

	async importSettingsFromFile(file) {
		if (!file) {
			throw new Error("No settings JSON file selected.");
		}

		const fileName = String(file.name || "settings.json").trim();
		if (fileName && !fileName.toLowerCase().endsWith(".json")) {
			throw new Error("Please choose a .json settings export file.");
		}

		const text = await readBrowserFileAsText(file);
		return await this.importSettingsFromJsonText(text, { sourceName: fileName });
	}

	parseSettingsExportJson(text) {
		try {
			return JSON.parse(String(text || ""));
		} catch (error) {
			throw new Error("The imported settings text is not valid JSON.");
		}
	}

	getSettingsChangeList(previousSettings, nextSettings) {
		const previous = previousSettings || {};
		const next = nextSettings || {};
		const keys = [
			"templatePath",
			"markdownFolderPath",
			"pdfFolderPath",
			"customStyleFolderPath",
			"activeStylePath",
			"showDashboardOverview",
			"showPaperLibraryImages",
		];

		return keys
			.filter((key) => previous[key] !== next[key])
			.map((key) => ({
				key,
				label: this.getSettingsFieldLabel(key),
				from: previous[key],
				to: next[key],
			}));
	}

	getSettingsFieldLabel(key) {
		const labels = {
			templatePath: "Paper summary template path",
			markdownFolderPath: "Markdown output folder",
			pdfFolderPath: "PDF download folder",
			customStyleFolderPath: "Markdown theme folder",
			activeStylePath: "Active dashboard style",
			showDashboardOverview: "Show Overview on main page",
			showPaperLibraryImages: "Show images in Paper Library",
		};

		return labels[key] || String(key || "Setting");
	}

	previewSettingsImportFromJsonText(text) {
		const payload = this.parseSettingsExportJson(text);
		const nextRawSettings = this.normalizeImportedSettingsPayload(payload);
		const previousExportableSettings = this.getExportableSettings(this.settings);
		const nextExportableSettings = this.getExportableSettings(nextRawSettings);

		return {
			previousSettings: previousExportableSettings,
			settings: nextExportableSettings,
			changes: this.getSettingsChangeList(
				previousExportableSettings,
				nextExportableSettings
			),
		};
	}

	async importSettingsFromJsonText(text, options = {}) {
		const payload = this.parseSettingsExportJson(text);
		const nextSettings = this.normalizeImportedSettingsPayload(payload);
		const previousSettings = Object.assign({}, this.settings || {});
		const previousExportableSettings = this.getExportableSettings(previousSettings);

		this.settings = nextSettings;

		await this.saveSettings();
		await this.refreshCustomStyleFiles();
		await this.applyActiveStyle();
		await this.refreshOpenDashboards();

		const nextExportableSettings = this.getExportableSettings(this.settings);
		const activeStylePath = this.settings.activeStylePath || STYLE_ORIGINAL;
		const activeStyleMissing =
			activeStylePath !== STYLE_ORIGINAL &&
			!this.getCustomStyleFiles().some((file) => file.path === activeStylePath);

		return {
			sourceName: options.sourceName || "settings export",
			previousSettings,
			previousExportableSettings,
			settings: nextExportableSettings,
			changes: this.getSettingsChangeList(
				previousExportableSettings,
				nextExportableSettings
			),
			activeStyleMissing,
		};
	}

	normalizeImportedSettingsPayload(payload) {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			throw new Error("Settings export must be a JSON object.");
		}

		const pluginId = String(payload.pluginId || payload.id || "").trim();
		const currentPluginId =
			this.manifest && this.manifest.id ? this.manifest.id : "treasure-hub";
		const acceptedPluginIds = new Set([currentPluginId, "treasure-hub", "paper-organization"]);

		if (pluginId && !acceptedPluginIds.has(pluginId)) {
			throw new Error(`This settings file is for ${pluginId}, not ${currentPluginId}.`);
		}

		const source =
			payload.settings && typeof payload.settings === "object" && !Array.isArray(payload.settings)
				? payload.settings
				: payload;

		const next = Object.assign({}, DEFAULT_SETTINGS);

		next.templatePath = this.normalizeImportedFilePath(
			source.templatePath,
			DEFAULT_SETTINGS.templatePath
		);

		next.markdownFolderPath = this.normalizeImportedFolderPath(
			source.markdownFolderPath,
			DEFAULT_SETTINGS.markdownFolderPath
		);

		next.pdfFolderPath = this.normalizeImportedFolderPath(
			source.pdfFolderPath,
			DEFAULT_SETTINGS.pdfFolderPath
		);

		next.customStyleFolderPath = this.normalizeImportedFolderPath(
			source.customStyleFolderPath,
			DEFAULT_SETTINGS.customStyleFolderPath
		);

		next.showDashboardOverview = source.showDashboardOverview !== false;
		next.showPaperLibraryImages = source.showPaperLibraryImages !== false;
		next.activeStylePath = this.normalizeImportedActiveStylePath(
			source.activeStylePath,
			next.customStyleFolderPath
		);

		return next;
	}

	normalizeImportedFilePath(value, fallback) {
		try {
			return sanitizeVaultFilePath(String(value || "").trim() || fallback) || fallback;
		} catch (error) {
			console.warn("treasure-hub: invalid imported file path", value, error);
			return fallback;
		}
	}

	normalizeImportedFolderPath(value, fallback) {
		try {
			return sanitizeVaultFolderPath(String(value || "").trim() || fallback) || fallback;
		} catch (error) {
			console.warn("treasure-hub: invalid imported folder path", value, error);
			return fallback;
		}
	}

	normalizeImportedActiveStylePath(value, customStyleFolderPath) {
		const raw = String(value || STYLE_ORIGINAL).trim();

		if (!raw || raw === STYLE_ORIGINAL) {
			return STYLE_ORIGINAL;
		}

		try {
			const safePath = sanitizeVaultFilePath(raw);
			const safeFolder = sanitizeVaultFolderPath(customStyleFolderPath || "");

			if (!safePath.toLowerCase().endsWith(".md")) {
				return STYLE_ORIGINAL;
			}

			if (safeFolder && !safePath.startsWith(`${safeFolder}/`)) {
				return STYLE_ORIGINAL;
			}

			return safePath;
		} catch (error) {
			console.warn("treasure-hub: invalid imported active style path", value, error);
			return STYLE_ORIGINAL;
		}
	}

	isOriginalStyleActive() {
		return (this.settings.activeStylePath || STYLE_ORIGINAL) === STYLE_ORIGINAL;
	}

	getCustomStyleFolderPathFromSettings(settings = this.settings) {
		try {
			return sanitizeVaultFolderPath(
				(settings && settings.customStyleFolderPath) || DEFAULT_SETTINGS.customStyleFolderPath
			) || DEFAULT_SETTINGS.customStyleFolderPath;
		} catch (_) {
			return DEFAULT_SETTINGS.customStyleFolderPath;
		}
	}

	getCustomStyleFolderPath() {
		return this.getCustomStyleFolderPathFromSettings(this.settings);
	}

	isPathInsideCustomStyleFolder(path) {
		const stylePath = sanitizeVaultFilePath(path);
		const folder = this.getCustomStyleFolderPath();

		if (!stylePath || !stylePath.toLowerCase().endsWith(".md")) {
			return false;
		}

		return folder ? stylePath.startsWith(`${folder}/`) : true;
	}

	getCustomStyleFiles() {
		return Array.isArray(this.customStyleFiles) ? this.customStyleFiles : [];
	}

	async refreshCustomStyleFiles() {
		const folder = this.getCustomStyleFolderPath();
		const styleFiles = [];

		try {
			const files = this.app.vault.getMarkdownFiles().filter((file) => {
				if (!(file instanceof TFile)) return false;
				if (!folder) return true;
				return file.path.startsWith(`${folder}/`);
			});

			for (const file of files) {
				let markdown = "";

				try {
					markdown = await this.app.vault.read(file);
				} catch (error) {
					console.warn(`treasure-hub: failed to read style note ${file.path}`, error);
					continue;
				}

				const cssBlocks = extractCssCodeBlocks(markdown);

				if (cssBlocks.length === 0) {
					continue;
				}

				const cssSize = cssBlocks.reduce((total, block) => total + block.length, 0);

				styleFiles.push({
					path: file.path,
					name: file.name,
					basename: file.basename,
					extension: "md",
					cssBlockCount: cssBlocks.length,
					cssSize,
					stat: Object.assign({
						size: 0,
						mtime: 0,
						ctime: 0,
					}, file.stat || {}),
				});
			}

			styleFiles.sort((a, b) => a.name.localeCompare(b.name));
			this.customStyleFiles = styleFiles;

			return styleFiles;
		} catch (error) {
			console.warn("treasure-hub: failed to scan Markdown style folder", error);
			this.customStyleFiles = [];
			return this.customStyleFiles;
		}
	}

	getActiveStyleLabel() {
		const activeStylePath = this.settings.activeStylePath || STYLE_ORIGINAL;

		if (activeStylePath === STYLE_ORIGINAL) {
			return "Original";
		}

		const file = this.getCustomStyleFiles().find((item) => item.path === activeStylePath);

		if (file) {
			return file.basename || file.name || activeStylePath;
		}

		return `Missing: ${activeStylePath}`;
	}

	async setCustomStyleFolderPath(folderPath) {
		const nextFolder = sanitizeVaultFolderPath(
			String(folderPath || "").trim() || DEFAULT_SETTINGS.customStyleFolderPath
		) || DEFAULT_SETTINGS.customStyleFolderPath;

		this.settings.customStyleFolderPath = nextFolder;

		if (
			this.settings.activeStylePath !== STYLE_ORIGINAL &&
			!this.isPathInsideCustomStyleFolder(this.settings.activeStylePath)
		) {
			this.settings.activeStylePath = STYLE_ORIGINAL;
		}

		await this.saveSettings();
		await this.refreshCustomStyleFiles();
		await this.applyActiveStyle();
		await this.refreshOpenDashboards();
	}

	async setActiveStyle(stylePath, options = {}) {
		const requestedStyle = String(stylePath || STYLE_ORIGINAL).trim();
		let nextStyle = STYLE_ORIGINAL;

		if (requestedStyle !== STYLE_ORIGINAL) {
			const safePath = sanitizeVaultFilePath(requestedStyle);

			if (!this.isPathInsideCustomStyleFolder(safePath)) {
				throw new Error(
					`Markdown style notes must be stored in ${this.getCustomStyleFolderPath()} and end with .md.`
				);
			}

			nextStyle = safePath;
		}

		this.settings.activeStylePath = nextStyle;
		await this.saveSettings();
		await this.refreshCustomStyleFiles();
		await this.applyActiveStyle({
			showNotice: options.showNotice === true,
		});
		await this.refreshOpenDashboards();
	}

	removeBuiltinStyle() {
		if (this.builtinStyleEl instanceof HTMLStyleElement) {
			this.builtinStyleEl.remove();
		}

		const existing = document.getElementById(BUILTIN_STYLE_ELEMENT_ID);
		if (existing instanceof HTMLStyleElement) {
			existing.remove();
		}

		this.builtinStyleEl = null;
	}

	getBundledDefaultThemePath() {
		const manifestDir =
			this.manifest && this.manifest.dir
				? this.manifest.dir
				: `.obsidian/plugins/${this.manifest && this.manifest.id ? this.manifest.id : "treasure-hub"}`;

		return normalizePath(`${manifestDir}/${DEFAULT_THEME_FILE_NAME}`);
	}

	async readBundledDefaultThemeCss() {
		const themePath = this.getBundledDefaultThemePath();
		const adapter = this.app.vault.adapter;

		if (!(await adapter.exists(themePath))) {
			throw new Error(`Bundled default theme file not found: ${themePath}`);
		}

		return await adapter.read(themePath);
	}

	async injectBuiltinStyle() {
		this.removeBuiltinStyle();

		const css = String(await this.readBundledDefaultThemeCss()).trim();
		if (!css) {
			return false;
		}

		const styleEl = document.createElement("style");
		styleEl.id = BUILTIN_STYLE_ELEMENT_ID;
		styleEl.dataset.paperOrganizationStylePath = STYLE_ORIGINAL;
		styleEl.dataset.paperOrganizationThemeSource = this.getBundledDefaultThemePath();
		styleEl.textContent = `/* Treasure Hub default theme: ${this.getBundledDefaultThemePath()} */\n${css}`;
		document.head.appendChild(styleEl);
		this.builtinStyleEl = styleEl;

		return true;
	}

	removeActiveCustomStyle() {
		if (this.customStyleEl instanceof HTMLStyleElement) {
			this.customStyleEl.remove();
		}

		const existing = document.getElementById(CUSTOM_STYLE_ELEMENT_ID);
		if (existing instanceof HTMLStyleElement) {
			existing.remove();
		}

		this.customStyleEl = null;
	}

	removeInjectedStyles() {
		this.removeBuiltinStyle();
		this.removeActiveCustomStyle();
	}

	async applyOriginalStyleFallback(options = {}, message = "Treasure Hub style: Original") {
		this.removeInjectedStyles();
		await this.injectBuiltinStyle();

		if (options.showNotice) {
			new Notice(message);
		}
	}

	async applyActiveStyle(options = {}) {
		// styles.css only contains small, non-theme base UI. The dashboard/library
		// theme itself is injected here:
		// - Original: read and inject bundled default-theme.css.
		// - Markdown theme: inject only fenced ```css blocks from the selected .md note.
		this.removeInjectedStyles();

		const activeStylePath = this.settings.activeStylePath || STYLE_ORIGINAL;

		if (activeStylePath === STYLE_ORIGINAL) {
			await this.injectBuiltinStyle();
			if (options.showNotice) {
				new Notice("Treasure Hub style: Original");
			}
			return true;
		}

		let safeStylePath = "";

		try {
			safeStylePath = sanitizeVaultFilePath(activeStylePath);
		} catch (error) {
			console.warn("treasure-hub: invalid Markdown style path", error);
			await this.applyOriginalStyleFallback(
				options,
				"Markdown style path is invalid. Original style is being used."
			);
			return false;
		}

		if (!this.isPathInsideCustomStyleFolder(safeStylePath)) {
			await this.applyOriginalStyleFallback(
				options,
				`Markdown style notes must be stored in ${this.getCustomStyleFolderPath()}. Original style is being used.`
			);
			return false;
		}

		try {
			const file = this.app.vault.getAbstractFileByPath(safeStylePath);

			if (!(file instanceof TFile)) {
				await this.applyOriginalStyleFallback(
					options,
					"Markdown style note not found. Original style is being used."
				);
				return false;
			}

			const markdown = await this.app.vault.read(file);
			const css = buildCssFromMarkdownStyleNote(safeStylePath, markdown);
			const styleEl = document.createElement("style");
			styleEl.id = CUSTOM_STYLE_ELEMENT_ID;
			styleEl.dataset.paperOrganizationStylePath = safeStylePath;
			styleEl.dataset.paperOrganizationReplacesBuiltinStyle = "true";
			styleEl.textContent = `/* Treasure Hub Markdown replacement style: ${safeStylePath} */\n${css}`;
			document.head.appendChild(styleEl);
			this.customStyleEl = styleEl;

			const activeFile = this.getCustomStyleFiles().find((item) => item.path === safeStylePath);

			if (options.showNotice) {
				new Notice(
					`Treasure Hub style: ${
						(activeFile && (activeFile.basename || activeFile.name)) || file.basename || safeStylePath
					} (Markdown theme)`
				);
			}

			return true;
		} catch (error) {
			console.error("treasure-hub: failed to load Markdown style", error);

			await this.applyOriginalStyleFallback(
				options,
				`Failed to load Markdown style. Original style is being used: ${
					error && error.message ? error.message : String(error)
				}`
			);

			return false;
		}
	}

	scheduleActiveStyleReload() {
		if (this.customStyleReloadTimer) {
			window.clearTimeout(this.customStyleReloadTimer);
		}

		this.customStyleReloadTimer = window.setTimeout(async () => {
			this.customStyleReloadTimer = null;
			await this.refreshCustomStyleFiles();
			await this.applyActiveStyle();
			await this.refreshOpenDashboards();
		}, 250);
	}

	isCustomStylePathRelevant(path) {
		let stylePath = "";

		try {
			stylePath = sanitizeVaultFilePath(path);
		} catch (_) {
			return false;
		}

		if (!stylePath || !stylePath.toLowerCase().endsWith(".md")) {
			return false;
		}

		const activeStylePath = this.settings.activeStylePath || STYLE_ORIGINAL;

		if (activeStylePath !== STYLE_ORIGINAL && stylePath === activeStylePath) {
			return true;
		}

		return this.isPathInsideCustomStyleFolder(stylePath);
	}

	handleVaultStyleChange(file, oldPath = "") {
		const paths = [
			file && file.path ? file.path : "",
			oldPath || "",
		];

		if (paths.some((path) => this.isCustomStylePathRelevant(path))) {
			this.scheduleActiveStyleReload();
		}
	}

	async handleVaultStyleRename(file, oldPath = "") {
		if (
			oldPath &&
			this.settings.activeStylePath === oldPath &&
			file instanceof TFile &&
			String(file.extension || "").toLowerCase() === "md" &&
			this.isPathInsideCustomStyleFolder(file.path)
		) {
			this.settings.activeStylePath = file.path;
			await this.saveSettings();
		}

		this.handleVaultStyleChange(file, oldPath);
	}

	async importCustomStyleFile(file) {
		if (!file) {
			throw new Error("No CSS or Markdown file selected.");
		}

		const originalName = String(file.name || "custom-style.md").trim();
		const lowerName = originalName.toLowerCase();

		if (!lowerName.endsWith(".css") && !lowerName.endsWith(".md")) {
			throw new Error("Please choose a .css or .md file.");
		}

		const content = await readBrowserFileAsText(file);
		const folder = this.getCustomStyleFolderPath();
		await ensureAdapterFolder(this.app, folder);

		const baseName = originalName.replace(/\.(css|md)$/i, "") || "custom-style";
		const stylePath = await getAvailableAdapterPath(
			this.app,
			folder,
			sanitizeFileName(baseName, 80),
			"md"
		);

		let markdownContent = content;

		if (lowerName.endsWith(".css")) {
			markdownContent = `# ${baseName}\n\n\`\`\`css\n${content.trim()}\n\`\`\`\n`;
		} else if (extractCssCodeBlocks(content).length === 0) {
			throw new Error("The selected Markdown file does not contain a fenced ```css code block.");
		}

		await this.app.vault.adapter.write(stylePath, markdownContent);
		await this.refreshCustomStyleFiles();
		await this.setActiveStyle(stylePath, { showNotice: false });

		return stylePath;
	}

	async createSampleCustomStyleNote() {
		const folder = this.getCustomStyleFolderPath();
		await ensureAdapterFolder(this.app, folder);

		const stylePath = await getAvailableAdapterPath(
			this.app,
			folder,
			"Soft Paper Theme",
			"md"
		);

		const content = `# Soft Paper Theme\n\nEdit the CSS block below, then use Treasure Hub settings to refresh and enable this note.\n\n\`\`\`css\n.paper-dashboard-title {\n\tletter-spacing: -0.045em;\n}\n\n.paper-dashboard-section,\n.paper-library-card,\n.paper-navigation-card {\n\tborder-radius: 22px;\n}\n\n.paper-page-header {\n\tbackground:\n\t\tlinear-gradient(135deg, rgba(var(--interactive-accent-rgb), 0.16), transparent 42%),\n\t\tvar(--background-secondary);\n}\n\`\`\`\n`;

		await this.app.vault.adapter.write(stylePath, content);
		await this.refreshCustomStyleFiles();
		await this.setActiveStyle(stylePath, { showNotice: true });

		return stylePath;
	}

	async importPaper(pdfUrl, downloadPdf, options = {}) {
		const cleanedUrl = String(pdfUrl || "").trim();

		if (!/^https?:\/\//i.test(cleanedUrl)) {
			throw new Error("Please enter a valid HTTP/HTTPS PDF URL.");
		}

		const arxivId = extractArxivId(cleanedUrl);

		let metadata = {
			title: "",
			authors: [],
			arxiv: arxivId || "",
		};

		if (arxivId) {
			try {
				const arxivMetadata = await fetchArxivMetadata(arxivId);

				if (
					isUsablePaperTitle(arxivMetadata.title) &&
					!isArxivLikeTitle(arxivMetadata.title, arxivId)
				) {
					metadata.title = normalizeWhitespace(arxivMetadata.title);
				}

				if (Array.isArray(arxivMetadata.authors)) {
					metadata.authors = normalizeAuthors(arxivMetadata.authors);
				}

				metadata.arxiv = arxivMetadata.arxiv || arxivId;
			} catch (error) {
				console.warn(
					"treasure-hub: arXiv metadata request failed; falling back to URL metadata.",
					error
				);
			}
		}

		let finalTitle = normalizeWhitespace(metadata.title || "");

		if (!isUsablePaperTitle(finalTitle)) {
			finalTitle = deriveTitleFromUrl(cleanedUrl);
		}

		if (!isUsablePaperTitle(finalTitle)) {
			finalTitle = "paper";
		}

		metadata.title = fixLeadingMethodDash(finalTitle);
		metadata.authors = normalizeAuthors(metadata.authors || []);
		metadata.arxiv = metadata.arxiv || arxivId || "";

		const safeBaseName = sanitizeFileName(metadata.title, 140);

		const markdownFolder = sanitizeVaultFolderPath(
			this.settings.markdownFolderPath || DEFAULT_SETTINGS.markdownFolderPath
		);

		const pdfFolder = sanitizeVaultFolderPath(
			this.settings.pdfFolderPath || DEFAULT_SETTINGS.pdfFolderPath
		);

		let pdfValue = "";

		if (downloadPdf) {
			const pdfArrayBuffer = await fetchPdfArrayBuffer(cleanedUrl);

			await ensureFolder(this.app, pdfFolder);

			const pdfPath = await getAvailableVaultPath(
				this.app,
				pdfFolder,
				safeBaseName,
				"pdf"
			);

			await this.app.vault.createBinary(pdfPath, pdfArrayBuffer);
			pdfValue = `[[${pdfPath}]]`;
		}

		const templateContent = await this.readTemplateContent();
		const templateBody = extractMarkdownBody(templateContent);

		await ensureFolder(this.app, markdownFolder);

		const markdownPath = await getAvailableVaultPath(
			this.app,
			markdownFolder,
			safeBaseName,
			"md"
		);

			const frontmatter = buildOrderedFrontmatter({
				read: false,
				title: metadata.title,
				authors: metadata.authors,
				labs: [],
				affiliation: "",
				arxiv: metadata.arxiv,
				pdf_url: cleanedUrl,
				pdf: pdfValue,
				image: "",
				Date: "",
				key_words: [],
				the_truth: "",
			});

		const markdownContent =
			frontmatter + normalizeTemplateBodyForAppend(templateBody);

		const file = await this.app.vault.create(markdownPath, markdownContent);

		if (!options || options.showNotice !== false) {
			new Notice(`Paper note created: ${file.path}`);
		}

		return file;
	}

	async importPapers(pdfUrls, downloadPdf, onProgress) {
		const urls = parsePaperPdfUrls(pdfUrls);

		if (urls.length === 0) {
			throw new Error("Please enter at least one valid HTTP/HTTPS PDF URL.");
		}

		const result = {
			total: urls.length,
			succeeded: [],
			failed: [],
		};

		for (const url of urls) {
			try {
				const file = await this.importPaper(url, downloadPdf, {
					showNotice: false,
				});

				result.succeeded.push({
					url,
					path: file && file.path ? file.path : "",
					file,
				});
			} catch (error) {
				console.error(
					`treasure-hub: failed to import paper from ${url}`,
					error
				);

				result.failed.push({
					url,
					error,
				});
			} finally {
				if (typeof onProgress === "function") {
					onProgress(result);
				}
			}
		}

		const succeededCount = result.succeeded.length;
		const failedCount = result.failed.length;

		if (failedCount === 0) {
			new Notice(`Batch import completed: ${succeededCount}/${result.total} papers created.`);
		} else if (succeededCount === 0) {
			const firstError = result.failed[0] && result.failed[0].error;
			new Notice(
				`Batch import failed: 0/${result.total} papers created. ${
					firstError && firstError.message ? firstError.message : "See console for details."
				}`
			);
		} else {
			new Notice(
				`Batch import partially completed: ${succeededCount}/${result.total} papers created, ${failedCount} failed. See console for details.`
			);
		}

		return result;
	}

	async readTemplateContent() {
		const templatePath = sanitizeVaultFilePath(
			this.settings.templatePath || DEFAULT_SETTINGS.templatePath
		);

		const file = this.app.vault.getAbstractFileByPath(templatePath);

		if (file instanceof TFile) {
			return await this.app.vault.read(file);
		}

		return DEFAULT_TEMPLATE;
	}

	getPaperItems() {
		const folder = sanitizeVaultFolderPath(
			this.settings.markdownFolderPath || DEFAULT_SETTINGS.markdownFolderPath
		);

		const files = this.app.vault.getMarkdownFiles().filter((file) => {
			if (!folder) return true;
			return file.path.startsWith(`${folder}/`);
		});

		return files.map((file) => this.buildPaperItem(file));
	}

	buildPaperItem(file) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter ? cache.frontmatter : {};

		const title = normalizeWhitespace(asString(fm.title)) || file.basename;
		const authors = normalizeStringArray(asArray(fm.authors));
			const labs = normalizeStringArray([
				...asArray(fm.lab),
				...asArray(fm.labs),
			]);
			const affiliations = normalizeStringArray([
				...asArray(fm.affiliation),
				...asArray(fm.affiliations),
			]);
			const keywords = normalizeStringArray([
				...asArray(fm.key_words),
				...asArray(fm.keywords),
			]);
		const image = normalizeWhitespace(asFirstString(fm.image));

		const theTruthSource =
			fm.the_truth !== undefined && fm.the_truth !== null
				? fm.the_truth
				: fm.summary;

		const theTruth = String(asString(theTruthSource) || "").trim();
		const read = asBoolean(fm.read);

		const arxiv = normalizeWhitespace(asString(fm.arxiv));
		const paperYear = extractPaperYear(fm);
		const arxivSortTime = getArxivSortTime(arxiv);

		let pdf = normalizeWhitespace(asString(fm.pdf));
		let pdfUrl = normalizeWhitespace(asString(fm.pdf_url));

		if (/^https?:\/\//i.test(pdf)) {
			if (!pdfUrl) {
				pdfUrl = pdf;
			}

			pdf = "";
		}

		const createdTime = file.stat.ctime;
		const modifiedTime = file.stat.mtime;

		const normalizedTitle = normalizeForSearch(title);
		const normalizedAuthors = authors.map(normalizeForSearch);
		const normalizedLabs = labs.map(normalizeForSearch);
		const normalizedAffiliations = affiliations.map(normalizeForSearch);
		const normalizedKeywords = keywords.map(normalizeForSearch);
		const normalizedArxiv = normalizeForSearch(arxiv);
		const normalizedTheTruth = normalizeForSearch(theTruth);
		const normalizedPdfUrl = normalizeForSearch(pdfUrl);
		const normalizedPdf = normalizeForSearch(pdf);
		const normalizedImage = normalizeForSearch(image);

		const pdfStatus = pdf ? "Local" : pdfUrl ? "External" : "None";

		const searchHaystack = [
			normalizedTitle,
			normalizedArxiv,
			normalizedTheTruth,
			normalizedPdfUrl,
			normalizedPdf,
			normalizedImage,
			...normalizedAuthors,
			...normalizedLabs,
			...normalizedAffiliations,
			...normalizedKeywords,
		].join(" ");

		return {
			path: file.path,
			file,
			title,
			authors,
			labs,
			affiliations,
			keywords,
			read,
			arxiv,
			paperYear,
			arxivSortTime,
			pdf,
			pdfUrl,
			image,
			hasImage: !!image,
			theTruth,
			summary: theTruth,
			createdTime,
			modifiedTime,
			normalizedTitle,
			normalizedAuthors,
			normalizedLabs,
			normalizedAffiliations,
			normalizedKeywords,
			normalizedArxiv,
			searchHaystack,
			pdfStatus,
			hasPdf: pdfStatus !== "None",
		};
	}

	async openNote(paper) {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(paper.file);
	}

	async openPaperGlobalGraph(paper, anchorLeaf = null) {
		if (!paper || !(paper.file instanceof TFile)) {
			new Notice("Paper note not found.");
			return;
		}

		const graphPaths = this.getPaperGraphRelatedMarkdownPaths(paper);
		const graphSearchQuery = this.buildPaperGraphSearchQuery(graphPaths);
		const targetGraphSearchQuery = this.buildPaperGraphSearchQuery([paper.file.path]);

		try {
			const leftLeaf =
				anchorLeaf ||
				this.app.workspace.activeLeaf ||
				this.app.workspace.getLeaf(false);

			if (!leftLeaf) {
				new Notice("No active workspace leaf found.");
				return;
			}

			const graphLeaf = await this.getOrCreatePaperRelationGraphLeaf(leftLeaf);
			const graphState = this.withPaperGraphTargetColorGroup(
				this.getGraphLeafState(graphLeaf),
				targetGraphSearchQuery
			);

			graphState.search = graphSearchQuery;

			await graphLeaf.setViewState({
				type: "graph",
				active: true,
				state: graphState,
			});

			this.paperRelationGraphLeaf = graphLeaf;
			this.markPaperRelationGraphLeaf(graphLeaf);

			await this.app.workspace.revealLeaf(graphLeaf);

			await sleepMs(180);

			const filterApplied = await this.applyGraphSearchFilter(
				graphLeaf,
				graphSearchQuery
			);

			const highlightApplied = await this.applyGraphTargetHighlight(
				graphLeaf,
				targetGraphSearchQuery
			);

			this.setSplitRatio(leftLeaf, graphLeaf, 2, 1);

			this.setActiveLeafSafely(leftLeaf);

			if (
				this.app.workspace.requestSaveLayout &&
				typeof this.app.workspace.requestSaveLayout === "function"
			) {
				this.app.workspace.requestSaveLayout();
			}

			if (!filterApplied) {
				new Notice(
					`Opened global graph. Please enter this filter manually if it was not applied: ${graphSearchQuery}`
				);
				return;
			}

			new Notice(
				`Updated global graph: ${graphPaths.length} related markdown file${
					graphPaths.length === 1 ? "" : "s"
				}${highlightApplied ? ", target node highlighted" : ""}.`
			);
		} catch (error) {
			console.error(
				"treasure-hub: failed to open or update global graph",
				error
			);

			new Notice(
				"Failed to open Obsidian Graph view. Please make sure the Graph view core plugin is enabled."
			);
		}
	}

	getPaperGraphRelatedMarkdownPaths(paper) {
		const sourceFile = paper && paper.file instanceof TFile ? paper.file : null;
		const sourcePath = normalizePath(
			String((sourceFile && sourceFile.path) || (paper && paper.path) || "")
		);

		const relatedPaths = [];
		const seen = new Set();

		const addPath = (value) => {
			const normalizedPath = normalizePath(String(value || "").trim());

			if (!normalizedPath || seen.has(normalizedPath)) {
				return;
			}

			const file = this.app.vault.getAbstractFileByPath(normalizedPath);

			if (!(file instanceof TFile) || file.extension !== "md") {
				return;
			}

			seen.add(normalizedPath);
			relatedPaths.push(normalizedPath);
		};

		addPath(sourcePath);

		if (!sourceFile || !sourcePath) {
			return relatedPaths;
		}

		this.addPaperOutlinkMarkdownPaths(sourceFile, addPath);
		this.addPaperBacklinkMarkdownPaths(sourcePath, addPath);

		return relatedPaths;
	}

	addPaperOutlinkMarkdownPaths(sourceFile, addPath) {
		if (!(sourceFile instanceof TFile) || typeof addPath !== "function") return;

		const sourcePath = sourceFile.path;
		const resolvedOutlinks =
			this.app.metadataCache && this.app.metadataCache.resolvedLinks
				? this.app.metadataCache.resolvedLinks[sourcePath]
				: null;

		if (resolvedOutlinks && typeof resolvedOutlinks === "object") {
			for (const targetPath of Object.keys(resolvedOutlinks)) {
				addPath(targetPath);
			}
		}

		const cache = this.app.metadataCache.getFileCache(sourceFile);
		const linkItems = [
			...(cache && Array.isArray(cache.links) ? cache.links : []),
			...(cache && Array.isArray(cache.embeds) ? cache.embeds : []),
		];

		for (const linkItem of linkItems) {
			const linkTarget = linkItem && linkItem.link ? linkItem.link : "";
			if (!linkTarget) continue;

			const targetFile = this.app.metadataCache.getFirstLinkpathDest(
				linkTarget,
				sourcePath
			);

			if (targetFile instanceof TFile) {
				addPath(targetFile.path);
			}
		}
	}

	addPaperBacklinkMarkdownPaths(sourcePath, addPath) {
		if (!sourcePath || typeof addPath !== "function") return;

		const resolvedLinks =
			this.app.metadataCache && this.app.metadataCache.resolvedLinks
				? this.app.metadataCache.resolvedLinks
				: {};

		for (const [linkingPath, targets] of Object.entries(resolvedLinks)) {
			if (!targets || typeof targets !== "object") continue;

			if (Object.prototype.hasOwnProperty.call(targets, sourcePath)) {
				addPath(linkingPath);
			}
		}
	}

	buildPaperGraphSearchQuery(paths) {
		const normalizedPaths = Array.isArray(paths)
			? paths.map((path) => normalizePath(String(path || "").trim())).filter(Boolean)
			: [];

		return normalizedPaths
			.map((path) => `path:"${this.escapeGraphSearchQuotedValue(path)}"`)
			.join(" OR ");
	}

	buildPaperGraphTargetColorGroups(targetGraphSearchQuery) {
		const targetQuery = String(targetGraphSearchQuery || "").trim();
		if (!targetQuery) return [];

		return [this.createPaperGraphTargetColorGroup(targetQuery)];
	}

	createPaperGraphTargetColorGroup(targetGraphSearchQuery) {
		const r = 92;
		const g = 181;
		const b = 218;
	
		return {
			query: targetGraphSearchQuery,
			color: {
				a: 1,
				rgb: r * 65536 + g * 256 + b,
				r,
				g,
				b,
			},
			paperOrganizationTargetGroup: true,
		};
	}

	escapeGraphSearchQuotedValue(value) {
		return String(value || "")
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"');
	}

	getGraphLeafState(graphLeaf) {
		try {
			const state =
				graphLeaf && typeof graphLeaf.getViewState === "function"
					? graphLeaf.getViewState()
					: null;

			if (state && state.state && typeof state.state === "object") {
				return Object.assign({}, state.state);
			}
		} catch (_) {}

		return {};
	}

	async applyGraphTargetHighlight(graphLeaf, targetGraphSearchQuery) {
		let applied = false;

		applied =
			this.applyGraphTargetHighlightUsingInternalApi(
				graphLeaf,
				targetGraphSearchQuery
			) || applied;

		if (!applied) {
			this.tryOpenGraphControls(graphLeaf);
			await sleepMs(120);
			applied =
				this.applyGraphTargetHighlightUsingInternalApi(
					graphLeaf,
					targetGraphSearchQuery
				) || applied;
		}

		this.refreshGraphView(graphLeaf);

		return applied;
	}

	applyGraphTargetHighlightUsingInternalApi(graphLeaf, targetGraphSearchQuery) {
		const view = graphLeaf && graphLeaf.view;
		if (!view) return false;

		const targetQuery = String(targetGraphSearchQuery || "").trim();
		if (!targetQuery) return false;

		let applied = false;
		const targetColorGroups = this.buildPaperGraphTargetColorGroups(targetQuery);

		const methodTargets = [
			[view, "setColorGroups"],
			[view, "setGroups"],
			[view.renderer, "setColorGroups"],
			[view.renderer, "setGroups"],
			[view.graph, "setColorGroups"],
			[view.graph, "setGroups"],
			[view.dataEngine, "setColorGroups"],
			[view.dataEngine, "setGroups"],
			[view.engine, "setColorGroups"],
			[view.engine, "setGroups"],
		];

		for (const [target, methodName] of methodTargets) {
			if (!target || typeof target[methodName] !== "function") continue;

			try {
				const currentOptions =
					target.options && typeof target.options === "object"
						? target.options
						: {
							colorGroups: Array.isArray(target.colorGroups)
								? target.colorGroups
								: targetColorGroups,
							groups: Array.isArray(target.groups)
								? target.groups
								: targetColorGroups,
						};
				const mergedOptions = this.withPaperGraphTargetColorGroup(
					currentOptions,
					targetQuery
				);

				target[methodName](
					methodName === "setGroups"
						? mergedOptions.groups
						: mergedOptions.colorGroups
				);
				applied = true;
			} catch (_) {}
		}

		const optionTargets = [
			view,
			view.renderer,
			view.graph,
			view.dataEngine,
			view.engine,
		];

		for (const target of optionTargets) {
			if (!target) continue;

			try {
				if (target.options && typeof target.options === "object") {
					target.options = this.withPaperGraphTargetColorGroup(
						target.options,
						targetQuery
					);
					applied = true;
				}

				if (Array.isArray(target.colorGroups)) {
					target.colorGroups = this.withPaperGraphTargetColorGroup(
						{ colorGroups: target.colorGroups },
						targetQuery
					).colorGroups;
					applied = true;
				}

				if (Array.isArray(target.groups)) {
					target.groups = this.withPaperGraphTargetColorGroup(
						{ groups: target.groups },
						targetQuery
					).groups;
					applied = true;
				}
			} catch (_) {}
		}

		for (const target of optionTargets) {
			if (!target || typeof target.setOptions !== "function") continue;
			if (!target.options || typeof target.options !== "object") continue;

			try {
				target.setOptions(
					this.withPaperGraphTargetColorGroup(target.options, targetQuery)
				);
				applied = true;
			} catch (_) {}
		}

		this.rememberPaperGraphTargetGroupQuery(graphLeaf, targetQuery);

		return applied;
	}

	withPaperGraphTargetColorGroup(options, targetGraphSearchQuery) {
		const nextOptions = Object.assign({}, options || {});
		const previousQuery = String(this.paperGraphTargetGroupQuery || "").trim();
		const nextGroup = this.createPaperGraphTargetColorGroup(
			targetGraphSearchQuery
		);

		const mergeGroups = (groups) => {
			const existingGroups = Array.isArray(groups) ? groups : [];

			return [
				...existingGroups.filter((group) => {
					if (!group || typeof group !== "object") return true;
					if (group.paperOrganizationTargetGroup === true) return false;
					if (previousQuery && group.query === previousQuery) return false;
					return group.query !== targetGraphSearchQuery;
				}),
				nextGroup,
			];
		};

		nextOptions.colorGroups = mergeGroups(nextOptions.colorGroups);
		nextOptions.groups = mergeGroups(nextOptions.groups);

		return nextOptions;
	}

	rememberPaperGraphTargetGroupQuery(graphLeaf, targetGraphSearchQuery) {
		this.paperGraphTargetGroupQuery = targetGraphSearchQuery;

		if (graphLeaf) {
			graphLeaf.paperOrganizationTargetGroupQuery = targetGraphSearchQuery;
		}

		const container = this.getGraphLeafContainer(graphLeaf);
		if (container instanceof HTMLElement) {
			container.dataset.paperOrganizationTargetGroupQuery =
				targetGraphSearchQuery;
		}
	}

	async applyGraphSearchFilter(graphLeaf, searchQuery) {
		let applied = false;

		applied = this.applyGraphSearchUsingInternalApi(graphLeaf, searchQuery) || applied;
		applied = this.applyGraphSearchUsingDom(graphLeaf, searchQuery) || applied;

		if (!applied) {
			this.tryOpenGraphControls(graphLeaf);
			await sleepMs(120);
			applied = this.applyGraphSearchUsingDom(graphLeaf, searchQuery) || applied;
		}

		this.refreshGraphView(graphLeaf);

		return applied;
	}

	applyGraphSearchUsingInternalApi(graphLeaf, searchQuery) {
		const view = graphLeaf && graphLeaf.view;
		if (!view) return false;

		let applied = false;

		const methodTargets = [
			[view, "setSearch"],
			[view, "setSearchQuery"],
			[view, "setQuery"],
			[view.renderer, "setSearch"],
			[view.renderer, "setSearchQuery"],
			[view.renderer, "setQuery"],
			[view.graph, "setSearch"],
			[view.graph, "setSearchQuery"],
			[view.graph, "setQuery"],
			[view.dataEngine, "setSearch"],
			[view.dataEngine, "setSearchQuery"],
			[view.dataEngine, "setQuery"],
		];

		for (const [target, methodName] of methodTargets) {
			if (!target || typeof target[methodName] !== "function") continue;

			try {
				target[methodName](searchQuery);
				applied = true;
			} catch (_) {}
		}

		const optionTargets = [
			view,
			view.renderer,
			view.graph,
			view.dataEngine,
			view.engine,
		];

		for (const target of optionTargets) {
			if (!target) continue;

			try {
				if (target.options && typeof target.options === "object") {
					target.options.search = searchQuery;
					applied = true;
				}

				if (typeof target.search === "string") {
					target.search = searchQuery;
					applied = true;
				}

				if (typeof target.query === "string") {
					target.query = searchQuery;
					applied = true;
				}
			} catch (_) {}
		}

		for (const target of optionTargets) {
			if (!target || typeof target.setOptions !== "function") continue;
			if (!target.options || typeof target.options !== "object") continue;

			try {
				target.setOptions(Object.assign({}, target.options, {
					search: searchQuery,
				}));
				applied = true;
			} catch (_) {}
		}

		return applied;
	}

	applyGraphSearchUsingDom(graphLeaf, searchQuery) {
		const container = this.getGraphLeafContainer(graphLeaf);
		if (!(container instanceof HTMLElement)) return false;

		const input = this.findGraphSearchInput(container);
		if (!(input instanceof HTMLInputElement)) return false;

		try {
			input.focus();
			input.value = searchQuery;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			input.blur();

			return true;
		} catch (error) {
			console.warn(
				"treasure-hub: failed to set graph search input",
				error
			);
			return false;
		}
	}

	findGraphSearchInput(container) {
		const selectors = [
			'.graph-controls .search-input-container input[type="text"]',
			'.graph-controls .search-input-container input[type="search"]',
			'.graph-controls input[type="text"]',
			'.graph-controls input[type="search"]',
			'.workspace-leaf-content[data-type="graph"] .search-input-container input',
			'.workspace-leaf-content[data-type="graph"] input[type="text"]',
			'.workspace-leaf-content[data-type="graph"] input[type="search"]',
			'input[placeholder*="Search files"]',
			'input[placeholder*="Search"]',
			'input[type="search"]',
			'input[type="text"]',
		];

		const candidates = [];

		for (const selector of selectors) {
			for (const input of Array.from(container.querySelectorAll(selector))) {
				if (!(input instanceof HTMLInputElement)) continue;
				if (input.disabled || input.readOnly) continue;
				if (!candidates.includes(input)) {
					candidates.push(input);
				}
			}
		}

		if (candidates.length === 0) return null;

		const scoreInput = (input) => {
			const text = [
				input.placeholder,
				input.getAttribute("aria-label"),
				input.getAttribute("title"),
				input.className,
				input.closest(".graph-controls") ? "graph-controls" : "",
				input.closest(".search-input-container") ? "search-input-container" : "",
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();

			let score = 0;

			if (text.includes("search files") || text.includes("搜索文件")) score += 100;
			if (text.includes("search") || text.includes("搜索")) score += 60;
			if (text.includes("filter") || text.includes("筛选") || text.includes("过滤")) score += 50;
			if (text.includes("graph-controls")) score += 40;
			if (text.includes("search-input-container")) score += 25;
			if (input.type === "search") score += 10;

			return score;
		};

		candidates.sort((a, b) => scoreInput(b) - scoreInput(a));

		return candidates[0];
	}

	tryOpenGraphControls(graphLeaf) {
		const container = this.getGraphLeafContainer(graphLeaf);
		if (!(container instanceof HTMLElement)) return false;

		const controlsButton = Array.from(
			container.querySelectorAll("button, .clickable-icon")
		).find((element) => {
			const label = [
				element.getAttribute("aria-label"),
				element.getAttribute("title"),
				element.textContent,
				element.className,
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();

			return /setting|filter|control|option|设置|筛选|过滤/.test(label);
		});

		if (!(controlsButton instanceof HTMLElement)) return false;

		try {
			controlsButton.click();
			return true;
		} catch (_) {
			return false;
		}
	}

	getGraphLeafContainer(graphLeaf) {
		return (
			(graphLeaf && graphLeaf.containerEl) ||
			(graphLeaf && graphLeaf.view && graphLeaf.view.containerEl) ||
			null
		);
	}

	refreshGraphView(graphLeaf) {
		const view = graphLeaf && graphLeaf.view;
		const targets = [view, view && view.renderer, view && view.graph, view && view.dataEngine];

		for (const target of targets) {
			if (!target) continue;

			for (const methodName of [
				"refresh",
				"render",
				"update",
				"updateSearch",
				"restart",
				"requestData",
				"requestSave",
				"onOptionsChange",
			]) {
				if (typeof target[methodName] !== "function") continue;

				try {
					target[methodName]();
				} catch (_) {}
			}
		}
	}

	async getOrCreatePaperRelationGraphLeaf(anchorLeaf) {
		const reusableLeaf = this.getReusablePaperRelationGraphLeaf();

		if (reusableLeaf) {
			return reusableLeaf;
		}

		const graphLeaf = this.createPaperRelationGraphLeaf(anchorLeaf);

		this.paperRelationGraphLeaf = graphLeaf;
		this.markPaperRelationGraphLeaf(graphLeaf);

		return graphLeaf;
	}

	createPaperRelationGraphLeaf(anchorLeaf) {
		if (
			this.app.workspace.createLeafBySplit &&
			typeof this.app.workspace.createLeafBySplit === "function"
		) {
			return this.app.workspace.createLeafBySplit(
				anchorLeaf,
				"vertical",
				false
			);
		}

		try {
			return this.app.workspace.getLeaf("split", "vertical");
		} catch (_) {
			return this.app.workspace.getLeaf(true);
		}
	}

	getReusablePaperRelationGraphLeaf() {
		if (this.isUsablePaperRelationGraphLeaf(this.paperRelationGraphLeaf)) {
			return this.paperRelationGraphLeaf;
		}

		const leaves =
			typeof this.app.workspace.getLeavesOfType === "function"
				? this.app.workspace.getLeavesOfType("graph")
				: [];

		const markedLeaf = leaves.find((leaf) => {
			return this.isMarkedPaperRelationGraphLeaf(leaf);
		});

		if (this.isUsablePaperRelationGraphLeaf(markedLeaf)) {
			this.paperRelationGraphLeaf = markedLeaf;
			return markedLeaf;
		}

		this.paperRelationGraphLeaf = null;

		return null;
	}

	isUsablePaperRelationGraphLeaf(leaf) {
		if (!leaf) return false;

		if (!this.isMarkedPaperRelationGraphLeaf(leaf)) {
			return false;
		}

		return this.isUsableGlobalGraphLeaf(leaf);
	}

	isUsableGlobalGraphLeaf(leaf) {
		if (!leaf) return false;

		try {
			const state =
				typeof leaf.getViewState === "function" ? leaf.getViewState() : null;

			const viewType =
				state && state.type
					? state.type
					: leaf.view && typeof leaf.view.getViewType === "function"
						? leaf.view.getViewType()
						: null;

			if (viewType !== "graph") {
				return false;
			}

			const container = leaf.containerEl;

			if (container instanceof HTMLElement && !container.isConnected) {
				return false;
			}

			return true;
		} catch (_) {
			return false;
		}
	}

	markPaperRelationGraphLeaf(leaf) {
		if (!leaf) return;

		leaf.paperOrganizationGraphPane = true;

		const container = leaf.containerEl;

		if (container instanceof HTMLElement) {
			container.dataset.paperOrganizationGraphPane = "true";
			container.addClass("paper-organization-relation-graph-pane");
		}

		const tabsEl = this.getLeafTabsElement(leaf);

		if (tabsEl instanceof HTMLElement) {
			tabsEl.dataset.paperOrganizationGraphPane = "true";
			tabsEl.addClass("paper-organization-relation-graph-tabs");
		}
	}

	isMarkedPaperRelationGraphLeaf(leaf) {
		if (!leaf) return false;

		if (leaf.paperOrganizationGraphPane === true) {
			return true;
		}

		const container = leaf.containerEl;

		if (
			container instanceof HTMLElement &&
			container.dataset.paperOrganizationGraphPane === "true"
		) {
			return true;
		}

		const tabsEl = this.getLeafTabsElement(leaf);

		if (
			tabsEl instanceof HTMLElement &&
			tabsEl.dataset.paperOrganizationGraphPane === "true"
		) {
			return true;
		}

		return false;
	}

	setSplitRatio(leftLeaf, rightLeaf, leftRatio = 2, rightRatio = 1) {
		if (!leftLeaf || !rightLeaf) return false;

		const leftItem = leftLeaf.parent || leftLeaf;
		const rightItem = rightLeaf.parent || rightLeaf;

		let applied = false;

		const areWorkspaceSiblings =
			leftItem &&
			rightItem &&
			leftItem.parent &&
			leftItem.parent === rightItem.parent;

		if (
			areWorkspaceSiblings &&
			typeof leftItem.setDimension === "function" &&
			typeof rightItem.setDimension === "function"
		) {
			leftItem.setDimension(leftRatio);
			rightItem.setDimension(rightRatio);
			applied = true;
		}

		if (!applied) {
			const leftTabsEl = this.getLeafTabsElement(leftLeaf);
			const rightTabsEl = this.getLeafTabsElement(rightLeaf);

			const areDomSiblings =
				leftTabsEl &&
				rightTabsEl &&
				leftTabsEl.parentElement &&
				leftTabsEl.parentElement === rightTabsEl.parentElement;

			if (areDomSiblings) {
				const leftApplied = this.setElementFlexGrow(leftTabsEl, leftRatio);
				const rightApplied = this.setElementFlexGrow(rightTabsEl, rightRatio);

				applied = leftApplied && rightApplied;
			}
		}

		this.triggerLeafResize(leftLeaf);
		this.triggerLeafResize(rightLeaf);

		try {
			this.app.workspace.trigger("resize");
		} catch (_) {}

		return applied;
	}

	setElementFlexGrow(element, grow) {
		if (!(element instanceof HTMLElement)) return false;

		element.style.flexGrow = String(grow);
		element.style.flexBasis = "0";
		element.style.minWidth = "0";

		return true;
	}

	getLeafTabsElement(leaf) {
		if (!leaf) return null;

		const directContainer = leaf.containerEl;

		if (directContainer instanceof HTMLElement) {
			const tabs = directContainer.closest(".workspace-tabs");

			if (tabs instanceof HTMLElement) {
				return tabs;
			}

			return directContainer;
		}

		const viewContainer = leaf.view && leaf.view.containerEl;

		if (viewContainer instanceof HTMLElement) {
			const tabs = viewContainer.closest(".workspace-tabs");

			if (tabs instanceof HTMLElement) {
				return tabs;
			}

			const leafEl = viewContainer.closest(".workspace-leaf");

			if (leafEl instanceof HTMLElement) {
				const parentTabs = leafEl.closest(".workspace-tabs");

				if (parentTabs instanceof HTMLElement) {
					return parentTabs;
				}

				return leafEl;
			}
		}

		return null;
	}

	triggerLeafResize(leaf) {
		try {
			if (leaf && typeof leaf.onResize === "function") {
				leaf.onResize();
			}
		} catch (_) {}
	}

	setActiveLeafSafely(leaf) {
		try {
			this.app.workspace.setActiveLeaf(leaf, {
				focus: true,
			});
		} catch (_) {
			try {
				this.app.workspace.setActiveLeaf(leaf, true, true);
			} catch (error) {
				console.warn("treasure-hub: failed to set active leaf", error);
			}
		}
	}

	async openPdf(paper) {
		if (paper.pdf) {
			const target = extractObsidianLinkTarget(paper.pdf);
			const normalizedTarget = normalizePath(target);

			let pdfFile = this.app.metadataCache.getFirstLinkpathDest(
				normalizedTarget,
				paper.path
			);

			if (!pdfFile) {
				const abstractFile =
					this.app.vault.getAbstractFileByPath(normalizedTarget);

				if (abstractFile instanceof TFile) {
					pdfFile = abstractFile;
				}
			}

			if (pdfFile instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(true);
				await leaf.openFile(pdfFile);
				return;
			}

			new Notice("Local PDF file not found.");
			return;
		}

		if (paper.pdfUrl) {
			window.open(paper.pdfUrl, "_blank");
			return;
		}

		new Notice("No PDF available.");
	}

	resolvePaperImage(paper) {
		const raw = normalizeWhitespace(asFirstString(paper && paper.image));

		if (!raw) {
			return null;
		}

		const target = extractImageLinkTarget(raw);

		if (!target) {
			return null;
		}

		if (/^(https?:\/\/|data:image\/|app:\/\/)/i.test(target)) {
			return {
				raw,
				target,
				src: target,
				file: null,
				label: target,
			};
		}

		const cleanTarget = normalizePath(
			decodeUriSafe(target.split("#")[0]).replace(/^\/+/, "")
		);

		let imageFile = this.app.metadataCache.getFirstLinkpathDest(
			cleanTarget,
			paper.path
		);

		if (!(imageFile instanceof TFile)) {
			const abstractFile = this.app.vault.getAbstractFileByPath(cleanTarget);

			if (abstractFile instanceof TFile) {
				imageFile = abstractFile;
			}
		}

		if (imageFile instanceof TFile) {
			return {
				raw,
				target: cleanTarget,
				src: this.app.vault.getResourcePath(imageFile),
				file: imageFile,
				label: imageFile.path,
			};
		}

		return null;
	}

	previewPaperImage(paper) {
		const imageInfo = this.resolvePaperImage(paper);

		if (!imageInfo || !imageInfo.src) {
			new Notice("Image not found or image link cannot be resolved.");
			return;
		}

		new PaperImagePreviewModal(this.app, paper, imageInfo).open();
	}

	async setReadStatus(paper, read, options = {}) {
		if (!paper || !paper.file) return;

		const shouldRefreshDashboards = options.refreshDashboards !== false;

		if (!shouldRefreshDashboards) {
			this.suppressDashboardRefresh();
		}

		await this.app.fileManager.processFrontMatter(paper.file, (frontmatter) => {
			frontmatter.read = !!read;
		});

		new Notice(read ? "Marked as read." : "Marked as unread.");

		if (shouldRefreshDashboards) {
			await this.refreshOpenDashboards();
		} else {
			this.suppressDashboardRefresh();
			this.updateOpenDashboardsReadStatus(paper, !!read);
		}
	}

	async markAsRead(paper) {
		await this.setReadStatus(paper, true);
	}

	async deletePaper(paper, options = {}) {
		if (!paper || !(paper.file instanceof TFile)) {
			new Notice("Paper note not found.");
			return false;
		}

		const file = paper.file;
		const path = file.path;
		const title = paper.title || file.basename || "paper note";
		const shouldRefreshDashboards = options.refreshDashboards !== false;

		if (!shouldRefreshDashboards) {
			this.suppressDashboardRefresh();
		}

		try {
			if (
				this.app.fileManager &&
				typeof this.app.fileManager.trashFile === "function"
			) {
				await this.app.fileManager.trashFile(file);
			} else if (this.app.vault && typeof this.app.vault.trash === "function") {
				await this.app.vault.trash(file, true);
			} else {
				await this.app.vault.delete(file);
			}

			new Notice(`Deleted paper note: ${title}`);

			if (shouldRefreshDashboards) {
				await this.refreshOpenDashboards();
			} else {
				this.suppressDashboardRefresh();
				this.updateOpenDashboardsPaperDeleted(path);
			}

			return true;
		} catch (error) {
			console.error("treasure-hub: failed to delete paper", error);
			new Notice(
				`Failed to delete paper note: ${
					error && error.message ? error.message : String(error)
				}`
			);
			return false;
		}
	}
};

class PaperDashboardView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;

		this.page = PAGE_DASHBOARD;

		this.papers = [];
		this.paperByPath = new Map();

		this.authorIndex = new Map();
		this.keywordIndex = new Map();
		this.authorLabels = new Map();
		this.keywordLabels = new Map();

		this.filteredPapers = [];

			this.state = {
				selectedAuthors: [],
				authorMatchMode: "any",
				selectedKeywords: [],
				keywordMatchMode: "any",
				searchText: "",
				searchType: DEFAULT_PAPER_SEARCH_TYPE,
				searchTokens: [],
				appliedSearchTokens: [],
				status: "all",
				sortBy: "imported-desc",
				filtersCollapsed: true,
			};

		this.searchTimer = null;

		this.resultCountEl = null;
		this.activeFiltersEl = null;
		this.clearFiltersButtonEl = null;
		this.filterChromeUpdaters = [];

			this.filtersContainerEl = null;
			this.filtersBodyEl = null;
			this.filterToggleButtonEl = null;
			this.filterTitleEl = null;
			this.filterTitleLabelEl = null;
			this.filterSummaryEl = null;
			this.searchTokenInputEl = null;

		this.libraryCardsEl = null;
		this.libraryEmptyStateEl = null;

		this.pageTransitionClass = "paper-dashboard-transition-initial";
	}

	getViewType() {
		return VIEW_TYPE_PAPER_DASHBOARD;
	}

	getDisplayText() {
		return this.page === PAGE_LIBRARY
			? "Paper Library"
			: "Treasure Hub Dashboard";
	}

	getIcon() {
		return "library";
	}

	getState() {
		return {
			page: this.page,
		};
	}

	async setState(state, result) {
		if (state && typeof state.page === "string") {
			this.page = state.page === PAGE_LIBRARY ? PAGE_LIBRARY : PAGE_DASHBOARD;
		}

		if (super.setState) {
			await super.setState(state, result);
		}
	}

	async setPage(page) {
		const nextPage = page === PAGE_LIBRARY ? PAGE_LIBRARY : PAGE_DASHBOARD;

		if (this.page === nextPage) {
			this.pageTransitionClass = "paper-dashboard-transition-refresh";
			this.render();
			return;
		}

		this.pageTransitionClass =
			nextPage === PAGE_LIBRARY
				? "paper-dashboard-transition-to-library"
				: "paper-dashboard-transition-to-dashboard";

		this.page = nextPage;
		this.render();
	}

	async onOpen() {
		this.contentEl.addClass("paper-organization-dashboard-view");
		this.pageTransitionClass = "paper-dashboard-transition-initial";
		await this.refreshDataAndRender();
	}

	async onClose() {
		if (this.searchTimer) {
			window.clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}
	}

	async refreshDataAndRender() {
		this.papers = this.plugin.getPaperItems();
		this.paperByPath = new Map(this.papers.map((paper) => [paper.path, paper]));

		this.buildIndexes();
		this.removeInvalidFilterSelections();
		this.applyFilters();
		this.render();
	}

	buildIndexes() {
		this.authorIndex = new Map();
		this.keywordIndex = new Map();
		this.authorLabels = new Map();
		this.keywordLabels = new Map();

		for (const paper of this.papers) {
			for (const author of paper.authors) {
				const key = normalizeForSearch(author);
				if (!key) continue;

				if (!this.authorIndex.has(key)) {
					this.authorIndex.set(key, new Set());
					this.authorLabels.set(key, author);
				}

				this.authorIndex.get(key).add(paper.path);
			}

			for (const keyword of paper.keywords) {
				const key = normalizeForSearch(keyword);
				if (!key) continue;

				if (!this.keywordIndex.has(key)) {
					this.keywordIndex.set(key, new Set());
					this.keywordLabels.set(key, keyword);
				}

				this.keywordIndex.get(key).add(paper.path);
			}
		}
	}

		removeInvalidFilterSelections() {
			this.state.selectedAuthors = this.state.selectedAuthors.filter((author) =>
				this.authorIndex.has(author)
			);

			this.state.selectedKeywords = this.state.selectedKeywords.filter((keyword) =>
				this.keywordIndex.has(keyword)
			);

			this.state.searchType = this.getSearchTypeDefinition(
				this.state.searchType
			).value;

			this.state.searchTokens = Array.isArray(this.state.searchTokens)
				? this.state.searchTokens
						.map((token) => this.normalizeSearchToken(token))
						.filter((token) => token.text)
				: [];

			this.state.appliedSearchTokens = Array.isArray(
				this.state.appliedSearchTokens
			)
				? this.state.appliedSearchTokens
						.map((token) => this.normalizeSearchToken(token))
						.filter((token) => token.text)
				: [];
		}

		normalizeSearchToken(token) {
			const type = this.getSearchTypeDefinition(token && token.type).value;
			const text = normalizeWhitespace(token && token.text);
			const id =
				token && token.id
					? String(token.id)
					: this.getSearchTokenId(type, text);

			return {
				id,
				type,
				text,
			};
		}

		getSearchTokenId(type, text) {
			const normalizedType = this.getSearchTypeDefinition(type).value;
			const normalizedText = normalizeForSearch(text);
			return `${normalizedType}:${normalizedText}`;
		}

	render() {
		const { contentEl } = this;
		contentEl.empty();

		this.resultCountEl = null;
		this.activeFiltersEl = null;
		this.clearFiltersButtonEl = null;
		this.filterChromeUpdaters = [];

			this.filtersContainerEl = null;
			this.filtersBodyEl = null;
			this.filterToggleButtonEl = null;
			this.filterTitleEl = null;
			this.filterTitleLabelEl = null;
			this.filterSummaryEl = null;
			this.searchTokenInputEl = null;

		this.libraryCardsEl = null;
		this.libraryEmptyStateEl = null;

		const transitionClass =
			this.pageTransitionClass || "paper-dashboard-transition-initial";

		const root = contentEl.createDiv({
			cls: `paper-dashboard paper-dashboard-page-${this.page} ${transitionClass}`,
		});

		if (this.plugin && !this.plugin.isOriginalStyleActive()) {
			root.addClass("paper-dashboard-custom-style-active");
			root.dataset.paperActiveStyle = "custom";
		} else {
			root.dataset.paperActiveStyle = "original";
		}

		this.renderPageHeader(root);

		if (this.page === PAGE_LIBRARY) {
			this.renderPaperLibrary(root);
			this.renderFilteredResults();
			this.updateFilterChrome();
		}

		this.decorateAnimatedElements(root);
	}

	decorateAnimatedElements(root) {
		if (!(root instanceof HTMLElement)) return;

		const targets = Array.from(
			root.querySelectorAll(
				".paper-page-header, .paper-dashboard-section, .paper-library-card"
			)
		);

		targets.forEach((element, index) => {
			if (!(element instanceof HTMLElement)) return;

			element.addClass("paper-dashboard-reveal-item");
			element.style.setProperty(
				"--paper-reveal-delay",
				`${Math.min(index * 70, 560)}ms`
			);
		});
	}

	renderPageHeader(root) {
		const header = root.createDiv({
			cls: "paper-page-header",
		});

		const titleWrap = header.createDiv({
			cls: "paper-page-title-wrap",
		});

		const title = titleWrap.createEl("h1", {
			text:
				this.page === PAGE_LIBRARY
					? "Paper Library"
					: "Treasure Hub",
			cls: "paper-dashboard-title",
		});

		if (this.page === PAGE_LIBRARY) {
			const backButton = header.createEl("button", {
				cls: "paper-page-back-button",
			});

			backButton.type = "button";
			backButton.setAttribute("aria-label", "Back to dashboard");

			backButton.addEventListener("click", async () => {
				await this.setPage(PAGE_DASHBOARD);
			});
		} else {
			title.addClass("is-clickable");
			title.setAttribute("role", "button");
			title.setAttribute("tabindex", "0");
			title.setAttribute("aria-label", "Open Paper Library");
			title.title = "Open Paper Library";

			const openLibrary = async (event) => {
				event.preventDefault();
				event.stopPropagation();
				await this.setPage(PAGE_LIBRARY);
			};

			title.addEventListener("click", openLibrary);
			title.addEventListener("keydown", async (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				await openLibrary(event);
			});
		}
	}

	renderNavigationModule(root) {
		const section = createSection(root, "Navigation");

		const grid = section.createDiv({
			cls: "paper-navigation-grid paper-navigation-grid-home",
		});

		const card = grid.createDiv({
			cls: "paper-navigation-card is-highlight",
		});

		card.createDiv({
			text: "📚",
			cls: "paper-navigation-icon",
		});

		const body = card.createDiv({
			cls: "paper-navigation-body",
		});

		body.createDiv({
			text: "Paper Library",
			cls: "paper-navigation-title",
		});

		body.createDiv({
			text: "View complete paper records with full metadata.",
			cls: "paper-navigation-desc",
		});

		const button = card.createEl("button", {
			text: "Open",
			cls: "paper-navigation-button",
		});

		button.addEventListener("click", async () => {
			await this.setPage(PAGE_LIBRARY);
		});

		card.addEventListener("dblclick", async () => {
			await this.setPage(PAGE_LIBRARY);
		});
	}

	renderQuickImport(root) {
		const section = createSection(root, "Quick Import");

		const form = section.createDiv({
			cls: "paper-dashboard-import-form",
		});

		const inputWrap = form.createDiv({
			cls: "paper-dashboard-field paper-dashboard-import-input-wrap",
		});

		inputWrap.createEl("label", {
			text: "Paper URL",
			cls: "paper-dashboard-label",
		});

		const input = inputWrap.createEl("input", {
			cls: "paper-dashboard-text-input",
		});

		input.type = "text";
		input.placeholder = "Paste paper PDF URL";

		const controls = form.createDiv({
			cls: "paper-dashboard-import-controls",
		});

		const checkboxLabel = controls.createEl("label", {
			cls: "paper-dashboard-checkbox-label",
		});

		const checkbox = checkboxLabel.createEl("input");
		checkbox.type = "checkbox";

		checkboxLabel.createSpan({
			text: "Download PDF locally",
		});

		const button = controls.createEl("button", {
			text: "Import Paper",
			cls: "mod-cta",
		});

		button.addEventListener("click", async () => {
			const url = String(input.value || "").trim();

			if (!url) {
				new Notice("Please enter a paper PDF URL.");
				return;
			}

			try {
				button.disabled = true;
				button.setText("Importing paper...");

				await this.plugin.importPaper(url, checkbox.checked);

				input.value = "";
				checkbox.checked = false;

				await this.refreshDataAndRender();
			} catch (error) {
				console.error("treasure-hub: failed to import paper", error);

				new Notice(
					`Paper import failed: ${
						error && error.message ? error.message : String(error)
					}`
				);
			} finally {
				button.disabled = false;
				button.setText("Import Paper");
			}
		});
	}

	renderOverview(root) {
		const section = createSection(root, "Overview");

		const total = this.papers.length;
		const unread = this.papers.filter((paper) => !paper.read).length;
		const read = this.papers.filter((paper) => paper.read).length;
		const localPdfs = this.papers.filter(
			(paper) => paper.pdfStatus === "Local"
		).length;
		const externalPdfs = this.papers.filter(
			(paper) => paper.pdfStatus === "External"
		).length;

		const grid = section.createDiv({
			cls: "paper-dashboard-stat-grid",
		});

		createStatCard(grid, "Total Papers", total);
		createStatCard(grid, "Unread", unread);
		createStatCard(grid, "Read", read);
		createStatCard(grid, "Local PDFs", localPdfs);
		createStatCard(grid, "External PDFs", externalPdfs);
	}

	renderPaperLibrary(root) {
		const section = createSection(root, "Paper Library", {
			showTitle: false,
		});

		this.renderFilters(section);
		this.renderPaperLibraryList(section);
	}

	renderFilters(section) {
		this.filterChromeUpdaters = [];

		const filters = section.createDiv({
			cls: "paper-dashboard-filters has-no-active-filters",
		});

		this.filtersContainerEl = filters;

		const filterHeader = filters.createDiv({
			cls: "paper-dashboard-filter-header",
		});

		const filterHeaderMain = filterHeader.createDiv({
			cls: "paper-dashboard-filter-header-main",
		});

		this.filterTitleEl = filterHeaderMain.createDiv({
			cls: "paper-dashboard-filter-title",
		});

		this.filterTitleLabelEl = this.filterTitleEl.createSpan({
			text: "Filters",
			cls: "paper-dashboard-filter-title-label",
		});

		this.filterSummaryEl = this.filterTitleEl.createSpan({
			cls: "paper-dashboard-filter-title-summary",
		});

		filters.addEventListener("mouseenter", () => {
			this.state.filtersCollapsed = false;
			this.updateFilterChrome();
		});

		filters.addEventListener("mouseleave", () => {
			this.state.filtersCollapsed = true;
			this.updateFilterChrome();
		});

		filters.addEventListener("focusin", () => {
			this.state.filtersCollapsed = false;
			this.updateFilterChrome();
		});

		filters.addEventListener("focusout", () => {
			window.setTimeout(() => {
				if (!filters.matches(":hover") && !filters.contains(document.activeElement)) {
					this.state.filtersCollapsed = true;
					this.updateFilterChrome();
				}
			}, 0);
		});

		this.filtersBodyEl = filters.createDiv({
			cls: "paper-dashboard-filter-body",
		});

		const toolbar = this.filtersBodyEl.createDiv({
			cls: "paper-dashboard-filter-toolbar",
		});

		this.renderSearchFilter(toolbar);
		this.renderStatusFilter(toolbar);

		this.activeFiltersEl = this.filtersBodyEl.createDiv({
			cls: "paper-dashboard-active-filters",
		});

		this.filterChromeUpdaters.push(() => {
			this.updateFiltersCollapsedState();
		});

		this.updateActiveFilterChips();
		this.updateFilterSummary();
		this.updateFilterChrome();
	}

	updateFiltersCollapsedState() {
		const collapsed = !!this.state.filtersCollapsed;

		if (this.filtersContainerEl) {
			this.filtersContainerEl.toggleClass("is-collapsed", collapsed);
		}

		if (this.filtersBodyEl) {
			this.filtersBodyEl.style.display = "";
			this.filtersBodyEl.setAttribute(
				"aria-hidden",
				collapsed ? "true" : "false"
			);
		}

		if (this.filterToggleButtonEl) {
			this.filterToggleButtonEl.setAttribute(
				"aria-expanded",
				collapsed ? "false" : "true"
			);
		}
	}

	getSearchTypeDefinition(type) {
		return (
			PAPER_SEARCH_TYPES.find((option) => option.value === type) ||
			PAPER_SEARCH_TYPES[0]
		);
	}

	getSearchTypeLabel(type) {
		return this.getSearchTypeDefinition(type).label;
	}

	renderSearchFilter(parent) {
		const field = parent.createDiv({
			cls: "paper-dashboard-filter-field paper-dashboard-search-field",
		});

		const builder = field.createDiv({
			cls: "paper-dashboard-search-builder",
		});

		const wrap = builder.createDiv({
			cls: "paper-dashboard-filter-search-wrap paper-dashboard-search-input-wrap paper-dashboard-search-type-control",
		});

		const typeBadge = wrap.createSpan({
			cls: "paper-dashboard-search-type-badge",
		});

		const searchInput = wrap.createEl("input", {
			cls: "paper-dashboard-text-input paper-dashboard-filter-search-input",
		});

		searchInput.type = "text";
		searchInput.setAttribute("aria-label", "Search term");
		this.searchTokenInputEl = searchInput;

		this.clearFiltersButtonEl = wrap.createEl("button", {
			cls: "paper-dashboard-search-clear-button",
		});

		this.clearFiltersButtonEl.type = "button";
		this.clearFiltersButtonEl.setAttribute("aria-label", "Clear filters");
		this.clearFiltersButtonEl.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.clearAllFilters();
			searchInput.focus();
		});

		const typeMenu = wrap.createDiv({
			cls: "paper-dashboard-search-type-menu",
		});

		typeMenu.setAttribute("role", "listbox");
		typeMenu.setAttribute("aria-label", "Search field");

		const typeOptions = [];

		for (const optionConfig of PAPER_SEARCH_TYPES) {
			const option = typeMenu.createEl("button", {
				text: optionConfig.label,
				cls: "paper-dashboard-search-type-option",
			});

			option.type = "button";
			option.setAttribute("role", "option");
			option.setAttribute("data-value", optionConfig.value);

			option.addEventListener("click", () => {
				this.state.searchType = optionConfig.value;
				setTypeOpen(false);
				updateSearchControl();
				searchInput.focus();
			});

			typeOptions.push(option);
		}

		const getDraftSearchTokens = () =>
			Array.isArray(this.state.searchTokens) ? this.state.searchTokens : [];

		const commitSearchInput = () => {
			const text = normalizeWhitespace(searchInput.value);
			if (!text) {
				updateSearchControl();
				searchInput.focus();
				return false;
			}

			const type = this.getSearchTypeDefinition(this.state.searchType).value;
			const normalizedText = normalizeForSearch(text);
			const id = this.getSearchTokenId(type, text);
			const exists = getDraftSearchTokens().some(
				(token) =>
					(token.id && String(token.id) === id) ||
					(this.getSearchTypeDefinition(token.type).value === type &&
						normalizeForSearch(token.text) === normalizedText)
			);

			if (!exists) {
				this.state.searchTokens = [
					...getDraftSearchTokens(),
					{
						id,
						type,
						text,
					},
				];
			}

			searchInput.value = "";
			this.updateFilterChrome();
			updateSearchControl();
			searchInput.focus();
			return true;
		};

			const applyDraftSearch = () => {
				commitSearchInput();
				this.state.appliedSearchTokens = getDraftSearchTokens()
					.map((token) => this.normalizeSearchToken(token))
					.filter((token) => token.text);
				this.onFiltersChanged();
				searchInput.focus();
			};

		const cycleSearchType = (direction) => {
			const activeType = this.getSearchTypeDefinition(this.state.searchType).value;
			const activeIndex = PAPER_SEARCH_TYPES.findIndex(
				(option) => option.value === activeType
			);
			const nextIndex =
				(activeIndex + direction + PAPER_SEARCH_TYPES.length) %
				PAPER_SEARCH_TYPES.length;

			this.state.searchType = PAPER_SEARCH_TYPES[nextIndex].value;
			updateSearchControl();
		};

		const updateSearchControl = () => {
			const activeType = this.getSearchTypeDefinition(this.state.searchType);
			typeBadge.setText(activeType.label);

			for (const option of typeOptions) {
				const isActive = option.getAttribute("data-value") === activeType.value;
				option.classList.toggle("is-active", isActive);
				option.setAttribute("aria-selected", isActive ? "true" : "false");
			}

				const hasSearchInput = normalizeWhitespace(searchInput.value) !== "";
				wrap.toggleClass("has-search-input", hasSearchInput);
			};

			const setTypeOpen = (open) => {
				wrap.classList.toggle("is-open", open);
				searchInput.setAttribute("aria-expanded", open ? "true" : "false");

				if (open) {
					this.state.filtersCollapsed = false;
					this.updateFilterChrome();
					updateSearchControl();
				}
			};

		searchInput.setAttribute("aria-haspopup", "listbox");
		searchInput.setAttribute("aria-expanded", "false");

		searchInput.addEventListener("input", () => {
			updateSearchControl();
			this.updateFilterChrome();
		});

		searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Tab") {
				event.preventDefault();
				setTypeOpen(!wrap.classList.contains("is-open"));
				return;
			}

			if (event.key === "Escape") {
				setTypeOpen(false);
				return;
			}

			if (wrap.classList.contains("is-open") && event.key === "ArrowDown") {
				event.preventDefault();
				cycleSearchType(1);
				return;
			}

			if (wrap.classList.contains("is-open") && event.key === "ArrowUp") {
				event.preventDefault();
				cycleSearchType(-1);
				return;
			}

			if (event.key === "Enter") {
				event.preventDefault();
				setTypeOpen(false);
				applyDraftSearch();
			}
		});

		wrap.addEventListener("focusout", () => {
			window.setTimeout(() => {
				if (!wrap.contains(document.activeElement)) {
					setTypeOpen(false);
				}
			}, 0);
		});

		this.filterChromeUpdaters.push(updateSearchControl);

		updateSearchControl();
	}

	renderStatusFilter(parent) {
		const field = parent.createDiv({
			cls: "paper-dashboard-filter-field paper-dashboard-status-field",
		});

		const statusButtons = field.createDiv({
			cls: "paper-dashboard-status-group",
		});

		this.createSegmentButton(statusButtons, "Unread", "unread");
		this.createSegmentButton(statusButtons, "Read", "read");

		this.filterChromeUpdaters.push(() => {
			for (const button of Array.from(statusButtons.children)) {
				const value = button.getAttribute("data-value");
				button.toggleClass("is-active", value === this.state.status);
			}

			this.updateSegmentIndicator(statusButtons);
		});

		this.updateSegmentIndicator(statusButtons);
	}

	renderSortFilter(parent, options = {}) {
		const field = parent.createDiv({
			cls: `paper-dashboard-filter-field paper-dashboard-sort-field ${
				options.header ? "paper-dashboard-sort-field-header" : ""
			}`,
		});

		field.createEl("label", {
			text: "Sort by",
			cls: "paper-dashboard-label",
		});

		const sortOptions = [
			["imported-desc", "Imported Time"],
			["modified-desc", "Modified Time"],
			["title-asc", "Title"],
			["read-status", "Read Status"],
		];

		const sortControl = field.createDiv({
			cls: "paper-dashboard-sort-control",
		});

		const sortButton = sortControl.createEl("button", {
			cls: "paper-dashboard-sort-button",
		});

		sortButton.type = "button";
		sortButton.setAttribute("aria-haspopup", "listbox");
		sortButton.setAttribute("aria-expanded", "false");

		const sortButtonLabel = sortButton.createSpan({
			cls: "paper-dashboard-sort-button-label",
		});

		sortButton.createSpan({
			cls: "paper-dashboard-sort-button-chevron",
		});

		const sortMenu = sortControl.createDiv({
			cls: "paper-dashboard-sort-menu",
		});

		sortMenu.setAttribute("role", "listbox");
		sortMenu.setAttribute("aria-label", "Sort by");

		const optionButtons = [];

		for (const [value, label] of sortOptions) {
			const option = sortMenu.createEl("button", {
				text: label,
				cls: "paper-dashboard-sort-option",
			});

			option.type = "button";
			option.setAttribute("role", "option");
			option.setAttribute("data-value", value);

			option.addEventListener("click", () => {
				this.state.sortBy = value;
				setSortOpen(false);
				this.onFiltersChanged();
			});

			optionButtons.push(option);
		}

		const getSortLabel = () => {
			const option = sortOptions.find(([value]) => value === this.state.sortBy);
			return option ? option[1] : this.getSortLabel(this.state.sortBy);
		};

		const updateSortControl = () => {
			sortButtonLabel.setText(getSortLabel());

			for (const option of optionButtons) {
				const isActive = option.getAttribute("data-value") === this.state.sortBy;
				option.classList.toggle("is-active", isActive);
				option.setAttribute("aria-selected", isActive ? "true" : "false");
			}
		};

		const setSortOpen = (open) => {
			sortControl.classList.toggle("is-open", open);
			sortButton.setAttribute("aria-expanded", open ? "true" : "false");

			if (open) {
				updateSortControl();
			}
		};

		sortButton.addEventListener("click", () => {
			setSortOpen(!sortControl.classList.contains("is-open"));
		});

		sortControl.addEventListener("focusout", () => {
			window.setTimeout(() => {
				if (!sortControl.contains(document.activeElement)) {
					setSortOpen(false);
				}
			}, 0);
		});

		sortControl.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				setSortOpen(false);
				sortButton.focus();
				return;
			}

			const focusedIndex = optionButtons.indexOf(document.activeElement);
			const activeIndex = optionButtons.findIndex((option) =>
				option.classList.contains("is-active")
			);

			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSortOpen(true);
				const baseIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
				const target = optionButtons[(baseIndex + 1) % optionButtons.length];
				if (target) target.focus();
				return;
			}

			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSortOpen(true);
				const target =
					focusedIndex > 0
						? optionButtons[focusedIndex - 1]
						: focusedIndex === 0
							? optionButtons[optionButtons.length - 1]
							: activeIndex > 0
								? optionButtons[activeIndex - 1]
						: optionButtons[optionButtons.length - 1];
				if (target) target.focus();
			}
		});

		this.filterChromeUpdaters.push(() => {
			updateSortControl();
		});

		updateSortControl();
	}

	renderFilterActions(parent) {
		const field = parent.createDiv({
			cls: "paper-dashboard-filter-field paper-dashboard-filter-actions",
		});

		const infoWrap = field.createDiv();

		this.resultCountEl = infoWrap.createDiv({
			cls: "paper-dashboard-result-count",
		});

		this.clearFiltersButtonEl = field.createEl("button", {
			text: "Clear filters",
			cls: "paper-dashboard-clear-filters",
		});

		this.clearFiltersButtonEl.addEventListener("click", () => {
			this.clearAllFilters();
		});

		this.updateResultCount();
	}

	renderFacetFilter(parent, config) {
		const card = parent.createDiv({
			cls: "paper-dashboard-filter-card",
		});

		const header = card.createDiv({
			cls: "paper-dashboard-filter-card-header",
		});

		const titleWrap = header.createDiv({
			cls: "paper-dashboard-filter-card-title",
		});

		titleWrap.createDiv({
			text: config.title,
			cls: "paper-dashboard-label",
		});

		const countBadge = titleWrap.createSpan({
			cls: "paper-dashboard-filter-count-badge",
		});

		const clearButton = header.createEl("button", {
			text: "Clear",
			cls: "paper-dashboard-small-button",
		});

		clearButton.addEventListener("click", () => {
			this.state[config.selectedKey] = [];
			this.onFiltersChanged();
		});

		const controls = card.createDiv({
			cls: "paper-dashboard-filter-card-controls",
		});

		const searchWrap = controls.createDiv({
			cls: "paper-dashboard-filter-card-search",
		});

		const optionSearchInput = searchWrap.createEl("input", {
			cls: "paper-dashboard-text-input",
		});

		optionSearchInput.type = "text";

		const matchMode = controls.createDiv({
			cls: "paper-dashboard-status-group paper-dashboard-match-mode",
		});

		const anyButton = matchMode.createEl("button", {
			text: config.anyText,
			cls: "paper-dashboard-match-button",
		});

		const allButton = matchMode.createEl("button", {
			text: config.allText,
			cls: "paper-dashboard-match-button",
		});

		anyButton.addEventListener("click", () => {
			this.state[config.matchModeKey] = "any";
			this.onFiltersChanged();
		});

		allButton.addEventListener("click", () => {
			this.state[config.matchModeKey] = "all";
			this.onFiltersChanged();
		});

		const list = card.createDiv({
			cls: "paper-dashboard-filter-option-list",
		});

		const optionRows = [];
		const checkboxByValue = new Map();

		for (const [key, label] of sortedMapEntries(config.labels)) {
			const row = list.createEl("label", {
				cls: "paper-dashboard-filter-option",
			});

			const checkbox = row.createEl("input");
			checkbox.type = "checkbox";
			checkbox.checked = this.state[config.selectedKey].includes(key);

			row.createSpan({
				text: label,
				cls: "paper-dashboard-filter-option-text",
			});

			const count = config.index.get(key) ? config.index.get(key).size : 0;

			row.createSpan({
				text: String(count),
				cls: "paper-dashboard-filter-option-count",
			});

			checkbox.addEventListener("change", () => {
				const selected = new Set(this.state[config.selectedKey]);

				if (checkbox.checked) {
					selected.add(key);
				} else {
					selected.delete(key);
				}

				this.state[config.selectedKey] = Array.from(selected);
				this.onFiltersChanged();
			});

			optionRows.push({
				key,
				label: normalizeForSearch(label),
				row,
			});

			checkboxByValue.set(key, checkbox);
		}

		const emptySearchResult = list.createDiv({
			text: config.emptyText,
			cls: "paper-dashboard-filter-option-empty",
		});

		const applyOptionSearch = () => {
			const query = normalizeForSearch(optionSearchInput.value);
			let visibleCount = 0;

			for (const item of optionRows) {
				const visible = !query || item.label.includes(query);
				item.row.style.display = visible ? "flex" : "none";
				if (visible) visibleCount += 1;
			}

			emptySearchResult.style.display = visibleCount === 0 ? "block" : "none";
		};

		optionSearchInput.addEventListener("input", applyOptionSearch);
		applyOptionSearch();

		const update = () => {
			const selected = this.state[config.selectedKey] || [];
			const selectedSet = new Set(selected);

			countBadge.setText(String(selected.length));
			countBadge.toggleClass("has-selection", selected.length > 0);

			clearButton.disabled = selected.length === 0;
			clearButton.toggleClass("is-disabled", selected.length === 0);

			for (const [key, checkbox] of checkboxByValue.entries()) {
				checkbox.checked = selectedSet.has(key);
			}

			anyButton.toggleClass(
				"is-active",
				this.state[config.matchModeKey] === "any"
			);

			allButton.toggleClass(
				"is-active",
				this.state[config.matchModeKey] === "all"
			);

			this.updateSegmentIndicator(matchMode);
		};

		this.filterChromeUpdaters.push(update);
		update();
	}

	updateSegmentIndicator(container) {
		if (!container) return;

		const activeButton = container.querySelector("button.is-active");

		if (!activeButton) {
			container.classList.remove("has-segment-indicator");
			return;
		}

		const applyPosition = () => {
			if (!container.isConnected || !activeButton.isConnected) return;

			if (activeButton.offsetWidth <= 0 || activeButton.offsetHeight <= 0) {
				return;
			}

			container.style.setProperty(
				"--paper-segment-indicator-left",
				`${activeButton.offsetLeft}px`
			);
			container.style.setProperty(
				"--paper-segment-indicator-top",
				`${activeButton.offsetTop}px`
			);
			container.style.setProperty(
				"--paper-segment-indicator-width",
				`${activeButton.offsetWidth}px`
			);
			container.style.setProperty(
				"--paper-segment-indicator-height",
				`${activeButton.offsetHeight}px`
			);
			container.classList.add("has-segment-indicator");
		};

		if (window.requestAnimationFrame) {
			window.requestAnimationFrame(applyPosition);
		} else {
			applyPosition();
		}
	}

	createSegmentButton(parent, label, value) {
		const button = parent.createEl("button", {
			text: label,
		});

		button.setAttribute("data-value", value);

		if (this.state.status === value) {
			button.addClass("is-active");
			}

			button.addEventListener("click", () => {
				this.state.status =
					value !== "all" && this.state.status === value ? "all" : value;
				this.onFiltersChanged();
			});
		}

	renderPaperLibraryList(section) {
		const list = section.createDiv({
			cls: "paper-library-list",
		});

		this.libraryEmptyStateEl = list.createDiv({
			cls: "paper-dashboard-empty-state paper-library-empty-state",
		});

		this.libraryCardsEl = list.createDiv({
			cls: "paper-library-card-list",
		});
	}

	onFiltersChanged() {
		this.applyFilters();
		this.updateFilterChrome();
		this.renderFilteredResults();
	}

	renderFilteredResults() {
		if (this.page === PAGE_LIBRARY) {
			this.renderLibraryCards();
		}
	}

	renderLibraryCards() {
		if (!this.libraryCardsEl || !this.libraryEmptyStateEl) return;

		this.updateResultCount();
		this.updateFilterSummary();

		this.libraryCardsEl.empty();

		const total = this.filteredPapers.length;

		if (this.papers.length === 0) {
			this.libraryEmptyStateEl.setText("No papers found.");
			this.libraryEmptyStateEl.style.display = "block";
			return;
		}

		if (total === 0) {
			this.libraryEmptyStateEl.setText("No papers match the current filters.");
			this.libraryEmptyStateEl.style.display = "block";
			return;
		}

		this.libraryEmptyStateEl.style.display = "none";

		for (const paper of this.filteredPapers) {
			this.renderLibraryCard(this.libraryCardsEl, paper);
		}
	}

	renderLibraryCard(parent, paper) {
		const showPaperLibraryImages =
			this.plugin.settings.showPaperLibraryImages !== false;
	
		const card = parent.createDiv({
			cls: `paper-library-card ${paper.read ? "is-read" : "is-unread"} ${
				showPaperLibraryImages ? "is-image-enabled" : "is-image-disabled"
			}`,
		});

		card.dataset.paperPath = paper.path || "";
	
		if (showPaperLibraryImages) {
			this.renderLibraryCardCover(card, paper);
		}
	
		const header = card.createDiv({
			cls: "paper-library-card-header",
		});

		const titleArea = header.createDiv({
			cls: "paper-library-title-area",
		});

		const titleRow = titleArea.createDiv({
			cls: "paper-library-title-row",
		});

		const title = titleRow.createEl("h3", {
			cls: "paper-library-title",
		});

		const titleButton = title.createEl("button", {
			text: paper.title || "Untitled paper",
			cls: "paper-library-title-button",
		});

		titleButton.type = "button";
		titleButton.title = "Open note";
		titleButton.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			await this.plugin.openNote(paper);
		});

		if (paper.pdfStatus !== "External") {
			titleRow.createSpan({
				text: paper.pdfStatus,
				cls: `paper-dashboard-pill ${getPdfStatusPillClass(paper.pdfStatus)}`,
			});
		}

		const meta = titleArea.createDiv({
			cls: "paper-library-meta",
		});

		const firstAuthorText = getFirstAuthorMetaText(paper);
		const affiliationText = getPaperAffiliationMetaText(paper);

		if (firstAuthorText) {
			meta.createSpan({
				text: firstAuthorText,
				cls: "paper-library-author-meta",
			});
		}

		if (affiliationText) {
			meta.createSpan({
				text: affiliationText,
				cls: "paper-library-affiliation-meta",
			});
		}

		if (paper.arxiv) {
			const arxivMeta = meta.createSpan({
				text: `arXiv ${paper.arxiv}`,
				cls: "paper-library-arxiv-meta",
			});

			arxivMeta.title = "Open arXiv";

			arxivMeta.addEventListener("click", () => {
				window.open(`https://arxiv.org/abs/${paper.arxiv}`, "_blank");
			});
		}

			const actions = header.createDiv({
				cls: "paper-library-card-actions",
			});

			this.createReadToggleButton(actions, paper);
			this.createOpenPdfButton(actions, paper);
			this.createOpenGraphButton(actions, paper);
			this.createDeletePaperButton(actions, paper);

		const detail = card.createDiv({
			cls: "paper-library-brief",
		});

		const keywordText =
			Array.isArray(paper.keywords) && paper.keywords.length > 0
				? paper.keywords.filter(Boolean).join(", ")
				: "";

		this.createLibraryInlineDetail(detail, "Key words", keywordText, {
			hideLabel: true,
			valueClass: "paper-library-keyword-value",
		});
		this.createLibraryInlineDetail(detail, "The truth", paper.theTruth);
	}

	renderLibraryCardCover(card, paper) {
		const imageInfo = this.plugin.resolvePaperImage(paper);

		if (!imageInfo || !imageInfo.src) {
			card.createDiv({
				cls: "paper-library-card-cover is-fallback",
			});
			return;
		}

		const cover = card.createEl("button", {
			cls: "paper-library-card-cover has-image",
		});

		cover.type = "button";
		cover.title = "Click to preview image";
		cover.setAttribute(
			"aria-label",
			`Preview image for ${paper.title || "paper"}`
		);

		const img = cover.createEl("img", {
			cls: "paper-library-cover-image",
		});

		img.src = imageInfo.src;
		img.alt = paper.title ? `Image for ${paper.title}` : "Paper image";
		img.loading = "lazy";
		img.decoding = "async";

		img.addEventListener("error", () => {
			cover.empty();
			cover.removeClass("has-image");
			cover.addClass("is-broken");
			cover.createDiv({
				text: "Image unavailable",
				cls: "paper-library-cover-error",
			});
		});

		cover.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.plugin.previewPaperImage(paper);
		});
	}

	createLibraryInlineDetail(parent, label, value, options = {}) {
		const line = parent.createDiv({
			cls: `paper-library-detail-line ${
				options.hideLabel ? "has-hidden-label" : ""
			}`,
		});

		if (!options.hideLabel) {
			line.createEl("strong", {
				text: label,
				cls: "paper-library-detail-label",
			});

			line.appendText(" ");
		}

		const text = String(value || "").trim();

		if (!text) {
			line.remove();
			return null;
		}

		line.createSpan({
			text,
			cls: `paper-library-detail-value ${options.valueClass || ""}`,
		});

		return line;
	}

	updateFilterChrome() {
		this.updateResultCount();
		this.updateActiveFilterChips();
		this.updateFilterSummary();
		this.updateFilterDensityState();

		for (const updater of this.filterChromeUpdaters) {
			try {
				updater();
			} catch (error) {
				console.warn("treasure-hub: filter chrome update failed", error);
			}
		}

		if (this.clearFiltersButtonEl) {
			const hasFilters = this.hasActiveFilters();
			const hasSearchDraft =
				this.searchTokenInputEl &&
				normalizeWhitespace(this.searchTokenInputEl.value) !== "";
			const canClear = hasFilters || hasSearchDraft;
			this.clearFiltersButtonEl.disabled = !canClear;
			this.clearFiltersButtonEl.toggleClass("is-muted", !canClear);
		}
	}

	updateFilterDensityState() {
		if (!this.filtersContainerEl) return;

		const hasFilters = this.hasActiveFilters();

		this.filtersContainerEl.toggleClass("has-active-filters", hasFilters);
		this.filtersContainerEl.toggleClass("has-no-active-filters", !hasFilters);
		this.filtersContainerEl.setAttribute(
			"data-has-active-filters",
			hasFilters ? "true" : "false"
		);
	}

	getActiveFilterLabels() {
		const labels = [];
		const seenTokenIds = new Set();

		const appendSearchToken = (token) => {
			const normalizedToken = this.normalizeSearchToken(token);
			if (!normalizedToken.text || seenTokenIds.has(normalizedToken.id)) {
				return;
			}

			seenTokenIds.add(normalizedToken.id);
			labels.push(`${this.getSearchTypeLabel(normalizedToken.type)}: ${normalizedToken.text}`);
		};

		const draftSearchTokens = Array.isArray(this.state.searchTokens)
			? this.state.searchTokens
			: [];

		const appliedSearchTokens = Array.isArray(this.state.appliedSearchTokens)
			? this.state.appliedSearchTokens
			: [];

		for (const token of draftSearchTokens) {
			appendSearchToken(token);
		}

		for (const token of appliedSearchTokens) {
			appendSearchToken(token);
		}

		if (this.state.status !== "all") {
			labels.push(`Status: ${this.state.status === "read" ? "Read" : "Unread"}`);
		}

		return labels;
	}

	updateFilterSummary() {
		if (!this.filterSummaryEl) return;

		const labels = this.getActiveFilterLabels();
		const summary = labels.join(" · ");

		this.filterSummaryEl.setText(summary ? `| ${summary}` : "");
		this.filterSummaryEl.toggleClass("is-empty", !summary);
		this.filterSummaryEl.title = summary;

		if (this.filtersContainerEl) {
			this.filtersContainerEl.toggleClass("has-filter-summary", !!summary);
			this.filtersContainerEl.setAttribute("data-filter-summary", summary);
		}
	}

	getSortLabel(sortBy) {
		const labels = {
			"imported-desc": "Imported Time",
			"modified-desc": "Modified Time",
			"title-asc": "Title",
			"read-status": "Read Status",
		};

		return labels[sortBy] || sortBy || "Imported Time";
	}

	hasActiveFilters() {
		const searchTokens = Array.isArray(this.state.searchTokens)
			? this.state.searchTokens
			: [];
		const appliedSearchTokens = Array.isArray(this.state.appliedSearchTokens)
			? this.state.appliedSearchTokens
			: [];

		return (
			searchTokens.some(
				(token) => normalizeWhitespace(token && token.text) !== ""
			) ||
			appliedSearchTokens.some(
				(token) => normalizeWhitespace(token && token.text) !== ""
			) ||
			this.state.status !== "all"
		);
	}

	clearAllFilters() {
		this.state.selectedAuthors = [];
		this.state.authorMatchMode = "any";
		this.state.selectedKeywords = [];
		this.state.keywordMatchMode = "any";
		this.state.searchText = "";
		this.state.searchTokens = [];
		this.state.appliedSearchTokens = [];
		this.state.searchType = DEFAULT_PAPER_SEARCH_TYPE;
		this.state.status = "all";
		this.state.sortBy = "imported-desc";

		if (this.searchTokenInputEl) {
			this.searchTokenInputEl.value = "";
		}

		this.onFiltersChanged();
	}

	updateActiveFilterChips() {
		if (!this.activeFiltersEl) return;

		this.activeFiltersEl.empty();

		if (!this.hasActiveFilters()) {
			this.activeFiltersEl.style.display = "none";
			return;
		}

		this.activeFiltersEl.style.display = "";

		const searchTokens = Array.isArray(this.state.searchTokens)
			? this.state.searchTokens
			: [];

		for (const [index, token] of searchTokens.entries()) {
			const text = normalizeWhitespace(token && token.text);
			if (!text) continue;
			const tokenId = this.normalizeSearchToken(token).id;

			this.createFilterChip(
				this.activeFiltersEl,
				`${this.getSearchTypeLabel(token.type)}: ${text}`,
				() => {
					this.state.searchTokens = this.state.searchTokens.filter(
						(draftToken, tokenIndex) =>
							tokenIndex !== index &&
							this.normalizeSearchToken(draftToken).id !== tokenId
					);
					this.state.appliedSearchTokens = (
						Array.isArray(this.state.appliedSearchTokens)
							? this.state.appliedSearchTokens
							: []
					).filter(
						(appliedToken) => this.normalizeSearchToken(appliedToken).id !== tokenId
					);
					this.onFiltersChanged();
				},
				{
					tokenId,
				}
			);
		}

		if (this.state.status !== "all") {
			this.createFilterChip(
				this.activeFiltersEl,
				`Status: ${this.state.status === "read" ? "Read" : "Unread"}`,
				() => {
					this.state.status = "all";
					this.onFiltersChanged();
				}
			);
		}
	}

	createFilterChip(parent, text, onRemove, options = {}) {
		const chip = parent.createSpan({
			cls: "paper-dashboard-filter-chip",
		});

		if (options.tokenId) {
			chip.setAttribute("data-filter-token-id", options.tokenId);
		}

		chip.createSpan({
			text,
			cls: "paper-dashboard-filter-chip-text",
		});

		const removeButton = chip.createEl("button", {
			text: "×",
			cls: "paper-dashboard-filter-chip-remove",
		});

		removeButton.type = "button";
		removeButton.title = "Remove filter";
		removeButton.setAttribute("aria-label", `Remove ${text}`);

		let removed = false;
		const removeFilter = (event) => {
			if (removed) return;
			removed = true;
			event.preventDefault();
			event.stopPropagation();
			onRemove(event);
		};

		const isInRemoveZone = (event) => {
			if (event.target === removeButton || removeButton.contains(event.target)) {
				return true;
			}

			const rect = chip.getBoundingClientRect();
			return typeof event.clientX === "number" && rect.right - event.clientX <= 28;
		};

		const removeFromZone = (event) => {
			if (isInRemoveZone(event)) {
				removeFilter(event);
			}
		};

		removeButton.addEventListener("pointerdown", removeFilter);
		removeButton.addEventListener("click", removeFilter);
		chip.addEventListener("pointerdown", removeFromZone);
		chip.addEventListener("click", removeFromZone);

		return chip;
	}

	applyFilters() {
		let resultSet = new Set(this.papers.map((paper) => paper.path));

		if (this.state.status !== "all") {
			const statusResult = new Set(
				this.papers
					.filter((paper) =>
						this.state.status === "read" ? paper.read : !paper.read
					)
					.map((paper) => paper.path)
			);

			resultSet = intersectSets([resultSet, statusResult]);
		}

		const searchTokens = Array.isArray(this.state.appliedSearchTokens)
			? this.state.appliedSearchTokens
					.map((token) => ({
						type: this.getSearchTypeDefinition(token && token.type).value,
						text: normalizeWhitespace(token && token.text),
					}))
					.filter((token) => token.text)
			: [];

		if (searchTokens.length > 0) {
			const searchResult = new Set(
				this.papers
					.filter((paper) => this.paperMatchesSearchTokens(paper, searchTokens))
					.map((paper) => paper.path)
			);

			resultSet = intersectSets([resultSet, searchResult]);
		}

		this.filteredPapers = Array.from(resultSet)
			.map((path) => this.paperByPath.get(path))
			.filter(Boolean);

		this.sortFilteredPapers();
	}

	paperMatchesSearchTokens(paper, tokens) {
		return tokens.every((token) => this.paperMatchesSearchToken(paper, token));
	}

	paperMatchesSearchToken(paper, token) {
		const query = normalizeForSearch(token && token.text);
		if (!query) return true;

		const terms = query.split(/\s+/).filter(Boolean);
		const fieldText = this.getPaperSearchFieldText(paper, token && token.type);

		return terms.every((term) => fieldText.includes(term));
	}

	getPaperSearchFieldText(paper, type) {
		const normalizedType = this.getSearchTypeDefinition(type).value;

			if (normalizedType === "paper") {
				return [paper.normalizedTitle, paper.normalizedArxiv]
					.filter(Boolean)
					.join(" ");
			}

			if (normalizedType === "keywords") {
				return Array.isArray(paper.normalizedKeywords)
					? paper.normalizedKeywords.join(" ")
					: "";
			}

			if (normalizedType === "lab") {
				return Array.isArray(paper.normalizedLabs)
					? paper.normalizedLabs.join(" ")
					: "";
			}

			if (normalizedType === "affiliation") {
				return Array.isArray(paper.normalizedAffiliations)
					? paper.normalizedAffiliations.join(" ")
					: "";
			}

			if (normalizedType === "author") {
				return Array.isArray(paper.normalizedAuthors)
					? paper.normalizedAuthors.join(" ")
					: "";
			}

			return paper.searchHaystack || "";
		}

	sortFilteredPapers() {
		this.filteredPapers.sort((a, b) => {
			const aSortTime = getPaperChronologicalSortTime(a);
			const bSortTime = getPaperChronologicalSortTime(b);

			if (aSortTime && bSortTime && aSortTime !== bSortTime) {
				return bSortTime - aSortTime;
			}

			if (aSortTime && !bSortTime) return -1;
			if (!aSortTime && bSortTime) return 1;

			return comparePaperTitles(a, b);
		});
	}

	updateResultCount() {
		if (!this.resultCountEl) return;

		this.resultCountEl.setText(
			`Showing ${this.filteredPapers.length} of ${this.papers.length} papers`
		);
	}

	createOpenPdfButton(parent, paper) {
		const button = parent.createEl("button", {
			text: "Open PDF",
			cls: "paper-dashboard-small-button",
		});

		if (!paper.hasPdf) {
			button.disabled = true;
			button.title = "No PDF available";
			button.addClass("is-disabled");
			return button;
		}

		button.addEventListener("click", async () => {
			await this.plugin.openPdf(paper);
		});

		return button;
	}

	createOpenGraphButton(parent, paper) {
		const button = parent.createEl("button", {
			text: "Graph",
			cls: "paper-dashboard-small-button paper-library-graph-button",
		});

		button.title =
			"Open or update the right-side global Graph filtered to this paper note and directly related markdown files, with the selected paper highlighted";

		if (!paper || !(paper.file instanceof TFile)) {
			button.disabled = true;
			button.addClass("is-disabled");
			button.title = "Paper note not found";
			return button;
		}

		button.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();

			await this.plugin.openPaperGlobalGraph(paper, this.leaf);
		});

		return button;
	}

	findLibraryCardByPath(path) {
		if (!this.libraryCardsEl || !path) return null;

		for (const child of Array.from(this.libraryCardsEl.children)) {
			if (child instanceof HTMLElement && child.dataset.paperPath === path) {
				return child;
			}
		}

		return null;
	}

	updateReadStatusInPlace(paper, read) {
		const path = typeof paper === "string" ? paper : paper && paper.path;
		if (!path) return;

		const nextRead = !!read;
		let knownPaper = false;

		for (const item of this.papers) {
			if (item && item.path === path) {
				item.read = nextRead;
				knownPaper = true;
			}
		}

		const mappedPaper = this.paperByPath.get(path);
		if (mappedPaper) {
			mappedPaper.read = nextRead;
			knownPaper = true;
		}

		if (paper && typeof paper === "object") {
			paper.read = nextRead;
		}

		if (!knownPaper) return;

		if (this.page !== PAGE_LIBRARY) {
			return;
		}

		this.applyFilters();
		this.updateFilterChrome();

		if (this.state.status !== "all") {
			this.renderLibraryCards();
			return;
		}

		const card = this.findLibraryCardByPath(path);
		if (!card) {
			this.renderLibraryCards();
			return;
		}

		card.toggleClass("is-read", nextRead);
		card.toggleClass("is-unread", !nextRead);

		const button = card.querySelector(".paper-library-read-toggle-button");
		if (button instanceof HTMLElement) {
			button.setText(nextRead ? "Unmark" : "Mark Read");
			button.setAttribute(
				"aria-label",
				nextRead ? "Mark as unread" : "Mark as read"
			);
		}
	}

	removePaperInPlace(paperOrPath) {
		const path =
			typeof paperOrPath === "string"
				? paperOrPath
				: paperOrPath && (paperOrPath.path || (paperOrPath.file && paperOrPath.file.path));

		if (!path) return;

		this.papers = this.papers.filter((paper) => paper && paper.path !== path);
		this.paperByPath.delete(path);

		this.buildIndexes();
		this.removeInvalidFilterSelections();
		this.applyFilters();
		this.updateFilterChrome();

		if (this.page === PAGE_LIBRARY) {
			this.renderLibraryCards();
		}
	}

	createReadToggleButton(parent, paper) {
		const button = parent.createEl("button", {
			text: paper.read ? "Unmark" : "Mark Read",
			cls: "paper-dashboard-small-button paper-library-read-toggle-button",
		});

		button.type = "button";
		button.setAttribute(
			"aria-label",
			paper.read ? "Mark as unread" : "Mark as read"
		);

		button.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();

			button.disabled = true;

			try {
				await this.plugin.setReadStatus(paper, !paper.read, {
					refreshDashboards: false,
				});
			} finally {
				button.disabled = false;
			}
		});

		return button;
	}

	createDeletePaperButton(parent, paper) {
		const button = parent.createEl("button", {
			text: "Delete",
			cls: "paper-dashboard-small-button paper-library-delete-button",
		});

		button.type = "button";
		button.title = "Delete this paper note";
		button.setAttribute("aria-label", "Delete paper note");

		if (!paper || !(paper.file instanceof TFile)) {
			button.disabled = true;
			button.addClass("is-disabled");
			button.title = "Paper note not found";
			return button;
		}

		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();

			new PaperDeleteConfirmModal(this.app, paper, async () => {
				button.disabled = true;
				try {
					return await this.plugin.deletePaper(paper, {
						refreshDashboards: false,
					});
				} finally {
					button.disabled = false;
				}
			}).open();
		});

		return button;
	}
}

class PaperDeleteConfirmModal extends Modal {
	constructor(app, paper, onConfirm) {
		super(app);
		this.paper = paper;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paper-organization-modal");
		contentEl.addClass("paper-delete-confirm-modal");

		contentEl.createEl("h2", {
			text: "Delete paper note?",
		});

		contentEl.createEl("p", {
			text: "This will move the paper note to trash. Linked PDFs and attachments will be left untouched.",
			cls: "paper-organization-desc",
		});

		const target = contentEl.createDiv({
			cls: "paper-delete-confirm-target",
		});

		target.createDiv({
			text: this.paper.title || "Untitled paper",
			cls: "paper-delete-confirm-title",
		});

		target.createDiv({
			text: this.paper.path || "",
			cls: "paper-delete-confirm-path",
		});

		const actions = contentEl.createDiv({
			cls: "paper-organization-button-row paper-delete-confirm-actions",
		});

		const cancelButton = actions.createEl("button", {
			text: "Cancel",
		});

		cancelButton.type = "button";
		cancelButton.addEventListener("click", () => {
			this.close();
		});

		const deleteButton = actions.createEl("button", {
			text: "Delete",
			cls: "mod-warning paper-delete-confirm-button",
		});

		deleteButton.type = "button";
		deleteButton.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();

			deleteButton.disabled = true;
			cancelButton.disabled = true;
			deleteButton.setText("Deleting...");

			const deleted = await this.onConfirm();

			if (deleted !== false) {
				this.close();
				return;
			}

			deleteButton.disabled = false;
			cancelButton.disabled = false;
			deleteButton.setText("Delete");
		});
	}

	onClose() {
		this.contentEl.empty();
		this.contentEl.removeClass("paper-delete-confirm-modal");
	}
}

class PaperImagePreviewModal extends Modal {
	constructor(app, paper, imageInfo) {
		super(app);
		this.paper = paper;
		this.imageInfo = imageInfo;
	}

	onOpen() {
		const { contentEl } = this;

		this.modalEl.addClass("paper-image-preview-container");
		contentEl.empty();
		contentEl.addClass("paper-image-preview-modal");

		contentEl.createEl("h2", {
			text: this.paper.title || "Paper image",
		});

		contentEl.createDiv({
			text: this.imageInfo.label || this.imageInfo.raw || "",
			cls: "paper-image-preview-source",
		});

		const frame = contentEl.createDiv({
			cls: "paper-image-preview-frame",
		});

		const img = frame.createEl("img", {
			cls: "paper-image-preview-img",
		});

		img.src = this.imageInfo.src;
		img.alt = this.paper.title ? `Image for ${this.paper.title}` : "Paper image";

		const actions = contentEl.createDiv({
			cls: "paper-image-preview-actions",
		});

		const closeButton = actions.createEl("button", {
			text: "Close",
		});

		closeButton.addEventListener("click", () => {
			this.close();
		});

		const openSourceButton = actions.createEl("button", {
			text: "Open source",
			cls: "mod-cta",
		});

		const canOpenExternal = /^https?:\/\//i.test(this.imageInfo.target || "");

		if (!(this.imageInfo.file instanceof TFile) && !canOpenExternal) {
			openSourceButton.disabled = true;
			openSourceButton.addClass("is-disabled");
			openSourceButton.title = "No openable source available";
		}

		openSourceButton.addEventListener("click", async () => {
			if (this.imageInfo.file instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(true);
				await leaf.openFile(this.imageInfo.file);
				this.close();
				return;
			}

			if (canOpenExternal) {
				window.open(this.imageInfo.target, "_blank");
			}
		});
	}

	onClose() {
		this.contentEl.empty();
		this.modalEl.removeClass("paper-image-preview-container");
	}
}


class PaperSettingsJsonExportModal extends Modal {
	constructor(app, jsonText) {
		super(app);
		this.jsonText = String(jsonText || "");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paper-organization-modal");
		contentEl.addClass("paper-settings-json-modal");

		contentEl.createEl("h2", { text: "Copy settings JSON" });

		contentEl.createEl("p", {
			text:
				"Clipboard access was not available. Select and copy the JSON below manually, then paste it into another vault when importing.",
			cls: "paper-organization-desc",
		});

		const field = contentEl.createDiv({
			cls: "paper-organization-field",
		});

		field.createEl("label", {
			text: "Settings JSON",
			cls: "paper-organization-label",
		});

		const textarea = field.createEl("textarea", {
			cls: "paper-organization-json-textarea",
		});

		textarea.value = this.jsonText;
		textarea.rows = 14;
		textarea.spellcheck = false;
		textarea.addEventListener("focus", () => textarea.select());

		const actions = contentEl.createDiv({
			cls: "paper-organization-button-row",
		});

		new Setting(actions)
			.addButton((button) => {
				button.setButtonText("Close").onClick(() => this.close());
			})
			.addButton((button) => {
				button
					.setButtonText("Copy again")
					.setCta()
					.onClick(async () => {
						const copied = await copyTextToClipboard(this.jsonText);

						if (copied) {
							new Notice("Settings JSON copied to clipboard.");
							this.close();
							return;
						}

						textarea.focus();
						textarea.select();
						new Notice("Clipboard copy is still unavailable. Copy the selected text manually.");
					});
			});

		window.setTimeout(() => {
			textarea.focus();
			textarea.select();
		}, 50);
	}

	onClose() {
		this.contentEl.empty();
		this.contentEl.removeClass("paper-settings-json-modal");
	}
}

class PaperSettingsJsonImportModal extends Modal {
	constructor(app, plugin, onSubmit, onSuccess) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.onSuccess = onSuccess;
		this.jsonText = "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paper-organization-modal");
		contentEl.addClass("paper-settings-json-modal");

		contentEl.createEl("h2", { text: "Import settings from JSON" });

		contentEl.createEl("p", {
			text:
				"Paste a Treasure Hub settings JSON export below. The changed settings will be previewed before import.",
			cls: "paper-organization-desc",
		});

		const field = contentEl.createDiv({
			cls: "paper-organization-field",
		});

		field.createEl("label", {
			text: "Pasted JSON",
			cls: "paper-organization-label",
		});

		const textarea = field.createEl("textarea", {
			cls: "paper-organization-json-textarea",
		});

		textarea.placeholder = `{
  "schemaVersion": ${SETTINGS_EXPORT_SCHEMA_VERSION},
  "pluginId": "treasure-hub",
  "settings": {
    "templatePath": "Templates/Paper Summary.md"
  }
}`;
		textarea.rows = 14;
		textarea.spellcheck = false;
		textarea.value = this.jsonText;

		const previewEl = field.createDiv({
			cls: "paper-settings-import-preview",
		});

		const helper = field.createDiv({
			cls: "paper-organization-desc paper-organization-inline-desc",
		});
		helper.setText("Only settings are imported. Paper notes, PDFs, and Markdown theme note contents are not embedded in the JSON.");

		const updatePreview = () => {
			this.jsonText = textarea.value;
			this.renderImportPreview(previewEl, this.jsonText);
		};

		textarea.addEventListener("input", updatePreview);
		this.renderImportPreview(previewEl, this.jsonText);

		const actions = contentEl.createDiv({
			cls: "paper-organization-button-row",
		});

		new Setting(actions)
			.addButton((button) => {
				button.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton((button) => {
				button.setButtonText("Read clipboard").onClick(async () => {
					try {
						const text = await readTextFromClipboard();

						if (!text) {
							new Notice("Clipboard is empty or unavailable. Paste the JSON manually.");
							return;
						}

						this.jsonText = text;
						textarea.value = text;
						updatePreview();
						textarea.focus();
						new Notice("Clipboard JSON pasted into the import box.");
					} catch (error) {
						new Notice("Clipboard read is unavailable. Paste the JSON manually.");
					}
				});
			})
			.addButton((button) => {
				button
					.setButtonText("Import")
					.setCta()
					.onClick(async () => {
						const text = String(this.jsonText || textarea.value || "").trim();

						if (!text) {
							new Notice("Please paste a settings JSON export first.");
							return;
						}

						try {
							button.setDisabled(true);
							button.setButtonText("Importing...");

							const result = await this.onSubmit(text);
							const changes = result && Array.isArray(result.changes) ? result.changes : [];

							new Notice(
								result && result.activeStyleMissing
									? "Settings imported. Active Markdown theme is missing in this vault, so Original is being shown until the theme note exists."
									: `Treasure Hub settings imported${changes.length ? ` (${changes.length} change${changes.length === 1 ? "" : "s"})` : ""}.`
							);

							if (typeof this.onSuccess === "function") {
								this.onSuccess(result);
							}

							this.close();
						} catch (error) {
							console.error("treasure-hub: failed to import pasted settings JSON", error);
							new Notice(
								`Failed to import settings: ${
									error && error.message ? error.message : String(error)
								}`
							);

							button.setDisabled(false);
							button.setButtonText("Import");
						}
					});
			});

		window.setTimeout(() => textarea.focus(), 50);
	}

	renderImportPreview(containerEl, jsonText) {
		containerEl.empty();

		const text = String(jsonText || "").trim();
		if (!text) {
			containerEl.addClass("is-empty");
			containerEl.removeClass("is-error");
			containerEl.createDiv({
				text: "Paste JSON to preview which settings will change.",
				cls: "paper-settings-import-preview-empty",
			});
			return;
		}

		containerEl.removeClass("is-empty");

		let preview = null;
		try {
			preview = this.plugin.previewSettingsImportFromJsonText(text);
		} catch (error) {
			containerEl.addClass("is-error");
			containerEl.createDiv({
				text: "Preview unavailable",
				cls: "paper-settings-import-preview-title",
			});
			containerEl.createDiv({
				text: error && error.message ? error.message : String(error),
				cls: "paper-settings-import-preview-error",
			});
			return;
		}

		containerEl.removeClass("is-error");
		const changes = preview && Array.isArray(preview.changes) ? preview.changes : [];

		containerEl.createDiv({
			text: changes.length
				? `Settings that will change (${changes.length})`
				: "No setting values will change",
			cls: "paper-settings-import-preview-title",
		});

		if (changes.length === 0) {
			containerEl.createDiv({
				text: "The pasted JSON matches the current plugin settings after normalization.",
				cls: "paper-settings-import-preview-empty",
			});
			return;
		}

		const header = containerEl.createDiv({
			cls: "paper-settings-import-change-row paper-settings-import-change-header",
		});
		header.createDiv({ text: "Setting" });
		header.createDiv({ text: "Current" });
		header.createDiv({ text: "Imported" });

		const list = containerEl.createDiv({
			cls: "paper-settings-import-change-list",
		});

		for (const change of changes) {
			const row = list.createDiv({
				cls: "paper-settings-import-change-row",
			});

			row.createDiv({
				text: change.label || change.key || "Setting",
				cls: "paper-settings-import-change-label",
			});

			row.createDiv({
				text: this.formatPreviewValue(change.from),
				cls: "paper-settings-import-change-value is-from",
			});

			row.createDiv({
				text: this.formatPreviewValue(change.to),
				cls: "paper-settings-import-change-value is-to",
			});
		}
	}

	formatPreviewValue(value) {
		if (value === true) return "Enabled";
		if (value === false) return "Disabled";
		if (value === STYLE_ORIGINAL) return "Original";
		if (value === null || value === undefined || value === "") return "(empty)";
		return String(value);
	}

	onClose() {
		this.contentEl.empty();
		this.contentEl.removeClass("paper-settings-json-modal");
	}
}

class PaperImportModal extends Modal {
	constructor(app, plugin, onSubmit) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.pdfUrl = "";
		this.downloadPdf = false;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paper-organization-modal");

		contentEl.createEl("h2", { text: "Import Paper from PDF URL" });

		contentEl.createEl("p", {
			text: "Enter a paper PDF URL. The plugin will extract metadata and create a paper summary note from your template.",
			cls: "paper-organization-desc",
		});

		new Setting(contentEl)
			.setName("PDF URL")
			.setDesc("Supports arXiv PDF links and direct PDF links.")
			.addText((text) => {
				text.setPlaceholder("https://arxiv.org/pdf/2504.02792")
					.setValue(this.pdfUrl)
					.onChange((value) => {
						this.pdfUrl = value;
					});

				text.inputEl.addClass("paper-organization-url-input");
			});

		new Setting(contentEl)
			.setName("Download PDF locally")
			.setDesc(
				"When enabled, the PDF will be saved to the configured PDF folder and linked in the pdf field."
			)
			.addToggle((toggle) => {
				toggle.setValue(this.downloadPdf).onChange((value) => {
					this.downloadPdf = value;
				});
			});

		const buttonRow = contentEl.createDiv({
			cls: "paper-organization-button-row",
		});

		new Setting(buttonRow)
			.addButton((button) => {
				button.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton((button) => {
				button
					.setButtonText("Import")
					.setCta()
					.onClick(async () => {
						const url = String(this.pdfUrl || "").trim();

						if (!url) {
							new Notice("Please enter a paper PDF URL.");
							return;
						}

						try {
							button.setDisabled(true);
							button.setButtonText("Importing...");
							await this.onSubmit(url, this.downloadPdf);
							this.close();
						} catch (error) {
							console.error(
								"treasure-hub: failed to import paper",
								error
							);

							new Notice(
								`Paper import failed: ${
									error && error.message ? error.message : String(error)
								}`
							);

							button.setDisabled(false);
							button.setButtonText("Import");
						}
					});
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}


class PaperBatchImportModal extends Modal {
	constructor(app, plugin, onSubmit) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.pdfUrls = "";
		this.downloadPdf = false;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paper-organization-modal");

		contentEl.createEl("h2", { text: "Import Papers from PDF URLs" });

		contentEl.createEl("p", {
			text: "Enter one PDF URL per line, or paste multiple URLs separated by spaces, commas, or semicolons. Each URL will be imported with the same logic as the single-paper import command.",
			cls: "paper-organization-desc",
		});

		const urlField = contentEl.createDiv({
			cls: "paper-organization-field",
		});

		urlField.createEl("label", {
			text: "PDF URLs",
			cls: "paper-organization-label",
		});

		const textarea = urlField.createEl("textarea", {
			cls: "paper-organization-url-textarea",
		});

		textarea.placeholder = [
			"https://arxiv.org/pdf/2504.02792",
			"https://arxiv.org/pdf/2505.01234",
		].join("\n");
		textarea.value = this.pdfUrls;
		textarea.rows = 8;
		textarea.addEventListener("input", () => {
			this.pdfUrls = textarea.value;
		});

		const helper = urlField.createDiv({
			cls: "paper-organization-desc paper-organization-inline-desc",
		});
		helper.setText("Duplicate URLs are ignored. Invalid URLs are skipped before import starts.");

		new Setting(contentEl)
			.setName("Download PDFs locally")
			.setDesc(
				"When enabled, each PDF will be saved to the configured PDF folder and linked in the pdf field."
			)
			.addToggle((toggle) => {
				toggle.setValue(this.downloadPdf).onChange((value) => {
					this.downloadPdf = value;
				});
			});

		const preview = contentEl.createDiv({
			cls: "paper-organization-batch-preview",
		});

		const updatePreview = () => {
			const urls = parsePaperPdfUrls(this.pdfUrls);
			preview.setText(`${urls.length} valid unique URL${urls.length === 1 ? "" : "s"} ready to import.`);
		};

		textarea.addEventListener("input", updatePreview);
		updatePreview();

		const buttonRow = contentEl.createDiv({
			cls: "paper-organization-button-row",
		});

		new Setting(buttonRow)
			.addButton((button) => {
				button.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton((button) => {
				button
					.setButtonText("Import All")
					.setCta()
					.onClick(async () => {
						const urls = parsePaperPdfUrls(this.pdfUrls);

						if (urls.length === 0) {
							new Notice("Please enter at least one valid HTTP/HTTPS PDF URL.");
							return;
						}

						try {
							button.setDisabled(true);
							button.setButtonText(`Importing 0/${urls.length}...`);

							let completed = 0;
							const result = await this.onSubmit(urls, this.downloadPdf, () => {
								completed += 1;
								button.setButtonText(`Importing ${completed}/${urls.length}...`);
							});

							if (!result || !Array.isArray(result.failed) || result.failed.length === 0) {
								this.close();
								return;
							}

							this.renderFailureSummary(result);
							this.pdfUrls = result.failed.map((item) => item.url).join("\n");
							textarea.value = this.pdfUrls;
							updatePreview();
							button.setDisabled(false);
							button.setButtonText("Retry Failed");
						} catch (error) {
							console.error(
								"treasure-hub: failed to batch import papers",
								error
							);

							new Notice(
								`Batch import failed: ${
									error && error.message ? error.message : String(error)
								}`
							);

							button.setDisabled(false);
							button.setButtonText("Import All");
						}
					});
			});
	}

	renderFailureSummary(result) {
		let failureEl = this.contentEl.querySelector(".paper-organization-batch-failures");

		if (!(failureEl instanceof HTMLElement)) {
			failureEl = this.contentEl.createDiv({
				cls: "paper-organization-batch-failures",
			});
		}

		failureEl.empty();

		failureEl.createDiv({
			text: `${result.failed.length} URL${result.failed.length === 1 ? "" : "s"} failed to import:`,
			cls: "paper-organization-batch-failures-title",
		});

		const list = failureEl.createEl("ul");

		for (const item of result.failed.slice(0, 8)) {
			const message = item.error && item.error.message ? item.error.message : String(item.error || "Unknown error");
			list.createEl("li", {
				text: `${item.url} — ${message}`,
			});
		}

		if (result.failed.length > 8) {
			list.createEl("li", {
				text: `...and ${result.failed.length - 8} more. See console for details.`,
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TreasureHubSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("paper-organization-settings");

		const hero = containerEl.createDiv({
			cls: "paper-settings-hero",
		});

		const heroText = hero.createDiv({
			cls: "paper-settings-hero-text",
		});

		heroText.createDiv({
			text: "Treasure Hub",
			cls: "paper-settings-eyebrow",
		});

		heroText.createEl("h2", {
			text: "Settings",
			cls: "paper-settings-title",
		});

		heroText.createDiv({
			text: "Manage paper import paths, library display, settings backup, and Markdown-based dashboard styles.",
			cls: "paper-settings-subtitle",
		});

		const heroBadge = hero.createDiv({
			cls: "paper-settings-hero-badge",
		});

		heroBadge.createDiv({
			text: "Active style",
			cls: "paper-settings-hero-badge-label",
		});

		heroBadge.createDiv({
			text: this.plugin.getActiveStyleLabel(),
			cls: "paper-settings-hero-badge-value",
		});

		const pathSection = this.createSettingsSection(containerEl, {
			eyebrow: "Storage",
			title: "Import paths",
			description:
				"Choose where paper notes, downloaded PDFs, and the fallback summary template are stored.",
		});

		this.addTextSetting(pathSection, {
			name: "Paper summary template path",
			desc:
				"Example: Templates/Paper Summary.md. If the file does not exist, the built-in template will be used.",
			placeholder: DEFAULT_SETTINGS.templatePath,
			value: this.plugin.settings.templatePath,
			onChange: async (value) => {
				this.plugin.settings.templatePath =
					value.trim() || DEFAULT_SETTINGS.templatePath;

				await this.plugin.saveSettings();
			},
		});

		this.addTextSetting(pathSection, {
			name: "Markdown output folder",
			desc: "Example: Papers/Summaries.",
			placeholder: DEFAULT_SETTINGS.markdownFolderPath,
			value: this.plugin.settings.markdownFolderPath,
			onChange: async (value) => {
				this.plugin.settings.markdownFolderPath =
					value.trim() || DEFAULT_SETTINGS.markdownFolderPath;

				await this.plugin.saveSettings();
			},
		});

		this.addTextSetting(pathSection, {
			name: "PDF download folder",
			desc: "Example: Papers/PDFs.",
			placeholder: DEFAULT_SETTINGS.pdfFolderPath,
			value: this.plugin.settings.pdfFolderPath,
			onChange: async (value) => {
				this.plugin.settings.pdfFolderPath =
					value.trim() || DEFAULT_SETTINGS.pdfFolderPath;

				await this.plugin.saveSettings();
			},
		});

		const dashboardSection = this.createSettingsSection(containerEl, {
			eyebrow: "Dashboard",
			title: "Main page display",
			description:
				"Control which modules are shown on the Treasure Hub main page.",
		});

		const overviewSetting = new Setting(dashboardSection)
			.setName("Show Overview on main page")
			.setDesc(
				"When enabled, the Dashboard page will display the Overview statistics module. Enabled by default."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showDashboardOverview !== false)
					.onChange(async (value) => {
						this.plugin.settings.showDashboardOverview = value;

						await this.plugin.saveSettings();
						await this.plugin.refreshOpenDashboards();
					});
			});

		overviewSetting.settingEl.addClass("paper-settings-row");

		const librarySection = this.createSettingsSection(containerEl, {
			eyebrow: "Library",
			title: "Display options",
			description:
				"Control how Paper Library cards present paper metadata and visual previews.",
		});

		const imageSetting = new Setting(librarySection)
			.setName("Show images in Paper Library")
			.setDesc(
				"When enabled, Paper Library will display images from the image frontmatter property. Enabled by default."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showPaperLibraryImages !== false)
					.onChange(async (value) => {
						this.plugin.settings.showPaperLibraryImages = value;

						await this.plugin.saveSettings();
						await this.plugin.refreshOpenDashboards();
					});
			});

		imageSetting.settingEl.addClass("paper-settings-row");

		const backupSection = this.createSettingsSection(containerEl, {
			eyebrow: "Backup",
			title: "Settings import/export",
			description:
				"Copy plugin settings as clipboard JSON, paste a previous JSON export, or use JSON files as a fallback. Theme notes themselves are not embedded; only their folder and active path are saved.",
		});

		this.renderSettingsImportExport(backupSection);

		const styleSection = this.createSettingsSection(containerEl, {
			eyebrow: "Appearance",
			title: "Dashboard style",
			description:
				"Use Original, or select a Markdown note in a vault folder. Each theme note can contain one or more fenced ```css code blocks.",
		});

		this.addTextSetting(styleSection, {
			name: "Markdown theme folder",
			desc:
				"Vault-relative folder containing .md theme notes with fenced ```css code blocks. Example: Treasure Hub/Themes.",
			placeholder: DEFAULT_SETTINGS.customStyleFolderPath,
			value: this.plugin.getCustomStyleFolderPath(),
			onChange: async (value) => {
				try {
					await this.plugin.setCustomStyleFolderPath(
						value.trim() || DEFAULT_SETTINGS.customStyleFolderPath
					);
				} catch (error) {
					new Notice(
						`Invalid theme folder path: ${
							error && error.message ? error.message : String(error)
						}`
					);
				}
			},
		});

		this.renderStyleSettings(styleSection);
	}

	createSettingsSection(containerEl, options) {
		const section = containerEl.createDiv({
			cls: "paper-settings-section",
		});

		const header = section.createDiv({
			cls: "paper-settings-section-header",
		});

		header.createDiv({
			text: options.eyebrow || "Settings",
			cls: "paper-settings-section-eyebrow",
		});

		header.createEl("h3", {
			text: options.title || "Settings",
			cls: "paper-settings-section-title",
		});

		if (options.description) {
			header.createDiv({
				text: options.description,
				cls: "paper-settings-section-desc",
			});
		}

		return section;
	}

	addTextSetting(containerEl, options) {
		const setting = new Setting(containerEl)
			.setName(options.name)
			.setDesc(options.desc)
			.addText((text) => {
				text.setPlaceholder(options.placeholder || "")
					.setValue(options.value || "")
					.onChange(options.onChange);
			});

		setting.settingEl.addClass("paper-settings-row");

		return setting;
	}

	renderSettingsImportExport(section) {
		const fileInput = section.createEl("input");
		fileInput.type = "file";
		fileInput.accept = ".json,application/json,text/plain";
		fileInput.addClass("paper-style-file-input");

		fileInput.onchange = async () => {
			const selectedFile = fileInput.files && fileInput.files[0];
			if (!selectedFile) return;

			try {
				const result = await this.plugin.importSettingsFromFile(selectedFile);
				new Notice(
					result.activeStyleMissing
						? "Settings imported. Active Markdown theme is missing in this vault, so Original is being shown until the theme note exists."
						: "Treasure Hub settings imported."
				);
				this.display();
			} catch (error) {
				console.error("treasure-hub: failed to import settings", error);
				new Notice(
					`Failed to import settings: ${
						error && error.message ? error.message : String(error)
					}`
				);
			} finally {
				fileInput.value = "";
			}
		};

		const summary = section.createDiv({
			cls: "paper-style-summary paper-settings-clipboard-summary",
		});

		const summaryMain = summary.createDiv({
			cls: "paper-style-summary-main",
		});

		summaryMain.createDiv({
			cls: "paper-style-summary-icon",
			text: "⇄",
		});

		const summaryBody = summaryMain.createDiv({
			cls: "paper-style-summary-body",
		});

		summaryBody.createDiv({
			text: "Clipboard settings JSON",
			cls: "paper-style-summary-title",
		});

		summaryBody.createDiv({
			text:
				"Copy the current plugin settings as JSON, or paste a previous JSON export to import it. Theme notes themselves are not embedded; only their folder and active path are saved.",
			cls: "paper-style-summary-desc",
		});

		const summaryActions = summary.createDiv({
			cls: "paper-style-summary-actions",
		});

		this.createToolbarButton(summaryActions, "Copy JSON", "mod-cta", async () => {
			await this.plugin.exportSettingsToClipboard();
		});

		this.createToolbarButton(summaryActions, "Paste JSON", "", () => {
			new PaperSettingsJsonImportModal(this.app, this.plugin, async (jsonText) => {
				return await this.plugin.importSettingsFromJsonText(jsonText, {
					sourceName: "pasted JSON",
				});
			}, () => this.display()).open();
		});

		const schemaRow = section.createDiv({
			cls: "paper-settings-export-schema-row",
		});

		const location = schemaRow.createDiv({
			cls: "paper-style-location paper-settings-export-schema-location",
		});

		location.createDiv({
			text: "Export schema",
			cls: "paper-style-location-label",
		});

		location.createDiv({
			text: `v${SETTINGS_EXPORT_SCHEMA_VERSION} · plugin ${
				this.plugin.manifest && this.plugin.manifest.version
					? this.plugin.manifest.version
					: ""
			}`,
			cls: "paper-style-location-path",
		});

		const fileRow = schemaRow.createDiv({
			cls: "paper-settings-secondary-actions paper-settings-secondary-actions-inline",
		});

		this.createToolbarButton(fileRow, "Download JSON file", "", () => {
			this.plugin.exportSettingsToFile();
		});

		this.createToolbarButton(fileRow, "Import JSON file", "", () => {
			fileInput.click();
		});
	}

	renderStyleSettings(section) {
		const activeStylePath = this.plugin.settings.activeStylePath || STYLE_ORIGINAL;
		const customFiles = this.plugin.getCustomStyleFiles();
		const activeFile = customFiles.find((file) => file.path === activeStylePath);
		const activeMissing = activeStylePath !== STYLE_ORIGINAL && !activeFile;

		const fileInput = section.createEl("input");
		fileInput.type = "file";
		fileInput.accept = ".css,.md,text/css,text/markdown,text/plain";
		fileInput.addClass("paper-style-file-input");

		fileInput.onchange = async () => {
			const selectedFile = fileInput.files && fileInput.files[0];
			if (!selectedFile) return;

			try {
				await this.plugin.importCustomStyleFile(selectedFile);
				new Notice(`Imported and enabled: ${selectedFile.name}`);
				this.display();
			} catch (error) {
				console.error("treasure-hub: failed to import Markdown style", error);
				new Notice(
					`Failed to import style: ${
						error && error.message ? error.message : String(error)
					}`
				);
			} finally {
				fileInput.value = "";
			}
		};

		const summary = section.createDiv({
			cls: activeMissing
				? "paper-style-summary is-warning"
				: "paper-style-summary",
		});

		const summaryMain = summary.createDiv({
			cls: "paper-style-summary-main",
		});

		summaryMain.createDiv({
			cls: "paper-style-summary-icon",
			text: activeStylePath === STYLE_ORIGINAL ? "◎" : activeMissing ? "!" : "✦",
		});

		const summaryBody = summaryMain.createDiv({
			cls: "paper-style-summary-body",
		});

		summaryBody.createDiv({
			text: this.plugin.getActiveStyleLabel(),
			cls: "paper-style-summary-title",
		});

		summaryBody.createDiv({
			text:
				activeStylePath === STYLE_ORIGINAL
					? "Using the built-in Treasure Hub style injected by the plugin."
					: activeMissing
						? "The selected Markdown theme note cannot be found in the theme folder, or it has no fenced ```css code block. The dashboard is currently falling back to Original style."
						: `Loaded from ${activeFile.path}`,
			cls: "paper-style-summary-desc",
		});

		const summaryActions = summary.createDiv({
			cls: "paper-style-summary-actions",
		});

		this.createToolbarButton(summaryActions, "Import CSS/MD", "mod-cta", () => {
			fileInput.click();
		});

		this.createToolbarButton(summaryActions, "Create sample", "", async () => {
			await this.plugin.createSampleCustomStyleNote();
			this.display();
		});

		this.createToolbarButton(summaryActions, "Refresh list", "", async () => {
			await this.plugin.refreshCustomStyleFiles();
			this.display();
		});

		const location = section.createDiv({
			cls: "paper-style-location",
		});

		location.createDiv({
			text: "Markdown theme folder",
			cls: "paper-style-location-label",
		});

		location.createDiv({
			text: this.plugin.getCustomStyleFolderPath(),
			cls: "paper-style-location-path",
		});

		const listHeader = section.createDiv({
			cls: "paper-style-list-header",
		});

		listHeader.createDiv({
			text: "Available styles",
			cls: "paper-style-list-title",
		});

		listHeader.createDiv({
			text: `${customFiles.length + 1} option${customFiles.length === 0 ? "" : "s"}`,
			cls: "paper-style-list-count",
		});

		const list = section.createDiv({
			cls: "paper-style-list",
		});

		this.renderOriginalStyleCard(list);

		if (customFiles.length === 0) {
			const empty = list.createDiv({
				cls: "paper-style-empty",
			});

			empty.createDiv({
				text: "No Markdown theme notes with CSS code blocks found yet.",
				cls: "paper-style-empty-title",
			});

			empty.createDiv({
				text:
					"Create or move a .md file into the theme folder, add a fenced ```css code block, then tap Refresh list. You can also tap Create sample.",
				cls: "paper-style-empty-desc",
			});
		} else {
			for (const file of customFiles) {
				this.renderCustomStyleCard(list, file);
			}
		}
	}

	createToolbarButton(containerEl, text, extraClass, onClick) {
		const button = containerEl.createEl("button", {
			text,
			cls: extraClass ? `paper-style-toolbar-button ${extraClass}` : "paper-style-toolbar-button",
		});

		button.onclick = async () => {
			button.setAttribute("disabled", "true");

			try {
				await onClick();
			} finally {
				button.removeAttribute("disabled");
			}
		};

		return button;
	}

	renderOriginalStyleCard(list) {
		const isActive = this.plugin.isOriginalStyleActive();
		const card = list.createDiv({
			cls: isActive ? "paper-style-card is-active" : "paper-style-card",
		});

		const main = card.createDiv({
			cls: "paper-style-card-main",
		});

		main.createDiv({
			text: "Original",
			cls: "paper-style-card-title",
		});

		main.createDiv({
			text: "Built-in dashboard style injected only when Original is active.",
			cls: "paper-style-card-path",
		});

		const actions = card.createDiv({
			cls: "paper-style-card-actions",
		});

		actions.createDiv({
			text: isActive ? "Active" : "Built-in",
			cls: isActive ? "paper-style-status is-active" : "paper-style-status",
		});

		if (!isActive) {
			this.createCardButton(actions, "Enable", async () => {
				await this.plugin.setActiveStyle(STYLE_ORIGINAL, { showNotice: true });
				this.display();
			});
		}
	}

	renderCustomStyleCard(list, file) {
		const isActive = this.plugin.settings.activeStylePath === file.path;
		const card = list.createDiv({
			cls: isActive ? "paper-style-card is-active" : "paper-style-card",
		});

		const main = card.createDiv({
			cls: "paper-style-card-main",
		});

		main.createDiv({
			text: file.basename || file.name,
			cls: "paper-style-card-title",
		});

		main.createDiv({
			text: file.path,
			cls: "paper-style-card-path",
		});

		const meta = main.createDiv({
			cls: "paper-style-card-meta",
		});

		meta.createSpan({
			text: `${file.cssBlockCount || 0} CSS block${file.cssBlockCount === 1 ? "" : "s"}`,
		});

		meta.createSpan({
			text: `${Math.max(0.1, (file.cssSize || file.stat.size) / 1024).toFixed(1)} KB CSS`,
		});

		meta.createSpan({
			text: `Modified ${formatDateTime(file.stat.mtime)}`,
		});

		const actions = card.createDiv({
			cls: "paper-style-card-actions",
		});

		actions.createDiv({
			text: isActive ? "Active" : "Available",
			cls: isActive ? "paper-style-status is-active" : "paper-style-status",
		});

		if (!isActive) {
			this.createCardButton(actions, "Enable", async () => {
				await this.plugin.setActiveStyle(file.path, { showNotice: true });
				this.display();
			});
		} else {
			this.createCardButton(actions, "Reload", async () => {
				await this.plugin.refreshCustomStyleFiles();
				await this.plugin.applyActiveStyle({ showNotice: true });
				await this.plugin.refreshOpenDashboards();
			});
		}

		this.createCardButton(actions, "Copy path", async () => {
			if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(file.path);
				new Notice("Style path copied.");
				return;
			}

			new Notice(file.path);
		});
	}

	createCardButton(containerEl, text, onClick) {
		const button = containerEl.createEl("button", {
			text,
			cls: "paper-style-card-button",
		});

		button.onclick = async () => {
			button.setAttribute("disabled", "true");

			try {
				await onClick();
			} catch (error) {
				new Notice(
					`${text} failed: ${
						error && error.message ? error.message : String(error)
					}`
				);
			} finally {
				button.removeAttribute("disabled");
			}
		};

		return button;
	}
}

/* ---------------- Dashboard DOM helpers ---------------- */


function parsePaperPdfUrls(value) {
	const rawItems = Array.isArray(value)
		? value
		: String(value || "").match(/https?:\/\/[^\s,;]+/gi) || [];

	const urls = [];
	const seen = new Set();

	for (const item of rawItems) {
		let url = String(item || "")
			.trim()
			.replace(/^<+/, "")
			.replace(/>+$/, "")
			.replace(/[),.;]+$/g, "");

		if (!/^https?:\/\//i.test(url)) {
			continue;
		}

		const key = url.toLowerCase();

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		urls.push(url);
	}

	return urls;
}

function createSection(root, title, options = {}) {
	const section = root.createDiv({
		cls: "paper-dashboard-section",
	});

	if (options.showTitle !== false) {
		section.createEl("h2", {
			text: title,
			cls: "paper-dashboard-section-title",
		});
	}

	return section;
}

function createStatCard(parent, label, value) {
	const card = parent.createDiv({
		cls: "paper-dashboard-stat-card",
	});

	card.createDiv({
		text: label,
		cls: "paper-dashboard-stat-label",
	});

	card.createDiv({
		text: String(value),
		cls: "paper-dashboard-stat-value",
	});
}

function getFirstAuthorMetaText(paper) {
	const authors = Array.isArray(paper && paper.authors) ? paper.authors : [];
	const firstAuthor = normalizeWhitespace(authors[0] || "");

	return firstAuthor;
}

function getPaperAffiliationMetaText(paper) {
	const labs = normalizeStringArray(
		Array.isArray(paper && paper.labs) ? paper.labs : []
	);
	const affiliations = normalizeStringArray(
		Array.isArray(paper && paper.affiliations) ? paper.affiliations : []
	);
	const parts = [];

	if (labs.length > 0) {
		parts.push(labs.join(", "));
	}

	if (affiliations.length > 0) {
		parts.push(affiliations.join(", "));
	}

	return parts.join(" / ");
}

function getPaperChronologicalSortTime(paper) {
	const arxivSortTime = Number(paper && paper.arxivSortTime) || 0;
	if (arxivSortTime) return arxivSortTime;

	const paperYear = Number(paper && paper.paperYear) || 0;
	return paperYear ? paperYear * 100 : 0;
}

function comparePaperTitles(a, b) {
	const titleCompare = normalizeWhitespace(a && a.title).localeCompare(
		normalizeWhitespace(b && b.title),
		undefined,
		{
			sensitivity: "base",
			numeric: true,
		}
	);

	if (titleCompare !== 0) return titleCompare;

	return String((a && a.path) || "").localeCompare(String((b && b.path) || ""));
}

function extractPaperYear(frontmatter) {
	const fm = frontmatter || {};
	const candidates = [
		fm.year,
		fm.publication_year,
		fm.published_year,
		fm.pub_year,
		fm.date,
		fm.published,
		fm.publication_date,
		fm.published_date,
	];

	for (const candidate of candidates) {
		const year = parseFrontmatterYear(candidate);
		if (year) return year;
	}

	return 0;
}

function parseFrontmatterYear(value) {
	if (value === null || value === undefined) return 0;

	if (Array.isArray(value)) {
		for (const item of value) {
			const year = parseFrontmatterYear(item);
			if (year) return year;
		}

		return 0;
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		const year = Math.trunc(value);
		return year >= 1900 && year <= 2100 ? year : 0;
	}

	const text = normalizeWhitespace(value);
	const match = text.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
	if (!match) return 0;

	const year = Number(match[1]);
	return year >= 1900 && year <= 2100 ? year : 0;
}

function getArxivSortTime(arxiv) {
	const cleanId = cleanArxivId(arxiv);
	if (!cleanId) return 0;

	const idTail = cleanId.includes("/")
		? cleanId.slice(cleanId.lastIndexOf("/") + 1)
		: cleanId;
	const match = idTail.match(/^(\d{2})(\d{2})(?:\.|\d)/);
	if (!match) return 0;

	const twoDigitYear = Number(match[1]);
	const month = Number(match[2]);
	if (!Number.isFinite(twoDigitYear) || month < 1 || month > 12) return 0;

	const year = twoDigitYear >= 91 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
	return year * 100 + month;
}

function formatDate(timestamp) {
	if (!timestamp) return "—";

	const date = new Date(timestamp);

	if (Number.isNaN(date.getTime())) return "—";

	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

function formatDateTime(timestamp) {
	if (!timestamp) return "—";

	const date = new Date(timestamp);

	if (Number.isNaN(date.getTime())) return "—";

	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");

	return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatDateForFileName(timestamp) {
	const date = new Date(timestamp || Date.now());

	if (Number.isNaN(date.getTime())) {
		return "unknown-date";
	}

	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");

	return `${year}-${month}-${day}-${hour}${minute}`;
}


async function copyTextToClipboard(text) {
	const value = String(text || "");

	try {
		if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			await navigator.clipboard.writeText(value);
			return true;
		}
	} catch (error) {
		console.warn("treasure-hub: navigator.clipboard.writeText failed", error);
	}

	try {
		const textarea = document.createElement("textarea");
		textarea.value = value;
		textarea.setAttribute("readonly", "readonly");
		textarea.style.position = "fixed";
		textarea.style.left = "-9999px";
		textarea.style.top = "0";
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		const success = document.execCommand && document.execCommand("copy");
		textarea.remove();
		return !!success;
	} catch (error) {
		console.warn("treasure-hub: fallback clipboard copy failed", error);
		return false;
	}
}

async function readTextFromClipboard() {
	if (navigator && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
		return await navigator.clipboard.readText();
	}

	return "";
}

function downloadTextFile(filename, text, mimeType = "text/plain") {
	const blob = new Blob([String(text || "")], {
		type: `${mimeType};charset=utf-8`,
	});
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");

	anchor.href = url;
	anchor.download = filename || "download.txt";
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();

	window.setTimeout(() => {
		URL.revokeObjectURL(url);
	}, 1000);
}

async function readBrowserFileAsText(file) {
	if (file && typeof file.text === "function") {
		return await file.text();
	}

	return await new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onload = () => resolve(String(reader.result || ""));
		reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
		reader.readAsText(file);
	});
}

function extractCssCodeBlocks(markdown) {
	const source = String(markdown || "").replace(/\r\n?/g, "\n");
	const blocks = [];
	const pattern = /(?:^|\n)(`{3,}|~{3,})[ \t]*css\b[^\n]*\n([\s\S]*?)\n\1[ \t]*(?=\n|$)/gi;
	let match;

	while ((match = pattern.exec(source)) !== null) {
		const css = String(match[2] || "").trim();

		if (css) {
			blocks.push(css);
		}
	}

	return blocks;
}

function buildCssFromMarkdownStyleNote(path, markdown) {
	const blocks = extractCssCodeBlocks(markdown);

	if (blocks.length === 0) {
		throw new Error("No fenced ```css code block found in the selected Markdown style note.");
	}

	return blocks
		.map((css, index) => `/* CSS block ${index + 1} from ${path} */\n${css}`)
		.join("\n\n");
}

function sortedMapEntries(map) {
	return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
}

function unionSets(sets) {
	const result = new Set();

	for (const set of sets) {
		for (const item of set) {
			result.add(item);
		}
	}

	return result;
}

function intersectSets(sets) {
	if (!sets || sets.length === 0) return new Set();

	const sorted = [...sets].sort((a, b) => a.size - b.size);
	const result = new Set();

	for (const item of sorted[0]) {
		if (sorted.every((set) => set.has(item))) {
			result.add(item);
		}
	}

	return result;
}

function getPdfStatusPillClass(status) {
	const value = String(status || "").toLowerCase();

	if (value === "local") return "is-local";
	if (value === "external") return "is-external";

	return "is-none";
}

function sleepMs(ms) {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/* ---------------- Basic value helpers ---------------- */

function asString(value) {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}

function asFirstString(value) {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) {
		const first = value.find((item) => normalizeWhitespace(item));
		return first === undefined || first === null ? "" : String(first);
	}
	return String(value);
}

function asArray(value) {
	if (value === null || value === undefined) return [];

	if (Array.isArray(value)) {
		return value.map((item) => String(item || "").trim()).filter(Boolean);
	}

	const text = String(value || "").trim();

	if (!text) return [];

	if (text.includes(",")) {
		return text
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}

	return [text];
}

function asBoolean(value) {
	if (value === true) return true;
	if (value === false) return false;

	const text = String(value || "").trim().toLowerCase();

	return text === "true" || text === "yes" || text === "1";
}

function normalizeForSearch(value) {
	return normalizeWhitespace(value).toLowerCase();
}

function normalizeStringArray(value) {
	return Array.isArray(value)
		? value.map(normalizeWhitespace).filter(Boolean)
		: [];
}

function extractObsidianLinkTarget(value) {
	const text = String(value || "").trim();

	const match = text.match(/^\[\[([^|\]]+)(?:\|[^\]]+)?\]\]$/);

	if (match && match[1]) {
		return match[1].trim();
	}

	return text;
}

function extractImageLinkTarget(value) {
	let text = String(value || "").trim();

	if (!text) return "";

	if (/^<[^>]+>$/.test(text)) {
		text = text.slice(1, -1).trim();
	}

	let match = text.match(/^!\[\[([\s\S]+?)\]\]$/);
	if (match && match[1]) {
		return stripObsidianLinkDisplay(match[1]);
	}

	match = text.match(/^\[\[([\s\S]+?)\]\]$/);
	if (match && match[1]) {
		return stripObsidianLinkDisplay(match[1]);
	}

	match = text.match(/^!\[[^\]]*?\]\(([\s\S]+?)\)$/);
	if (match && match[1]) {
		return stripMarkdownLinkTarget(match[1]);
	}

	match = text.match(/^\[[^\]]*?\]\(([\s\S]+?)\)$/);
	if (match && match[1]) {
		return stripMarkdownLinkTarget(match[1]);
	}

	return text;
}

function stripObsidianLinkDisplay(value) {
	return String(value || "").split("|")[0].trim();
}

function stripMarkdownLinkTarget(value) {
	let text = String(value || "").trim();

	if (/^<[^>]+>$/.test(text)) {
		return text.slice(1, -1).trim();
	}

	const titleMatch = text.match(/^([\s\S]+?)\s+["'][^"']*["']$/);
	if (titleMatch && titleMatch[1]) {
		return titleMatch[1].trim();
	}

	return text;
}

function decodeUriSafe(value) {
	try {
		return decodeURIComponent(value);
	} catch (_) {
		return value;
	}
}

/* ---------------- Metadata helpers ---------------- */

function isArxivLikeTitle(title, arxivId) {
	const text = normalizeWhitespace(title || "");
	const lower = text.toLowerCase();

	if (!lower) return false;

	if (lower.includes("arxiv")) {
		return true;
	}

	if (arxivId) {
		const cleanId = cleanArxivId(arxivId).toLowerCase();

		if (lower === cleanId) return true;
		if (lower === `arxiv ${cleanId}`) return true;
		if (lower === `arxiv:${cleanId}`) return true;
	}

	return false;
}

function isUsablePaperTitle(title) {
	const text = normalizeWhitespace(title || "");

	if (!text) return false;
	if (text.length < 3) return false;

	if (/^[\s†‡*§¶,.;:|_\-–—()[\]{}'"`~^+=\\/<>]+$/.test(text)) {
		return false;
	}

	const chars = Array.from(text);

	const alphaNumericCount = chars.filter((char) =>
		/[\p{L}\p{N}]/u.test(char)
	).length;

	if (alphaNumericCount < 2) {
		return false;
	}

	const lower = text.toLowerCase();

	const invalidExactTitles = new Set([
		"untitled",
		"title",
		"paper",
		"main",
		"main.pdf",
		"article",
		"document",
	]);

	if (invalidExactTitles.has(lower)) {
		return false;
	}

	return true;
}

/* ---------------- arXiv helpers ---------------- */

function extractArxivId(input) {
	const value = String(input || "").trim();
	if (!value) return "";

	let decoded = value;

	try {
		decoded = decodeURIComponent(value);
	} catch (_) {
		decoded = value;
	}

	let match = decoded.match(/arxiv\.org\/(?:pdf|abs|html)\/([^?#\s]+)/i);
	if (match && match[1]) return cleanArxivId(match[1]);

	match = decoded.match(/[?&](?:id_list|id)=([^&#\s]+)/i);
	if (match && match[1]) return cleanArxivId(match[1]);

	match = decoded.match(
		/(?:^|\s)arXiv:([a-z\-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i
	);
	if (match && match[1]) return cleanArxivId(match[1]);

	return "";
}

function cleanArxivId(value) {
	let id = String(value || "").trim();

	id = id.replace(/\.pdf$/i, "");
	id = id.replace(/^arXiv:/i, "");
	id = id.replace(/^abs\//i, "");
	id = id.replace(/^pdf\//i, "");
	id = id.split(/[?#]/)[0];
	id = id.replace(/v\d+$/i, "");

	return id;
}

async function fetchArxivMetadata(arxivId) {
	const cleanId = cleanArxivId(arxivId);

	try {
		const apiMetadata = await fetchArxivMetadataFromApi(cleanId);

		if (
			isUsablePaperTitle(apiMetadata.title) &&
			!isArxivLikeTitle(apiMetadata.title, cleanId)
		) {
			return apiMetadata;
		}
	} catch (error) {
		console.warn(
			"treasure-hub: arXiv API metadata request failed; trying arXiv abs page fallback.",
			error
		);
	}

	return await fetchArxivMetadataFromAbsPage(cleanId);
}

async function fetchArxivMetadataFromApi(arxivId) {
	const cleanId = cleanArxivId(arxivId);

	const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(
		cleanId
	)}`;

	const response = await requestUrl({
		url: apiUrl,
		method: "GET",
		headers: {
			Accept: "application/atom+xml, application/xml, text/xml, */*",
		},
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`arXiv API returned HTTP ${response.status}`);
	}

	const xml = response.text || "";
	const entryMatch = xml.match(/<entry[\s\S]*?<\/entry>/i);

	if (!entryMatch) {
		throw new Error("arXiv API response did not contain an entry.");
	}

	const entry = entryMatch[0];

	const title = normalizeWhitespace(
		decodeXml(extractFirstXmlTag(entry, "title"))
	);

	const authors = [];

	const authorRegex =
		/<author[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi;

	let match;

	while ((match = authorRegex.exec(entry)) !== null) {
		const name = normalizeWhitespace(decodeXml(match[1]));
		if (name) authors.push(name);
	}

	let idFromEntry = cleanId;
	const idTag = extractFirstXmlTag(entry, "id");
	const idMatch = idTag.match(/arxiv\.org\/abs\/([^\s<]+)/i);

	if (idMatch && idMatch[1]) {
		idFromEntry = cleanArxivId(idMatch[1]);
	}

	return {
		title,
		authors: normalizeAuthors(authors),
		arxiv: idFromEntry,
	};
}

async function fetchArxivMetadataFromAbsPage(arxivId) {
	const cleanId = cleanArxivId(arxivId);
	const absUrl = `https://arxiv.org/abs/${encodeURIComponent(cleanId)}`;

	const response = await requestUrl({
		url: absUrl,
		method: "GET",
		headers: {
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`arXiv abs page returned HTTP ${response.status}`);
	}

	const html = response.text || "";

	const title = extractArxivTitleFromAbsHtml(html);
	const authors = extractArxivAuthorsFromAbsHtml(html);

	return {
		title,
		authors: normalizeAuthors(authors),
		arxiv: cleanId,
	};
}

function extractArxivTitleFromAbsHtml(html) {
	const text = String(html || "");

	const titleMatch = text.match(
		/<h1[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*\bdescriptor\b[^"']*["'][^>]*>\s*Title:\s*<\/span>([\s\S]*?)<\/h1>/i
	);

	if (titleMatch && titleMatch[1]) {
		return normalizeWhitespace(decodeHtml(stripHtmlTags(titleMatch[1])));
	}

	const fallbackTitleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

	if (fallbackTitleMatch && fallbackTitleMatch[1]) {
		return normalizeWhitespace(
			decodeHtml(stripHtmlTags(fallbackTitleMatch[1]))
				.replace(/^\[[^\]]+\]\s*/, "")
				.replace(/\s*\|\s*arXiv.*$/i, "")
		);
	}

	return "";
}

function extractArxivAuthorsFromAbsHtml(html) {
	const text = String(html || "");
	const authors = [];

	const authorsBlockMatch = text.match(
		/<div[^>]*class=["'][^"']*\bauthors\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
	);

	if (!authorsBlockMatch || !authorsBlockMatch[1]) {
		return authors;
	}

	const block = authorsBlockMatch[1];
	const authorRegex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;

	let match;

	while ((match = authorRegex.exec(block)) !== null) {
		const author = normalizeWhitespace(decodeHtml(stripHtmlTags(match[1])));

		if (author) {
			authors.push(author);
		}
	}

	return authors;
}

function stripHtmlTags(value) {
	return String(value || "").replace(/<[^>]*>/g, " ");
}

function decodeHtml(value) {
	return String(value || "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
			String.fromCodePoint(parseInt(hex, 16))
		)
		.replace(/&#(\d+);/g, (_, num) =>
			String.fromCodePoint(parseInt(num, 10))
		)
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function extractFirstXmlTag(xml, tagName) {
	const regex = new RegExp(
		`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
		"i"
	);

	const match = String(xml || "").match(regex);

	return match ? match[1] : "";
}

function decodeXml(value) {
	return String(value || "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/* ---------------- PDF download helper ---------------- */

async function fetchPdfArrayBuffer(pdfUrl) {
	const response = await requestUrl({
		url: pdfUrl,
		method: "GET",
		headers: {
			Accept: "application/pdf, application/octet-stream, */*",
		},
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`PDF request returned HTTP ${response.status}`);
	}

	if (!response.arrayBuffer) {
		throw new Error("PDF response did not include binary data.");
	}

	return response.arrayBuffer;
}

/* ---------------- Text and path helpers ---------------- */

function splitAuthorString(value) {
	let text = normalizeWhitespace(value || "");

	if (!text) return [];

	text = text.replace(/\s+and\s+/gi, ", ");
	text = text.replace(/\s*[;|]\s*/g, ", ");
	text = text.replace(/\s*,\s*$/, "");

	return text
		.split(/\s*,\s*/)
		.map((author) => author.replace(/\s*\d+$|\s*[†‡*§¶]+$/g, ""))
		.map(normalizeWhitespace)
		.filter(Boolean);
}

function normalizeAuthors(authors) {
	const list = Array.isArray(authors) ? authors : splitAuthorString(authors);
	const seen = new Set();
	const result = [];

	for (const author of list) {
		const normalized = normalizeWhitespace(
			String(author || "").replace(/\s*\d+$|\s*[†‡*§¶]+$/g, "")
		);

		if (!normalized) continue;

		const key = normalized.toLowerCase();

		if (seen.has(key)) continue;

		seen.add(key);
		result.push(normalized);
	}

	return result;
}

function normalizeWhitespace(value) {
	return String(value || "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function fixLeadingMethodDash(title) {
	return String(title || "").replace(
		/^([A-Z][A-Za-z0-9]{1,30})\s*[-–—]\s+([A-Z])/,
		"$1: $2"
	);
}

function deriveTitleFromUrl(url) {
	const arxivId = extractArxivId(url);

	if (arxivId) {
		return `arXiv ${arxivId}`;
	}

	try {
		const parsed = new URL(url);

		const last = decodeURIComponent(
			parsed.pathname.split("/").filter(Boolean).pop() || "paper"
		);

		return last.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ");
	} catch (_) {
		return "paper";
	}
}

function sanitizeFileName(title, maxLength) {
	let name = normalizeWhitespace(title || "");

	name = name.replace(/[:：]/g, "");
	name = name.replace(/[\\/*?"<>|#^\[\]]/g, " ");
	name = name.replace(/[\x00-\x1f]/g, " ");
	name = name.replace(/\s+/g, " ").trim();
	name = name.replace(/[. ]+$/g, "");

	if (!name) {
		name = "paper";
	}

	const limit = maxLength || 140;

	if (name.length > limit) {
		name = name.slice(0, limit).trim().replace(/[. ]+$/g, "");
	}

	return name || "paper";
}

function sanitizeVaultFolderPath(path) {
	const value = normalizePath(String(path || "").trim())
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");

	if (!value) return "";

	const parts = value.split("/").filter(Boolean);

	if (parts.includes("..")) {
		throw new Error(`Unsafe folder path: ${path}`);
	}

	return parts.join("/");
}

function sanitizeVaultFilePath(path) {
	const value = normalizePath(String(path || "").trim()).replace(/^\/+/, "");

	if (!value) return "";

	const parts = value.split("/").filter(Boolean);

	if (parts.includes("..")) {
		throw new Error(`Unsafe file path: ${path}`);
	}

	return parts.join("/");
}

async function ensureFolder(app, folderPath) {
	const folder = sanitizeVaultFolderPath(folderPath);

	if (!folder) return;

	const parts = folder.split("/").filter(Boolean);
	let current = "";

	for (const part of parts) {
		current = current ? `${current}/${part}` : part;

		const exists = await app.vault.adapter.exists(current);

		if (!exists) {
			await app.vault.createFolder(current);
		}
	}
}

async function ensureAdapterFolder(app, folderPath) {
	const folder = sanitizeVaultFolderPath(folderPath);

	if (!folder) return;

	const adapter = app.vault.adapter;
	const parts = folder.split("/").filter(Boolean);
	let current = "";

	for (const part of parts) {
		current = current ? `${current}/${part}` : part;

		const exists = await adapter.exists(current);

		if (!exists) {
			if (typeof adapter.mkdir === "function") {
				await adapter.mkdir(current);
			} else {
				await app.vault.createFolder(current);
			}
		}
	}
}

async function getAvailableAdapterPath(app, folderPath, baseName, extension) {
	const folder = sanitizeVaultFolderPath(folderPath);
	const safeBase = sanitizeFileName(baseName, 140);
	const ext = String(extension || "").replace(/^\./, "");

	let counter = 1;

	while (true) {
		const suffix = counter === 1 ? "" : ` ${counter}`;
		const fileName = `${safeBase}${suffix}.${ext}`;
		const fullPath = normalizePath(folder ? `${folder}/${fileName}` : fileName);

		if (!(await app.vault.adapter.exists(fullPath))) {
			return fullPath;
		}

		counter += 1;
	}
}

async function getAvailableVaultPath(app, folderPath, baseName, extension) {
	const folder = sanitizeVaultFolderPath(folderPath);
	const safeBase = sanitizeFileName(baseName, 140);
	const ext = String(extension || "").replace(/^\./, "");

	let counter = 1;

	while (true) {
		const suffix = counter === 1 ? "" : ` ${counter}`;
		const fileName = `${safeBase}${suffix}.${ext}`;
		const fullPath = normalizePath(folder ? `${folder}/${fileName}` : fileName);

		if (!(await app.vault.adapter.exists(fullPath))) {
			return fullPath;
		}

		counter += 1;
	}
}

/* ---------------- Template and YAML helpers ---------------- */

function extractMarkdownBody(templateContent) {
	const content = String(templateContent || "");

	if (!content.startsWith("---")) {
		return content;
	}

	const match = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/);

	if (!match) {
		return content;
	}

	return content.slice(match[0].length);
}

function normalizeTemplateBodyForAppend(body) {
	const value = String(body || "");

	if (!value) {
		return "\n";
	}

	return value.startsWith("\n") ? value : `\n${value}`;
}

function buildOrderedFrontmatter(data) {
	const lines = ["---"];

	lines.push(`read: ${data.read ? "true" : "false"}`);
	lines.push(`title: ${yamlString(data.title || "")}`);

	pushYamlArray(lines, "authors", normalizeAuthors(data.authors || []));
	pushYamlArray(lines, "labs", normalizeStringArray(data.labs || []));
	pushYamlStringOrBlank(lines, "affiliation", data.affiliation || "");

	lines.push(`arxiv: ${yamlString(data.arxiv || "")}`);
	lines.push(`pdf_url: ${yamlString(data.pdf_url || "")}`);
	lines.push(`pdf: ${yamlString(data.pdf || "")}`);
	lines.push(`image: ${yamlString(data.image || "")}`);
	pushYamlStringOrBlank(lines, "Date", data.Date || data.date || "");

	pushYamlArray(lines, "key_words", normalizeStringArray(data.key_words || []));
	lines.push(`the_truth: ${yamlString(data.the_truth || "")}`);

	lines.push("---");

	return lines.join("\n");
}

function pushYamlStringOrBlank(lines, key, value) {
	const text = normalizeWhitespace(value);
	lines.push(text ? `${key}: ${yamlString(text)}` : `${key}:`);
}

function pushYamlArray(lines, key, values) {
	const list = Array.isArray(values) ? values.filter(Boolean) : [];

	if (list.length === 0) {
		lines.push(`${key}: []`);
		return;
	}

	lines.push(`${key}:`);

	for (const value of list) {
		lines.push(`  - ${yamlString(value)}`);
	}
}

function yamlString(value) {
	const text = String(value || "")
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r?\n/g, " ");

	return `"${text}"`;
}
