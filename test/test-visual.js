'use strict';
/**
 * Визуальная проверка: IR → HTML → скриншот → сравнение с оригиналом.
 *
 * Структурные тесты проверяют геометрию и наличие свойств. Они НЕ проверяют,
 * что результат выглядит правильно: потерянный слой, сбитый порядок наложения
 * или пропавшая прозрачность пройдут мимо них.
 *
 * Здесь отрисовываем IR обратно и сравниваем попиксельно. Чтобы тест не был
 * штампом, в конце проверяется, что он ЛОВИТ внесённую порчу.
 *
 *   node test/test-visual.js [url] [ширина]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Browser, sleep } = require('../engine/browser');
const { captureUrl } = require('../engine/capture');
const { renderIr } = require('../engine/render-ir');

const URL_ = process.argv.find((a) => /^https?:/.test(a)) || 'data:text/html;charset=utf-8,' +
  encodeURIComponent(SMALL_PAGE());
const WIDTH = parseInt(process.argv.find((a) => /^\d+$/.test(a)), 10) || 900;
const PORT = 7403;

function SMALL_PAGE() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;font-family:Arial,sans-serif;background:#f1f5f9}
  .wrap{display:flex;flex-direction:column;gap:16px;padding:32px;width:700px}
  .card{display:flex;flex-direction:column;gap:12px;padding:20px;background:#fff;
        border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 8px 24px rgba(15,23,42,.12)}
  .row{display:flex;align-items:center;gap:10px}
  .dot{width:12px;height:12px;border-radius:50%;background:#22c55e}
  h1{margin:0;font-size:24px;color:#0f172a}
  p{margin:0;color:#475569;font-size:14px;line-height:1.6}
  .btn{align-self:flex-start;padding:12px 20px;border-radius:10px;font-size:15px;font-weight:600;
       color:#fff;background:linear-gradient(90deg,#6366f1,#a855f7)}
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
  .cell{height:56px;border-radius:8px;background:#e0e7ff}
  .cell.b{background:#fde68a}
  .over{position:relative;height:70px;background:#fce7f3;border-radius:10px}
  .badge{position:absolute;right:10px;top:10px;padding:4px 10px;border-radius:999px;
         background:#db2777;color:#fff;font-size:12px}
</style></head><body>
  <div class="wrap">
    <div class="card">
      <div class="row"><span class="dot"></span><h1>Заголовок карточки</h1></div>
      <p>Описание в две строки,<br>с переносом и <b>жирным</b> словом.</p>
      <div class="btn">Купить сейчас</div>
    </div>
    <div class="grid"><div class="cell"></div><div class="cell b"></div><div class="cell"></div></div>
    <div class="over"><div class="badge">NEW</div></div>
  </div>
</body></html>`;
}

let fails = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

function startStaticServer(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    if (p === '/asset') {
      const file = url.searchParams.get('f');
      const full = path.join(root.assetsDir || '', path.basename(file || ''));
      if (!fs.existsSync(full)) { res.writeHead(404); res.end(); return; }
      const buf = fs.readFileSync(full);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }
    const key = p.slice(1);
    const entry = root[key];
    if (!entry) { res.writeHead(404); res.end('нет'); return; }
    const isPng = key.endsWith('.png') || key === 'orig';
    const buf = isPng ? entry : Buffer.from(entry, 'utf8');
    res.writeHead(200, {
      'Content-Type': isPng ? 'image/png' : 'text/html; charset=utf-8',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** Сравнение двух изображений средствами браузера через canvas. */
