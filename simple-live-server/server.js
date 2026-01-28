const http = require('http');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const WebSocket = require('ws');

const PORT = 3000;
const TARGET_DIR = path.join(__dirname, 'target');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const LIVE_RELOAD_SCRIPT = `
<script>
(function () {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const socket = new WebSocket(wsUrl);

  socket.addEventListener('message', function (event) {
    if (event.data === 'reload') {
      location.reload();
    }
  });

  socket.addEventListener('close', function () {
    // optional: try reconnect (simple)
    setTimeout(function () { location.reload(); }, 500);
  });
})();
</script>
`;

class HtmlInjectTransform extends Transform {
  constructor() {
    super();
    this._buffer = '';
    this._injected = false;
  }

  _transform(chunk, encoding, callback) {
    const text = chunk.toString('utf8');
    this._buffer += text;

    // В задании сказано: достаточно проверить, что кусок содержит </body>
    if (!this._injected && this._buffer.includes('</body>')) {
      const updated = this._buffer.replace('</body>', `${LIVE_RELOAD_SCRIPT}\n</body>`);
      this.push(updated);
      this._buffer = '';
      this._injected = true;
      return callback();
    }

    // Чтобы не держать слишком много в памяти, пушим частями
    // но оставляем "хвост" (на случай, если </body> разорвётся)
    if (this._buffer.length > 64 * 1024 && !this._injected) {
      this.push(this._buffer.slice(0, 32 * 1024));
      this._buffer = this._buffer.slice(32 * 1024);
    }

    callback();
  }

  _flush(callback) {
    if (!this._injected) {
      // Если </body> не встретился (редко, но возможно),
      // добавим скрипт в конец файла, чтобы WS всё равно подключился.
      this.push(this._buffer + LIVE_RELOAD_SCRIPT);
      this._buffer = '';
      this._injected = true;
      return callback();
    }

    if (this._buffer.length > 0) {
      this.push(this._buffer);
      this._buffer = '';
    }

    callback();
  }
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveRequestToFilePath(urlPathname) {
  // убираем query string
  const cleanPath = urlPathname.split('?')[0].split('#')[0];

  // / -> /index.html (удобно для проверки)
  const normalized = cleanPath === '/' ? '/index.html' : cleanPath;

  const decoded = safeDecodeURIComponent(normalized);

  // строим путь внутри TARGET_DIR
  const candidate = path.join(TARGET_DIR, decoded);

  // защита от path traversal
  if (!isPathInside(TARGET_DIR, candidate)) {
    return null;
  }

  return candidate;
}

function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    return sendError(res, 400, 'Bad Request');
  }

  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const filePath = resolveRequestToFilePath(req.url);
  if (!filePath) {
    return sendError(res, 403, 'Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendError(res, 404, 'Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });

    const readStream = fs.createReadStream(filePath);

    readStream.on('error', () => {
      // если файл внезапно стал недоступен
      if (!res.headersSent) {
        sendError(res, 500, 'Internal Server Error');
      } else {
        res.end();
      }
    });

    // Инъекция ТОЛЬКО в HTML
    if (ext === '.html') {
      readStream.pipe(new HtmlInjectTransform()).pipe(res);
    } else {
      readStream.pipe(res);
    }
  });
});

/**
 * WebSocket server (ws) поверх того же HTTP сервера
 */
const wss = new WebSocket.Server({ server });

function broadcastReload() {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send('reload');
    }
  }
}

/**
 * fs.watch: слежение за target/ (recursively)
 * По заданию: primary focus event name is "change"
 */
fs.watch(TARGET_DIR, { recursive: true }, (eventType) => {
  if (eventType === 'change') {
    broadcastReload();
  }
});

server.listen(PORT, () => {
  console.log(`Live Server running: http://localhost:${PORT}`);
  console.log(`Root directory: ${TARGET_DIR}`);
});
