'use strict';
/**
 * Захват страницы целиком: подготовка → DOMSnapshot → IR → SVG → ассеты → скриншот.
 *
 * Реальные сайты ломаются не на парсинге, а на мелочах. Здесь закрыты:
 *   • шрифты, которые ещё не догрузились (иначе метрики текста врут);
 *   • ленивые картинки ниже сгиба (иначе их просто нет в снимке);
 *   • незавершённые анимации (иначе половина блоков имеет opacity:0);
 *   • инлайновый SVG (Figma умеет строить его из разметки — нужен outerHTML);
 *   • картинки за CORS — тянем ИЗ СТРАНИЦЫ, а не снаружи, тогда CORS не мешает и куки на месте.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Browser, sleep } = require('./browser');
const { serializeSnapshot, COMPUTED_STYLES } = require('./serialize');

const MAX_ASSET_BYTES = 14 * 1024 * 1024;

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/tiff': '.tiff',
  'font/woff': '.woff', 'font/woff2': '.woff2', 'font/ttf': '.ttf', 'font/otf': '.otf',
};

function extFromMime(mime, url) {
  if (mime && MIME_EXT[mime.toLowerCase()]) return MIME_EXT[mime.toLowerCase()];
  try {
    const u = new URL(url);
    const e = path.extname(u.pathname);
    if (e && e.length <= 6) return e;
  } catch { /* noop */ }
  return '.bin';
}

function hashId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** Ограниченный параллелизм. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { error: String(e && e.message || e) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Подготовить страницу: шрифты, прокрутка для ленивых картинок, добор анимаций.
 */
async function preparePage(page, opts = {}) {
  const scrollToLoad = opts.scrollToLoad !== false;

  // 1. Шрифты
  try {
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
      }
    });
  } catch { /* не критично */ }

  // 2. Прокрутка вниз и обратно — будит IntersectionObserver и lazy-load.
  // Охват: вся высота документа (с разумным потолком), иначе лента вроде
  // habr.com теряет изображения ниже отсечки.
  //
  // Плавная прокрутка здесь критична: при `scroll-behavior: smooth` вызов
  // scrollTo превращается в анимацию, и снимок делается ПОСРЕДИ движения.
  // Из-за этого липкая шапка MDN оказалась в IR на y=649 вместо своего места.
  let scrollAt = { x: 0, y: 0 };
  if (scrollToLoad) {
    try {
      scrollAt = await page.evaluate(async (maxPx, pauseMs) => {
        const prevHtml = document.documentElement.style.scrollBehavior;
        const prevBody = document.body ? document.body.style.scrollBehavior : '';
        document.documentElement.style.scrollBehavior = 'auto';
        if (document.body) document.body.style.scrollBehavior = 'auto';

        const step = Math.max(240, Math.floor(window.innerHeight * 0.75));
        const max = Math.min(document.documentElement.scrollHeight || 0, maxPx);
        for (let y = 0; y < max; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, pauseMs));
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((r) => setTimeout(r, 300));

        // Возврат наверх с проверкой, что действительно доехали
        for (let i = 0; i < 40 && window.scrollY > 0; i++) {
          window.scrollTo(0, 0);
          await new Promise((r) => setTimeout(r, 50));
        }
        document.documentElement.style.scrollBehavior = prevHtml;
        if (document.body) document.body.style.scrollBehavior = prevBody;
        return { x: window.scrollX, y: window.scrollY };
      }, opts.maxScrollPx || 50000, opts.scrollPauseMs || 45);
    } catch (e) { /* не критично */ }
  }

  // 3. Довести анимации до конечного состояния (не убивать — иначе часть блоков останется opacity:0)
  try {
    await page.evaluate(() => {
      const anims = document.getAnimations ? document.getAnimations() : [];
      for (const a of anims) {
        try { a.finish(); } catch { /* бесконечные не завершаются — это нормально */ }
      }
    });
  } catch { /* не критично */ }

  // 4. Зафиксировать реально выбранный источник картинки в атрибуте
  try {
    await page.evaluate(() => {
      for (const img of Array.from(document.images)) {
        const cs = img.currentSrc || img.src;
        if (cs && img.getAttribute('src') !== cs) img.setAttribute('src', cs);
        if (img.loading === 'lazy') img.loading = 'eager';
      }
    });
  } catch { /* не критично */ }

  try {
    await page.evaluate(async () => {
      const pending = Array.from(document.images).filter((i) => !i.complete);
      await Promise.race([
        Promise.all(pending.map((i) => new Promise((r) => {
          i.addEventListener('load', r, { once: true });
          i.addEventListener('error', r, { once: true });
        }))),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    });
  } catch { /* не критично */ }

  if (opts.waitMs) await sleep(opts.waitMs);
  return { scrollX: scrollAt.x, scrollY: scrollAt.y };
}

/** Достать outerHTML инлайновых SVG — Figma построит из них вектор. */
async function collectSvgs(page, ir) {
  const refs = (ir._svgRefs || []).filter((n) => n._bid);
  if (!refs.length) return { total: 0, ok: 0 };
  let ok = 0;
  const failures = [];
  const CHUNK = 100;

  // CDP требует сначала «запросить документ», иначе pushNodesByBackendIdsToFrontend
  // отвечает "Document needs to be requested first".
  try {
    await page.send('DOM.getDocument', { depth: 0, pierce: false });
  } catch (e) {
    failures.push('getDocument: ' + (e.message || e));
  }

  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK);
    let nodeIds = [];
    try {
      const res = await page.send('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: slice.map((r) => r._bid),
      });
      nodeIds = res.nodeIds || [];
    } catch (e) {
      failures.push('pushNodes: ' + (e.message || e));
      nodeIds = [];
    }
    for (let k = 0; k < slice.length; k++) {
      const nodeId = nodeIds[k];
      if (!nodeId) { failures.push(`nodeId не получен (backendNodeId=${slice[k]._bid})`); continue; }
      try {
        const html = await page.send('DOM.getOuterHTML', { nodeId });
        const svg = html && html.outerHTML;
        if (svg && svg.length < 400000) { slice[k].svg = svg; ok++; }
        else failures.push('пустая разметка или слишком большая');
      } catch (e) {
        failures.push('getOuterHTML: ' + (e.message || e));
      }
    }
  }
  for (const n of refs) delete n._bid;
  ir.stats.svgsWithMarkup = ok;
  if (failures.length) {
    ir.warnings = (ir.warnings || []).concat(
      [`Не удалось получить разметку SVG (${failures.length}): ` + failures.slice(0, 3).join('; ')]
    );
  }
  return { total: refs.length, ok, failures };
}