async function diffInBrowser(page, origUrl, renderUrl, threshold) {
  return page.evaluate(async (a, b, th) => {
    const load = (u) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('не загрузилось: ' + u));
      img.src = u;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ia.naturalWidth, ib.naturalWidth);
    const h = Math.min(ia.naturalHeight, ib.naturalHeight);
    const mk = (img) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, w, h).data;
    };
    const da = mk(ia);
    const db = mk(ib);
    let sum = 0;
    let over = 0;
    const BANDS = 16;
    const bandH = Math.max(1, Math.floor(h / BANDS));
    const bands = new Array(BANDS).fill(0);
    const bandTotals = new Array(BANDS).fill(0);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const od = octx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const d0 = Math.abs(da[o] - db[o]);
      const d1 = Math.abs(da[o + 1] - db[o + 1]);
      const d2 = Math.abs(da[o + 2] - db[o + 2]);
      const d = Math.max(d0, d1, d2);
      sum += d;
      const band = Math.min(BANDS - 1, Math.floor(Math.floor(i / w) / bandH));
      bandTotals[band]++;
      if (d > th) {
        over++;
        bands[band]++;
        od.data[o] = 255; od.data[o + 1] = 0; od.data[o + 2] = 0; od.data[o + 3] = 255;
      } else {
        const g = da[o];
        od.data[o] = g; od.data[o + 1] = g; od.data[o + 2] = g; od.data[o + 3] = 255;
      }
    }
    octx.putImageData(od, 0, 0);

    // Сравнение в уменьшенном масштабе: усреднение убирает рябь сглаживания
    // шрифтов (проверочный HTML не грузит @font-face страницы), но сохраняет
    // структурные ошибки — потерянный блок, сдвиг, неверный цвет.
    const scale = 4;
    const sw = Math.max(1, Math.floor(w / scale));
    const sh = Math.max(1, Math.floor(h / scale));
    const small = (img) => {
      const c = document.createElement('canvas');
      c.width = sw; c.height = sh;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, sw, sh);
      return x.getImageData(0, 0, sw, sh).data;
    };
    const sa = small(ia);
    const sb = small(ib);
    let ssum = 0;
    let sover = 0;
    for (let i = 0; i < sw * sh; i++) {
      const o = i * 4;
      const d = Math.max(Math.abs(sa[o] - sb[o]), Math.abs(sa[o + 1] - sb[o + 1]), Math.abs(sa[o + 2] - sb[o + 2]));
      ssum += d;
      if (d > 24) sover++;
    }

    return {
      width: w, height: h,
      meanDiff: sum / (w * h),
      diffFraction: over / (w * h),
      coarse: {
        width: sw, height: sh,
        meanDiff: ssum / (sw * sh),
        diffFraction: sover / (sw * sh),
      },
      diffImage: out.toDataURL('image/png'),
      bands: bands.map((v, i) => ({
        from: i * bandH,
        to: Math.min(h, (i + 1) * bandH),
        fraction: bandTotals[i] ? v / bandTotals[i] : 0,
      })),
    };
  }, { args: [origUrl, renderUrl, threshold] });
}

/** Дождаться шрифтов и картинок, чтобы снимок был окончательным. */
async function settlePage(page) {
  try {
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]);
      }
      const imgs = Array.from(document.images).filter((i) => !i.complete);
      if (imgs.length) {
        await Promise.race([
          Promise.all(imgs.map((i) => new Promise((r) => {
            i.addEventListener('load', r, { once: true });
            i.addEventListener('error', r, { once: true });
          }))),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
      }
      await new Promise((r) => setTimeout(r, 250));
    });
  } catch (e) { /* не критично */ }
}

async function screenshotBase64(page, width, height) {
  const shot = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: Math.min(height, 20000), scale: 1 },
  });
  return shot.data;
}

/**
 * Убрать один заметный слой — проба чувствительности теста.
 * Имитирует ровно тот класс ошибок, ради которого тест написан:
 * слой молча потерялся, а геометрия остальных не пострадала.
 */
function dropVisibleNode(root) {
  const transparent = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  let dropped = null;
  (function walk(node) {
    if (dropped) return;
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const st = c.style || {};
      const visible = !transparent(st['background-color']) ||
        (st['background-image'] && st['background-image'] !== 'none') ||
        (c.text && c.text.trim().length > 3) ||
        c.type === 'image';
      const area = (c.box ? c.box.w * c.box.h : 0);
      if (visible && area > 2000) {
        kids.splice(i, 1);
        dropped = c;
        return;
      }
      walk(c);
      if (dropped) return;
    }
  })(root);
  return dropped;
}

