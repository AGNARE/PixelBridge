---
name: figma-bridge
description: Build designs directly on the user's Figma canvas and read the result back as a PNG. Use whenever the user asks to create, sketch, lay out or "накидать" anything in Figma ("накидай в фигме", "сделай макет", "нарисуй экран в Figma", "собери интерфейс"), to import a website / HTML / CSS into Figma, or to work with a Figma file programmatically. Requires the local bridge engine on 127.0.0.1:7331 and an open plugin window in Figma Desktop.
---

# Figma bridge

A local bridge lets you **write into the user's Figma canvas** and **read it back
as an image**. This is the only way to create Figma nodes programmatically: the
Figma REST API cannot create them, and the official Figma MCP server only reads
context. Everything goes through a plugin running in the user's own Figma.

The project lives at `C:\Users\Tima\Projects\figma-web-capture` — the folder this
skill was installed from; adjust the path if the repository was cloned elsewhere.
`start-engine.cmd` in that folder starts the bridge.

## Before anything else: check the bridge

```
GET http://127.0.0.1:7331/health
```

The answer tells you what you can do:

| Field | Meaning | If it is not what you need |
|---|---|---|
| `ok: true` | engine is running | start `start-engine.cmd` (see below) |
| `plugin: true` | the Figma plugin is open and connected | ask the user to run **Plugins → Development → Web → Figma Bridge** |

If the engine is not running, launch it **as a detached process** so it outlives
your session, or ask the user to double-click `start-engine.cmd`. Do not make it
a background job of the chat session: other chats need it too.

**Nothing works without an open plugin window.** The plugin holds the WebSocket
to the engine. Say so plainly instead of retrying.

## The core loop

You cannot see Figma. So build, then look, then fix:

1. `POST /api/build` — put your design on the canvas
2. `GET /api/state` — read `pageChildren` to find what you just created and its `id`
3. `POST /api/screenshot` with that `id` — get a PNG and actually look at it
4. Fix and repeat

Do not claim a design looks right without doing step 3 at least once.

## Read before the first build

Two companion files hold what earlier sessions paid for. Do not rediscover them:

- **[ПРАКТИКА.md](ПРАКТИКА.md)** — every rule in full, with the mistake behind it.
- **[layout-engine.py](layout-engine.py)** — a ready layout engine that produces
  **100% auto-layout**. Import it instead of computing boxes by hand.

The five rules that break builds most often:

1. **A child's `box` is relative to its parent**, never accumulated from the root.
   Root-relative coordinates make the plugin fall back to absolute layers for
   *every* container — one build lost 82 of 82 that way.
2. **Text height must be exact**: `lines × round(fontSize × 1.35)`, with explicit
   `\n` for multi-line. The plugin sets `textAutoResize = HEIGHT`, so Figma
   re-measures the text and a guessed height desynchronises the whole layout.
3. **`rgba()` in a solid fill turns into opaque white.** Alpha works inside
   gradients only. Build dark themes from stacked solid colours.
4. **New frames land in the viewport centre and overlap.** Pass
   `options: {"offset": 1560}` to lay a set out in a row. There is no
   "move node" endpoint — only a rebuild.
5. **`align-items` accepts only `center` / `flex-start`.** `top` silently means
   something else and the layout diverges.

When a build looks wrong and the report says nothing useful, the plugin can be
run **locally against its own Figma mock** to dump the real node tree — the recipe
is in ПРАКТИКА.md, section 5. That is how an empty `characters: ""` was found.

**Keep ПРАКТИКА.md current.** After any session that used the bridge, append what
cost time: surprising behaviour, a limit you hit, a trick that worked. An
unmaintained skill starts lying within a month. `layout-engine.py`'s `build()`
takes `look=True` by default and screenshots the result — the "look at it with
your own eyes" rule lives in the tool, not in good intentions.

## Endpoints

All are `POST` with a JSON body unless noted.

| Endpoint | Body | Purpose |
|---|---|---|
| `GET /health` | — | engine and plugin state |
| `GET /api/state` | — | file name, page, selection, `pageChildren` (id/name/size/position) |
| `POST /api/build` | design spec, see below | create layers |
| `POST /api/capture-and-build` | `{"url":"https://…","width":1440}` | capture a live website and build it |
| `POST /api/capture` | `{"url":"…","width":1440}` | capture only, returns IR JSON |
| `POST /api/capture-code` | `{"html":"…","css":"…","width":1440}` | render HTML/CSS in Chrome, returns IR |
| `POST /api/screenshot` | `{"nodeIds":["1:2"],"scale":1}` | export nodes to PNG; returns `shots[].file` on disk |
| `POST /api/select` | `{"nodeIds":[…]}` | select nodes (useful before a screenshot) |
| `POST /api/delete` | `{"nodeIds":[…]}` | delete nodes — **confirms nothing, be careful** |
| `GET /api/selftest` | — | what this Figma version supports |

