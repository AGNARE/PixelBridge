'use strict';
/**
 * DOMSnapshot → компактное дерево IR (Intermediate Representation).
 *
 * IR — единый формат для обоих источников:
 *   • захват веб-страницы (этот файл)
 *   • дизайн, который строит агент через /api/build
 * Дальше IR одинаково превращается в слои Figma плагином (code.js).
 *
 * ФАКТЫ О ФОРМАТЕ (проверено эмпирически, test/dump-snapshot.js):
 *   • layout.styles — массив ТОЛЬКО ЗНАЧЕНИЙ, позиционно, в порядке COMPUTED_STYLES. Имён нет.
 *   • layout.bounds — border box [x, y, w, h] в координатах документа.
 *   • у одного узла может быть НЕСКОЛЬКО записей layout (::after — бокс + текст).
 *   • documentURL / title — индексы в таблице строк, а не строки.
 *   • узлы без записи в layout не отрисованы (display:none) → пропускаем.
 *   • псевдоэлементы ::before/::after присутствуют как обычные узлы.
 *   • paintOrders — глобальный порядок отрисовки; им и сортируем слои.
 */

/** Запрашиваемые computed styles. ПОРЯДОК ВАЖЕН: он же порядок значений в layout.styles. */
const COMPUTED_STYLES = [
  // Бокс и позиционирование
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'box-sizing', 'overflow', 'overflow-x', 'overflow-y', 'visibility', 'opacity',
  'transform', 'transform-origin', 'vertical-align',
  // Flex
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'justify-content', 'align-items', 'align-content', 'align-self',
  'gap', 'row-gap', 'column-gap', 'order',
  // Grid
  'grid-template-columns', 'grid-template-rows', 'grid-auto-flow',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  // Фон
  'background-color', 'background-image', 'background-size', 'background-position',
  'background-repeat', 'background-clip', 'background-origin',
  // Границы
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow',
  // Текст
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-decoration-line',
  'text-transform', 'white-space', 'text-overflow', 'text-shadow',
  'color', 'direction', '-webkit-text-stroke-width', '-webkit-text-stroke-color',
  // Эффекты
  'filter', 'backdrop-filter', 'mix-blend-mode',
  // Прочее
  'list-style-type', 'object-fit', 'object-position',
];

const SKIP_TAGS = new Set([
  'HEAD', 'META', 'TITLE', 'STYLE', 'SCRIPT', 'LINK', 'BASE', 'NOSCRIPT',
  'TEMPLATE', 'COL', 'COLGROUP', 'SOURCE', 'TRACK',
]);

/** Инлайновые теги: их текст можно склеивать в один текстовый слой. */
const INLINE_TAGS = new Set([
  'SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'U', 'SMALL', 'CODE', 'SUP', 'SUB', 'MARK',
  'ABBR', 'CITE', 'Q', 'S', 'DEL', 'INS', 'VAR', 'KBD', 'SAMP', 'LABEL', 'TIME',
  'BDI', 'BDO', 'FONT', 'BIG', 'TT', 'STRIKE', 'ACRONYM', 'RUBY', 'RT', 'RP', 'WBR',
]);

const TEXT_PROPS = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'line-height', 'text-decoration-line', 'text-transform',
  'word-spacing', 'text-shadow',
];

const MAX_RUNS = 600;

// ---------------------------------------------------------------------------
// Утилиты

function round2(v) { return Math.round(v * 100) / 100; }
function px(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

function parseAttrList(strings, arr) {
  const out = {};
  if (!arr) return out;
  for (let k = 0; k + 1 < arr.length; k += 2) {
    const name = strings[arr[k]];
    if (name === undefined) continue;
    out[name] = strings[arr[k + 1]];
  }
  return out;
}

function pickFromSrcset(srcset) {
  if (!srcset) return null;
  const parts = String(srcset).split(',').map((s) => s.trim()).filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const part of parts) {
    const m = /^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/.exec(part);
    if (!m) continue;
    const score = m[2] ? parseFloat(m[2]) : 1;
    if (score > bestScore) { bestScore = score; best = m[1]; }
  }
  return best;
}

