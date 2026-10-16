'use strict';
/**
 * Web → Figma Bridge — плагин Figma (главный поток, без DOM).
 *
 * Получает от UI нормализованное дерево IR и строит из него слои Figma.
 * Один и тот же путь используется и для захваченной веб-страницы,
 * и для дизайна, который строит агент через /api/build. Это и есть
 * смысл единого формата IR.
 *
 * Файл намеренно самодостаточный: никакой сборки, никаких зависимостей.
 * В конце есть тестовый выход (module.exports), который в песочнице Figma
 * не выполняется, потому что там нет `module`.
 */

const PLUGIN_VERSION = '0.1.0';

/* ========================================================================
 * 1. РАЗБОР CSS-ЗНАЧЕНИЙ
 * ===================================================================== */

/** Именованные цвета нужны редко (Chrome нормализует их в rgb), но пусть будут. */
const CSS_NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], gray: [128, 128, 128], grey: [128, 128, 128],
  silver: [192, 192, 192], maroon: [128, 0, 0], olive: [128, 128, 0], lime: [0, 255, 0],
  aqua: [0, 255, 255], teal: [0, 128, 128], navy: [0, 0, 128], fuchsia: [255, 0, 255],
  purple: [128, 0, 128], orange: [255, 165, 0], pink: [255, 192, 203], brown: [165, 42, 42],
  gold: [255, 215, 0], indigo: [75, 0, 130], violet: [238, 130, 238], crimson: [220, 20, 60],
  transparent: [0, 0, 0, 0],
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** 'rgb(99 102 241 / 50%)' и 'rgba(99,102,241,.5)' и '#6366f1' → {r,g,b,a} */
function parseColor(input, current) {
  if (input === undefined || input === null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'currentcolor' || s === 'inherit' || s === 'initial') {
    return current || { r: 0, g: 0, b: 0, a: 1 };
  }

  let m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const raw = m[1].replace(/\//g, ' ').split(/[,\s]+/).filter(Boolean);
    if (raw.length < 3) return null;
    const ch = (t) => {
      if (t.endsWith('%')) return clamp(parseFloat(t) / 100, 0, 1);
      return clamp(parseFloat(t) / 255, 0, 1);
    };
    const a = raw[3] === undefined ? 1
      : (raw[3].endsWith('%') ? parseFloat(raw[3]) / 100 : parseFloat(raw[3]));
    const c = { r: ch(raw[0]), g: ch(raw[1]), b: ch(raw[2]), a: clamp(isNaN(a) ? 1 : a, 0, 1) };
    if ([c.r, c.g, c.b].some((v) => isNaN(v))) return null;
    return c;
  }

  m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    else if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
  }

  const named = CSS_NAMED[s];
  if (named) {
    return { r: named[0] / 255, g: named[1] / 255, b: named[2] / 255, a: named[3] === undefined ? 1 : named[3] / 255 };
  }
  return null;
}

/** Разбить строку по разделителю, игнорируя вложенные скобки. */
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === quote && str[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

function px(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

/** Числовые части CSS-значения: '10px 8px 24px 0px' → [10,8,24,0] */
function numbers(str) {
  const m = String(str || '').match(/-?\d*\.?\d+/g);
  return m ? m.map(Number) : [];
}

/* ---------------------------- Тени ---------------------------- */

/**
 * CSS box-shadow → эффекты Figma.
 * blurScale: 1 — радиус как в CSS, 0.5 — половина (Figma визуально
 * расширяет тень сильнее, чем CSS при том же числе).
 */
function parseBoxShadow(value, blurScale) {
  const scale = blurScale === undefined ? 1 : blurScale;
  if (!value || value === 'none') return [];
  const out = [];
  for (const part of splitTopLevel(value, ',')) {
    const inset = /\binset\b/.test(part);
    const cleaned = part.replace(/\binset\b/g, ' ').trim();
    // Цвет может стоять где угодно — вырезаем его и оставляем числа
    const colorMatch = /(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/.exec(cleaned);
    const nums = numbers(cleaned.replace(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/g, ' '));
    if (nums.length < 2) continue;
    const color = colorMatch ? parseColor(colorMatch[1]) : null;
    const [ox, oy, blur = 0, spread = 0] = nums;
    out.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: color || { r: 0, g: 0, b: 0, a: 0.25 },
      offset: { x: ox, y: oy },
      radius: Math.max(0, blur * scale),
      spread: spread,
      visible: true,
      blendMode: 'NORMAL',
    });
  }
  return out;
}

/* ------------------------- Градиенты ------------------------- */

/** Угол CSS (0 = вверх, по часовой) → единичный вектор в экранных координатах. */
function cssAngleToVector(angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

function directionKeywordToAngle(word) {
  const w = word.toLowerCase().trim();
  const table = {
    'to top': 0, 'to top right': 45, 'to right top': 45,
    'to right': 90, 'to bottom right': 135, 'to right bottom': 135,
    'to bottom': 180, 'to bottom left': 225, 'to left bottom': 225,
    'to left': 270, 'to top left': 315, 'to left top': 315,
  };
  return table[w] !== undefined ? table[w] : null;
}

/** Позиция остановки: '50%' или '120px' → доля 0..1 вдоль линии градиента. */
function stopPosition(token, lineLen, fontSize) {
  if (!token) return null;
  const t = token.trim();
  if (t.endsWith('%')) return parseFloat(t) / 100;
  if (t.endsWith('px')) return lineLen > 0 ? parseFloat(t) / lineLen : 0;
  if (t.endsWith('em') || t.endsWith('rem')) {
    const v = parseFloat(t) * (t.endsWith('rem') ? 16 : fontSize);
    return lineLen > 0 ? v / lineLen : 0;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n / 100 : null;
}

/** Разобрать список остановок 'rgb(...) 0%, #fff 100%' */
function parseStops(parts, lineLen, fontSize) {
  const stops = [];
  for (const raw of parts) {
    const m = /^(.*?)((?:\s+-?[\d.]+(?:px|%|em|rem)?)+)?$/.exec(raw.trim());
    if (!m) continue;
    const colorStr = m[1].trim();
    const color = parseColor(colorStr);
    if (!color) continue;
    const posTokens = (m[2] || '').trim().split(/\s+/).filter(Boolean);
    if (!posTokens.length) {
      stops.push({ color, position: null });
    } else {
      for (const tok of posTokens) {
        stops.push({ color, position: stopPosition(tok, lineLen, fontSize) });
      }
    }
  }
  if (!stops.length) return [];
  // Раскладываем неопределённые позиции по правилам CSS
  if (stops[0].position === null) stops[0].position = 0;
  if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
  let i = 0;
  while (i < stops.length) {
    if (stops[i].position !== null) { i++; continue; }
    let j = i;
    while (j < stops.length && stops[j].position === null) j++;
    const a = stops[i - 1].position;
    const b = stops[j].position;
    const n = j - i + 1;
    for (let k = i; k < j; k++) {
      stops[k].position = a + ((b - a) * (k - i + 1)) / n;
    }
    i = j;
  }
  return stops.map((s) => ({
    position: clamp(s.position, 0, 1),
    color: s.color,
  }));
}

/**
 * CSS-градиент → заливка Figma.
 * w, h — размеры объекта (нужны для матрицы преобразования).
 */
function parseGradient(css, w, h, fontSize) {
  const m = /^\s*(repeating-)?(linear|radial|conic)-gradient\((.*)\)\s*$/is.exec(css);
  if (!m) return null;
  const kind = m[2].toLowerCase();
  const inner = m[3];

  // Внутри первый аргумент может быть направлением/формой
  const parts = splitTopLevel(inner, ',');
  if (!parts.length) return null;

  let angle = 180; // linear-gradient по умолчанию: сверху вниз
  let radialCenter = { x: 0.5, y: 0.5 };
  let radialRadiusPx = null;
  let stopsStart = 0;

  if (kind === 'linear') {
    const head = parts[0].trim();
    if (/^(to\s|[\d.+-]+deg)/i.test(head)) {
      stopsStart = 1;
      const degMatch = /(-?[\d.]+)deg/i.exec(head);
      if (degMatch) angle = parseFloat(degMatch[1]);
      else {
        const a = directionKeywordToAngle(head);
        if (a !== null) angle = a;
      }
    }
  } else if (kind === 'radial') {
    const head = parts[0].trim();
    if (/^(circle|ellipse|at\b|closest|farthest|[\d.]+(px|%|em|rem))/.test(head)) {
      stopsStart = 1;
      const atMatch = /at\s+([^,]+)/i.exec(head);
      if (atMatch) {
        const t = atMatch[1].trim().split(/\s+/);
        const frac = (tok, fallback) => {
          if (!tok) return fallback;
          if (tok.endsWith('%')) return parseFloat(tok) / 100;
          if (tok.endsWith('px')) return fallback; // зависит от размера — считаем ниже
          const n = parseFloat(tok);
          return Number.isFinite(n) ? n / 100 : fallback;
        };
        radialCenter = { x: frac(t[0], 0.5), y: frac(t[1] || t[0], 0.5) };
        // px-позиция центра
        if (t[0] && t[0].endsWith('px') && w > 0) radialCenter.x = parseFloat(t[0]) / w;
        if (t[1] && t[1].endsWith('px') && h > 0) radialCenter.y = parseFloat(t[1]) / h;
      }
      const rMatch = /([\d.]+)(px|%|em|rem)/.exec(head);
      if (rMatch) {
        const v = parseFloat(rMatch[1]);
        const unit = rMatch[2];
        radialRadiusPx = unit === 'px' ? v : unit === '%' ? (v / 100) * Math.max(w, h)
          : v * (unit === 'rem' ? 16 : fontSize);
      }
    }
  } else {
    return null; // conic — не поддержан, вернём null и подставим средний цвет
  }

  const stopParts = parts.slice(stopsStart);
  const lineLen = kind === 'linear'
    ? Math.abs(w * Math.sin((angle * Math.PI) / 180)) + Math.abs(h * Math.cos((angle * Math.PI) / 180))
    : Math.max(w, h);
  const stops = parseStops(stopParts, lineLen || 1, fontSize || 16);
  if (stops.length < 2) return null;

  // Figma требует строго возрастающие позиции
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].position < stops[i - 1].position) stops[i].position = stops[i - 1].position;
  }

  if (kind === 'linear') {
    const dir = cssAngleToVector(angle);
    const len = Math.max(1, lineLen);
    const cx = w / 2;
    const cy = h / 2;
    const sx = cx - (dir.x * len) / 2;
    const sy = cy - (dir.y * len) / 2;
    const ex = cx + (dir.x * len) / 2;
    const ey = cy + (dir.y * len) / 2;
    const nx0 = w > 0 ? sx / w : 0;
    const ny0 = h > 0 ? sy / h : 0;
    const nx1 = w > 0 ? ex / w : 1;
    const ny1 = h > 0 ? ey / h : 0;
    return {
      type: 'GRADIENT_LINEAR',
      gradientTransform: [
        [nx1 - nx0, ny1 - ny0, nx0],
        [0, 0, ny0],
      ],
      gradientStops: stops,
      opacity: 1,
      visible: true,
      blendMode: 'NORMAL',
    };
  }

  // Радиальный: в пространстве Figma градиент идёт из центра (0.5,0.5) радиусом 0.5
  const farthest = Math.max(
    Math.hypot(radialCenter.x * w, radialCenter.y * h),
    Math.hypot((1 - radialCenter.x) * w, radialCenter.y * h),
    Math.hypot(radialCenter.x * w, (1 - radialCenter.y) * h),
    Math.hypot((1 - radialCenter.x) * w, (1 - radialCenter.y) * h)
  );
  const rPx = radialRadiusPx || farthest || Math.max(w, h) / 2;
  const rx = w > 0 ? rPx / w : 0.5;
  const ry = h > 0 ? rPx / h : 0.5;
  return {
    type: 'GRADIENT_RADIAL',
    gradientTransform: [
      [2 * rx, 0, radialCenter.x - rx],
      [0, 2 * ry, radialCenter.y - ry],
    ],
    gradientStops: stops,
    opacity: 1,
    visible: true,
    blendMode: 'NORMAL',
  };
}

/** Разобрать background-image → массив заливок Figma (снизу вверх). */
function backgroundToFills(style, w, h, currentColor) {
  const bgImage = style['background-image'];
  const fills = [];

  if (bgImage && bgImage !== 'none') {
    const layers = splitTopLevel(bgImage, ',');
    // CSS перечисляет слои сверху вниз; Figma рисует с нулевого индекса вверх —
    // поэтому порядок обратный.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const grad = parseGradient(layer, w, h, px(style['font-size']) || 16);
      if (grad) { fills.push(grad); continue; }
      const urlMatch = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/i.exec(layer);
      if (urlMatch) {
        fills.push({
          __imageRef: (urlMatch[1] || urlMatch[2] || urlMatch[3] || '').trim(),
          __scaleMode: backgroundScaleMode(style),
          __fraction: estimateBackgroundFraction(style['background-size'], w, h),
        });
      }
      // conic и прочее — пропускаем
    }
  }

  const bg = parseColor(style['background-color'], currentColor);
  if (bg && bg.a > 0) fills.push({ type: 'SOLID', color: bg, opacity: 1, visible: true, blendMode: 'NORMAL' });
  return fills;
}

function backgroundScaleMode(style) {
  const size = style['background-size'] || 'auto';
  const repeat = style['background-repeat'] || 'no-repeat';
  if (/repeat/.test(repeat) && !/no-repeat/.test(repeat)) return 'TILE';
  if (/cover/.test(size)) return 'FILL';
  if (/contain/.test(size)) return 'FIT';
  return 'FILL';
}

/** Доля, которую занимает картинка внутри бокса (для выравнивания по background-position). */
function estimateBackgroundFraction(size, w, h) {
  if (!size || size === 'auto' || size === 'cover' || size === 'contain') return 1;
  const parts = String(size).trim().split(/\s+/);
  const one = (t, dim) => {
    if (!t || t === 'auto') return 1;
    if (t.endsWith('%')) return parseFloat(t) / 100;
    if (t.endsWith('px') && dim > 0) return parseFloat(t) / dim;
    return 1;
  };
  return { x: one(parts[0], w), y: one(parts[1] || parts[0], h) };
}

/* ========================================================================
 * 2. ШРИФТЫ
 * ===================================================================== */

const WEIGHT_KEYWORD = {
  thin: 100, hairline: 100,
  extralight: 200, ultralight: 200,
  light: 300,
  book: 400, regular: 400, normal: 400, roman: 400,
  medium: 500,
  semibold: 600, demibold: 600, sem: 600,
  bold: 700,
  extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
};

/**
 * Слитные названия — проверяются ПЕРВЫМИ.
 * Иначе 'Semi Bold' разбирается по словам и находится 'bold' → 700 вместо 600.
 */
const WEIGHT_COMPACT = {
  thin: 100, hairline: 100,
  extralight: 200, ultralight: 200,
  light: 300,
  book: 400, regular: 400, normal: 400, roman: 400,
  medium: 500,
  semibold: 600, demibold: 600, semib: 600,
  bold: 700,
  extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
};

const NUM_TO_KEYWORD = {
  100: 'thin', 200: 'extralight', 300: 'light', 400: 'regular', 500: 'medium',
  600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black',
};