/**
 * Байты ассета: сначала через CDP, потом из страницы.
 *
 * Порядок принципиален. `fetch()` внутри страницы подчиняется CORS и для
 * картинок тоже, поэтому на habr.com так терялось 52 изображения из 53.
 * `Network.getResponseBody` отдаёт уже загруженное браузером тело напрямую,
 * вообще без участия политики CORS.
 */
async function getAssetBytes(page, url, timeoutMs) {
  // 1. Тело, перехваченное сразу при загрузке — CORS не участвует
  if (page.imageBodies && page.imageBodies.has(url)) {
    const hit = page.imageBodies.get(url);
    return { buf: hit.buf, mime: hit.mime || '' };
  }
  // 2. Запрос тела по идентификатору запроса
  if (page.networkIndex) {
    const entry = page.networkIndex.get(url);
    if (entry) {
      try {
        const res = await page.send('Network.getResponseBody', { requestId: entry.requestId });
        if (res && res.body) {
          const buf = res.base64Encoded
            ? Buffer.from(res.body, 'base64')
            : Buffer.from(res.body, 'binary');
          if (buf.length) return { buf, mime: entry.mime || '' };
        }
      } catch (e) {
        // тело могло быть вытеснено из буфера — пробуем следующий способ
      }
    }
  }
  // 3. Последний рубеж: запрос из самой страницы (подчиняется CORS)
  const fallback = await fetchAssetInPage(page, url, timeoutMs);
  if (!fallback || fallback.error || !fallback.dataUrl) {
    return { error: (fallback && fallback.error) || 'нет данных' };
  }
  const comma = fallback.dataUrl.indexOf(',');
  const buf = Buffer.from(fallback.dataUrl.slice(comma + 1), 'base64');
  return { buf, mime: fallback.mime || '' };
}

/**
 * Скачать байты ассета средствами самой страницы (обходит CORS и использует куки).
 *
 * Таймаут обязателен: без него одна зависшая картинка останавливает весь захват.
 * Именно на этом habr.com показывал 122 секунды вместо пятнадцати.
 */
