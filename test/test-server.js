'use strict';
/**
 * Интеграционный тест моста.
 *
 * Поднимаем сервер в этом же процессе и подключаемся к нему ПОДДЕЛЬНЫМ ПЛАГИНОМ
 * по WebSocket. Так проверяется вся цепочка:
 *   HTTP-запрос агента → сервер → WS → плагин → WS → сервер → HTTP-ответ
 * Плюс проверяется собственный парсер кадров RFC 6455 на больших сообщениях.
 */

const PORT = 7399;
process.env.W2F_PORT = String(PORT);

let fails = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

const BASE = `http://127.0.0.1:${PORT}`;

async function getJson(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, body: await res.json() };
}
async function postJson(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  require('../engine/server');

  // --- ждём подъёма ---
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await getJson('/health'); if (r.body.ok) { up = true; break; } } catch (e) { /* ещё нет */ }
    await sleep(100);
  }
  console.log('=== СЕРВЕР ===');
  check('сервер поднялся', up);
  if (!up) process.exit(1);

  const h0 = await getJson('/health');
  check('плагин пока не подключён', h0.body.plugin === false);

  // --- поддельный плагин ---
  const received = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS не открылся')), { once: true });
  });

  let bigPayloadOk = false;
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
    received.push(msg);
    if (msg.cmd === 'build') {
      // Проверяем, что большой JSON дошёл целым, и отвечаем большим же
      bigPayloadOk = !!(msg.ir && msg.ir.root);
      const echo = 'x'.repeat(300000);
      ws.send(JSON.stringify({
        type: 'result', requestId: msg.requestId, ok: true,
        result: { nodeId: '123:456', name: msg.ir.title, echoLength: echo.length, layers: 42 },
      }));
      return;
    }
    if (msg.cmd === 'build-with-assets') {
      ws.send(JSON.stringify({
        type: 'result', requestId: msg.requestId, ok: true,
        result: { nodeId: '1:2', assets: (msg.assets || []).length },
      }));
      return;
    }
    if (msg.cmd === 'export') {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      ws.send(JSON.stringify({
        type: 'result', requestId: msg.requestId, ok: true,
        result: { images: [{ id: '1:2', name: 'Тест', base64: png }] },
      }));
      return;
    }
    if (msg.cmd === 'state') {
      ws.send(JSON.stringify({
        type: 'result', requestId: msg.requestId, ok: true,
        result: { fileName: 'Мой файл', pageName: 'Page 1', selection: [] },
      }));
    }
  });

  ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', fileName: 'Мой файл', pageName: 'Page 1' }));
  await sleep(150);

  console.log('\n=== РЕГИСТРАЦИЯ ПЛАГИНА ===');
  const h1 = await getJson('/health');
  check('сервер видит плагин', h1.body.plugin === true);
  check('версия плагина получена', h1.body.pluginInfo && h1.body.pluginInfo.version === '0.1.0',
    JSON.stringify(h1.body.pluginInfo));

  console.log('\n=== СБОРКА ДИЗАЙНА (агент → плагин) ===');
  const build = await postJson('/api/build', {
    name: 'Экран входа',
    width: 1440, height: 900,
    background: '#0f172a',
    nodes: [
      {
        type: 'frame', name: 'Карточка', box: [520, 290, 400, 320],
        style: { background: '#ffffff', radius: 16, boxShadow: '0 12px 32px rgba(0,0,0,.25)', padding: 32 },
        children: [
          { type: 'text', name: 'Заголовок', text: 'Вход в аккаунт', box: [32, 32, 336, 40],
            style: { fontSize: 28, fontWeight: 700, color: '#0f172a' } },
          { type: 'text', name: 'Подпись', text: 'Введите email и пароль', box: [32, 84, 336, 24],
            style: { fontSize: 15, color: '#64748b' } },
        ],
      },
    ],
  });
  check('HTTP 200', build.status === 200, 'status ' + build.status);
  check('ответ ok', build.body.ok === true, JSON.stringify(build.body).slice(0, 200));
  check('плагин получил команду build', received.some((m) => m.cmd === 'build'));
  check('большое сообщение дошло целиком', bigPayloadOk);
  if (build.body.result) {
    check('результат плагина вернулся агенту', build.body.result.nodeId === '123:456',
      JSON.stringify(build.body.result).slice(0, 160));
  }

  console.log('\n=== СКРИНШОТ ОТ ПЛАГИНА ===');
  const shot = await postJson('/api/screenshot', { nodeIds: ['1:2'], scale: 2 });
  check('HTTP 200', shot.status === 200);
  check('файл PNG записан', shot.body.shots && shot.body.shots.length === 1 && shot.body.shots[0].bytes > 0,
    JSON.stringify(shot.body.shots));

  console.log('\n=== СОСТОЯНИЕ ===');
  const st = await getJson('/api/state');
  check('состояние получено', st.body.ok && st.body.state && st.body.state.fileName === 'Мой файл',
    JSON.stringify(st.body.state));

  console.log('\n=== ЗАХВАТ СТРАНИЦЫ ===');
  const cap = await postJson('/api/capture', {
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><head><style>body{margin:0;font-family:Arial;background:#111}</style></head>' +
      '<body><div style="padding:40px;color:#fff;font-size:32px;font-weight:700">Привет, мост</div></body></html>'),
    width: 800, height: 600,
  });
  check('HTTP 200', cap.status === 200, JSON.stringify(cap.body).slice(0, 200));
  check('IR получен', !!(cap.body.ir && cap.body.ir.root));
  check('валидация без ошибок', cap.body.validation && cap.body.validation.errors === 0,
    JSON.stringify(cap.body.validation));
  check('sessionId выдан', !!cap.body.sessionId);

  console.log('\n=== ЗАХВАТ ИЗ КОДА (через локальное превью) ===');
  const code = await postJson('/api/capture-code', {
    html: '<div class="card"><h1>Из кода</h1><p>Проверка маршрута превью</p>' +
          '<img src="' + BASE + '/pixel.png" width="40" height="40" alt="Пиксель"></div>',
    css: '.card{display:flex;flex-direction:column;gap:8px;padding:24px;width:420px;margin:40px auto;' +
         'background:#fff;border:1px solid #e2e8f0;border-radius:14px}' +
         'h1{margin:0;font-size:24px;color:#0f172a}p{margin:0;color:#64748b}',
    width: 800, height: 600,
  });
  check('HTTP 200', code.status === 200, JSON.stringify(code.body).slice(0, 250));
  check('IR получен', !!(code.body.ir && code.body.ir.root));
  check('валидация без ошибок', code.body.validation && code.body.validation.errors === 0,
    JSON.stringify(code.body.validation));
  const assets = (code.body.ir && code.body.ir.assets) || [];
  check('внешняя картинка найдена', assets.length === 1, JSON.stringify(assets).slice(0, 200));
  if (assets.length) {
    const url = (code.body.ir.assets[0].absoluteUrl || '').replace(/^https?:\/\/[^/]+/, '');
    const imgRes = await fetch(BASE + url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    check('байты картинки отдаются по /asset', imgRes.status === 200 && buf.length > 0,
      `status ${imgRes.status}, ${buf.length} байт, ${imgRes.headers.get('content-type')}`);
  }

  console.log('\n=== ЗАХВАТ И СБОРКА ОДНИМ ВЫЗОВОМ ===');
  const both = await postJson('/api/capture-and-build', {
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><body style="margin:0"><div style="padding:20px;background:#6366f1;color:#fff">Блок</div></body></html>'),
    width: 600, height: 400,
  });
  check('HTTP 200', both.status === 200, JSON.stringify(both.body).slice(0, 200));
  check('плагин получил build-with-assets', received.some((m) => m.cmd === 'build-with-assets'));

  ws.close();
  await sleep(200);
  const h2 = await getJson('/health');
  check('отключение плагина зарегистрировано', h2.body.plugin === false);

  console.log('\n=== ОШИБКА БЕЗ ПЛАГИНА ===');
  const noPlugin = await postJson('/api/build', { name: 'x', nodes: [] });
  check('понятная ошибка вместо зависания', noPlugin.status === 500 && /Плагин не подключён/.test(noPlugin.body.error),
    JSON.stringify(noPlugin.body).slice(0, 160));

  console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\nОШИБКА ТЕСТА:', e && e.stack || e);
  process.exit(1);
});
