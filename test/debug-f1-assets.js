'use strict';
/** Почему Figma не принимает картинки: смотрим форматы и способ использования. */
const fs = require('node:fs');
const path = require('node:path');
const { captureUrl } = require('../engine/capture');

(async () => {
  const ir = await captureUrl('https://www.formula1.com/', {
    width: 1440, height: 900, profileMode: 'clean', fetchAssets: true, screenshot: false,
  });

  console.log('ассетов:', (ir.assets || []).length);
  const byMime = {};
  let totalBytes = 0;
  for (const a of ir.assets || []) {
    const m = a.mime || '(неизвестно)';
    byMime[m] = (byMime[m] || 0) + 1;
    totalBytes += a.bytes || 0;
  }
  console.log('\n=== ФОРМАТЫ ===');
  for (const [m, n] of Object.entries(byMime).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${m}`);
  }
  console.log(`  суммарно ${(totalBytes / 1024 / 1024).toFixed(2)} МБ`);

  console.log('\n=== КАК ИСПОЛЬЗУЮТСЯ ===');
  let bySrc = 0, byBg = 0, inline = 0;
  const usedIds = new Set();
  (function walk(n) {
    if (n.src) { bySrc++; usedIds.add(n.src); }
    if (n.bgSrc) { byBg++; usedIds.add(n.bgSrc); }
    if (n.inlineSrc || n.inlineBgSrc) inline++;
    for (const c of n.children || []) walk(c);
  })(ir.root);
  console.log(`  как <img> src      : ${bySrc}`);
  console.log(`  как фон (bgSrc)    : ${byBg}`);
  console.log(`  встроенных data:   : ${inline}`);
  console.log(`  уникальных ссылок  : ${usedIds.size}`);
  const unused = (ir.assets || []).filter((a) => !usedIds.has(a.id));
  console.log(`  ассетов не использовано слоями: ${unused.length}`);

  console.log('\n=== КРУПНЕЙШИЕ И НЕОБЫЧНЫЕ ===');
  const sorted = (ir.assets || []).slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  for (const a of sorted.slice(0, 6)) {
    console.log(`  ${((a.bytes || 0) / 1024).toFixed(0).padStart(6)} КБ  ${a.mime || '?'}  file=${a.file}`);
  }
  const weird = (ir.assets || []).filter((a) => a.mime && !/png|jpeg|jpg|gif|webp/i.test(a.mime));
  console.log('\n  форматов, которые Figma может не принять:', weird.length);
  for (const a of weird.slice(0, 10)) console.log(`    ${a.mime}  ${String(a.url).slice(0, 80)}`);
})();
