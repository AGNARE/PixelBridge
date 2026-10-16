'use strict';
/**
 * Профилирование сборки в НАСТОЯЩЕЙ Figma через мост.
 *
 * Синтетические IR разного размера и разного состава. Цель — понять, что
 * именно съедает время: количество слоёв, текст, SVG или что-то ещё.
 *
 *   node test/profile-build.js
 */

const PORT = process.env.W2F_PORT || 7331;
const BASE = `http://127.0.0.1:${PORT}`;

const SVG_SMALL = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<circle cx="12" cy="12" r="10" fill="#f59e0b"/></svg>';

const SVG_LARGE = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
  Array.from({ length: 60 }, (_, i) =>
    `<rect x="${i % 10 * 12}" y="${Math.floor(i / 10) * 20}" width="10" height="18" rx="2" fill="hsl(${i * 6},70%,55%)"/>`
  ).join('') + '</svg>';

function frame(name, x, y, w, h, kids) {
  return {
    type: 'frame', tag: 'div', name, sel: 'div.' + name.replace(/\W/g, ''),
    box: { x, y, w, h },
    style: {
      display: 'block', position: 'static', overflow: 'visible', opacity: '1',
      'background-color': '#e0e7ff',
      'border-top-left-radius': '6px', 'border-top-right-radius': '6px',
      'border-bottom-right-radius': '6px', 'border-bottom-left-radius': '6px',
      'border-top-width': '0px', 'border-right-width': '0px',
      'border-bottom-width': '0px', 'border-left-width': '0px',
      'border-top-style': 'none', 'box-shadow': 'none',
      'background-image': 'none',
    },
    children: kids || [],
  };
}

function text(name, x, y, w, h, body) {
  return {
    type: 'text', tag: 'p', name, sel: 'p.' + name.replace(/\W/g, ''),
    box: { x, y, w, h },
    text: body,
    style: {
      display: 'block', position: 'static', opacity: '1',
      'font-family': 'Inter, sans-serif', 'font-size': '14px', 'font-weight': '400',
      'font-style': 'normal', 'line-height': '20px', 'letter-spacing': 'normal',
      'text-align': 'left', color: '#0f172a',
      'white-space': 'normal',
    },
    children: [],
  };
}

function textWithRuns(name, x, y, w, h) {
  const t = text(name, x, y, w, h, 'Обычный текст и жирный кусок и красный кусок');
  t.runs = [
    { text: 'Обычный текст и ', style: { 'font-family': 'Inter, sans-serif', 'font-weight': '400', 'font-size': '14px', color: '#0f172a' } },
    { text: 'жирный кусок', style: { 'font-family': 'Inter, sans-serif', 'font-weight': '700', 'font-size': '14px', color: '#0f172a' } },
    { text: ' и ', style: { 'font-family': 'Inter, sans-serif', 'font-weight': '400', 'font-size': '14px', color: '#0f172a' } },
    { text: 'красный кусок', style: { 'font-family': 'Inter, sans-serif', 'font-weight': '400', 'font-size': '14px', color: '#dc2626' } },
  ];
  t.text = t.runs.map((r) => r.text).join('');
  return t;
}

function svgNode(name, x, y, w, h, markup) {
  return {
    type: 'svg', tag: 'svg', name, sel: 'svg.' + name.replace(/\W/g, ''),
    box: { x, y, w, h }, svg: markup,
    style: { display: 'block', position: 'static', opacity: '1', overflow: 'visible' },
    children: [],
  };
}

