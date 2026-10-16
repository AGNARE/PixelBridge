'use strict';
/**
 * Стресс-тест конвертера на реальной тяжёлой странице.
 * Свежий захват → конвертер → сверка геометрии всего дерева.
 */
const mock = require('./figma-mock');
const fs = require('node:fs');
const path = require('node:path');
const { captureUrl } = require('../engine/capture');

const URL_ = process.argv.find((a) => /^https?:/.test(a)) || 'https://tailwindcss.com/';
const WIDTH = parseInt(process.argv.find((a) => /^\d+$/.test(a)), 10) || 1440;
const REUSE = process.argv.includes('--reuse');
const CACHE = path.join(__dirname, '..', '.cache', 'big.ir.json');

/** Дети IR-узла, которые становятся отдельными слоями Figma. */
function figChildrenFor(figNode, irNode) {
  // Текст с padding плагин оборачивает во фрейм, внутри — сам текст
  if (irNode.type === 'text' && irNode.bbox) return [];
  // Поле ввода тоже строится как фрейм с текстом-плейсхолдером
  if (irNode.type === 'input') return [];
  return figNode._children || [];
}
/** Обёртка внешних отступов: внутри ровно один узел, координаты копятся. */
function isMarginWrap(figNode) {
  return !!(figNode.getPluginData && figNode.getPluginData('w2f.margin') === '1' && figNode._children.length === 1);
}
function expectedBox(n) { return (n.type === 'text' && n.bbox) ? n.bbox : n.box; }

