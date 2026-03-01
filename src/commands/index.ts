import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AIPanelProvider } from '../panels/AIPanelProvider';

// 递归获取目录下所有文件
async function getAllFilesInDirectory(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    
    async function traverse(currentPath: string) {
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
                // 支持所有文件类型
                files.push(fullPath);
            }
        }
    }
    
    await traverse(dirPath);
    return files;
}

export function registerCommands(
    context: vscode.ExtensionContext,
    panelProvider: AIPanelProvider
) {
    // 添加选中代码到 AI 指令
    const addSelectionCmd = vscode.commands.registerCommand(
        'aiUploader.addSelection',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('没有活动的编辑器');
                return;
            }

            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showWarningMessage('请先选择代码');
                return;
            }

            const document = editor.document;
            const filePath = document.fileName;
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            const selectedText = document.getText(selection);

            // 获取选中的行号范围
            const startLine = selection.start.line + 1;
            const endLine = selection.end.line + 1;
            const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

            panelProvider.addFileReference({
                id: `${filePath}#${lineRange}`,
                path: filePath,
                name: fileName,
                lineRange: lineRange,
                content: selectedText,
                type: 'selection'
            });

            vscode.window.showInformationMessage(`已添加选中代码 (${fileName}:${lineRange})`);
        }
    );

    // 添加文件到 AI 指令
    const addFileCmd = vscode.commands.registerCommand(
        'aiUploader.addFile',
        async (uri: vscode.Uri, selectedUris?: vscode.Uri[]) => {
            // 如果有多个选中的URI，处理所有文件
            const urisToProcess = selectedUris && selectedUris.length > 0 
                ? selectedUris.filter(u => u.fsPath && !u.fsPath.endsWith('/'))
                : (uri ? [uri] : []);

            if (urisToProcess.length === 0) {
                vscode.window.showWarningMessage('请从资源管理器中右键选择文件');
                return;
            }

            let successCount = 0;
            let failCount = 0;

            for (const fileUri of urisToProcess) {
                try {
                    const filePath = fileUri.fsPath;
                    const fileName = filePath.split(/[\\/]/).pop() || filePath;

                    // 尝试读取文件内容（支持文本文件和图片等）
                    try {
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        const content = document.getText();
                        const totalLines = document.lineCount;

                        panelProvider.addFileReference({
                            id: filePath,
                            path: filePath,
                            name: fileName,
                            lineRange: `1-${totalLines}`,
                            content: content,
                            type: 'file'
                        });
                        successCount++;
                    } catch (error) {
                        // 对于二进制文件（图片等），只添加文件引用
                        panelProvider.addFileReference({
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
                    console.error(`处理文件失败: ${fileUri.fsPath}`, error);
                }
            }

            if (successCount > 0) {
                vscode.window.showInformationMessage(`已添加 ${successCount} 个文件到 AI 指令`);
            }
            if (failCount > 0) {
                vscode.window.showWarningMessage(`${failCount} 个文件添加失败`);
            }
        }
    );

    // 添加目录到 AI 指令
    const addFolderCmd = vscode.commands.registerCommand(
        'aiUploader.addFolder',
        async (uri: vscode.Uri, selectedUris?: vscode.Uri[]) => {
            const urisToProcess = selectedUris && selectedUris.length > 0
                ? selectedUris.filter(u => u.fsPath)
                : (uri ? [uri] : []);

            if (urisToProcess.length === 0) {
                vscode.window.showWarningMessage('请从资源管理器中右键选择目录');
                return;
            }

            let successCount = 0;
            let failCount = 0;

            for (const folderUri of urisToProcess) {
                try {
                    // 递归读取目录下的所有文件
                    const files = await getAllFilesInDirectory(folderUri.fsPath);
                    
                    for (const filePath of files) {
                        try {
                            const fileUri = vscode.Uri.file(filePath);
                            const fileName = filePath.split(/[\\/]/).pop() || filePath;

                            // 尝试读取文件内容
                            try {
                                const document = await vscode.workspace.openTextDocument(fileUri);
                                const content = document.getText();
                                const totalLines = document.lineCount;

                                panelProvider.addFileReference({
                                    id: filePath,
                                    path: filePath,
                                    name: fileName,
                                    lineRange: `1-${totalLines}`,
                                    content: content,
                                    type: 'file'
                                });
                                successCount++;
                            } catch (error) {
                                // 对于二进制文件（图片等），只添加文件引用
                                panelProvider.addFileReference({
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
                        }
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(`读取目录失败: ${error}`);
                }
            }

            if (successCount > 0) {
                vscode.window.showInformationMessage(`已从目录添加 ${successCount} 个文件到 AI 指令`);
            }
            if (failCount > 0) {
                vscode.window.showWarningMessage(`${failCount} 个文件添加失败`);
            }
        }
    );

    // 打开面板
    const openPanelCmd = vscode.commands.registerCommand(
        'aiUploader.openPanel',
        () => {
            vscode.commands.executeCommand('aiUploaderPanel.focus');
        }
    );

    // 清空所有
    const clearAllCmd = vscode.commands.registerCommand(
        'aiUploader.clearAll',
        () => {
            panelProvider.clearAll();
            vscode.window.showInformationMessage('已清空所有引用');
        }
    );

    context.subscriptions.push(addSelectionCmd, addFileCmd, addFolderCmd, openPanelCmd, clearAllCmd);
}
