(function() {
    const vscode = acquireVsCodeApi();

    // DOM 元素
    const fileListEl = document.getElementById('fileList');
    const fileCountEl = document.getElementById('fileCount');
    const previewEl = document.getElementById('preview');
    const copyBtn = document.getElementById('copyBtn');
    const browserBtn = document.getElementById('browserBtn');
    const clearBtn = document.getElementById('clearBtn');
    const exportMdToggle = document.getElementById('exportMdToggle');
    const batchExportBtn = document.getElementById('batchExportBtn');
    const selectFilesBtn = document.getElementById('selectFilesBtn');
    const batchImportBtn = document.getElementById('batchImportBtn');
    const platformSelect = document.getElementById('platformSelect');
    const urlInput = document.getElementById('urlInput');

    let currentFiles = [];
    let platformPresets = [];
    let currentPlatformConfig = { platform: 'Kimi', url: 'https://kimi.moonshot.cn' };
    let batchExportSettings = { exportMdEnabled: false };
    let mcpConfig = { mcpServers: {}, executor: 'chrome-devtools' };
    let mcpRuntimeStatus = {};
    let dragCounter = 0;
    let batchImportInputEl = null;
    
    // 快捷用语数据
    let quickPhrases = [];
    let categories = [];
    let currentCategory = 'default';
    let selectedPhraseIds = new Set();
    let isMultiSelectMode = false;

    // 初始化
    function init() {
        // 请求文件列表
        vscode.postMessage({ type: 'getFileList' });

        // 绑定按钮事件
        copyBtn.addEventListener('click', () => {
            // 发送用户编辑后的最新内容
            vscode.postMessage({ 
                type: 'copyInstruction',
                content: previewEl.value 
            });
        });

        browserBtn.addEventListener('click', () => {
            vscode.postMessage({
                type: 'openBrowser',
                content: previewEl.value
            });
        });

        if (batchExportBtn) {
            batchExportBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'batchExportFiles',
                    content: previewEl.value,
                    exportMdEnabled: !!(exportMdToggle && exportMdToggle.checked)
                });
            });
        }
        
        // 绑定覆盖文件按钮
        const overwriteBtn = document.getElementById('overwriteBtn');
        if (overwriteBtn) {
            overwriteBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'overwriteFiles' });
            });
        }

        clearBtn.addEventListener('click', () => {
            if (currentFiles.length > 0) {
                vscode.postMessage({ type: 'clearAll' });
            }
        });

        // 绑定"从工作区选择"按钮事件
        if (selectFilesBtn) {
            selectFilesBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'selectFilesFromWorkspace' });
            });
        }

        // 绑定粘贴路径输入框事件
        const pastePathInput = document.getElementById('pastePathInput');
        const addPathBtn = document.getElementById('addPathBtn');
        
        if (pastePathInput && addPathBtn) {
            // 点击添加按钮
            addPathBtn.addEventListener('click', () => {
                const pathValue = pastePathInput.value.trim();
                if (pathValue) {
                    // 支持逗号分隔的多个路径
                    const paths = pathValue.split(',').map(p => p.trim()).filter(p => p);
                    vscode.postMessage({ 
                        type: 'addFilesByPath', 
                        paths: paths 
                    });
                    pastePathInput.value = '';
                }
            });
            
            // 回车键添加
            pastePathInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const pathValue = pastePathInput.value.trim();
                    if (pathValue) {
                        // 支持逗号分隔的多个路径
                        const paths = pathValue.split(',').map(p => p.trim()).filter(p => p);
                        vscode.postMessage({ 
                            type: 'addFilesByPath', 
                            paths: paths 
                        });
                        pastePathInput.value = '';
                    }
                }
            });
        }

        // 绑定拖拽事件
        setupDragAndDrop();

        // 绑定平台配置事件
        if (platformSelect) {
            platformSelect.addEventListener('change', handlePlatformChange);
        }
        if (urlInput) {
            urlInput.addEventListener('change', handleUrlChange);
            urlInput.addEventListener('blur', handleUrlChange);
        }
        if (exportMdToggle) {
            exportMdToggle.addEventListener('change', () => {
                const enabled = !!exportMdToggle.checked;
                batchExportSettings.exportMdEnabled = enabled;
                vscode.postMessage({
                    type: 'updateBatchExportSettings',
                    settings: { exportMdEnabled: enabled }
                });
            });
        }
        
        // 初始化快捷用语弹窗
        initQuickPhrasesModal();
        
        // 初始化站点管理弹窗
        initSitesModal();

        initBatchImportModal();

        // Initialize MCP config modal
        initMcpModal();
        
        // 请求快捷用语数据
        vscode.postMessage({ type: 'getQuickPhrases' });
        
        // 请求平台预设数据
        vscode.postMessage({ type: 'getPlatformPresets' });

        // Request batch export settings
        vscode.postMessage({ type: 'getBatchExportSettings' });

        // Request MCP config
        vscode.postMessage({ type: 'getMcpConfig' });
    }

    // 处理平台选择变化
    function handlePlatformChange(e) {
        const selectedPlatform = e.target.value;
        const preset = platformPresets.find(p => p.platform === selectedPlatform);
        
        if (preset) {
            currentPlatformConfig = { ...preset };
            if (urlInput) {
                urlInput.value = preset.url;
            }
            // 发送配置更新到 extension
            vscode.postMessage({
                type: 'updatePlatformConfig',
                config: currentPlatformConfig
            });
        }
    }
    
    // 处理 URL 输入变化
    function handleUrlChange(e) {
        const newUrl = e.target.value.trim();
        if (newUrl !== currentPlatformConfig.url) {
            currentPlatformConfig.url = newUrl;
            // 发送配置更新到 extension
            vscode.postMessage({
                type: 'updatePlatformConfig',
                config: currentPlatformConfig
            });
        }
    }

    // 更新平台配置 UI
    function updatePlatformConfig(config, presets) {
        platformPresets = presets || [];
        currentPlatformConfig = config || (platformPresets[0] || { platform: 'Kimi', url: 'https://kimi.moonshot.cn' });
        
        // 动态更新下拉框选项
        if (platformSelect) {
            platformSelect.innerHTML = platformPresets.map(p => 
                `<option value="${escapeHtml(p.platform)}">${escapeHtml(p.platform)}</option>`
            ).join('');
            platformSelect.value = currentPlatformConfig.platform;
        }
        if (urlInput) {
            urlInput.value = currentPlatformConfig.url;
        }
    }

    // 设置拖拽事件处理
    function setupDragAndDrop() {
        // 拖拽进入
        fileListEl.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter++;
            fileListEl.classList.add('drag-over');
        });

        // 拖拽经过
        fileListEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
        });

        // 拖拽离开
        fileListEl.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter--;
            if (dragCounter === 0) {
                fileListEl.classList.remove('drag-over');
            }
        });

        // 放置文件
        fileListEl.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            fileListEl.classList.remove('drag-over');

            // 获取拖拽的文件路径
            const uris = [];

            // 尝试从 VS Code 资源管理器获取文件路径
            const codeUri = e.dataTransfer.getData('application/vnd.code.uri');
            if (codeUri) {
                uris.push(codeUri);
            }

            // 尝试从 text/uri-list 获取文件路径（系统文件管理器）
            const uriList = e.dataTransfer.getData('text/uri-list');
            if (uriList) {
                // text/uri-list 可能包含多个 URI，每行一个
                const lines = uriList.split('\n').filter(line => line.trim() && !line.startsWith('#'));
                uris.push(...lines);
            }

            // 处理 DataTransferItemList（系统文件拖放）
            if (e.dataTransfer.items) {
                for (let i = 0; i < e.dataTransfer.items.length; i++) {
                    const item = e.dataTransfer.items[i];
                    if (item.kind === 'file') {
                        const file = item.getAsFile();
                        if (file) {
                            // 对于系统文件，我们尝试获取路径
                            // 注意：浏览器安全限制下可能无法直接获取完整路径
                            const filePath = e.dataTransfer.getData('text/plain') || file.name;
                            if (filePath) {
                                uris.push(filePath);
                            }
                        }
                    }
                }
            }

            // 去重并发送文件路径到 extension
            const uniqueUris = [...new Set(uris)];
            if (uniqueUris.length > 0) {
                vscode.postMessage({
                    type: 'dropFiles',
                    uris: uniqueUris
                });
            }
        });
    }

    // 更新文件列表
    function updateFileList(files) {
        currentFiles = files;

        // 更新计数
        fileCountEl.textContent = `${files.length} 个文件`;

        // 更新按钮状态
        const hasFiles = files.length > 0;
        copyBtn.disabled = !hasFiles;
        browserBtn.disabled = !hasFiles;
        if (batchExportBtn) {
            batchExportBtn.disabled = !hasFiles;
        }
        clearBtn.disabled = !hasFiles;

        // 清空列表
        fileListEl.innerHTML = '';

        if (files.length === 0) {
            fileListEl.innerHTML = `
                <div class="empty-state">
                    <p>暂无文件引用</p>
                    <p class="hint">拖拽文件到此处，或选择代码开始</p>
                </div>
            `;
            previewEl.value = '';
            return;
        }

        // 渲染文件列表
        files.forEach(file => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            // 只有选中代码引用才显示行号范围
            const fileMeta = file.type === 'selection' 
                ? `<div class="file-meta">行 ${file.lineRange}</div>` 
                : '';
            fileItem.innerHTML = `
                <span class="file-icon">${file.type === 'selection' ? '✂️' : '📄'}</span>
                <div class="file-info">
                    <div class="file-name" title="${file.name}">${file.name}</div>
                    ${fileMeta}
                </div>
                <span class="file-type ${file.type}">${file.type === 'selection' ? '选中' : '文件'}</span>
                <button class="remove-btn" data-id="${file.id}" title="移除">
                    ✕
                </button>
            `;
            fileListEl.appendChild(fileItem);
        });

        // 绑定移除按钮事件
        fileListEl.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget;
                const id = target.dataset.id;
                if (id) {
                    vscode.postMessage({ type: 'removeFile', id });
                }
            });
        });

        // 更新预览
        updatePreview(files);
    }

    // 更新预览文本 - 只显示文件名和行号
    function updatePreview(files) {
        if (files.length === 0) {
            previewEl.value = '';
            return;
        }

        // 如果用户已经编辑过内容，保留用户的修改（除非文件列表发生变化时重新生成）
        const currentValue = previewEl.value;
        const hasUserEdited = currentValue && !currentValue.includes('## 引用文件');
        
        let instruction = '';

        // 当文件数>1时，添加目录结构
        if (files.length > 1) {
            instruction += '## 目录结构\n\n';
            instruction += generateDirectoryTree(files);
            instruction += '\n';
        }

        instruction += '## 引用文件\n\n';

        files.forEach(file => {
            // 只有选中代码引用才显示行号范围
            if (file.type === 'selection') {
                instruction += `- ${file.name} (${file.lineRange})\n`;
            } else {
                instruction += `- ${file.name}\n`;
            }
        });

        instruction += '\n## 需求描述\n\n';
        instruction += '请分析以上文件并提供帮助。';

        previewEl.value = instruction;
    }
    
    // 获取当前指令内容（用于复制、发送等操作）
    function getCurrentInstruction() {
        return previewEl.value || '';
    }

    // 生成目录树结构
    function generateDirectoryTree(files) {
        // 获取所有文件路径
        const paths = files.map(f => f.path);
        
        // 找到共同根目录
        let commonRoot = findCommonRoot(paths);
        
        // 构建树结构
        const tree = {};
        
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
        return renderTree(tree, '');
    }

    // 找到共同根目录
    function findCommonRoot(paths) {
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
    function renderTree(tree, prefix) {
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
                result += renderTree(value, childPrefix);
            }
        }
        
        return result;
    }

    // 监听来自 extension 的消息
    window.addEventListener('message', (event) => {
        const message = event.data;

        switch (message.type) {
            case 'updateFileList':
                updateFileList(message.files);
                break;
            case 'updatePlatformConfig':
                updatePlatformConfig(message.config, message.presets);
                // Refresh site list if site modal is currently open
                const sitesModal = document.getElementById('sitesModal');
                if (sitesModal && sitesModal.classList.contains('active')) {
                    renderSitesList();
                }
                break;
            case 'updateQuickPhrases':
                quickPhrases = message.phrases || [];
                categories = message.categories || [];
                // Switch to first category if current one was removed
                const categoryExists = categories.some(c => c.id === currentCategory);
                if (!categoryExists && categories.length > 0) {
                    currentCategory = categories[0].id;
                }
                renderCategories();
                renderQuickPhrases();
                break;
            case 'updateBatchExportSettings':
                batchExportSettings = message.settings || { exportMdEnabled: false };
                if (exportMdToggle) {
                    exportMdToggle.checked = !!batchExportSettings.exportMdEnabled;
                }
                break;
            case 'updateMcpConfig':
                mcpConfig = message.config || { mcpServers: {}, executor: 'chrome-devtools' };
                const mcpModal = document.getElementById('mcpModal');
                if (mcpModal && mcpModal.classList.contains('active')) {
                    renderMcpList();
                }
                break;
            case 'updateMcpRuntimeStatus':
                mcpRuntimeStatus = message.runtime || {};
                const runtimeModal = document.getElementById('mcpModal');
                if (runtimeModal && runtimeModal.classList.contains('active')) {
                    renderMcpList();
                }
                break;
            case 'clipboardText':
                if (batchImportInputEl) {
                    batchImportInputEl.value = message.text || '';
                    batchImportInputEl.focus();
                }
                break;
        }
    });

    // ========== 快捷用语功能 ==========
    
    function initQuickPhrasesModal() {
        // 创建弹窗 HTML
        const modalHTML = `
            <div id="quickPhrasesModal" class="modal-overlay">
                <div class="modal-container">
                    <div class="modal-header">
                        <h3>快捷用语</h3>
                        <button class="modal-close" title="关闭">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="tab-header" id="categoryTabs"></div>
                        <div class="toolbar">
                            <input type="text" id="searchPhrases" class="toolbar-search" placeholder="搜索快捷用语...">
                            <button id="addPhraseBtn" class="toolbar-btn">新增</button>
                            <button id="multiSelectBtn" class="toolbar-btn secondary">多选</button>
                            <button id="selectAllBtn" class="toolbar-btn secondary" style="display:none;">全选</button>
                            <button id="deleteSelectedBtn" class="toolbar-btn danger" style="display:none;">删除</button>
                            <button id="cancelMultiBtn" class="toolbar-btn secondary" style="display:none;">取消</button>
                        </div>
                        <div id="phrasesList" class="phrases-list"></div>
                        <div id="batchAddBar" class="batch-add-bar" style="display:none;">
                            <button id="batchAddBtn" class="btn-batch-add">批量添加 (<span id="selectedCount">0</span>)</button>
                        </div>
                        <div id="addPhraseForm" class="add-phrase-form">
                            <h4 id="phraseFormTitle">新增快捷用语</h4>
                            <input type="hidden" id="editingPhraseId" value="">
                            <div class="form-group">
                                <label>指令内容</label>
                                <textarea id="newPhraseContent" class="form-control" rows="3" placeholder="输入快捷用语内容..."></textarea>
                            </div>
                            <div class="form-group">
                                <label>分类</label>
                                <select id="newPhraseCategory" class="form-control"></select>
                            </div>
                            <div class="form-group" id="newCategoryGroup" style="display:none;">
                                <label>新分类名称</label>
                                <input type="text" id="newCategoryName" class="form-control" placeholder="输入新分类名称">
                            </div>
                            <div class="form-actions">
                                <button id="deletePhraseBtn" class="btn-danger" style="display:none; margin-right:auto;">删除</button>
                                <button id="cancelAddBtn" class="btn-secondary">取消</button>
                                <button id="confirmAddBtn" class="btn-primary">确定</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        // 绑定事件
        const quickPhrasesBtn = document.getElementById('quickPhrasesBtn');
        const modal = document.getElementById('quickPhrasesModal');
        const closeBtn = modal.querySelector('.modal-close');
        const addPhraseBtn = document.getElementById('addPhraseBtn');
        const cancelAddBtn = document.getElementById('cancelAddBtn');
        const confirmAddBtn = document.getElementById('confirmAddBtn');
        const selectAllBtn = document.getElementById('selectAllBtn');
        const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
        const searchInput = document.getElementById('searchPhrases');
        const categorySelect = document.getElementById('newPhraseCategory');
        
        quickPhrasesBtn.addEventListener('click', () => {
            modal.classList.add('active');
            renderCategories();
            renderQuickPhrases();
        });
        
        closeBtn.addEventListener('click', () => {
            modal.classList.remove('active');
            hideAddForm();
            isMultiSelectMode = false;
            selectedPhraseIds.clear();
            updateToolbarState();
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
                hideAddForm();
                isMultiSelectMode = false;
                selectedPhraseIds.clear();
                updateToolbarState();
            }
        });
        
        addPhraseBtn.addEventListener('click', showAddForm);
        cancelAddBtn.addEventListener('click', hideAddForm);
        confirmAddBtn.addEventListener('click', confirmAddPhrase);
        
        // 删除单个快捷用语按钮
        const deletePhraseBtn = document.getElementById('deletePhraseBtn');
        deletePhraseBtn.addEventListener('click', () => {
            const editingId = document.getElementById('editingPhraseId').value;
            if (editingId) {
                vscode.postMessage({
                    type: 'deleteQuickPhrases',
                    ids: [editingId]
                });
                hideAddForm();
            }
        });
        
        // 多选按钮 - 进入多选模式
        const multiSelectBtn = document.getElementById('multiSelectBtn');
        multiSelectBtn.addEventListener('click', () => {
            isMultiSelectMode = true;
            selectedPhraseIds.clear();
            updateToolbarState();
            renderQuickPhrases();
        });
        
        // 取消按钮 - 退出多选模式
        const cancelMultiBtn = document.getElementById('cancelMultiBtn');
        cancelMultiBtn.addEventListener('click', () => {
            isMultiSelectMode = false;
            selectedPhraseIds.clear();
            updateToolbarState();
            renderQuickPhrases();
        });
        
        // 全选按钮
        selectAllBtn.addEventListener('click', () => {
            const visiblePhrases = getVisiblePhrases();
            if (selectedPhraseIds.size === visiblePhrases.length) {
                selectedPhraseIds.clear();
            } else {
                selectedPhraseIds = new Set(visiblePhrases.map(p => p.id));
            }
            renderQuickPhrases();
            updateToolbarState();
        });
        
        // 删除按钮
        deleteSelectedBtn.addEventListener('click', async () => {
            if (selectedPhraseIds.size === 0) return;
            
            const idsToDelete = Array.from(selectedPhraseIds);
            vscode.postMessage({
                type: 'deleteQuickPhrases',
                ids: idsToDelete
            });
            selectedPhraseIds.clear();
            updateToolbarState();
        });
        
        // 批量添加按钮
        const batchAddBtn = document.getElementById('batchAddBtn');
        batchAddBtn.addEventListener('click', () => {
            const selectedPhrases = quickPhrases.filter(p => selectedPhraseIds.has(p.id));
            if (selectedPhrases.length === 0) return;
            
            // 逐行批量添加到指令区域
            const preview = document.getElementById('preview');
            const contents = selectedPhrases.map(p => p.content);
            
            let currentValue = preview.value;
            if (currentValue && !currentValue.endsWith('\n') && currentValue.length > 0) {
                currentValue += '\n';
            }
            preview.value = currentValue + contents.join('\n');
            
            // 触发输入事件
            preview.dispatchEvent(new Event('input'));
            
            // 关闭快捷用语面板
            document.getElementById('quickPhrasesModal').classList.remove('active');
            
            // 重置状态
            isMultiSelectMode = false;
            selectedPhraseIds.clear();
            updateToolbarState();
        });
        
        searchInput.addEventListener('input', () => {
            renderQuickPhrases();
        });
        
        categorySelect.addEventListener('change', () => {
            const newCategoryGroup = document.getElementById('newCategoryGroup');
            if (categorySelect.value === '__new__') {
                newCategoryGroup.style.display = 'block';
            } else {
                newCategoryGroup.style.display = 'none';
            }
        });
    }
    
    function renderCategories() {
        const tabsContainer = document.getElementById('categoryTabs');
        const categorySelect = document.getElementById('newPhraseCategory');
        
        // 渲染 Tab
        tabsContainer.innerHTML = categories.map(cat => `
            <button class="tab-btn ${cat.id === currentCategory ? 'active' : ''}" data-id="${cat.id}">
                ${cat.name}
            </button>
        `).join('');
        
        // 绑定 Tab 点击事件
        tabsContainer.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentCategory = btn.dataset.id;
                renderCategories();
                renderQuickPhrases();
            });
        });
        
        // 渲染分类选择下拉框
        if (categorySelect) {
            categorySelect.innerHTML = [
                ...categories.map(cat => `<option value="${cat.id}">${cat.name}</option>`),
                '<option value="__new__">+ 新建分类</option>'
            ].join('');
        }
    }
    
    function getVisiblePhrases() {
        const searchTerm = document.getElementById('searchPhrases').value.toLowerCase();
        return quickPhrases.filter(p => {
            const matchesCategory = p.category === currentCategory;
            const matchesSearch = p.content.toLowerCase().includes(searchTerm);
            return matchesCategory && matchesSearch;
        });
    }
    
    function renderQuickPhrases() {
        const listContainer = document.getElementById('phrasesList');
        const visiblePhrases = getVisiblePhrases();
        
        if (visiblePhrases.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-phrases">
                    <p>暂无快捷用语</p>
                    <p style="font-size: 11px; margin-top: 8px;">点击"新增"按钮添加</p>
                </div>
            `;
            return;
        }
        
        listContainer.innerHTML = visiblePhrases.map(phrase => `
            <div class="phrase-item ${isMultiSelectMode ? 'multi-select' : ''}" data-id="${phrase.id}">
                <input type="checkbox" class="phrase-checkbox" 
                    ${selectedPhraseIds.has(phrase.id) ? 'checked' : ''}
                    ${!isMultiSelectMode ? 'style="display:none;"' : ''}>
                <div class="phrase-content" title="${escapeHtml(phrase.content)}">${escapeHtml(phrase.content)}</div>
                ${!isMultiSelectMode ? `
                    <button class="phrase-edit-btn" title="编辑">✏️</button>
                    <button class="phrase-add-btn" title="添加到指令">+</button>
                ` : ''}
            </div>
        `).join('');
        
        // 绑定事件
        if (isMultiSelectMode) {
            listContainer.querySelectorAll('.phrase-checkbox').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const id = e.target.closest('.phrase-item').dataset.id;
                    if (e.target.checked) {
                        selectedPhraseIds.add(id);
                    } else {
                        selectedPhraseIds.delete(id);
                    }
                    updateToolbarState();
                });
            });
            
            // 多选模式下点击整行也切换选择
            listContainer.querySelectorAll('.phrase-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT') return;
                    const checkbox = item.querySelector('.phrase-checkbox');
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                });
            });
        } else {
            // 非多选模式下，+按钮和编辑按钮可用
            listContainer.querySelectorAll('.phrase-add-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = e.target.closest('.phrase-item').dataset.id;
                    const phrase = quickPhrases.find(p => p.id === id);
                    if (phrase) {
                        addPhraseToInstruction(phrase.content);
                        document.getElementById('quickPhrasesModal').classList.remove('active');
                    }
                });
            });
            
            // 绑定编辑按钮
            listContainer.querySelectorAll('.phrase-edit-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = e.target.closest('.phrase-item').dataset.id;
                    showEditPhraseForm(id);
                });
            });
        }
    }
    
    function updateToolbarState() {
        const multiSelectBtn = document.getElementById('multiSelectBtn');
        const selectAllBtn = document.getElementById('selectAllBtn');
        const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
        const cancelMultiBtn = document.getElementById('cancelMultiBtn');
        const batchAddBar = document.getElementById('batchAddBar');
        const selectedCountEl = document.getElementById('selectedCount');
        
        if (isMultiSelectMode) {
            // 多选模式：显示全选、删除、取消按钮，隐藏多选按钮
            multiSelectBtn.style.display = 'none';
            selectAllBtn.style.display = 'inline-block';
            cancelMultiBtn.style.display = 'inline-block';
            batchAddBar.style.display = 'block';
            
            // 更新全选按钮文字
            const visiblePhrases = getVisiblePhrases();
            selectAllBtn.textContent = selectedPhraseIds.size === visiblePhrases.length && visiblePhrases.length > 0 ? '取消全选' : '全选';
            
            // 更新删除按钮显示
            deleteSelectedBtn.style.display = selectedPhraseIds.size > 0 ? 'inline-block' : 'none';
            
            // 更新选中数量
            selectedCountEl.textContent = selectedPhraseIds.size.toString();
        } else {
            // 普通模式：显示多选按钮，隐藏其他
            multiSelectBtn.style.display = 'inline-block';
            selectAllBtn.style.display = 'none';
            deleteSelectedBtn.style.display = 'none';
            cancelMultiBtn.style.display = 'none';
            batchAddBar.style.display = 'none';
        }
    }
    
    function showAddForm() {
        const form = document.getElementById('addPhraseForm');
        document.getElementById('phraseFormTitle').textContent = '新增快捷用语';
        document.getElementById('editingPhraseId').value = '';
        document.getElementById('deletePhraseBtn').style.display = 'none';
        form.classList.add('active');
        document.getElementById('newPhraseContent').focus();
        // 重置表单
        document.getElementById('newPhraseContent').value = '';
        document.getElementById('newPhraseCategory').value = currentCategory;
        document.getElementById('newCategoryName').value = '';
        document.getElementById('newCategoryGroup').style.display = 'none';
    }
    
    function showEditPhraseForm(phraseId) {
        const phrase = quickPhrases.find(p => p.id === phraseId);
        if (!phrase) return;
        
        const form = document.getElementById('addPhraseForm');
        document.getElementById('phraseFormTitle').textContent = '编辑快捷用语';
        document.getElementById('editingPhraseId').value = phraseId;
        document.getElementById('deletePhraseBtn').style.display = 'inline-block';
        form.classList.add('active');
        
        // 填充表单
        document.getElementById('newPhraseContent').value = phrase.content;
        document.getElementById('newPhraseCategory').value = phrase.category;
        document.getElementById('newCategoryName').value = '';
        document.getElementById('newCategoryGroup').style.display = 'none';
        document.getElementById('newPhraseContent').focus();
    }
    
    function hideAddForm() {
        document.getElementById('addPhraseForm').classList.remove('active');
        document.getElementById('editingPhraseId').value = '';
    }
    
    function confirmAddPhrase() {
        const content = document.getElementById('newPhraseContent').value.trim();
        let category = document.getElementById('newPhraseCategory').value;
        const newCategoryName = document.getElementById('newCategoryName').value.trim();
        const editingId = document.getElementById('editingPhraseId').value;
        
        if (!content) {
            return;
        }
        
        // 如果是新建分类
        if (category === '__new__') {
            if (!newCategoryName) {
                return;
            }
            const newCategoryId = 'cat_' + Date.now();
            vscode.postMessage({
                type: 'addCategory',
                category: {
                    id: newCategoryId,
                    name: newCategoryName,
                    isDefault: false
                }
            });
            category = newCategoryId;
            // 切换到新分类，确保tab显示正确
            currentCategory = newCategoryId;
        }
        
        if (editingId) {
            // 编辑模式 - 更新快捷用语
            vscode.postMessage({
                type: 'updateQuickPhrase',
                phrase: {
                    id: editingId,
                    content: content,
                    category: category
                }
            });
        } else {
            // 新增模式
            const newPhrase = {
                id: 'phrase_' + Date.now(),
                content: content,
                category: category
            };
            
            vscode.postMessage({
                type: 'addQuickPhrase',
                phrase: newPhrase
            });
        }
        
        hideAddForm();
    }
    
    function addPhraseToInstruction(phrase) {
        const preview = document.getElementById('preview');
        const currentValue = preview.value;
        
        if (currentValue && !currentValue.endsWith('\n')) {
            preview.value = currentValue + '\n' + phrase;
        } else {
            preview.value = currentValue + phrase;
        }
        
        // 触发输入事件以更新状态
        preview.dispatchEvent(new Event('input'));
    }
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ========== 站点管理功能 ==========
    
    function initSitesModal() {
        const manageSitesBtn = document.getElementById('manageSitesBtn');
        const sitesModal = document.getElementById('sitesModal');
        const closeBtn = sitesModal.querySelector('.modal-close');
        const addSiteBtn = document.getElementById('addSiteBtn');
        const cancelAddSiteBtn = document.getElementById('cancelAddSiteBtn');
        const confirmAddSiteBtn = document.getElementById('confirmAddSiteBtn');
        
        console.log('[AI Uploader] initSitesModal:', { manageSitesBtn, sitesModal, closeBtn, addSiteBtn, cancelAddSiteBtn, confirmAddSiteBtn });
        
        // 打开站点管理弹窗
        manageSitesBtn.addEventListener('click', () => {
            console.log('[AI Uploader] 打开站点管理弹窗');
            sitesModal.classList.add('active');
            hideAddSiteForm();
            renderSitesList();
        });
        
        // 关闭弹窗
        closeBtn.addEventListener('click', () => {
            sitesModal.classList.remove('active');
            hideAddSiteForm();
        });
        
        sitesModal.addEventListener('click', (e) => {
            if (e.target === sitesModal) {
                sitesModal.classList.remove('active');
                hideAddSiteForm();
            }
        });
        
        // 新增站点
        console.log('[AI Uploader] 绑定新增站点按钮');
        addSiteBtn.addEventListener('click', () => {
            console.log('[AI Uploader] 点击了新增站点按钮');
            showAddSiteForm();
        });
        cancelAddSiteBtn.addEventListener('click', hideAddSiteForm);
        confirmAddSiteBtn.addEventListener('click', confirmAddSite);
        
        // 删除站点
        const deleteSiteBtn = document.getElementById('deleteSiteBtn');
        deleteSiteBtn.addEventListener('click', () => {
            const editing = document.getElementById('newSiteName').dataset.editing;
            if (editing && confirm(`确定要删除站点 "${editing}" 吗？`)) {
                vscode.postMessage({
                    type: 'deletePlatformPresets',
                    platforms: [editing]
                });
                hideAddSiteForm();
            }
        });
    }
    
    function renderSitesList() {
        const sitesListEl = document.getElementById('sitesList');
        
        if (platformPresets.length === 0) {
            sitesListEl.innerHTML = `
                <div class="empty-sites">
                    <p>暂无站点</p>
                    <p style="font-size: 11px; margin-top: 8px;">点击"新增站点"按钮添加</p>
                </div>
            `;
            return;
        }
        
        sitesListEl.innerHTML = platformPresets.map(preset => `
            <div class="site-item" data-platform="${encodeURIComponent(preset.platform)}">
                <div class="site-info">
                    <div class="site-name">${escapeHtml(preset.platform)}</div>
                    <div class="site-url">${escapeHtml(preset.url)}</div>
                </div>
                <div class="site-actions">
                    <button class="site-edit-btn" title="编辑">✏️</button>
                </div>
            </div>
        `).join('');
        
        // 绑定编辑按钮
        sitesListEl.querySelectorAll('.site-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const siteItem = e.currentTarget.closest('.site-item');
                if (!siteItem) return;
                const platform = decodeURIComponent(siteItem.dataset.platform);
                showEditSiteForm(platform);
            });
        });
    }
    
    function showAddSiteForm() {
        const form = document.getElementById('addSiteForm');
        document.querySelector('#addSiteForm h4').textContent = '新增站点';
        document.getElementById('newSiteName').value = '';
        document.getElementById('newSiteUrl').value = '';
        document.getElementById('newSiteName').dataset.editing = '';
        document.getElementById('deleteSiteBtn').style.display = 'none';
        form.style.display = 'block';
        document.getElementById('newSiteName').focus();
    }
    
    function showEditSiteForm(platform) {
        const preset = platformPresets.find(p => p.platform === platform);
        if (!preset) return;
        
        const form = document.getElementById('addSiteForm');
        document.querySelector('#addSiteForm h4').textContent = '编辑站点';
        document.getElementById('newSiteName').value = preset.platform;
        document.getElementById('newSiteUrl').value = preset.url;
        document.getElementById('newSiteName').dataset.editing = platform;
        document.getElementById('deleteSiteBtn').style.display = 'inline-block';
        form.style.display = 'block';
        document.getElementById('newSiteName').focus();
    }
    
    function hideAddSiteForm() {
        document.getElementById('addSiteForm').style.display = 'none';
        document.getElementById('newSiteName').dataset.editing = '';
    }
    
    function confirmAddSite() {
        const name = document.getElementById('newSiteName').value.trim();
        const url = document.getElementById('newSiteUrl').value.trim();
        const editing = document.getElementById('newSiteName').dataset.editing;
        
        if (!name || !url) {
            console.log('[AI Uploader] 站点名称或URL为空');
            return;
        }
        
        const preset = {
            platform: name,
            url: url
        };
        
        // 确保空字符串被正确处理为新增模式
        const isEditingMode = editing && editing.length > 0;
        
        console.log('[AI Uploader] 确认站点:', { name, url, editing, isEditingMode });
        
        if (isEditingMode) {
            // 编辑模式
            if (editing !== name) {
                // 名称改变了，先删除旧的再添加新的
                console.log('[AI Uploader] 编辑模式：名称改变，先删除再添加');
                vscode.postMessage({
                    type: 'deletePlatformPresets',
                    platforms: [editing]
                });
                vscode.postMessage({
                    type: 'addPlatformPreset',
                    preset: preset
                });
            } else {
                // 只有 URL 变了
                console.log('[AI Uploader] 编辑模式：只更新URL');
                vscode.postMessage({
                    type: 'updatePlatformPreset',
                    preset: preset
                });
            }
        } else {
            // 新增模式
            console.log('[AI Uploader] 新增模式，发送消息:', preset);
            vscode.postMessage({
                type: 'addPlatformPreset',
                preset: preset
            });
        }
        
        hideAddSiteForm();
    }

    // 启动

    function initMcpModal() {
        const configMcpBtn = document.getElementById('configMcpBtn');
        const modal = document.getElementById('mcpModal');
        if (!configMcpBtn || !modal) {
            return;
        }

        const closeBtn = modal.querySelector('.modal-close');
        const addMcpBtn = document.getElementById('addMcpBtn');
        const cancelAddMcpBtn = document.getElementById('cancelAddMcpBtn');
        const confirmAddMcpBtn = document.getElementById('confirmAddMcpBtn');

        configMcpBtn.addEventListener('click', () => {
            modal.classList.add('active');
            hideAddMcpForm();
            renderMcpList();
        });

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.classList.remove('active');
                hideAddMcpForm();
            });
        }

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
                hideAddMcpForm();
            }
        });

        if (addMcpBtn) {
            addMcpBtn.addEventListener('click', showAddMcpForm);
        }
        if (cancelAddMcpBtn) {
            cancelAddMcpBtn.addEventListener('click', hideAddMcpForm);
        }
        if (confirmAddMcpBtn) {
            confirmAddMcpBtn.addEventListener('click', confirmAddMcpJson);
        }
    }

    function initBatchImportModal() {
        const modal = document.getElementById('batchImportModal');
        const input = document.getElementById('batchImportInput');
        const pasteBtn = document.getElementById('batchImportPasteBtn');
        const cancelBtn = document.getElementById('batchImportCancelBtn');
        const confirmBtn = document.getElementById('batchImportConfirmBtn');
        if (!modal || !input || !pasteBtn || !cancelBtn || !confirmBtn) {
            return;
        }
        batchImportInputEl = input;

        const closeModal = () => {
            modal.classList.remove('active');
            input.value = '';
        };

        const openModal = () => {
            modal.classList.add('active');
            input.value = '';
            input.focus();
        };

        batchImportBtn && batchImportBtn.addEventListener('click', openModal);
        modal.querySelector('.modal-close')?.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        pasteBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'requestClipboardText' });
        });
        cancelBtn.addEventListener('click', closeModal);
        confirmBtn.addEventListener('click', () => {
            const names = input.value
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);
            if (names.length === 0) {
                return;
            }
            vscode.postMessage({ type: 'batchImportFilesByNames', names });
            closeModal();
        });
    }

    function renderMcpList() {
        const mcpListEl = document.getElementById('mcpList');
        if (!mcpListEl) {
            return;
        }

        const entries = Object.entries((mcpConfig && mcpConfig.mcpServers) || {});
        if (entries.length === 0) {
            mcpListEl.innerHTML = '<div class="empty-sites"><p>No MCP servers configured</p></div>';
            return;
        }

        const statusMap = {
            ready: '就绪',
            starting: '启动中',
            error: '异常',
            stopped: '未启动'
        };

        mcpListEl.innerHTML = entries.map(([name, server]) => {
            const isExecutor = mcpConfig.executor === name;
            const isLocked = !!server.locked;
            const enabled = isLocked ? true : !!server.enabled;
            const argsText = Array.isArray(server.args) ? server.args.join(' ') : '';
            const runtime = mcpRuntimeStatus[name] || { status: 'stopped' };
            const statusLabel = statusMap[runtime.status] || runtime.status;
            const errorText = runtime.lastError ? '<span class="mcp-error">(' + escapeHtml(runtime.lastError) + ')</span>' : '';
            const startLabel = runtime.status === 'ready' ? '已就绪' : runtime.status === 'starting' ? '启动中' : '启动';
            const startDisabled = runtime.status === 'ready' || runtime.status === 'starting' ? ' disabled' : '';

            return '<div class="site-item" data-mcp-name="' + encodeURIComponent(name) + '">' +
                '<div class="site-info">' +
                '<div class="site-name">' + escapeHtml(name) + (isExecutor ? ' (executor)' : '') + '</div>' +
                '<div class="site-url">' + escapeHtml((server.command || '') + (argsText ? ' ' + argsText : '')) + '</div>' +
                '</div>' +
                '<div class="mcp-item-actions">' +
                '<div class="mcp-status-row">' +
                '<span class="mcp-status-label">' + statusLabel + '</span>' +
                errorText +
                '<button class="mcp-start-btn" data-mcp-name="' + encodeURIComponent(name) + '"' + startDisabled + '>' + startLabel + '</button>' +
                '</div>' +
                '<label class="mcp-inline-label">' +
                '<input type="checkbox" class="mcp-enabled-toggle" ' + (enabled ? 'checked' : '') + ' ' + (isLocked ? 'disabled' : '') + '>' +
                '<span>' + (isLocked ? 'Always On' : 'Enabled') + '</span>' +
                '</label>' +
                '<label class="mcp-inline-label">' +
                '<input type="radio" name="mcpExecutor" class="mcp-executor-radio" ' + (isExecutor ? 'checked' : '') + '>' +
                '<span>Executor</span>' +
                '</label>' +
                '</div>' +
                '</div>';
        }).join('');

        mcpListEl.querySelectorAll('.mcp-enabled-toggle').forEach((input) => {
            input.addEventListener('change', (e) => {
                const item = e.currentTarget.closest('.site-item');
                if (!item) return;
                const name = decodeURIComponent(item.dataset.mcpName);
                vscode.postMessage({
                    type: 'updateMcpServerEnabled',
                    name,
                    enabled: !!e.currentTarget.checked
                });
            });
        });

        mcpListEl.querySelectorAll('.mcp-executor-radio').forEach((input) => {
            input.addEventListener('change', (e) => {
                if (!e.currentTarget.checked) return;
                const item = e.currentTarget.closest('.site-item');
                if (!item) return;
                const name = decodeURIComponent(item.dataset.mcpName);
                vscode.postMessage({
                    type: 'setMcpExecutor',
                    name
                });
            });
        });

        mcpListEl.querySelectorAll('.mcp-start-btn').forEach((button) => {
            button.addEventListener('click', () => {
                const name = decodeURIComponent(button.dataset.mcpName);
                vscode.postMessage({
                    type: 'startMcpServer',
                    name
                });
            });
        });
    }
    function showAddMcpForm() {
        const form = document.getElementById('addMcpForm');
        const input = document.getElementById('mcpJsonInput');
        if (!form || !input) {
            return;
        }

        form.style.display = 'block';
        input.value = '';
        input.focus();
    }

    function hideAddMcpForm() {
        const form = document.getElementById('addMcpForm');
        if (!form) {
            return;
        }
        form.style.display = 'none';
    }

    function confirmAddMcpJson() {
        const input = document.getElementById('mcpJsonInput');
        if (!input) {
            return;
        }

        const rawJson = input.value.trim();
        if (!rawJson) {
            return;
        }

        vscode.postMessage({
            type: 'addMcpServersByJson',
            json: rawJson
        });
        hideAddMcpForm();
    }

    init();
})();
