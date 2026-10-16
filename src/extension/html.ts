import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Translate } from '../shared/i18n';
import type { Language } from '../shared/protocol';
import type { HostKind } from './controller';

function csp(webview: vscode.Webview, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
}

export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, language: Language, host: HostKind): string {
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', name)).toString();
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('xterm.css')}">
  <link rel="stylesheet" href="${asset('webview.css')}">
  <title>Terminal Grid</title>
</head>
<body data-host="${host}">
  <div id="app"></div>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}

/** A plain message instead of the board, for when grid terminals cannot start. */
export function renderNotice(webview: vscode.Webview, language: Language, text: string): string {
  const escaped = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, randomBytes(16).toString('base64'))}">
  <style>
    body { margin: 0; padding: 16px; box-sizing: border-box; color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <p>${escaped}</p>
</body>
</html>`;
}

/** Shown in the bottom panel while the board is open in an editor tab. */
export function renderPlaceholder(webview: vscode.Webview, language: Language, t: Translate): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, nonce)}">
  <style>
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
      background: var(--vscode-panel-background); color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    button { height: 26px; padding: 0 12px; border: 0; border-radius: 4px; cursor: pointer; font: inherit;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div>${t('placeholder')}</div>
  <button type="button" id="bring">${t('moveToPanel')}</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('bring').addEventListener('click', () => vscode.postMessage({ type: 'bringHere' }));
  </script>
</body>
</html>`;
}
