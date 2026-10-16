'use strict';
/** Почему пропала картинка-значок на MDN: что говорит IR про ассеты. */
const { captureUrl } = require('../engine/capture');

(async () => {
  const ir = await captureUrl('https://developer.mozilla.org/en-US/', {
    width: 1280, height: 900, profileMode: 'clean', fetchAssets: true, screenshot: false,
  });

  console.log('=== АССЕТЫ ===');
  console.log('найдено внешних:', (ir.assets || []).length);
  for (const a of ir.assets || []) {
    console.log(`  ${a.id}  файл=${a.file || 'НЕ СКАЧАН'}  ${String(a.url).slice(0, 90)}`);
  }
  if (ir.assetsStats) {
    console.log('скачано:', ir.assetsStats.ok, 'из', ir.assetsStats.total);
    for (const f of ir.assetsStats.failed || []) {
      console.log('  НЕУДАЧА:', f.error, String(f.url).slice(0, 90));
    }
  }
  console.log('встроенных (data:) картинок:', ir.inlineAssets);

  console.log('\n=== СЛОИ-КАРТИНКИ И ФОНЫ ===');
  (function walk(n, ax, ay) {
    if (n.type === 'image' || n.src || n.bgSrc || n.inlineSrc || n.inlineBgSrc) {
      console.log(`  y=${String(Math.round(ay)).padStart(5)} ${n.type.padEnd(5)} ` +
        `src=${n.src || (n.inlineSrc ? 'inline' : '—')} bg=${n.bgSrc || (n.inlineBgSrc ? 'inline' : '—')} ` +
        `bgi=${String((n.style || {})['background-image'] || '').slice(0, 46)} ${(n.name || '').slice(0, 34)}`);
    }
    for (const c of n.children || []) walk(c, ax + c.box.x, ay + c.box.y);
  })(ir.root, ir.root.box.x, ir.root.box.y);

  console.log('\n=== ПРЕДУПРЕЖДЕНИЯ ===');
  for (const w of ir.warnings || []) console.log('  ' + w);
})().catch((e) => { console.error('ОШИБКА:', e.stack || e); process.exitCode = 1; });