/** Вес и наклон из названия стиля Figma: 'Semi Bold Italic' → {weight:600, italic:true} */
function styleTraits(styleName) {
  const s = String(styleName || '').toLowerCase();
  const italic = /italic|oblique/.test(s);
  // Сначала слитная форма: 'semibold' — иначе 'bold' внутри найдётся раньше
  const compact = s.replace(/italic|oblique/g, '').replace(/[\s_-]+/g, '');
  if (WEIGHT_COMPACT[compact] !== undefined) return { weight: WEIGHT_COMPACT[compact], italic };
  for (const token of s.split(/[\s_-]+/)) {
    if (WEIGHT_KEYWORD[token] !== undefined) return { weight: WEIGHT_KEYWORD[token], italic };
  }
  const numMatch = /(\d{3})/.exec(s);
  if (numMatch) return { weight: parseInt(numMatch[1], 10), italic };
  return { weight: 400, italic };
}

let fontIndex = null;
const loadedFonts = new Set();
const fontResolveCache = new Map();

async function ensureFontIndex() {
  if (fontIndex) return fontIndex;
  fontIndex = new Map();
  try {
    const list = await figma.listAvailableFontsAsync();
    for (const item of list) {
      const fam = String((item.fontName && item.fontName.family) || '');
      if (!fam) continue;
      const key = fam.toLowerCase();
      if (!fontIndex.has(key)) fontIndex.set(key, []);
      fontIndex.get(key).push(item.fontName);
    }
  } catch (e) {
    fontIndex = new Map();
  }
  return fontIndex;
}

/** Выбрать стиль в семействе под нужный вес и наклон. */
function pickStyle(styles, weight, wantItalic) {
  if (!styles || !styles.length) return null;
  const target = Number.isFinite(weight) ? weight : 400;
  let best = null;
  let bestScore = Infinity;
  for (const sn of styles) {
    const { weight: w, italic } = styleTraits(sn.style);
    const italicPenalty = (!!italic === !!wantItalic) ? 0 : 1000;
    const score = italicPenalty + Math.abs(w - target);
    if (score < bestScore) { bestScore = score; best = sn; }
  }
  return best;
}

/**
 * CSS-стек шрифтов → имя шрифта Figma.
 * @param {string} familyCss например: "Inter, -apple-system, sans-serif"
 */
function resolveFont(familyCss, weightCss, styleCss) {
  const cacheKey = `${familyCss}|${weightCss}|${styleCss}`;
  if (fontResolveCache.has(cacheKey)) return fontResolveCache.get(cacheKey);

  const wantItalic = /italic|oblique/.test(String(styleCss || ''));
  const weight = parseInt(weightCss, 10);

  const stack = String(familyCss || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  // Ставим вперёд тот шрифт, который реально использовал браузер.
  // Иначе Figma возьмёт первый доступный (например Inter), а браузер — Arial,
  // и текст завернётся по-другому.
  const preferred = runtime.fontMap ? runtime.fontMap[familyCss] : null;
  if (preferred) {
    const idx = stack.findIndex((s) => s.toLowerCase() === String(preferred).toLowerCase());
    if (idx > 0) { stack.splice(idx, 1); stack.unshift(preferred); }
  }

  let result = null;
  for (const fam of stack) {
    const styles = fontIndex.get(fam.toLowerCase());
    if (styles && styles.length) {
      const picked = pickStyle(styles, weight, wantItalic);
      if (picked) { result = picked; break; }
    }
  }
  if (!result) {
    const inter = fontIndex.get('inter');
    result = (inter && pickStyle(inter, weight, wantItalic)) || null;
  }
  if (!result) {
    // Последний рубеж — любой доступный шрифт
    for (const [, styles] of fontIndex) {
      if (styles.length) { result = styles[0]; break; }
    }
  }
  fontResolveCache.set(cacheKey, result);
  return result;
}

async function ensureFontLoaded(fontName) {
  if (!fontName) return null;
  const key = `${fontName.family}||${fontName.style}`;
  if (loadedFonts.has(key)) return fontName;
  try {
    await figma.loadFontAsync(fontName);
    loadedFonts.add(key);
    return fontName;
  } catch (e) {
    return null;
  }
}

/* ========================================================================
 * 3. ВЕРИФИКАЦИЯ АВТО-ЛЕЙАУТА
 *
 * Авто-лейаут — это то, что делает макет редактируемым, но он приблизителен.
 * Поэтому мы СНАЧАЛА предсказываем раскладку flex вручную и сверяем с
 * реальными координатами из браузера. Совпало — включаем авто-лейаут.
 * Не совпало — раскладываем абсолютно, чтобы не испортить геометрию.
 * ===================================================================== */

/**
 * CSS по умолчанию отдаёт justify-content: normal, а не flex-start.
 * Без этой строки авто-лейаут не включался вообще нигде.
 */
const JUSTIFY_MAP = {
  normal: 'MIN',
  'flex-start': 'MIN', start: 'MIN', left: 'MIN',
  center: 'CENTER',
  'flex-end': 'MAX', end: 'MAX', right: 'MAX',
  'space-between': 'SPACE_BETWEEN',
};
const ALIGN_MAP = {
  normal: 'MIN', // для flex-контейнера normal ведёт себя как stretch,
                 // а размеры детей уже растянуты браузером
  'flex-start': 'MIN', start: 'MIN',
  center: 'CENTER',
  'flex-end': 'MAX', end: 'MAX',
  stretch: 'MIN', // размеры уже растянуты браузером — просто прижимаем к началу
};

/** Размеры и координаты слоя. У текста с padding позиция берётся из bbox. */
function placeBoxOf(ir) {
  if (ir.type === 'text' && ir.bbox) return ir.bbox;
  return ir.box;
}

function round2(v) { return Math.round(v * 100) / 100; }

/**
 * Border box элемента в IR. У текстовых слоёв box — это content box,
 * а flex-элементом является именно border box, поэтому нужен bbox.
 */
function bboxOf(child) { return child.bbox || child.box; }

/**
 * Предсказать позиции детей во flex- или блочном контейнере.
 * Возвращает массив {x, y} в координатах относительно border box родителя —
 * ровно в той же системе, что и child.box в IR.
 *
 * Блочный контейнер (display: block) — это стопка детей по вертикали
 * без отступов между ними: тот же вертикальный авто-лейаут Figma.
 */
function predictFlex(container, children, style) {
  const display = String(style.display || 'block');
  // inline-flex тоже подходит: размер контейнера мы уже знаем из браузера
  // и задаём его фиксированным, поэтому shrink-to-fit не мешает.
  const isFlexC = /flex/.test(display);
  const dir = isFlexC ? (style['flex-direction'] || 'row') : 'column';
  if (isFlexC && /reverse/.test(dir)) return null;
  const isRow = dir.startsWith('row');

  const bt = px(style['border-top-width']);
  const bb = px(style['border-bottom-width']);
  const bl = px(style['border-left-width']);
  const br = px(style['border-right-width']);
  const pt = px(style['padding-top']);
  const pb = px(style['padding-bottom']);
  const pl = px(style['padding-left']);
  const pr = px(style['padding-right']);

  const contentX = bl + pl;
  const contentY = bt + pt;
  const cw = Math.max(0, container.w - bl - br - pl - pr);
  const ch = Math.max(0, container.h - bt - bb - pt - pb);

  const gapRaw = isFlexC
    ? (isRow ? (style['column-gap'] || style.gap) : (style['row-gap'] || style.gap))
    : null;
  const gap = (isFlexC && gapRaw && gapRaw !== 'normal') ? px(gapRaw) : 0;

  const justifyKey = isFlexC
    ? (style['justify-content'] || 'flex-start').split(/\s+/)[0]
    : 'flex-start';
  const justify = JUSTIFY_MAP[justifyKey];
  if (!justify) return null;

  const n = children.length;
  if (!n) return [];

  const marginOf = (c, side) => px((c.style || {})['margin-' + side]);
  const mainStart = (c) => (isRow ? marginOf(c, 'left') : marginOf(c, 'top'));
  const mainEnd = (c) => (isRow ? marginOf(c, 'right') : marginOf(c, 'bottom'));
  const crossStart = (c) => (isRow ? marginOf(c, 'top') : marginOf(c, 'left'));
  const crossEnd = (c) => (isRow ? marginOf(c, 'bottom') : marginOf(c, 'right'));
  const mainSize = (c) => (isRow ? bboxOf(c).w : bboxOf(c).h);
  const crossSize = (c) => (isRow ? bboxOf(c).h : bboxOf(c).w);

  const available = isRow ? cw : ch;
  let sumMain = 0;
  for (const c of children) sumMain += mainStart(c) + mainSize(c) + mainEnd(c);
  const totalGap = gap * (n - 1);
  const free = available - sumMain - totalGap;

  let offset = 0;
  let extraGap = 0;
  if (justify === 'MIN') offset = 0;
  else if (justify === 'CENTER') offset = free / 2;
  else if (justify === 'MAX') offset = free;
  else if (justify === 'SPACE_BETWEEN') { offset = 0; extraGap = n > 1 ? free / (n - 1) : 0; }
  else return null;

  const positions = [];
  let cursor = (isRow ? contentX : contentY) + offset;
  for (const c of children) {
    const alignSelfRaw = isFlexC ? (c.style || {})['align-self'] : null;
    const alignKey = (!alignSelfRaw || alignSelfRaw === 'auto')
      ? (isFlexC ? (style['align-items'] || 'flex-start').split(/\s+/)[0] : 'flex-start')
      : alignSelfRaw.split(/\s+/)[0];
    const align = ALIGN_MAP[alignKey];
    if (!align) return null;

    const alongMain = cursor + mainStart(c);
    const crossAvailable = isRow ? ch : cw;
    const crossOrigin = isRow ? contentY : contentX;
    // Выравнивание по поперечной оси работает с ВНЕШНИМ боксом (вместе с
    // отступами), а координата нужна для рамки элемента. Без этого
    // центрирование ребёнка с отступами считалось бы неверно.
    const outer = crossSize(c) + crossStart(c) + crossEnd(c);
    let marginBoxStart;
    if (align === 'MIN') marginBoxStart = crossOrigin;
    else if (align === 'CENTER') marginBoxStart = crossOrigin + (crossAvailable - outer) / 2;
    else marginBoxStart = crossOrigin + crossAvailable - outer;
    const alongCross = marginBoxStart + crossStart(c);

    positions.push(isRow ? { x: alongMain, y: alongCross } : { x: alongCross, y: alongMain });
    cursor += mainStart(c) + mainSize(c) + mainEnd(c) + gap + extraGap;
  }
  return positions;
}

/** Уникальные значения с допуском 0.5px, по возрастанию. */
function uniqSortedRounded(values) {
  const out = [];
  for (const v of values.slice().sort((a, b) => a - b)) {
    if (!out.length || Math.abs(out[out.length - 1] - v) > 0.5) out.push(v);
  }
  return out;
}

/**
 * Разобрать вычисленное grid-template-* в размеры дорожек.
 * Chrome отдаёт уже посчитанные пиксели и, что важно, ВКЛЮЧАЕТ неявные
 * дорожки. Возвращает null, если значения не в пикселях (auto, minmax, fr).
 */
function parseTracksPx(value) {
  if (!value || value === 'none') return null;
  const parts = String(value).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const m = /^(-?[\d.]+)px$/.exec(p);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (!Number.isFinite(v) || v <= 0) return null;
    out.push(v);
  }
  return out.length ? out : null;
}

function tracksEqual(arr, tol) {
  for (const v of arr) if (Math.abs(v - arr[0]) > tol) return false;
  return true;
}

/**
 * План для grid-контейнера.
 *
 * Figma умеет GRID-лейаут, но дорожки в нём — равные доли фрейма.
 * Поэтому мы берём grid только тогда, когда геометрия это подтверждает:
 * все дорожки одинаковые и ровно заполняют контейнер. Иначе — абсолютные
 * координаты, чтобы не испортить раскладку.
 *
 * Позиции детей определяются ПО ГЕОМЕТРИИ, а не разбором grid-template:
 * так алгоритм расстановки Chrome остаётся единственным источником правды,
 * и мы лишь проверяем, что равные доли его воспроизводят.
 */
function gridPlan(container, children, style, tolerance) {
  const display = String(style.display || '');
  if (!/grid/.test(display)) return null;
  if (!children.length) return null;

  const bl = px(style['border-left-width']);
  const br = px(style['border-right-width']);
  const bt = px(style['border-top-width']);
  const bb = px(style['border-bottom-width']);
  const pl = px(style['padding-left']);
  const pr = px(style['padding-right']);
  const pt = px(style['padding-top']);
  const pb = px(style['padding-bottom']);
  const contentX = bl + pl;
  const contentY = bt + pt;
  const contentW = container.w - bl - br - pl - pr;
  const contentH = container.h - bt - bb - pt - pb;
  if (contentW <= 1 || contentH <= 1) return null;

  for (const c of children) {
    const cs = c.style || {};
    if (cs.position && cs.position !== 'static') return null;
    if (cs.float && cs.float !== 'none') return null;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (Math.abs(px(cs['margin-' + side])) > 0.01) return null;
    }
  }

  const gapX = px(style['column-gap'] || style.gap);
  const gapY = px(style['row-gap'] || style.gap);
  const boxes = children.map(bboxOf);
  const tol = tolerance === undefined ? 2 : tolerance;

  // Размеры дорожек: сначала из вычисленных grid-template-*.
  // Это точнее геометрии — например, видно колонку, в которой нет ни одной
  // ячейки (случай grid-column: span 2 в первой колонке).
  const colTracks = parseTracksPx(style['grid-template-columns']);
  const rowTracks = parseTracksPx(style['grid-template-rows']);

  let nCols;
  let tw;
  if (colTracks) {
    if (!tracksEqual(colTracks, 0.75)) return null; // Figma умеет только равные доли
    nCols = colTracks.length;
    tw = colTracks.reduce((a, b) => a + b, 0) / nCols;
  } else {
    const offX = uniqSortedRounded(boxes.map((b) => Math.round((b.x - contentX) * 100) / 100));
    nCols = offX.length;
    if (!nCols) return null;
    tw = nCols > 1 ? offX[1] - offX[0] - gapX : Math.max.apply(null, boxes.map((b) => b.w));
  }

  let nRows;
  let th;
  if (rowTracks) {
    if (!tracksEqual(rowTracks, 0.75)) return null;
    nRows = rowTracks.length;
    th = rowTracks.reduce((a, b) => a + b, 0) / nRows;
  } else {
    const offY = uniqSortedRounded(boxes.map((b) => Math.round((b.y - contentY) * 100) / 100));
    nRows = offY.length;
    if (!nRows) return null;
    th = nRows > 1 ? offY[1] - offY[0] - gapY : Math.max.apply(null, boxes.map((b) => b.h));
  }

  if (!(tw > 0.5) || !(th > 0.5)) return null;
  // Дорожки обязаны ровно заполнять контейнер — иначе равные доли Figma не совпадут
  if (Math.abs(tw * nCols + gapX * (nCols - 1) - contentW) > tol) return null;
  if (Math.abs(th * nRows + gapY * (nRows - 1) - contentH) > tol) return null;

  const placements = [];
  for (let i = 0; i < children.length; i++) {
    const b = boxes[i];
    const col = Math.round((b.x - contentX) / (tw + gapX));
    const row = Math.round((b.y - contentY) / (th + gapY));
    if (col < 0 || col >= nCols || row < 0 || row >= nRows) return null;
    if (Math.abs(contentX + col * (tw + gapX) - b.x) > tol) return null;
    if (Math.abs(contentY + row * (th + gapY) - b.y) > tol) return null;

    const colSpan = Math.max(1, Math.round((b.w + gapX) / (tw + gapX)));
    const rowSpan = Math.max(1, Math.round((b.h + gapY) / (th + gapY)));
    if (col + colSpan > nCols || row + rowSpan > nRows) return null;

    // Figma растягивает элемент по его области — размеры должны совпасть
    const wantW = colSpan * tw + (colSpan - 1) * gapX;
    const wantH = rowSpan * th + (rowSpan - 1) * gapY;
    if (Math.abs(wantW - b.w) > tol || Math.abs(wantH - b.h) > tol) return null;

    placements.push({ child: children[i], col, row, colSpan, rowSpan });
  }

  return {
    layoutMode: 'GRID',
    gridColumnCount: nCols,
    gridRowCount: nRows,
    gridColumnGap: gapX,
    gridRowGap: gapY,
    paddingLeft: bl + pl,
    paddingRight: br + pr,
    paddingTop: bt + pt,
    paddingBottom: bb + pb,
    placements,
  };
}

