import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface FileReference {
    id: string;
    path: string;
    name: string;
    lineRange: string;
    content: string;
    type: 'file' | 'selection';
}

export interface PlatformConfig {
    platform: string;
    url: string;
}

// 快捷用语接口
export interface QuickPhrase {
    id: string;
    content: string;
    category: string;
}

// 快捷用语分类接口
export interface QuickPhraseCategory {
    id: string;
    name: string;
    isDefault: boolean;
}

// 默认平台预设配置
const DEFAULT_PLATFORM_PRESETS: PlatformConfig[] = [
    { platform: 'Kimi', url: 'https://kimi.moonshot.cn' },
    { platform: 'ChatGPT', url: 'https://chat.openai.com' },
    { platform: 'Claude', url: 'https://claude.ai' },
    { platform: 'Gemini', url: 'https://gemini.google.com' },
    { platform: '通义千问', url: 'https://tongyi.aliyun.com' }
];

interface BatchExportSettings {
    exportMdEnabled: boolean;
}

interface ExportManifestEntry {
    exportedRelativePath: string;
    originalPath: string;
}

interface ExportManifest {
    timestamp: string;
    rootPath: string;
    createdAt: string;
    entries: ExportManifestEntry[];
    mdFile?: string;
}

interface LatestExportSession {
    timestamp: string;
    rootPath: string;
    exportDir: string;
    manifestPath: string;
}

interface McpServerConfig {
    command: string;
    args: string[];
    enabled: boolean;
    locked?: boolean;
}

interface McpConfigState {
    mcpServers: Record<string, McpServerConfig>;
    executor: string;
}

interface McpToolInfo {
    name: string;
}

interface McpRuntimeSummary {
    status: 'stopped' | 'starting' | 'ready' | 'error';
    lastError?: string;
}

interface McpRuntimeState extends McpRuntimeSummary {
    client?: StdioMcpClient;
    startPromise?: Promise<StdioMcpClient | undefined>;
}

const BATCH_EXPORT_SETTINGS_KEY = 'aiUploaderBatchExportSettings';
const LATEST_EXPORT_SESSIONS_KEY = 'aiUploaderLatestExportSessions';
const MCP_CONFIG_KEY = 'aiUploaderMcpConfig';
const BUILTIN_CHROME_MCP_NAME = 'chrome-devtools';
const BUILTIN_CHROME_MCP_CONFIG: McpServerConfig = {
    command: 'npx',
    args: ['-y', '--prefer-offline', 'chrome-devtools-mcp@0.21.0', '--isolated'],
    enabled: true,
    locked: true
};