(async () => {
  const browser = new Browser({ headless: true, profileMode: 'clean' });
  let server = null;
  try {
    await browser.launch();
    console.log(`Захват: ${URL_.slice(0, 80)} @ ${WIDTH}px`);
    const ir = await captureUrl(URL_, {
      width: WIDTH, height: 900, profileMode: 'clean',
      fetchAssets: true, screenshot: true,
    });
    if (!ir.screenshot) { console.log('Скриншот не снят — сравнивать нечего'); process.exit(1); }
    const content = ir.content;
    console.log(`IR: слоёв ${ir.stats.emitted}, размер ${content.w}×${content.h}`);

    // Картинки раздаём по локальным URL, чтобы отрисовка не ходила в сеть
    const assetById = new Map((ir.assets || []).map((a) => [a.id, a]));
    const assetUrl = (id) => {
      const a = assetById.get(id);
      if (!a || !a.file) return '';
      return `http://127.0.0.1:${PORT}/asset?f=${encodeURIComponent(a.file)}`;
    };
    const html = renderIr(ir, { assetUrl });

    const files = {
      render: html,
      blank: '<!doctype html><html><body style="margin:0"></body></html>',
      assetsDir: ir.assetsDir,
    };
    server = await startStaticServer(files);

    // Оригинал
    const shotOrig = Buffer.from(ir.screenshot.base64, 'base64');
    files['orig'] = shotOrig;
    files['orig.png'] = shotOrig;

    // Отрисовка IR
    const page = await browser.openPage(`http://127.0.0.1:${PORT}/render`,
      { width: WIDTH, height: 900 });
    await settlePage(page);
    const renderedBase64 = await screenshotBase64(page, content.w, content.h);
    const shotRender = Buffer.from(renderedBase64, 'base64');
    files['render.png'] = shotRender;
    await page.close();

    // Сравнение
    const blank = await browser.openPage(`http://127.0.0.1:${PORT}/blank`, { width: 400, height: 300 });
    const metrics = await diffInBrowser(blank,
      `http://127.0.0.1:${PORT}/orig.png`,
      `http://127.0.0.1:${PORT}/render.png`, 40);

    const outDir = path.join(__dirname, '..', '.cache', 'visual');
    fs.mkdirSync(outDir, { recursive: true });
    const name = URL_.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'page';
    fs.writeFileSync(path.join(outDir, name + '-orig.png'), shotOrig);
    fs.writeFileSync(path.join(outDir, name + '-render.png'), shotRender);
    const diffPng = Buffer.from(String(metrics.diffImage).split(',')[1], 'base64');
    fs.writeFileSync(path.join(outDir, name + '-diff.png'), diffPng);

    console.log(`\n=== СРАВНЕНИЕ ${metrics.width}×${metrics.height} ===`);
    console.log(`  попиксельно : среднее ${metrics.meanDiff.toFixed(2)}/255, ` +
      `отличается ${(metrics.diffFraction * 100).toFixed(2)}%`);
    console.log(`  структура   : среднее ${metrics.coarse.meanDiff.toFixed(2)}/255, ` +
      `отличается ${(metrics.coarse.diffFraction * 100).toFixed(2)}% ` +
      `(уменьшено в 4 раза — без ряби сглаживания шрифтов)`);
    const worst = metrics.bands.slice().sort((a, b) => b.fraction - a.fraction).slice(0, 4);
    console.log('  худшие полосы:');
    for (const b of worst) {
      console.log(`    y ${b.from}–${b.to}: ${(b.fraction * 100).toFixed(1)}% отличающихся пикселей`);
    }

    // Вырезаем худшую полосу из обоих изображений — чтобы её можно было
    // посмотреть глазами, а не догадываться по числам
    if (worst.length) {
      const band = worst[0];
      const cropper = await browser.openPage(`http://127.0.0.1:${PORT}/blank`, { width: 400, height: 300 });
      const crops = await cropper.evaluate(async (a, b, y0, y1) => {
        const load = (u) => new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error('нет ' + u));
          i.src = u;
        });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const w = Math.min(ia.naturalWidth, ib.naturalWidth);
        const h = Math.min(y1, ia.naturalHeight) - y0;
        const one = (img) => {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, y0, w, h, 0, 0, w, h);
          return c.toDataURL('image/png');
        };
        return { orig: one(ia), render: one(ib), y0, y1, w, h };
      }, { args: [`http://127.0.0.1:${PORT}/orig.png`, `http://127.0.0.1:${PORT}/render.png`,
        band.from, band.to] });
      await cropper.close();
      fs.writeFileSync(path.join(outDir, `${name}-worst-orig.png`),
        Buffer.from(crops.orig.split(',')[1], 'base64'));
      fs.writeFileSync(path.join(outDir, `${name}-worst-render.png`),
        Buffer.from(crops.render.split(',')[1], 'base64'));
      console.log(`  худшая полоса вырезана: ${name}-worst-{orig,render}.png (y ${band.from}–${band.to})`);
    }
    console.log(`  файлы: ${outDir}\\${name}-{orig,render,diff}.png`);

    await blank.close();

    // Проверка, что тест не штамп: убираем видимый слой и убеждаемся,
    // что метрика ухудшается. Это ровно тот класс ошибок, ради которого
    // тест и написан — молча потерянный слой.
    const good = metrics.diffFraction;
    const broken = JSON.parse(JSON.stringify(ir));
    const dropped = dropVisibleNode(broken.root);
    if (!dropped) console.log('  (не нашлось слоя для пробы чувствительности)');
    files.render = renderIr(broken, { assetUrl });
    const page2 = await browser.openPage(`http://127.0.0.1:${PORT}/render`, { width: WIDTH, height: 900 });
    await settlePage(page2);
    const brokenShot = await screenshotBase64(page2, content.w, content.h);
    files['render.png'] = Buffer.from(brokenShot, 'base64');
    await page2.close();

    const blank2 = await browser.openPage(`http://127.0.0.1:${PORT}/blank`, { width: 400, height: 300 });
    const brokenMetrics = await diffInBrowser(blank2,
      `http://127.0.0.1:${PORT}/orig.png`,
      `http://127.0.0.1:${PORT}/render.png`, 40);
    await blank2.close();

    console.log(`\n=== ПРОВЕРКА ЧУВСТВИТЕЛЬНОСТИ ТЕСТА ===`);
    console.log(`  убран слой: ${dropped ? dropped.name : '—'}`);
    console.log(`  с потерянным слоем: ${(brokenMetrics.diffFraction * 100).toFixed(2)}% ` +
      `(было ${(good * 100).toFixed(2)}%)`);

    console.log('\n=== ВЫВОДЫ ===');
    // Признак «шумной» страницы: убрали целый слой, а метрика не шевельнулась.
    // Значит, фоновое расхождение (динамика, ленивые секции, карусели)
    // перекрывает сигнал, и числам по этой странице доверять нельзя.
    const sensitive = !!dropped && (brokenMetrics.diffFraction - good) > 0.01;
    if (!sensitive) {
      console.log('  ВНИМАНИЕ: страница нестабильна — убранный слой не изменил метрику.');
      console.log('  Расхождения здесь отражают динамику сайта, а не качество переноса.');
      console.log('  Пороговые проверки по такой странице пропущены.');
    }
    if (sensitive) {
      check('структура совпадает', metrics.coarse.diffFraction < 0.06,
        `${(metrics.coarse.diffFraction * 100).toFixed(2)}% при пороге 6%`);
      check('структура близка по яркости', metrics.coarse.meanDiff < 8,
        `${metrics.coarse.meanDiff.toFixed(2)} при пороге 8`);
      check('попиксельное расхождение объяснимо', metrics.diffFraction < 0.15,
        `${(metrics.diffFraction * 100).toFixed(2)}% при пороге 15%`);
    }
    check('тест ловит потерянный слой', sensitive,
      `${(good * 100).toFixed(2)}% → ${(brokenMetrics.diffFraction * 100).toFixed(2)}%`);

    console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
    if (fails) process.exitCode = 1;
  } catch (e) {
    console.error('\nОШИБКА:', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await browser.close();
  }
})();