/** Можно ли этому контейнеру включить авто-лейаут. */
function autoLayoutPlan(container, children, style, tolerance) {
  if (!runtime.autoReasons) runtime.autoReasons = {};
  const bail = (reason) => {
    runtime.autoReasons[reason] = (runtime.autoReasons[reason] || 0) + 1;
    return null;
  };

  const display = style.display || 'block';
  const isFlexC = /flex/.test(display);
  const isGridC = /grid/.test(display);

  if (isGridC) {
    if (!gridSupported) return bail('grid: не поддерживается вашей версией Figma');
    const gp = gridPlan(container, children, style, tolerance);
    if (gp) return gp;
    return bail('grid: равные доли не воспроизводят раскладку');
  }

  const BLOCKISH = display === 'block' || display === 'flow-root' ||
    display === 'list-item' || display === 'table-cell' || display === 'table-row';
  if (!isFlexC && !BLOCKISH) {
    return bail('не flex (' + display + ')');
  }

  const wrap = style['flex-wrap'] || 'nowrap';
  if (isFlexC && wrap && wrap !== 'nowrap') return bail('flex-wrap: ' + wrap);
  if (!children.length) return bail('нет детей');

  const dir = isFlexC ? (style['flex-direction'] || 'row') : 'column';
  if (isFlexC && /reverse/.test(dir)) return bail('обратное направление');

  // Позиционированные дети в CSS выпадают из потока — это ровно то,
  // для чего в Figma есть layoutPositioning = 'ABSOLUTE'.
  const flowChildren = [];
  const absoluteSet = new Set();
  for (const c of children) {
    const cs = c.style || {};
    const pos = cs.position || 'static';
    if (pos === 'absolute' || pos === 'fixed') { absoluteSet.add(c); continue; }
    if (pos === 'relative') {
      // relative остаётся в потоке, но визуально смещён — модель авто-лейаута
      // такое не выражает.
      const shifted = ['top', 'left', 'right', 'bottom'].some((s) => {
        const v = cs[s];
        return v !== undefined && v !== 'auto' && Math.abs(px(v)) > 0.01;
      });
      if (shifted) return bail('relative-ребёнок со смещением');
    }
    const cdisplay = String(cs.display || 'block');
    if (!isFlexC && /inline|contents/.test(cdisplay)) {
      return bail('в block-контейнере инлайн-ребёнок (' + cdisplay + ')');
    }
    if (cs.float && cs.float !== 'none') return bail('ребёнок с float');
    if (cs.order !== undefined && parseInt(cs.order, 10) !== 0) return bail('ребёнок с order');
    // Авто-отступы (margin: auto) распределяют свободное место — модель
    // авто-лейаута Figma такого не выражает.
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (String(cs['margin-' + side] || '').trim() === 'auto') return bail('авто-отступ у ребёнка');
    }
    // Внешние отступы у детей блок-контейнера схлопываются, поэтому сумму
    // отступов представить нельзя. У flex-контейнеров схлопывания нет —
    // там отступы выражаются точно через рамку-обёртку.
    if (!isFlexC) {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (Math.abs(px(cs['margin-' + side])) > 0.01) return bail('у ребёнка внешние отступы');
      }
    }
    flowChildren.push(c);
  }
  if (!flowChildren.length) return bail('все дети позиционированы');

  // Оговорка: координаты absolute-детей в авто-лейауте Figma отсчитываются
  // от рамки фрейма. Если у фрейма есть padding, есть неоднозначность —
  // и тогда мы эту затею не затеваем.
  if (absoluteSet.size) {
    const padded = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
      .some((s) => Math.abs(px(style[s])) > 0.01);
    if (padded) return bail('absolute-дети и padding у контейнера');
  }

  const predicted = predictFlex(container, flowChildren, style);
  if (!predicted) return bail('нераскладываемое выравнивание');

  let worst = 0;
  for (let i = 0; i < flowChildren.length; i++) {
    const bb = bboxOf(flowChildren[i]);
    const dx = Math.abs(predicted[i].x - bb.x);
    const dy = Math.abs(predicted[i].y - bb.y);
    worst = Math.max(worst, dx, dy);
  }
  const tol = tolerance === undefined ? 2 : tolerance;
  if (worst > tol) return bail(`раскладка не совпала (${worst.toFixed(1)}px)`);

  const isRow = isFlexC && dir.startsWith('row');
  const justify = isFlexC
    ? JUSTIFY_MAP[(style['justify-content'] || 'flex-start').split(/\s+/)[0]]
    : 'MIN';
  const alignItems = isFlexC
    ? (ALIGN_MAP[(style['align-items'] || 'flex-start').split(/\s+/)[0]] || 'MIN')
    : 'MIN';

  const gapRaw = isFlexC
    ? (isRow ? (style['column-gap'] || style.gap) : (style['row-gap'] || style.gap))
    : null;
  const gap = (isFlexC && gapRaw && gapRaw !== 'normal') ? px(gapRaw) : 0;

  return {
    layoutMode: isRow ? 'HORIZONTAL' : 'VERTICAL',
    itemSpacing: gap,
    // В CSS рамка сдвигает содержимое, в Figma — нет: отступ отсчитывается
    // от края фрейма, а обводка рисуется внутрь и на раскладку не влияет.
    // Поэтому толщина границ прибавляется к отступам Figma.
    paddingLeft: px(style['border-left-width']) + px(style['padding-left']),
    paddingRight: px(style['border-right-width']) + px(style['padding-right']),
    paddingTop: px(style['border-top-width']) + px(style['padding-top']),
    paddingBottom: px(style['border-bottom-width']) + px(style['padding-bottom']),
    primaryAxisAlignItems: justify || 'MIN',
    counterAxisAlignItems: alignItems,
    absoluteSet,
    worstDeviation: Math.round(worst * 100) / 100,
  };
}

/* ========================================================================
 * 4. ПОСТРОЕНИЕ СЛОЁВ
 * ===================================================================== */

const runtime = {
  assetBytes: new Map(),
  imageCache: new Map(),
  fontMap: {},
  stats: { frames: 0, texts: 0, images: 0, svgs: 0, grid: 0, autoLayout: 0, absolute: 0, skipped: 0 },
  warnings: [],
  missingFonts: new Set(),
  missingImages: 0,
  options: {},
  progress: { done: 0, total: 0, t0: 0 },
  created: new Set(),
};

function warn(msg) {
  if (runtime.warnings.indexOf(msg) === -1 && runtime.warnings.length < 60) runtime.warnings.push(msg);
}

/** Имя файла. В режиме dynamic-page доступ к figma.root может быть ограничен. */
function safeRootName() {
  try {
    return (figma.root && figma.root.name) ? String(figma.root.name) : 'Без имени';
  } catch (e) {
    return 'Без имени';
  }
}

function isTransparent(c) { return !c || c.a === 0; }

/** Найти байты картинки по ссылке IR. */
function imageBytesFor(node) {
  if (node.inlineSrc) {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(node.inlineSrc);
    if (!m) return null;
    try {
      return m[2] ? figma.base64Decode(m[3]) : new Uint8Array(0);
    } catch (e) { return null; }
  }
  if (node.src) return runtime.assetBytes.get(node.src) || null;
  return null;
}

function backgroundBytesFor(node) {
  if (node.inlineBgSrc) {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(node.inlineBgSrc);
    if (!m) return null;
    try { return m[2] ? figma.base64Decode(m[3]) : null; } catch (e) { return null; }
  }
  if (node.bgSrc) return runtime.assetBytes.get(node.bgSrc) || null;
  return null;
}

function hashFor(bytes, cacheKey) {
  if (!bytes || !bytes.length) return null;
  if (cacheKey && runtime.imageCache.has(cacheKey)) return runtime.imageCache.get(cacheKey);
  try {
    const hash = figma.createImage(bytes).hash;
    if (cacheKey) runtime.imageCache.set(cacheKey, hash);
    return hash;
  } catch (e) {
    return null;
  }
}

/** Собрать заливки узла с учётом картинок. */
function buildFills(node, w, h, currentColor) {
  const raw = backgroundToFills(node.style, w, h, currentColor);
  const out = [];
  for (const f of raw) {
    if (f.__imageRef === undefined) { out.push(f); continue; }
    const bytes = backgroundBytesFor(node);
    const hash = bytes ? hashFor(bytes, 'bg:' + (node.bgSrc || '')) : null;
    if (hash) {
      out.push({ type: 'IMAGE', scaleMode: f.__scaleMode || 'FILL', imageHash: hash, opacity: 1, visible: true });
    } else {
      runtime.missingImages++;
    }
  }
  return out;
}

/** Границы → обводки Figma. */
function applyBorders(fNode, style) {
  const sides = ['top', 'right', 'bottom', 'left'];
  const widths = sides.map((s) => px(style[`border-${s}-width`]));
  const styleName = (style['border-top-style'] || 'none');
  const maxW = Math.max.apply(null, widths);
  if (maxW <= 0 || styleName === 'none' || styleName === 'hidden') return;

  const colors = sides.map((s) => parseColor(style[`border-${s}-color`]));
  const anyVisible = colors.some((c) => c && c.a > 0);
  if (!anyVisible) return;

  const firstColor = colors.find((c) => c && c.a > 0) || { r: 0, g: 0, b: 0, a: 1 };
  const filled = colors.map((c) => (c && c.a > 0 ? c : firstColor));

  // Приводим все цвета к одному: Figma умеет разные толщины, но не разные цвета сторон
  const sameColor = filled.every((c) =>
    Math.abs(c.r - filled[0].r) < 0.004 && Math.abs(c.g - filled[0].g) < 0.004 &&
    Math.abs(c.b - filled[0].b) < 0.004 && Math.abs(c.a - filled[0].a) < 0.004);
  if (!sameColor) warn('Границы с разными цветами по сторонам приведены к цвету верхней.');

  fNode.strokes = [{ type: 'SOLID', color: filled[0], opacity: 1, visible: true }];
  fNode.strokeAlign = 'INSIDE';
  fNode.strokeWeight = maxW;
  try {
    fNode.strokeTopWeight = widths[0];
    fNode.strokeRightWeight = widths[1];
    fNode.strokeBottomWeight = widths[2];
    fNode.strokeLeftWeight = widths[3];
  } catch (e) { /* не все версии API поддерживают — не критично */ }

  if (styleName === 'dashed' && maxW > 0) fNode.dashPattern = [maxW * 2, maxW * 2];
  else if (styleName === 'dotted' && maxW > 0) fNode.dashPattern = [0.01, maxW * 2];
}

/** Скругления. */
function applyRadius(fNode, style) {
  const tl = px(style['border-top-left-radius']);
  const tr = px(style['border-top-right-radius']);
  const br = px(style['border-bottom-right-radius']);
  const bl = px(style['border-bottom-left-radius']);
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) return;
  if (tl === tr && tr === br && br === bl) {
    fNode.cornerRadius = tl;
    return;
  }
  try {
    fNode.topLeftRadius = tl;
    fNode.topRightRadius = tr;
    fNode.bottomRightRadius = br;
    fNode.bottomLeftRadius = bl;
  } catch (e) {
    fNode.cornerRadius = Math.max(tl, tr, br, bl);
  }
}

/** Поворот из CSS transform. */
function applyTransform(fNode, style) {
  const t = style.transform;
  if (!t || t === 'none') return;
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return;
  const nums = m[1].split(',').map(Number);
  if (nums.length < 6 || nums.some(isNaN)) return;
  const [a, b, c, d] = nums;
  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  // Наклон искажает форму — Figma так не умеет, пропускаем
  const dot = (a * c + b * d) / (scaleX * scaleY || 1);
  if (Math.abs(dot) > 0.02) return;
  if (Math.abs(scaleX - 1) > 0.02 || Math.abs(scaleY - 1) > 0.02) return;
  const angleDeg = (Math.atan2(b, a) * 180) / Math.PI;
  if (Math.abs(angleDeg) < 0.05) return;
  // CSS вращает по часовой, Figma против часовой
  try { fNode.rotation = -angleDeg; } catch (e) { /* noop */ }
}

/** Текстовые свойства, общие для узла и для диапазонов. */
function applyTextStyle(tNode, style, currentColor, shadowScale) {
  const fontSize = px(style['font-size']) || 16;
  const font = resolveFont(style['font-family'], style['font-weight'], style['font-style']);
  // Ставить fontName можно ТОЛЬКО для загруженного шрифта: иначе Figma
  // бросает исключение и рушится весь импорт вместо одной подстановки.
  const usableFont = font && loadedFonts.has(`${font.family}||${font.style}`) ? font : null;
  if (usableFont) {
    tNode.fontName = usableFont;
  } else if (font) {
    runtime.missingFonts.add(`${font.family} ${font.style}`);
  }
  tNode.fontSize = fontSize;

  const color = parseColor(style.color, currentColor) || { r: 0, g: 0, b: 0, a: 1 };
  tNode.fills = [{ type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }];

  const lh = style['line-height'];
  if (lh && lh !== 'normal') {
    if (/px$/.test(lh)) {
      tNode.lineHeight = { unit: 'PIXELS', value: px(lh) };
    } else {
      const n = parseFloat(lh);
      if (Number.isFinite(n)) tNode.lineHeight = { unit: 'PERCENT', value: n > 10 ? n : n * 100 };
    }
  } else {
    tNode.lineHeight = { unit: 'AUTO' };
  }

  const ls = style['letter-spacing'];
  if (ls && ls !== 'normal') tNode.letterSpacing = { unit: 'PIXELS', value: px(ls) };
  else tNode.letterSpacing = { unit: 'PIXELS', value: 0 };

  const align = textAlignOf(style['text-align']);
  tNode.textAlignHorizontal = align;

  const deco = style['text-decoration-line'];
  if (deco && deco !== 'none') {
    tNode.textDecoration = /underline/.test(deco) ? 'UNDERLINE'
      : /line-through/.test(deco) ? 'STRIKETHROUGH' : 'NONE';
  }
  const tc = textCaseOf(style['text-transform']);
  if (tc) tNode.textCase = tc;

  const shadow = parseBoxShadow(style['text-shadow'], shadowScale)
    .filter((e) => e.type === 'DROP_SHADOW');
  if (shadow.length) tNode.effects = shadow;
}