(async () => {
  mock.install();
  mock.reset();
  delete require.cache[require.resolve('../code.js')];
  require('../code.js');

  let ir;
  if (REUSE && fs.existsSync(CACHE)) {
    ir = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    console.log(`IR из кэша: слоёв ${ir.stats.emitted}, картинок ${(ir.assets || []).length}`);
  } else {
    console.log(`Захват ${URL_} @ ${WIDTH}px…`);
    const t0 = Date.now();
    ir = await captureUrl(URL_, { width: WIDTH, height: 900, profileMode: 'clean', fetchAssets: true });
    console.log(`Захват: ${Date.now() - t0} мс, слоёв ${ir.stats.emitted}, картинок ${(ir.assets || []).length}`);
    const save = Object.assign({}, ir);
    delete save.screenshot;
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(save));
  }
  const fm = Object.keys(ir.fontMap || {}).length;
  if (ir.timings) {
    console.log('Тайминги: ' + Object.entries(ir.timings).map(([k, v]) => `${k} ${v}мс`).join(', '));
  }
  if (ir.assetsStats && ir.assetsStats.failed && ir.assetsStats.failed.length) {
    const reasons = {};
    for (const f of ir.assetsStats.failed) {
      const key = String(f.error).replace(/\d+/g, 'N').slice(0, 40);
      reasons[key] = (reasons[key] || 0) + 1;
    }
    console.log('Не скачались картинки: ' + Object.entries(reasons).map(([k, v]) => `${k} ×${v}`).join('; '));
  }
  console.log(`Индекс ответов сети (картинки): ${ir.networkImages}`);
  if (ir.assetsStats && ir.assetsStats.failed && ir.assetsStats.failed.length) {
    console.log('Примеры несработавших URL:');
    for (const f of ir.assetsStats.failed.slice(0, 3)) console.log('   ' + f.url.slice(0, 120));
  }
  console.log(`Стеков шрифтов распознано: ${fm}`);
  for (const [stack, used] of Object.entries(ir.fontMap || {}).slice(0, 4)) {
    console.log(`   ${JSON.stringify(stack).slice(0, 55)} → ${used}`);
  }

  // Передаём байты картинок в плагин, как это делает UI
  for (const a of ir.assets || []) {
    if (!a.file) continue;
    const fs = require('node:fs');
    const path = require('node:path');
    const bytes = fs.readFileSync(path.join(ir.assetsDir, a.file));
    await mock.postToPlugin({ type: 'asset-chunk', assets: [{ id: a.id, bytes: new Uint8Array(bytes) }] });
  }

  console.log('\nПостроение…');
  const t1 = Date.now();
  await mock.postToPlugin({
    type: 'import', requestId: 'big', ir,
    options: { autoLayout: 'safe', textAutoHeight: true, addAnnotations: true, addPluginData: true },
  });
  const buildMs = Date.now() - t1;

  const msgs = mock.messages();
  const errors = msgs.filter((m) => m.type === 'error');
  const done = msgs.find((m) => m.type === 'done');
  let fails = 0;
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) fails++;
  };

  console.log('\n=== РЕЗУЛЬТАТ ===');
  check('нет ошибок плагина', errors.length === 0, errors.map((e) => e.message).join('; '));
  if (!done) { console.log('нет отчёта'); process.exit(1); }
  const rep = done.report;
  console.log(`  построение: ${buildMs} мс`);
  console.log(`  фреймов ${rep.stats.frames}, текстов ${rep.stats.texts}, картинок ${rep.stats.images}, svg ${rep.stats.svgs}`);
  console.log(`  авто-лейаут ${rep.stats.autoLayout}, абсолютно ${rep.stats.absolute}`);
  console.log(`  шрифтов ${rep.fonts.loaded}/${rep.fonts.requested}, пропущено картинок ${rep.missingImages}`);
  const total = rep.stats.frames + rep.stats.texts + rep.stats.images + rep.stats.svgs;
  const autoPct = rep.stats.autoLayout + rep.stats.absolute > 0
    ? (100 * rep.stats.autoLayout / (rep.stats.autoLayout + rep.stats.absolute)).toFixed(0) : 0;
  console.log(`  слоёв всего ${total}, авто-лейаутом покрыто ${autoPct}% контейнеров`);
  if (rep.warnings.length) {
    console.log(`  предупреждения (${rep.warnings.length}):`);
    for (const w of rep.warnings.slice(0, 8)) console.log('    • ' + w);
  }
  if (rep.missingFonts.length) {
    console.log(`  шрифты не найдены: ${JSON.stringify(rep.missingFonts.slice(0, 6))}`);
  }

  const root = mock.figmaMock.currentPage._children[0];
  check('корневой фрейм', !!root);
  if (!root) process.exit(1);

  // ---- Сверка геометрии ----
  // slackX/slackY — накопленный сдвиг от УЖЕ ПРИНЯТЫХ расхождений высоты текста.
  // Мок считает метрики шрифта грубо, поэтому текст в нём выше/ниже настоящего;
  // в колоночном авто-лейауте это сдвигает всех последующих братьев.
  // Без учёта slack такие сдвиги выглядели бы как новые ошибки.
  const TOL = 2.5;
  let compared = 0;
  let worst = 0;
  const roots = [];
  const cascades = [];
  const t2 = Date.now();

  function walk(irNode, figNode, irX, irY, figX, figY, path, isRoot, parentOk, slackX, slackY) {
    // Разворачиваем обёртку внешних отступов: её координаты складываются
    while (isMarginWrap(figNode)) {
      figX += figNode.x;
      figY += figNode.y;
      figNode = figNode._children[0];
    }
    const eb = expectedBox(irNode);
    const ew = isRoot ? ir.content.w : eb.w;
    const eh = isRoot ? ir.content.h : eb.h;
    const ix = irX + eb.x, iy = irY + eb.y;
    const fx = figX + figNode.x, fy = figY + figNode.y;
    const dx = Math.abs(ix - fx), dy = Math.abs(iy - fy);
    const dw = Math.abs(ew - figNode.width), dh = Math.abs(eh - figNode.height);
    compared++;

    const isText = irNode.type === 'text';
    const tolX = TOL + slackX;
    const tolY = (isText ? TOL + dh / 2 : TOL) + slackY;
    const tolH = isText ? Infinity : TOL;
    const tolW = isText ? TOL + 1 : TOL;
    const ok = dx <= tolX && dy <= tolY && dw <= tolW && dh <= tolH;
    worst = Math.max(worst, dx, dy);

    if (!ok) {
      const info = {
        path,
        ir: `${ix.toFixed(1)},${iy.toFixed(1)} ${ew.toFixed(1)}×${eh.toFixed(1)}`,
        fig: `${fx.toFixed(1)},${fy.toFixed(1)} ${figNode.width.toFixed(1)}×${figNode.height.toFixed(1)}`,
        d: `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} dw=${dw.toFixed(1)} dh=${dh.toFixed(1)}` +
           (slackX || slackY ? ` slack=${slackX.toFixed(1)}/${slackY.toFixed(1)}` : ''),
        parentAuto: figParentAuto(figNode),
        kind: `${irNode.type}${irNode.bbox ? '+bbox' : ''}`,
      };
      if (parentOk) roots.push(info);
      else if (cascades.length < 5) cascades.push(info);
    }

    const kids = figChildrenFor(figNode, irNode);
    const irKids = irNode.children || [];
    if (kids.length !== irKids.length) {
      if (parentOk) roots.push({ path, kind: 'структура', d: `детей ${irKids.length} против ${kids.length}`, ir: '', fig: '', parentAuto: figParentAuto(figNode) });
      return isText ? dh : 0;
    }

    const mode = figNode._layoutMode;
    const auto = mode === 'HORIZONTAL' || mode === 'VERTICAL';
    let accX = 0, accY = 0;
    for (let i = 0; i < irKids.length; i++) {
      const delta = walk(irKids[i], kids[i], ix, iy, fx, fy,
        `${path} > ${irKids[i].name}`, false, parentOk && ok, slackX + accX, slackY + accY);
      if (auto && delta) {
        if (mode === 'HORIZONTAL') accX += delta;
        else accY += delta;
      }
    }
    return isText ? dh : 0;
  }

  walk(ir.root, root, 0, 0, -root.x, -root.y, ir.root.name, true, true, 0, 0);
  const walkMs = Date.now() - t2;

  console.log(`\n=== ГЕОМЕТРИЯ ===`);
  console.log(`  сверено слоёв: ${compared} за ${walkMs} мс, макс. смещение ${worst.toFixed(2)}px`);
  check('корневых расхождений нет', roots.length === 0,
    `корневых ${roots.length}, каскадных ${cascades.length}`);
  for (const s of roots.slice(0, 14)) {
    console.log(`      ! [${s.kind}${s.parentAuto ? ', родитель авто-лейаут' : ''}] ${s.d}`);
    console.log(`        ${s.path.split(' > ').slice(-3).join(' > ')}`);
    console.log(`        IR  [${s.ir}]`);
    console.log(`        FIG [${s.fig}]`);
  }
  if (cascades.length) {
    console.log(`      (каскадные, показаны ${cascades.length}: следствие корневых)`);
  }

  console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
  if (fails) process.exitCode = 1;
})().catch((e) => {
  console.error('\nОШИБКА:', e && e.stack || e);
  process.exitCode = 1;
});

function figParentAuto(figNode) {
  const p = figNode.parent;
  return !!(p && p._layoutMode && p._layoutMode !== 'NONE');
}
