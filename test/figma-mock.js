'use strict';
/**
 * Мок Figma Plugin API для запуска code.js в Node.
 *
 * Главное: мок НАМЕРЕННО строгий. Он повторяет ограничения настоящего API,
 * иначе тесты доказывают только то, что код не падает.
 *   • нельзя задать fontName или characters у текста, пока шрифт не загружен;
 *   • нельзя resize у текста с авто-шириной;
 *   • нельзя appendChild в лист;
 *   • нельзя задать невалидные fills;
 *   • layoutMode доступен только фреймам.
 *
 * Плюс мок сам раскладывает авто-лейаут по документированному поведению Figma —
 * это независимая реализация, с которой можно сверять собственную проверку.
 */

const FONT_LIST = [
  { family: 'Inter', style: 'Thin' },
  { family: 'Inter', style: 'Extra Light' },
  { family: 'Inter', style: 'Light' },
  { family: 'Inter', style: 'Regular' },
  { family: 'Inter', style: 'Medium' },
  { family: 'Inter', style: 'Semi Bold' },
  { family: 'Inter', style: 'Bold' },
  { family: 'Inter', style: 'Extra Bold' },
  { family: 'Inter', style: 'Black' },
  { family: 'Inter', style: 'Italic' },
  { family: 'Inter', style: 'Bold Italic' },
  { family: 'Roboto', style: 'Regular' },
  { family: 'Roboto', style: 'Medium' },
  { family: 'Roboto', style: 'Bold' },
  { family: 'Roboto', style: 'Italic' },
  { family: 'Roboto Mono', style: 'Regular' },
  { family: 'Roboto Mono', style: 'Bold' },
  { family: 'Open Sans', style: 'Regular' },
  { family: 'Open Sans', style: 'Bold' },
  { family: 'Montserrat', style: 'Regular' },
  { family: 'Montserrat', style: 'Bold' },
];

function fontKey(f) { return `${f.family}||${f.style}`; }
const loadedFonts = new Set();

class MockError extends Error {}

function assertFontLoaded(fontName) {
  if (!fontName || !fontName.family || !fontName.style) {
    throw new MockError('fontName должен содержать family и style');
  }
  const key = fontKey(fontName);
  if (!loadedFonts.has(key)) {
    throw new MockError(`Шрифт не загружен: ${key}. Вызовите figma.loadFontAsync перед использованием.`);
  }
}

function validateFills(fills) {
  if (!Array.isArray(fills)) throw new MockError('fills должен быть массивом');
  for (const f of fills) {
    if (!f || typeof f !== 'object') throw new MockError('невалидная заливка');
    if (f.type === 'SOLID') {
      const c = f.color;
      if (!c || [c.r, c.g, c.b].some((v) => typeof v !== 'number' || v < 0 || v > 1)) {
        throw new MockError('невалидный цвет заливки: ' + JSON.stringify(c));
      }
    } else if (f.type === 'IMAGE') {
      if (!f.imageHash) throw new MockError('IMAGE-заливка без imageHash');
    } else if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') {
      const t = f.gradientTransform;
      if (!Array.isArray(t) || t.length !== 2 || !Array.isArray(t[0]) || t[0].length !== 3) {
        throw new MockError('невалидный gradientTransform');
      }
      if (!Array.isArray(f.gradientStops) || f.gradientStops.length < 2) {
        throw new MockError('в градиенте меньше двух остановок');
      }
      let prev = -1;
      for (const s of f.gradientStops) {
        if (typeof s.position !== 'number') throw new MockError('позиция остановки не число');
        if (s.position < prev - 1e-6) throw new MockError('позиции остановок не возрастают');
        prev = s.position;
      }
    } else {
      throw new MockError('неизвестный тип заливки: ' + f.type);
    }
  }
}

// ---------------------------------------------------------------------------
// Строгая проверка перечислений.
//
// Это не педантизм. Первый же реальный импорт упал с
//   layoutPositioning: Invalid enum value. Expected 'AUTO' | 'ABSOLUTE',
//   received 'INHERIT'
// а мок принимал что угодно и молчал. Снисходительный мок прячет
// нарушения API — значит, он обязан отвергать недопустимые значения.