async function fetchAssetInPage(page, url, timeoutMs) {
  const limit = timeoutMs || 15000;
  return page.evaluate(async (u, t) => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, t);
    try {
      const res = await fetch(u, {
        credentials: 'include',
        cache: 'force-cache',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) return { error: 'HTTP ' + res.status };
      const blob = await res.blob();
      if (blob.size > 14 * 1024 * 1024) return { error: 'слишком большой: ' + blob.size };
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('FileReader'));
        fr.readAsDataURL(blob);
      });
      return { dataUrl, mime: blob.type || '', size: blob.size };
    } catch (e) {
      const msg = String((e && e.message) || e);
      return { error: /abort/i.test(msg) ? `таймаут ${t} мс` : msg };
    } finally {
      clearTimeout(timer);
    }
  }, { args: [url, limit] });
}

/**
 * Определить, какой шрифт браузер РЕАЛЬНО использовал для каждого стека.
 *
 * Зачем: CSS пишет `Inter, Arial, sans-serif`, но если Inter в системе нет,
 * браузер возьмёт Arial. Figma же возьмёт Inter — метрики разойдутся,
 * и однострочный заголовок перенесётся на две строки. Это заметный дефект.
 *
 * Метод: сравниваем ширину пробной строки в проверяемом шрифте и в заведомо
 * доступном обобщённом (monospace/serif/sans-serif). Совпала — шрифта нет.
 */
async function detectUsedFonts(page) {
  try {
    return await page.evaluate(() => {
      const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
        'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math',
        'emoji', 'fangsong']);
      const PSEUDO = new Set(['-apple-system', 'blinkmacsystemfont', 'system-ui', '-moz-use-system-font']);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return {};
      const TEST = 'mmmmmmmmmmlliWWQ@#gjqpРОД';
      const widthOf = (font) => { ctx.font = font; return ctx.measureText(TEST).width; };
      const REF = {
        monospace: widthOf('72px monospace'),
        serif: widthOf('72px serif'),
        'sans-serif': widthOf('72px sans-serif'),
      };
      const cache = new Map();
      const available = (family) => {
        const key = family.toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let ok;
        if (PSEUDO.has(key)) ok = false;
        else if (GENERIC.has(key)) ok = true;
        else {
          ok = false;
          for (const g of ['monospace', 'serif', 'sans-serif']) {
            if (Math.abs(widthOf(`72px "${family}", ${g}`) - REF[g]) > 0.5) { ok = true; break; }
          }
        }
        cache.set(key, ok);
        return ok;
      };

      const stacks = new Set();
      const all = document.querySelectorAll('*');
      const limit = Math.min(all.length, 5000);
      for (let i = 0; i < limit; i++) {
        const ff = getComputedStyle(all[i]).fontFamily;
        if (ff) stacks.add(ff);
        if (stacks.size > 40) break;
      }

      const out = {};
      for (const stack of stacks) {
        const fams = stack.split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        for (const f of fams) {
          if (available(f)) { out[stack] = f; break; }
        }
      }
      return out;
    });
  } catch (e) {
    return {};
  }
}

/**
 * Собрать правила @font-face страницы.
 *
 * Нужно только для проверочной отрисовки IR: без них текст рисуется системным
 * шрифтом, и попиксельное сравнение показывает разницу шрифтов вместо разницы
 * макета. Продукту это не требуется — плагин сопоставляет шрифты сам.
 */
async function collectFontFaces(page) {
  try {
    const rules = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const walk = (list, base) => {
        for (const r of list) {
          try {
            if (r.type === 5) {
              let text = r.cssText;
              text = text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/g, (m, a, b, c) => {
                const u = a || b || c || '';
                try { return `url("${new URL(u, base).href}")`; } catch (e) { return m; }
              });
              if (!seen.has(text)) { seen.add(text); out.push(text); }
            } else if (r.type === 3 && r.styleSheet) {
              walk(r.styleSheet.cssRules, r.styleSheet.href || base);
            }
          } catch (e) { /* правило недоступно */ }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try { walk(sheet.cssRules, sheet.href || location.href); } catch (e) { /* кросс-доменный лист */ }
      }
      return out;
    });
    const css = (rules || []).join('\n');
    return css.length > 300000 ? '' : css;
  } catch (e) {
    return '';
  }
}

/** Форматы, которые figma.createImage принимает без перекодирования. */
const FIGMA_SAFE_IMAGE = /^image\/(png|jpe?g|gif)$/i;

/**
 * Перекодировать картинку в формат, который принимает Figma.
 *
 * Нужно потому, что современные сайты отдают AVIF и SVG, а figma.createImage
 * их не понимает: на formula1.com так терялось 65 картинок из 76.
 * Декодирует тот же браузер, которым мы снимаем страницу, — Chrome умеет
 * и AVIF, и SVG.
 *
 * Прозрачность решает формат: есть альфа — PNG, нет — JPEG (иначе фото
 * в PNG раздулись бы в разы).
 */
