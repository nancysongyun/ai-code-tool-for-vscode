import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { AIPanelProvider } from './panels/AIPanelProvider';

export function activate(context: vscode.ExtensionContext) {


    // 创建面板提供者
    const panelProvider = new AIPanelProvider(context.extensionUri, context);

    // 注册 Webview 视图
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AIPanelProvider.viewType,
            panelProvider
        )
    );

    // 注册所有命令
    registerCommands(context, panelProvider);
}

export function deactivate() {
    console.log('AI Code Uploader 插件已停用');
}