export class AIPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiUploaderPanel';

    private _view?: vscode.WebviewView;
    private _fileReferences: Map<string, FileReference> = new Map();
    private _context: vscode.ExtensionContext;
    private _platformConfig: PlatformConfig;
    private _platformPresets: PlatformConfig[] = [];
    private _batchExportSettings: BatchExportSettings;
    private _mcpConfig: McpConfigState;
    private _mcpRuntimes: Record<string, McpRuntimeState> = {};

    constructor(
        private readonly _extensionUri: vscode.Uri,
        context: vscode.ExtensionContext
    ) {
        this._context = context;
        this._platformPresets = this._loadPlatformPresets();
        this._platformConfig = this._loadPlatformConfig();
        this._batchExportSettings = this._loadBatchExportSettings();
        this._mcpConfig = this._loadMcpConfig();

        if (!this._context.globalState.get(BATCH_EXPORT_SETTINGS_KEY)) {
            void this._context.globalState.update(BATCH_EXPORT_SETTINGS_KEY, this._batchExportSettings);
        }
        if (!this._context.globalState.get(MCP_CONFIG_KEY)) {
            void this._context.globalState.update(MCP_CONFIG_KEY, this._mcpConfig);
        }
    }

    // 默认快捷用语分类
    private readonly DEFAULT_CATEGORIES: QuickPhraseCategory[] = [
        { id: 'default', name: '默认分类', isDefault: true },
    ];

    // 默认快捷用语
    private readonly DEFAULT_PHRASES: QuickPhrase[] = [
        { id: '1', content: '请补充中文解释', category: 'default' },
        { id: '2', content: '请分析代码存在的问题', category: 'default' },
        { id: '3', content: '解耦拆分ts文件', category: 'default' },
        { id: '4', content: '请将代码简化', category: 'default' },
        { id: '5', content: '请直接基于源码修改', category: 'default' }
    ];

    // 加载快捷用语分类
    private _loadCategories(): QuickPhraseCategory[] {
        const categories = this._context.globalState.get<QuickPhraseCategory[]>('aiUploaderCategories');
        if (categories && categories.length > 0) {
            return categories;
        }
        return [...this.DEFAULT_CATEGORIES];
    }

    // 加载快捷用语
    private _loadQuickPhrases(): QuickPhrase[] {
        const phrases = this._context.globalState.get<QuickPhrase[]>('aiUploaderQuickPhrases');
        if (phrases && phrases.length > 0) {
            return phrases;
        }
        return [...this.DEFAULT_PHRASES];
    }

    // 保存快捷用语分类
    private async _saveCategories(categories: QuickPhraseCategory[]): Promise<void> {
        await this._context.globalState.update('aiUploaderCategories', categories);
    }

    // 保存快捷用语
    private async _saveQuickPhrases(phrases: QuickPhrase[]): Promise<void> {
        await this._context.globalState.update('aiUploaderQuickPhrases', phrases);
    }

    // 加载平台预设列表
    private _loadPlatformPresets(): PlatformConfig[] {
        const presets = this._context.globalState.get<PlatformConfig[]>('aiUploaderPlatformPresets');
        if (presets && presets.length > 0) {
            return presets;
        }
        // 默认使用预设列表
        return [...DEFAULT_PLATFORM_PRESETS];
    }

    // 保存平台预设列表
    private async _savePlatformPresets(presets: PlatformConfig[]): Promise<void> {
        this._platformPresets = presets;
        await this._context.globalState.update('aiUploaderPlatformPresets', presets);
    }

    // 加载平台配置
    private _loadPlatformConfig(): PlatformConfig {
        const config = this._context.globalState.get<PlatformConfig>('aiUploaderPlatformConfig');
        if (config) {
            // 检查是否存在于当前预设列表中
            const exists = this._platformPresets.some(p => p.platform === config.platform && p.url === config.url);
            if (exists) {
                return config;
            }
        }
        // 默认使用第一个预设
        return this._platformPresets[0] || DEFAULT_PLATFORM_PRESETS[0];
    }

    // 保存平台配置
    private async _savePlatformConfig(config: PlatformConfig): Promise<void> {
        this._platformConfig = config;
        await this._context.globalState.update('aiUploaderPlatformConfig', config);
    }

    // 发送平台配置到 webview
    private _sendPlatformConfig() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updatePlatformConfig',
                config: this._platformConfig,
                presets: this._platformPresets
            });
        }
    }

    private _loadBatchExportSettings(): BatchExportSettings {
        const settings = this._context.globalState.get<BatchExportSettings>(BATCH_EXPORT_SETTINGS_KEY);
        return {
            exportMdEnabled: settings?.exportMdEnabled === true
        };
    }

    private async _saveBatchExportSettings(settings: BatchExportSettings): Promise<void> {
        this._batchExportSettings = {
            exportMdEnabled: settings.exportMdEnabled === true
        };
        await this._context.globalState.update(BATCH_EXPORT_SETTINGS_KEY, this._batchExportSettings);
        this._sendBatchExportSettings();
    }

    private _sendBatchExportSettings() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateBatchExportSettings',
                settings: this._batchExportSettings
            });
        }
    }

    private _loadLatestExportSessions(): Record<string, LatestExportSession> {
        return this._context.globalState.get<Record<string, LatestExportSession>>(LATEST_EXPORT_SESSIONS_KEY) || {};
    }

    private async _saveLatestExportSessions(sessions: Record<string, LatestExportSession>): Promise<void> {
        await this._context.globalState.update(LATEST_EXPORT_SESSIONS_KEY, sessions);
    }

    private _normalizeMcpConfig(config?: Partial<McpConfigState>): McpConfigState {
        const normalizedServers: Record<string, McpServerConfig> = {};
        const sourceServers = config?.mcpServers || {};

        for (const [name, server] of Object.entries(sourceServers)) {
            if (!server || typeof server.command !== 'string' || !server.command.trim()) {
                continue;
            }
            let args = Array.isArray(server.args) ? server.args.filter(arg => typeof arg === 'string') : [];
            if (server.command.trim().toLowerCase() === 'npx' && !args.some(arg => arg === '-y' || arg === '--yes')) {
                args = ['-y', ...args];
            }
            normalizedServers[name] = {
                command: server.command,
                args,
                enabled: server.enabled !== false,
                locked: server.locked === true
            };
        }

        normalizedServers[BUILTIN_CHROME_MCP_NAME] = {
            ...BUILTIN_CHROME_MCP_CONFIG,
            enabled: true,
            locked: true
        };

        const valid = new Set(Object.keys(normalizedServers));
        for (const name of Object.keys(this._mcpRuntimes)) {
            if (!valid.has(name)) {
                delete this._mcpRuntimes[name];
            }
        }

        const requestedExecutor = config?.executor;
        const executor = requestedExecutor && normalizedServers[requestedExecutor]
            ? requestedExecutor
            : BUILTIN_CHROME_MCP_NAME;

        return {
            mcpServers: normalizedServers,
            executor
        };
    }

    private _getMcpRuntimeSummary(name: string): McpRuntimeSummary {
        const runtime = this._mcpRuntimes[name];
        if (!runtime) {
            return { status: 'stopped' };
        }

        return {
            status: runtime.status,
            lastError: runtime.lastError
        };
    }

    private _getReadyMcpClient(name: string): StdioMcpClient | undefined {
        const runtime = this._mcpRuntimes[name];
        if (runtime && runtime.status === 'ready') {
            return runtime.client;
        }
        return undefined;
    }

    private _sendMcpRuntimeStatus(): void {
        if (!this._view) {
            return;
        }

        const runtimeSummary: Record<string, McpRuntimeSummary> = {};
        for (const name of Object.keys(this._mcpConfig.mcpServers)) {
            runtimeSummary[name] = this._getMcpRuntimeSummary(name);
        }

        this._view.webview.postMessage({
            type: 'updateMcpRuntimeStatus',
            runtime: runtimeSummary
        });
    }

    private async _ensureMcpRuntime(name: string, server: McpServerConfig): Promise<StdioMcpClient | undefined> {
        if (!server.enabled) {
            this._mcpRuntimes[name] = { status: 'error', lastError: 'Server disabled' };
            this._sendMcpRuntimeStatus();
            return undefined;
        }

        let runtime = this._mcpRuntimes[name];
        if (!runtime) {
            runtime = { status: 'stopped' };
            this._mcpRuntimes[name] = runtime;
        }

        if (runtime.status === 'ready' && runtime.client) {
            return runtime.client;
        }

        if (runtime.status === 'starting' && runtime.startPromise) {
            return runtime.startPromise;
        }

        runtime.status = 'starting';
        runtime.lastError = undefined;
        this._sendMcpRuntimeStatus();

        const startPromise = (async () => {
            const client = new StdioMcpClient(server.command, server.args, () => {
                const target = this._mcpRuntimes[name];
                if (target) {
                    target.status = 'stopped';
                    target.client = undefined;
                    this._sendMcpRuntimeStatus();
                }
            });

            try {
                await client.start();
                await client.initialize();
                runtime.client = client;
                runtime.status = 'ready';
                runtime.lastError = undefined;
                return client;
            } catch (error) {
                runtime.status = 'error';
                runtime.lastError = String(error);
                runtime.client = undefined;
                return undefined;
            } finally {
                runtime.startPromise = undefined;
                this._sendMcpRuntimeStatus();
            }
        })();

        runtime.startPromise = startPromise;
        return startPromise;
    }

    private async _startMcpServer(name: string): Promise<void> {
        const server = this._mcpConfig.mcpServers[name];
        if (!server) {
            return;
        }

        const client = await this._ensureMcpRuntime(name, server);
        if (client) {
            vscode.window.showInformationMessage(`MCP ${name} 已启动`);
        } else {
            vscode.window.showWarningMessage(`无法启动 MCP ${name}，请检查配置`);
        }
    }


    private _loadMcpConfig(): McpConfigState {
        const stored = this._context.globalState.get<McpConfigState>(MCP_CONFIG_KEY);
        return this._normalizeMcpConfig(stored);
    }

    private async _saveMcpConfig(config: McpConfigState): Promise<void> {
        this._mcpConfig = this._normalizeMcpConfig(config);
        await this._context.globalState.update(MCP_CONFIG_KEY, this._mcpConfig);
        this._sendMcpConfig();
    }

    private _sendMcpConfig() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateMcpConfig',
                config: this._mcpConfig
            });
        }
        this._sendMcpRuntimeStatus();
    }

    private async _addMcpServersByJson(rawJson: string): Promise<void> {
        if (!rawJson || !rawJson.trim()) {
            vscode.window.showWarningMessage('Please input a valid MCP JSON config');
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawJson);
        } catch (error) {
            vscode.window.showErrorMessage('Failed to parse MCP JSON: ' + String(error));
            return;
        }

        if (!parsed || typeof parsed !== 'object') {
            vscode.window.showErrorMessage('Invalid JSON format: expected an object');
            return;
        }

        const parsedConfig = parsed as {
            mcpServers?: Record<string, Partial<McpServerConfig>>;
            servers?: Record<string, Partial<McpServerConfig>>;
        };
        const candidateServers = parsedConfig.mcpServers || parsedConfig.servers;
        if (!candidateServers || typeof candidateServers !== 'object') {
            vscode.window.showErrorMessage('Invalid JSON format: missing mcpServers or servers object');
            return;
        }

        const nextConfig: McpConfigState = {
            mcpServers: { ...this._mcpConfig.mcpServers },
            executor: this._mcpConfig.executor
        };

        let addCount = 0;
        for (const [name, server] of Object.entries(candidateServers)) {
            if (!server || typeof server.command !== 'string' || !server.command.trim()) {
                continue;
            }
            if (name === BUILTIN_CHROME_MCP_NAME) {
                continue;
            }

            let args = Array.isArray(server.args) ? server.args.filter(arg => typeof arg === 'string') : [];
            if (server.command.trim().toLowerCase() === 'npx' && !args.some(arg => arg === '-y' || arg === '--yes')) {
                args = ['-y', ...args];
            }
            nextConfig.mcpServers[name] = {
                command: server.command,
                args,
                enabled: server.enabled !== false,
                locked: false
            };
            addCount++;
        }

        if (addCount === 0) {
            vscode.window.showWarningMessage('No valid MCP server config found to add');
            return;
        }

        await this._saveMcpConfig(nextConfig);
        vscode.window.showInformationMessage('Saved ' + addCount + ' MCP server entries');
    }

    private async _updateMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
        const server = this._mcpConfig.mcpServers[name];
        if (!server) {
            return;
        }

        if (server.locked || name === BUILTIN_CHROME_MCP_NAME) {
            vscode.window.showWarningMessage('Built-in chrome-devtools MCP is always enabled and cannot be disabled');
            this._sendMcpConfig();
            return;
        }

        const nextConfig: McpConfigState = {
            mcpServers: { ...this._mcpConfig.mcpServers },
            executor: this._mcpConfig.executor
        };
        nextConfig.mcpServers[name] = {
            ...server,
            enabled
        };

        if (!enabled && nextConfig.executor === name) {
            nextConfig.executor = BUILTIN_CHROME_MCP_NAME;
        }

        await this._saveMcpConfig(nextConfig);
    }

    private async _setMcpExecutor(name: string): Promise<void> {
        const server = this._mcpConfig.mcpServers[name];
        if (!server) {
            return;
        }

        if (!server.enabled && name !== BUILTIN_CHROME_MCP_NAME) {
            vscode.window.showWarningMessage('Please enable this MCP server before setting it as executor');
            return;
        }

        const nextConfig: McpConfigState = {
            mcpServers: { ...this._mcpConfig.mcpServers },
            executor: name
        };
        await this._saveMcpConfig(nextConfig);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 处理来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'removeFile':
                    this._fileReferences.delete(data.id);
                    this._updateFileList();
                    break;
                case 'copyInstruction':
                    await this._copyToClipboard(data.content);
                    break;
                case 'openBrowser':
                    await this._openBrowser(data.content);
                    break;
                case 'exportFiles':
                    await this._exportFiles(data.content);
                    break;
                case 'batchExportFiles':
                    await this._batchExportFiles(data.content, data.exportMdEnabled);
                    break;
                case 'clearAll':
                    this.clearAll();
                    break;
                case 'getFileList':
                    this._updateFileList();
                    break;
                case 'updatePlatformConfig':
                    await this._savePlatformConfig(data.config);
                    break;
                case 'getPlatformPresets':
                    this._sendPlatformConfig();
                    break;
                case 'addPlatformPreset':
                    await this._addPlatformPreset(data.preset);
                    break;
                case 'updatePlatformPreset':
                    await this._updatePlatformPreset(data.preset);
                    break;
                case 'deletePlatformPresets':
                    await this._deletePlatformPresets(data.platforms);
                    break;
                case 'selectFilesFromWorkspace':
                    await this._selectFilesFromWorkspace();
                    break;
                case 'dropFiles':
                    await this._handleDroppedFiles(data.files || data.uris || []);
                    break;
                case 'getQuickPhrases':
                    this._sendQuickPhrases();
                    break;
                case 'addQuickPhrase':
                    await this._addQuickPhrase(data.phrase);
                    break;
                case 'updateQuickPhrase':
                    await this._updateQuickPhrase(data.phrase);
                    break;
                case 'deleteQuickPhrases':
                    await this._deleteQuickPhrases(data.ids);
                    break;
                case 'addCategory':
                    await this._addCategory(data.category);
                    break;
                case 'deleteCategories':
                    await this._deleteCategories(data.ids);
                    break;
                case 'overwriteFiles':
                    await this._overwriteFiles();
                    break;
                case 'addFilesByPath':
                    await this._addFilesByPath(data.paths);
                    break;
                case 'getBatchExportSettings':
                    this._sendBatchExportSettings();
                    break;
                case 'updateBatchExportSettings':
                    await this._saveBatchExportSettings(data.settings || { exportMdEnabled: data.exportMdEnabled === true });
                    break;
                case 'getMcpConfig':
                    this._sendMcpConfig();
                    break;
                case 'addMcpServersByJson':
                    await this._addMcpServersByJson(data.json);
                    break;
                case 'updateMcpServerEnabled':
                    await this._updateMcpServerEnabled(data.name, data.enabled === true);
                    break;
                case 'setMcpExecutor':
                    await this._setMcpExecutor(data.name);
                    break;
                case 'startMcpServer':
                    await this._startMcpServer(data.name);
                    break;
            }
        });

        // 初始化时更新文件列表和平台配置
        this._updateFileList();
        this._sendPlatformConfig();
        this._sendQuickPhrases();
        this._sendBatchExportSettings();
        this._sendMcpConfig();
    }

    // 发送快捷用语到 webview
    private _sendQuickPhrases() {
        if (this._view) {
            const phrases = this._loadQuickPhrases();
            const categories = this._loadCategories();
            this._view.webview.postMessage({
                type: 'updateQuickPhrases',
                phrases: phrases,
                categories: categories
            });
        }
    }

    // 添加快捷用语
    private async _addQuickPhrase(phrase: QuickPhrase): Promise<void> {
        const phrases = this._loadQuickPhrases();
        phrases.push(phrase);
        await this._saveQuickPhrases(phrases);
        this._sendQuickPhrases();
    }

    // 更新快捷用语
    private async _updateQuickPhrase(updatedPhrase: QuickPhrase): Promise<void> {
        const phrases = this._loadQuickPhrases();
        const index = phrases.findIndex(p => p.id === updatedPhrase.id);
        if (index !== -1) {
            phrases[index] = updatedPhrase;
            await this._saveQuickPhrases(phrases);
            this._sendQuickPhrases();
        }
    }

    // 删除快捷用语
    private async _deleteQuickPhrases(ids: string[]): Promise<void> {
        const phrases = this._loadQuickPhrases();
        const filtered = phrases.filter(p => !ids.includes(p.id));
        await this._saveQuickPhrases(filtered);

        // 清理空分类
        await this._cleanupEmptyCategories();

        this._sendQuickPhrases();
    }

    // 添加分类
    private async _addCategory(category: QuickPhraseCategory): Promise<void> {
        const categories = this._loadCategories();
        categories.push(category);
        await this._saveCategories(categories);
        this._sendQuickPhrases();
    }

    // 删除分类
    private async _deleteCategories(ids: string[]): Promise<void> {
        const categories = this._loadCategories();
        const filtered = categories.filter(c => !ids.includes(c.id) && !c.isDefault);
        await this._saveCategories(filtered);

        // 同时删除该分类下的快捷用语
        const phrases = this._loadQuickPhrases();
        const filteredPhrases = phrases.filter(p => !ids.includes(p.category));
        await this._saveQuickPhrases(filteredPhrases);

        this._sendQuickPhrases();
    }

    // 清理空分类（非默认分类且没有指令的分类）
    private async _cleanupEmptyCategories(): Promise<void> {
        const categories = this._loadCategories();
        const phrases = this._loadQuickPhrases();

        // 找出有指令的分类
        const categoriesWithPhrases = new Set(phrases.map(p => p.category));

        // 保留默认分类或有指令的分类
        const filteredCategories = categories.filter(c =>
            c.isDefault || categoriesWithPhrases.has(c.id)
        );

        // 如果有变化则保存
        if (filteredCategories.length !== categories.length) {
            await this._saveCategories(filteredCategories);
        }
    }

    // 添加平台预设
    private async _addPlatformPreset(preset: PlatformConfig): Promise<void> {
        console.log('[AI Uploader] 添加平台预设:', preset);
        const presets = this._loadPlatformPresets();
        console.log('[AI Uploader] 当前预设列表:', presets);
        // 检查是否已存在相同名称的预设
        const exists = presets.some(p => p.platform === preset.platform);
        if (exists) {
            console.log('[AI Uploader] 站点已存在:', preset.platform);
            vscode.window.showWarningMessage(`站点 "${preset.platform}" 已存在`);
            return;
        }
        presets.push(preset);
        await this._savePlatformPresets(presets);
        console.log('[AI Uploader] 预设已保存，新列表:', this._platformPresets);
        this._sendPlatformConfig();
        console.log('[AI Uploader] 已发送配置到 webview');
    }

    // 更新平台预设
    private async _updatePlatformPreset(updatedPreset: PlatformConfig): Promise<void> {
        const presets = this._loadPlatformPresets();
        const index = presets.findIndex(p => p.platform === updatedPreset.platform);
        if (index !== -1) {
            presets[index] = updatedPreset;
            await this._savePlatformPresets(presets);
            // 如果当前选中的配置被更新了，也更新当前配置
            if (this._platformConfig.platform === updatedPreset.platform) {
                this._platformConfig = { ...updatedPreset };
                await this._savePlatformConfig(this._platformConfig);
            }
            this._sendPlatformConfig();
        }
    }

    // 删除平台预设
    private async _deletePlatformPresets(platformNames: string[]): Promise<void> {
        const presets = this._loadPlatformPresets();
        const filtered = presets.filter(p => !platformNames.includes(p.platform));
        await this._savePlatformPresets(filtered);

        // 如果当前选中的配置被删除了，切换到第一个预设
        if (platformNames.includes(this._platformConfig.platform)) {
            const newConfig = filtered[0] || DEFAULT_PLATFORM_PRESETS[0];
            await this._savePlatformConfig(newConfig);
        }

        this._sendPlatformConfig();
    }

    // 添加文件引用 - 修复：相同文件不同行号时合并
    public addFileReference(reference: FileReference) {
        // 检查是否已存在相同文件路径（根据 path 而非 id）
        let existingRef: FileReference | undefined;
        for (const ref of this._fileReferences.values()) {
            if (ref.path === reference.path) {
                existingRef = ref;
                break;
            }
        }

        if (existingRef) {
            // 已存在相同文件，合并行号
            const existingLines = this._parseLineRanges(existingRef.lineRange);
            const newLines = this._parseLineRanges(reference.lineRange);

            // 合并行号（使用 Set 去重）
            const mergedLines = new Set([...existingLines, ...newLines]);

            // 更新内容 - 如果新引用是选中内容，追加到后面
            let mergedContent = existingRef.content;
            if (reference.type === 'selection' && reference.content !== existingRef.content) {
                mergedContent += '\n\n// --- 额外选中内容 ---\n' + reference.content;
            }

            // 格式化合并后的行号范围
            const mergedLineRange = this._formatLineRanges(mergedLines);

            // 更新引用
            existingRef.lineRange = mergedLineRange;
            existingRef.content = mergedContent;

            vscode.window.showInformationMessage(
                `已合并到现有文件: ${reference.name} (行号: ${mergedLineRange})`
            );
        } else {
            // 新文件，直接添加（使用 id 作为 key）
            this._fileReferences.set(reference.id, reference);
        }

        this._updateFileList();
    }

    // 解析行号范围字符串为行号数组
    private _parseLineRanges(rangeStr: string): number[] {
        const lines: number[] = [];
        const parts = rangeStr.split(',');

        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.includes('-')) {
                const [start, end] = trimmed.split('-').map(n => parseInt(n.trim()));
                for (let i = start; i <= end; i++) {
                    lines.push(i);
                }
            } else {
                lines.push(parseInt(trimmed));
            }
        }

        return lines;
    }

    // 将行号数组格式化为范围字符串
    private _formatLineRanges(lines: Set<number>): string {
        const sorted = Array.from(lines).sort((a, b) => a - b);
        if (sorted.length === 0) return '';
        if (sorted.length === 1) return `${sorted[0]}`;

        const ranges: string[] = [];
        let start = sorted[0];
        let end = sorted[0];

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === end + 1) {
                end = sorted[i];
            } else {
                ranges.push(start === end ? `${start}` : `${start}-${end}`);
                start = end = sorted[i];
            }
        }
        ranges.push(start === end ? `${start}` : `${start}-${end}`);

        return ranges.join(',');
    }

    // 清空所有引用
    public clearAll() {
        this._fileReferences.clear();
        this._updateFileList();
    }

    // 更新文件列表到 webview
    private _updateFileList() {
        if (this._view) {
            const files = Array.from(this._fileReferences.values());
            this._view.webview.postMessage({
                type: 'updateFileList',
                files: files
            });
        }
    }

    // 生成指令文本 - 只显示文件名和行号，不显示代码内容
    private _generateInstruction(): string {
        const files = Array.from(this._fileReferences.values());
        if (files.length === 0) {
            return '';
        }

        let instruction = '';

        // 当文件数>1时，添加目录结构
        if (files.length > 1) {
            instruction += '## 目录结构\n\n';
            instruction += this._generateDirectoryTree(files);
            instruction += '\n';
        }

        instruction += '## 引用文件\n\n';

        for (const file of files) {
            // 只有选中代码引用才显示行号范围
            if (file.type === 'selection') {
                instruction += `- ${file.name} (${file.lineRange})\n`;
            } else {
                instruction += `- ${file.name}\n`;
            }
        }

        instruction += '\n## 需求描述\n\n';
        instruction += '请分析以上文件并提供帮助。';

        return instruction;
    }

    // 生成目录树结构
    private _generateDirectoryTree(files: FileReference[]): string {
        // 获取所有文件路径
        const paths = files.map(f => f.path);

        // 找到共同根目录
        let commonRoot = this._findCommonRoot(paths);

        // 构建树结构
        const tree: { [key: string]: any } = {};

        for (const file of files) {
            const relativePath = file.path.substring(commonRoot.length).replace(/^[/\\]/, '');
            const parts = relativePath.split(/[/\\]/);

            let current = tree;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (i === parts.length - 1) {
                    // 文件
                    current[part] = null;
                } else {
                    // 目录
                    if (!current[part]) {
                        current[part] = {};
                    }
                    current = current[part];
                }
            }
        }

        // 渲染树为字符串
        return this._renderTree(tree, '');
    }

    // 找到共同根目录
    private _findCommonRoot(paths: string[]): string {
        if (paths.length === 0) return '';
        if (paths.length === 1) {
            const lastSlash = Math.max(paths[0].lastIndexOf('/'), paths[0].lastIndexOf('\\'));
            return lastSlash > 0 ? paths[0].substring(0, lastSlash) : '';
        }

        let common = paths[0];
        for (let i = 1; i < paths.length; i++) {
            while (!paths[i].startsWith(common)) {
                const lastSlash = Math.max(common.lastIndexOf('/'), common.lastIndexOf('\\'));
                if (lastSlash <= 0) return '';
                common = common.substring(0, lastSlash);
            }
        }
        return common;
    }

    // 渲染树结构为字符串
    private _renderTree(tree: { [key: string]: any }, prefix: string): string {
        const entries = Object.entries(tree).sort((a, b) => {
            // 目录排在文件前面
            const aIsDir = a[1] !== null && typeof a[1] === 'object';
            const bIsDir = b[1] !== null && typeof b[1] === 'object';
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a[0].localeCompare(b[0]);
        });

        let result = '';
        for (let i = 0; i < entries.length; i++) {
            const [name, value] = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = prefix + (isLast ? '    ' : '│   ');

            const isDir = value !== null && typeof value === 'object';
            const displayName = isDir ? name + '/' : name;

            result += prefix + connector + displayName + '\n';

            if (isDir) {
                result += this._renderTree(value, childPrefix);
            }
        }

        return result;
    }

    // 复制到剪贴板 - 使用用户编辑后的内容
    private async _copyToClipboard(content?: string): Promise<void> {
        // 优先使用用户编辑后的内容，如果没有则使用生成的内容
        const instruction = content || this._generateInstruction();
        if (!instruction || instruction.trim() === '') {
            vscode.window.showWarningMessage('没有可复制的文件引用');
            return;
        }

        vscode.window.showInformationMessage('指令已复制到剪贴板！');
    }

    // 打开浏览器
    private async _openBrowser(content?: string): Promise<void> {
        const instruction = (content && content.trim()) ? content : this._generateInstruction();
        if (!instruction || instruction.trim() === '') {
            vscode.window.showWarningMessage('No instruction content to send');
            return;
        }

        const url = this._platformConfig.url;
        if (!url || !url.trim()) {
            vscode.window.showWarningMessage('Please configure a target URL first');
            return;
        }

        const mcpSuccess = await this._openBrowserWithMcp(url, instruction);
        if (mcpSuccess) {
            vscode.window.showInformationMessage('Opened page, filled instruction, and submitted via MCP');
            return;
        }

        // MCP not ready: block action and prompt user to start MCP.
        vscode.window.showWarningMessage("MCP 未就绪：请在【配置MCP】中启动 chrome-devtools-mcp 后再重试。");
    }

    private async _openBrowserWithMcp(url: string, instruction: string): Promise<boolean> {
        const candidates = [this._mcpConfig.executor, BUILTIN_CHROME_MCP_NAME];
        const tried = new Set<string>();

        for (const name of candidates) {
            if (!name || tried.has(name)) {
                continue;
            }
            tried.add(name);

            const server = this._mcpConfig.mcpServers[name];
            if (!server) {
                continue;
            }
            if (!server.enabled && name !== BUILTIN_CHROME_MCP_NAME) {
                continue;
            }

            const success = await this._tryOpenBrowserWithMcpServer(name, server, url, instruction);
            if (success) {
                return true;
            }
        }

        return false;
    }

    private async _tryOpenBrowserWithMcpServer(
        serverName: string,
        server: McpServerConfig,
        url: string,
        instruction: string
    ): Promise<boolean> {
        const client = this._getReadyMcpClient(serverName);
        if (!client) {
            return false;
        }

        try {
            const tools = await client.listTools();

            const navigated = await this._tryNavigateWithMcp(client, tools, url);
            if (!navigated) {
                return false;
            }

            await this._sleep(1500);
            const filled = await this._tryFillInputWithMcp(client, tools, instruction);
            if (!filled) {
                return false;
            }

            await this._sleep(300);
            const submitted = await this._trySubmitInputWithMcp(client, tools, instruction);
            if (!submitted) {
                return false;
            }

            return true;
        } catch (error) {
            console.error('MCP browser automation failed for server: ' + serverName, error);
            return false;
        }
    }

    private async _tryNavigateWithMcp(client: StdioMcpClient, tools: McpToolInfo[], url: string): Promise<boolean> {
        const toolNames = tools.map(tool => tool.name);
        const newPageToolNames = toolNames
            .filter(name => /(new.?page|open.?page|new.?tab|open.?tab)/i.test(name));
        const navigationToolNames = toolNames
            .filter(name => /(navigate|goto)/i.test(name));

        const argumentGuesses: Array<Record<string, unknown>> = [
            { url },
            { uri: url },
            { pageUrl: url },
            { target: url },
            { href: url }
        ];

        if (await this._tryCallMcpTools(client, newPageToolNames, argumentGuesses)) {
            return true;
        }

        if (newPageToolNames.length > 0 && await this._tryCallMcpTools(client, newPageToolNames, [{}])) {
            await this._sleep(500);
            if (await this._tryCallMcpTools(client, navigationToolNames, argumentGuesses)) {
                return true;
            }
        }

        return this._tryCallMcpTools(client, navigationToolNames, argumentGuesses);
    }

    private async _tryCallMcpTools(
        client: StdioMcpClient,
        toolNames: string[],
        argumentGuesses: Array<Record<string, unknown>>
    ): Promise<boolean> {
        for (const toolName of toolNames) {
            for (const args of argumentGuesses) {
                try {
                    await client.callTool(toolName, args);
                    return true;
                } catch {
                    // Try next argument shape.
                }
            }
        }

        return false;
    }

    private async _tryFillInputWithMcp(client: StdioMcpClient, tools: McpToolInfo[], instruction: string): Promise<boolean> {
        const script = [
            '(function(){',
            'const text = ' + JSON.stringify(instruction) + ';',
            'const candidates = Array.from(document.querySelectorAll(\'textarea, [contenteditable="true"], input[type="text"]\'));',
            'const visible = candidates.filter((el) => {',
            '  const rect = el.getBoundingClientRect();',
            '  const style = window.getComputedStyle(el);',
            '  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";',
            '});',
            'const target = visible[0] || candidates[0];',
            'if (!target) { throw new Error("no-input"); }',
            'const getValue = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent || "");',
            'target.focus();',
            'if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {',
            '  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;',
            '  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");',
            '  if (descriptor && descriptor.set) { descriptor.set.call(target, text); } else { target.value = text; }',
            '  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));',
            '  target.dispatchEvent(new Event("change", { bubbles: true }));',
            '} else {',
            '  target.textContent = text;',
            '  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));',
            '}',
            'if (getValue(target) !== text) { throw new Error("input-not-complete"); }',
            'return { ok: true };',
            '})()'
        ].join('');

        if (await this._tryEvaluateWithMcp(client, tools, script)) {
            return true;
        }

        const fillToolNames = tools
            .map(tool => tool.name)
            .filter(name => /(fill|type|insert|input|paste|set.?value)/i.test(name));

        const selectors = [
            'textarea',
            'textarea:not([disabled])',
            '[contenteditable="true"]',
            'div[contenteditable="true"]',
            'input[type="text"]'
        ];

        for (const toolName of fillToolNames) {
            for (const selector of selectors) {
                const argumentGuesses: Array<Record<string, unknown>> = [
                    { selector, text: instruction },
                    { selector, value: instruction },
                    { selector, input: instruction },
                    { element: selector, text: instruction },
                    { element: selector, value: instruction }
                ];

                for (const args of argumentGuesses) {
                    try {
                        await client.callTool(toolName, args);
                        if (await this._waitForMcpInputToMatch(client, tools, instruction)) {
                            return true;
                        }
                    } catch {
                        // Try next argument shape.
                    }
                }
            }
        }

        return false;
    }

    private async _waitForMcpInputToMatch(client: StdioMcpClient, tools: McpToolInfo[], instruction: string): Promise<boolean> {
        const script = [
            '(function(){',
            'const text = ' + JSON.stringify(instruction) + ';',
            'const candidates = Array.from(document.querySelectorAll(\'textarea, [contenteditable="true"], input[type="text"]\'));',
            'const matched = candidates.some((el) => {',
            '  const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent || "");',
            '  return value === text;',
            '});',
            'if (!matched) { throw new Error("input-not-complete"); }',
            'return { ok: true };',
            '})()'
        ].join('');

        for (let attempt = 0; attempt < 10; attempt++) {
            if (await this._tryEvaluateWithMcp(client, tools, script)) {
                return true;
            }
            await this._sleep(150);
        }

        return false;
    }

    private async _trySubmitInputWithMcp(client: StdioMcpClient, tools: McpToolInfo[], instruction: string): Promise<boolean> {
        const clickScript = [
            '(function(){',
            'const text = ' + JSON.stringify(instruction) + ';',
            'const candidates = Array.from(document.querySelectorAll(\'textarea, [contenteditable="true"], input[type="text"]\'));',
            'const target = candidates.find((el) => {',
            '  const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent || "");',
            '  return value === text;',
            '});',
            'if (!target) { throw new Error("input-not-complete"); }',
            'target.focus();',
            'const buttons = Array.from(document.querySelectorAll(\'button, [role="button"], input[type="submit"]\'));',
            'const sendButton = buttons.find((el) => {',
            '  if (el instanceof HTMLButtonElement && el.disabled) { return false; }',
            '  if (el instanceof HTMLInputElement && el.disabled) { return false; }',
            '  if (el.getAttribute("aria-disabled") === "true") { return false; }',
            '  const label = ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.textContent || "") + " " + ((el instanceof HTMLInputElement && el.value) || "")).trim();',
            '  return /(send|submit|发送|提交|确认|發送|送出)/i.test(label);',
            '});',
            'if (!(sendButton instanceof HTMLElement)) { throw new Error("no-send-button"); }',
            'sendButton.click();',
            'return { ok: true, mode: "button" };',
            '})()'
        ].join('');

        if (await this._tryEvaluateWithMcp(client, tools, clickScript)) {
            return true;
        }

        if (!await this._waitForMcpInputToMatch(client, tools, instruction)) {
            return false;
        }

        if (await this._tryPressEnterWithMcp(client, tools)) {
            return true;
        }

        const enterScript = [
            '(function(){',
            'const text = ' + JSON.stringify(instruction) + ';',
            'const candidates = Array.from(document.querySelectorAll(\'textarea, [contenteditable="true"], input[type="text"]\'));',
            'const target = candidates.find((el) => {',
            '  const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent || "");',
            '  return value === text;',
            '});',
            'if (!target) { throw new Error("input-not-complete"); }',
            'target.focus();',
            'target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));',
            'target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));',
            'return { ok: true, mode: "synthetic-enter" };',
            '})()'
        ].join('');

        return this._tryEvaluateWithMcp(client, tools, enterScript);
    }

    private async _tryPressEnterWithMcp(client: StdioMcpClient, tools: McpToolInfo[]): Promise<boolean> {
        const keyToolNames = tools
            .map(tool => tool.name)
            .filter(name => /(press|keyboard|key)/i.test(name));

        const argumentGuesses: Array<Record<string, unknown>> = [
            { key: 'Enter' },
            { keys: ['Enter'] },
            { text: 'Enter' },
            { value: 'Enter' },
            { key: 'Enter', code: 'Enter' }
        ];

        return this._tryCallMcpTools(client, keyToolNames, argumentGuesses);
    }

    private async _tryEvaluateWithMcp(client: StdioMcpClient, tools: McpToolInfo[], script: string): Promise<boolean> {
        const evaluateToolNames = tools
            .map(tool => tool.name)
            .filter(name => /(evaluate|script|javascript|execute)/i.test(name));

        for (const toolName of evaluateToolNames) {
            const argumentGuesses: Array<Record<string, unknown>> = [
                { script },
                { expression: script },
                { code: script },
                { function: script }
            ];

            for (const args of argumentGuesses) {
                try {
                    await client.callTool(toolName, args);
                    return true;
                } catch {
                    // Try next argument shape.
                }
            }
        }

        return false;
    }
    private async _sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }
    // Export markdown content to a chosen path
    private async _exportFiles(content?: string): Promise<void> {
        const files = Array.from(this._fileReferences.values());
        if (files.length === 0) {
            vscode.window.showWarningMessage('No referenced files to export');
            return;
        }

        const instruction = content || this._generateInstruction();
        if (!instruction || instruction.trim() === '') {
            vscode.window.showWarningMessage('No content to export');
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('ai-instruction.md'),
            filters: {
                Markdown: ['md'],
                Text: ['txt'],
                'All Files': ['*']
            }
        });

        if (uri) {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(instruction, 'utf8'));
                vscode.window.showInformationMessage('Exported to: ' + uri.fsPath);
            } catch (error) {
                vscode.window.showErrorMessage('Export failed: ' + String(error));
            }
        }
    }

    private _getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
            if (folder) {
                return folder;
            }
        }

        return vscode.workspace.workspaceFolders?.[0];
    }

    private _resolveFlatExportFileName(filePath: string, usedFileNames: Set<string>): string {
        const fallbackName = 'exported-file';
        const rawBaseName = path.basename(filePath) || fallbackName;
        const safeBaseName = rawBaseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || fallbackName;

        const reserveName = (name: string): string | undefined => {
            const key = name.toLowerCase();
            if (usedFileNames.has(key)) {
                return undefined;
            }
            usedFileNames.add(key);
            return name;
        };

        const reserved = reserveName(safeBaseName);
        if (reserved) {
            return reserved;
        }

        const ext = path.extname(safeBaseName);
        const stem = ext ? safeBaseName.slice(0, -ext.length) : safeBaseName;
        let counter = 2;
        while (true) {
            const candidate = stem + '-' + counter + ext;
            const availableName = reserveName(candidate);
            if (availableName) {
                return availableName;
            }
            counter++;
        }
    }

    // Batch export referenced files to .ai/<timestamp> with code files in one folder.
    private async _batchExportFiles(content?: string, exportMdEnabled?: boolean): Promise<void> {
        const files = Array.from(this._fileReferences.values());
        if (files.length === 0) {
            vscode.window.showWarningMessage('No referenced files to export');
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('Open a workspace first before running batch export');
            return;
        }

        const activeFolder = this._getActiveWorkspaceFolder();
        if (!activeFolder) {
            vscode.window.showWarningMessage('Cannot determine active workspace root');
            return;
        }

        const shouldExportMd = exportMdEnabled === undefined
            ? this._batchExportSettings.exportMdEnabled
            : exportMdEnabled === true;
        await this._saveBatchExportSettings({ exportMdEnabled: shouldExportMd });

        const groups = new Map<string, { rootPath: string; files: FileReference[] }>();
        for (const file of files) {
            const fileUri = vscode.Uri.file(file.path);
            const owner = vscode.workspace.getWorkspaceFolder(fileUri) || activeFolder;
            if (!owner) {
                continue;
            }

            const rootPath = owner.uri.fsPath;
            if (!groups.has(rootPath)) {
                groups.set(rootPath, { rootPath, files: [] });
            }
            groups.get(rootPath)!.files.push(file);
        }

        if (groups.size === 0) {
            vscode.window.showWarningMessage('No referenced files to export');
            return;
        }

        const timestamp = Date.now().toString();
        const instruction = (content && content.trim()) ? content : this._generateInstruction();
        const sessions = this._loadLatestExportSessions();

        let successCount = 0;
        let failCount = 0;
        let rootCount = 0;

        for (const group of groups.values()) {
            const rootPath = group.rootPath;
            const exportDir = path.join(rootPath, '.ai', timestamp);
            const manifestEntries: ExportManifestEntry[] = [];
            const usedFileNames = new Set<string>();

            await fs.promises.mkdir(exportDir, { recursive: true });

            for (const file of group.files) {
                try {
                    const sourceUri = vscode.Uri.file(file.path);
                    const contentBuffer = await vscode.workspace.fs.readFile(sourceUri);

                    const resolvedRelativePath = this._resolveFlatExportFileName(file.path, usedFileNames);

                    const targetPath = path.join(exportDir, resolvedRelativePath);
                    await fs.promises.writeFile(targetPath, contentBuffer);

                    manifestEntries.push({
                        exportedRelativePath: resolvedRelativePath,
                        originalPath: file.path
                    });
                    successCount++;
                } catch (error) {
                    console.error('Export file failed: ' + file.path, error);
                    failCount++;
                }
            }

            let mdFile: string | undefined;
            if (shouldExportMd && instruction && instruction.trim()) {
                mdFile = 'instruction-' + timestamp + '.md';
                await fs.promises.writeFile(path.join(exportDir, mdFile), instruction, 'utf8');
            }

            const manifest: ExportManifest = {
                timestamp,
                rootPath,
                createdAt: new Date().toISOString(),
                entries: manifestEntries,
                mdFile
            };

            const manifestPath = path.join(exportDir, 'manifest.json');
            await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

            sessions[rootPath] = {
                timestamp,
                rootPath,
                exportDir,
                manifestPath
            };

            rootCount++;
        }

        await this._saveLatestExportSessions(sessions);

        if (failCount === 0) {
            vscode.window.showInformationMessage('Batch export completed: ' + successCount + ' files, ' + rootCount + ' roots, timestamp ' + timestamp);
        } else {
            vscode.window.showWarningMessage('Batch export finished with errors: success ' + successCount + ', failed ' + failCount);
        }
    }

    // Overwrite files using latest export session under current active workspace root
    private async _overwriteFiles(): Promise<void> {
        const activeFolder = this._getActiveWorkspaceFolder();
        if (!activeFolder) {
            vscode.window.showWarningMessage('Cannot determine active workspace root');
            return;
        }

        const sessions = this._loadLatestExportSessions();
        const session = sessions[activeFolder.uri.fsPath];
        if (!session) {
            vscode.window.showWarningMessage('No recent export session found for this workspace root. Run batch export first.');
            return;
        }

        if (!fs.existsSync(session.manifestPath)) {
            vscode.window.showWarningMessage('Export manifest not found. Run batch export again.');
            return;
        }

        let manifest: ExportManifest;
        try {
            const manifestRaw = await fs.promises.readFile(session.manifestPath, 'utf8');
            manifest = JSON.parse(manifestRaw) as ExportManifest;
        } catch (error) {
            vscode.window.showErrorMessage('Failed to read export manifest: ' + String(error));
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            'This will overwrite ' + manifest.entries.length + ' files from the latest export session. Continue?',
            { modal: true },
            'Confirm Overwrite',
            'Cancel'
        );

        if (confirm !== 'Confirm Overwrite') {
            return;
        }

        let successCount = 0;
        let failCount = 0;
        let skipCount = 0;

        for (const entry of manifest.entries) {
            const sourcePath = path.join(session.exportDir, ...entry.exportedRelativePath.split(/[\\/]/));
            if (!fs.existsSync(sourcePath)) {
                skipCount++;
                continue;
            }

            try {
                const contentBuffer = await fs.promises.readFile(sourcePath);
                await fs.promises.mkdir(path.dirname(entry.originalPath), { recursive: true });
                await fs.promises.writeFile(entry.originalPath, contentBuffer);
                successCount++;
            } catch (error) {
                console.error('Overwrite file failed: ' + entry.originalPath, error);
                failCount++;
            }
        }

        if (failCount === 0) {
            vscode.window.showInformationMessage('Overwrite completed: success ' + successCount + ', skipped ' + skipCount);
        } else {
            vscode.window.showWarningMessage('Overwrite finished with errors: success ' + successCount + ', failed ' + failCount + ', skipped ' + skipCount);
        }
    }

    private async _getAllFilesInDirectory(dirPath: string): Promise<string[]> {
        const files: string[] = [];

        const traverse = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                // 跳过 node_modules 和隐藏文件夹
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverse(fullPath);
                } else {
                    files.push(fullPath);
                }
            }
        };

        await traverse(dirPath);
        return files;
    }

    // 处理拖拽的文件
    private async _handleDroppedFiles(filePaths: string[]): Promise<void> {
        let addedCount = 0;
        for (const filePath of filePaths) {
            try {
                // 转换为 VS Code URI
                const fileUri = vscode.Uri.file(filePath);
                // 检查是否是文本文件
                const document = await vscode.workspace.openTextDocument(fileUri);
                const content = document.getText();
                const fileName = filePath.split(/[\\/]/).pop() || filePath;
                const totalLines = document.lineCount;

                this.addFileReference({
                    id: filePath,
                    path: filePath,
                    name: fileName,
                    lineRange: `1-${totalLines}`,
                    content: content,
                    type: 'file'
                });
                addedCount++;
            } catch (error) {
                // 跳过无法读取的文件（可能是二进制文件）
                console.log(`无法读取文件: ${filePath}`, error);
            }
        }
        if (addedCount > 0) {
            vscode.window.showInformationMessage(`已添加 ${addedCount} 个文件`);
        }
    }

    // 从工作区选择文件
    private async _selectFilesFromWorkspace(): Promise<void> {
        const files = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: '选择文件',
            filters: {
                'All Files': ['*']
            }
        });

        if (files && files.length > 0) {
            for (const fileUri of files) {
                // 读取文件并添加到引用列表
                try {
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const content = document.getText();
                    const filePath = fileUri.fsPath;
                    const fileName = filePath.split(/[\\/]/).pop() || filePath;
                    const totalLines = document.lineCount;

                    this.addFileReference({
                        id: filePath,
                        path: filePath,
                        name: fileName,
                        lineRange: `1-${totalLines}`,
                        content: content,
                        type: 'file'
                    });
                } catch (error) {
                    vscode.window.showErrorMessage(`无法读取文件: ${error}`);
                }
            }
            vscode.window.showInformationMessage(`已添加 ${files.length} 个文件`);
        }
    }

    // 通过路径添加文件（支持绝对路径和相对路径）
    private async _addFilesByPath(paths: string[]): Promise<void> {
        if (!paths || paths.length === 0) {
            return;
        }

        let successCount = 0;
        let failCount = 0;
        const failedPaths: string[] = [];

        for (const inputPath of paths) {
            const trimmedPath = inputPath.trim();
            if (!trimmedPath) {
                continue;
            }

            try {
                let filePath: string;

                // 判断是绝对路径还是相对路径
                if (path.isAbsolute(trimmedPath)) {
                    // 绝对路径直接使用
                    filePath = trimmedPath;
                } else {
                    // 相对路径，基于工作区根目录
                    const workspaceFolders = vscode.workspace.workspaceFolders;

                    if (!workspaceFolders || workspaceFolders.length === 0) {
                        failCount++;
                        failedPaths.push(trimmedPath);
                        continue;
                    }

                    // 优先使用第一个工作区文件夹作为基准
                    const basePath = workspaceFolders[0].uri.fsPath;
                    filePath = path.join(basePath, trimmedPath);
                }

                // 规范化路径
                filePath = path.normalize(filePath);

                // 检查文件是否存在
                if (!fs.existsSync(filePath)) {
                    failCount++;
                    failedPaths.push(trimmedPath);
                    continue;
                }

                // 检查是否是文件
                const stats = fs.statSync(filePath);
                if (!stats.isFile()) {
                    failCount++;
                    failedPaths.push(trimmedPath);
                    continue;
                }

                // 读取文件内容
                const fileUri = vscode.Uri.file(filePath);
                try {
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const content = document.getText();
                    const fileName = path.basename(filePath);
                    const totalLines = document.lineCount;

                    this.addFileReference({
                        id: filePath,
                        path: filePath,
                        name: fileName,
                        lineRange: `1-${totalLines}`,
                        content: content,
                        type: 'file'
                    });
                    successCount++;
                } catch (error) {
                    // 对于二进制文件，只添加文件引用
                    const fileName = path.basename(filePath);
                    this.addFileReference({
                        id: filePath,
                        path: filePath,
                        name: fileName,
                        lineRange: 'binary',
                        content: `[二进制文件: ${fileName}]`,
                        type: 'file'
                    });
                    successCount++;
                }
            } catch (error) {
                failCount++;
                failedPaths.push(trimmedPath);
            }
        }

        // 显示结果
        if (successCount > 0) {
            vscode.window.showInformationMessage(`已添加 ${successCount} 个文件到 AI 指令`);
        }
        if (failCount > 0) {
            vscode.window.showWarningMessage(`${failCount} 个文件添加失败: ${failedPaths.slice(0, 3).join(', ')}${failedPaths.length > 3 ? '...' : ''}`);
        }
    }

    // 生成 Webview HTML
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
        );

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Uploader</title>
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>AI 文件引用</h2>
            <span id="fileCount" class="file-count">0 个文件</span>
        </div>

        <div class="instructions">
            <p>📋 选中代码后右键 → "发送到AI"</p>
        </div>

        <div id="fileList" class="file-list">
            <div class="empty-state">
                <p>暂无文件引用</p>
                <p class="hint">拖拽文件到此处，或点击按钮选择</p>
            </div>
        </div>

        <div class="file-list-actions">
            <button id="selectFilesBtn" class="btn-select-files">
                <span class="icon">+</span>
                从工作区选择
            </button>
        </div>

        <div class="paste-path-section">
            <div class="paste-path-input-group">
                <input type="text" id="pastePathInput" class="paste-path-input" placeholder="粘贴文件路径 (支持绝对路径或相对路径，多路径用逗号分隔)..." />
                <button id="addPathBtn" class="btn-add-path" title="添加路径">
                    <span class="icon">+</span>
                </button>
            </div>
        </div>

        <div class="actions">
            <button id="copyBtn" class="btn btn-primary">
                <span class="icon">📋</span>
                复制指令
            </button>
            <button id="browserBtn" class="btn btn-secondary">
                <span class="icon">🌐</span>
                打开网页
            </button>
            <button id="batchExportBtn" class="btn btn-secondary">
                <span class="icon">📁</span>
                批量导出
            </button>
            <button id="overwriteBtn" class="btn btn-secondary">
                <span class="icon">🔄</span>
                覆盖文件
            </button>
            <button id="clearBtn" class="btn btn-danger">
                <span class="icon">🗑️</span>
                清空
            </button>
        </div>

        <div class="export-md-toggle-row">
            <label class="switch-label" for="exportMdToggle">
                <input type="checkbox" id="exportMdToggle" />
                <span>导出MD</span>
            </label>
        </div>

        <div class="preview-section">
            <div class="preview-header">
                <h3>编辑指令</h3>
                <button id="quickPhrasesBtn" class="btn-quick-phrases" title="快捷用语">
                    <span class="icon">⚡</span>
                    快捷用语
                </button>
            </div>
            <textarea id="preview" placeholder="添加文件后将显示指令预览..."></textarea>
        </div>

        <div class="platform-section">
            <div class="platform-header">
                <h3>打开网页</h3>
                <div class="platform-header-actions">
                    <button id="manageSitesBtn" class="btn-manage-sites">
                        <span class="icon">⚙</span>
                        管理
                    </button>
                    <button id="configMcpBtn" class="btn-manage-sites">
                        <span class="icon">⚙</span>
                        配置MCP
                    </button>
                </div>
            </div>
            <div class="platform-config">
                <div class="form-group">
                    <label for="platformSelect">选择站点</label>
                    <select id="platformSelect" class="form-control">
                        <!-- 动态加载 -->
                    </select>
                </div>
                <div class="form-group">
                    <label for="urlInput">目标 URL</label>
                    <input type="text" id="urlInput" class="form-control" placeholder="https://..." />
                </div>
            </div>
        </div>
    </div>

    <!-- 站点管理弹窗 -->
    <div id="sitesModal" class="modal-overlay">
        <div class="modal-container">
            <div class="modal-header">
                <h3>管理站点</h3>
                <div class="modal-header-actions">
                    <button id="addSiteBtn" class="toolbar-btn">+ 新增站点</button>
                    <button class="modal-close" title="关闭">&times;</button>
                </div>
            </div>
            <div class="modal-body">
                <div id="sitesList" class="sites-list"></div>
                <div id="addSiteForm" class="add-site-form" style="display:none;">
                    <h4>新增站点</h4>
                    <div class="form-group">
                        <label>站点名称</label>
                        <input type="text" id="newSiteName" class="form-control" placeholder="如：Kimi">
                    </div>
                    <div class="form-group">
                        <label>网址</label>
                        <input type="text" id="newSiteUrl" class="form-control" placeholder="https://...">
                    </div>
                    <div class="form-actions">
                        <button id="deleteSiteBtn" class="btn-danger" style="display:none;margin-right:auto;">删除</button>
                        <button id="cancelAddSiteBtn" class="btn-secondary">取消</button>
                        <button id="confirmAddSiteBtn" class="btn-primary">确定</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- MCP config modal -->
    <div id="mcpModal" class="modal-overlay">
        <div class="modal-container">
            <div class="modal-header">
                <h3>配置MCP</h3>
                <div class="modal-header-actions">
                    <button id="addMcpBtn" class="toolbar-btn">+</button>
                    <button class="modal-close" title="Close">&times;</button>
                </div>
            </div>
            <div class="modal-body">
                <div id="mcpList" class="sites-list"></div>
                <div id="addMcpForm" class="add-site-form" style="display:none;">
                    <h4>添加 MCP 配置 (JSON)</h4>
                    <div class="form-group">
                        <label>JSON 内容</label>
                        <textarea id="mcpJsonInput" class="form-control" rows="6" placeholder='{"servers": {"server-name": {"command": "npx", "args": ["-y", "pkg@latest"], "type": "stdio"}}}'></textarea>
                    </div>
                    <div class="form-actions">
                        <button id="cancelAddMcpBtn" class="btn-secondary">取消</button>
                        <button id="confirmAddMcpBtn" class="btn-primary">确定</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}


