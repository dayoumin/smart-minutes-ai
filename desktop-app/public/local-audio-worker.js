/* Audio transport only: no caching, offline routing, credentials or backend fetches. */
const PROTOCOL = 'lmo-audio-v1';
const prefix = new URL('__lmo_audio__/', self.registration.scope).pathname;
const failure = status => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const forwardAudio = async event => {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405);
  if (!event.clientId) return failure(403);
  const client = await self.clients.get(event.clientId);
  if (!client || client.type !== 'window' || new URL(client.url).origin !== self.location.origin) return failure(403);
  const leaseId = new URL(request.url).pathname.slice(prefix.length);
  if (!/^[a-f0-9-]{36}$/.test(leaseId)) return failure(404);
  const range = request.headers.get('Range');
  if (range !== null && (range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) return failure(416);
  return await new Promise(resolve => {
    const channel = new MessageChannel();
    let completed = false;
    const finish = response => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', cancel);
      channel.port1.close();
      resolve(response);
    };
    const cancel = () => {
      channel.port1.postMessage({ protocol: PROTOCOL, cancel: true });
      finish(failure(503));
    };
    const timeout = setTimeout(cancel, 10000);
    channel.port1.onmessage = message => {
      const data = message.data;
      if (completed) {
        if (data?.body instanceof ReadableStream) void data.body.cancel().catch(() => {});
        return;
      }
      try {
        if (data?.protocol !== PROTOCOL || !Number.isInteger(data.status) || data.status < 200 || data.status > 599
          || (data.body !== null && !(data.body instanceof ReadableStream))) throw new Error('Invalid audio response');
        const received = new Headers(data.headers);
        const headers = new Headers({ 'Cache-Control': 'no-store' });
        for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
          const value = received.get(name);
          if (value !== null) headers.set(name, value);
        }
        finish(new Response(request.method === 'HEAD' ? null : data.body, { status: data.status, headers }));
      } catch {
        if (data?.body instanceof ReadableStream) void data.body.cancel().catch(() => {});
        finish(failure(502));
      }
    };
    channel.port1.onmessageerror = () => finish(failure(502));
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) { cancel(); return; }
    try {
      client.postMessage({ protocol: PROTOCOL, leaseId, method: request.method, range }, [channel.port2]);
    } catch { finish(failure(503)); }
  });
};

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  event.respondWith(forwardAudio(event));
});