function defineEnum(proto, name, allowed, initial) {
  const key = '_enum_' + name;
  Object.defineProperty(proto, name, {
    configurable: true,
    get() { return this[key] === undefined ? initial : this[key]; },
    set(v) {
      if (allowed.indexOf(v) === -1) {
        throw new MockError(`${name}: недопустимое значение ${JSON.stringify(v)}. ` +
          `Ожидается ${allowed.map((a) => `'${a}'`).join(' | ')}`);
      }
      this[key] = v;
    },
  });
}

function installEnumValidation() {
  const N = MockNode.prototype;
  const F = FrameNode.prototype;
  const T = TextNode.prototype;

  // Только для полей, у которых ещё НЕТ собственного аксессора:
  // layoutMode и textAutoResize переопределять нельзя — их сеттеры
  // пересчитывают раскладку и метрики текста.
  defineEnum(N, 'layoutPositioning', ['AUTO', 'ABSOLUTE'], 'AUTO');
  defineEnum(N, 'layoutAlign', ['INHERIT', 'STRETCH'], 'INHERIT');

  defineEnum(F, 'primaryAxisSizingMode', ['FIXED', 'AUTO'], 'FIXED');
  defineEnum(F, 'counterAxisSizingMode', ['FIXED', 'AUTO'], 'FIXED');
  defineEnum(F, 'primaryAxisAlignItems', ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'], 'MIN');
  defineEnum(F, 'counterAxisAlignItems', ['MIN', 'CENTER', 'MAX', 'BASELINE'], 'MIN');
  defineEnum(F, 'strokeAlign', ['INSIDE', 'OUTSIDE', 'CENTER'], 'INSIDE');

  defineEnum(T, 'textAlignHorizontal', ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'], 'LEFT');
  defineEnum(T, 'textAlignVertical', ['TOP', 'CENTER', 'BOTTOM'], 'TOP');
  defineEnum(T, 'textCase', ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED'], 'ORIGINAL');
  defineEnum(T, 'textDecoration', ['NONE', 'UNDERLINE', 'STRIKETHROUGH'], 'NONE');
  defineEnum(T, 'textTruncation', ['DISABLED', 'ENDING'], 'DISABLED');
}

// ---------------------------------------------------------------------------

let idCounter = 1;
const registry = new Map();

class MockNode {
  constructor(type) {
    this.id = `${idCounter++}:${Math.floor(idCounter * 7 + 1)}`;
    this.type = type;
    this.name = type;
    this._x = 0;
    this._y = 0;
    this._w = 1;
    this._h = 1;
    this.parent = null;
    this._children = [];
    this._fills = [];
    this._strokes = [];
    this._effects = [];
    this._opacity = 1;
    this._rotation = 0;
    this._pluginData = {};
    this.annotations = [];
    this.removed = false;
    registry.set(this.id, this);
  }

  get x() { return this._x; }
  set x(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new MockError('x должен быть числом');
    this._x = v;
  }
  get y() { return this._y; }
  set y(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new MockError('y должен быть числом');
    this._y = v;
  }
  get width() { return this._w; }
  get height() { return this._h; }

  get fills() { return this._fills; }
  set fills(v) { validateFills(v); this._fills = v; }
  get strokes() { return this._strokes; }
  set strokes(v) { validateFills(v); this._strokes = v; }
  get effects() { return this._effects; }
  set effects(v) {
    if (!Array.isArray(v)) throw new MockError('effects должен быть массивом');
    this._effects = v;
  }
  get opacity() { return this._opacity; }
  set opacity(v) { this._opacity = v; }
  get rotation() { return this._rotation; }
  set rotation(v) { this._rotation = v; }
  get children() { return this._children.slice(); }

  /**
   * Якоря grid-лейаута. В настоящей Figma их установка пересчитывает
   * раскладку немедленно, поэтому мок обязан делать то же — иначе последний
   * добавленный ребёнок остаётся в позиции по умолчанию.
   */
  get gridColumnAnchorIndex() { return this._gridCol || 0; }
  set gridColumnAnchorIndex(v) { this._gridCol = v; if (this.parent) this.parent._relayout(); }
  get gridRowAnchorIndex() { return this._gridRow || 0; }
  set gridRowAnchorIndex(v) { this._gridRow = v; if (this.parent) this.parent._relayout(); }
  get gridColumnSpan() { return this._gridColSpan || 1; }
  set gridColumnSpan(v) { this._gridColSpan = v; if (this.parent) this.parent._relayout(); }
  get gridRowSpan() { return this._gridRowSpan || 1; }
  set gridRowSpan(v) { this._gridRowSpan = v; if (this.parent) this.parent._relayout(); }

  setPluginData(key, value) {
    if (typeof key !== 'string' || key.length > 64) throw new MockError('ключ pluginData слишком длинный');
    if (typeof value !== 'string') throw new MockError('значение pluginData должно быть строкой');
    this._pluginData[key] = value;
  }
  getPluginData(key) { return this._pluginData[key] || ''; }

  resize(w, h) {
    if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) {
      throw new MockError('resize: нужны два числа');
    }
    this._w = Math.max(0.01, w);
    this._h = Math.max(0.01, h);
  }

  appendChild(node) {
    if (!(node instanceof MockNode)) throw new MockError('appendChild: не узел');
    if (this.type === 'RECTANGLE' || this.type === 'TEXT' || this.type === 'VECTOR') {
      throw new MockError(`appendChild: узел ${this.type} не может иметь детей`);
    }
    if (node === this) throw new MockError('нельзя вложить узел в себя');
    let p = this.parent;
    while (p) { if (p === node) throw new MockError('циклическая вложенность'); p = p.parent; }
    if (node.parent) node.parent._remove(node);
    node.parent = this;
    this._children.push(node);
    this._relayout();
    return node;
  }

  _remove(node) {
    const i = this._children.indexOf(node);
    if (i >= 0) this._children.splice(i, 1);
    node.parent = null;
    this._relayout();
  }

  /** Удалить узел из документа. */
  remove() {
    if (this.parent) this.parent._remove(this);
    this.removed = true;
    registry.delete(this.id);
  }

  _relayout() { /* базовые узлы не раскладывают детей */ }

  async exportAsync(opts) {
    return new Uint8Array([137, 80, 78, 71]);
  }
}

class FrameNode extends MockNode {
  constructor(type) {
    super(type || 'FRAME');
    this.clipsContent = true;
    this._layoutMode = 'NONE';
    this.primaryAxisSizingMode = 'FIXED';
    this.counterAxisSizingMode = 'FIXED';
    this.itemSpacing = 0;
    this.paddingLeft = 0;
    this.paddingRight = 0;
    this.paddingTop = 0;
    this.paddingBottom = 0;
    this.primaryAxisAlignItems = 'MIN';
    this.counterAxisAlignItems = 'MIN';
    this.gridColumnCount = 1;
    this.gridRowCount = 1;
    this.gridColumnGap = 0;
    this.gridRowGap = 0;
    this.cornerRadius = 0;
    this.strokeWeight = 0;
    this.strokeAlign = 'INSIDE';
    this.dashPattern = [];
    this._svg = null;
  }

  get layoutMode() { return this._layoutMode; }
  set layoutMode(v) {
    if (!['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID'].includes(v)) {
      throw new MockError('недопустимый layoutMode: ' + v);
    }
    this._layoutMode = v;
    this._relayout();
  }

  resize(w, h) {
    super.resize(w, h);
    this._relayout();
  }

  /** Раскладка детей по документированному поведению Figma. */
  _relayout() {
    if (this._layoutMode === 'GRID') return this._relayoutGrid();
    if (this._layoutMode !== 'HORIZONTAL' && this._layoutMode !== 'VERTICAL') return;
    const horizontal = this._layoutMode === 'HORIZONTAL';
    const flow = this._children.filter((c) => c.layoutPositioning !== 'ABSOLUTE');
    if (!flow.length) return;

    const contentW = this._w - this.paddingLeft - this.paddingRight;
    const contentH = this._h - this.paddingTop - this.paddingBottom;

    const mainSizes = flow.map((c) => (horizontal ? c.width : c.height));
    const totalMain = mainSizes.reduce((a, b) => a + b, 0) + this.itemSpacing * (flow.length - 1);
    const availableMain = horizontal ? contentW : contentH;
    const free = availableMain - totalMain;

    let start = 0;
    let extra = 0;
    if (this.primaryAxisAlignItems === 'CENTER') start = free / 2;
    else if (this.primaryAxisAlignItems === 'MAX') start = free;
    else if (this.primaryAxisAlignItems === 'SPACE_BETWEEN' && flow.length > 1) extra = free / (flow.length - 1);

    let cursor = start;
    for (let i = 0; i < flow.length; i++) {
      const c = flow[i];
      const main = mainSizes[i];
      const cross = horizontal ? c.height : c.width;
      const availableCross = horizontal ? contentH : contentW;
      let crossPos = 0;
      if (this.counterAxisAlignItems === 'CENTER') crossPos = (availableCross - cross) / 2;
      else if (this.counterAxisAlignItems === 'MAX') crossPos = availableCross - cross;
      else crossPos = 0;

      if (horizontal) {
        c._x = this.paddingLeft + cursor;
        c._y = this.paddingTop + crossPos;
      } else {
        c._x = this.paddingLeft + crossPos;
        c._y = this.paddingTop + cursor;
      }
      cursor += main + this.itemSpacing + extra;
    }
  }

  /**
   * Grid-лейаут Figma: дорожки — РАВНЫЕ ДОЛИ фрейма.
   * Именно из-за этого плагин включает grid только тогда, когда геометрия
   * подтверждает равные дорожки.
   */
  _relayoutGrid() {
    const flow = this._children.filter((c) => c.layoutPositioning !== 'ABSOLUTE');
    if (!flow.length) return;
    const nCols = Math.max(1, this.gridColumnCount | 0);
    const nRows = Math.max(1, this.gridRowCount | 0);
    const cg = this.gridColumnGap || 0;
    const rg = this.gridRowGap || 0;
    const contentW = this._w - this.paddingLeft - this.paddingRight;
    const contentH = this._h - this.paddingTop - this.paddingBottom;
    const tw = (contentW - (nCols - 1) * cg) / nCols;
    const th = (contentH - (nRows - 1) * rg) / nRows;
    for (const c of flow) {
      const col = Math.max(0, Math.min(nCols - 1, c.gridColumnAnchorIndex | 0));
      const row = Math.max(0, Math.min(nRows - 1, c.gridRowAnchorIndex | 0));
      c._x = this.paddingLeft + col * (tw + cg);
      c._y = this.paddingTop + row * (th + rg);
      // Figma растягивает элемент по его области
      const cs = Math.max(1, c.gridColumnSpan || 1);
      const rs = Math.max(1, c.gridRowSpan || 1);
      const w = cs * tw + (cs - 1) * cg;
      const h = rs * th + (rs - 1) * rg;
      // Текст свою высоту считает по содержимому
      if (c.type !== 'TEXT') {
        c._w = Math.max(0.01, w);
        c._h = Math.max(0.01, h);
      } else {
        c._w = Math.max(0.01, w);
      }
    }
  }
}

class TextNode extends MockNode {
  constructor() {
    super('TEXT');
    this._fontName = { family: 'Inter', style: 'Regular' };
    this._fontSize = 12;
    this._lineHeight = { unit: 'AUTO' };
    this._letterSpacing = { unit: 'PIXELS', value: 0 };
    this._characters = '';
    this.textAlignHorizontal = 'LEFT';
    this._textAutoResize = 'NONE';
    this.textDecoration = 'NONE';
    this.textCase = 'ORIGINAL';
    this.textTruncation = 'DISABLED';
    this.maxLines = null;
    this._ranges = [];
  }

  get fontName() { return this._fontName; }
  set fontName(v) { assertFontLoaded(v); this._fontName = v; this._recompute(); }
  get characters() { return this._characters; }
  set characters(v) {
    assertFontLoaded(this._fontName);
    this._characters = String(v);
    this._recompute();
  }
  get fontSize() { return this._fontSize; }
  set fontSize(v) { this._fontSize = v; this._recompute(); }
  get lineHeight() { return this._lineHeight; }
  set lineHeight(v) { this._lineHeight = v; this._recompute(); }
  get textAutoResize() { return this._textAutoResize; }
  set textAutoResize(v) {
    if (!['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'].includes(v)) {
      throw new MockError('недопустимый textAutoResize: ' + v);
    }
    this._textAutoResize = v;
    this._recompute();
  }

  resize(w, h) {
    if (this._textAutoResize === 'WIDTH_AND_HEIGHT') {
      throw new MockError('Нельзя resize у текста с autoResize WIDTH_AND_HEIGHT');
    }
    if (this._textAutoResize === 'HEIGHT') {
      // Ширина фиксируется, высота пересчитывается по содержимому
      this._w = Math.max(0.01, w);
      this._recompute();
      return;
    }
    super.resize(w, h);
    this._recompute();
  }

  _lineHeightPx() {
    if (this._lineHeight.unit === 'PIXELS') return this._lineHeight.value;
    if (this._lineHeight.unit === 'PERCENT') return (this._fontSize * this._lineHeight.value) / 100;
    return this._fontSize * 1.2;
  }

  /** Простая, но независимая модель метрик текста. */
  _recompute() {
    if (this._textAutoResize === 'WIDTH_AND_HEIGHT') {
      const lines = this._characters.split('\n');
      let maxW = 0;
      for (const l of lines) maxW = Math.max(maxW, this._estimateWidth(l));
      this._w = Math.max(1, maxW + this._letterSpacing.value * Math.max(0, this._characters.length - 1));
      this._h = Math.max(1, lines.length * this._lineHeightPx());
      return;
    }
    if (this._textAutoResize === 'HEIGHT' || this._textAutoResize === 'NONE') {
      let lines = this._wrapLines(this._w);
      // Обрезка с ограничением строк — как в Figma при textTruncation ENDING
      if (this.textTruncation === 'ENDING' && this.maxLines) {
        lines = Math.min(lines, this.maxLines);
      }
      if (this._textAutoResize === 'HEIGHT') {
        this._h = Math.max(1, lines * this._lineHeightPx());
      }
    }
  }

  _estimateWidth(s) {
    const bold = /bold|black|heavy|semibold|semi bold/i.test(this._fontName.style);
    const per = this._fontSize * (bold ? 0.58 : 0.53);
    return s.length * per;
  }

  _wrapLines(width) {
    let total = 0;
    for (const para of this._characters.split('\n')) {
      const w = this._estimateWidth(para);
      total += Math.max(1, Math.ceil(w / Math.max(1, width)));
    }
    return Math.max(1, total);
  }

  _checkRange(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > this._characters.length || start >= end) {
      throw new MockError(`некорректный диапазон ${start}..${end} при длине ${this._characters.length}`);
    }
  }
  setRangeFontName(s, e, v) { this._checkRange(s, e); assertFontLoaded(v); this._ranges.push({ s, e, font: v }); }
  setRangeFontSize(s, e, v) { this._checkRange(s, e); this._ranges.push({ s, e, size: v }); }
  setRangeFills(s, e, v) { this._checkRange(s, e); validateFills(v); this._ranges.push({ s, e, fills: v }); }
  setRangeLetterSpacing(s, e, v) { this._checkRange(s, e); this._ranges.push({ s, e, ls: v }); }
  setRangeTextDecoration(s, e, v) { this._checkRange(s, e); this._ranges.push({ s, e, deco: v }); }
  setRangeTextCase(s, e, v) { this._checkRange(s, e); this._ranges.push({ s, e, tc: v }); }
}

// ---------------------------------------------------------------------------

const messagesToUi = [];
let onMessageHandler = null;

const currentPage = new FrameNode('PAGE');
currentPage.name = 'Page 1';
currentPage._w = 0;
currentPage._h = 0;

const root = { name: 'Тестовый файл', type: 'DOCUMENT' };

const figmaMock = {
  root,
  currentPage,
  viewport: {
    center: { x: 0, y: 0 },
    scrollAndZoomIntoView() {},
  },
  notify() {},
  showUI() {},
  ui: {
    postMessage(msg) { messagesToUi.push(msg); },
    set onmessage(fn) { onMessageHandler = fn; },
    get onmessage() { return onMessageHandler; },
    resize() {},
    close() {},
  },
  mixed: Symbol('figma.mixed'),

  createFrame() { return new FrameNode('FRAME'); },
  createRectangle() { const r = new MockNode('RECTANGLE'); r._fills = []; return r; },
  createText() { return new TextNode(); },
  createNodeFromSvg(svg) {
    if (typeof svg !== 'string' || !/^\s*<svg[\s>]/i.test(svg)) {
      throw new MockError('createNodeFromSvg: строка не начинается с <svg');
    }
    if (!/<\/svg>\s*$/i.test(svg)) throw new MockError('createNodeFromSvg: незакрытый тег svg');
    const f = new FrameNode('FRAME');
    f._svg = svg;
    const wm = /\bwidth\s*=\s*"([\d.]+)"/.exec(svg);
    const hm = /\bheight\s*=\s*"([\d.]+)"/.exec(svg);
    f._w = wm ? parseFloat(wm[1]) : 100;
    f._h = hm ? parseFloat(hm[1]) : 100;
    return f;
  },
  createImage(bytes) {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
      throw new MockError('createImage: нужен Uint8Array или ArrayBuffer');
    }
    const len = bytes instanceof Uint8Array ? bytes.length : bytes.byteLength;
    if (len === 0) throw new MockError('createImage: пустые данные');
    return { hash: 'imghash_' + len + '_' + Math.floor(len * 31 % 99991) };
  },
  createPage() { const p = new FrameNode('PAGE'); registry.set(p.id, p); return p; },

  async loadFontAsync(fontName) {
    const key = fontKey(fontName);
    if (!FONT_LIST.some((f) => fontKey(f) === key)) {
      throw new MockError('Шрифт недоступен в этой среде: ' + key);
    }
    loadedFonts.add(key);
  },
  async listAvailableFontsAsync() {
    return FONT_LIST.map((fontName) => ({ fontName }));
  },
  async getNodeByIdAsync(id) { return registry.get(id) || null; },
  base64Decode(str) {
    return new Uint8Array(Buffer.from(String(str), 'base64'));
  },
  base64Encode(bytes) {
    return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
  },
};

