'use strict';
/**
 * Запуск браузера (Chrome/Edge) и работа с вкладками через CDP.
 *
 * Три режима профиля:
 *   clean      — временный профиль, каждый запуск с нуля (по умолчанию)
 *   persistent — постоянный профиль рядом с плагином: логинишься один раз, дальше сохраняется
 *   system     — ваш реальный профиль Chrome (закрытые страницы под вашей сессией)
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connectCdp } = require('./cdp');

const WIN_BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const POSIX_BROWSER_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** Найти исполняемый файл браузера. */
function findBrowser(explicitPath) {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) return explicitPath;
    throw new Error(`Указанный браузер не найден: ${explicitPath}`);
  }
  const fromEnv = process.env.W2F_BROWSER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = process.platform === 'win32' ? WIN_BROWSER_PATHS : POSIX_BROWSER_PATHS;
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    'Не найден Chrome или Edge. Укажите путь вручную: W2F_BROWSER="C:\\путь\\chrome.exe"'
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET JSON без зависимостей. */
function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** Разрешить каталог профиля под выбранный режим. */
function resolveProfileDir(mode, baseDir) {
  if (mode === 'system') return null; // используем системный профиль по умолчанию
  if (mode === 'persistent') {
    const dir = path.join(baseDir, '.profile');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2f-profile-'));
  return dir;
}

class Browser {
  constructor(opts = {}) {
    this.headless = opts.headless !== false;
    this.profileMode = opts.profileMode || 'clean';
    this.baseDir = opts.baseDir || __dirname;
    this.extraArgs = opts.extraArgs || [];
    this.executablePath = findBrowser(opts.executablePath);
    this.proc = null;
    this.port = 0;
    this.wsUrl = '';
    this.conn = null;
    this.userDataDir = null;
    this._tempProfile = false;
  }

  async launch() {
    this.userDataDir = resolveProfileDir(this.profileMode, this.baseDir);
    this._tempProfile = this.profileMode === 'clean';

    const args = [
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-client-side-phishing-detection',
      '--disable-sync',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
    ];
    if (this.headless) args.push('--headless=new', '--disable-gpu');
    if (this.userDataDir) args.push(`--user-data-dir=${this.userDataDir}`);
    if (!this.headless) args.push('--window-size=1600,1200');
    args.push(...this.extraArgs, 'about:blank');

    this.proc = spawn(this.executablePath, args, {
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    this.proc.on('error', (err) => {
      this._launchError = err;
    });

    const { port, wsPath } = await this._waitForDevToolsPort(25000);
    this.port = port;
    this.wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
    this.conn = await connectCdp(this.wsUrl);
    return this;
  }

  async _waitForDevToolsPort(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const probePort = async (port) => {
      try {
        const info = await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1500);
        if (info && info.webSocketDebuggerUrl) {
          const m = /^ws:\/\/[^/]+(\/.*)$/.exec(info.webSocketDebuggerUrl);
          return { port, wsPath: m ? m[1] : '/devtools/browser' };
        }
      } catch { /* ещё не поднялся */ }
      return null;
    };

    // 1) Явный --remote-debugging-port
    while (Date.now() < deadline) {
      if (this._launchError) throw this._launchError;

      // port=0 → Chrome пишет фактический порт в DevToolsActivePort
      const portFile = this.userDataDir
        ? path.join(this.userDataDir, 'DevToolsActivePort')
        : path.join(defaultSystemProfileDir(), 'DevToolsActivePort');
      if (fs.existsSync(portFile)) {
        try {
          const lines = fs.readFileSync(portFile, 'utf8').split('\n');
          const port = parseInt(lines[0], 10);
          if (port > 0) {
            const probed = await probePort(port);
            if (probed) return probed;
            const wsPath = (lines[1] || '').trim() || '/devtools/browser';
            return { port, wsPath: wsPath.startsWith('/') ? wsPath : '/' + wsPath };
          }
        } catch { /* файл ещё дописывается */ }
      }
      await sleep(150);
    }
    throw new Error(
      'Браузер не отдал отладочный порт за 25 секунд. ' +
      'Если Chrome уже запущен — закройте его или используйте режим профиля «постоянный».'
    );
  }

  /** Создать вкладку, дождаться загрузки, вернуть объект сессии. */
  async openPage(url, { width = 1440, height = 900, waitMs = 900, timeoutMs = 45000, enableNetwork = false } = {}) {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });

    await this.conn.send('Page.enable', {}, sessionId);
    await this.conn.send('DOM.enable', {}, sessionId);
    await this.conn.send('Runtime.enable', {}, sessionId);

    const page = new Page(this, targetId, sessionId);

    // Индекс ответов сети: позволяет забрать тело картинки через CDP,
    // где ограничения CORS не действуют вообще.
    //
    // Тело забирается СРАЗУ по завершении загрузки. Если отложить это до конца
    // захвата, Chrome успевает вытеснить тела из буфера, и картинка теряется —
    // именно так на habr.com пропадало большинство изображений.
    if (enableNetwork) {
      page.networkIndex = new Map();
      page.imageBodies = new Map();
      const byRequestId = new Map();
      const bodyQueue = [];
      let draining = false;
      let bufferedBytes = 0;
      const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
      const MAX_ONE_BYTES = 16 * 1024 * 1024;

      // Тела забираются очередью: если просто отбрасывать лишние запросы
      // при превышении параллелизма, картинки теряются молча.
      const drain = async () => {
        if (draining) return;
        draining = true;
        while (bodyQueue.length) {
          if (bufferedBytes > MAX_TOTAL_BYTES) { bodyQueue.length = 0; break; }
          const batch = bodyQueue.splice(0, 8);
          await Promise.all(batch.map(async (entry) => {
            try {
              const res = await this.conn.send('Network.getResponseBody',
                { requestId: entry.requestId }, sessionId);
              if (!res || !res.body) return;
              const buf = res.base64Encoded
                ? Buffer.from(res.body, 'base64')
                : Buffer.from(res.body, 'binary');
              if (!buf.length) return;
              bufferedBytes += buf.length;
              page.imageBodies.set(entry.url, { buf, mime: entry.mime });
            } catch (e) { /* тело вытеснено — сработает резервный путь */ }
          }));
        }
        draining = false;
      };
      page.drainImageBodies = drain;

      try {
        await this.conn.send('Network.enable', {
          maxTotalBufferSize: 256 * 1024 * 1024,
          maxResourceBufferSize: 64 * 1024 * 1024,
        }, sessionId);

        this.conn.on('Network.responseReceived', (p) => {
          if (!p || !p.response) return;
          const mime = p.response.mimeType || '';
          if (p.type === 'Image' || /^image\//i.test(mime)) {
            const entry = { requestId: p.requestId, mime, url: p.response.url };
            page.networkIndex.set(p.response.url, entry);
            byRequestId.set(p.requestId, entry);
          }
        }, sessionId);

        this.conn.on('Network.loadingFinished', (p) => {
          if (!p) return;
          const entry = byRequestId.get(p.requestId);
          if (!entry) return;
          byRequestId.delete(p.requestId);
          if ((p.encodedDataLength || 0) > MAX_ONE_BYTES) return;
          bodyQueue.push(entry);
          drain();
        }, sessionId);
      } catch (e) { /* без индекса останется резервный способ */ }
    }

    await this.conn.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId
    );

    // Ждём готовности DOM, а не события load: его надолго откладывают
    // аналитика и трекеры — на habr.com ожидание доходило до 60 секунд.
    const domTimeout = Math.min(timeoutMs, 20000);
    const loaded = this.conn.once('Page.domContentEventFired', domTimeout, sessionId).catch(() => null);
    await this.conn.send('Page.navigate', { url }, sessionId);
    await loaded;
    if (waitMs > 0) await sleep(waitMs);

    return page;
  }

  async close() {
    try { if (this.conn) await this.conn.send('Browser.close'); } catch { /* noop */ }
    if (this.conn) this.conn.close();
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill(); } catch { /* noop */ }
    }
    if (this._tempProfile && this.userDataDir) {
      try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

function opts_noViewportWindow(browser) {
  return !browser.headless;
}

function defaultSystemProfileDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  }
  return path.join(os.homedir(), '.config/google-chrome');
}

class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.networkIndex = null;
  }

  send(method, params = {}) {
    return this.browser.conn.send(method, params, this.sessionId);
  }

  /** Подписаться на событие CDP этой вкладки. */
  on(method, handler) {
    return this.browser.conn.on(method, handler, this.sessionId);
  }

  /**
   * Выполнить выражение/функцию в странице.
   * @param {Function|string} fnOrExpr
   * @param {{args?: any[], awaitPromise?: boolean, returnByValue?: boolean}} [opts]
   */
  async evaluate(fnOrExpr, opts = {}) {
    const { args = [], awaitPromise = true, returnByValue = true } = opts;
    let expression;
    if (typeof fnOrExpr === 'function') {
      const passed = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(', ');
      expression = `(${fnOrExpr.toString()})(${passed})`;
    } else {
      expression = String(fnOrExpr);
    }
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception
        ? (res.exceptionDetails.exception.description || res.exceptionDetails.exception.value)
        : res.exceptionDetails.text;
      throw new Error(`Ошибка в странице: ${text}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async close() {
    try { await this.browser.conn.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* noop */ }
  }
}

module.exports = { Browser, Page, findBrowser, sleep, defaultSystemProfileDir };
