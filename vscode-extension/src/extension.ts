import * as vscode from 'vscode';
import WebSocket, { WebSocketServer } from 'ws';
import * as path from 'path';
import type { IncomingMessage } from 'http';

export function activate(context: vscode.ExtensionContext) {
    const injector = new LiveCodeInjector(context);
    injector.activate();
}

export function deactivate() {
    // Cleanup handled by LiveCodeInjector via disposables
}

interface CodeMessage {
    type: 'javascript' | 'css';
    code: string;
    filename: string;
    filepath: string;
    timestamp: number;
}

interface PingMessage {
    type: 'ping';
    timestamp: number;
    source: string;
}

interface PongMessage {
    type: 'pong';
    timestamp: number;
    originalTimestamp: number;
}

interface ConnectedMessage {
    type: 'connected';
    message: string;
}

type OutgoingMessage = CodeMessage | PongMessage | ConnectedMessage;

class LiveCodeInjector {
    private context: vscode.ExtensionContext;
    private wss: WebSocketServer | null = null;
    private clients: Set<WebSocket> = new Set();
    private isEnabled: boolean = true;
    private statusBarItem: vscode.StatusBarItem;
    private lastUserActivity: number = Date.now();
    private outputChannel: vscode.OutputChannel;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'liveCodeInjector.toggleServer';
        this.outputChannel = vscode.window.createOutputChannel('Live Code Injector');
    }

    activate() {
        this.registerCommands();
        this.setupFileWatcher();
        this.setupUserActivityTracking();
        this.updateStatusBar();

        const config = vscode.workspace.getConfiguration('liveCodeInjector');
        if (config.get('autoStartServer', true)) {
            this.startServer();
        }
    }

    private registerCommands() {
        const commands = [
            vscode.commands.registerCommand('liveCodeInjector.enable', () => this.enable()),
            vscode.commands.registerCommand('liveCodeInjector.disable', () => this.disable()),
            vscode.commands.registerCommand('liveCodeInjector.startServer', () => this.startServer()),
            vscode.commands.registerCommand('liveCodeInjector.stopServer', () => this.stopServer()),
            vscode.commands.registerCommand('liveCodeInjector.executeCurrentFile', () => this.executeCurrentFile()),
            vscode.commands.registerCommand('liveCodeInjector.toggleServer', () => this.toggleServer()),
        ];

        commands.forEach(cmd => this.context.subscriptions.push(cmd));
        this.context.subscriptions.push(this.statusBarItem);
        this.context.subscriptions.push(this.outputChannel);

        // Ensure cleanup on deactivate
        this.context.subscriptions.push({
            dispose: () => this.stopServer()
        });
    }

    private setupFileWatcher() {
        const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (!this.isEnabled) { return; }

            // Only process saves within 5s of user activity (skip auto-saves)
            const timeSinceActivity = Date.now() - this.lastUserActivity;
            if (timeSinceActivity < 5000) {
                this.handleDocumentSave(document);
            } else {
                this.log(`Ignoring auto-save: ${path.basename(document.fileName)}`);
            }
        });

        this.context.subscriptions.push(saveListener);
    }

    private setupUserActivityTracking() {
        const activities = [
            vscode.window.onDidChangeTextEditorSelection(() => {
                this.lastUserActivity = Date.now();
            }),
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.lastUserActivity = Date.now();
            }),
            vscode.workspace.onDidChangeTextDocument(() => {
                this.lastUserActivity = Date.now();
            }),
            vscode.window.onDidChangeTextEditorVisibleRanges(() => {
                this.lastUserActivity = Date.now();
            })
        ];

        activities.forEach(d => this.context.subscriptions.push(d));
    }

    // ── Embedded WebSocket Server ──────────────────────────────────

    private startServer() {
        if (this.wss) {
            vscode.window.showInformationMessage('Live Injector server is already running.');
            return;
        }

        const config = vscode.workspace.getConfiguration('liveCodeInjector');
        const port = config.get('serverPort', 8765);

        try {
            this.wss = new WebSocketServer({ port, perMessageDeflate: false });

            this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
                this.log(`Client connected from ${req.socket.remoteAddress}`);
                this.clients.add(ws);
                this.updateStatusBar();

                this.sendTo(ws, {
                    type: 'connected',
                    message: 'Live Injector Server Connected (v2 — embedded)'
                });

                ws.on('message', (raw: WebSocket.RawData) => {
                    try {
                        const data = JSON.parse(raw.toString());
                        this.handleClientMessage(ws, data);
                    } catch {
                        this.log('Error parsing client message');
                    }
                });

                ws.on('close', () => {
                    this.log('Client disconnected');
                    this.clients.delete(ws);
                    this.updateStatusBar();
                });

                ws.on('error', (err: Error) => {
                    this.log(`Client error: ${err.message}`);
                    this.clients.delete(ws);
                    this.updateStatusBar();
                });
            });

            this.wss.on('error', (err: Error) => {
                if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
                    vscode.window.showErrorMessage(
                        `Live Injector: Port ${port} is already in use. Change it in settings or stop the other process.`
                    );
                } else {
                    vscode.window.showErrorMessage(`Live Injector server error: ${err.message}`);
                }
                this.wss = null;
                this.updateStatusBar();
            });

            this.log(`Server running on ws://localhost:${port}`);
            vscode.window.showInformationMessage(`Live Injector server started on port ${port}`);
            this.updateStatusBar();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to start server: ${err.message}`);
            this.wss = null;
            this.updateStatusBar();
        }
    }

    private stopServer() {
        if (!this.wss) { return; }

        // Close all client connections
        this.clients.forEach(ws => {
            try { ws.close(); } catch { /* ignore */ }
        });
        this.clients.clear();

        this.wss.close();
        this.wss = null;

        this.log('Server stopped');
        vscode.window.showInformationMessage('Live Injector server stopped');
        this.updateStatusBar();
    }

    private toggleServer() {
        if (this.wss) {
            this.stopServer();
        } else {
            this.startServer();
        }
    }

    private handleClientMessage(ws: WebSocket, data: any) {
        switch (data.type) {
            case 'ping': {
                const pong: PongMessage = {
                    type: 'pong',
                    timestamp: Date.now(),
                    originalTimestamp: data.timestamp
                };
                this.sendTo(ws, pong);
                break;
            }
            case 'test':
                this.log(`Test message from client: ${data.message}`);
                break;
            default:
                this.log(`Unknown client message type: ${data.type}`);
        }
    }

    // ── File handling ──────────────────────────────────────────────

    private handleDocumentSave(document: vscode.TextDocument) {
        const ext = path.extname(document.fileName).toLowerCase();
        const config = vscode.workspace.getConfiguration('liveCodeInjector');
        const supportedExtensions = config.get<string[]>('supportedExtensions', ['.js', '.css']);

        if (!supportedExtensions.includes(ext)) { return; }

        let type: 'javascript' | 'css';
        if (ext === '.js') {
            type = 'javascript';
        } else if (ext === '.css') {
            type = 'css';
        } else {
            return;
        }

        const message: CodeMessage = {
            type,
            code: document.getText(),
            filename: path.basename(document.fileName),
            filepath: document.fileName,
            timestamp: Date.now()
        };

        this.broadcast(message);
        this.showStatusMessage(`Sent ${message.filename} to browser`, 2000);
    }

    private executeCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor found');
            return;
        }

        const ext = path.extname(editor.document.fileName).toLowerCase();
        if (!['.js', '.css'].includes(ext)) {
            vscode.window.showWarningMessage('Only .js and .css files are supported.');
            return;
        }

        editor.document.save().then(() => {
            this.handleDocumentSave(editor.document);
        });
    }

    // ── Broadcasting ───────────────────────────────────────────────

    private broadcast(message: OutgoingMessage) {
        const data = JSON.stringify(message);
        let sent = 0;
        this.clients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
                sent++;
            }
        });
        this.log(`Broadcast ${(message as any).type} to ${sent} client(s)`);
    }

    private sendTo(ws: WebSocket, message: OutgoingMessage) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    // ── UI ─────────────────────────────────────────────────────────

    private enable() {
        this.isEnabled = true;
        vscode.workspace.getConfiguration('liveCodeInjector')
            .update('enabled', true, vscode.ConfigurationTarget.Global);
        this.updateStatusBar();
        vscode.window.showInformationMessage('Live Code Injector enabled');
    }

    private disable() {
        this.isEnabled = false;
        vscode.workspace.getConfiguration('liveCodeInjector')
            .update('enabled', false, vscode.ConfigurationTarget.Global);
        this.updateStatusBar();
        vscode.window.showInformationMessage('Live Code Injector disabled');
    }

    private updateStatusBar() {
        const serverRunning = this.wss !== null;
        const clientCount = this.clients.size;

        if (!this.isEnabled) {
            this.statusBarItem.text = '$(circle-slash) Live Injector: Disabled';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (serverRunning && clientCount > 0) {
            this.statusBarItem.text = `$(broadcast) Live Injector: ${clientCount} client${clientCount > 1 ? 's' : ''}`;
            this.statusBarItem.backgroundColor = undefined;
        } else if (serverRunning) {
            this.statusBarItem.text = '$(radio-tower) Live Injector: Waiting...';
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = '$(circle-outline) Live Injector: Off';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }

        this.statusBarItem.show();
    }

    private showStatusMessage(message: string, timeout: number = 3000) {
        const d = vscode.window.setStatusBarMessage(message, timeout);
        setTimeout(() => d.dispose(), timeout);
    }

    private log(message: string) {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
}
