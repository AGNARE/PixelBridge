'use strict';
/** Где в IR оказалась шапка MDN и почему. */
const { captureUrl } = require('../engine/capture');

(async () => {
  const ir = await captureUrl('https://developer.mozilla.org/en-US/', {
    width: 1280, height: 900, profileMode: 'clean', fetchAssets: false, screenshot: false,
  });

  const rows = [];
  (function walk(n, ax, ay) {
    const t = (n.text || '').replace(/\s+/g, ' ').slice(0, 30);
    const cls = (n.cls || '').slice(0, 40);
    if (ay > 600 && ay < 900) {
      rows.push({ ax, ay, type: n.type, tag: n.tag, name: (n.name || '').slice(0, 46),
        cls, pos: (n.style || {}).position, top: (n.style || {}).top, z: (n.style || {}).zIndex, text: t });
    }
    for (const c of n.children || []) walk(c, ax + c.box.x, ay + c.box.y);
  })(ir.root, ir.root.box.x, ir.root.box.y);
  rows.sort((a, b) => a.ay - b.ay);
  console.log(`узлов с абсолютным y в 600..900: ${rows.length}\n`);
  for (const r of rows.slice(0, 24)) {
    console.log(`  y=${String(Math.round(r.ay)).padStart(5)} x=${String(Math.round(r.ax)).padStart(5)} ` +
      `${r.type.padEnd(5)} ${String(r.tag).padEnd(9)} pos=${String(r.pos).padEnd(8)} top=${String(r.top).padEnd(6)} ` +
      `${r.name}${r.text ? ' «' + r.text + '»' : ''}`);
  }

  // Все липкие и фиксированные элементы страницы
  console.log('\n=== position: sticky / fixed ===');
  (function walk(n, ax, ay) {
    const pos = (n.style || {}).position;
    if (pos === 'sticky' || pos === 'fixed') {
      console.log(`  ${pos.padEnd(7)} y=${String(Math.round(ay)).padStart(5)} ` +
        `${String(n.tag).padEnd(9)} ${(n.name || '').slice(0, 50)}`);
    }
    for (const c of n.children || []) walk(c, ax + c.box.x, ay + c.box.y);
  })(ir.root, ir.root.box.x, ir.root.box.y);
})().catch((e) => { console.error('ОШИБКА:', e.stack || e); process.exitCode = 1; });