async function normalizeImage(page, buf, mime) {
  if (FIGMA_SAFE_IMAGE.test(mime || '')) return { buf, mime, converted: false };
  if (buf.length > 12 * 1024 * 1024) return { buf, mime, converted: false };
  try {
    const src = `data:${mime || 'application/octet-stream'};base64,${buf.toString('base64')}`;
    const res = await page.evaluate(async (url) => {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('не удалось декодировать'));
        i.src = url;
      });
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('нулевой размер');
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let transparent = false;
      try {
        const d = ctx.getImageData(0, 0, w, h).data;
        // шагаем по альфе, а не по всем пикселям: для 4000×3000 это в разы быстрее
        for (let i = 3; i < d.length; i += 4 * 17) {
          if (d[i] < 250) { transparent = true; break; }
        }
      } catch (e) { transparent = true; } // getImageData может быть недоступен
      const type = transparent ? 'image/png' : 'image/jpeg';
      return { dataUrl: c.toDataURL(type, 0.92), type, w, h };
    }, { args: [src] });
    if (!res || !res.dataUrl) return { buf, mime, converted: false };
    const comma = res.dataUrl.indexOf(',');
    const out = Buffer.from(res.dataUrl.slice(comma + 1), 'base64');
    if (!out.length) return { buf, mime, converted: false };
    return { buf: out, mime: res.type, converted: true, width: res.w, height: res.h };
  } catch (e) {
    return { buf, mime, converted: false, normalizeError: String((e && e.message) || e) };
  }
}

/** Скачать все внешние ассеты в каталог. */
async function fetchAssets(page, ir, assetsDir, opts) {
  const assetTimeoutMs = (opts && opts.assetTimeoutMs) || 15000;
  fs.mkdirSync(assetsDir, { recursive: true });
  const assets = ir.assets || [];
  if (!assets.length) return { total: 0, ok: 0, failed: [] };

  const failed = [];
  const results = await mapLimit(assets, 6, async (asset) => {
    const r = await getAssetBytes(page, asset.url, assetTimeoutMs);
    if (!r || r.error || !r.buf) {
      failed.push({ id: asset.id, url: asset.url, error: (r && r.error) || 'нет данных' });
      return null;
    }
    const buf = r.buf;
    if (!buf.length || buf.length > MAX_ASSET_BYTES) {
      failed.push({ id: asset.id, url: asset.url, error: 'некорректный размер' });
      return null;
    }
    // AVIF и SVG Figma не принимает — перекодируем в PNG или JPEG
    const norm = opts.normalizeImages === false
      ? { buf, mime: r.mime, converted: false }
      : await normalizeImage(page, buf, r.mime);
    const finalBuf = norm.buf;
    const ext = extFromMime(norm.mime, asset.url);
    const file = hashId(asset.url) + ext;
    fs.writeFileSync(path.join(assetsDir, file), finalBuf);
    asset.file = file;
    asset.mime = norm.mime || 'application/octet-stream';
    asset.bytes = finalBuf.length;
    asset.originalMime = r.mime || '';
    asset.converted = !!norm.converted;
    return file;
  });

  const ok = results.filter(Boolean).length;
  ir.assetsFailed = failed;
  return { total: assets.length, ok, failed };
}

/** Пропустить data:URL из ассетов — они уже внутри IR. */
function normalizeInlineAssets(ir) {
  let inline = 0;
  (function walk(n) {
    if (n.inlineSrc) inline++;
    if (n.inlineBgSrc) inline++;
    for (const c of n.children) walk(c);
  })(ir.root);
  return inline;
}

/**
 * Полный захват URL.
 * @param {string} url
 * @param {object} opts
 */
