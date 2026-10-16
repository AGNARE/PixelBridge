'use strict';
/**
 * Локальный движок + мост.
 *
 *   HTTP  — захват страниц, ассеты, приём дизайна от агента
 *   WS    — постоянный канал к плагину Figma
 *
 * Схема:
 *     сайт ──CDP──┐
 *                 ├──► IR ──► плагин ──► слои Figma
 *     агент ─HTTP─┘
 *
 * Без зависимостей: только модули Node.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { captureUrl } = require('./capture');
const { validateIR } = require('./validate');
const { acceptUpgrade } = require('./ws');

const PORT = parseInt(process.env.W2F_PORT || '7331', 10);
const HOST = '127.0.0.1';
const CACHE_DIR = path.join(__dirname, '.cache');
const MAX_BODY = 256 * 1024 * 1024;
const KEEP_SESSIONS = 4;

const state = {
  sessions: new Map(),
  sessionOrder: [],
  plugin: null,
  pluginInfo: null,
  pending: new Map(),
  log: [],
  startedAt: Date.now(),
  counters: { captures: 0, builds: 0, shots: 0, errors: 0 },
};

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 400) state.log.shift();
  console.log(line);
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// Сессии захвата

function createSession(ir, assetsDir, assetFiles) {
  const id = newId('s');
  const session = { id, ir, assetsDir, assetFiles: assetFiles || new Map(), createdAt: Date.now(), previewHtml: null };
  state.sessions.set(id, session);
  state.sessionOrder.push(id);
  while (state.sessionOrder.length > KEEP_SESSIONS) {
    const old = state.sessionOrder.shift();
    const s = state.sessions.get(old);
    if (s && s.assetsDir) {
      try { fs.rmSync(s.assetsDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
    }
    state.sessions.delete(old);
  }
  return session;
}

/** Переписать ссылки на ассеты в абсолютные URL движка. */
function publicIr(session) {
  const ir = JSON.parse(JSON.stringify(session.ir, (k, v) => (k === 'screenshot' ? undefined : v)));
  ir.sessionId = session.id;
  ir.assets = (ir.assets || []).map((a) => Object.assign({}, a, {
    url: `/asset/${session.id}/${a.id}`,
    absoluteUrl: `http://${HOST}:${PORT}/asset/${session.id}/${a.id}`,
  }));
  return ir;
}

// ---------------------------------------------------------------------------
// Утилиты HTTP

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('Тело запроса не является JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Преобразование «дружелюбной» спецификации дизайна в IR

const STYLE_KEY_MAP = {
  fontSize: 'font-size', fontWeight: 'font-weight', fontFamily: 'font-family',
  fontStyle: 'font-style', lineHeight: 'line-height', letterSpacing: 'letter-spacing',
  textAlign: 'text-align', color: 'color', textTransform: 'text-transform',
  background: 'background-color', fill: 'background-color', backgroundColor: 'background-color',
  backgroundImage: 'background-image', boxShadow: 'box-shadow', shadow: 'box-shadow',
  opacity: 'opacity', gap: 'gap', rowGap: 'row-gap', columnGap: 'column-gap',
  display: 'display', flexDirection: 'flex-direction', justifyContent: 'justify-content',
  alignItems: 'align-items', overflow: 'overflow', whiteSpace: 'white-space',
  textDecoration: 'text-decoration-line', borderColor: 'border-top-color',
  borderWidth: 'border-top-width', borderStyle: 'border-top-style',
};

const RADIUS_MAP = {
  radius: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  borderRadius: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
};

function pxIfNumber(v) {
  return typeof v === 'number' ? v + 'px' : v;
}

function coerceStyle(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (key === 'padding') {
      const v = pxIfNumber(value);
      for (const s of ['top', 'right', 'bottom', 'left']) out[`padding-${s}`] = v;
      continue;
    }
    if (key === 'border') {
      const m = /^\s*([\d.]+)(px)?\s+(solid|dashed|dotted)\s+(.+?)\s*$/.exec(String(value));
      if (m) {
        for (const s of ['top', 'right', 'bottom', 'left']) {
          out[`border-${s}-width`] = m[1] + 'px';
          out[`border-${s}-style`] = m[3];
          out[`border-${s}-color`] = m[4];
        }
      }
      continue;
    }
    if (RADIUS_MAP[key]) {
      const v = pxIfNumber(value);
      for (const t of RADIUS_MAP[key]) out[t] = v;
      continue;
    }
    if (STYLE_KEY_MAP[key]) { out[STYLE_KEY_MAP[key]] = pxIfNumber(value); continue; }
    out[key] = pxIfNumber(value);
  }
  return out;
}