function textAlignOf(v) {
  const s = String(v || 'start').toLowerCase();
  if (s === 'center') return 'CENTER';
  if (s === 'right' || s === 'end') return 'RIGHT';
  if (s === 'justify') return 'JUSTIFIED';
  return 'LEFT';
}

function textCaseOf(v) {
  const s = String(v || 'none').toLowerCase();
  if (s === 'uppercase') return 'UPPER';
  if (s === 'lowercase') return 'LOWER';
  if (s === 'capitalize') return 'TITLE';
  return null;
}

/** Применить стили диапазонов (жирные/цветные куски внутри абзаца). */
function applyTextRuns(tNode, node, style, currentColor, shadowScale) {
  const runs = node.runs;
  if (!runs || !runs.length) return;
  const joined = runs.map((r) => r.text).join('');
  if (joined !== node.text) {
    // Позиции могли сдвинуться при схлопывании пробелов — диапазоны не применяем
    return;
  }
  let pos = 0;
  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;
    if (end <= start || !run.style) continue;
    const st = run.style;
    try {
      const family = st['font-family'] || style['font-family'];
      const weight = st['font-weight'] || style['font-weight'];
      const fontStyle = st['font-style'] || style['font-style'];
      const font = resolveFont(family, weight, fontStyle);
      if (font && loadedFonts.has(`${font.family}||${font.style}`)) {
        tNode.setRangeFontName(start, end, font);
      }
      const fs = px(st['font-size']);
      if (fs > 0) tNode.setRangeFontSize(start, end, fs);
      const c = parseColor(st.color, currentColor);
      if (c) tNode.setRangeFills(start, end, [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }]);
      const ls = st['letter-spacing'];
      if (ls && ls !== 'normal') tNode.setRangeLetterSpacing(start, end, { unit: 'PIXELS', value: px(ls) });
      const deco = st['text-decoration-line'];
      if (deco && deco !== 'none') {
        tNode.setRangeTextDecoration(start, end,
          /underline/.test(deco) ? 'UNDERLINE' : 'STRIKETHROUGH');
      }
      const tc = textCaseOf(st['text-transform']);
      if (tc) tNode.setRangeTextCase(start, end, tc);
    } catch (e) {
      // Диапазон может выйти за пределы — не критично, стиль уже применён ко всему слою
    }
  }
}

/** Создать прямоугольник нужного размера. */
function makeRect(w, h) {
  const r = figma.createRectangle();
  r.resize(Math.max(0.01, w), Math.max(0.01, h));
  trackCreated(r);
  return r;
}

function makeFrame(w, h, clips) {
  const f = figma.createFrame();
  f.resize(Math.max(0.01, w), Math.max(0.01, h));
  f.clipsContent = !!clips;
  f.fills = [];
  trackCreated(f);
  return f;
}

/**
 * Учёт созданных узлов.
 *
 * `figma.createFrame()` (и родственные) сразу прикрепляют узел к странице.
 * Если сборка падает на середине, корневой фрейм и осиротевшие создания
 * остаются мусором на холсте пользователя. Именно так в файле появился
 * десяток безымянных фреймов 1440×10345 в точке 0,0.
 */
function trackCreated(node) {
  if (!node || !node.id) return node;
  try { runtime.created.add(node.id); } catch (e) { /* noop */ }
  return node;
}

/** Убрать с холста всё, что осталось от неудавшегося импорта. */
function cleanupFailedImport() {
  let removed = 0;
  try {
    const page = figma.currentPage;
    const doomed = [];
    for (const child of page.children) {
      if (runtime.created.has(child.id)) doomed.push(child);
    }
    for (const n of doomed) {
      try { n.remove(); removed++; } catch (e) { /* noop */ }
    }
  } catch (e) { /* noop */ }
  return removed;
}

/** Записать метаданные слоя: имя, аннотацию, pluginData. */
function decorate(node, ir) {
  node.name = ir.name || ir.tag || 'layer';
  if (runtime.options.addAnnotations && ir.note) {
    try { node.annotations = [{ label: ir.note }]; } catch (e) { /* старые версии API */ }
  }
  if (runtime.options.addPluginData !== false) {
    try {
      if (ir.selPath) node.setPluginData('w2f.sel', String(ir.selPath).slice(0, 900));
      else if (ir.sel) node.setPluginData('w2f.sel', String(ir.sel).slice(0, 900));
      if (ir.tag) node.setPluginData('w2f.tag', String(ir.tag));
      const src = { url: runtime.sourceUrl || '', width: runtime.sourceWidth || 0 };
      if (src.url) node.setPluginData('w2f.src', `${src.url}#${src.width}`);
    } catch (e) { /* noop */ }
  }
}

/**
 * Построить узел Figma из узла IR. Возвращает созданный SceneNode.
 */
async function buildNode(ir, parentStyle) {
  // Отчёт о ходе. Без него долгая сборка в настоящей Figma выглядит
  // как зависание, и непонятно, на каком слое она застряла.
  runtime.progress.done++;
  runtime.currentNode = ir.name || ir.type;   // попадёт в ошибку сторожевого таймера
  // Отчёт о ходе: если сборка где-то встанет, в журнале движка останется имя
  // последнего слоя, до которого она дошла. Без этого «зависло» ничего не говорит.
  if (runtime.progress.done === 1 || runtime.progress.done % 10 === 0) {
    post({
      type: 'progress',
      phase: 'сборка: ' + (ir.name || ir.type || '—'),
      done: runtime.progress.done,
      total: runtime.progress.total || 0,
      elapsedMs: Date.now() - runtime.progress.t0,
    });
  }
  const style = ir.style || {};
  const box = ir.box || { x: 0, y: 0, w: 0, h: 0 };
  const w = Math.max(0.01, box.w);
  const h = Math.max(0.01, box.h);
  const currentColor = parseColor(style.color) || { r: 0, g: 0, b: 0, a: 1 };

  let node = null;
  const placeBox = placeBoxOf(ir);

  if (ir.type === 'text') {
    if (ir.bbox) {
      // У элемента есть padding и/или границы. Текстовый слой Figma их не умеет,
      // поэтому оборачиваем текст во фрейм с настоящим border box.
      // Это ещё и делает элемент корректным flex-элементом для авто-лейаута.
      const bb = ir.bbox;
      const wrap = makeFrame(bb.w, bb.h, /hidden|clip|auto|scroll/.test(style.overflow || ''));
      wrap.fills = buildFills(ir, bb.w, bb.h, currentColor);
      applyRadius(wrap, style);
      applyBorders(wrap, style);
      const wrapEffects = parseBoxShadow(style['box-shadow'], runtime.options.shadowBlurScale);
      if (wrapEffects.length) wrap.effects = wrapEffects;

      const t = await buildText(ir, style, currentColor);
      wrap.appendChild(t);
      t.x = round2(box.x - bb.x);
      t.y = round2(box.y - bb.y);
      t.name = 'текст';
      node = wrap;
    } else {
      node = await buildText(ir, style, currentColor);
    }
  } else if (ir.type === 'svg' && ir.svg) {
    node = buildSvg(ir, w, h);
  } else if (ir.type === 'instance' && ir.componentId) {
    node = await buildInstance(ir, w, h);
  } else if (ir.type === 'image') {
    node = buildImage(ir, w, h);
  } else if (ir.type === 'input') {
    node = await buildInput(ir, style, currentColor, w, h);
  } else {
    node = await buildFrame(ir, style, currentColor, w, h);
  }

  decorate(node, ir);
  await bindVars(node, style);
  node.x = placeBox.x;
  node.y = placeBox.y;

  if (ir.opacity !== undefined && ir.opacity < 1) node.opacity = ir.opacity;
  else if (style.opacity !== undefined && parseFloat(style.opacity) < 1) node.opacity = parseFloat(style.opacity);

  applyTransform(node, style);
  return node;
}

async function buildText(ir, style, currentColor) {
  const box = ir.box;
  const t = figma.createText();
  trackCreated(t);

  // Шрифт обязательно загрузить ДО записи characters
  const font = resolveFont(style['font-family'], style['font-weight'], style['font-style']);
  const usable = font && loadedFonts.has(`${font.family}||${font.style}`) ? font : null;
  if (!usable) {
    if (font) runtime.missingFonts.add(`${font.family} ${font.style}`);
    const fallback = Array.from(loadedFonts)[0];
    if (fallback) {
      const [family, sty] = fallback.split('||');
      t.fontName = { family, style: sty };
    }
  } else {
    t.fontName = usable;
  }

  try {
    t.characters = ir.text || '';
  } catch (e) {
    // Шрифт всё-таки не загружен. Пробуем принудительно и, если не выйдет,
    // оставляем прямоугольник — лучше пустая плашка, чем сорванный импорт.
    let recovered = false;
    try {
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      loadedFonts.add('Inter||Regular');
      t.fontName = { family: 'Inter', style: 'Regular' };
      t.characters = ir.text || '';
      recovered = true;
    } catch (e2) { /* не вышло */ }
    if (!recovered) {
      warn('Часть текста пропущена: шрифт недоступен. Импорт продолжен.');
      const r = makeRect(box.w, box.h);
      applyRadius(r, style);
      return r;
    }
  }
  applyTextStyle(t, style, currentColor, runtime.options.shadowBlurScale);
  applyTextRuns(t, ir, style, currentColor, runtime.options.shadowBlurScale);

  const autoH = runtime.options.textAutoHeight !== false;
  const ws = String(style['white-space'] || 'normal').toLowerCase();
  const hasHardBreak = (ir.text || '').indexOf('\n') !== -1;
  // white-space: nowrap / pre означает, что браузер ГАРАНТИРОВАННО не переносил
  // строку. Если оставить автовысоту, Figma может завернуть текст по своим
  // метрикам шрифта и получить лишнюю строку. Поэтому фиксируем ширину и
  // обрезаем многоточием — ровно как CSS text-overflow: ellipsis.
  const noWrap = (!/\bnormal\b|\bpre-wrap\b|\bpre-line\b|\bbreak-spaces\b/.test(ws)) &&
    /\bnowrap\b|\bpre\b/.test(ws);

  try {
    if (noWrap && !hasHardBreak) {
      t.textAutoResize = 'NONE';
      try { t.maxLines = 1; } catch (e2) { /* старые версии API */ }
      try { t.textTruncation = 'ENDING'; } catch (e2) { /* старые версии API */ }
      t.resize(Math.max(1, box.w), Math.max(1, box.h));
    } else if (autoH) {
      t.textAutoResize = 'HEIGHT';
      t.resize(Math.max(1, box.w), Math.max(1, box.h));
    } else {
      t.textAutoResize = 'NONE';
      t.resize(Math.max(1, box.w), Math.max(1, box.h));
    }
  } catch (e) {
    try { t.textAutoResize = 'NONE'; } catch (e2) { /* noop */ }
  }
  runtime.stats.texts++;
  return t;
}

/**
 * Инстанс компонента дизайн-системы. Ссылаемся на конкретный вариант по id —
 * так надёжнее, чем искать по имени, и работает при documentAccess: dynamic-page.
 */
async function buildInstance(ir, w, h) {
  const comp = await figma.getNodeByIdAsync(ir.componentId);
  if (!comp) throw new Error('компонент не найден: ' + ir.componentId);
  let src = comp;
  if (comp.type === 'COMPONENT_SET') {
    let kids;
    try { kids = Array.from(comp.children); }
    catch (e) { kids = await comp.getChildrenAsync(); }
    src = comp.defaultVariant || kids[0];
  }
  if (!src || src.type !== 'COMPONENT') {
    throw new Error('это не компонент: ' + ir.componentId);
  }
  const inst = src.createInstance();
  trackCreated(inst);
  try { inst.name = ir.name || src.name; } catch (e) { /* имя не критично */ }
  try { inst.resize(Math.max(1, w), Math.max(1, h)); } catch (e) { /* размер задан компонентом */ }

  // Текст внутри инстанса. Без этого все кнопки говорили бы «Кнопка»,
  // а все поля — «Поле ввода»: у компонента свой текст, и его надо заменить.
  // Запись может быть строкой («Войти») или объектом {text, color, colorVar}:
  // у компонента текст своего цвета, и подставленное значение иначе осталось бы
  // цветом плейсхолдера. colorVar — имя переменной, тогда цвет не «зашит».
  const wants = (ir.texts && ir.texts.length) ? ir.texts : null;
  if (wants && wants.length) {
    try {
      const texts = await collectTextsAsync(inst, []);
      for (let i = 0; i < wants.length && i < texts.length; i++) {
        const node2 = texts[i];
        const want = wants[i];
        const chars = (want && typeof want === 'object')
          ? (want.text != null ? want.text : '') : want;
        try {
          if (node2.fontName && node2.fontName !== figma.mixed) {
            await figma.loadFontAsync(node2.fontName);
          }
          node2.characters = String(chars);
        } catch (e) { /* этот текст не заменить — останется текст компонента */ }
        try {
          if (want && typeof want === 'object' && node2.type === 'TEXT') {
            if (want.colorVar) {
              const v = await dsVar(want.colorVar);
              if (v) node2.fills = [dsBound(v)];
            } else if (want.color) {
              node2.fills = [{ type: 'SOLID', color: hexToRgb(want.color) }];
            }
          }
        } catch (e) { /* цвет не подменить — останется цвет компонента */ }
      }
    } catch (e) { /* обход не удался */ }
  }
  return inst;
}

/** Собирает текстовые слои внутри узла — нужен для подмены текста в инстансах. */
async function collectTextsAsync(node, out) {
  let kids = [];
  try { kids = Array.from(node.children); }
  catch (e) { kids = await node.getChildrenAsync(); }
  for (const k of kids) {
    if (k.type === 'TEXT') { out.push(k); continue; }
    if (k.type === 'VECTOR') continue;
    let sub = null;
    // Свойства узла читаем под try: при dynamic-page обращение к .children
    // на неподгруженном узле бросает исключение, и весь обход срывается.
    try { sub = k.children; } catch (e) { sub = null; }
    if (sub) await collectTextsAsync(k, out);
  }
  return out;
}

/* --- привязка к переменным дизайн-системы ------------------------------- */

let _dsVarCache = null;

function hexToRgb(h) {
  const s = String(h).replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return { r: parseInt(full.slice(0, 2), 16) / 255,
           g: parseInt(full.slice(2, 4), 16) / 255,
           b: parseInt(full.slice(4, 6), 16) / 255 };
}

/**
 * Переменная по имени. Имена повторяются между коллекциями (светлая «Synapse»
 * и тёмная «Synapse Dark»), поэтому поддерживается форма «Коллекция/имя»:
 * без неё сборка тёмной темы привязалась бы к светлым переменным.
 */
