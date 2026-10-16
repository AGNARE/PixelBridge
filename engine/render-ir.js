'use strict';
/**
 * IR → автономный HTML.
 *
 * Назначение — ПРОВЕРКА, а не продукт. Отрисовывая IR обратно и сравнивая
 * с исходной страницей, мы ловим то, чего не видят структурные тесты:
 * потерянные слои, неверный порядок наложения, сбитую прозрачность,
 * пропавшую обрезку.
 *
 * Всё позиционируется абсолютно по координатам из IR, поэтому геометрия
 * точна по построению, а расхождения указывают на смысловые потери.
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Свойства, которые НЕ переносим: раскладку задаёт абсолютное
 * позиционирование, и эти свойства ей противоречат.
 */
const SKIP = new Set([
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'justify-content', 'align-items', 'align-content', 'align-self',
  'gap', 'row-gap', 'column-gap', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-flow',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  'float', 'clear', 'z-index', 'box-sizing', 'vertical-align',
  'transform-origin', 'list-style-type', 'direction',
]);

const TEXT_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
  'text-decoration-line', 'text-overflow', 'color', 'text-shadow',
];

function cssDecls(style, extra) {
  const out = [];
  for (const [k, v] of Object.entries(style || {})) {
    if (SKIP.has(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    out.push(`${k}:${v}`);
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined && v !== null && v !== '') out.push(`${k}:${v}`);
  }
  return out.join(';');
}

/**
 * Смещение начала координат для абсолютно позиционированных детей.
 *
 * Содержащий блок — это PADDING BOX предка, а его левый край отстоит от
 * border box ровно на ширину границы. Padding сюда НЕ входит: он находится
 * внутри padding box. Ошибка здесь накапливается на каждом вложенном
 * отступе и уводит весь макет — именно это и показал визуальный тест.
 */
function containingInset(style) {
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  return {
    x: px((style || {})['border-left-width']),
    y: px((style || {})['border-top-width']),
  };
}

/** Цвет фона полотна: в CSS фон body переходит на canvas, если у html его нет. */
function canvasBackground(ir) {
  const transparent = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  const rootBg = ir.root && ir.root.style ? ir.root.style['background-color'] : null;
  if (!transparent(rootBg)) return rootBg;
  const kids = (ir.root && ir.root.children) || [];
  for (const kid of kids) {
    const bg = kid.style ? kid.style['background-color'] : null;
    if (!transparent(bg)) return bg;
  }
  return '#ffffff';
}

/**
 * @param {object} ir результат захвата
 * @param {object} opts
 * @param {(id:string)=>string} opts.assetUrl как получить URL картинки по ссылке IR
 */
function renderIr(ir, opts) {
  const options = opts || {};
  const assetUrl = options.assetUrl || ((id) => id);
  const content = ir.content || { w: 1440, h: 900 };

  function renderNode(node, parentInset) {
    const style = node.style || {};
    const box = node.box || { x: 0, y: 0, w: 0, h: 0 };
    const left = round(box.x - parentInset.x);
    const top = round(box.y - parentInset.y);
    const w = Math.max(0, round(box.w));
    const h = Math.max(0, round(box.h));
    const base = `position:absolute;left:${left}px;top:${top}px;`;

    if (node.type === 'text') {
      const textCss = { 'white-space': 'pre-wrap', 'overflow-wrap': 'break-word' };
      return `<div title="${esc(node.name)}" style="${base}width:${w}px;` +
        (h > 0 ? `min-height:${h}px;` : '') +
        cssDecls(style, textCss) + `">${esc(node.text || '')}</div>`;
    }

    if (node.type === 'image') {
      const url = node.inlineSrc || (node.src ? assetUrl(node.src) : '');
      const fit = style['object-fit'] || 'fill';
      const inner = url
        ? `<img src="${esc(url)}" style="width:100%;height:100%;object-fit:${esc(fit)};display:block">`
        : '';
      return `<div title="${esc(node.name)}" style="${base}width:${w}px;height:${h}px;overflow:hidden;` +
        cssDecls(style, null) + `">${inner}</div>`;
    }

    if (node.type === 'svg' && node.svg) {
      // Разметку SVG вставляем как есть, но снимаем жёсткие размеры
      const svg = String(node.svg).replace(
        /<svg([^>]*?)\swidth="[^"]*"([^>]*?)\sheight="[^"]*"/i, '<svg$1$2');
      return `<div title="${esc(node.name)}" style="${base}width:${w}px;height:${h}px;` +
        cssDecls(style, null) + `">` +
        `<div style="width:100%;height:100%">${svg}</div></div>`;
    }

    const inset = containingInset(style);
    const kids = (node.children || []).map((c) => renderNode(c, inset)).join('');
    const clip = /hidden|clip/.test(style.overflow || '') ||
      /hidden|clip/.test(style['overflow-x'] || '') ||
      /hidden|clip/.test(style['overflow-y'] || '');
    // Фоновую картинку тоже переводим на локальный источник: в IR лежит
    // исходный CSS url(), и он может не загрузиться или упереться в hotlink.
    const bgOverride = {};
    if (node.bgSrc) bgOverride['background-image'] = `url("${assetUrl(node.bgSrc)}")`;
    else if (node.inlineBgSrc) bgOverride['background-image'] = `url("${node.inlineBgSrc}")`;
    return `<div title="${esc(node.name)}" style="${base}width:${w}px;height:${h}px;` +
      (clip ? 'overflow:hidden;' : '') +
      cssDecls(style, bgOverride) + `">${kids}</div>`;
  }

  const body = ir.root ? renderNode(ir.root, { x: 0, y: 0 }) : '';
  const canvas = canvasBackground(ir);
  // Правила @font-face страницы: без них сравнение покажет разницу шрифтов,
  // а не разницу макета.
  const fonts = ir.fontCss ? `\n${ir.fontCss}\n` : '';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<style>${fonts}
  html,body{margin:0;padding:0;background:${esc(canvas)}}
  body{position:relative;width:${round(content.w)}px;height:${round(content.h)}px;overflow:hidden}
  *{box-sizing:border-box}
  div,img{min-width:0}
</style></head>
<body>${body}</body></html>`;
}

function round(v) { return Math.round(v * 100) / 100; }

module.exports = { renderIr };
