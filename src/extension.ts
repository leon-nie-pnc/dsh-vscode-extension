/**
 * dsh-chat extension entry point.
 *
 * The DeepSeek Harness web chat is contributed as a webview view in the panel
 * area, so it docks as a tab beside other assistant panels (CHAT, CLAUDE CODE,
 * CODEX) and can be moved or widened like them. The view embeds the local
 * `dsh web` server via iframe, backed by one supervised child process.
 * @module dsh-chat/extension
 */

import * as vscode from 'vscode'
import { resolveDshConfig, workspaceCwd, type DshConfig } from './config'
import { isServerHealthy, startDsh, stopChild, type RunningDsh } from './dsh-process'

/** Output channel for the `dsh web` process logs. */
let output: vscode.OutputChannel
/** The currently supervised server, if any. */
let running: RunningDsh | undefined
/** Status bar item showing the server state. */
let statusBar: vscode.StatusBarItem
/** The panel chat view, once resolved. */
let chatView: vscode.WebviewView | undefined

/**
 * Extension activation: create the output channel and status bar, register the
 * panel chat view and the dsh.* commands.
 * @param context - the extension context.
 */
export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('DSH')
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = 'dsh.openPanel'
  context.subscriptions.push(statusBar, output)

  const provider = new DshChatProvider()
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh-chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openPanel', () => void vscode.commands.executeCommand('dsh-chat.focus')),
    vscode.commands.registerCommand('dsh.start', () => void ensureRunning()),
    vscode.commands.registerCommand('dsh.restart', () => void restart()),
    vscode.commands.registerCommand('dsh.stop', () => void stop()),
    vscode.commands.registerCommand('dsh.openInBrowser', () => void openInBrowser()),
  )

  // Adopt an already-running server on activation so the status bar reflects
  // reality even before the view is opened.
  void refreshStatusFromExisting()
}

/**
 * Deactivate: stop the child process this extension spawned.
 */
export function deactivate(): void {
  stop()
}

/** Resolve the current config, or surface the error and return undefined. */
function tryConfig(): DshConfig | undefined {
  try {
    return resolveDshConfig()
  } catch (error) {
    setStatus('error')
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${messageOf(error)}`)
    return undefined
  }
}

/** Ensure a supervised server is running and healthy. */
async function ensureRunning(): Promise<RunningDsh | undefined> {
  const config = tryConfig()
  if (config === undefined) return undefined
  setStatus('starting')
  output.appendLine(`starting: ${config.bin} web --host ${config.host} --port ${config.port}`)
  try {
    running = await startDsh(config, workspaceCwd(), line => output.appendLine(line))
  } catch (error) {
    running = { status: 'error', url: config.url, error: messageOf(error) }
  }
  if (running.status === 'running') {
    setStatus('running', config.url)
    output.appendLine(`healthy at ${config.url}`)
  } else {
    setStatus('error')
    const detail = running.error ?? 'failed to start'
    output.appendLine(detail)
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${detail}`)
  }
  return running
}

/** Load the chat view's HTML from the current server state. */
function renderView(config: DshConfig, server: RunningDsh | undefined): void {
  if (chatView === undefined) return
  chatView.webview.html = server?.status === 'running'
    ? iframeHtml(server.url, server.proxy?.port ?? config.port)
    : errorHtml(server?.error ?? 'failed to start dsh web')
}

/** Restart: stop any owned child, then start fresh and reload the view. */
async function restart(): Promise<void> {
  stop()
  const config = tryConfig()
  const server = await ensureRunning()
  if (config !== undefined) renderView(config, server)
}

/** Stop the server this extension spawned; leave any adopted server alone. */
function stop(): void {
  if (running === undefined) return
  running.proxy?.dispose()
  stopChild(running.child)
  running = undefined
  setStatus('stopped')
}

/** Open the configured URL in the system browser. */
async function openInBrowser(): Promise<void> {
  const server = running ?? (await ensureRunning())
  if (server !== undefined) {
    await vscode.env.openExternal(vscode.Uri.parse(server.url))
  }
}

/** Reflect an already-running server on the status bar without spawning. */
async function refreshStatusFromExisting(): Promise<void> {
  const config = tryConfig()
  if (config === undefined) return
  setStatus(await isServerHealthy(config.url) ? 'running' : 'stopped', config.url)
}

/** Update the status bar text/tooltip for the given state. */
function setStatus(status: RunningDsh['status'], url?: string): void {
  if (status === 'running') {
    statusBar.text = `$(comment-discussion) DSH`
    statusBar.tooltip = `DeepSeek Harness running at ${url ?? '127.0.0.1:3080'} (click to focus chat)`
  } else if (status === 'starting') {
    statusBar.text = `$(sync~spin) DSH`
    statusBar.tooltip = 'DeepSeek Harness starting…'
  } else if (status === 'error') {
    statusBar.text = `$(error) DSH`
    statusBar.tooltip = 'DeepSeek Harness failed to start (click to retry)'
  } else {
    statusBar.text = `$(comment-discussion) DSH`
    statusBar.tooltip = 'DeepSeek Harness (click to focus chat)'
  }
  statusBar.show()
}

/** Extract a one-line message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The chat iframe document. The CSP allows only the loopback server as a frame
 * source, so the embedded app cannot be replaced by another origin. The iframe
 * is sized to the viewport (100vw/100vh) so it fills the panel view.
 *
 * `src` is the authenticated `?token=` URL announced by `dsh web`; visiting it
 * sets the auth cookie the framed app needs. The CSP allows the whole loopback
 * origin, so the token query on `src` is permitted.
 * @param src - the authenticated URL to frame.
 * @param port - the loopback port, for the frame-src CSP entry.
 */
function iframeHtml(src: string, port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src http://127.0.0.1:${port};">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
    iframe { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`
}

/** A minimal error document shown in the view when the server fails to start. */
function errorHtml(detail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>
<body style="font-family:var(--vscode-font-family);color:var(--vscode-errorForeground);padding:1.5rem">
  <h3>DeepSeek Harness failed to start</h3>
  <p>${escapeHtml(detail)}</p>
  <p>See the <b>DSH</b> output channel for logs, then run <b>DSH: Restart server</b>.</p>
</body>
</html>`
}

/** Escape text for safe interpolation into HTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] ?? ch))
}

/**
 * The panel chat view: docks beside other assistant panels and embeds the
 * DeepSeek Harness web UI. On first resolve it starts (or adopts) the server,
 * then loads the iframe.
 */
class DshChatProvider implements vscode.WebviewViewProvider {
  public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    chatView = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = loadingHtml()
    webviewView.onDidDispose(() => { if (chatView === webviewView) chatView = undefined })

    const config = tryConfig()
    if (config === undefined) {
      webviewView.webview.html = errorHtml('dsh configuration is invalid; see the error notification.')
      return
    }
    const server = await ensureRunning()
    renderView(config, server)
  }
}

/** A brief loading document while the server starts. */
function loadingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>
<body style="font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:1.5rem">
  <p>Starting DeepSeek Harness…</p>
</body>
</html>`
}
