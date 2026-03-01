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

export class AIPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiUploaderPanel';

    private _view?: vscode.WebviewView;
    private _fileReferences: Map<string, FileReference> = new Map();
    private _context: vscode.ExtensionContext;
    private _platformConfig: PlatformConfig;
    private _platformPresets: PlatformConfig[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        context: vscode.ExtensionContext
    ) {
        this._context = context;
        this._platformPresets = this._loadPlatformPresets();
        this._platformConfig = this._loadPlatformConfig();
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
                    await this._openBrowser();
                    break;
                case 'exportFiles':
                    await this._exportFiles(data.content);
                    break;
                case 'batchExportFiles':
                    await this._batchExportFiles();
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
                    await this._handleDroppedFiles(data.files);
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
            }
        });

        // 初始化时更新文件列表和平台配置
        this._updateFileList();
        this._sendPlatformConfig();
        this._sendQuickPhrases();
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

        await vscode.env.clipboard.writeText(instruction);
        vscode.window.showInformationMessage('指令已复制到剪贴板！');
    }

    // 打开浏览器
    private async _openBrowser(): Promise<void> {
        const instruction = this._generateInstruction();
        if (!instruction) {
            vscode.window.showWarningMessage('没有可发送的文件引用');
            return;
        }

        // 复制到剪贴板
        await vscode.env.clipboard.writeText(instruction);

        // 使用配置的平台 URL
        const url = this._platformConfig.url;
        if (url) {
            vscode.env.openExternal(vscode.Uri.parse(url));
            vscode.window.showInformationMessage(
                `已打开 ${this._platformConfig.platform}，请粘贴指令到输入框`
            );
        } else {
            vscode.window.showWarningMessage('请先配置目标平台 URL');
        }
    }

    // 导出MD文件 - 使用用户编辑后的内容
    private async _exportFiles(content?: string): Promise<void> {
        const files = Array.from(this._fileReferences.values());
        if (files.length === 0) {
            vscode.window.showWarningMessage('没有可导出的文件引用');
            return;
        }

        // 优先使用用户编辑后的内容，如果没有则使用生成的内容
        const instruction = content || this._generateInstruction();
        if (!instruction || instruction.trim() === '') {
            vscode.window.showWarningMessage('没有可导出的内容');
            return;
        }

        // 选择保存位置
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('ai-instruction.md'),
            filters: {
                'Markdown': ['md'],
                'Text': ['txt'],
                'All Files': ['*']
            }
        });

        if (uri) {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(instruction, 'utf8'));
                vscode.window.showInformationMessage(`已导出到: ${uri.fsPath}`);
            } catch (error) {
                vscode.window.showErrorMessage(`导出失败: ${error}`);
            }
        }
    }

    // 批量导出引用的文件到指定目录
    private async _batchExportFiles(): Promise<void> {
        const files = Array.from(this._fileReferences.values());
        if (files.length === 0) {
            vscode.window.showWarningMessage('没有可导出的文件引用');
            return;
        }

        // 选择目标文件夹
        const folderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择导出目录'
        });

        if (!folderUris || folderUris.length === 0) {
            return;
        }

        const targetDir = folderUris[0];
        let successCount = 0;
        let failCount = 0;

        for (const file of files) {
            try {
                const sourceUri = vscode.Uri.file(file.path);
                const targetUri = vscode.Uri.joinPath(targetDir, file.name);

                // 读取源文件内容
                const content = await vscode.workspace.fs.readFile(sourceUri);
                // 写入目标位置
                await vscode.workspace.fs.writeFile(targetUri, content);
                successCount++;
            } catch (error) {
                console.error(`导出文件失败: ${file.path}`, error);
                failCount++;
            }
        }

        if (failCount === 0) {
            vscode.window.showInformationMessage(`成功导出 ${successCount} 个文件到 ${targetDir.fsPath}`);
        } else {
            vscode.window.showWarningMessage(`导出完成: ${successCount} 个成功, ${failCount} 个失败`);
        }
    }

    // 覆盖文件 - 选取目录A，将A下的文件按原目录结构覆盖到对应路径
    private async _overwriteFiles(): Promise<void> {
        const files = Array.from(this._fileReferences.values());
        if (files.length === 0) {
            vscode.window.showWarningMessage('没有文件引用，请先添加文件');
            return;
        }

        // 选择源目录（包含新文件的目录）
        const sourceFolderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择源文件目录'
        });

        if (!sourceFolderUris || sourceFolderUris.length === 0) {
            return;
        }

        const sourceDir = sourceFolderUris[0].fsPath;

        // 确认操作
        const confirm = await vscode.window.showWarningMessage(
            `即将用 "${path.basename(sourceDir)}" 目录下的文件覆盖原文件，此操作不可撤销。是否继续？`,
            { modal: true },
            '确认覆盖',
            '取消'
        );

        if (confirm !== '确认覆盖') {
            return;
        }

        // 读取源目录下的所有文件
        const sourceFiles = await this._getAllFilesInDirectory(sourceDir);

        if (sourceFiles.length === 0) {
            vscode.window.showWarningMessage('源目录中没有文件');
            return;
        }

        // 构建原文件的相对路径映射
        const originalFilesMap = new Map<string, FileReference>(); // relativePath -> FileReference
        const commonRoot = this._findCommonRoot(files.map(f => f.path));

        for (const file of files) {
            const relativePath = file.path.substring(commonRoot.length).replace(/^[/\\]/, '');
            originalFilesMap.set(relativePath, file);
        }

        // 执行覆盖
        let successCount = 0;
        let failCount = 0;
        let skipCount = 0;
        const overwriteResults: string[] = [];

        for (const sourceFilePath of sourceFiles) {
            const sourceFileName = path.basename(sourceFilePath);
            const sourceRelativePath = sourceFilePath.substring(sourceDir.length).replace(/^[/\\]/, '');

            // 查找匹配的原文件
            let matchedOriginal: FileReference | undefined;

            // 优先按相对路径匹配
            if (originalFilesMap.has(sourceRelativePath)) {
                matchedOriginal = originalFilesMap.get(sourceRelativePath);
            } else {
                // 按文件名匹配
                for (const [relPath, fileRef] of originalFilesMap) {
                    if (path.basename(relPath) === sourceFileName) {
                        matchedOriginal = fileRef;
                        break;
                    }
                }
            }

            if (matchedOriginal) {
                try {
                    // 读取源文件内容
                    const content = await fs.promises.readFile(sourceFilePath);
                    // 写入原文件位置
                    await fs.promises.writeFile(matchedOriginal.path, content);
                    successCount++;
                    overwriteResults.push(`✓ ${sourceRelativePath} → ${matchedOriginal.name}`);
                } catch (error) {
                    failCount++;
                    overwriteResults.push(`✗ ${sourceRelativePath} (失败: ${error})`);
                }
            } else {
                skipCount++;
                overwriteResults.push(`⊘ ${sourceRelativePath} (未匹配到原文件)`);
            }
        }

        // 显示结果
        const message = `覆盖完成: ${successCount} 个成功, ${failCount} 个失败, ${skipCount} 个跳过`;
        if (failCount === 0 && skipCount === 0) {
            vscode.window.showInformationMessage(message);
        } else if (failCount > 0) {
            vscode.window.showErrorMessage(message);
        } else {
            vscode.window.showWarningMessage(message);
        }

        // 输出详细日志
        console.log('覆盖文件详细结果:');
        overwriteResults.forEach(r => console.log(r));
    }

    // 递归获取目录下所有文件
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
            <button id="exportBtn" class="btn btn-secondary">
                <span class="icon">💾</span>
                导出MD
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
                <h3>打开 AI 页面</h3>
                <button id="manageSitesBtn" class="btn-manage-sites">
                    <span class="icon">⚙️</span>
                    管理
                </button>
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

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
