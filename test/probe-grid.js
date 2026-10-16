'use strict';
/** Что Chrome отдаёт в вычисленных grid-template-* и как он расставляет ячейки. */
const { Browser } = require('../engine/browser');

const HTML = `<!doctype html><html><head><style>
  *{box-sizing:border-box} body{margin:0;font-family:Arial,monospace}
  .g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:400px;padding:0}
  .g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;width:400px;padding:0}
  .span2{grid-column:span 2}
  .cell{background:#e0e7ff;padding:8px}
  .fixed{display:grid;grid-template-columns:120px 200px;gap:6px;width:400px}
  .rows{display:grid;grid-template-columns:100px 100px;grid-template-rows:40px 60px;gap:5px;width:300px}
</style></head><body>
  <div class="g2"><div class="cell">A</div><div class="cell">B</div><div class="cell">C</div><div class="cell">D</div></div>
  <div class="g3"><div class="cell span2">X</div><div class="cell">E</div><div class="cell">F</div></div>
  <div class="fixed"><div class="cell">1</div><div class="cell">2</div></div>
  <div class="rows"><div class="cell">P</div><div class="cell">Q</div><div class="cell">R</div><div class="cell">S</div></div>
</body></html>`;

(async () => {
  const b = new Browser({ headless: true, profileMode: 'clean' });
  try {
    await b.launch();
    const page = await b.openPage('data:text/html;charset=utf-8,' + encodeURIComponent(HTML),
      { width: 900, height: 700 });

    const info = await page.evaluate(() => {
      const out = [];
      for (const cls of ['g2', 'g3', 'fixed', 'rows']) {
        const el = document.querySelector('.' + cls);
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const kids = Array.from(el.children).map((c) => {
          const cr = c.getBoundingClientRect();
          const ccs = getComputedStyle(c);
          return {
            x: Math.round((cr.x - r.x) * 100) / 100,
            y: Math.round((cr.y - r.y) * 100) / 100,
            w: Math.round(cr.width * 100) / 100,
            h: Math.round(cr.height * 100) / 100,
            colStart: ccs.gridColumnStart,
            colEnd: ccs.gridColumnEnd,
            rowStart: ccs.gridRowStart,
            rowEnd: ccs.gridRowEnd,
            pl: ccs.paddingLeft,
          };
        });
        out.push({
          cls,
          cols: cs.gridTemplateColumns,
          rows: cs.gridTemplateRows,
          autoFlow: cs.gridAutoFlow,
          colGap: cs.columnGap,
          rowGap: cs.rowGap,
          boxW: Math.round(r.width * 100) / 100,
          boxH: Math.round(r.height * 100) / 100,
          kids,
        });
      }
      return out;
    });

    for (const g of info) {
      console.log('=== .' + g.cls + ' ===');
      console.log('  grid-template-columns :', JSON.stringify(g.cols));
      console.log('  grid-template-rows    :', JSON.stringify(g.rows));
      console.log('  auto-flow             :', g.autoFlow, '| зазоры', g.colGap, '/', g.rowGap);
      console.log('  размер                :', g.boxW + '×' + g.boxH);
      for (const k of g.kids) {
        console.log(`    ячейка x=${k.x} y=${k.y} ${k.w}×${k.h}  column ${k.colStart}/${k.colEnd}  row ${k.rowStart}/${k.rowEnd}  padding-left=${k.pl}`);
      }
      console.log('');
    }
  } catch (e) {
    console.error('ОШИБКА:', e.stack || e);
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
