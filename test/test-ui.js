'use strict';
/**
 * Дымовой тест интерфейса плагина.
 * Открываем ui.html в настоящем Chrome и проверяем, что скрипт не падает,
 * видит движок и реально доводит запрос захвата до конца.
 */

const PORT = 7401;
process.env.W2F_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const { Browser, sleep } = require('../engine/browser');

let fails = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

(async () => {
  require('../engine/server');
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch (e) { /* ждём */ }
    await sleep(100);
  }

  const browser = new Browser({ headless: true, profileMode: 'clean' });
  await browser.launch();
  const page = await browser.openPage(BASE + '/ui?engine=' + encodeURIComponent(BASE), { width: 520, height: 900 });

  const consoleErrors = [];
  const exceptions = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      consoleErrors.push((p.args || []).map((a) => a.value || a.description || '').join(' '));
    }
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'исключение');
  });

  // Ждём, пока UI опросит движок и подключит WebSocket
  await sleep(2500);

  console.log('=== ЗАГРУЗКА ИНТЕРФЕЙСА ===');
  const state = await page.evaluate(() => ({
    fileState: document.getElementById('filestate').textContent,
    dot: document.getElementById('dot').className,
    goUrlDisabled: document.getElementById('goUrl').disabled,
    goCodeDisabled: document.getElementById('goCode').disabled,
    tabs: Array.from(document.querySelectorAll('nav button')).map((b) => b.textContent),
    panes: document.querySelectorAll('.pane').length,
    logText: document.getElementById('log').textContent.slice(0, 200),
  }));

  check('нет исключений в скрипте', exceptions.length === 0, exceptions.join(' | ').slice(0, 300));
  check('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
  check('движок обнаружен', /движок работает/.test(state.fileState), state.fileState);
  check('индикатор связи горит', /dot on/.test(state.dot), state.dot);
  check('кнопки разблокированы', !state.goUrlDisabled && !state.goCodeDisabled);
  check('три вкладки на месте', state.tabs.length === 3, JSON.stringify(state.tabs));
  check('три панели на месте', state.panes === 3, String(state.panes));

  console.log('\n=== ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК ===');
  const tabsOk = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[1].click();
    const after = {
      activeBtn: document.querySelector('nav button.active').dataset.pane,
      activePane: document.querySelector('.pane.active').id,
    };
    btns[2].click();
    const after2 = {
      activeBtn: document.querySelector('nav button.active').dataset.pane,
      activePane: document.querySelector('.pane.active').id,
    };
    btns[0].click();
    return { after, after2, back: document.querySelector('.pane.active').id };
  });
  check('вкладка «Код» открывается', tabsOk.after.activePane === 'pane-code', JSON.stringify(tabsOk.after));
  check('вкладка «Мост» открывается', tabsOk.after2.activePane === 'pane-bridge', JSON.stringify(tabsOk.after2));
  check('возврат на «Сайт»', tabsOk.back === 'pane-url', tabsOk.back);

  console.log('\n=== ИМПОРТ КОДА ЧЕРЕЗ ИНТЕРФЕЙС ===');
  await page.evaluate(() => {
    document.getElementById('html').value =
      '<div class="card"><h1>Проверка интерфейса</h1><p>Кнопка должна довести это до движка</p></div>';
    document.getElementById('css').value =
      '.card{display:flex;flex-direction:column;gap:8px;padding:24px;width:400px;margin:32px auto;' +
      'background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.1)}' +
      'h1{margin:0;font-size:22px}p{margin:0;color:#64748b}';
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[1].click();
    document.getElementById('goCode').click();
  });

  let logText = '';
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    logText = await page.evaluate(() => document.getElementById('log').textContent);
    if (/захвачено за/.test(logText)) break;
  }
  console.log('  журнал интерфейса:\n    ' + logText.split('\n').filter(Boolean).join('\n    '));
  check('интерфейс дошёл до движка', /Рендер кода в Chrome/.test(logText), '');
  check('движок вернул захват', /захвачено за/.test(logText), '');
  check('после импорта новых исключений нет', exceptions.length === 0, exceptions.join(' | ').slice(0, 300));

  await page.close();
  await browser.close();

  console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nВсе проверки пройдены.');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\nОШИБКА ТЕСТА:', e && e.stack || e);
  process.exit(1);
});
