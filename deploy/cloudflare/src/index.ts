import release from '../release.json' with { type: 'json' };

export function parseByteRange(value: string, size: number): { offset: number; length: number } | null {
    if (!Number.isSafeInteger(size) || size <= 0) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2])) return null;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
        const length = Math.min(suffix, size);
        return { offset: size - length, length };
    }
    const offset = Number(match[1]);
    const end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) return null;
    return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

export default {
    async fetch(request, env): Promise<Response> {
        const pathname = new URL(request.url).pathname;
        if (!pathname.startsWith('/downloads/')) return env.ASSETS.fetch(request);
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        if (pathname === release.previousDownloadPath || release.previousDownloadPaths.includes(pathname)) {
            return new Response(null, {
                status: 307,
                headers: { Location: release.downloadPath, 'Cache-Control': 'no-store' },
            });
        }
        if (pathname !== release.downloadPath && pathname !== '/downloads/engine-beta.json') {
            return new Response('Not found', { status: 404 });
        }
        if (release.bytes <= 0 || !/^[a-f0-9]{64}$/.test(release.sha256)) {
            return new Response('Download is being prepared', { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }
        if (pathname === '/downloads/engine-beta.json') {
            return new Response(request.method === 'HEAD' ? null : JSON.stringify(release), {
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            });
        }
        const etag = `"sha256-${release.sha256}"`;
        const headers = new Headers({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${release.downloadPath.split('/').pop()}"`,
            'Cache-Control': 'public, max-age=3600, no-transform',
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff',
            ETag: etag,
        });
        if (request.headers.get('If-None-Match')?.split(',').map(value => value.trim()).some(value => value === etag || value === '*')) {
            return new Response(null, { status: 304, headers });
        }
        let range: { offset: number; length: number } | undefined;
        const requestedRange = request.headers.get('Range');
        const ifRange = request.headers.get('If-Range');
        if (request.method === 'GET' && requestedRange && (!ifRange || ifRange === etag)) {
            range = parseByteRange(requestedRange, release.bytes) ?? undefined;
            if (!range) {
                headers.set('Content-Range', `bytes */${release.bytes}`);
                return new Response(null, { status: 416, headers });
            }
        }
        try {
            const key = release.downloadPath.slice('/downloads/'.length);
            if (request.method === 'HEAD') {
                const object = await env.RELEASES.head(key);
                if (!object || object.size !== release.bytes || object.customMetadata?.sha256 !== release.sha256) {
                    return new Response('Download is being prepared', { status: 503, headers: { 'Cache-Control': 'no-store' } });
                }
                headers.set('Content-Length', String(object.size));
                return new Response(null, { headers });
            }
            const object = await env.RELEASES.get(key, range ? { range } : undefined);
            if (!object || object.size !== release.bytes || object.customMetadata?.sha256 !== release.sha256) {
                return new Response('Download is being prepared', { status: 503, headers: { 'Cache-Control': 'no-store' } });
            }
            headers.set('Content-Length', String(range?.length ?? object.size));
            if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
            return new Response(object.body, { status: range ? 206 : 200, headers });
        } catch {
            return new Response('Download temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }
    },
} satisfies ExportedHandler<Env>;