// ---------------------------------------------------------------------------

function install() {
  installEnumValidation();
  global.figma = figmaMock;
  global.__html__ = '<html><body>мок UI</body></html>';
  messagesToUi.length = 0;
  onMessageHandler = null;
  return figmaMock;
}

function reset() {
  idCounter = 1;
  registry.clear();
  messagesToUi.length = 0;
  currentPage._children.length = 0;
  // Загруженные шрифты НЕ сбрасываются: в настоящей Figma они остаются
  // загруженными на всю жизнь плагина. Сброс здесь создавал ложную картину —
  // плагин считал шрифт загруженным, а мок про него «забывал».
}

/** Явный сброс шрифтов — только для тестов, которым нужен чистый старт. */
function resetFonts() {
  loadedFonts.clear();
}

function messages() { return messagesToUi.slice(); }

/** Отправить сообщение в плагин так, как это сделал бы UI. */
async function postToPlugin(msg) {
  if (!onMessageHandler) throw new Error('code.js не зарегистрировал figma.ui.onmessage');
  return onMessageHandler(msg);
}

/** Собрать дерево в простой объект для проверок. */
function dumpTree(node, depth) {
  const maxDepth = depth === undefined ? Infinity : depth;
  function walk(n, d) {
    const o = {
      id: n.id,
      type: n.type,
      name: n.name,
      x: Math.round(n.x * 100) / 100,
      y: Math.round(n.y * 100) / 100,
      w: Math.round(n.width * 100) / 100,
      h: Math.round(n.height * 100) / 100,
      children: [],
    };
    if (n._fills && n._fills.length) o.fills = n._fills.length;
    if (n.type === 'TEXT') {
      o.text = n.characters.slice(0, 60);
      o.font = `${n.fontName.family} ${n.fontName.style}`;
      o.fontSize = n.fontSize;
      o.autoResize = n.textAutoResize;
      o.ranges = n._ranges.length;
    }
    if (n._layoutMode && n._layoutMode !== 'NONE') {
      o.autoLayout = n._layoutMode;
      o.spacing = n.itemSpacing;
      o.align = `${n.primaryAxisAlignItems}/${n.counterAxisAlignItems}`;
    }
    if (n._svg) o.svg = n._svg.length;
    if (n._pluginData && n._pluginData['w2f.sel']) o.sel = n._pluginData['w2f.sel'];
    if (d < maxDepth && n._children) for (const c of n._children) o.children.push(walk(c, d + 1));
    return o;
  }
  return walk(node, 0);
}

function flatten(node, out) {
  const acc = out || [];
  acc.push(node);
  for (const c of node._children || []) flatten(c, acc);
  return acc;
}

module.exports = {
  install,
  reset,
  resetFonts,
  messages,
  postToPlugin,
  dumpTree,
  flatten,
  figmaMock,
  currentPage,
  MockError,
  FONT_LIST,
  loadedFonts,
};
