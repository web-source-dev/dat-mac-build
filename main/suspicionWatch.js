'use strict';

const { execFile } = require('child_process');
const { sendScreenReport } = require('./screenReport');

const EDITORS = new Set([
  'code',
  'code - insiders',
  'cursor',
  'devenv',
  'idea',
  'idea64',
  'pycharm',
  'pycharm64',
  'webstorm',
  'webstorm64',
  'rider',
  'rider64',
  'clion',
  'clion64',
  'goland',
  'goland64',
  'phpstorm',
  'phpstorm64',
  'rustrover',
  'rustrover64',
  'rubymine',
  'rubymine64',
  'sublime_text',
  'notepad++',
  'atom',
  'zed',
  'windsurf',
  'fleet',
  'emacs',
  'code-oss',
  'codium',
  'vscodium',
  'studio64'
]);

const TERMINALS = new Set([
  'windowsterminal',
  'openconsole',
  'cmd',
  'powershell',
  'pwsh',
  'powershell_ise',
  'bash',
  'wsl',
  'ubuntu',
  'debian',
  'mintty',
  'conemu',
  'conemu64',
  'hyper',
  'alacritty',
  'wezterm',
  'wezterm-gui',
  'tabby',
  'git-bash'
]);

const TITLE_MARKS = [
  /visual studio code/i,
  /\bcursor\b/i,
  /intellij idea/i,
  /pycharm/i,
  /webstorm/i,
  /sublime text/i,
  /notepad\+\+/i,
  /android studio/i,
  /windsurf/i
];

const TERM_TITLE = /\b(command prompt|windows powershell|powershell|windows terminal|git bash|mingw|wsl|ubuntu|debian|terminal)\b/i;
const DEVTOOLS_TITLE = /devtools|developer tools|inspect element/i;
const CODE_TITLE = /\.(jsx?|tsx?|mjs|cjs|py|php|rb|go|rs|java|cs|cpp|cc|c|h|hpp|css|scss|vue|json|ya?ml|sh|ps1|bat|sql|env)\b|github\.com\/.+\/blob\/|stackoverflow\.com\/questions|codepen\.io|jsfiddle\.net|replit\.com|codesandbox\.io|vscode\.dev|github\.dev/i;

const FOREGROUND_SCRIPT = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class DeskForeground {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
  '}',
  '"@',
  '$handle = [DeskForeground]::GetForegroundWindow()',
  '$title = New-Object System.Text.StringBuilder 512',
  '[DeskForeground]::GetWindowText($handle, $title, $title.Capacity) | Out-Null',
  '$procId = [uint32]0',
  '[DeskForeground]::GetWindowThreadProcessId($handle, [ref]$procId) | Out-Null',
  '$name = ""',
  'try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}',
  'Write-Output ($name + "`t" + $title.ToString())'
].join('\n');

const COOLDOWN_MS = 45 * 1000;

let readProfile = async () => ({ allowRemote: false });
let timer = null;
let stopped = false;
let checking = false;
let lastKey = '';
let lastAt = 0;
let warned = false;

function readForeground() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_SCRIPT],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          if (!warned) {
            warned = true;
            console.warn('[ALERT] Could not read the front window:', err.message);
          }
          resolve(null);
          return;
        }
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        const split = line.indexOf('\t');
        if (split < 0) {
          resolve(null);
          return;
        }
        resolve({
          process: line.slice(0, split).trim(),
          title: line.slice(split + 1).trim().slice(0, 180)
        });
      }
    );
  });
}

function knownName(processName) {
  const known = {
    code: 'Visual Studio Code',
    cursor: 'Cursor',
    devenv: 'Visual Studio',
    idea64: 'IntelliJ IDEA',
    pycharm64: 'PyCharm',
    webstorm64: 'WebStorm',
    sublime_text: 'Sublime Text',
    'notepad++': 'Notepad++',
    windsurf: 'Windsurf',
    zed: 'Zed',
    windowsterminal: 'Windows Terminal',
    cmd: 'Command Prompt',
    powershell: 'PowerShell',
    pwsh: 'PowerShell',
    powershell_ise: 'PowerShell ISE',
    bash: 'Bash',
    wsl: 'WSL',
    mintty: 'Git Bash'
  };
  return known[String(processName || '').toLowerCase()] || processName || 'Window';
}

function classifyWindow(processName, title) {
  const name = String(processName || '').toLowerCase();
  const text = String(title || '');
  if (!name || name === 'electron' || name === 'datdesk') return null;
  if (TERMINALS.has(name) || TERM_TITLE.test(text)) {
    return { kind: 'terminal', label: knownName(processName), title: text };
  }
  if (EDITORS.has(name) || TITLE_MARKS.some((pattern) => pattern.test(text))) {
    return { kind: 'editor', label: knownName(processName), title: text };
  }
  if (DEVTOOLS_TITLE.test(text)) {
    return { kind: 'devtools', label: 'Developer tools', title: text };
  }
  if (CODE_TITLE.test(text)) {
    return { kind: 'code', label: knownName(processName), title: text };
  }
  return null;
}

function alertMessage(hit) {
  const where = hit.title ? `. ${hit.title}` : '';
  if (hit.kind === 'terminal') return `Terminal open: ${hit.label}${where}`;
  if (hit.kind === 'devtools') return `Developer tools open: ${hit.label}${where}`;
  if (hit.kind === 'code') return `Code on screen: ${hit.label}${where}`;
  return `Code editor open: ${hit.label}${where}`;
}

async function checkFrontWindow() {
  if (stopped || checking) return;
  checking = true;
  try {
    const profile = await readProfile();
    if (!profile?.allowRemote || !profile?.deviceId) return;
    const front = await readForeground();
    const hit = front ? classifyWindow(front.process, front.title) : null;
    if (!hit) return;
    const key = `${hit.kind}|${front.process}|${hit.title}`;
    if (key === lastKey && Date.now() - lastAt < COOLDOWN_MS) return;
    lastKey = key;
    lastAt = Date.now();
    const label = hit.label;
    const message = alertMessage(hit);
    const result = await sendScreenReport({
      message,
      user: {
        email: profile.email || '',
        userId: profile.userId || '',
        deviceId: profile.deviceId
      },
      source: 'alert'
    });
    if (!result?.ok) {
      lastAt = 0;
      console.warn('[ALERT] Screenshot was not sent:', result?.message || 'unknown');
      return;
    }
    const { reportActivity } = require('./activityLog');
    reportActivity('alert', { app: label, title: front.title || '' }, {
      email: profile.email || '',
      userId: profile.userId || '',
      deviceId: profile.deviceId
    });
  } catch (err) {
    console.warn('[ALERT]', err.message);
  } finally {
    checking = false;
  }
}

function startSuspicionWatch(getProfile) {
  if (typeof getProfile === 'function') readProfile = getProfile;
  if (timer || stopped) return;
  stopped = false;
  timer = setInterval(checkFrontWindow, 2500);
  setTimeout(checkFrontWindow, 1200);
}

function stopSuspicionWatch() {
  stopped = true;
  clearInterval(timer);
  timer = null;
}

module.exports = { startSuspicionWatch, stopSuspicionWatch };
