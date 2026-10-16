'use strict';
/** Отладка: почему обёртка текста встаёт не туда. */
const fs = require('node:fs');
const path = require('node:path');
const mock = require('./figma-mock');

const CACHE = path.join(__dirname, '..', '.cache', 'big.ir.json');
const NEEDLE = process.argv[2] || '.px-2.text-4xl';

mock.install();
mock.reset();
delete require.cache[require.resolve('../code.js')];
const plugin = require('../code.js');

function findIR(node, needle, out) {
  if (node.selPath && node.selPath.includes(needle)) out.push(node);
  for (const c of node.children || []) findIR(c, needle, out);
  return out;
}

(async () => {
  const ir = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  for (const a of ir.assets || []) {
    if (!a.file) continue;
    const bytes = fs.readFileSync(path.join(ir.assetsDir, a.file));
    await mock.postToPlugin({ type: 'asset-chunk', assets: [{ id: a.id, bytes: new Uint8Array(bytes) }] });
  }
  await mock.postToPlugin({ type: 'import', requestId: 'dbg', ir, options: { autoLayout: 'safe' } });

  const hits = findIR(ir.root, NEEDLE, []);
  console.log(`Найдено узлов IR по "${NEEDLE}": ${hits.length}`);
  for (const h of hits.slice(0, 2)) {
    console.log('\n--- IR ---');
    console.log('  type :', h.type);
    console.log('  name :', h.name);
    console.log('  box  :', JSON.stringify(h.box));
    console.log('  bbox :', JSON.stringify(h.bbox));
    console.log('  style: padding-left =', h.style['padding-left'], ', border-left =', h.style['border-left-width']);
    console.log('  sel  :', h.selPath);
  }

  // Найти соответствующий узел в дереве Figma
  const root = mock.figmaMock.currentPage._children[0];
  const targetName = hits[0] && hits[0].name;
  let found = null;
  (function walk(n) {
    if (n.name === targetName) { found = n; return; }
    for (const c of n._children || []) { if (found) return; walk(c); }
  })(root);

  if (!found) { console.log('\nВ дереве Figma слой не найден по имени:', targetName); return; }
  console.log('\n--- FIGMA ---');
  console.log('  type:', found.type, ' name:', found.name);
  console.log('  x,y  :', found.x, found.y, ' w,h:', found.width, found.height);
  console.log('  layoutMode:', found._layoutMode);
  console.log('  дети :', (found._children || []).map((c) => `${c.type} "${c.name}" @${c.x},${c.y} ${c.width}×${c.height}`));

  console.log('\n--- ЦЕПОЧКА РОДИТЕЛЕЙ В FIGMA ---');
  let p = found.parent;
  let depth = 0;
  while (p && depth++ < 6) {
    console.log(`  ${'  '.repeat(depth)}${p.type} "${p.name}" @${p.x},${p.y} ${p.width}×${p.height} ` +
      `layout=${p._layoutMode || '-'} pad=${p.paddingLeft || 0}/${p.paddingTop || 0} spacing=${p.itemSpacing || 0} ` +
      `align=${p.primaryAxisAlignItems || '-'}/${p.counterAxisAlignItems || '-'}`);
    p = p.parent;
  }
})().catch((e) => { console.error('ОШИБКА:', e.stack || e); process.exitCode = 1; });