class StdioMcpClient {
    private process?: ChildProcessWithoutNullStreams;
    private buffer: Buffer = Buffer.alloc(0);
    private nextId = 1;
    private pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
        timer: NodeJS.Timeout;
    }>();

    constructor(
        private readonly command: string,
        private readonly args: string[],
        private readonly onExit?: () => void
    ) { }

    async start(): Promise<void> {
        if (this.process) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const child = spawn(this.command, this.args, {
                stdio: 'pipe',
                shell: process.platform === 'win32'
            });

            this.process = child;

            child.stdout.on('data', (chunk: Buffer) => {
                this.onStdoutData(chunk);
            });

            child.stderr.on('data', (chunk: Buffer) => {
                console.error('[MCP stderr]', chunk.toString('utf8'));
            });

            child.once('spawn', () => resolve());
            child.once('error', (error) => reject(error));
            child.once('exit', (code, signal) => {
                const reason = new Error('MCP process exited (code=' + code + ', signal=' + signal + ')');
                this.process = undefined;
                this.rejectAllPending(reason);
                if (this.onExit) {
                    this.onExit();
                }
            });
        });
    }

    async initialize(): Promise<void> {
        const baseParams = {
            capabilities: {},
            clientInfo: {
                name: 'ai-code-uploader',
                version: '2.0.0'
            }
        };

        try {
            await this.request('initialize', {
                ...baseParams,
                protocolVersion: '2024-11-05'
            }, 180000);
        } catch {
            await this.request('initialize', {
                ...baseParams,
                protocolVersion: '2024-10-07'
            }, 180000);
        }

        this.notify('notifications/initialized', {});
    }

    async listTools(): Promise<McpToolInfo[]> {
        const result = await this.request('tools/list', {}, 60000);
        if (!result || typeof result !== 'object') {
            return [];
        }

        const toolsValue = (result as { tools?: unknown }).tools;
        if (!Array.isArray(toolsValue)) {
            return [];
        }

        const tools: McpToolInfo[] = [];
        for (const item of toolsValue) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const nameValue = (item as { name?: unknown }).name;
            if (typeof nameValue !== 'string' || !nameValue.trim()) {
                continue;
            }
            tools.push({ name: nameValue });
        }

        return tools;
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        const result = await this.request('tools/call', {
            name,
            arguments: args
        });

        if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
            throw new Error('Tool call returned error for: ' + name);
        }

        return result;
    }

    dispose(): void {
        if (this.process && !this.process.killed) {
            this.process.kill();
        }
        this.rejectAllPending(new Error('MCP client disposed'));
        this.process = undefined;
        if (this.onExit) {
            this.onExit();
        }
    }

    private onStdoutData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length > 0) {
            let headerEndIndex = this.buffer.indexOf('\r\n\r\n');
            let headerSeparatorLength = 4;
            if (headerEndIndex < 0) {
                headerEndIndex = this.buffer.indexOf('\n\n');
                headerSeparatorLength = 2;
            }

            const newlineIndex = this.buffer.indexOf('\n');
            const startsWithContentLength = /^Content-Length:/i.test(
                this.buffer.slice(0, Math.min(this.buffer.length, 64)).toString('utf8')
            );

            if (startsWithContentLength) {
                if (headerEndIndex < 0) {
                    return;
                }
                const headerText = this.buffer.slice(0, headerEndIndex).toString('utf8');
                const match = headerText.match(/Content-Length:\s*(\d+)/i);
                if (!match) {
                    this.buffer = Buffer.alloc(0);
                    this.rejectAllPending(new Error('Invalid MCP header without Content-Length'));
                    return;
                }

                const contentLength = Number(match[1]);
                const bodyStartIndex = headerEndIndex + headerSeparatorLength;
                const bodyEndIndex = bodyStartIndex + contentLength;
                if (this.buffer.length < bodyEndIndex) {
                    return;
                }

                const bodyBuffer = this.buffer.slice(bodyStartIndex, bodyEndIndex);
                this.buffer = this.buffer.slice(bodyEndIndex);
                this.handleMessageBody(bodyBuffer.toString('utf8'));
                continue;
            }

            if (newlineIndex < 0) {
                return;
            }

            const line = this.buffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '');
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (line.trim()) {
                this.handleMessageBody(line);
            }
        }
    }

    private handleMessageBody(body: string): void {
        try {
            const message = JSON.parse(body) as {
                id?: number;
                result?: unknown;
                error?: { message?: string };
            };
            if (typeof message.id === 'number') {
                const pending = this.pending.get(message.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    if (message.error) {
                        pending.reject(new Error(message.error.message || 'Unknown MCP error'));
                    } else {
                        pending.resolve(message.result);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to parse MCP response message', error);
        }
    }

    private request(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('MCP request timeout: ' + method));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            this.send({
                jsonrpc: '2.0',
                id,
                method,
                params
            });
        });
    }

    private notify(method: string, params: unknown): void {
        this.send({
            jsonrpc: '2.0',
            method,
            params
        });
    }

    private send(message: Record<string, unknown>): void {
        if (!this.process || !this.process.stdin.writable) {
            throw new Error('MCP process is not writable');
        }

        this.process.stdin.write(JSON.stringify(message) + '\n', 'utf8');
    }

    private rejectAllPending(reason: Error): void {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(reason);
        }
        this.pending.clear();
    }
}