function buildIr(kind, n, opts) {
  const o = opts || {};
  const cols = Math.max(1, Math.floor(Math.sqrt(n)));
  const cell = 60;
  const gap = 10;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * (cell + gap);
    const y = Math.floor(i / cols) * (cell + gap);
    const name = `${kind}-${i}`;
    if (kind === 'frames') nodes.push(frame(name, x, y, cell, 40));
    else if (kind === 'texts') nodes.push(text(name, x, y, cell * 2, 20, 'Строка текста номер ' + i));
    else if (kind === 'runs') nodes.push(textWithRuns(name, x, y, cell * 3, 20));
    else if (kind === 'svg') nodes.push(svgNode(name, x, y, 24, 24, o.bigSvg ? SVG_LARGE : SVG_SMALL));
  }
  const W = cols * (cell + gap) * (kind === 'texts' ? 2 : kind === 'runs' ? 3 : 1);
  const H = Math.ceil(n / cols) * (cell + gap);
  return {
    url: 'profile://' + kind,
    title: `Профиль ${kind} × ${n}`,
    viewport: { w: Math.max(W, 400), h: Math.max(H, 400) },
    content: { w: Math.max(W, 400), h: Math.max(H, 400) },
    root: {
      type: 'frame', tag: 'html', name: 'html', sel: 'html',
      box: { x: 0, y: 0, w: Math.max(W, 400), h: Math.max(H, 400) },
      style: { display: 'block', position: 'static', opacity: '1', 'background-color': '#f8fafc' },
      children: nodes,
    },
    assets: [],
    stats: { emitted: n + 1 },
    warnings: [],
  };
}

async function run(kind, n, opts, timeoutMs) {
  const ir = buildIr(kind, n, opts);
  const t0 = Date.now();
  let out;
  try {
    const res = await fetch(BASE + '/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ir,
        timeoutMs: timeoutMs || undefined,
        options: { autoLayout: 'off', addAnnotations: false, addPluginData: false },
      }),
    });
    out = await res.json();
  } catch (e) {
    return { kind, n, ms: Date.now() - t0, error: String(e.message || e) };
  }
  const ms = Date.now() - t0;
  if (!out.ok) return { kind, n, ms, error: out.error };
  return { kind, n, ms, stats: out.result && out.result.report ? out.result.report.stats : null };
}

(async () => {
  const health = await (await fetch(BASE + '/health')).json();
  console.log(`Плагин подключён: ${health.plugin}`);
  if (!health.plugin) {
    console.log('Нужно открыть плагин в Figma.');
    process.exit(1);
  }

  // Режим одного замера: node test/profile-build.js frames 400 900000
  if (process.argv[2] && process.argv[3]) {
    const kind = process.argv[2];
    const n = parseInt(process.argv[3], 10);
    const timeoutMs = parseInt(process.argv[4], 10) || 300000;
    const bigSvg = process.argv.includes('--big-svg');
    console.log(`Один замер: ${kind} × ${n}, таймаут ${timeoutMs / 1000} с`);
    const t0 = Date.now();
    const r = await run(kind, n, { bigSvg }, timeoutMs);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.error) console.log(`  ОШИБКА за ${sec} с: ${r.error}`);
    else console.log(`  ГОТОВО за ${sec} с (${(r.ms / n).toFixed(1)} мс/слой), слоёв ${r.stats ? r.stats.frames + r.stats.texts + r.stats.images + r.stats.svgs : '?'}`);
    process.exit(r.error ? 1 : 0);
  }

  console.log(`\n${'состав'.padEnd(16)} ${'слоёв'.padStart(6)} ${'время'.padStart(9)} ${'мс/слой'.padStart(9)}  примечание`);
  console.log('-'.repeat(74));

  const plan = [
    ['frames', 25, {}],
    ['frames', 100, {}],
    ['frames', 400, {}],
    ['texts', 25, {}],
    ['texts', 100, {}],
    ['texts', 400, {}],
    ['runs', 100, {}],
    ['svg', 25, {}],
    ['svg', 100, {}],
    ['svg', 25, { bigSvg: true }],
  ];

  for (const [kind, n, opts] of plan) {
    const r = await run(kind, n, opts);
    const note = opts.bigSvg ? 'крупная SVG-разметка' : (r.error ? 'ОШИБКА: ' + r.error.slice(0, 40) : '');
    const per = r.error ? '—' : (r.ms / n).toFixed(1);
    console.log(`${(kind + (opts.bigSvg ? '-big' : '')).padEnd(16)} ${String(n).padStart(6)} ` +
      `${String(r.ms + ' мс').padStart(9)} ${String(per).padStart(9)}  ${note}`);
  }

  console.log('\nГотово.');
  process.exit(0);
})().catch((e) => {
  console.error('ОШИБКА:', e && e.stack || e);
  process.exit(1);
});
