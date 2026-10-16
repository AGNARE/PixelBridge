# -*- coding: utf-8 -*-
"""Движок раскладки для моста Web → Figma.

Даёт 100% авто-лейаут: размеры считаются из содержимого, координаты детей
назначаются ОТНОСИТЕЛЬНО РОДИТЕЛЯ, растяжимые элементы помечаются flex=True.

Использование:

    from layout_engine import F, ROW, COL, T, MARK, build
    card = COL("card", pad=20, gap=12, style={"background": "#FFFFFF", "radius": 12},
               children=[T("t", 300, "Заголовок", 16, 700)])
    build("01 — Экран", ROW("root", w=1440, h=1024, children=[card]), bg="#F4F6F8")

Ключи style — CSS или camelCase: background, radius, border, padding, gap,
display, flexDirection, alignItems, boxShadow, textAlign, lineHeight, letterSpacing,
whiteSpace, opacity. Числа становятся px.

ЧЕГО НЕ ДЕЛАТЬ:
  * rgba в сплошной заливке → станет белым (в градиентах работает);
  * задавать высоту текста «на глаз» → считать строки × round(кегль × 1.35);
  * считать координаты от корня → только относительно родителя;
  * использовать justify-content → ставить распорку F(..., flex=True).
"""
import json
import urllib.request

BRIDGE = "http://127.0.0.1:7331"
FRAME_W, FRAME_H = 1440, 1024
ROW_OFFSET = 1560          # смещение следующего кадра, чтобы вставали в ряд


def post(path, body):
    req = urllib.request.Request(BRIDGE + path, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read().decode("utf-8"))