## Design spec for `/api/build`

```json
{
  "name": "Экран входа",
  "width": 1440,
  "height": 900,
  "background": "#0f172a",
  "nodes": [
    {
      "type": "frame",
      "name": "Карточка",
      "box": [520, 250, 400, 400],
      "style": {
        "background": "#ffffff",
        "radius": 18,
        "boxShadow": "0 20px 60px rgba(0,0,0,.45)",
        "padding": 32
      },
      "children": [
        {
          "type": "text",
          "name": "Заголовок",
          "text": "Вход в аккаунт",
          "box": [32, 32, 336, 40],
          "style": { "fontSize": 28, "fontWeight": 700, "color": "#0f172a" }
        }
      ]
    }
  ]
}
```

Rules that matter:

- `box` is `[x, y, width, height]` **relative to the parent**, or an object
  `{x,y,w,h}`. `x`/`y` of the root are ignored — the frame is centred in the viewport.
- `type` is one of `frame`, `text`, `image`, `svg`, `input`.
- `style` keys may be CSS (`font-size`, `border-top-color`) or camelCase
  (`fontSize`, `color`, `background`, `radius`, `border: "1px solid #ccc"`,
  `padding`, `boxShadow`, `textAlign`, `lineHeight`, `letterSpacing`, `gap`,
  `display`, `flexDirection`, `justifyContent`, `alignItems`). Numbers become `px`.
- `src` on an `image` accepts an `http(s)` URL; the engine proxies it, so CORS
  is not your problem.

## What the report tells you

Both build endpoints return a `report`:

- `stats` — how many frames, texts, images, SVGs were created
- `stats.autoLayout` / `stats.absolute` — how many containers became **editable**
  Figma auto-layout versus fixed absolute coordinates
- `autoReasons` — why each container was refused auto-layout. Read this: it
  tells you where the layout is not editable
- `fontMap` / `missingFonts` — font substitutions
- `warnings` — honest caveats, read them

**Auto-layout is not free.** Figma auto-layout cannot express CSS margins on
children (the plugin wraps them), it needs equal grid tracks, and it refuses
`position: relative` offsets. If you want an editable design, build with
`display: "flex"`, explicit `gap`, and **positions that match what flex would
produce** — otherwise the plugin correctly falls back to absolute coordinates
and you lose editability.

The reliable way to get there is not to hand-place anything: use
[layout-engine.py](layout-engine.py). It sizes containers from their content,
marks stretchy elements with `flex=True`, and emits parent-relative coordinates,
so the plugin's `predictFlex` agrees and every container becomes auto-layout.
A healthy report is `autoLayout` = number of containers, `absolute` = 0.

## Reading a screenshot

`POST /api/screenshot` writes PNG files and returns their paths. Then use the
image-reading tool on that path. Screenshots of a full page can be very tall —
prefer `scale` between 0.25 and 0.5 for an overview, and screenshot a single
sub-frame for detail.

## Known limits of this Figma version

`GET /api/selftest` reports them precisely. As of the last check:

- **GRID auto-layout is unsupported** (cell anchors have no setter). Grid
  containers become absolute coordinates — geometrically exact, not editable.
- Everything else is supported: auto-layout, gradients, shadows, per-corner
  radius, per-side borders, text ranges, truncation, SVG, images, export.

## Housekeeping

- Every import selects its root frame, so `GET /api/state` → `selection[0].id`
  gives you the thing you just built.
- Failed builds clean up after themselves, but **test artifacts you create stay
  on the canvas**. Delete them with `/api/delete` when done, and say what you
  are deleting.
- Never delete nodes the user did not ask you to delete, and never delete a
  node you did not create.

## Capturing a website or HTML

`POST /api/capture-and-build` does the whole path: Chrome renders the page,
computed styles and geometry are extracted, images are downloaded and
**AVIF/SVG are re-encoded to PNG or JPEG** because `figma.createImage` rejects
them. Expect tens of seconds for a heavy page; the engine logs progress.

Useful options in the body: `width`, `height`, `profileMode`
(`clean` | `persistent` | `system`, the last for pages behind a login),
`options.autoLayout` (`safe` | `off` | `aggressive`), `options.offset`.
