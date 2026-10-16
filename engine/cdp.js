'use strict';
/**
 * Минимальный клиент Chrome DevTools Protocol.
 * Ноль зависимостей: WebSocket и fetch — встроены в Node 22.
 *
 * Поддерживает "flatten"-режим: все команды идут по одному WebSocket,
 * а принадлежность к вкладке определяется полем sessionId.
 */

class CdpError extends Error {
  constructor(message, method, code) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

class CdpConnection {
  /** @param {WebSocket} ws */
  constructor(ws, label = 'browser') {
    this.ws = ws;
    this.label = label;
    this._nextId = 1;
    this._pending = new Map();
    this._handlers = new Map();
    this._closed = false;
    this._closeWaiters = [];

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        if (msg.error) {
          p.reject(new CdpError(msg.error.message || 'CDP error', p.method, msg.error.code));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        const key = (msg.sessionId || '') + '|' + msg.method;
        for (const h of this._handlers.get(key) || []) {
          try { h(msg.params, msg.sessionId); } catch { /* слушатель не должен ронять поток */ }
        }
      }
    });

    const finish = () => {
      this._closed = true;
      for (const [, p] of this._pending) {
        p.reject(new CdpError('Соединение с браузером закрыто', p.method, -1));
      }
      this._pending.clear();
      for (const w of this._closeWaiters) w();
      this._closeWaiters = [];
    };
    ws.addEventListener('close', finish);
    ws.addEventListener('error', finish);
  }

  get closed() { return this._closed; }

  /**
   * Отправить CDP-команду.
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   */
  send(method, params = {}, sessionId) {
    if (this._closed) {
      return Promise.reject(new CdpError('Соединение закрыто', method, -1));
    }
    const id = this._nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this._pending.delete(id);
        reject(new CdpError(String(err && err.message || err), method, -1));
      }
    });
  }

  /** Подписаться на событие. @returns {() => void} отписка */
  on(method, handler, sessionId = '') {
    const key = sessionId + '|' + method;
    let arr = this._handlers.get(key);
    if (!arr) { arr = []; this._handlers.set(key, arr); }
    arr.push(handler);
    return () => {
      const cur = this._handlers.get(key) || [];
      const i = cur.indexOf(handler);
      if (i >= 0) cur.splice(i, 1);
    };
  }

  /** Дождаться одного события (или таймаута). */
  once(method, timeoutMs = 30000, sessionId = '') {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`Таймаут ожидания события ${method}`, method, -2));
      }, timeoutMs);
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      }, sessionId);
    });
  }

  waitClose() {
    if (this._closed) return Promise.resolve();
    return new Promise((resolve) => this._closeWaiters.push(resolve));
  }

  close() {
    try { this.ws.close(); } catch { /* уже закрыт */ }
  }
}

/**
 * Подключиться к WebSocket-эндпоинту CDP.
 * @param {string} wsUrl
 * @param {number} timeoutMs
 */
async function connectCdp(wsUrl, timeoutMs = 20000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new CdpError(`Таймаут подключения к ${wsUrl}`, 'connect', -2));
    }, timeoutMs);
    const ok = () => { clearTimeout(timer); resolve(); };
    const bad = (ev) => {
      clearTimeout(timer);
      const msg = ev && ev.message ? ev.message : 'WebSocket error';
      reject(new CdpError(`Не удалось подключиться к браузеру: ${msg}`, 'connect', -3));
    };
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', bad, { once: true });
  });
  return new CdpConnection(ws);
}

module.exports = { CdpConnection, CdpError, connectCdp };