def get(path):
    with urllib.request.urlopen(BRIDGE + path, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


# ------------------------------------------------------------------ узлы
def _n(kind, name, w, h, style, children, flex=False):
    return {"type": kind, "name": name, "w": w, "h": h, "style": style or {},
            "children": children or [], "flex": flex}


def F(name, w=None, h=None, style=None, children=None, flex=False, dx=None, dy=None):
    """Обычный фрейм. dx/dy — только для детей нефлексового контейнера."""
    n = _n("frame", name, w, h, style, children, flex)
    if dx is not None:
        n["dx"] = dx
    if dy is not None:
        n["dy"] = dy
    return n


def ROW(name, w=None, h=None, gap=0, pad=0, align="center", style=None, children=None, flex=False):
    st = {"display": "flex", "flexDirection": "row", "alignItems": align, "gap": gap, "padding": pad}
    if style:
        st.update(style)
    return _n("frame", name, w, h, st, children, flex)


def COL(name, w=None, h=None, gap=0, pad=0, align=None, style=None, children=None, flex=False):
    st = {"display": "flex", "flexDirection": "column", "gap": gap, "padding": pad}
    if align:
        st["alignItems"] = align
    if style:
        st.update(style)
    return _n("frame", name, w, h, st, children, flex)


def T(name, w, s, size=13, weight=500, color="#172033", align=None, track=None, lines=None,
      color_var=None):
    """Текст. Высота = строки × round(кегль × 1.35).

    lines считается по количеству \\n, если не задать явно. Однострочный текст
    получает whiteSpace: nowrap — это делает высоту и ширину детерминированными.
    color_var — имя переменной дизайн-системы: тогда цвет не «зашит», а выдан
    переменной и меняется из одного места.
    """
    lh = round(size * 1.35)
    n = lines or (s.count("\n") + 1)
    st = {"fontFamily": "Inter", "fontSize": size, "fontWeight": weight, "color": color,
          "lineHeight": f"{lh}px"}
    if color_var:
        st["colorVar"] = color_var
    if n == 1:
        st["whiteSpace"] = "nowrap"
    if align:
        st["textAlign"] = align
    if track:
        st["letterSpacing"] = track
    node = _n("text", name, w, lh * n, st, [])
    node["text"] = s
    return node


def SVG(name, w, h, markup):
    """Вектор. markup — ПОЛНАЯ разметка вместе с корневым <svg>...</svg>."""
    return {"type": "svg", "name": name, "w": w, "h": h, "flex": False, "style": {},
            "children": [], "svg": markup}


def IMG(name, w, h, src):
    return {"type": "image", "name": name, "w": w, "h": h, "flex": False, "style": {},
            "children": [], "src": src}


def INST(name, w, h, component_id, texts=None, flex=False):
    """Инстанс компонента дизайн-системы.

    component_id — id КОНКРЕТНОГО варианта (не набора): так надёжнее, чем искать
    по имени, и работает при documentAccess: dynamic-page. Собирать экраны
    из инстансов, а не из примитивов, — единственный способ получить
    «поменял компонент → поменялось на всех экранах».

    texts — список строк: заменяет текстовые слои внутри инстанса по порядку.
    Без него кнопка скажет «Кнопка», а поле — «Поле ввода», потому что таков
    текст самого компонента. Вместо строки можно передать словарь
    {"text": ..., "color": "#..."} или {"text": ..., "colorVar": "color/text"}:
    тогда вместе с текстом меняется и его цвет — у компонента он свой, и
    подставленное значение иначе осталось бы цветом плейсхолдера.
    """
    node = {"type": "instance", "name": name, "w": w, "h": h, "style": {},
            "children": [], "flex": flex, "componentId": component_id}
    if texts:
        node["texts"] = [t if isinstance(t, dict) else str(t) for t in texts]
    return node


# --------------------------------------------------- размеры и раскладка
def resolve(node):
    """Считает размеры по содержимому снизу вверх, раздаёт остаток flex-детям."""
    st, kids = node["style"], node["children"]
    if node["type"] == "frame" and st.get("display") == "flex" and kids:
        for c in kids:
            resolve(c)
        pad = st.get("padding", 0) or 0
        gap = st.get("gap", 0) or 0
        horiz = st.get("flexDirection", "row") == "row"
        if horiz:
            if node["w"] is None:
                node["w"] = pad * 2 + sum(c["w"] for c in kids) + gap * (len(kids) - 1)
            if node["h"] is None:
                node["h"] = pad * 2 + max(c["h"] for c in kids)
            free = node["w"] - pad * 2 - sum(c["w"] for c in kids if not c["flex"]) - gap * (len(kids) - 1)
            fl = [c for c in kids if c["flex"]]
            for c in fl:
                c["w"] = max(1, round(free / len(fl)))
        else:
            if node["h"] is None:
                node["h"] = pad * 2 + sum(c["h"] for c in kids) + gap * (len(kids) - 1)
            if node["w"] is None:
                node["w"] = pad * 2 + max(c["w"] for c in kids)
            free = node["h"] - pad * 2 - sum(c["h"] for c in kids if not c["flex"]) - gap * (len(kids) - 1)
            fl = [c for c in kids if c["flex"]]
            for c in fl:
                c["h"] = max(1, round(free / len(fl)))
    else:
        for c in kids:
            resolve(c)
        # Пустой flex-контейнер (например, все пункты группы скрыты) раньше
        # оставался с w=h=None и ронял resolve() на max() по пустому списку.
        # Размер из отступов, но не None и не ноль — Figma не принимает 0.
        if node["type"] == "frame" and not kids:
            pad2 = (st.get("padding", 0) or 0) * 2
            if node["w"] is None:
                node["w"] = max(1, pad2)
            if node["h"] is None:
                node["h"] = max(1, pad2)
    return node["w"], node["h"]


def place(node, x=0, y=0):
    """Назначает box. x, y — ОТНОСИТЕЛЬНО РОДИТЕЛЯ (мост ждёт именно так)."""
    node["box"] = [round(x, 1), round(y, 1), node["w"], node["h"]]
    st, kids = node["style"], node["children"]
    if st.get("display") == "flex" and kids:
        pad = st.get("padding", 0) or 0
        gap = st.get("gap", 0) or 0
        horiz = st.get("flexDirection", "row") == "row"
        inner_w, inner_h = node["w"] - 2 * pad, node["h"] - 2 * pad
        if horiz:
            cx = pad
            for ch in kids:
                cy = pad + (inner_h - ch["h"]) / 2 if st.get("alignItems") == "center" else pad
                place(ch, cx, cy)
                cx += ch["w"] + gap
        else:
            cy = pad
            for ch in kids:
                place(ch, pad, cy)
                cy += ch["h"] + gap
    else:
        for ch in kids:
            place(ch, ch.get("dx", 0), ch.get("dy", 0))
    return node


# ------------------------------------------------------------------ сборка
def build(name, root, bg="#FFFFFF", offset=ROW_OFFSET, w=FRAME_W, h=FRAME_H,
          look=True, verbose=True, page=None, quiet=False, timeout_ms=None):
    """Собирает кадр. Возвращает (nodeId, stats).

    look=True (по умолчанию) сразу снимает PNG и печатает путь: правило «посмотреть
    глазами» встроено в инструмент, а не оставлено на память. Для пакетной сборки
    восьми кадров подряд ставить look=False и снять всё одним проходом в конце.

    offset ставит кадры в ряд: следующий ложится на предыдущий + offset.
    page — имя страницы Figma, куда собрать кадр (создастся при надобности).
    quiet — не трогать вид: без приближения к кадру и выделения. Замер на живой
    Figma: этот шаг стоит до 120 с на кадр с инстансами, поэтому для серийной
    сборки он обязателен. На геометрию не влияет.
    timeout_ms — сколько движок ждёт плагин (по умолчанию 120 с).
    """
    resolve(root)
    place(root, 0, 0)
    opts = {"offset": offset}
    if page:
        opts["page"] = page          # собрать на конкретной странице Figma
    if quiet:
        opts["quiet"] = True         # пакетная сборка: вид не трогаем
    body = {"name": name, "width": w, "height": h, "background": bg,
            "nodes": [root], "options": opts}
    if timeout_ms:
        body["timeoutMs"] = timeout_ms
    rep = post("/api/build", body)
    res = rep.get("result", {})
    st = res.get("report", {}).get("stats", {})
    node_id = res.get("nodeId")
    if verbose:
        print(f"{name}: {node_id} | авто-лейаут {st.get('autoLayout')} | "
              f"абсолютных {st.get('absolute')} | текстов {st.get('texts')}")
        for reason, n in res.get("report", {}).get("autoReasons", []):
            print(f"   не авто-лейаут: {reason} — {n}")
        for warn in res.get("report", {}).get("warnings", []):
            if "grid" not in warn:
                print("   предупреждение:", warn)
    if look and node_id:
        path = screenshot(node_id)
        print(f"   СНИМОК: {path}")
        print("   посмотри картинку прежде чем что-либо утверждать о результате")
    return node_id, st


def screenshot(node_id, scale=0.6):
    """Снимает кадр. Возвращает путь к PNG — открыть и посмотреть глазами."""
    return post("/api/screenshot", {"nodeIds": [node_id], "scale": scale})["shots"][0]["file"]


def wipe(prefixes):
    """Удаляет с холста кадры с указанными префиксами имён. Только свои."""
    st = get("/api/state")["state"]
    mine = [c["id"] for c in st["pageChildren"] if c["name"].startswith(tuple(prefixes))]
    if mine:
        post("/api/delete", {"nodeIds": mine})
    return len(mine)