async function dsVar(name) {
  if (!_dsVarCache) {
    let list;
    try { list = figma.variables.getLocalVariables(); }
    catch (e) { list = await figma.variables.getLocalVariablesAsync(); }
    let colls = [];
    try { colls = figma.variables.getLocalVariableCollections(); }
    catch (e) { colls = await figma.variables.getLocalVariableCollectionsAsync(); }
    const byId = new Map((colls || []).map((c) => [c.id, c]));
    _dsVarCache = new Map();
    for (const v of list) {
      const c = byId.get(v.variableCollectionId);
      if (c) _dsVarCache.set(c.name + '/' + v.name, v);
      _dsVarCache.set(v.name, v);
    }
  }
  return _dsVarCache.get(name) || null;
}

function dsBound(v) {
  return figma.variables.setBoundVariableForPaint(
    { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v);
}

/**
 * Привязывает заливку, обводку и цвет текста к переменным, если в стиле заданы
 * backgroundVar / strokeVar / colorVar. Тогда цвет не «зашит» в слой, а выдан
 * переменной — и меняется из одного места.
 */
async function bindVars(node, style) {
  if (!figma.variables || !style) return;
  try {
    if (style.backgroundVar) {
      const v = await dsVar(style.backgroundVar);
      if (v) node.fills = [dsBound(v)];
    }
    if (style.strokeVar) {
      const v = await dsVar(style.strokeVar);
      if (v) node.strokes = [dsBound(v)];
    }
    if (style.colorVar && node.type === 'TEXT') {
      const v = await dsVar(style.colorVar);
      if (v) node.fills = [dsBound(v)];
    }
  } catch (e) { /* переменной нет — останется обычный цвет */ }
}

function buildSvg(ir, w, h) {
  let svg = ir.svg;
  // Figma лучше строит SVG с явными размерами
  if (!/\swidth\s*=/.test(svg)) svg = svg.replace(/<svg/i, `<svg width="${w}" height="${h}"`);
  try {
    const n = figma.createNodeFromSvg(svg);
    trackCreated(n);
    try { n.resize(w, h); } catch (e) { /* noop */ }
    runtime.stats.svgs++;
    return n;
  } catch (e) {
    warn('Не удалось построить SVG, заменён прямоугольником.');
    runtime.stats.svgs++;
    const r = makeRect(w, h);
    r.fills = [];
    return r;
  }
}

function buildImage(ir, w, h) {
  const r = makeRect(w, h);
  const bytes = imageBytesFor(ir);
  const key = 'img:' + (ir.src || '');
  const hash = hashFor(bytes, key);
  if (hash) {
    const objectFit = (ir.style && ir.style['object-fit']) || 'fill';
    const scaleMode = objectFit === 'contain' ? 'FIT'
      : objectFit === 'cover' ? 'FILL'
      : objectFit === 'none' ? 'CROP' : 'FILL';
    r.fills = [{ type: 'IMAGE', scaleMode, imageHash: hash, opacity: 1, visible: true }];
    applyRadius(r, ir.style);
    applyBorders(r, ir.style);
    runtime.stats.images++;
  } else {
    runtime.missingImages++;
    const bg = parseColor(ir.style['background-color']);
    r.fills = bg && bg.a > 0 ? [{ type: 'SOLID', color: bg, opacity: 1, visible: true }] : [];
    applyRadius(r, ir.style);
  }
  return r;
}

async function buildInput(ir, style, currentColor, w, h) {
  const f = makeFrame(w, h, /hidden/.test(style.overflow || ''));
  f.fills = buildFills(ir, w, h, currentColor);
  applyRadius(f, style);
  applyBorders(f, style);
  const effects = parseBoxShadow(style['box-shadow'], runtime.options.shadowBlurScale);
  if (effects.length) f.effects = effects;

  const text = ir.text || '';
  if (text) {
    const t = figma.createText();
    trackCreated(t);
    const placeholderStyle = Object.assign({}, style);
    // Плейсхолдер обычно бледнее — сохраняем его собственный цвет, если он есть
    const font = resolveFont(style['font-family'], style['font-weight'], style['font-style']);
    const usable = font && loadedFonts.has(`${font.family}||${font.style}`) ? font : null;
    if (usable) t.fontName = usable;
    else {
      const fallback = Array.from(loadedFonts)[0];
      if (fallback) { const [fam, st] = fallback.split('||'); t.fontName = { family: fam, style: st }; }
    }
    t.characters = text;
    applyTextStyle(t, placeholderStyle, currentColor, runtime.options.shadowBlurScale);
    try { t.fills = [{ type: 'SOLID', color: { r: 0.58, g: 0.62, b: 0.68 }, opacity: 1 }]; } catch (e) { /* noop */ }
    try {
      t.textAutoResize = 'HEIGHT';
      t.resize(Math.max(1, w - px(style['padding-left']) - px(style['padding-right']) - 4),
        Math.max(1, h - px(style['padding-top']) - px(style['padding-bottom'])));
      t.x = px(style['padding-left']) + px(style['border-left-width']) + 2;
      t.y = px(style['padding-top']) + px(style['border-top-width']);
    } catch (e) { /* noop */ }
    f.appendChild(t);
    runtime.stats.texts++;
  }
  runtime.stats.frames++;
  return f;
}

/** Есть ли у ребёнка внешние отступы. */
function hasMargins(child) {
  const cs = child.style || {};
  return ['top', 'right', 'bottom', 'left']
    .some((s) => Math.abs(px(cs['margin-' + s])) > 0.01);
}

/**
 * Обернуть ребёнка в рамку, чей padding равен его внешним отступам.
 * Авто-лейаут Figma не умеет margin у детей, но padding обёртки даёт
 * ровно тот же результат. Применяется только к flex-контейнерам:
 * в блочных отступы схлопываются, и сумма была бы неверной.
 */
function wrapWithMargins(childNode, child) {
  const cs = child.style || {};
  const mt = px(cs['margin-top']);
  const mr = px(cs['margin-right']);
  const mb = px(cs['margin-bottom']);
  const ml = px(cs['margin-left']);
  const bb = bboxOf(child);
  const wrap = makeFrame(bb.w + ml + mr, bb.h + mt + mb, false);
  wrap.fills = [];
  wrap.name = childNode.name;
  try { wrap.setPluginData('w2f.margin', '1'); } catch (e) { /* noop */ }
  wrap.appendChild(childNode);
  childNode.layoutPositioning = 'AUTO';
  childNode.x = ml;
  childNode.y = mt;
  return wrap;
}

async function buildFrame(ir, style, currentColor, w, h) {
  const clips = /hidden|clip|auto|scroll/.test(style.overflow || '') ||
    /hidden|clip|auto|scroll/.test(style['overflow-x'] || '') ||
    /hidden|clip|auto|scroll/.test(style['overflow-y'] || '');
  const f = makeFrame(w, h, clips);
  f.fills = buildFills(ir, w, h, currentColor);
  applyRadius(f, style);
  applyBorders(f, style);

  const effects = parseBoxShadow(style['box-shadow'], runtime.options.shadowBlurScale);
  if (effects.length) f.effects = effects;

  const filter = style.filter;
  if (filter && filter !== 'none' && /blur\(/.test(filter)) {
    const m = /blur\(([\d.]+)px\)/.exec(filter);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= 0.5) f.effects = f.effects.concat([{ type: 'LAYER_BLUR', radius: v, visible: true }]);
    }
  }

  runtime.stats.frames++;

  // ---- Дети ----
  const children = ir.children || [];
  if (!children.length) return f;

  const mode = runtime.options.autoLayout || 'safe';
  let plan = null;
  if (mode !== 'off') {
    plan = autoLayoutPlan({ w, h }, children, style,
      mode === 'aggressive' ? 1e9 : (runtime.options.autoLayoutTolerance || 2));
  }

  let useGrid = false;
  let planApplied = false;
  if (plan) {
    f.primaryAxisSizingMode = 'FIXED';
    f.counterAxisSizingMode = 'FIXED';
    f.paddingLeft = plan.paddingLeft;
    f.paddingRight = plan.paddingRight;
    f.paddingTop = plan.paddingTop;
    f.paddingBottom = plan.paddingBottom;
    if (plan.layoutMode === 'GRID') {
      // GRID-лейаут появился в Figma позже остальных режимов и поддерживается
      // не везде. Если версия его не знает — не срываем импорт, а укладываем
      // контейнер абсолютно и больше не пробуем.
      if (gridSupported) {
        try {
          f.layoutMode = 'GRID';
          f.gridColumnCount = plan.gridColumnCount;
          f.gridRowCount = plan.gridRowCount;
          f.gridColumnGap = plan.gridColumnGap;
          f.gridRowGap = plan.gridRowGap;
          useGrid = true;
          planApplied = true;
          runtime.stats.grid++;
        } catch (e) {
          gridSupported = false;
          warn('Ваша версия Figma не поддерживает GRID-лейаут — grid-контейнеры ' +
            'уложены абсолютными координатами. Раскладка точная, но не редактируемая.');
          try { f.layoutMode = 'NONE'; } catch (e2) { /* noop */ }
        }
      }
    } else {
      f.layoutMode = plan.layoutMode;
      f.itemSpacing = plan.itemSpacing;
      f.primaryAxisAlignItems = plan.primaryAxisAlignItems;
      f.counterAxisAlignItems = plan.counterAxisAlignItems;
      planApplied = true;
    }
  }
  // Считаем только то, что действительно применилось, иначе отчёт врёт
  if (planApplied) runtime.stats.autoLayout++;
  else runtime.stats.absolute++;

  for (const child of children) {
    let childNode = await buildNode(child, style);
    const isAbsoluteChild = !!(plan && plan.absoluteSet && plan.absoluteSet.has(child));
    // Отступы выражаем обёрткой: у её padding ровно та же геометрия
    if (plan && !useGrid && !isAbsoluteChild && hasMargins(child)) {
      childNode = wrapWithMargins(childNode, child);
    }
    f.appendChild(childNode);
    if (useGrid) {
      const p = plan.placements.find((x) => x.child === child);
      if (p) {
        try {
          childNode.gridColumnAnchorIndex = p.col;
          childNode.gridRowAnchorIndex = p.row;
          childNode.gridColumnSpan = p.colSpan;
          childNode.gridRowSpan = p.rowSpan;
        } catch (e) {
          warn('Версия Figma не поддерживает якоря grid-лейаута.');
        }
        childNode.layoutPositioning = 'AUTO';
      }
    } else if (plan && plan.layoutMode !== 'GRID') {
      if (isAbsoluteChild) {
        // Выпавший из потока ребёнок — абсолютное позиционирование в авто-лейауте
        childNode.layoutPositioning = 'ABSOLUTE';
        childNode.x = placeBoxOf(child).x;
        childNode.y = placeBoxOf(child).y;
      } else {
        // Координаты вычисляет Figma; размеры уже выставлены
        childNode.layoutPositioning = 'AUTO';
        childNode.layoutGrow = 0;
        childNode.layoutAlign = 'INHERIT';
      }
    } else {
      childNode.x = placeBoxOf(child).x;
      childNode.y = placeBoxOf(child).y;
    }
    await yieldToHost();
  }
  return f;
}

/**
 * Отдача управления хосту.
 *
 * Раньше здесь было `await new Promise(r => setTimeout(r, 0))` каждые 40 слоёв,
 * чтобы окно плагина не подвисало. Это оказалось ГЛАВНОЙ причиной медленной
 * сборки: Chrome душит таймеры скрытых страниц, а окно плагина почти всегда
 * не на переднем плане. Замер в настоящей Figma: 100 фреймов — 777 мс,
 * 400 фреймов — 226 секунд, то есть 567 мс на слой вместо 8.
 *
 * Синхронная сборка тысяч слоёв для плагина Figma нормальна — так работают
 * все импортёры. Отдавать управление через таймер нельзя.
 */
function yieldToHost() {
  return Promise.resolve();
}

/* ========================================================================
 * 5. СБОР ШРИФТОВ И ТОЧКА ВХОДА
 * ===================================================================== */

function collectFontRequests(node, out) {
  const style = node.style || {};
  if (node.type === 'text' || node.type === 'input') {
    out.push({
      family: style['font-family'],
      weight: style['font-weight'],
      style: style['font-style'],
    });
  }
  if (node.runs) {
    for (const r of node.runs) {
      if (!r.style) continue;
      out.push({
        family: r.style['font-family'] || style['font-family'],
        weight: r.style['font-weight'] || style['font-weight'],
        style: r.style['font-style'] || style['font-style'],
      });
    }
  }
  for (const c of node.children || []) collectFontRequests(c, out);
}