function coerceBox(box) {
  if (Array.isArray(box)) return { x: box[0] || 0, y: box[1] || 0, w: box[2] || 0, h: box[3] || 0 };
  if (box && typeof box === 'object') {
    return { x: box.x || 0, y: box.y || 0, w: box.w || box.width || 0, h: box.h || box.height || 0 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

let autoNameCounter = 0;
function coerceNode(node) {
  const type = node.type || (node.text !== undefined ? 'text' : 'frame');
  const out = {
    type,
    tag: node.tag || (type === 'text' ? 'text' : 'div'),
    name: node.name || `${type}-${++autoNameCounter}`,
    box: coerceBox(node.box),
    style: coerceStyle(node.style || node.css || {}),
    children: [],
  };
  if (node.sel) out.sel = node.sel;
  if (node.selPath) out.selPath = node.selPath;
  if (node.text !== undefined) out.text = String(node.text);
  if (node.note) out.note = node.note;
  if (node.runs) out.runs = node.runs;
  if (node.src) out.src = node.src;
  if (node.inlineSrc) out.inlineSrc = node.inlineSrc;
  if (node.bgSrc) out.bgSrc = node.bgSrc;
  if (node.svg) out.svg = node.svg;
  if (node.componentId) out.componentId = String(node.componentId);
  // texts — либо строки, либо объекты {text, color, colorVar}: у компонента
  // текст своего цвета, и подставленное значение иначе осталось бы цветом
  // плейсхолдера. Объекты пропускаем как есть, строки приводим к строке.
  if (Array.isArray(node.texts)) {
    out.texts = node.texts.map((v) => (v && typeof v === 'object' ? v : String(v)));
  }
  if (node.opacity !== undefined) out.opacity = node.opacity;
  for (const c of node.children || []) out.children.push(coerceNode(c));
  return out;
}

/** Дружелюбная спецификация → полноценный IR. */
function normalizeDesignSpec(spec) {
  if (spec && spec.root) {
    return {
      url: spec.url || 'agent://design',
      title: spec.title || spec.name || 'Дизайн агента',
      viewport: spec.viewport || { w: 1440, h: 900 },
      content: spec.content || { w: (spec.width || 1440), h: (spec.height || 900) },
      root: coerceNode(spec.root),
      assets: [],
      stats: {},
      warnings: [],
    };
  }
  const width = spec.width || 1440;
  const height = spec.height || 900;
  const root = {
    type: 'frame',
    tag: 'html',
    name: spec.name || spec.title || 'Дизайн',
    sel: 'html',
    box: { x: 0, y: 0, w: width, h: height },
    style: Object.assign({ display: 'block', 'background-color': spec.background || '#ffffff' }, coerceStyle(spec.style || {})),
    children: (spec.nodes || spec.children || []).map(coerceNode),
  };
  return {
    url: 'agent://design',
    title: spec.name || spec.title || 'Дизайн агента',
    viewport: { w: width, h: height },
    content: { w: width, h: height },
    root,
    assets: [],
    stats: { emitted: (spec.nodes || []).length + 1 },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Обмен с плагином

const PLUGIN_TIMEOUT = 120000;

function pluginRequest(cmd, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!state.plugin || !state.plugin.open) {
      reject(new Error('Плагин не подключён. Откройте плагин Web → Figma Bridge в Figma Desktop.'));
      return;
    }
    const requestId = newId('r');
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error(`Плагин не ответил за ${(timeoutMs || PLUGIN_TIMEOUT) / 1000} с`));
    }, timeoutMs || PLUGIN_TIMEOUT);
    state.pending.set(requestId, { resolve, reject, timer });
    const ok = state.plugin.send({ cmd, requestId, ...payload });
    if (!ok) {
      clearTimeout(timer);
      state.pending.delete(requestId);
      reject(new Error('Не удалось отправить команду в плагин'));
    }
  });
}

