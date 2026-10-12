/**
 * Shared Chromium/Chrome resolution for headless browser suites.
 *
 * `CHROMIUM_PATH` wins when set. Otherwise a usable executable is detected
 * on macOS, Linux, and Windows (known install paths, then PATH). A missing
 * browser is a BLOCKED result — never a pass, and never a silent skip of
 * the assertions that would have run.
 */
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Distinct from assertion failure (1) so the runner can report BLOCKED. */
export const BROWSER_BLOCKED_EXIT = 77;

export class BrowserBlockedError extends Error {
  readonly instructions: string;
  constructor(message: string, instructions: string) {
    super(message);
    this.name = 'BrowserBlockedError';
    this.instructions = instructions;
  }
}

export function isBrowserBlocked(err: unknown): err is BrowserBlockedError {
  return err instanceof BrowserBlockedError || (err instanceof Error && err.name === 'BrowserBlockedError');
}

const PATH_NAMES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'microsoft-edge',
  'msedge'
];

function candidatePaths(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      path.join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
      path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      '/opt/homebrew/bin/chromium',
      '/usr/local/bin/chromium',
      '/usr/local/bin/google-chrome'
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES ?? 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable'
  ];
}

function pathLookup(): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of PATH_NAMES) found.push(path.join(dir, name));
  }
  return found;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function browserSetupInstructions(): string {
  return [
    'Browser tests are BLOCKED — they were not executed and this is not a pass.',
    'Install a Chromium-based browser, or point CHROMIUM_PATH at its executable, then re-run.',
    '  macOS: install Google Chrome (https://www.google.com/chrome/) or `brew install --cask chromium`',
    '         typical path: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '  Linux: `sudo apt-get install -y chromium` or `chromium-browser` or `google-chrome-stable`',
    '  Windows: install Google Chrome or set CHROMIUM_PATH to chrome.exe',
    '  CI: install chromium in the image, or set CHROMIUM_PATH. Headless mode is unchanged.',
    'Do not treat a missing browser as a skipped or passing suite.'
  ].join('\n');
}

/**
 * Resolve a usable browser executable.
 * Throws BrowserBlockedError when none is installed or CHROMIUM_PATH is unusable.
 * An explicit CHROMIUM_PATH is never replaced by a fallback.
 */
export function requireChromiumExecutable(): string {
  const explicit = process.env.CHROMIUM_PATH?.trim();
  if (explicit) {
    const expanded = explicit.startsWith('~/') ? path.join(homedir(), explicit.slice(2)) : explicit;
    if (isExecutable(expanded)) return expanded;
    throw new BrowserBlockedError(
      `CHROMIUM_PATH is set but not a usable executable: ${expanded}`,
      browserSetupInstructions()
    );
  }
  const seen = new Set<string>();
  for (const candidate of [...candidatePaths(), ...pathLookup()]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutable(candidate)) return candidate;
  }
  throw new BrowserBlockedError(
    `No Chromium/Chrome executable found on ${process.platform}.`,
    browserSetupInstructions()
  );
}

/** Print setup instructions and exit 77. Returns false when err is not a block. */
export function exitOnBrowserBlocked(err: unknown): boolean {
  if (!isBrowserBlocked(err)) return false;
  console.error(`BLOCKED: ${err.message}`);
  console.error(err.instructions);
  process.exit(BROWSER_BLOCKED_EXIT);
}
