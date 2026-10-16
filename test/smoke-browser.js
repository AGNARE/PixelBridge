'use strict';
/** Дымовой тест: запуск Chrome, открытие страницы, чтение метрик через CDP. */
const { Browser } = require('../engine/browser');

(async () => {
  const t0 = Date.now();
  const browser = new Browser({ headless: true, profileMode: 'clean' });
  console.log('Браузер:', browser.executablePath);
  try {
    await browser.launch();
    console.log(`Запуск + CDP: ${Date.now() - t0} мс, порт ${browser.port}`);

    const page = await browser.openPage('data:text/html,' + encodeURIComponent(`
      <html><head><style>
        body{margin:0;font-family:Arial,sans-serif}
        .box{width:300px;height:120px;background:linear-gradient(135deg,#6366f1,#a855f7);
             border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
        h1{margin:0;font-size:28px;color:#fff}
      </style></head><body>
        <div class="box"><h1>Привет, Figma</h1></div>
      </body></html>`), { width: 1280, height: 800 });

    const title = await page.evaluate(() => document.title);
    const box = await page.evaluate(() => {
      const el = document.querySelector('.box');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: r.width, h: r.height, radius: cs.borderRadius, bg: cs.backgroundImage.slice(0, 40) };
    });
    console.log('title =', JSON.stringify(title));
    console.log('box   =', JSON.stringify(box));

    const metrics = await page.send('Page.getLayoutMetrics');
    console.log('cssContentSize =', JSON.stringify(metrics.cssContentSize));

    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    console.log('Скриншот base64, байт:', shot.data.length);

    // Главная проверка: DOMSnapshot с computed styles
    const snap = await page.send('DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'width', 'height', 'color', 'background-image'],
      includeDOMRects: true,
      includePaintOrder: true,
    });
    const doc = snap.documents[0];
    console.log('DOMSnapshot: узлов =', doc.nodes.nodeName.length,
                ', layout-записей =', doc.layout.nodeIndex.length,
                ', строк =', snap.strings.length);
    const li = doc.layout.nodeIndex[1];
    console.log('layout[1] nodeIndex =', li,
                'bounds =', JSON.stringify(doc.layout.bounds[1]),
                'styles =', (doc.layout.styles[1] || []).length, 'строк');

    await page.close();
    console.log('\nOK — движок работает.');
  } catch (err) {
    console.error('\nОШИБКА:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