function handlePluginMessage(msg) {
  if (msg.type === 'hello') {
    state.pluginInfo = { version: msg.version, file: msg.fileName, page: msg.pageName, at: Date.now() };
    log(`Плагин подключён: v${msg.version}, файл «${msg.fileName || '—'}»`);
    return;
  }
  if (msg.type === 'result' && msg.requestId) {
    const p = state.pending.get(msg.requestId);
    if (!p) return;
    clearTimeout(p.timer);
    state.pending.delete(msg.requestId);
    if (msg.ok === false || msg.error) p.reject(new Error(msg.error || 'Ошибка плагина'));
    else p.resolve(msg.result);
    return;
  }
  if (msg.type === 'progress') {
    const p = state.pending.get(msg.requestId);
    // Не чаще раза в 5 секунд, чтобы журнал не забивался
    if (p) {
      const now = Date.now();
      if (!p.lastLog || now - p.lastLog > 5000) {
        p.lastLog = now;
        log(`прогресс: ${msg.phase} ${msg.done}/${msg.total}` +
          (msg.elapsedMs ? `, прошло ${(msg.elapsedMs / 1000).toFixed(1)} с` : ''));
      }
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Маршруты

async function handleCapture(req, res) {
  const body = await readBody(req);
  const url = body.url;
  if (!url) { sendJson(res, 400, { ok: false, error: 'Не передан url' }); return; }

  const width = body.width || 1440;
  const height = body.height || 900;
  log(`Захват ${url} @ ${width}px…`);
  const t0 = Date.now();

  const assetsDir = path.join(CACHE_DIR, 'assets', newId('a'));
  const ir = await captureUrl(url, {
    width, height,
    profileMode: body.profileMode || 'clean',
    headless: body.headless !== false,
    scrollToLoad: body.scrollToLoad !== false,
    fetchAssets: body.fetchAssets !== false,
    screenshot: body.screenshot === true,
    assetsDir,
    baseDir: __dirname,
    waitMs: body.waitMs || 0,
  });

  // Скриншот не отдаём в JSON — сохраняем файлом и возвращаем путь
  let screenshotFile = null;
  if (ir.screenshot && ir.screenshot.base64) {
    const dir = path.join(CACHE_DIR, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    screenshotFile = path.join(dir, newId('page') + '.png');
    fs.writeFileSync(screenshotFile, Buffer.from(ir.screenshot.base64, 'base64'));
    delete ir.screenshot;
  }

  const assetFiles = new Map();
  for (const a of ir.assets || []) if (a.file) assetFiles.set(a.id, path.join(assetsDir, a.file));
  const session = createSession(ir, assetsDir, assetFiles);
  state.counters.captures++;
  log(`Захват готов: слоёв ${ir.stats.emitted}, ассетов ${(ir.assets || []).length}, ${Date.now() - t0} мс`);

  const report = validateIR(ir);
  sendJson(res, 200, {
    ok: true,
    sessionId: session.id,
    ms: Date.now() - t0,
    screenshotFile,
    ir: publicIr(session),
    validation: { errors: report.errors.length, warns: report.warns.length, byCode: report.counts.byCode },
  });
}

async function handleCaptureCode(req, res) {
  const body = await readBody(req);
  const html = String(body.html || '');
  const css = String(body.css || '');
  if (!html && !css) { sendJson(res, 400, { ok: false, error: 'Не передан html или css' }); return; }

  const doc = buildPreviewDocument(html, css, body);
  const session = createSession({ placeholder: true }, null, new Map());
  session.previewHtml = doc;
  const url = `http://${HOST}:${PORT}/preview/${session.id}`;
  log(`Захват из кода @ ${body.width || 1440}px…`);
  const t0 = Date.now();

  const assetsDir = path.join(CACHE_DIR, 'assets', newId('a'));
  const ir = await captureUrl(url, {
    width: body.width || 1440,
    height: body.height || 900,
    profileMode: 'clean',
    fetchAssets: true,
    screenshot: false,
    assetsDir,
    baseDir: __dirname,
  });

  session.ir = ir;
  session.assetsDir = assetsDir;
  for (const a of ir.assets || []) if (a.file) session.assetFiles.set(a.id, path.join(assetsDir, a.file));
  state.counters.captures++;

  const report = validateIR(ir);
  sendJson(res, 200, {
    ok: true,
    sessionId: session.id,
    ms: Date.now() - t0,
    ir: publicIr(session),
    validation: { errors: report.errors.length, warns: report.warns.length, byCode: report.counts.byCode },
  });
}

function buildPreviewDocument(html, css, opts) {
  const font = opts.font || 'Inter, -apple-system, Segoe UI, Arial, sans-serif';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box }
  body { margin: 0; font-family: ${font}; }
  ${css}
</style></head>
<body>
${html}
</body></html>`;
}

async function handleBuild(req, res) {
  const body = await readBody(req);
  const ir = body.ir || normalizeDesignSpec(body);
  const options = Object.assign(
    { autoLayout: 'safe', textAutoHeight: true, addAnnotations: true, addPluginData: true },
    body.options || {}
  );
  log(`Сборка дизайна: «${ir.title || '—'}»`);
  const result = await pluginRequest('build', { ir, options }, body.timeoutMs || PLUGIN_TIMEOUT);
  state.counters.builds++;
  sendJson(res, 200, { ok: true, result });
}

/**
 * Захват и сразу сборка — один вызов, чтобы агенту не гонять IR через себя.
 * Байты картинок уезжают в плагин прямо здесь.
 */
async function handleCaptureAndBuild(req, res) {
  const body = await readBody(req);
  if (!body.url) { sendJson(res, 400, { ok: false, error: 'Не передан url' }); return; }

  const width = body.width || 1440;
  log(`Захват и сборка ${body.url} @ ${width}px…`);
  const t0 = Date.now();

  const assetsDir = path.join(CACHE_DIR, 'assets', newId('a'));
  const ir = await captureUrl(body.url, {
    width,
    height: body.height || 900,
    profileMode: body.profileMode || 'clean',
    scrollToLoad: body.scrollToLoad !== false,
    fetchAssets: true,
    screenshot: false,
    assetsDir,
    baseDir: __dirname,
  });
  state.counters.captures++;

  const assets = [];
  for (const a of ir.assets || []) {
    if (!a.file) continue;
    try {
      // base64, а не массив чисел: JSON из Array.from(буфера) раздувается
      // в разы, и на тяжёлой странице передача картинок вешала сборку.
      assets.push({ id: a.id, base64: fs.readFileSync(path.join(assetsDir, a.file)).toString('base64') });
    } catch (e) { /* картинка потеряется, плагин это отметит */ }
  }
  log(`Ассетов к передаче: ${assets.length}`);

  const options = Object.assign(
    { autoLayout: 'safe', textAutoHeight: true, addAnnotations: true, addPluginData: true },
    body.options || {}
  );
  const result = await pluginRequest('build-with-assets', { ir, options, assets }, 600000);
  state.counters.builds++;
  sendJson(res, 200, {
    ok: true,
    ms: Date.now() - t0,
    captureMs: Date.now() - t0,
    result,
  });
}

async function handleScreenshot(req, res) {
  const body = await readBody(req);
  const result = await pluginRequest('export', {
    nodeIds: body.nodeIds || [],
    scale: body.scale || 1,
    maxWidth: body.maxWidth || 3200,
  }, 180000);
  state.counters.shots++;

  const shots = [];
  const dir = path.join(CACHE_DIR, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  for (const img of result.images || []) {
    const file = path.join(dir, `${newId('shot')}.png`);
    fs.writeFileSync(file, Buffer.from(img.base64, 'base64'));
    shots.push({ id: img.id, name: img.name, file, bytes: fs.statSync(file).size });
    delete img.base64;
  }
  sendJson(res, 200, { ok: true, shots, raw: result });
}

async function handleState(req, res) {
  const result = await pluginRequest('state', {}, 15000);
  sendJson(res, 200, { ok: true, state: result });
}

function handleAsset(req, res, sessionId, assetId) {
  const session = state.sessions.get(sessionId);
  if (!session) { sendJson(res, 404, { ok: false, error: 'Сессия не найдена' }); return; }
  const file = session.assetFiles.get(assetId);
  if (!file || !fs.existsSync(file)) { sendJson(res, 404, { ok: false, error: 'Ассет не найден' }); return; }
  const data = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=600' });
  res.end(data);
}

function handlePreview(res, sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session || !session.previewHtml) { res.writeHead(404); res.end('not found'); return; }
  const buf = Buffer.from(session.previewHtml, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function statusPage() {
  const plugin = state.plugin && state.plugin.open
    ? `подключён (v${state.pluginInfo && state.pluginInfo.version || '?'}, файл «${(state.pluginInfo && state.pluginInfo.file) || '—'}»)`
    : 'НЕ подключён';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Web → Figma Bridge</title>
<style>body{font:14px/1.6 ui-monospace,Consolas,monospace;background:#0f172a;color:#e2e8f0;padding:32px;max-width:900px}
h1{font-size:20px;color:#a5b4fc}h2{font-size:15px;color:#94a3b8;margin-top:28px}
b{color:#4ade80}.warn{color:#fbbf24}code{background:#1e293b;padding:2px 6px;border-radius:4px}
li{margin:2px 0}</style></head><body>
<h1>Web → Figma Bridge</h1>
<p>Движок работает. Плагин: <b>${plugin}</b></p>
<p>Аптайм: ${Math.round((Date.now() - state.startedAt) / 1000)} с ·
захватов ${state.counters.captures} · сборок ${state.counters.builds} · скриншотов ${state.counters.shots}</p>
<h2>Маршруты</h2>
<ul>
<li><code>POST /api/capture</code> — {"url":"https://…","width":1440}</li>
<li><code>POST /api/capture-code</code> — {"html":"…","css":"…","width":1440}</li>
<li><code>POST /api/build</code> — {"name":"…","width":1440,"nodes":[…]}</li>
<li><code>POST /api/capture-and-build</code> — захват и сразу сборка в Figma</li>
<li><code>POST /api/screenshot</code> — {"nodeIds":["…"],"scale":1}</li>
<li><code>GET /api/state</code> — состояние плагина</li>
<li><code>GET /asset/&lt;session&gt;/&lt;id&gt;</code> — байты картинок</li>
</ul>
<h2>Журнал</h2>
<ul>${state.log.slice(-25).reverse().map((l) => `<li>${l.replace(/[<>&]/g, '')}</li>`).join('')}</ul>
</body></html>`;
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const buf = Buffer.from(statusPage(), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }
    if (p === '/health') {
      sendJson(res, 200, {
        ok: true,
        plugin: !!(state.plugin && state.plugin.open),
        pluginInfo: state.pluginInfo,
        counters: state.counters,
        uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
      });
      return;
    }
    if (p === '/api/capture' && req.method === 'POST') return await handleCapture(req, res);
    if (p === '/api/capture-code' && req.method === 'POST') return await handleCaptureCode(req, res);
    if (p === '/api/capture-and-build' && req.method === 'POST') return await handleCaptureAndBuild(req, res);
    if (p === '/api/build' && req.method === 'POST') return await handleBuild(req, res);
    if (p === '/api/screenshot' && req.method === 'POST') return await handleScreenshot(req, res);
    if (p === '/api/state') return await handleState(req, res);

    // Удалить слои по id
    if (p === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await pluginRequest('delete', { nodeIds: body.nodeIds || [] }, 120000);
      log(`Удалено слоёв: ${(result.removed || []).length}`);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    // Выделить слои по id — нужно, чтобы снять с них скриншот
    if (p === '/api/select' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await pluginRequest('select', { nodeIds: body.nodeIds || [] }, 30000);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    // Самопроверка возможностей Figma — можно запустить отсюда, не трогая
    // интерфейс плагина
    if (p === '/api/design-system' && req.method === 'POST') {
      const body = await readBody(req);
      const theme = (body && body.theme) === 'Dark' ? 'Dark' : 'Light';
      const result = await pluginRequest('design-system', { theme }, 900000);
      state.counters.builds++;
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (p === '/api/selftest') {
      const report = await pluginRequest('selftest', {}, 180000);
      sendJson(res, 200, { ok: true, report });
      return;
    }

    // Интерфейс плагина отдаём браузеру — удобно для отладки и дымовых тестов
    if (p === '/ui') {
      const file = path.join(__dirname, '..', 'ui.html');
      if (!fs.existsSync(file)) { sendJson(res, 404, { ok: false, error: 'ui.html не найден' }); return; }
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }

    // Прокси картинок: убирает CORS для тех дизайнов, где агент
    // ссылается на внешние URL напрямую.
    if (p === '/proxy') {
      const target = url.searchParams.get('url');
      if (!target) { sendJson(res, 400, { ok: false, error: 'Не передан url' }); return; }
      let parsed;
      try { parsed = new URL(target); } catch (e) { sendJson(res, 400, { ok: false, error: 'Некорректный url' }); return; }
      if (!/^https?:$/.test(parsed.protocol)) { sendJson(res, 400, { ok: false, error: 'Только http/https' }); return; }
      const upstream = await fetch(parsed.href, { redirect: 'follow' });
      if (!upstream.ok) { sendJson(res, 502, { ok: false, error: 'Источник ответил ' + upstream.status }); return; }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > 24 * 1024 * 1024) { sendJson(res, 413, { ok: false, error: 'Файл слишком большой' }); return; }
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=600',
      });
      res.end(buf);
      return;
    }

    const previewMatch = /^\/preview\/([^/]+)$/.exec(p);
    if (previewMatch) return handlePreview(res, previewMatch[1]);

    // Диагностический пиксель: полезен для проверки цепочки ассетов
    if (p === '/pixel.png') {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
      return;
    }

    const assetMatch = /^\/asset\/([^/]+)\/([^/]+)$/.exec(p);
    if (assetMatch) return handleAsset(req, res, assetMatch[1], assetMatch[2]);

    sendJson(res, 404, { ok: false, error: 'Неизвестный маршрут: ' + p });
  } catch (e) {
    state.counters.errors++;
    log('ОШИБКА: ' + (e && e.message || e));
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    else { try { res.end(); } catch (e2) { /* noop */ } }
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const ws = acceptUpgrade(req, socket);
  if (!ws) return;
  if (state.plugin && state.plugin.open) {
    try { state.plugin.close(); } catch (e) { /* noop */ }
  }
  state.plugin = ws;
  log('WebSocket: плагин открыл соединение');
  ws.on('message', (msg) => {
    let parsed;
    try { parsed = JSON.parse(msg.data); } catch (e) { return; }
    handlePluginMessage(parsed);
  });
  ws.on('close', () => {
    if (state.plugin === ws) {
      state.plugin = null;
      log('WebSocket: плагин отключился');
    }
  });
});

fs.mkdirSync(CACHE_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  // Подсказки печатает Node, а не .cmd: файл запускалки обязан быть в ASCII,
  // иначе cmd.exe падает с "The syntax of the command is incorrect".
  log(`Движок запущен: http://${HOST}:${PORT}`);
  log(`Страница состояния: http://${HOST}:${PORT}/`);
  log('');
  log('Оставьте это окно открытым, пока работаете с плагином.');
  log('');
  log('Дальше в Figma Desktop:');
  log('  1. Plugins → Development → Import plugin from manifest…');
  log('     укажите manifest.json из этой папки');
  log('  2. Plugins → Development → Web → Figma Bridge');
  log('');
  log(`Если порт ${PORT} занят, задайте другой: set W2F_PORT=7444 перед запуском.`);
  log('');
});

process.on('SIGINT', () => { log('Остановка'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { log('Остановка'); server.close(() => process.exit(0)); });

module.exports = { server, state, normalizeDesignSpec, coerceStyle, coerceNode, buildPreviewDocument };