function extractUrls(cssValue) {
  const urls = [];
  if (!cssValue) return urls;
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
  let m;
  while ((m = re.exec(cssValue)) !== null) {
    const u = (m[1] || m[2] || m[3] || '').trim();
    if (u) urls.push(u);
  }
  return urls;
}

function shortText(t, max = 34) {
  if (!t) return '';
  const s = String(t).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function semanticName(tag, attrs, text, pseudo) {
  let base;
  if (attrs.id) base = '#' + attrs.id;
  else if (attrs.class) {
    const cls = String(attrs.class).split(/\s+/).filter(Boolean).slice(0, 3).map((c) => '.' + c).join('');
    base = cls || tag.toLowerCase();
  } else {
    base = tag.toLowerCase();
  }
  if (pseudo) base += pseudo;
  const aria = shortText(attrs['aria-label'], 26);
  const t = aria || shortText(text, 30);
  if (t) base += ` «${t}»`;
  return base;
}

function buildSelector(tag, attrs) {
  if (attrs.id) return '#' + attrs.id;
  let sel = tag.toLowerCase();
  if (attrs.class) {
    const first = String(attrs.class).split(/\s+/).filter(Boolean)[0];
    if (first) sel += '.' + first;
  }
  return sel;
}

function normalizeText(t) {
  return String(t)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Собрать текст из рунов с корректным CSS-схлопыванием пробелов.
 * Перенос строки из <br> сохраняется как «\n» и не схлопывается.
 */
function assembleText(runs, containerStyle) {
  const pre = /pre/.test((containerStyle && containerStyle['white-space']) || '');
  let s = '';
  for (const r of runs) {
    if (r.br) { s += '\n'; continue; }
    const t = String(r.text == null ? '' : r.text);
    s += pre ? t.replace(/\u00a0/g, ' ') : t.replace(/[\t\n\r ]+/g, ' ');
  }
  // Схлопываем лишние переводы строк, но оставляем одиночные
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

const ATTR_WHITELIST = new Set([
  'alt', 'href', 'title', 'role', 'aria-label', 'placeholder', 'type',
  'value', 'name', 'for', 'target', 'rel', 'poster', 'aria-hidden', 'lang',
]);

function pruneAttrs(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class' || k === 'id' || k === 'style' || k === 'srcset' || k === 'src') continue;
    if (!ATTR_WHITELIST.has(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v).slice(0, 300);
  }
  return out;
}

function firstNote(attrs) {
  const candidates = [
    ['alt', 'Alt'],
    ['aria-label', 'ARIA'],
    ['title', 'Title'],
    ['placeholder', 'Placeholder'],
    ['href', 'Ссылка'],
  ];
  for (const [key, label] of candidates) {
    const v = attrs[key];
    if (v && String(v).trim()) return `${label}: ${shortText(v, 200)}`;
  }
  if (attrs.role) return `Роль: ${attrs.role}`;
  return null;
}

/** Content box: border box минус границы и padding. */
function contentBox(abs, style) {
  const bl = px(style['border-left-width']);
  const br = px(style['border-right-width']);
  const bt = px(style['border-top-width']);
  const bb = px(style['border-bottom-width']);
  const pl = px(style['padding-left']);
  const pr = px(style['padding-right']);
  const pt = px(style['padding-top']);
  const pb = px(style['padding-bottom']);
  return {
    x: round2(abs.x + bl + pl),
    y: round2(abs.y + bt + pt),
    w: round2(Math.max(0, abs.w - bl - br - pl - pr)),
    h: round2(Math.max(0, abs.h - bt - bb - pt - pb)),
  };
}

// ---------------------------------------------------------------------------

function serializeSnapshot(snap, opts = {}) {
  const styleNames = opts.styleNames || COMPUTED_STYLES;
  const doc = snap.documents[0];
  if (!doc) throw new Error('В снапшоте нет документа');
  const strings = snap.strings || [];
  const S = (i) => (i === undefined || i === null || i < 0 ? undefined : strings[i]);

  const n = doc.nodes;
  const L = doc.layout;
  const total = n.nodeType.length;

  // --- 1. Дети по индексам узлов ---
  const childrenOf = new Map();
  for (let i = 0; i < total; i++) {
    const p = n.parentIndex[i];
    if (p === undefined || p < 0) continue;
    let arr = childrenOf.get(p);
    if (!arr) { arr = []; childrenOf.set(p, arr); }
    arr.push(i);
  }

  // --- 2. Записи layout по индексу узла (может быть несколько) ---
  const layoutByNode = new Map();
  for (let i = 0; i < L.nodeIndex.length; i++) {
    const ni = L.nodeIndex[i];
    let arr = layoutByNode.get(ni);
    if (!arr) { arr = []; layoutByNode.set(ni, arr); }
    arr.push(i);
  }

  const attrsCache = new Map();
  function attrsOf(i) {
    let a = attrsCache.get(i);
    if (a === undefined) { a = parseAttrList(strings, n.attributes[i]); attrsCache.set(i, a); }
    return a;
  }

  const styleCache = new Map();
  function styleOf(layoutIdx) {
    let s = styleCache.get(layoutIdx);
    if (s) return s;
    const arr = L.styles[layoutIdx] || [];
    s = {};
    for (let k = 0; k < styleNames.length; k++) {
      const v = S(arr[k]);
      if (v !== undefined && v !== null && v !== '') s[styleNames[k]] = v;
    }
    styleCache.set(layoutIdx, s);
    return s;
  }

  const boundsOf = (layoutIdx) => {
    const b = L.bounds[layoutIdx] || [0, 0, 0, 0];
    return { x: b[0] || 0, y: b[1] || 0, w: Math.max(0, b[2] || 0), h: Math.max(0, b[3] || 0) };
  };

  const paintOrderCache = new Map();
  function paintOrderOf(nodeIdx) {
    let v = paintOrderCache.get(nodeIdx);
    if (v !== undefined) return v;
    const lays = layoutByNode.get(nodeIdx);
    v = lays && L.paintOrders ? (L.paintOrders[lays[0]] ?? 0) : 0;
    paintOrderCache.set(nodeIdx, v);
    return v;
  }

  // --- Ассеты ---
  const assets = [];
  const assetSeen = new Map();
  function addAsset(url, kind) {
    let id = assetSeen.get(url);
    if (id === undefined) {
      id = 'a' + assetSeen.size;
      assetSeen.set(url, id);
      assets.push({ id, url, kind });
    }
    return id;
  }
  function resolveUrl(u) {
    if (!u) return null;
    if (/^data:/i.test(u)) return u;
    try { return new URL(u, opts.baseUrl || '').href; } catch { return u; }
  }
  function assetRef(rawUrl, kind) {
    const abs = resolveUrl(rawUrl);
    if (!abs) return null;
    if (/^data:/i.test(abs)) return { inline: abs };
    return { id: addAsset(abs, kind) };
  }

  const stats = {
    scanned: 0, emitted: 0, texts: 0, images: 0, svgs: 0,
    frames: 0, skippedHidden: 0, skippedEmpty: 0, pseudo: 0, maxDepth: 0,
  };
  const warnings = [];
  const warningSeen = new Set();
  const warn = (m) => { if (!warningSeen.has(m)) { warningSeen.add(m); warnings.push(m); } };

  const svgRefs = [];
  let flattenedCount = 0;

  /**
   * Действительные дети узла для отрисовки.
   *
   * Если у элемента нет собственного бокса в дереве раскладки — это не всегда
   * значит «не отрисован». Так выглядит `display: contents`: бокса нет, а дети
   * видны. Раньше такие поддеревья выбрасывались целиком, и на MDN пропадал
   * значок внутри `<figure>`. Поэтому здесь мы ПРОВАЛИВАЕМСЯ внутрь.
   */
  function effectiveChildren(nodeIdx) {
    const acc = [];
    const push = (parent) => {
      for (const k of childrenOf.get(parent) || []) {
        const kt = n.nodeType[k];
        if (kt === 3) {
          if (layoutByNode.has(k)) acc.push(k);
          continue;
        }
        if (kt !== 1) continue;
        const kTag = (S(n.nodeName[k]) || '').toUpperCase();
        if (SKIP_TAGS.has(kTag)) continue;
        if (layoutByNode.has(k)) { acc.push(k); continue; }
        flattenedCount++;
        push(k);
      }
    };
    push(nodeIdx);
    return acc;
  }

  // --- Группировка детей: руны текста ↔ полноценные узлы ---
  /**
   * @returns {Array<{kind:'runs', runs:Array, box:object} | {kind:'node', nodeIdx:number}>}
   */
  function groupChildren(nodeIdx) {
    const kids = effectiveChildren(nodeIdx);
    const groups = [];
    let current = null;

    const open = (srcIdx) => {
      current = { kind: 'runs', runs: [], srcIdx };
      return current;
    };
    const flush = () => {
      if (current && current.runs.length) groups.push(current);
      current = null;
    };

    for (const k of kids) {
      const kt = n.nodeType[k];
      const kLays = layoutByNode.get(k);

      if (kt === 3) {
        if (!kLays) continue;
        const g = current || open(k);
        for (const li of kLays) {
          const t = S(L.text[li]);
          if (t === undefined || t === null) continue;
          g.runs.push({ text: String(t), style: null, box: boundsOf(li) });
        }
        continue;
      }
      if (kt !== 1) continue;

      const kTag = S(n.nodeName[k]) || '';
      const kTagU = kTag.toUpperCase();
      if (SKIP_TAGS.has(kTagU)) continue;
      if (!kLays) continue; // не отрисован (display:none)

      if (kTagU === 'BR') {
        const g = current || open(k);
        g.runs.push({ text: '\n', style: null, br: true, box: boundsOf(kLays[0]) });
        continue;
      }

      const kStyle = styleOf(kLays[0]);
      if (isMergeableInline(kTagU, kStyle)) {
        const g = current || open(k);
        collectRuns(k, kStyle, g.runs);
        continue;
      }

      flush();
      groups.push({ kind: 'node', nodeIdx: k, srcIdx: k });
    }
    flush();
    return groups;
  }

  /**
   * Группировка без склейки — для flex/grid контейнеров,
   * где каждый текстовый узел является отдельным флекс-элементом.
   */
  function groupChildrenDirect(nodeIdx) {
    const groups = [];
    for (const k of effectiveChildren(nodeIdx)) {
      const kt = n.nodeType[k];
      const kLays = layoutByNode.get(k);
      if (!kLays) continue;
      if (kt === 3) {
        const runs = [];
        for (const li of kLays) {
          const t = S(L.text[li]);
          if (t === undefined || t === null) continue;
          runs.push({ text: String(t), style: null, box: boundsOf(li) });
        }
        if (runs.length) groups.push({ kind: 'runs', runs, srcIdx: k });
        continue;
      }
      if (kt !== 1) continue;
      const kTag = S(n.nodeName[k]) || '';
      const kTagU = kTag.toUpperCase();
      if (SKIP_TAGS.has(kTagU)) continue;
      if (kTagU === 'BR') {
        groups.push({ kind: 'runs', runs: [{ text: '\n', br: true, box: boundsOf(kLays[0]) }], srcIdx: k });
        continue;
      }
      groups.push({ kind: 'node', nodeIdx: k, srcIdx: k });
    }
    return groups;
  }

  function isMergeableInline(tag, style) {
    if (!INLINE_TAGS.has(tag)) return false;
    if (style.display !== 'inline') return false;
    if (style.position && style.position !== 'static') return false;
    if (style.float && style.float !== 'none') return false;
    if (style.transform && style.transform !== 'none') return false;
    if (style.opacity !== undefined && parseFloat(style.opacity) < 1) return false;
    const bg = style['background-color'];
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return false;
    const bgi = style['background-image'];
    if (bgi && bgi !== 'none') return false;
    return true;
  }

  function collectRuns(nodeIdx, inheritedStyle, out) {
    if (out.length > MAX_RUNS) return;
    const kt = n.nodeType[nodeIdx];
    const lays = layoutByNode.get(nodeIdx);

    if (kt === 3) {
      if (!lays) return;
      for (const li of lays) {
        const t = S(L.text[li]);
        if (t === undefined || t === null) continue;
        out.push({ text: String(t), style: inheritedStyle, box: boundsOf(li) });
      }
      return;
    }
    if (kt !== 1 || !lays) return;

    const tag = S(n.nodeName[nodeIdx]) || '';
    const tagU = tag.toUpperCase();
    if (SKIP_TAGS.has(tagU)) return;
    if (tagU === 'BR') {
      out.push({ text: '\n', style: inheritedStyle, br: true, box: boundsOf(lays[0]) });
      return;
    }

    const own = styleOf(lays[0]);
    const style = Object.assign({}, inheritedStyle);
    for (const p of TEXT_PROPS) if (own[p] !== undefined) style[p] = own[p];

    for (const k of childrenOf.get(nodeIdx) || []) collectRuns(k, style, out);
  }

  /**
   * Объединяющий бокс для группы рунов.
   *
   * ВАЖНО: пробельные руны и вырожденные боксы [0,0,0,0] исключаются.
   * У пробельного текстового узла нет «чернил», а его бокс в Chrome бывает
   * нулевым — и тогда он растягивает объединение до начала координат документа.
   * Именно это ломало слои на example.com.
   */
  function unionBox(runs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let any = false;
    for (const r of runs) {
      if (!r.box) continue;
      const b = r.box;
      if (b.w === 0 && b.h === 0) continue;
      if (!r.br && String(r.text == null ? '' : r.text).trim() === '') continue;
      any = true;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    if (!any || !Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  /**
   * Полный путь-селектор от корня. Уникален, годится для querySelector
   * и для трассировки слоя обратно в код.
   */
  function pathSelector(nodeIdx, tag, attrs, parentPath) {
    if (attrs.id) return '#' + attrs.id;
    const ownTag = tag.toLowerCase();
    let own = ownTag;
    const firstClass = attrs.class ? String(attrs.class).split(/\s+/).filter(Boolean)[0] : null;
    if (firstClass) own += '.' + firstClass;

    // Если среди братьев есть такой же — уточняем позицией
    const p = n.parentIndex[nodeIdx];
    const sibs = (childrenOf.get(p) || []).filter((s) => n.nodeType[s] === 1);
    let same = 0;
    for (const s of sibs) {
      const sTag = (S(n.nodeName[s]) || '').toLowerCase();
      if (sTag !== ownTag) continue;
      const sAttrs = attrsOf(s);
      const sClass = sAttrs.class ? String(sAttrs.class).split(/\s+/).filter(Boolean)[0] || null : null;
      if (sClass === firstClass) same++;
    }
    if (same > 1) {
      let k = 0;
      for (const s of sibs) {
        if (n.nodeType[s] !== 1) continue;
        k++;
        if (s === nodeIdx) break;
      }
      own += `:nth-child(${k})`;
    }
    return parentPath ? `${parentPath} > ${own}` : own;
  }

  // -----------------------------------------------------------------------

  function buildNode(nodeIdx, parentAbs, depth, parentStyle, parentPath) {
    stats.scanned++;
    if (n.nodeType[nodeIdx] !== 1) return null;

    const tag = S(n.nodeName[nodeIdx]) || '';
    // nodeName у HTML-элементов в ВЕРХНЕМ регистре, а у SVG — в нижнем.
    // Поэтому все сравнения тегов идут по tagUpper.
    const tagUpper = tag.toUpperCase();
    if (SKIP_TAGS.has(tagUpper)) return null;

    const isPseudo = tag.startsWith('::');
    if (isPseudo) stats.pseudo++;

    const lays = layoutByNode.get(nodeIdx);
    if (!lays || !lays.length) { stats.skippedHidden++; return null; }

    const li = lays[0];
    const abs = boundsOf(li);
    const style = styleOf(li);

    if (style.visibility === 'hidden') { stats.skippedHidden++; return null; }
    const opacity = style.opacity === undefined ? 1 : parseFloat(style.opacity);
    if (!(opacity > 0)) { stats.skippedHidden++; return null; }

    const attrs = attrsOf(nodeIdx);
    const selPath = pathSelector(nodeIdx, tag, attrs, parentPath);

    // Текст псевдоэлемента лежит во второй записи layout
    let pseudoText = null;
    let pseudoTextBox = null;
    if (isPseudo && lays.length > 1) {
      for (let k = 1; k < lays.length; k++) {
        const t = S(L.text[lays[k]]);
        if (t) { pseudoText = String(t); pseudoTextBox = boundsOf(lays[k]); break; }
      }
    }

    const isImg = tagUpper === 'IMG';
    const isSvg = tagUpper === 'SVG';
    const isInput = tagUpper === 'INPUT' || tagUpper === 'TEXTAREA' || tagUpper === 'SELECT';
    const display = style.display || 'block';
    const isFlexGrid = /flex|grid/.test(display) && display !== 'inline';

    // --- Группировка содержимого ---
    let groups = [];
    if (!isImg && !isSvg && !isInput) {
      groups = (display === 'contents' || isFlexGrid)
        ? groupChildrenDirect(nodeIdx)
        : groupChildren(nodeIdx);
    }

    const runGroups = groups.filter((g) => g.kind === 'runs');
    const soleRuns = groups.length === 1 && runGroups.length === 1 ? runGroups[0] : null;

    // --- Тип слоя ---
    let type;
    if (isImg) type = 'image';
    else if (isSvg) type = 'svg';
    else if (isInput) type = 'input';
    else if (soleRuns && !pseudoText) type = 'text';
    else if (isPseudo && pseudoText) type = 'text';
    else type = 'frame';

    // --- Ассеты ---
    let imgRef = null;
    if (isImg) {
      // capture.js заранее перезаписывает атрибут src значением currentSrc,
      // поэтому здесь достаточно attrs.src (+ srcset как запасной вариант).
      const src = attrs.src || pickFromSrcset(attrs.srcset);
      imgRef = assetRef(src, 'img');
      stats.images++;
    }
    let bgRef = null;
    const bgUrls = extractUrls(style['background-image']);
    if (bgUrls.length) bgRef = assetRef(bgUrls[0], 'bg');

    // --- Бокс слоя ---
    let box;
    let boxExtra = null;
    let textContent = null;
    let runsOut = null;

    if (type === 'text') {
      const source = soleRuns || runGroups[0] || null;
      const runs = (pseudoText && !source)
        ? [{ text: pseudoText, style: null, box: pseudoTextBox || abs }]
        : source.runs;
      const joined = assembleText(runs, style);
      if (joined.trim() === '' && !runs.some((r) => r.br)) return null;

      textContent = joined;

      // ВАЖНО: всё считаем в абсолютных координатах, а в IR кладём относительные.
      const cAbs = contentBox(abs, style);
      const u = unionBox(runs);
      if (cAbs.w <= 0) {
        cAbs.x = u.x; cAbs.y = u.y; cAbs.w = u.w; cAbs.h = u.h;
      } else {
        // Контейнеры вроде <button> центрируют содержимое по вертикали —
        // подтягиваем текстовый слой к фактическому положению строки.
        const topGap = u.y - cAbs.y;
        const botGap = (cAbs.y + cAbs.h) - (u.y + u.h);
        if (topGap > 3 && Math.abs(topGap - botGap) < 3) {
          cAbs.y += topGap;
          cAbs.h = Math.max(0, cAbs.h - topGap * 2);
        }
      }
      box = {
        x: round2(cAbs.x - parentAbs.x),
        y: round2(cAbs.y - parentAbs.y),
        w: round2(cAbs.w),
        h: round2(cAbs.h),
      };
      if (box.w <= 0 || box.h <= 0) { stats.skippedEmpty++; return null; }

      // Текстовый слой в Figma не умеет padding. Если у элемента он есть,
      // сохраняем его border box отдельно — плагин обернёт текст во фрейм.
      // Без этого flex-раскладка считала бы размеры по content box и разъезжалась.
      const bboxAbs = {
        x: round2(abs.x - parentAbs.x),
        y: round2(abs.y - parentAbs.y),
        w: round2(abs.w),
        h: round2(abs.h),
      };
      if (Math.abs(bboxAbs.x - box.x) > 0.01 || Math.abs(bboxAbs.y - box.y) > 0.01 ||
          Math.abs(bboxAbs.w - box.w) > 0.01 || Math.abs(bboxAbs.h - box.h) > 0.01) {
        boxExtra = bboxAbs;
      }
      if (runs.length > 1 && runsAreStyled(runs, style)) {
        runsOut = compressRuns(runs, style);
      }
    } else {
      box = {
        x: round2(abs.x - parentAbs.x),
        y: round2(abs.y - parentAbs.y),
        w: round2(abs.w),
        h: round2(abs.h),
      };
      if (type === 'input') textContent = attrs.placeholder || attrs.value || '';
    }

    // --- Дети ---
    const children = [];
    if (type === 'frame') {
      for (const g of groups) {
        if (g.kind === 'node') {
          const child = buildNode(g.nodeIdx, abs, depth + 1, style, selPath);
          if (child) children.push({ node: child, po: paintOrderOf(g.nodeIdx), seq: g.srcIdx });
        } else {
          const synth = buildSyntheticText(g, abs, depth, style);
          if (synth) children.push({ node: synth, po: paintOrderOf(g.srcIdx), seq: g.srcIdx });
        }
      }
      children.sort((a, b) => (a.po !== b.po ? a.po - b.po : a.seq - b.seq));
    }

    // --- Пустой фрейм без оформления — мусор ---
    if (type === 'frame' && children.length === 0) {
      const hasBg = style['background-color'] && style['background-color'] !== 'rgba(0, 0, 0, 0)';
      const hasBgImg = style['background-image'] && style['background-image'] !== 'none';
      const hasBorder = (px(style['border-top-width']) + px(style['border-right-width']) +
                         px(style['border-bottom-width']) + px(style['border-left-width'])) > 0;
      const hasShadow = style['box-shadow'] && style['box-shadow'] !== 'none';
      const hasRadius = (px(style['border-top-left-radius']) + px(style['border-top-right-radius']) +
                         px(style['border-bottom-right-radius']) + px(style['border-bottom-left-radius'])) > 0;
      const hasSvg = type === 'svg';
      if (!hasBg && !hasBgImg && !hasBorder && !hasShadow && !hasRadius && !hasSvg) {
        stats.skippedEmpty++;
        return null;
      }
    }

    // --- Имя, описание, селектор ---
    // Для псевдоэлемента tag уже равен '::before' — второй раз не добавляем.
    const name = semanticName(tag, attrs, textContent || attrs.alt || attrs.placeholder || '',
      isPseudo ? '' : (attrs['aria-label'] ? '' : ''));

    stats.emitted++;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (type === 'text') stats.texts++;
    if (type === 'svg') stats.svgs++;
    if (type === 'frame') stats.frames++;

    const out = {
      type,
      tag: tag.toLowerCase(),
      name,
      sel: buildSelector(tag, attrs),
      selPath,
      box,
      style,
      children: children.map((c) => c.node),
    };
    if (attrs.id) out.domId = attrs.id;
    if (attrs.class) out.cls = String(attrs.class).slice(0, 200);
    const note = firstNote(attrs);
    if (note) out.note = note;
    if (isPseudo) out.pseudo = tag;
    const pattrs = pruneAttrs(attrs);
    if (Object.keys(pattrs).length) out.attrs = pattrs;
    if (imgRef) {
      if (imgRef.inline) out.inlineSrc = imgRef.inline;
      else out.src = imgRef.id;
    }
    if (bgRef) {
      if (bgRef.inline) out.inlineBgSrc = bgRef.inline;
      else out.bgSrc = bgRef.id;
    }
    if (textContent !== null) out.text = textContent;
    if (boxExtra) out.bbox = boxExtra;
    if (runsOut) out.runs = runsOut;
    if (type === 'input') {
      out.inputType = attrs.type || 'text';
      out.text = attrs.placeholder || attrs.value || '';
    }
    if (isSvg) {
      out._bid = n.backendNodeId[nodeIdx];
      svgRefs.push(out);
    }
    if (style.position === 'fixed' || style.position === 'sticky') {
      out.fixed = style.position === 'fixed';
      out.sticky = style.position === 'sticky';
      warn(`${style.position === 'sticky' ? 'Липкие' : 'Фиксированные'} элементы ` +
        '(шапки, модалки) уложены обычными слоями в общий поток.');
    }
    if (opacity < 1) out.opacity = opacity;
    if (isImg && !imgRef) warn('Найдены <img> без источника — оставлены пустые прямоугольники.');
    return out;
  }

  /** Текстовый слой из группы рунов внутри составного контейнера. */
  function buildSyntheticText(group, parentAbs, depth, parentStyle) {
    const runs = group.runs;
    const joined = assembleText(runs, parentStyle);
    if (joined.trim() === '' && !runs.some((r) => r.br)) return null;
    const u = unionBox(runs);
    const box = {
      x: round2(u.x - parentAbs.x),
      y: round2(u.y - parentAbs.y),
      w: round2(u.w),
      h: round2(u.h),
    };
    if (box.w <= 0 && box.h <= 0) return null; // пустой синтетический текст не нужен
    const style = {};
    for (const p of TEXT_PROPS) if (parentStyle[p] !== undefined) style[p] = parentStyle[p];
    // Стиль первого содержательного руна точнее стиля контейнера
    const first = runs.find((r) => r.style);
    if (first && first.style) Object.assign(style, first.style);

    stats.emitted++;
    stats.texts++;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    const out = {
      type: 'text',
      tag: 'text',
      name: semanticName('TEXT', {}, joined, ''),
      sel: ':text',
      box,
      style,
      text: joined,
      children: [],
    };
    if (runs.length > 1 && runsAreStyled(runs, style)) out.runs = compressRuns(runs, style);
    return out;
  }

  // -----------------------------------------------------------------------

  let htmlIdx = -1;
  for (let i = 0; i < total; i++) {
    if (n.nodeType[i] === 1 && (S(n.nodeName[i]) || '') === 'HTML') { htmlIdx = i; break; }
  }
  if (htmlIdx < 0) throw new Error('Не найден элемент <html> в снапшоте');

  const htmlLays = layoutByNode.get(htmlIdx);
  const rootAbs = { x: 0, y: 0 };
  if (htmlLays) {
    const b = boundsOf(htmlLays[0]);
    rootAbs.x = b.x;
    rootAbs.y = b.y;
  }

  const contentW = doc.contentWidth || (htmlLays ? boundsOf(htmlLays[0]).w : 0);
  const contentH = doc.contentHeight || (htmlLays ? boundsOf(htmlLays[0]).h : 0);

  const root = buildNode(htmlIdx, rootAbs, 0, {}, '');
  if (!root) throw new Error('Не удалось построить корневой слой');

  stats.scanned = total;
  stats.flattened = flattenedCount;

  const vpW = opts.viewportWidth || contentW;
  const vpH = opts.viewportHeight || 0;
  // Если страница короче экрана — берём высоту экрана, чтобы фон заполнился.
  // Если длиннее — полную высоту документа.
  const frameH = Math.max(contentH, vpH);

  return {
    url: opts.url || S(doc.documentURL) || '',
    title: S(doc.title) || '',
    viewport: { w: vpW, h: vpH },
    content: { w: round2(Math.max(contentW, vpW)), h: round2(frameH) },
    root,
    assets,
    stats,
    warnings,
    _svgRefs: svgRefs,
  };
}

// ---------------------------------------------------------------------------

function runsAreStyled(runs, baseStyle) {
  for (const r of runs) {
    if (!r.style) continue;
    if (r.style.color !== baseStyle.color) return true;
    if (r.style['font-weight'] !== baseStyle['font-weight']) return true;
    if (r.style['font-style'] !== baseStyle['font-style']) return true;
  }
  return false;
}

function runSignature(style) {
  if (!style) return '';
  return [
    style.color, style['font-weight'], style['font-style'], style['font-size'],
    style['font-family'], style['text-decoration-line'], style['letter-spacing'],
    style['text-transform'],
  ].join('|');
}

function pickRunStyle(style) {
  const o = {};
  if (!style) return o;
  for (const k of TEXT_PROPS) if (style[k] !== undefined) o[k] = style[k];
  return o;
}

function compressRuns(runs, baseStyle) {
  const out = [];
  for (const r of runs) {
    if (r.text === '') continue;
    const effective = r.style || baseStyle;
    const sig = runSignature(effective);
    const last = out[out.length - 1];
    if (last && last.sig === sig && !r.br) {
      last.text += r.text;
    } else {
      out.push({ text: r.text, sig, style: pickRunStyle(effective), br: !!r.br });
    }
  }
  return out.map((r) => {
    const o = { text: r.text };
    if (r.style && Object.keys(r.style).length) o.style = r.style;
    return o;
  });
}

module.exports = {
  COMPUTED_STYLES,
  serializeSnapshot,
  extractUrls,
  pickFromSrcset,
  parseAttrList,
  contentBox,
};
