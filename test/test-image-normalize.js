'use strict';
/**
 * Проверка перекодирования картинок в формат, который принимает Figma.
 *
 * figma.createImage понимает PNG, JPEG и GIF. Современные сайты отдают AVIF
 * и SVG — на formula1.com так терялось 65 картинок из 76. Движок обязан
 * перекодировать их сам, своим браузером.
 *
 * Тест без сети: картинки раздаёт локальный сервер.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { captureUrl } = require('../engine/capture');

const PORT = 7407;

const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const SVG_DOC = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
  '<rect width="80" height="40" rx="8" fill="#6366f1"/>' +
  '<circle cx="20" cy="20" r="10" fill="#fde68a"/></svg>';

let fails = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/pic.svg') {
      const buf = Buffer.from(SVG_DOC, 'utf8');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }
    if (req.url === '/pic.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_PIXEL.length });
      res.end(PNG_PIXEL);
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;font-family:Arial;background:#fff}
      .wrap{display:flex;gap:20px;padding:24px}
      img{width:160px;height:80px;object-fit:cover}
    </style></head><body>
      <div class="wrap">
        <img src="http://127.0.0.1:${PORT}/pic.svg" alt="Вектор">
        <img src="http://127.0.0.1:${PORT}/pic.png" alt="Растр">
      </div>
    </body></html>`;
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const server = await startServer();
  try {
    const ir = await captureUrl(`http://127.0.0.1:${PORT}/`, {
      width: 600, height: 400, profileMode: 'clean',
      fetchAssets: true, screenshot: false,
      assetsDir: path.join(__dirname, '..', '.cache', 'assets', 'normalize-test'),
    });

    console.log('=== АССЕТЫ ПОСЛЕ ЗАХВАТА ===');
    for (const a of ir.assets || []) {
      console.log(`  ${a.id}  исходный=${a.originalMime || '?'}  итоговый=${a.mime}  ` +
        `перекодирован=${a.converted ? 'да' : 'нет'}  ${((a.bytes || 0) / 1024).toFixed(1)} КБ  ${a.file}`);
    }
    check('обе картинки скачаны', (ir.assets || []).length === 2, String((ir.assets || []).length));

    const svg = (ir.assets || []).find((a) => /svg/i.test(a.originalMime || ''));
    const png = (ir.assets || []).find((a) => /png/i.test(a.originalMime || ''));

    check('SVG найден', !!svg);
    check('PNG найден', !!png);

    if (svg) {
      check('SVG перекодирован', svg.converted === true);
      check('SVG стал PNG', svg.mime === 'image/png', svg.mime);
      check('файл SVG не пустой', (svg.bytes || 0) > 0, `${svg.bytes} байт`);
      const p = path.join(ir.assetsDir, svg.file || '');
      check('файл на диске есть', fs.existsSync(p));
      if (fs.existsSync(p)) {
        const head = fs.readFileSync(p).slice(0, 8);
        check('на диске действительно PNG',
          head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47,
          head.toString('hex'));
      }
    }

    if (png) {
      check('PNG не перекодирован зря', png.converted === false, String(png.converted));
      check('PNG остался PNG', png.mime === 'image/png', png.mime);
    }

    const unsafe = (ir.assets || []).filter((a) => !/^image\/(png|jpe?g|gif)$/i.test(a.mime || ''));
    check('несовместимых форматов не осталось', unsafe.length === 0,
      unsafe.map((a) => a.mime).join(', '));

    // Плагин должен увидеть обе картинки как IMAGE-заливки
    const mock = require('./figma-mock');
    mock.install();
    mock.reset();
    delete require.cache[require.resolve('../code.js')];
    require('../code.js');
    for (const a of ir.assets || []) {
      if (!a.file) continue;
      const bytes = fs.readFileSync(path.join(ir.assetsDir, a.file));
      await mock.postToPlugin({ type: 'asset-chunk', assets: [{ id: a.id, bytes: new Uint8Array(bytes) }] });
    }
    await mock.postToPlugin({
      type: 'import', requestId: 'n', ir,
      options: { autoLayout: 'safe', addAnnotations: true, addPluginData: true },
    });
    const done = mock.messages().find((m) => m.type === 'done');
    const err = mock.messages().find((m) => m.type === 'error');
    check('плагин собрал без ошибок', !err, err ? err.message : '');
    check('отчёт получен', !!done);
    if (done) {
      console.log(`  картинок в отчёте: ${done.report.stats.images}, пропущено: ${done.report.missingImages}`);
      check('обе картинки стали слоями', done.report.stats.images === 2,
        String(done.report.stats.images));
      check('пропущенных картинок нет', done.report.missingImages === 0,
        String(done.report.missingImages));
    }

    console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
    if (fails) process.exitCode = 1;
  } catch (e) {
    console.error('ОШИБКА:', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