async function captureUrl(url, opts = {}) {
  const width = opts.width || 1440;
  const height = opts.height || 900;
  const t0 = Date.now();

  const browser = new Browser({
    headless: opts.headless !== false,
    profileMode: opts.profileMode || 'clean',
    baseDir: opts.baseDir,
    executablePath: opts.executablePath,
  });

  const timings = {};
  let page = null;
  let scrollWarning = null;
  try {
    await browser.launch();
    timings.launch = Date.now() - t0;

    const t1 = Date.now();
    page = await browser.openPage(url, {
      width, height,
      waitMs: 0,
      timeoutMs: opts.timeoutMs || 60000,
      enableNetwork: true,
    });
    timings.load = Date.now() - t1;

    const t2 = Date.now();
    const scrollAt = await preparePage(page, opts);
    timings.prepare = Date.now() - t2;

    // Липкие и фиксированные элементы позиционируются относительно экрана,
    // поэтому ненулевая прокрутка уводит их в IR не туда. Проверяем и давим.
    if (scrollAt && (scrollAt.x || scrollAt.y)) {
      try {
        const fixed = await page.evaluate(() => {
          document.documentElement.style.scrollBehavior = 'auto';
          if (document.body) document.body.style.scrollBehavior = 'auto';
          window.scrollTo(0, 0);
          return { x: window.scrollX, y: window.scrollY };
        });
        if (fixed && (fixed.x || fixed.y)) {
          scrollWarning = `Страница осталась прокручена на ${Math.round(fixed.x)},${Math.round(fixed.y)} px — ` +
            'липкие шапки могут оказаться не на своём месте.';
        }
        scrollAt.x = fixed ? fixed.x : 0;
        scrollAt.y = fixed ? fixed.y : 0;
      } catch (e) { /* noop */ }
    }
    timings.scrollFix = Date.now() - t2;

    const t3 = Date.now();
    const snap = await page.send('DOMSnapshot.captureSnapshot', {
      computedStyles: COMPUTED_STYLES,
      includeDOMRects: true,
      includePaintOrder: true,
      includeBlendedBackgroundColors: true,
      includeTextColorOpacities: opts.includeTextColorOpacities === true,
    });
    timings.snapshot = Date.now() - t3;

    const t4 = Date.now();
    const ir = serializeSnapshot(snap, {
      url,
      viewportWidth: width,
      viewportHeight: height,
    });
    timings.serialize = Date.now() - t4;

    // Скриншот снимаем СРАЗУ после снимка, а не в конце.
    // Иначе сравнивать нечего: на formula1.com баннер cookie-согласия
    // появляется через несколько секунд, и скриншот, сделанный после
    // скачивания картинок, показывал баннер, которого в IR уже нет.
    if (opts.screenshot !== false) {
      const tShot = Date.now();
      try {
        const shot = await page.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: Math.min(
            (ir.content && ir.content.h) || height, 20000), scale: 1 },
        });
        ir.screenshot = {
          base64: shot.data,
          width,
          height: Math.min((ir.content && ir.content.h) || height, 20000),
        };
      } catch (e) {
        ir.warnings = (ir.warnings || []).concat(['Скриншот не снят: ' + (e.message || e)]);
      }
      timings.screenshot = Date.now() - tShot;
    }

    ir.scrollAtCapture = { x: scrollAt.x, y: scrollAt.y };
    if (scrollWarning) ir.warnings = (ir.warnings || []).concat([scrollWarning]);
    if (opts.scrollToLoad === false) {
      ir.warnings = (ir.warnings || []).concat([
        'Догрузка ленивых картинок отключена — изображения ниже первого экрана могли не загрузиться.',
      ]);
    }

    const t5 = Date.now();
    await collectSvgs(page, ir);
    timings.svg = Date.now() - t5;

    const tFonts = Date.now();
    ir.fontMap = await detectUsedFonts(page);
    ir.fontCss = await collectFontFaces(page);
    timings.fonts = Date.now() - tFonts;

    if (opts.fetchAssets !== false) {
      const t6 = Date.now();
      const assetsDir = opts.assetsDir || path.join(__dirname, '.cache', 'assets', hashId(url + width + Date.now()));
      ir.assetsDir = assetsDir;
      // Дожидаемся очереди перехвата тел, иначе часть ещё в пути
      if (page.drainImageBodies) {
        try { await page.drainImageBodies(); } catch (e) { /* noop */ }
      }
      ir.networkImages = page.networkIndex ? page.networkIndex.size : -1;
      ir.bufferedImages = page.imageBodies ? page.imageBodies.size : -1;
      ir.assetsStats = await fetchAssets(page, ir, assetsDir, opts);
      timings.assets = Date.now() - t6;
    }
    ir.inlineAssets = normalizeInlineAssets(ir);

    delete ir._svgRefs;
    ir.timings = timings;
    ir.totalMs = Date.now() - t0;
    ir.ok = true;
    return ir;
  } finally {
    if (page) { try { await page.close(); } catch { /* noop */ } }
    try { await browser.close(); } catch { /* noop */ }
  }
}

module.exports = {
  captureUrl,
  preparePage,
  collectSvgs,
  collectFontFaces,
  fetchAssets,
  fetchAssetInPage,
  getAssetBytes,
  detectUsedFonts,
  mapLimit,
  hashId,
};
