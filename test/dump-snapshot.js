'use strict';
/** Диагностика: какую именно структуру отдаёт DOMSnapshot. Смотрим факты, не память. */
const { Browser } = require('../engine/browser');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Проба</title>
<style>
  * { box-sizing: border-box }
  body { margin:0; font-family: Arial; background:#f8fafc }
  .card { display:flex; flex-direction:column; gap:12px; padding:20px; width:400px;
          background:#fff; border:1px solid #e2e8f0; border-radius:14px;
          box-shadow:0 8px 24px rgba(15,23,42,.10); margin:40px }
  .row { display:flex; align-items:center; gap:10px }
  .dot { width:10px; height:10px; border-radius:50%; background:#22c55e }
  .title { font-size:20px; font-weight:700; color:#0f172a; letter-spacing:-.3px }
  .muted { color:#64748b; font-size:13px; line-height:1.5 }
  .btn { padding:10px 18px; background:linear-gradient(90deg,#6366f1,#a855f7);
         color:#fff; border-radius:10px; border:0; font-size:14px }
  .hidden { display:none }
  .card::after { content:"pseudo"; color:red }
  .rel { position:relative; background:#fee2e2; padding:8px }
  .abs { position:absolute; top:4px; right:4px; width:20px; height:20px; background:#ef4444 }
  .abs2 { position:absolute; top:4px; left:4px; width:20px; height:20px; background:#3b82f6; z-index:5 }
</style></head><body>
  <div class="card">
    <div class="row"><span class="dot"></span><h2 class="title">Заголовок карточки</h2></div>
    <p class="muted">Описание в две строки,<br>с переносом.</p>
    <div class="rel">относительный<div class="abs"></div><div class="abs2"></div></div>
    <button class="btn">Купить сейчас</button>
    <input type="text" placeholder="Email" value="">
    <span class="hidden">скрытый</span>
    <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjMGVhNWU5Ii8+PC9zdmc+" alt="Лого" width="40" height="40">
    <svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#f59e0b"/></svg>
  </div>
</body></html>`;

(async () => {
  const browser = new Browser({ headless: true, profileMode: 'clean' });
  try {
    await browser.launch();
    const page = await browser.openPage('data:text/html,' + encodeURIComponent(HTML), { width: 1000, height: 900 });
    const snap = await page.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [
        'display', 'position', 'flex-direction', 'gap', 'padding-top', 'padding-left',
        'width', 'height', 'color', 'background-color', 'background-image',
        'border-top-width', 'border-top-color', 'border-top-style', 'border-radius',
        'box-shadow', 'font-family', 'font-size', 'font-weight', 'line-height',
        'letter-spacing', 'text-align', 'opacity', 'overflow', 'z-index', 'visibility',
      ],
      includeDOMRects: true,
      includePaintOrder: true,
    });
    const doc = snap.documents[0];
    const S = snap.strings;
    const str = (i) => (i === undefined || i === null || i < 0 ? null : S[i]);
    const attrsAt = (i) => {
      const a = doc.nodes.attributes[i] || [];
      const o = {};
      for (let k = 0; k + 1 < a.length; k += 2) o[str(a[k])] = str(a[k + 1]);
      return o;
    };

    console.log('=== РАЗМЕРЫ ===');
    console.log('nodes.parentIndex  :', doc.nodes.parentIndex.length);
    console.log('nodes.nodeType     :', doc.nodes.nodeType.length);
    console.log('nodes.nodeName     :', doc.nodes.nodeName.length);
    console.log('nodes.nodeValue    :', doc.nodes.nodeValue.length);
    console.log('nodes.backendNodeId:', doc.nodes.backendNodeId.length);
    console.log('nodes.attributes   :', doc.nodes.attributes.length);
    console.log('layout.nodeIndex   :', doc.layout.nodeIndex.length);
    console.log('layout.styles      :', doc.layout.styles.length);
    console.log('layout.bounds      :', doc.layout.bounds.length);
    console.log('layout.paintOrders :', doc.layout.paintOrders.length);
    console.log('layout.text        :', doc.layout.text.length);
    console.log('textBoxes.layIndex :', doc.textBoxes ? doc.textBoxes.layoutIndex.length : 'нет');
    console.log('strings            :', S.length);
    console.log('есть pseudoType?   :', Object.keys(doc.nodes).filter(k => /pseudo|Pseudo/.test(k)));
    console.log('все ключи nodes    :', Object.keys(doc.nodes).join(', '));
    console.log('все ключи layout   :', Object.keys(doc.layout).join(', '));
    console.log('все ключи document :', Object.keys(doc).join(', '));

    console.log('\n=== ДЕРЕВО УЗЛОВ (nodes) ===');
    for (let i = 0; i < doc.nodes.nodeType.length && i < 40; i++) {
      const t = doc.nodes.nodeType[i];
      const name = str(doc.nodes.nodeName[i]);
      const par = doc.nodes.parentIndex[i];
      const a = attrsAt(i);
      const aStr = Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ');
      console.log(`  [${i}] type=${t} parent=${par} <${name}> ${aStr.slice(0, 90)}`);
    }

    console.log('\n=== LAYOUT ===');
    for (let i = 0; i < doc.layout.nodeIndex.length && i < 40; i++) {
      const ni = doc.layout.nodeIndex[i];
      const b = doc.layout.bounds[i];
      const po = doc.layout.paintOrders ? doc.layout.paintOrders[i] : '?';
      const txt = str(doc.layout.text[i]);
      const tag = str(doc.nodes.nodeName[ni]);
      console.log(`  layout[${i}] -> node[${ni}] <${tag}> bounds=${JSON.stringify(b)} paintOrder=${po} text=${txt ? JSON.stringify(txt.slice(0, 30)) : '-'}`);
    }

    console.log('\n=== СТИЛИ layout[1] (body) ===');
    const st = doc.layout.styles[1] || [];
    for (let k = 0; k + 1 < st.length; k += 2) console.log(`  ${str(st[k])} = ${str(st[k + 1])}`);

    // Найдём карточку
    let cardIdx = -1;
    for (let i = 0; i < doc.layout.nodeIndex.length; i++) {
      const ni = doc.layout.nodeIndex[i];
      const a = attrsAt(ni);
      if ((a.class || '').includes('card')) { cardIdx = i; break; }
    }
    if (cardIdx >= 0) {
      console.log(`\n=== СТИЛИ .card (layout[${cardIdx}]) ===`);
      const cs = doc.layout.styles[cardIdx] || [];
      for (let k = 0; k + 1 < cs.length; k += 2) console.log(`  ${str(cs[k])} = ${str(cs[k + 1])}`);
    }

    console.log('\n=== textBoxes ===');
    if (doc.textBoxes) {
      for (let i = 0; i < Math.min(doc.textBoxes.layoutIndex.length, 10); i++) {
        const li = doc.textBoxes.layoutIndex[i];
        const start = doc.textBoxes.start[i];
        const len = doc.textBoxes.length[i];
        console.log(`  tb[${i}] layoutIndex=${li} start=${start} len=${len}`);
      }
    }
    console.log('\n=== scrolling / размеры ===');
    console.log('doc.title =', JSON.stringify(doc.title));
    console.log('doc.documentURL =', String(doc.documentURL).slice(0, 60));
  } catch (e) {
    console.error('ОШИБКА:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