async function preloadFonts(ir) {
  await ensureFontIndex();
  const requests = [];
  collectFontRequests(ir, requests);

  const wanted = new Map();
  for (const r of requests) {
    const font = resolveFont(r.family, r.weight, r.style);
    if (!font) { runtime.missingFonts.add(String(r.family || '').slice(0, 60)); continue; }
    wanted.set(`${font.family}||${font.style}`, font);
  }
  // Подстраховка: базовый Inter, чтобы всегда был рабочий шрифт
  const inter = fontIndex.get('inter');
  if (inter && inter.length) {
    const reg = pickStyle(inter, 400, false);
    if (reg) wanted.set(`${reg.family}||${reg.style}`, reg);
  }

  let ok = 0;
  for (const [key, font] of wanted) {
    if (await ensureFontLoaded(font)) ok++;
    else warn(`Шрифт недоступен: ${key.replace('||', ' ')}`);
  }

  // Гарантия: хотя бы один шрифт обязан быть загружен, иначе текстовый слой
  // не создать вообще. Перебираем известные варианты, пока не получится.
  if (loadedFonts.size === 0) {
    const candidates = [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Medium' }];
    try {
      const list = await figma.listAvailableFontsAsync();
      for (const item of list.slice(0, 60)) {
        if (item && item.fontName) candidates.push(item.fontName);
      }
    } catch (e) { /* список недоступен — останутся базовые варианты */ }
    for (const c of candidates) {
      if (await ensureFontLoaded(c)) { ok++; break; }
    }
    if (loadedFonts.size === 0) {
      warn('Не удалось загрузить ни одного шрифта — текстовые слои могут не построиться.');
    }
  }

  return { requested: wanted.size, loaded: ok };
}

/**
 * Проверить ДО сборки, годится ли grid-лейаут этой версии Figma.
 *
 * Важный нюанс: сам `layoutMode = 'GRID'` может работать, а вот якоря ячеек
 * (`gridColumnAnchorIndex`) — нет. Тогда фрейм получит grid-раскладку без
 * управления позициями, и Figma расставит детей своим потоком, что разойдётся
 * с CSS. Поэтому grid признаётся пригодным только вместе с якорями.
 */
async function probeGridSupport() {
  let probe = null;
  try {
    probe = figma.createFrame();
    probe.layoutMode = 'GRID';
    probe.gridColumnCount = 2;
    probe.gridRowCount = 2;
    const c = figma.createRectangle();
    c.resize(10, 10);
    probe.appendChild(c);
    c.gridColumnAnchorIndex = 1;
    c.gridRowAnchorIndex = 1;
    c.gridColumnSpan = 1;
    probe.remove();
    return { ok: true };
  } catch (e) {
    try { if (probe) probe.remove(); } catch (e2) { /* noop */ }
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

async function runImport(payload) {
  const ir = payload.ir;
  const options = payload.options || {};
  runtime.options = options;
  runtime.warnings = [];
  runtime.missingFonts = new Set();
  runtime.missingImages = 0;
  runtime.stats = { frames: 0, texts: 0, images: 0, svgs: 0, grid: 0, autoLayout: 0, absolute: 0, skipped: 0 };
  runtime.sourceUrl = ir.url || '';
  runtime.sourceWidth = ir.viewport && ir.viewport.w || 0;
  runtime.fontMap = ir.fontMap || {};
  runtime.autoReasons = {};
  runtime.progress = { done: 0, total: (ir.stats && ir.stats.emitted) || 0, t0: Date.now() };
  runtime.created = new Set();

  post({ type: 'progress', phase: 'fonts', done: 0, total: 1 });
  const fonts = await preloadFonts(ir.root);

  // Пригодность grid-лейаута выясняем один раз до сборки, иначе получим
  // фреймы с grid-раскладкой и без управления позициями детей.
  post({ type: 'progress', phase: 'проверка grid', done: 0, total: 1 });
  const gridProbe = await probeGridSupport();
  gridSupported = gridProbe.ok;
  if (!gridSupported) {
    warn('Ваша версия Figma не поддерживает grid-лейаут с якорями ячеек (' +
      gridProbe.reason + '). grid-контейнеры уложены абсолютными координатами — ' +
      'раскладка точная, но не редактируемая.');
  }

  post({ type: 'progress', phase: 'build', done: 0, total: 1 });

  let rootNode;
  try {
    rootNode = await buildNode(ir.root, null);
  } catch (e) {
    // Неудачная сборка не должна оставлять мусор на холсте пользователя
    const removed = cleanupFailedImport();
    if (removed) warn(`Неудавшийся импорт убран с холста (слоёв: ${removed}).`);
    throw e;
  }

  // Корневой фрейм приводим к размеру страницы и даём осмысленное имя
  const contentW = (ir.content && ir.content.w) || (ir.root.box && ir.root.box.w) || 1440;
  const contentH = (ir.content && ir.content.h) || (ir.root.box && ir.root.box.h) || 900;
  const rootFrame = rootNode;
  rootFrame.name = `${ir.title || 'Страница'} — ${Math.round(contentW)}px`;
  try { rootFrame.resize(Math.max(1, contentW), Math.max(1, contentH)); } catch (e) { /* noop */ }
  rootFrame.x = 0;
  rootFrame.y = 0;
  rootFrame.clipsContent = false;

  if (options.pageName) {
    try { rootFrame.name = options.pageName; } catch (e) { /* noop */ }
  }

  return {
    rootFrame,
    report: {
      fonts,
      stats: runtime.stats,
      warnings: runtime.warnings,
      missingFonts: Array.from(runtime.missingFonts).slice(0, 40),
      missingImages: runtime.missingImages,
      autoReasons: Object.entries(runtime.autoReasons || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 10),
    },
  };
}

/* ========================================================================
 * 6. САМОПРОВЕРКА ВОЗМОЖНОСТЕЙ FIGMA
 *
 * Зачем: плагин нельзя прогнать в настоящей Figma на этапе разработки, и
 * остаётся неопределённость — какие именно возможности поддерживает версия
 * пользователя. Этот тест превращает неизвестность в измеримый факт:
 * он пробует каждую возможность на временном фрейме и сообщает результат.
 * ===================================================================== */

async function selfTest() {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' });
  let probe = null;
  // Самопроверка тоже обязана убирать за собой: createText/createFrame
  // прикрепляются к странице немедленно и иначе остаются мусором.
  const made = [];
  const madeNode = (n) => { made.push(n); return n; };

  try {
    probe = madeNode(figma.createFrame());
    probe.name = 'w2f-selftest';
    probe.resize(320, 200);
    probe.clipsContent = false;
    add('Фрейм, размеры, обрезка', true);

    try {
      probe.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.95 }, opacity: 1 }];
      probe.fills = [{
        type: 'GRADIENT_LINEAR',
        gradientTransform: [[1, 0, 0], [0, 1, 0]],
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
        opacity: 1, visible: true, blendMode: 'NORMAL',
      }];
      add('Заливки и линейные градиенты', true);
    } catch (e) { add('Заливки и линейные градиенты', false, e.message); }

    try {
      probe.fills = [{
        type: 'GRADIENT_RADIAL',
        gradientTransform: [[1, 0, 0], [0, 1, 0]],
        gradientStops: [
          { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
        ],
        opacity: 1, visible: true, blendMode: 'NORMAL',
      }];
      add('Радиальные градиенты', true);
    } catch (e) { add('Радиальные градиенты', false, e.message); }

    try {
      probe.layoutMode = 'VERTICAL';
      probe.primaryAxisSizingMode = 'FIXED';
      probe.counterAxisSizingMode = 'FIXED';
      probe.itemSpacing = 8;
      probe.paddingLeft = 12;
      probe.paddingTop = 12;
      probe.primaryAxisAlignItems = 'SPACE_BETWEEN';
      probe.counterAxisAlignItems = 'CENTER';
      add('Авто-лейаут: направление, зазор, отступы, выравнивание', true);
    } catch (e) { add('Авто-лейаут: направление, зазор, отступы, выравнивание', false, e.message); }

    // Проба ровно того, что плагин делает в авто-лейауте. Первый реальный
    // импорт упал именно здесь: layoutPositioning принимает только
    // AUTO | ABSOLUTE, а не INHERIT (у layoutAlign набор значений другой).
    try {
      const child = madeNode(figma.createRectangle());
      child.resize(10, 10);
      probe.appendChild(child);
      child.layoutPositioning = 'ABSOLUTE';
      child.x = 5;
      child.y = 5;
      child.layoutPositioning = 'AUTO';
      child.layoutGrow = 0;
      child.layoutAlign = 'INHERIT';
      add('Дети авто-лейаута: абсолютные и в потоке', true,
        `layoutPositioning=${child.layoutPositioning}, layoutAlign=${child.layoutAlign}`);
    } catch (e) { add('Дети авто-лейаута: абсолютные и в потоке', false, e.message); }

    // GRID-лейаут разбираем по частям: в реальной Figma 126 сам layoutMode=GRID
    // работает, а якоря ячеек — нет. Общая проба «упало/не упало» это скрывает.
    const gridSteps = [];
    let gridOk = true;
    try {
      probe.layoutMode = 'GRID';
      gridSteps.push('layoutMode=GRID ✓');
    } catch (e) {
      gridOk = false;
      gridSteps.push('layoutMode=GRID ✗ ' + e.message);
    }
    try {
      probe.gridColumnCount = 3;
      probe.gridRowCount = 2;
      gridSteps.push('дорожки ✓');
    } catch (e) { gridOk = false; gridSteps.push('дорожки ✗ ' + e.message); }
    try {
      probe.gridColumnGap = 10;
      probe.gridRowGap = 10;
      gridSteps.push('зазоры ✓');
    } catch (e) { gridOk = false; gridSteps.push('зазоры ✗ ' + e.message); }

    let anchorCell = null;
    try {
      anchorCell = madeNode(figma.createRectangle());
      anchorCell.resize(20, 20);
      probe.appendChild(anchorCell);
      anchorCell.gridColumnAnchorIndex = 2;
      anchorCell.gridRowAnchorIndex = 1;
      anchorCell.gridColumnSpan = 1;
      anchorCell.gridRowSpan = 1;
      gridSteps.push('якоря ячеек ✓');
    } catch (e) { gridOk = false; gridSteps.push('якоря ячеек ✗ ' + e.message); }

    add('GRID-лейаут Figma (нужен целиком, иначе grid ложится абсолютно)', gridOk,
      gridSteps.join('; '));
    try { probe.layoutMode = 'NONE'; } catch (e) { /* noop */ }

    try {
      probe.effects = [{
        type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.3 },
        offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true, blendMode: 'NORMAL',
      }];
      probe.effects = probe.effects.concat([{
        type: 'INNER_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.2 },
        offset: { x: 0, y: 1 }, radius: 4, spread: 0, visible: true, blendMode: 'NORMAL',
      }]);
      probe.effects = probe.effects.concat([{ type: 'LAYER_BLUR', radius: 2, visible: true }]);
      add('Внешние и внутренние тени, размытие', true);
    } catch (e) { add('Внешние и внутренние тени, размытие', false, e.message); }

    try {
      probe.cornerRadius = 8;
      probe.topLeftRadius = 8;
      probe.topRightRadius = 4;
      probe.bottomRightRadius = 2;
      probe.bottomLeftRadius = 0;
      add('Скругление по отдельным углам', true);
    } catch (e) { add('Скругление по отдельным углам', false, e.message); }

    try {
      probe.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
      probe.strokeAlign = 'INSIDE';
      probe.strokeWeight = 2;
      probe.strokeTopWeight = 1;
      probe.strokeBottomWeight = 3;
      probe.dashPattern = [4, 4];
      add('Границы: толщина по сторонам, пунктир', true);
    } catch (e) { add('Границы: толщина по сторонам, пунктир', false, e.message); }

    try {
      probe.opacity = 0.9;
      add('Прозрачность слоя', true);
    } catch (e) { add('Прозрачность слоя', false, e.message); }

    // Шрифты — самая частая причина срыва импорта
    const fontInfo = [];
    try {
      const list = await figma.listAvailableFontsAsync();
      fontInfo.push(`доступно шрифтов: ${list.length}`);
      const inter = list.filter((f) => f.fontName && f.fontName.family === 'Inter').length;
      fontInfo.push(inter ? `стилей Inter: ${inter}` : 'Inter НЕ найден');
    } catch (e) { fontInfo.push('список шрифтов недоступен: ' + e.message); }

    try {
      const fontName = { family: 'Inter', style: 'Regular' };
      await figma.loadFontAsync(fontName);
      const t = madeNode(figma.createText());
      t.fontName = fontName;
      t.characters = 'Проверка текста';
      t.fontSize = 16;
      t.lineHeight = { unit: 'PERCENT', value: 150 };
      t.letterSpacing = { unit: 'PIXELS', value: 0 };
      t.textAlignHorizontal = 'CENTER';
      t.textCase = 'UPPER';
      t.textDecoration = 'UNDERLINE';
      t.textAutoResize = 'HEIGHT';
      t.resize(200, 40);
      const h = Math.round(t.height);
      t.setRangeFontSize(0, 8, 20);
      t.setRangeFills(0, 8, [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1 }]);
      t.setRangeLetterSpacing(0, 8, { unit: 'PIXELS', value: 1 });
      add('Текст: шрифты, диапазоны, автовысота', true,
        `${fontInfo.join(', ')}; высота после автоподбора ${h}px`);
    } catch (e) { add('Текст: шрифты, диапазоны, автовысота', false, `${e.message} — ${fontInfo.join(', ')}`); }

    try {
      const t2 = madeNode(figma.createText());
      t2.fontName = { family: 'Inter', style: 'Regular' };
      t2.characters = 'Обрезка длинного текста в одну строку';
      t2.textAutoResize = 'NONE';
      t2.maxLines = 1;
      t2.textTruncation = 'ENDING';
      add('Обрезка текста многоточием (nowrap в CSS)', true);
    } catch (e) { add('Обрезка текста многоточием (nowrap в CSS)', false, e.message); }

    try {
      probe.setPluginData('w2f.test', 'ok');
      const back = probe.getPluginData('w2f.test');
      probe.annotations = [{ label: 'Проверка аннотаций' }];
      add('Данные слоя и аннотации', back === 'ok', back === 'ok' ? '' : 'данные не вернулись');
    } catch (e) { add('Данные слоя и аннотации', false, e.message); }

    try {
      const svgNode = madeNode(figma.createNodeFromSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
        '<circle cx="12" cy="12" r="10" fill="#f59e0b"/></svg>'));
      const kind = svgNode.type;
      svgNode.remove();
      add('Построение вектора из SVG-разметки', true, `получился ${kind}`);
    } catch (e) { add('Построение вектора из SVG-разметки', false, e.message); }

    try {
      const img = figma.createImage(figma.base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='));
      const r = madeNode(figma.createRectangle());
      r.resize(10, 10);
      r.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: img.hash, opacity: 1, visible: true }];
      const hash = String(img.hash);
      add('Картинки', true, 'хэш ' + hash.slice(0, 12));
      r.remove();
    } catch (e) { add('Картинки', false, e.message); }

    try {
      figma.currentPage.appendChild(probe);
      const bytes = await probe.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.5 } });
      add('Экспорт слоя в PNG', !!(bytes && bytes.length), `${bytes ? bytes.length : 0} байт`);
    } catch (e) { add('Экспорт слоя в PNG', false, e.message); }

    try {
      add('Страница документа', true, String(figma.currentPage.name));
    } catch (e) { add('Страница документа', false, e.message); }
  } catch (e) {
    add('Общая проверка', false, String((e && e.message) || e));
  } finally {
    // Убираем за собой: createFrame/createText прикрепляются к странице сразу
    for (const n of made) {
      try { n.remove(); } catch (e) { /* уже удалён */ }
    }
    try { if (probe) probe.remove(); } catch (e) { /* noop */ }
  }

  const failed = results.filter((r) => !r.ok).length;
  return { results, failed, total: results.length, version: PLUGIN_VERSION };
}

/* ========================================================================
 * 7. ОБМЕН СООБЩЕНИЯМИ
 * ===================================================================== */

let busy = false;
/**
 * Загружены ли страницы файла целиком в этой сессии плагина.
 *
 * При documentAccess: dynamic-page граф узлов грузится по страницам, и чужая
 * страница выгружается. Компоненты дизайн-системы живут на своей странице:
 * без её загрузки каждый createInstance тянет загрузку страницы заново, и
 * сборка идёт секунды на слой (замер: 3 с на узел на экране с 20 инстансами).
 */
let pagesLoaded = false;
/** Поддерживает ли эта версия Figma GRID-лейаут. Выясняется при первой попытке. */
let gridSupported = true;

function post(msg) {
  try { figma.ui.postMessage(msg); } catch (e) { /* окно могло закрыться */ }
}

// showUI обёрнут: если какая-то опция не поддерживается версией API,
// плагин не должен умереть целиком на старте.
try {
  figma.showUI(__html__, { width: 460, height: 720, themeColors: true, title: 'Web → Figma Bridge' });
} catch (e) {
  try {
    figma.showUI(__html__, { width: 460, height: 720, themeColors: true });
  } catch (e2) {
    figma.showUI(__html__, { width: 460, height: 720 });
  }
}

/* ========================================================================
 * Дизайн-система: переменные, компоненты и иконки.
 * Добавлено к мосту. Вызывается командой движка «design-system».
 *
 * ВАЖНО про темы: на тарифе Figma, где работает пользователь, у коллекции
 * переменных допустим ТОЛЬКО ОДИН режим («Limited to 1 modes only»). Поэтому
 * двухрежимная коллекция невозможна. Вместо неё — две отдельные коллекции
 * и два набора компонентов: «Synapse» для светлой темы и «Synapse Dark»
 * для тёмной. Каждая тема внутри себя меняется из одного места.
 * ===================================================================== */

