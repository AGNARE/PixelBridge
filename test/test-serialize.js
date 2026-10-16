'use strict';
/**
 * Проверка сериализатора.
 * Главное: реконструируем абсолютные координаты обходом IR и сверяем с getBoundingClientRect
 * живого DOM. Именно это доказывает точность геометрии, а не «на глаз».
 */
const { Browser } = require('../engine/browser');
const { serializeSnapshot, COMPUTED_STYLES } = require('../engine/serialize');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Карточка</title>
<style>
  * { box-sizing: border-box }
  body { margin:0; font-family: Arial, sans-serif; background:#f8fafc }
  .card { display:flex; flex-direction:column; gap:12px; padding:20px; width:420px;
          background:#fff; border:1px solid #e2e8f0; border-radius:14px;
          box-shadow:0 8px 24px rgba(15,23,42,.10); margin:40px }
  .row { display:flex; align-items:center; gap:10px }
  .dot { width:10px; height:10px; border-radius:50%; background:#22c55e }
  .title { margin:0; font-size:20px; font-weight:700; color:#0f172a; letter-spacing:-.3px }
  .muted { margin:0; color:#64748b; font-size:13px; line-height:1.5 }
  .btn { padding:12px 18px; background:linear-gradient(90deg,#6366f1,#a855f7);
         color:#fff; border:0; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer }
  .hidden { display:none }
  .mix { padding:16px; background:#eff6ff; border-radius:10px }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px }
  .cell { padding:8px; background:#e0e7ff; border-radius:6px }
</style></head><body>
  <div class="card">
    <div class="row"><span class="dot"></span><h2 class="title">Заголовок карточки</h2></div>
    <p class="muted">Описание в две строки,<br>с переносом и <b>жирным</b> словом.</p>
    <div class="mix">Прямой текст перед блоком<div style="margin-top:8px;color:#1d4ed8">вложенный блок</div></div>
    <button class="btn">Купить сейчас</button>
    <input type="text" placeholder="Email" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px">
    <div class="grid"><div class="cell">A</div><div class="cell">B</div></div>
    <span class="hidden">не должно быть в результате</span>
    <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjMGVhNWU5Ii8+PC9zdmc+" alt="Лого" width="40" height="40">
  </div>
</body></html>`;

const CHECK_SELECTORS = [
  '.card', '.row', '.dot', '.title', '.muted', '.mix', '.btn', 'input', '.grid', '.cell', 'img',
];

function dump(node, indent = '', out = []) {
  const box = `[${node.box.x},${node.box.y} ${node.box.w}×${node.box.h}]`;
  const extra = [];
  if (node.text !== undefined) extra.push(`text=${JSON.stringify(node.text.slice(0, 34))}`);
  if (node.runs) extra.push(`runs=${node.runs.length}`);
  out.push(`${indent}${node.type.padEnd(6)} ${node.name} ${box} ${extra.join(' ')}`);
  for (const c of node.children) dump(c, indent + '  ', out);
  return out;
}

function flatten(root) {
  const out = [];
  (function walk(n, absX, absY) {
    out.push({ node: n, absX, absY });
    for (const c of n.children) walk(c, absX + c.box.x, absY + c.box.y);
  })(root, root.box.x, root.box.y);
  return out;
}

(async () => {
  const browser = new Browser({ headless: true, profileMode: 'clean' });
  let fails = 0;
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) fails++;
  };
  try {
    await browser.launch();
    const page = await browser.openPage('data:text/html;charset=utf-8,' + encodeURIComponent(HTML),
      { width: 1200, height: 900 });

    await page.evaluate(() => {
      for (const img of document.images) {
        if (img.currentSrc && img.getAttribute('src') !== img.currentSrc) img.setAttribute('src', img.currentSrc);
      }
    });

    // Эталон из живого DOM снимается позже — когда известны селекторы из IR.

    const snap = await page.send('DOMSnapshot.captureSnapshot', {
      computedStyles: COMPUTED_STYLES, includeDOMRects: true, includePaintOrder: true,
    });
    const ir = serializeSnapshot(snap, {
      url: 'test://card', viewportWidth: 1200, viewportHeight: 900,
    });

    console.log('stats   :', JSON.stringify(ir.stats));
    console.log('content :', JSON.stringify(ir.content));
    console.log('\n=== ДЕРЕВО IR ===');
    for (const line of dump(ir.root)) console.log(line);

    // ---------- Функциональные проверки ----------
    const flat = flatten(ir.root);
    const nodes = flat.map((f) => f.node);
    const texts = nodes.filter((n) => n.type === 'text');
    const byText = (s) => texts.find((n) => n.text.includes(s));
    console.log('\n=== ФУНКЦИОНАЛЬНЫЕ ПРОВЕРКИ ===');
    check('текст заголовка найден', !!byText('Заголовок карточки'));
    check('перенос строки сохранён', (byText('Описание в две строки') || {}).text?.includes('\n') === true);
    check('жирный ран выделен', ((byText('Описание в две строки') || {}).runs || []).length > 1);
    check('прямой текст перед блоком не потерян', !!byText('Прямой текст перед блоком'));
    check('текст кнопки найден', !!byText('Купить сейчас'));
    check('display:none пропущен', !byText('не должно быть'));
    check('плейсхолдер input найден', nodes.some((n) => n.type === 'input' && n.text === 'Email'));
    check('есть image-слой', nodes.some((n) => n.type === 'image'));
    check('градиент на кнопке', nodes.some((n) => (n.style['background-image'] || '').includes('gradient')));
    check('grid container распознан', nodes.some((n) => n.style.display === 'grid'));
    check('нет лишних пробелов', !texts.some((n) => /  |\n /.test(n.text)));

    // ---------- ГЕОМЕТРИЯ: сверка с живым DOM ----------
    // Селекторы берём ИЗ IR и ищем их в DOM — это заодно проверяет генерацию селекторов.
    const sels = [...new Set(flat.map((f) => f.node.selPath).filter((s) => s && s !== ':text'))];
    const truth = await page.evaluate((list) => {
      const sx = window.scrollX, sy = window.scrollY;
      const out = {};
      for (const s of list) {
        let el = null;
        try { el = document.querySelector(s); } catch { continue; }
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const n = (v) => parseFloat(v) || 0;
        const bl = n(cs.borderLeftWidth), bt = n(cs.borderTopWidth);
        const br = n(cs.borderRightWidth), bb = n(cs.borderBottomWidth);
        const pl = n(cs.paddingLeft), pt = n(cs.paddingTop);
        const pr = n(cs.paddingRight), pb = n(cs.paddingBottom);
        out[s] = {
          border: { x: r.x + sx, y: r.y + sy, w: r.width, h: r.height },
          content: {
            x: r.x + sx + bl + pl, y: r.y + sy + bt + pt,
            w: r.width - bl - br - pl - pr, h: r.height - bt - bb - pt - pb,
          },
        };
      }
      return out;
    }, { args: [sels] });

    console.log('\n=== ГЕОМЕТРИЯ (IR против getBoundingClientRect) ===');
    const TOL = 1.5;
    let checked = 0;
    for (const f of flat) {
      const sel = f.node.selPath;
      if (!sel || sel === ':text') continue;
      const t = truth[sel];
      if (!t) { check(`эталон для ${sel}`, false, 'селектор не найден в DOM'); continue; }
      const useContent = f.node.type === 'text';
      const want = useContent ? t.content : t.border;
      const got = { x: f.absX, y: f.absY, w: f.node.box.w, h: f.node.box.h };
      const dx = Math.abs(got.x - want.x), dy = Math.abs(got.y - want.y);
      const dw = Math.abs(got.w - want.w), dh = Math.abs(got.h - want.h);
      checked++;
      check(
        `${sel} (${useContent ? 'content' : 'border'}-box)`,
        dx <= TOL && dy <= TOL && dw <= TOL && dh <= TOL,
        `x ${got.x.toFixed(1)}/${want.x.toFixed(1)} y ${got.y.toFixed(1)}/${want.y.toFixed(1)} ` +
        `w ${got.w.toFixed(1)}/${want.w.toFixed(1)} h ${got.h.toFixed(1)}/${want.h.toFixed(1)}`
      );
    }
    console.log(`  проверено слоёв: ${checked}`);

    console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
    if (fails) process.exitCode = 1;
  } catch (e) {
    console.error('ОШИБКА:', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
