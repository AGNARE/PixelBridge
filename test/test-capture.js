'use strict';
/**
 * Захват реального сайта из командной строки.
 *   node test/test-capture.js https://example.com [ширина]
 */
const fs = require('node:fs');
const path = require('node:path');
const { captureUrl } = require('../engine/capture');
const { validateIR, formatReport } = require('../engine/validate');

const url = process.argv[2] || 'https://example.com';
const width = parseInt(process.argv[3], 10) || 1440;

function dump(node, indent = '', out = [], depth = 99) {
  const extra = [];
  if (node.text !== undefined) extra.push(`«${node.text.replace(/\n/g, '\\n').slice(0, 30)}»`);
  if (node.type === 'image') extra.push(node.src ? `asset:${node.src}` : (node.inlineSrc ? 'inline' : 'НЕТ ИСТОЧНИКА'));
  if (node.type === 'svg') extra.push(node.svg ? `svg ${node.svg.length}б` : 'svg БЕЗ РАЗМЕТКИ');
  if (node.note) extra.push(`[${node.note}]`);
  out.push(`${indent}${node.type.padEnd(5)} ${node.name} [${node.box.x},${node.box.y} ${node.box.w}×${node.box.h}] ${extra.join(' ')}`);
  if (indent.length / 2 < depth) {
    for (const c of node.children) dump(c, indent + '  ', out, depth);
  } else if (node.children.length) {
    out.push(`${indent}  … ещё ${node.children.length} детей`);
  }
  return out;
}

(async () => {
  console.log(`Захват: ${url} @ ${width}px\n`);
  try {
    const ir = await captureUrl(url, { width, height: 900, profileMode: 'clean', fetchAssets: true });
    console.log('title    :', JSON.stringify(ir.title));
    console.log('content  :', JSON.stringify(ir.content));
    console.log('timings  :', JSON.stringify(ir.timings), 'всего', ir.totalMs + 'мс');
    console.log('stats    :', JSON.stringify(ir.stats));
    console.log('assets   :', (ir.assets || []).length, 'внешних,', ir.inlineAssets, 'встроенных');
    if (ir.assetsStats) {
      console.log('          скачано', ir.assetsStats.ok, 'из', ir.assetsStats.total);
      for (const f of ir.assetsStats.failed.slice(0, 8)) {
        console.log('          FAIL', f.error, f.url.slice(0, 90));
      }
    }
    console.log('warnings :', JSON.stringify(ir.warnings));

    const report = validateIR(ir);
    console.log('\n=== ВАЛИДАЦИЯ IR ===');
    console.log(formatReport(report));

    console.log('\n=== ДЕРЕВО (первые 60 строк) ===');
    for (const line of dump(ir.root).slice(0, 60)) console.log(line);

    const outDir = path.join(__dirname, '..', '.cache');
    fs.mkdirSync(outDir, { recursive: true });
    const name = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
    const irPath = path.join(outDir, name + '.ir.json');
    const save = Object.assign({}, ir);
    if (save.screenshot) {
      const png = path.join(outDir, name + '.png');
      fs.writeFileSync(png, Buffer.from(save.screenshot.base64, 'base64'));
      console.log(`\nскриншот: ${png}`);
      delete save.screenshot;
    }
    fs.writeFileSync(irPath, JSON.stringify(save));
    console.log(`IR: ${irPath} (${(fs.statSync(irPath).size / 1024).toFixed(1)} КБ)`);
    console.log('\nOK');
  } catch (e) {
    console.error('\nОШИБКА:', e && e.stack || e);
    process.exitCode = 1;
  }
})();
