import { gzip } from 'node:zlib';

function acceptsGzip(value) {
  const encodings = String(value || '').split(',').map((entry) => {
    const [name, ...params] = entry.trim().toLowerCase().split(';');
    const q = params.find((param) => param.trim().startsWith('q='));
    return { name, quality: q ? Number(q.trim().slice(2)) : 1 };
  });
  const chosen = encodings.find((entry) => entry.name === 'gzip') || encodings.find((entry) => entry.name === '*');
  return Boolean(chosen && chosen.quality > 0);
}

// Large workspace snapshots travel compressed; compression runs off the main
// event loop. API bodies remain private and must never enter an HTTP cache.
export function sendJsonResponse(response, status, payload, acceptEncoding = '') {
  const body = Buffer.from(JSON.stringify(payload));
  response.statusCode = status;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  const finish = (bytes, compressed = false) => {
    if (response.destroyed) return;
    response.writeHead(status, { ...headers, 'Content-Length': bytes.length, ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) });
    response.end(bytes);
  };
  if (body.length < 2048 || !acceptsGzip(acceptEncoding)) return finish(body);
  gzip(body, { level: 4 }, (error, bytes) => finish(error ? body : bytes, !error));
}
