'use strict';
/**
 * Сквозной тест конвертера: браузер → IR → дерево Figma.
 *
 * Проверяется главное: геометрия дерева Figma совпадает с геометрией браузера.
 * Дерево раскладывает МОК — независимая реализация поведения Figma,
 * поэтому совпадение это не тавтология.
 */
const mock = require('./figma-mock');
const { captureUrl } = require('../engine/capture');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Карточка товара</title>
<style>
  * { box-sizing: border-box }
  body { margin:0; font-family: Inter, Arial, sans-serif; background:#f8fafc }
  .page { display:flex; flex-direction:column; gap:16px; padding:32px; width:760px; margin:0 auto }
  .card { display:flex; flex-direction:column; gap:12px; padding:20px; width:420px;
          background:#fff; border:1px solid #e2e8f0; border-radius:14px;
          box-shadow:0 8px 24px rgba(15,23,42,.10) }
  .row { display:flex; align-items:center; gap:10px }
  .dot { width:10px; height:10px; border-radius:50%; background:#22c55e }
  .title { margin:0; font-size:20px; font-weight:700; color:#0f172a; letter-spacing:-.3px }
  .muted { margin:0; color:#64748b; font-size:13px; line-height:1.5 }
  .btn { padding:12px 18px; background:linear-gradient(90deg,#6366f1,#a855f7);
         color:#fff; border:0; border-radius:10px; font-size:14px; font-weight:600 }
  .swatch { width:64px; height:40px; border-radius:8px; background:#6366f1 }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px }
  .cell { padding:8px; background:#e0e7ff; border-radius:6px }
  .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:12px }
  .span2 { grid-column: span 2 }
</style></head><body>
  <div class="page">
    <div class="card">
      <div class="row"><span class="dot"></span><h2 class="title">Заголовок карточки</h2></div>
      <p class="muted">Описание в две строки,<br>с переносом и <b>жирным</b> словом.</p>
      <button class="btn">Купить сейчас</button>
      <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjMGVhNWU5Ii8+PC9zdmc+" alt="Лого" width="40" height="40">
    </div>
    <div class="row"><div class="swatch"></div><div class="swatch"></div><div class="swatch"></div></div>
    <div class="grid"><div class="cell">A</div><div class="cell">B</div>
      <div class="cell">C</div><div class="cell">D</div></div>
    <div class="grid3"><div class="cell span2">Широкая ячейка</div><div class="cell">E</div>
      <div class="cell">F</div></div>
  </div>
</body></html>`;

function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  return ok ? 0 : 1;
}

/** Дети IR-узла, которые действительно становятся отдельными слоями Figma. */
function figChildrenFor(figNode, irNode) {
  if (irNode.type === 'text' && irNode.bbox) return []; // обёртка, внутри только текст
  if (irNode.type === 'input') return [];               // фрейм с текстом-плейсхолдером
  return figNode._children || [];
}

/** Обёртка внешних отступов: внутри ровно один узел, координаты копятся. */
function isMarginWrap(figNode) {
  return !!(figNode.getPluginData && figNode.getPluginData('w2f.margin') === '1' && figNode._children.length === 1);
}

function expectedBox(irNode) {
  if (irNode.type === 'text' && irNode.bbox) return irNode.bbox;
  return irNode.box;
}

(async () => {
  mock.install();
  mock.reset();
  delete require.cache[require.resolve('../code.js')];
  require('../code.js');

  console.log('Захват тестовой страницы…');
  const ir = await captureUrl('data:text/html;charset=utf-8,' + encodeURIComponent(HTML), {
    width: 900, height: 800, profileMode: 'clean', fetchAssets: false, screenshot: false,
  });
  ir.url = 'test://карточка';
  console.log(`IR: слоёв ${ir.stats.emitted}, текстов ${ir.stats.texts}\n`);

  await mock.postToPlugin({
    type: 'import', requestId: 'r1', ir,
    options: { autoLayout: 'safe', addAnnotations: true, addPluginData: true },
  });

  const msgs = mock.messages();
  const errors = msgs.filter((m) => m.type === 'error');
  const done = msgs.find((m) => m.type === 'done');

  let fails = 0;
  console.log('=== СООБЩЕНИЯ ПЛАГИНА ===');
  fails += check('нет ошибок', errors.length === 0, errors.map((e) => e.message).join('; '));
  fails += check('пришёл отчёт done', !!done);
  if (!done) { console.log('\nНет отчёта — дальше проверять нечего'); process.exit(1); }

  const rep = done.report;
  console.log(`  слоёв: фреймов ${rep.stats.frames}, текстов ${rep.stats.texts}, ` +
              `картинок ${rep.stats.images}, svg ${rep.stats.svgs}`);
  console.log(`  авто-лейаут: ${rep.stats.autoLayout}, абсолютно: ${rep.stats.absolute}`);
  console.log(`  шрифтов загружено: ${rep.fonts.loaded}/${rep.fonts.requested}`);
  if (rep.warnings.length) console.log('  предупреждения: ' + JSON.stringify(rep.warnings));

  // ---- Сверка деревьев ----
  const root = mock.figmaMock.currentPage._children[0];
  fails += check('корневой фрейм создан', !!root);
  if (!root) process.exit(1);

  console.log('\n=== ГЕОМЕТРИЯ (Figma против IR) ===');
  let compared = 0;
  let worst = 0;
  const problems = [];
  const TOL = 1.6;

  (function walk(irNode, figNode, irAbsX, irAbsY, figAbsX, figAbsY, path, isRoot) {
    // Разворачиваем обёртку внешних отступов: её координаты складываются,
    // дальше сравниваем уже сам слой
    while (isMarginWrap(figNode)) {
      figAbsX += figNode.x;
      figAbsY += figNode.y;
      figNode = figNode._children[0];
    }
    const eb = expectedBox(irNode);
    // Корневой фрейм намеренно растянут до размера страницы (ir.content),
    // а не до высоты <html> — иначе фон не заполнит экран.
    const expectW = isRoot ? ir.content.w : eb.w;
    const expectH = isRoot ? ir.content.h : eb.h;

    const irChildX = irAbsX + eb.x;
    const irChildY = irAbsY + eb.y;
    const figChildX = figAbsX + figNode.x;
    const figChildY = figAbsY + figNode.y;

    const dx = Math.abs(irChildX - figChildX);
    const dy = Math.abs(irChildY - figChildY);
    const dw = Math.abs(expectW - figNode.width);
    const dh = Math.abs(expectH - figNode.height);
    compared++;

    // Высоту текста считает движок Figma по своим метрикам шрифта, а мок
    // использует грубую оценку. Поэтому у текста допускаем расхождение высоты,
    // а по вертикали — сдвиг не больше половины этой разницы (родитель центрирует).
    const isText = irNode.type === 'text';
    const tolY = isText ? TOL + dh / 2 : TOL;
    const tolH = isText ? Infinity : TOL;
    const tolW = isText ? TOL + 1 : TOL;

    worst = Math.max(worst, dx, dy);
    if (dx > TOL || dy > tolY || dw > tolW || dh > tolH) {
      problems.push(`${path}\n      IR  [${irChildX.toFixed(1)},${irChildY.toFixed(1)} ${expectW.toFixed(1)}×${expectH.toFixed(1)}]` +
                    `\n      FIG [${figChildX.toFixed(1)},${figChildY.toFixed(1)} ${figNode.width.toFixed(1)}×${figNode.height.toFixed(1)}]`);
    }

    const figKids = figChildrenFor(figNode, irNode);
    const irKids = irNode.children || [];
    if (figKids.length !== irKids.length) {
      problems.push(`${path}: детей в IR ${irKids.length}, в Figma ${figKids.length}`);
      return;
    }
    for (let i = 0; i < irKids.length; i++) {
      walk(irKids[i], figKids[i], irChildX, irChildY, figChildX, figChildY,
        `${path} > ${irKids[i].name}`, false);
    }
  // Оба дерева приводим к началу координат их корня, иначе сравниваем позиции
  // на холсте, а не геометрию макета.
  })(ir.root, root, 0, 0, -root.x, -root.y, ir.root.name, true);

  fails += check(`сверено слоёв: ${compared}`, problems.length === 0,
    problems.length ? `расхождений ${problems.length}, макс. смещение ${worst.toFixed(2)}px` : `макс. смещение ${worst.toFixed(2)}px`);
  for (const p of problems.slice(0, 12)) console.log('      ! ' + p);

  // ---- Свойства ----
  console.log('\n=== СВОЙСТВА ===');
  const all = mock.flatten(root);

  const grads = all.filter((n) => (n._fills || []).some((f) => /^GRADIENT/.test(f.type)));
  fails += check('градиент перенесён', grads.length > 0,
    grads.length ? grads[0].name + ': ' + grads[0]._fills.find((f) => /GRADIENT/.test(f.type)).gradientStops.length + ' остановок' : '');

  const shadows = all.filter((n) => (n._effects || []).some((e) => e.type === 'DROP_SHADOW'));
  fails += check('тень перенесена', shadows.length > 0,
    shadows.length ? shadows[0].name + ': radius=' + shadows[0]._effects[0].radius + ' offset=' + JSON.stringify(shadows[0]._effects[0].offset) : '');

  const bordered = all.filter((n) => (n._strokes || []).length > 0);
  fails += check('границы перенесены', bordered.length > 0,
    bordered.length ? bordered[0].name + ' weight=' + bordered[0].strokeWeight : '');

  const rounded = all.filter((n) => (n.cornerRadius || 0) > 0);
  fails += check('скругления перенесены', rounded.length > 0,
    rounded.length ? rounded[0].name + ' r=' + rounded[0].cornerRadius : '');

  const texts = all.filter((n) => n.type === 'TEXT');
  fails += check('текстовых слоёв столько же, сколько в IR', texts.length === ir.stats.texts,
    `${texts.length} против ${ir.stats.texts}`);

  const interText = texts.find((t) => /Заголовок/.test(t.characters));
  fails += check('жирный заголовок получил Bold', !!interText && /Bold/.test(interText.fontName.style),
    interText ? interText.fontName.family + ' ' + interText.fontName.style : 'слой не найден');

  const runText = texts.find((t) => /Описание/.test(t.characters));
  fails += check('диапазоны (жирное слово) применены', !!runText && runText._ranges.length > 0,
    runText ? 'диапазонов ' + runText._ranges.length : '');

  const autos = all.filter((n) => /HORIZONTAL|VERTICAL/.test(n._layoutMode || ''));
  const grids = all.filter((n) => n._layoutMode === 'GRID');
  fails += check('авто-лейаут использован', autos.length > 0, `фреймов с авто-лейаутом: ${autos.length}`);
  fails += check('grid-контейнеры получили GRID-лейаут Figma', grids.length >= 2,
    `grid-фреймов: ${grids.length}`);
  for (const g of grids) {
    console.log(`      grid: ${g.name.slice(0, 34)} — ${g.gridColumnCount}×${g.gridRowCount}, ` +
      `зазоры ${g.gridColumnGap}/${g.gridRowGap}, ` +
      `якоря детей: ${g._children.map((c) => `${c.gridColumnAnchorIndex}:${c.gridRowAnchorIndex}+${c.gridColumnSpan}`).join(' ')}`);
  }
  if (autos.length) {
    console.log('      пример: ' + autos.map((a) => `${a.name} ${a._layoutMode} gap=${a.itemSpacing} ${a.primaryAxisAlignItems}/${a.counterAxisAlignItems}`).slice(0, 3).join('\n               '));
  }

  const pluginData = all.filter((n) => n._pluginData && n._pluginData['w2f.sel']);
  fails += check('трассировка к CSS сохранена в pluginData', pluginData.length > 0,
    `слоёв с селектором: ${pluginData.length}`);

  const notes = all.filter((n) => (n.annotations || []).length > 0);
  fails += check('описания (alt/aria) сохранены', notes.length > 0,
    notes.length ? JSON.stringify(notes[0].annotations[0]) : 'нет');

  const imgFills = all.filter((n) => (n._fills || []).some((f) => f.type === 'IMAGE'));
  fails += check('картинка стала IMAGE-заливкой', imgFills.length === ir.stats.images,
    `${imgFills.length} против ${ir.stats.images}`);
  fails += check('пропущенных картинок нет', rep.missingImages === 0, 'missing=' + rep.missingImages);

  console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
  if (fails) process.exitCode = 1;
})().catch((e) => {
  console.error('\nОШИБКА ТЕСТА:', e && e.stack || e);
  process.exitCode = 1;
});
