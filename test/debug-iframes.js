'use strict';
/** Если ли на F1 iframe-ы и баннер cookie, и где он живёт. */
const { Browser } = require('../engine/browser');
const { preparePage } = require('../engine/capture');
const { COMPUTED_STYLES } = require('../engine/serialize');

(async () => {
  const b = new Browser({ headless: true, profileMode: 'clean' });
  try {
    await b.launch();
    const page = await b.openPage('https://www.formula1.com/', { width: 1280, height: 900 });
    await preparePage(page, {});

    const snap = await page.send('DOMSnapshot.captureSnapshot', {
      computedStyles: COMPUTED_STYLES, includeDOMRects: true, includePaintOrder: true,
    });

    console.log('документов в снапшоте:', snap.documents.length);
    for (let i = 0; i < snap.documents.length; i++) {
      const d = snap.documents[i];
      console.log(`  [${i}] ${String(d.documentURL).slice(0, 90)}  узлов ${d.nodes.nodeType.length}`);
    }

    const doc = snap.documents[0];
    const S = (i) => snap.strings[i];
    let iframeNodes = 0;
    let withContentDoc = 0;
    for (let i = 0; i < doc.nodes.nodeType.length; i++) {
      const tag = doc.nodes.nodeName[i] !== undefined ? S(doc.nodes.nodeName[i]) : null;
      if (tag === 'IFRAME' || tag === 'FRAME') iframeNodes++;
    }
    const cdi = doc.nodes.contentDocumentIndex;
    if (cdi) withContentDoc = (cdi.index || []).length;
    console.log(`\nузлов <iframe> в дереве: ${iframeNodes}, с contentDocumentIndex: ${withContentDoc}`);

    const cookieInMain = snap.strings.filter((s) => s && /non-essential.*cookies/i.test(s)).length;
    console.log('строка про non-essential cookies в главном документе:', cookieInMain);

    // Есть ли iframe с баннером в живом DOM
    const frames = await page.evaluate(() => {
      const out = [];
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        const r = f.getBoundingClientRect();
        out.push({
          src: (f.getAttribute('src') || '').slice(0, 70),
          w: Math.round(r.width), h: Math.round(r.height),
          x: Math.round(r.x), y: Math.round(r.y),
        });
      }
      return out;
    });
    console.log('\n=== iframe в живом DOM ===');
    for (const f of frames.slice(0, 10)) console.log(`  ${f.w}×${f.h} at ${f.x},${f.y}  ${f.src}`);

    const banner = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      const info = [];
      let cur = el;
      let depth = 0;
      while (cur && depth++ < 8) {
        info.push(`${cur.tagName}${cur.className ? '.' + String(cur.className).split(' ')[0].slice(0, 40) : ''}`);
        cur = cur.parentElement;
      }
      return info;
    });
    console.log('\n=== что в центре экрана ===');
    console.log('  ' + banner.join('  ←  '));
  } catch (e) {
    console.error('ОШИБКА:', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