const DS_TOKENS = {
  bg:          { Light: '#F4F6F8', Dark: '#070B14' },
  surface:     { Light: '#FFFFFF', Dark: '#101728' },
  surfaceSoft: { Light: '#F8FAFC', Dark: '#16203A' },
  raised:      { Light: '#FFFFFF', Dark: '#1B2540' },
  border:      { Light: '#E2E8F0', Dark: '#26314F' },
  borderSoft:  { Light: '#F1F5F9', Dark: '#1A2338' },
  text:        { Light: '#172033', Dark: '#EDF1FF' },
  textMuted:   { Light: '#64748B', Dark: '#9AA4C0' },
  textFaint:   { Light: '#94A3B8', Dark: '#626C88' },
  brand:       { Light: '#6366F1', Dark: '#7C5CFF' },
  action:      { Light: '#4F46E5', Dark: '#7C5CFF' },
  actionHover: { Light: '#4338CA', Dark: '#8F73FF' },
  actionBg:    { Light: '#EEF2FF', Dark: '#212C4C' },
  accentLine:  { Light: '#C7D2FE', Dark: '#3B4A7A' },
  success:     { Light: '#15803D', Dark: '#2BD9A0' },
  successBg:   { Light: '#ECFDF3', Dark: '#0F2E28' },
  warn:        { Light: '#B45309', Dark: '#FFB020' },
  warnBg:      { Light: '#FFF7ED', Dark: '#33260F' },
  danger:      { Light: '#B91C1C', Dark: '#FF5C7A' },
  dangerBg:    { Light: '#FEF2F2', Dark: '#341826' },
  info:        { Light: '#0369A1', Dark: '#5CB8FF' },
  infoBg:      { Light: '#EFF6FF', Dark: '#122438' },
  neutral:     { Light: '#475569', Dark: '#8C96B4' },
  neutralBg:   { Light: '#F1F5F9', Dark: '#1B2540' },
  onAction:    { Light: '#FFFFFF', Dark: '#FFFFFF' },
};

const DS_NUMBERS = {
  'radius/control': { Light: 8,  Dark: 12 },
  'radius/card':    { Light: 12, Dark: 20 },
  'radius/pill':    { Light: 999, Dark: 999 },
};

const DS_ICONS = {
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
  'arrow-up-right': 'M7 17L17 7M8 7h9v9',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-up': 'M6 15l6-6 6 6',
  'search': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3',
  'plus': 'M12 5v14M5 12h14',
  'minus': 'M5 12h14',
  'check': 'M5 13l4 4L19 7',
  'close': 'M6 6l12 12M18 6L6 18',
  'more': 'M6 12h.01M12 12h.01M18 12h.01',
  'folder': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  'file': 'M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z',
  'calendar': 'M8 3v4M16 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  'user': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21c0-3.3 3.6-6 8-6s8 2.7 8 6',
  'users': 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M2 20c0-2.8 3.1-5 7-5s7 2.2 7 5M17 5.2a3.5 3.5 0 0 1 0 6.6M19 15.5c1.8.7 3 1.9 3 3.5',
  'bell': 'M18 15V10a6 6 0 1 0-12 0v5l-1.5 3h15L18 15zM10 21h4',
  'settings': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4',
  'filter': 'M3 5h18l-7 8v6l-4 2v-8L3 5z',
  'link': 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  'star': 'M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.8 6.7 19.6l1.1-6L3.4 9.4l6-.8L12 3z',
  'clock': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
  'alert': 'M12 9v4M12 17h.01M10.3 3.9L2.4 17a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  'info': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16v-5M12 8h.01',
  'trash': 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
  'edit': 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  'eye': 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  'lock': 'M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1M9 11V8a3 3 0 0 1 6 0v3',
  'home': 'M3 10.5L12 3l9 7.5M5 10v10h14V10',
  'grid': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  'list': 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  'board': 'M4 5h4v11H4zM10 5h4v7h-4zM16 5h4v15h-4z',
  'sparkle': 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z',
  'graph': 'M7.7 6.6l8.6 10.8M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  'git': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M12 3v6M12 15v6',
  'gantt': 'M4 4v16M4 6h8M4 12h12M4 18h6',
};

const DS_SETS = ['Button', 'Input', 'Badge / Status', 'Badge / Priority', 'Chip',
                 'Checkbox', 'Toggle', 'Avatar', 'Card', 'Row / Task', 'Icon'];

async function buildDesignSystem(themeOpt) {
  const theme = themeOpt === 'Dark' ? 'Dark' : 'Light';
  if (!figma.variables || !figma.variables.createVariableCollection) {
    throw new Error('в этой версии Figma нет переменных');
  }
  for (const s of ['Regular', 'Medium', 'Semi Bold', 'Bold']) {
    await figma.loadFontAsync({ family: 'Inter', style: s });
  }

  const pageName = theme === 'Dark' ? 'Design System — Dark' : 'Design System';
  const collName = theme === 'Dark' ? 'Synapse Dark' : 'Synapse';
  const suffix = theme === 'Dark' ? ' · Dark' : '';

  let pages;
  try { pages = figma.root.children; }
  catch (e) { pages = await figma.root.getChildrenAsync(); }
  let page = pages.find((p) => p.name === pageName);
  if (!page) page = figma.createPage();
  page.name = pageName;
  if (figma.currentPage !== page) {
    if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(page);
    else figma.currentPage = page;
  }

  const ds = { theme: theme, variables: 0, mode: theme, components: 0, sets: [], icons: 0,
               failed: [], page: pageName, map: {} };
  const VARS = {};

  // ---- переменные: одна коллекция, один режим (ограничение тарифа)
  let collections;
  try { collections = figma.variables.getLocalVariableCollections(); }
  catch (e) { collections = await figma.variables.getLocalVariableCollectionsAsync(); }
  let coll = collections.find((c) => c.name === collName);
  if (!coll) coll = figma.variables.createVariableCollection(collName);
  const modeId = coll.modes[0].modeId;
  try { coll.renameMode(modeId, theme); } catch (e) { /* имя не критично */ }

  let existing;
  try { existing = figma.variables.getLocalVariables(); }
  catch (e) { existing = await figma.variables.getLocalVariablesAsync(); }

  const makeVar = (name, type, value) => {
    let v = existing.find((x) => x.name === name && x.variableCollectionId === coll.id);
    if (!v) {
      try { v = figma.variables.createVariable(name, coll, type); }
      catch (e) { v = figma.variables.createVariable(name, coll.id, type); }
      ds.variables++;
    }
    v.setValueForMode(modeId, type === 'COLOR' ? dsHex(value) : value);
    VARS[name] = v;
    return v;
  };
  for (const name of Object.keys(DS_TOKENS)) makeVar('color/' + name, 'COLOR', DS_TOKENS[name][theme]);
  for (const name of Object.keys(DS_NUMBERS)) makeVar(name, 'FLOAT', DS_NUMBERS[name][theme]);
  _dsVarCache = null;      // переменные изменились — кэш имён больше не годится

  // ---- чистим прежние наборы этой темы
  let pageKids;
  try { pageKids = Array.from(page.children); }
  catch (e) { pageKids = await page.getChildrenAsync(); }
  const ours = DS_SETS.map((n) => n + suffix);
  for (const ch of pageKids) {
    if (ch.type === 'COMPONENT_SET' && ours.indexOf(ch.name) !== -1) ch.remove();
    // пустые иконки и брошенные векторы от прежнего, неудачного прогона
    else if (ch.type === 'COMPONENT' && ch.name.indexOf('Name=') === 0) ch.remove();
    else if (ch.type === 'VECTOR' && ch.width === 100 && ch.height === 100) ch.remove();
    else if (ch.type === 'TEXT' && ch.name.indexOf('подпись-') === 0) ch.remove();
  }

  const T = (chars, size, weight, colorVar) => dsText(chars, size, weight, colorVar, VARS);
  const C = (name, w, h, fillVar, radiusVar, strokeVar) =>
    dsComp(name + suffix, w, h, fillVar, radiusVar, strokeVar, VARS);

  // ---- кнопки
  const KINDS = {
    Primary:   { fill: 'color/action',   fg: 'color/onAction',  stroke: null,           w: 148 },
    Secondary: { fill: 'color/surface',  fg: 'color/text',      stroke: 'color/border', w: 148 },
    Ghost:     { fill: null,             fg: 'color/textMuted', stroke: null,           w: 148 },
    Danger:    { fill: 'color/danger',   fg: 'color/onAction',  stroke: null,           w: 148 },
    Icon:      { fill: 'color/surface',  fg: 'color/textMuted', stroke: 'color/border', w: 36 },
  };
  const buttons = [];
  for (const kind of Object.keys(KINDS)) {
    const k = KINDS[kind];
    for (const state of ['Default', 'Hover', 'Focus', 'Disabled']) {
      let fill = k.fill;
      if (state === 'Disabled') fill = 'color/neutralBg';
      else if (state === 'Hover' && k.fill === 'color/action') fill = 'color/actionHover';
      const stroke = state === 'Focus' ? 'color/brand' : (state === 'Disabled' ? null : k.stroke);
      const fg = state === 'Disabled' ? 'color/textFaint' : k.fg;
      const c = C(`Kind=${kind}, State=${state}`, kind === 'Icon' ? 36 : 148, 36, fill, 'radius/control', stroke);
      if (kind === 'Icon') c.appendChild(T('+', 16, 'Semi Bold', fg));
      else { c.paddingLeft = 16; c.paddingRight = 16; c.appendChild(T('Кнопка', 13, 'Semi Bold', fg)); }
      buttons.push(c);
    }
  }
  const setButton = figma.combineAsVariants(buttons, page);
  setButton.name = 'Button' + suffix;
  ds.sets.push(['Button', buttons.length]);

  // ---- поля
  const inputs = [];
  for (const kind of ['Text', 'Select']) {
    for (const state of ['Default', 'Focus', 'Error', 'Disabled']) {
      const fill = state === 'Disabled' ? 'color/surfaceSoft' : 'color/surface';
      const stroke = state === 'Focus' ? 'color/brand' : state === 'Error' ? 'color/danger' : 'color/border';
      const fg = state === 'Error' ? 'color/danger' : 'color/textFaint';
      const c = C(`Kind=${kind}, State=${state}`, 248, 40, fill, 'radius/control', stroke);
      c.primaryAxisAlignItems = 'MIN';
      c.paddingLeft = 12;
      c.paddingRight = 12;
      c.appendChild(T(kind === 'Select' ? 'Значение' : 'Поле ввода', 13, 'Medium', fg));
      inputs.push(c);
    }
  }
  const setInput = figma.combineAsVariants(inputs, page);
  setInput.name = 'Input' + suffix;
  ds.sets.push(['Input', inputs.length]);

  // ---- бейджи
  const STATUS = [['К выполнению', 'color/neutral', 'color/neutralBg'],
                  ['В работе', 'color/warn', 'color/warnBg'],
                  ['На проверке', 'color/info', 'color/infoBg'],
                  ['Заблокировано', 'color/danger', 'color/dangerBg'],
                  ['Готово', 'color/success', 'color/successBg'],
                  ['Архив', 'color/textMuted', 'color/borderSoft']];
  const badges = STATUS.map((row) => {
    const c = C(`Status=${row[0]}`, 136, 24, row[2], 'radius/pill', null);
    c.appendChild(T(row[0], 11, 'Semi Bold', row[1]));
    return c;
  });
  const setBadge = figma.combineAsVariants(badges, page);
  setBadge.name = 'Badge / Status' + suffix;
  ds.sets.push(['Badge / Status', badges.length]);

  const PRIO = [['Высокий', 'color/danger', 'color/dangerBg'],
                ['Средний', 'color/warn', 'color/warnBg'],
                ['Низкий', 'color/neutral', 'color/neutralBg']];
  const prios = PRIO.map((row) => {
    const c = C(`Priority=${row[0]}`, 104, 24, row[2], 'radius/pill', null);
    c.appendChild(T(row[0], 11, 'Semi Bold', row[1]));
    return c;
  });
  const setPrio = figma.combineAsVariants(prios, page);
  setPrio.name = 'Badge / Priority' + suffix;
  ds.sets.push(['Badge / Priority', prios.length]);

  // ---- чипы
  const CHIPS = [['Default', 'color/surface', 'color/textMuted', 'color/border'],
                 ['Active', 'color/actionBg', 'color/action', 'color/accentLine']];
  const chips = CHIPS.map((row) => {
    const c = C(`State=${row[0]}`, 96, 32, row[1], 'radius/control', row[3]);
    c.appendChild(T('Чип', 12, row[0] === 'Active' ? 'Semi Bold' : 'Medium', row[2]));
    return c;
  });
  const setChip = figma.combineAsVariants(chips, page);
  setChip.name = 'Chip' + suffix;
  ds.sets.push(['Chip', chips.length]);

  // ---- флажок и переключатель
  const checks = [['Off', false], ['On', true]].map((pair) => {
    const on = pair[1];
    const c = C(`State=${pair[0]}`, 20, 20, on ? 'color/action' : 'color/surface',
                'radius/control', on ? null : 'color/border');
    if (on) c.appendChild(T('✓', 12, 'Bold', 'color/onAction'));
    return c;
  });
  const setCheck = figma.combineAsVariants(checks, page);
  setCheck.name = 'Checkbox' + suffix;
  ds.sets.push(['Checkbox', checks.length]);

  const toggles = [['Off', false], ['On', true]].map((pair) => {
    const on = pair[1];
    const c = C(`State=${pair[0]}`, 40, 22, on ? 'color/action' : 'color/border', 'radius/pill', null);
    const knob = figma.createEllipse();
    knob.resize(18, 18);
    knob.fills = [dsPaint('color/surface', VARS)];
    c.appendChild(knob);
    c.primaryAxisAlignItems = on ? 'MAX' : 'MIN';
    c.paddingLeft = on ? 0 : 2;
    c.paddingRight = on ? 2 : 0;
    return c;
  });
  const setToggle = figma.combineAsVariants(toggles, page);
  setToggle.name = 'Toggle' + suffix;
  ds.sets.push(['Toggle', toggles.length]);

  // ---- аватары
  const avatars = [16, 24, 32, 40].map((size) => {
    const c = C(`Size=${size}`, size, size, 'color/action', 'radius/pill', null);
    c.appendChild(T('А', Math.max(9, Math.round(size * 0.42)), 'Bold', 'color/onAction'));
    return c;
  });
  const setAvatar = figma.combineAsVariants(avatars, page);
  setAvatar.name = 'Avatar' + suffix;
  ds.sets.push(['Avatar', avatars.length]);

  // ---- карточки
  const cards = [];
  {
    const c = C('Kind=Plain', 320, 120, 'color/surface', 'radius/card', 'color/border');
    c.layoutMode = 'VERTICAL';
    c.primaryAxisAlignItems = 'MIN';
    c.counterAxisAlignItems = 'MIN';
    c.paddingLeft = 20; c.paddingRight = 20; c.paddingTop = 20; c.paddingBottom = 20;
    c.itemSpacing = 8;
    c.appendChild(T('Заголовок карточки', 15, 'Bold', 'color/text'));
    c.appendChild(T('Пояснение в одну строку', 12, 'Medium', 'color/textMuted'));
    cards.push(c);
  }
  {
    const c = C('Kind=KPI', 273, 96, 'color/surface', 'radius/card', 'color/border');
    c.layoutMode = 'VERTICAL';
    c.primaryAxisAlignItems = 'MIN';
    c.counterAxisAlignItems = 'MIN';
    c.paddingLeft = 20; c.paddingRight = 20; c.paddingTop = 16; c.paddingBottom = 16;
    c.itemSpacing = 4;
    c.appendChild(T('Просрочено', 12, 'Medium', 'color/textMuted'));
    c.appendChild(T('4', 28, 'Bold', 'color/text'));
    cards.push(c);
  }
  const setCard = figma.combineAsVariants(cards, page);
  setCard.name = 'Card' + suffix;
  ds.sets.push(['Card', cards.length]);

  // ---- строка таблицы
  const ROWS = [['Default', 'color/surface'], ['Hover', 'color/surfaceSoft'], ['Selected', 'color/actionBg']];
  const rows = ROWS.map((pair) => {
    const c = C(`State=${pair[0]}`, 720, 48, pair[1], null, null);
    c.primaryAxisAlignItems = 'MIN';
    c.paddingLeft = 20;
    c.paddingRight = 20;
    c.itemSpacing = 16;
    c.appendChild(T('TASK-142', 12, 'Semi Bold', 'color/action'));
    c.appendChild(T('Реализовать JWT-аутентификацию', 13, 'Semi Bold', 'color/text'));
    return c;
  });
  const setRow = figma.combineAsVariants(rows, page);
  setRow.name = 'Row / Task' + suffix;
  ds.sets.push(['Row / Task', rows.length]);

  // ---- иконки
  const icons = [];
  for (const name of Object.keys(DS_ICONS)) {
    try {
      const c = figma.createComponent();
      c.name = `Name=${name}`;
      c.resize(24, 24);
      c.fills = [];
      // createVector + vectorPaths на этой версии Figma не срабатывает,
      // а createNodeFromSvg — рабочий путь, им пользуется сам мост.
      const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
        + '<path d="' + DS_ICONS[name] + '" fill="none" stroke="#64748B" stroke-width="1.6"'
        + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const art = figma.createNodeFromSvg(markup);
      trackCreated(art);
      art.name = name;
      c.appendChild(art);
      art.x = 0;
      art.y = 0;
      try { art.resize(24, 24); } catch (e2) { /* уже нужного размера */ }
      const paintIt = (n) => {
        try { if (n.strokes && n.strokes.length) n.strokes = [dsPaint('color/textMuted', VARS)]; }
        catch (e2) { /* обводку не привязать — останется цвет из разметки */ }
      };
      paintIt(art);
      let artKids = [];
      try { artKids = Array.from(art.children); }
      catch (e2) { artKids = await art.getChildrenAsync(); }
      for (const k of artKids) paintIt(k);
      icons.push(c);
      ds.icons++;
    } catch (e) {
      ds.failed.push(name + ': ' + ((e && e.message) || e));
    }
  }
  let setIcon = null;
  if (icons.length) {
    setIcon = figma.combineAsVariants(icons, page);
    setIcon.name = 'Icon' + suffix;
    ds.sets.push(['Icon', icons.length]);
  }

  // ---- раскладка в столбец с подписями
  const all = [setButton, setInput, setBadge, setPrio, setChip, setCheck, setToggle,
               setAvatar, setCard, setRow].concat(setIcon ? [setIcon] : []);
  let y = 0;
  for (const s of all) {
    if (!s) continue;
    s.x = 0;
    s.y = y + 60;
    const t = figma.createText();
    t.fontName = { family: 'Inter', style: 'Bold' };
    t.characters = s.name;
    t.fontSize = 24;
    t.fills = [{ type: 'SOLID', color: { r: 0.09, g: 0.13, b: 0.2 } }];
    t.name = 'подпись-' + s.name;
    t.x = 0;
    t.y = y;
    page.appendChild(t);
    y = s.y + s.height + 140;
  }

  ds.components = ds.sets.reduce((sum, pair) => sum + pair[1], 0);

  // ---- карта «набор → вариант → id»: по ней ставятся инстансы на экранах
  for (const s of all) {
    if (!s || s.type !== 'COMPONENT_SET') continue;
    let variants;
    try { variants = Array.from(s.children); }
    catch (e) { variants = await s.getChildrenAsync(); }
    ds.map[s.name] = {};
    for (const v of variants) ds.map[s.name][v.name] = v.id;
  }

  try { figma.viewport.scrollAndZoomIntoView(all.filter(Boolean)); } catch (e) { /* не критично */ }
  return ds;
}

