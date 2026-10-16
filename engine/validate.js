'use strict';
/**
 * Валидатор IR. Ловит класс ошибок, который иначе ищется глазами на каждом сайте:
 * вырожденные боксы, слои вне родителя, мусор в тексте, потерянные ассеты.
 *
 * Используется в тестах и в отчёте движка.
 */

const ISSUE_LIMITS = { error: 40, warn: 40 };

function validateIR(ir, opts = {}) {
  const issues = [];
  const add = (level, code, message, path) => {
    issues.push({ level, code, message, path });
  };

  const CLIPS = /hidden|auto|scroll|clip/;
  const hasBox = (s) => !!s && ((s['background-color'] && s['background-color'] !== 'rgba(0, 0, 0, 0)') ||
    (s['background-image'] && s['background-image'] !== 'none') ||
    (parseFloat(s['border-top-width']) || 0) + (parseFloat(s['border-right-width']) || 0) +
    (parseFloat(s['border-bottom-width']) || 0) + (parseFloat(s['border-left-width']) || 0) > 0 ||
    (s['box-shadow'] && s['box-shadow'] !== 'none') ||
    (parseFloat(s['border-top-left-radius']) || 0) > 0);

  const assetIds = new Set((ir.assets || []).map((a) => a.id));
  let nodeCount = 0;
  let depthMax = 0;

  function walk(node, absX, absY, path, depth, parentAbs, parentStyle, ancestorClips) {
    nodeCount++;
    depthMax = Math.max(depthMax, depth);
    // Для отчёта берём точный CSS-путь слоя, а не длинную цепочку имён
    const here = node.selPath || node.sel || (path ? `${path} > ${node.name}` : node.name);
    const b = node.box || { x: 0, y: 0, w: 0, h: 0 };

    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.w) || !Number.isFinite(b.h)) {
      add('error', 'nan-box', `Нечисловой бокс: ${JSON.stringify(b)}`, here);
      return;
    }
    if (b.w < 0 || b.h < 0) {
      add('error', 'negative-box', `Отрицательный размер ${b.w}×${b.h}`, here);
    }
    if (b.w === 0 && b.h === 0) {
      add('error', 'zero-box', 'Нулевой бокс — слой невидим', here);
    }
    if (node.type === 'text') {
      if (b.w <= 0 || b.h <= 0) {
        add('error', 'text-zero', `Текстовый слой без площади ${b.w}×${b.h}`, here);
      }
      const t = node.text || '';
      if (/^ | $/.test(t)) add('warn', 'text-space', `Пробел по краям текста: ${JSON.stringify(t.slice(0, 40))}`, here);
      if (/  /.test(t)) add('warn', 'text-double-space', 'Двойной пробел в тексте', here);
      if (/\n /.test(t)) add('warn', 'text-space-after-nl', 'Пробел сразу после переноса строки', here);
    }
    if (node.type === 'frame' && b.w > 0 && b.h > 0) {
      if (!hasBox(node.style) && node.children.length === 0) {
        add('warn', 'empty-frame', 'Пустой фрейм без оформления и детей', here);
      }
    }
    if (node.type === 'image') {
      if (!node.src && !node.inlineSrc) {
        add('warn', 'image-no-src', 'Картинка без источника', here);
      } else if (node.src && !assetIds.has(node.src)) {
        add('error', 'image-missing-asset', `Ссылка на несуществующий ассет ${node.src}`, here);
      }
    }
    if (node.type === 'svg' && !node.svg) {
      add('warn', 'svg-no-markup', 'SVG без разметки — будет пустой прямоугольник', here);
    }
    if (node.style) {
      const op = node.style.opacity;
      if (op !== undefined && op === '0') add('warn', 'opacity-zero', 'opacity: 0 — слой невидим', here);
    }

    // Клип учитывается у ЛЮБОГО предка: если где-то выше контейнер
    // обрезает содержимое, слой «вне родителя» — это нормальная прокрутка.
    const clipsSelf = CLIPS.test((node.style && node.style['overflow-x']) || '') ||
                      CLIPS.test((node.style && node.style['overflow-y']) || '');
    const clipped = ancestorClips || clipsSelf;

    // Слой целиком вне родителя — сигнал ошибки расчёта.
    // НО: выносные псевдоэлементы, абсолютное позиционирование и
    // прокручиваемые контейнеры дают то же самое легально — их исключаем.
    if (parentAbs && !clipped) {
      const st = node.style || {};
      const positioned = /absolute|fixed/.test(st.position || '');
      const pseudo = !!node.pseudo;
      const noOverlap = absX + b.w <= parentAbs.x || absX >= parentAbs.x + parentAbs.w ||
                        absY + b.h <= parentAbs.y || absY >= parentAbs.y + parentAbs.h;
      if (noOverlap && b.w > 0 && b.h > 0 && !positioned && !pseudo) {
        add('warn', 'outside-parent',
          `Слой вне родителя: слой [${absX.toFixed(1)},${absY.toFixed(1)} ${b.w.toFixed(1)}×${b.h.toFixed(1)}], ` +
          `родитель [${parentAbs.x.toFixed(1)},${parentAbs.y.toFixed(1)} ${parentAbs.w.toFixed(1)}×${parentAbs.h.toFixed(1)}]`, here);
      }
    }

    for (const c of node.children) {
      walk(c, absX + (c.box ? c.box.x : 0), absY + (c.box ? c.box.y : 0), here, depth + 1,
        { x: absX, y: absY, w: b.w, h: b.h }, node.style, clipped);
    }
  }

  if (!ir.root) {
    add('error', 'no-root', 'В IR нет корневого слоя', '');
  } else {
    walk(ir.root, ir.root.box.x, ir.root.box.y, '', 0, null);
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');

  return {
    ok: errors.length === 0,
    nodeCount,
    depthMax,
    errors,
    warns,
    counts: {
      error: errors.length,
      warn: warns.length,
      byCode: issues.reduce((acc, i) => {
        acc[i.code] = (acc[i.code] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

function formatReport(report, opts = {}) {
  const lines = [];
  lines.push(`Слоёв: ${report.nodeCount}, макс. глубина: ${report.depthMax}`);
  lines.push(`Ошибок: ${report.errors.length}, предупреждений: ${report.warns.length}`);
  if (Object.keys(report.counts.byCode).length) {
    lines.push('По кодам: ' + Object.entries(report.counts.byCode).map(([k, v]) => `${k}×${v}`).join(', '));
  }
  const limit = opts.limit || 25;
  for (const level of ['errors', 'warns']) {
    const list = report[level];
    if (!list.length) continue;
    lines.push(`\n--- ${level === 'errors' ? 'ОШИБКИ' : 'ПРЕДУПРЕЖДЕНИЯ'} (первые ${Math.min(limit, list.length)}) ---`);
    for (const i of list.slice(0, limit)) {
      lines.push(`  [${i.code}] ${i.message}\n      ${i.path}`);
    }
  }
  return lines.join('\n');
}

module.exports = { validateIR, formatReport, ISSUE_LIMITS };
