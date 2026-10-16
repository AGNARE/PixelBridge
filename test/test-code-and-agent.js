'use strict';
/**
 * Сквозная проверка двух путей, которые ещё ни разу не тестировались целиком:
 *
 *   1. Импорт HTML/CSS-кода — рендер в Chrome → IR → слои Figma
 *   2. Агентская сборка — спецификация дизайна → IR → слои Figma
 *
 * Плагин настоящий (code.js) поверх мока Figma, движок настоящий.
 */

const PORT = 7405;
process.env.W2F_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

const mock = require('./figma-mock');
const { Browser } = require('../engine/browser');
const { sleep } = require('../engine/browser');

let fails = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

async function postJson(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Собрать IR плагином и вернуть корневой узел Figma. */
async function buildWithPlugin(ir, options) {
  mock.reset();
  await mock.postToPlugin({
    type: 'import', requestId: 'x', ir,
    options: Object.assign({ autoLayout: 'safe', addAnnotations: true, addPluginData: true }, options || {}),
  });
  const err = mock.messages().find((m) => m.type === 'error');
  const done = mock.messages().find((m) => m.type === 'done');
  return { err, done, root: mock.figmaMock.currentPage._children[0] };
}

/** Сверить геометрию дерева Figma с IR (как в test-converter). */
function compareGeometry(ir, root, tolerance) {
  const TOL = tolerance === undefined ? 2.5 : tolerance;
  const problems = [];
  let compared = 0;
  const eb = (n) => ((n.type === 'text' && n.bbox) ? n.bbox : n.box);
  const kids = (f, n) => {
    if (n.type === 'text' && n.bbox) return [];
    if (n.type === 'input') return [];
    return f._children || [];
  };
  (function walk(irN, figN, ix, iy, fx, fy, path, isRoot) {
    const e = eb(irN);
    const ew = isRoot ? ir.content.w : e.w;
    const eh = isRoot ? ir.content.h : e.h;
    const X = ix + e.x, Y = iy + e.y;
    const FX = fx + figN.x, FY = fy + figN.y;
    const dx = Math.abs(X - FX), dy = Math.abs(Y - FY);
    const dw = Math.abs(ew - figN.width), dh = Math.abs(eh - figN.height);
    compared++;
    const isText = irN.type === 'text';
    const ok = dx <= TOL && dy <= (isText ? TOL + dh / 2 : TOL) &&
      dw <= (isText ? TOL + 1 : TOL) && dh <= (isText ? Infinity : TOL);
    if (!ok && problems.length < 6) {
      problems.push(`${path.split(' > ').slice(-2).join(' > ')}: ` +
        `IR [${X.toFixed(1)},${Y.toFixed(1)} ${ew.toFixed(1)}×${eh.toFixed(1)}] ` +
        `FIG [${FX.toFixed(1)},${FY.toFixed(1)} ${figN.width.toFixed(1)}×${figN.height.toFixed(1)}]`);
    }
    const k = kids(figN, irN), ik = irN.children || [];
    if (k.length !== ik.length) {
      problems.push(`${path}: детей ${ik.length} против ${k.length}`);
      return;
    }
    for (let i = 0; i < ik.length; i++) {
      walk(ik[i], k[i], X, Y, FX, FY, path + ' > ' + ik[i].name, false);
    }
  })(ir.root, root, 0, 0, -root.x, -root.y, ir.root.name, true);
  return { compared, problems };
}

(async () => {
  require('../engine/server');
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch (e) { /* ждём */ }
    await sleep(100);
  }

  mock.install();
  mock.reset();
  delete require.cache[require.resolve('../code.js')];
  require('../code.js');

  // =====================================================================
  console.log('########## ПУТЬ 1: ИМПОРТ HTML/CSS-КОДА ##########');
  const code = await postJson('/api/capture-code', {
    html: `<!doctype html><html><body>
      <div class="card">
        <div class="row"><span class="dot"></span><h1>Заголовок из кода</h1></div>
        <p>Описание с <b>жирным</b> словом и переносом<br>на вторую строку.</p>
        <div class="grid"><div class="c a"></div><div class="c b"></div>
          <div class="c" style="grid-column: span 2"></div></div>
        <button class="btn">Купить сейчас</button>
      </div>
    </body></html>`,
    css: `*{box-sizing:border-box} body{margin:0;font-family:Inter,Arial,sans-serif;background:#f8fafc}
      .card{display:flex;flex-direction:column;gap:12px;padding:24px;width:460px;margin:40px auto;
            background:#fff;border:1px solid #e2e8f0;border-radius:16px;
            box-shadow:0 10px 30px rgba(15,23,42,.12)}
      .row{display:flex;align-items:center;gap:10px}
      .dot{width:12px;height:12px;border-radius:50%;background:#22c55e}
      h1{margin:0;font-size:22px;font-weight:700;color:#0f172a}
      p{margin:0;color:#475569;font-size:14px;line-height:1.6}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .c{height:52px;border-radius:8px;background:#e0e7ff}
      .c.b{background:#fde68a}
      .btn{align-self:flex-start;padding:12px 20px;border:0;border-radius:10px;font-size:15px;
           font-weight:600;color:#fff;background:linear-gradient(90deg,#6366f1,#a855f7)}`,
    width: 800, height: 900,
  });

  check('движок отрендерил код', code.status === 200 && code.body.ok === true,
    JSON.stringify(code.body).slice(0, 200));
  check('валидация IR без ошибок', code.body.validation && code.body.validation.errors === 0,
    JSON.stringify(code.body.validation));
  const ir1 = code.body.ir;
  check('слово из кода дошло до IR', JSON.stringify(ir1).indexOf('Заголовок из кода') !== -1);
  check('градиент из CSS разобран',
    JSON.stringify(ir1).indexOf('linear-gradient') !== -1);
  check('grid из CSS распознан', JSON.stringify(ir1).indexOf('"display":"grid"') !== -1);
  console.log(`  слоёв ${ir1.stats.emitted}, текстов ${ir1.stats.texts}, размер ${ir1.content.w}×${ir1.content.h}`);

  const b1 = await buildWithPlugin(ir1, { autoLayout: 'safe' });
  check('плагин собрал код без ошибок', !b1.err, b1.err ? b1.err.message : '');
  check('отчёт получен', !!b1.done);
  if (b1.done) {
    const s = b1.done.report.stats;
    console.log(`  фреймов ${s.frames}, текстов ${s.texts}, grid ${s.grid}, авто-лейаут ${s.autoLayout}`);
    const g = compareGeometry(ir1, b1.root);
    check(`геометрия кода совпала (${g.compared} слоёв)`, g.problems.length === 0,
      g.problems.slice(0, 2).join(' | '));
    const autoLayoutFrames = mock.flatten(b1.root).filter((n) => /HORIZONTAL|VERTICAL|GRID/.test(n._layoutMode || ''));
    check('авто-лейаут применён к карточке', autoLayoutFrames.length >= 2,
      `фреймов с авто-лейаутом: ${autoLayoutFrames.length}`);
  }

  // =====================================================================
  console.log('\n########## ПУТЬ 2: АГЕНТСКАЯ СБОРКА ДИЗАЙНА ##########');
  const received = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS не открылся')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
    if (!msg.cmd) return;
    received.push(msg);
    ws.send(JSON.stringify({
      type: 'result', requestId: msg.requestId, ok: true,
      result: { nodeId: 'agent:1', name: msg.ir ? msg.ir.title : '', layers: (msg.ir && msg.ir.stats) ? msg.ir.stats.emitted : 0 },
    }));
  });
  ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', fileName: 'Тест агента', pageName: 'Test' }));
  await sleep(200);

  const spec = {
    name: 'Экран входа',
    width: 1440, height: 900,
    background: '#0f172a',
    nodes: [
      {
        type: 'frame', name: 'Карточка входа',
        box: [520, 250, 400, 400],
        style: { background: '#ffffff', radius: 18, boxShadow: '0 20px 60px rgba(0,0,0,.45)', padding: 32 },
        children: [
          { type: 'text', name: 'Заголовок', text: 'Вход в аккаунт', box: [32, 32, 336, 40],
            style: { fontSize: 28, fontWeight: 700, color: '#0f172a' } },
          { type: 'text', name: 'Подпись', text: 'Введите email и пароль', box: [32, 84, 336, 24],
            style: { fontSize: 15, color: '#64748b' } },
          { type: 'frame', name: 'Кнопка', box: [32, 300, 336, 48],
            style: { background: '#6366f1', radius: 12 },
            children: [
              { type: 'text', name: 'Текст кнопки', text: 'Войти', box: [0, 14, 336, 20],
                style: { fontSize: 16, fontWeight: 600, color: '#ffffff', textAlign: 'center' } },
            ] },
        ],
      },
    ],
  };

  const build = await postJson('/api/build', spec);
  check('сервер принял спецификацию', build.status === 200 && build.body.ok === true,
    JSON.stringify(build.body).slice(0, 200));
  const cmd = received.find((m) => m.cmd === 'build');
  check('плагин получил команду build', !!cmd);
  if (cmd) {
    const ir2 = cmd.ir;
    check('спецификация превратилась в IR', !!(ir2 && ir2.root));
    check('корневой фрейм нужного размера', ir2.root.box.w === 1440 && ir2.root.box.h === 900,
      `${ir2.root.box.w}×${ir2.root.box.h}`);
    check('фон подложки попал в IR',
      JSON.stringify(ir2.root.style).indexOf('#0f172a') !== -1);
    check('вложенность сохранена', (ir2.root.children[0].children || []).length === 3,
      String((ir2.root.children[0].children || []).length));
    check('тень разобрана как CSS',
      ir2.root.children[0].style['box-shadow'] === '0 20px 60px rgba(0,0,0,.45)',
      ir2.root.children[0].style['box-shadow']);

    const b2 = await buildWithPlugin(ir2, { autoLayout: 'safe' });
    check('плагин собрал агентский дизайн без ошибок', !b2.err, b2.err ? b2.err.message : '');
    if (b2.done) {
      const s = b2.done.report.stats;
      console.log(`  фреймов ${s.frames}, текстов ${s.texts}, авто-лейаут ${s.autoLayout}, картинок ${s.images}`);
      check('слои текста созданы', s.texts === 3, String(s.texts));
      // В спецификации позиции заданы вручную, поэтому авто-лейаут применить
      // нельзя: координаты не совпадут с потоком. Плагин обязан это понять,
      // а не разложить «на глазок».
      check('авто-лейаут не применён к ручным координатам', s.autoLayout === 0,
        `авто-лейаут ${s.autoLayout}`);
      const reasons = (b2.done.report.autoReasons || []).map(([k]) => k).join('; ');
      console.log('  причины отказа от авто-лейаута: ' + (reasons || '—'));
      const texts = mock.flatten(b2.root).filter((n) => n.type === 'TEXT');
      const joined = texts.map((t) => t.characters).join(' | ');
      check('тексты дошли до слоёв', /Вход в аккаунт/.test(joined) && /Войти/.test(joined), joined.slice(0, 80));
      const grad = mock.flatten(b2.root).filter((n) => (n._fills || []).some((f) => f.color && f.color.b > 0.9 && f.color.r < 0.5));
      check('цвет кнопки применён', grad.length >= 1, `слоёв с синей заливкой: ${grad.length}`);
      const fontNames = new Set(texts.map((t) => t.fontName.family + ' ' + t.fontName.style));
      console.log('  шрифты текстовых слоёв: ' + Array.from(fontNames).join(', '));
      check('жирный текст получил жирный шрифт',
        texts.some((t) => /Bold/.test(t.fontName.style) && /Вход в аккаунт/.test(t.characters)),
        Array.from(fontNames).join(', '));
    }
  }

  ws.close();
  await sleep(150);

  console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\nОШИБКА ТЕСТА:', e && e.stack || e);
  process.exit(1);
});
