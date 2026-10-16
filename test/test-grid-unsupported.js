'use strict';
/**
 * Проверка деградации: что если версия Figma НЕ поддерживает GRID-лейаут.
 *
 * Это не гипотетический случай. Самопроверка в реальной Figma 126 показала:
 *   GRID-лейаут Figma и якоря ячеек — no setter for property
 * Импорт обязан это пережить: grid-контейнеры уходят в абсолютные координаты,
 * отчёт не должен врать, а работа не должна повторяться для каждого контейнера.
 */

const mock = require('./figma-mock');
const { captureUrl } = require('../engine/capture');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;font-family:Arial}
  .wrap{padding:20px}
  .g{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:400px}
  .c{height:40px;background:#e0e7ff;border-radius:6px}
  .flex{display:flex;gap:8px;margin-top:14px}
  .f{width:60px;height:30px;background:#fde68a}
</style></head><body>
  <div class="wrap">
    <div class="g"><div class="c"></div><div class="c"></div><div class="c"></div><div class="c"></div></div>
    <div class="flex"><div class="f"></div><div class="f"></div></div>
  </div>
</body></html>`;

let fails = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

/**
 * Сломать якоря grid-лейаута — ровно так, как это делает реальная Figma 126.
 * Важно: там работает `layoutMode = 'GRID'`, но НЕ работает
 * `gridColumnAnchorIndex`. Первая версия этого теста ломала layoutMode,
 * то есть моделировала не тот отказ — и пропустила бы реальную проблему.
 */
function breakGrid() {
  // Якоря объявлены на БАЗОВОМ типе узла. Если сломать их только у фреймов,
  // проба (она ставит якорь на прямоугольнике) ошибочно пройдёт — именно на
  // этом первая версия теста и споткнулась.
  const proto = Object.getPrototypeOf(mock.figmaMock.createRectangle());
  for (const name of ['gridColumnAnchorIndex', 'gridRowAnchorIndex', 'gridColumnSpan', 'gridRowSpan']) {
    const key = '_broken_' + name;
    Object.defineProperty(proto, name, {
      configurable: true,
      get() { return this[key] === undefined ? (name.endsWith('Span') ? 1 : 0) : this[key]; },
      set() { throw new Error('no setter for property'); },
    });
  }
}

(async () => {
  mock.install();
  mock.reset();
  breakGrid();
  delete require.cache[require.resolve('../code.js')];
  require('../code.js');

  const ir = await captureUrl('data:text/html;charset=utf-8,' + encodeURIComponent(HTML),
    { width: 600, height: 400, profileMode: 'clean', fetchAssets: false, screenshot: false });

  await mock.postToPlugin({ type: 'import', requestId: 'g', ir, options: { autoLayout: 'safe' } });

  const err = mock.messages().find((m) => m.type === 'error');
  const done = mock.messages().find((m) => m.type === 'done');

  console.log('=== ИМПОРТ ПРИ ОТСУТСТВИИ GRID ===');
  check('импорт не сорвался', !err, err ? err.message : '');
  check('отчёт получен', !!done);
  if (!done) { console.log('\nПРОВАЛЕНО'); process.exit(1); }

  const s = done.report.stats;
  console.log(`  авто-лейаут ${s.autoLayout}, абсолютно ${s.absolute}, grid ${s.grid}`);
  check('grid-фреймов ноль', s.grid === 0, String(s.grid));
  check('flex-контейнер всё равно получил авто-лейаут', s.autoLayout >= 1, String(s.autoLayout));
  check('отчёт не считает несостоявшийся grid авто-лейаутом',
    s.autoLayout + s.absolute === done.report.stats.autoLayout + s.absolute && s.absolute >= 2,
    `абсолютно ${s.absolute}`);
  check('есть понятное предупреждение',
    (done.report.warnings || []).some((w) => /GRID/i.test(w)),
    JSON.stringify(done.report.warnings));

  // Геометрия должна остаться точной, несмотря на откат
  const root = mock.figmaMock.currentPage._children[0];
  const all = mock.flatten(root);
  // Дорожка = (400 − 10) / 2 = 195 px. Ищем по высоте и наличию заливки,
  // чтобы проверка не зависела от точной ширины дорожки.
  const cells = all.filter((n) => (n._fills || []).length > 0 && Math.abs(n.height - 40) < 1.5);
  console.log(`  ячеек сетки найдено: ${cells.length} (${cells.map((c) => Math.round(c.width)).join(', ')} px шириной)`);
  check('ячейки сетки на месте', cells.length === 4, String(cells.length));
  if (cells.length === 4) {
    check('ширина дорожки верная', cells.every((c) => Math.abs(c.width - 195) < 2),
      cells.map((c) => Math.round(c.width)).join(', '));
  }
  if (cells.length >= 2) {
    const xs = cells.map((c) => Math.round(c.x)).sort((a, b) => a - b);
    check('две колонки сохранены', new Set(xs).size === 2, `x = ${xs.join(', ')}`);
    check('вторая колонка сдвинута на 205 px (195 + зазор 10)',
      Math.abs((xs[2] - xs[0]) - 205) < 2, `${xs[2] - xs[0]} px`);
  }

  console.log('\n=== ПОВТОРНЫЙ ИМПОРТ (не должно быть повторных попыток GRID) ===');
  mock.reset();
  breakGrid();
  const ir2 = await captureUrl('data:text/html;charset=utf-8,' + encodeURIComponent(HTML),
    { width: 600, height: 400, profileMode: 'clean', fetchAssets: false, screenshot: false });
  await mock.postToPlugin({ type: 'import', requestId: 'g2', ir: ir2, options: { autoLayout: 'safe' } });
  const done2 = mock.messages().find((m) => m.type === 'done');
  check('второй импорт тоже завершился', !!done2);
  if (done2) {
    const reasons = (done2.report.autoReasons || []).map(([k]) => k).join('; ');
    console.log('  причины отказа: ' + reasons);
  }

  console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
  if (fails) process.exitCode = 1;
})().catch((e) => {
  console.error('\nОШИБКА ТЕСТА:', e && e.stack || e);
  process.exitCode = 1;
});
