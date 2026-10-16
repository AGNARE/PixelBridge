'use strict';
/**
 * Минимальный WebSocket-сервер: только RFC 6455 то, что нужно.
 * Сделан вручную, потому что весь проект принципиально без зависимостей.
 */

const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 128 * 1024 * 1024;

class WsSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.open = true;
    this._fragments = [];
    this._fragmentOpcode = null;
    this._handlers = { message: [], close: [], error: [] };
    this.meta = {};

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
  }

  on(event, fn) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(fn);
    return this;
  }

  _emit(event, arg) {
    for (const fn of this._handlers[event] || []) {
      try { fn(arg); } catch (e) { /* обработчик не должен ронять сервер */ }
    }
  }

  _close() {
    if (!this.open) return;
    this.open = false;
    this._emit('close');
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const hi = b.readUInt32BE(2);
      const lo = b.readUInt32BE(6);
      len = hi * 4294967296 + lo;
      offset = 10;
    }
    if (len > MAX_MESSAGE) {
      // Слишком большое сообщение — рвём соединение, иначе съедим память
      this.close(1009, 'message too big');
      return null;
    }

    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;

    let payload = b.subarray(offset, offset + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.buffer = b.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === 0x8) { this.close(); return; }
    if (opcode === 0x9) { this._write(0xA, payload); return; }
    if (opcode === 0xA) return;

    if (opcode === 0x0) {
      this._fragments.push(payload);
    } else {
      this._fragmentOpcode = opcode;
      this._fragments = [payload];
    }

    if (!fin) return;

    const full = Buffer.concat(this._fragments);
    this._fragments = [];
    const finalOpcode = opcode === 0x0 ? this._fragmentOpcode : opcode;
    const text = full.toString('utf8');
    this._emit('message', { data: text, binary: finalOpcode === 0x2 });
  }

  _write(opcode, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (e) {
      this._close();
      return false;
    }
  }

  send(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return this._write(0x1, Buffer.from(text, 'utf8'));
  }

  close(code, reason) {
    if (!this.open) return;
    let payload = Buffer.alloc(0);
    if (code) {
      const r = Buffer.from(String(reason || ''), 'utf8');
      payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
    }
    this._write(0x8, payload);
    this.open = false;
    try { this.socket.end(); } catch (e) { /* noop */ }
    this._emit('close');
  }
}

/**
 * Обработать HTTP-upgrade и вернуть WsSocket.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 */
function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  return new WsSocket(socket);
}

module.exports = { acceptUpgrade, WsSocket };