function dsHex(h) {
  const s = h.replace('#', '');
  return { r: parseInt(s.slice(0, 2), 16) / 255,
           g: parseInt(s.slice(2, 4), 16) / 255,
           b: parseInt(s.slice(4, 6), 16) / 255 };
}

function dsPaint(varName, VARS) {
  const v = VARS[varName];
  const base = { type: 'SOLID', color: { r: 0, g: 0, b: 0 } };
  if (!v) return base;
  try { return figma.variables.setBoundVariableForPaint(base, 'color', v); }
  catch (e) { return base; }
}

function dsText(chars, size, weight, colorVar, VARS) {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: weight };
  t.characters = chars;
  t.fontSize = size;
  t.fills = [dsPaint(colorVar, VARS)];
  return t;
}

function dsComp(name, w, h, fillVar, radiusVar, strokeVar, VARS) {
  const c = figma.createComponent();
  c.name = name;
  c.resize(w, h);
  c.layoutMode = 'HORIZONTAL';
  c.primaryAxisSizingMode = 'FIXED';
  c.counterAxisSizingMode = 'FIXED';
  c.primaryAxisAlignItems = 'CENTER';
  c.counterAxisAlignItems = 'CENTER';
  c.fills = fillVar ? [dsPaint(fillVar, VARS)] : [];
  const rv = VARS[radiusVar];
  if (rv) { try { c.setBoundVariable('cornerRadius', rv); } catch (e) { /* необязательно */ } }
  if (strokeVar) { c.strokes = [dsPaint(strokeVar, VARS)]; c.strokeWeight = 1; }
  return c;
}

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'design-system') {
    try {
      const t0 = Date.now();
      const ds = await buildDesignSystem(msg.theme || 'Light');
      post({
        type: 'done',
        requestId: msg.requestId || null,
        name: 'Дизайн-система',
        ms: Date.now() - t0,
        report: Object.assign({ stats: { frames: 0, texts: 0, autoLayout: 0, absolute: 0 } }, ds),
      });
      figma.notify('Система собрана: переменных ' + ds.variables +
                   ', компонентов ' + ds.components + (ds.failed.length ? ', иконки не вышли: ' + ds.failed.join(', ') : ''));
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId || null, message: String((e && e.message) || e) });
    }
    return;
  }


  if (msg.type === 'asset-chunk') {
    for (const item of msg.assets || []) {
      if (item && item.id && item.bytes) runtime.assetBytes.set(item.id, item.bytes);
    }
    post({ type: 'asset-chunk-ack', count: (msg.assets || []).length });
    return;
  }

  if (msg.type === 'import' || msg.type === 'design') {
    if (busy) { post({ type: 'error', requestId: msg.requestId || null, message: 'Уже идёт построение — дождитесь окончания.' }); return; }
    busy = true;
    const t0 = Date.now();
    try {
      // options.page — собрать на конкретной странице, создав её при надобности
      const wantPage = msg.options && msg.options.page;
      if (wantPage) {        let pages;
        try { pages = figma.root.children; }
        catch (e) { pages = await figma.root.getChildrenAsync(); }
        let pg = pages.find((x) => x.name === wantPage);
        if (!pg) pg = figma.createPage();
        pg.name = wantPage;
        if (figma.currentPage !== pg) {
          if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(pg);
          else figma.currentPage = pg;
        }
        // dynamic-page: если нужная страница УЖЕ текущая, setCurrentPageAsync не
        // вызывается — и её граф узлов в этой сессии плагина не загружен. Тогда
        // appendChild падает с «page has not been explicitly loaded». Грузим явно.
        try {
          if (typeof pg.loadAsync === 'function') await pg.loadAsync();
        } catch (e) {
          try { if (typeof figma.loadAllPagesAsync === 'function') await figma.loadAllPagesAsync(); }
          catch (e2) { /* страница уже загружена — ничего страшного */ }
        }
      }
      // Один раз за сессию грузим ВСЕ страницы: иначе компоненты дизайн-системы
      // берутся с выгруженной страницы, и каждый инстанс стоит секунды.
      if (!pagesLoaded) {
        try {
          if (typeof figma.loadAllPagesAsync === 'function') {
            await figma.loadAllPagesAsync();
            pagesLoaded = true;
          }
        } catch (e) { /* останется постраничная загрузка ниже */ }
      }
      const tBuild = Date.now();
      const result = await Promise.race([
        runImport(msg),
        new Promise((_, rej) => setTimeout(() => rej(new Error(
          'сборка не завершилась за 180 с — снята сторожевым таймером плагина. ' +
          'Последний слой: «' + (runtime.currentNode || '—') + '»')), 180000)),
      ]);
      const buildMs = Date.now() - tBuild;
      const node = result.rootFrame;

      // Поставить рядом с тем, что уже есть, чтобы импорты не накладывались
      try {
        const offset = (msg.options && msg.options.offset) || 0;
        const center = figma.viewport.center;
        node.x = Math.round(center.x - node.width / 2 + offset);
        node.y = Math.round(center.y - node.height / 2);
      } catch (e) { /* noop */ }

      post({ type: 'progress', phase: 'кадр собран, кладу на страницу', done: 0, total: 1 });
      const tAppend = Date.now();
      try {
        figma.currentPage.appendChild(node);
      } catch (e) {
        throw new Error('кадр не лёг на страницу «' + figma.currentPage.name + '»: ' +
                        ((e && e.message) || e));
      }
      const appendMs = Date.now() - tAppend;
      // Пакетная сборка (options.quiet) не трогает вид: приближение к кадру и
      // выделение на странице с сотнями слоёв стоят минуты — замер: 120 с на один
      // кадр 1440×1024 с инстансами. Геометрии это не касается, а сборку серии
      // окон такой шаг превращает в получасовую.
      post({ type: 'progress', phase: 'кадр на странице', done: 0, total: 1 });
      const quiet = !!(msg.options && msg.options.quiet);
      if (!quiet) {
        try { figma.viewport.scrollAndZoomIntoView([node]); } catch (e) { /* noop */ }
        try { figma.currentPage.selection = [node]; } catch (e) { /* noop */ }
      }

      post({
        type: 'done',
        requestId: msg.requestId || null,
        nodeId: node.id,
        name: node.name,
        ms: Date.now() - t0,
        report: Object.assign({}, result.report,
          { timings: { buildMs, appendMs, quiet, pagesLoaded } }),
      });
      if (!quiet) {
        figma.notify(`Готово: ${node.width}×${node.height}, слоёв ${result.report.stats.frames + result.report.stats.texts + result.report.stats.images + result.report.stats.svgs}`);
      }
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId || null, message: String((e && e.message) || e) });
    } finally {
      busy = false;
    }
    return;
  }

  if (msg.type === 'export-png') {
    try {
      const nodes = [];
      for (const id of msg.nodeIds || []) {
        const n = await figma.getNodeByIdAsync(id);
        if (n && n.exportAsync) nodes.push(n);
      }
      const images = [];
      for (const n of nodes) {
        const bytes = await n.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: msg.scale || 1 },
        });
        images.push({ id: n.id, name: n.name, base64: figma.base64Encode(bytes) });
      }
      post({ type: 'export-png-result', requestId: msg.requestId || null, images });
    } catch (e) {
      post({ type: 'export-png-result', requestId: msg.requestId || null, error: String((e && e.message) || e) });
    }
    return;
  }

  if (msg.type === 'selftest') {
    try {
      const report = await selfTest();
      post({ type: 'selftest-result', requestId: msg.requestId || null, report });
      const bad = report.results.filter((r) => !r.ok);
      figma.notify(bad.length
        ? `Проверка: ${report.total - bad.length} из ${report.total} работают. Не работают: ${bad.length}`
        : `Проверка пройдена полностью: ${report.total} из ${report.total}`,
      bad.length ? { error: false } : undefined);
    } catch (e) {
      post({ type: 'selftest-result', requestId: msg.requestId || null, error: String((e && e.message) || e) });
    }
    return;
  }

  if (msg.type === 'delete') {
    const removed = [];
    const failed = [];
    for (const id of msg.nodeIds || []) {
      try {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) { failed.push({ id, reason: 'не найден' }); continue; }
        if (n.type === 'PAGE' || n.type === 'DOCUMENT') {
          failed.push({ id, reason: 'страницу удалять нельзя' });
          continue;
        }
        const name = n.name;
        n.remove();
        removed.push({ id, name });
      } catch (e) {
        failed.push({ id, reason: String((e && e.message) || e) });
      }
    }
    post({ type: 'delete-result', requestId: msg.requestId || null, removed, failed });
    return;
  }

  if (msg.type === 'select') {
    try {
      const nodes = [];
      for (const id of msg.nodeIds || []) {
        const n = await figma.getNodeByIdAsync(id);
        if (n) nodes.push(n);
      }
      figma.currentPage.selection = nodes;
      if (nodes.length) { try { figma.viewport.scrollAndZoomIntoView(nodes); } catch (e2) { /* noop */ } }
      post({ type: 'select-result', requestId: msg.requestId || null, count: nodes.length });
    } catch (e) {
      post({ type: 'select-result', requestId: msg.requestId || null, error: String((e && e.message) || e) });
    }
    return;
  }

  if (msg.type === 'state') {
    const page = figma.currentPage;
    const info = {
      type: 'state-result',
      requestId: msg.requestId || null,
      fileName: safeRootName(),
      pageName: page ? page.name : '',
      selection: (page ? page.selection : []).map((n) => ({
        id: n.id, name: n.name, type: n.type,
        x: n.x, y: n.y, width: n.width, height: n.height,
      })),
      // Список слоёв холста: без него нельзя ни найти импортированное,
      // ни снять с него скриншот для проверки
      pageChildren: page ? page.children.slice(0, 300).map((n) => ({
        id: n.id, name: n.name, type: n.type,
        x: Math.round(n.x), y: Math.round(n.y),
        width: Math.round(n.width), height: Math.round(n.height),
      })) : [],
      version: PLUGIN_VERSION,
    };
    post(info);
    return;
  }

  if (msg.type === 'notice') {
    figma.notify(String(msg.message || ''), msg.error ? { error: true } : undefined);
    return;
  }
};

/* ========================================================================
 * 7. ТЕСТОВЫЙ ВЫХОД (в песочнице Figma `module` не существует)
 * ===================================================================== */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseColor,
    parseBoxShadow,
    parseGradient,
    backgroundToFills,
    splitTopLevel,
    numbers,
    styleTraits,
    pickStyle,
    predictFlex,
    autoLayoutPlan,
    textAlignOf,
    textCaseOf,
    runtime,
    runImport,
    selfTest,
    PLUGIN_VERSION,
    __setFontIndex: (m) => { fontIndex = m; },
    __fonts: () => ({ fontIndex, loadedFonts, fontResolveCache }),
  };
}
