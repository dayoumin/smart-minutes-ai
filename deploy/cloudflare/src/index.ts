import release from '../release.json' with { type: 'json' };
import desktopPublication from '../desktop-release.json' with { type: 'json' };
import desktopInstallPublication from '../desktop-install-release.json' with { type: 'json' };
import { parseDesktopRelease } from '../../../desktop-app/src/desktopRelease.ts';
import { parseDesktopInstallRelease } from './desktopInstallRelease.ts';

const notPrepared = () => new Response('Download is being prepared', {
    status: 503, headers: { 'Cache-Control': 'no-store' },
});

// An unpublished descriptor stays honest: no desktop download is offered until a verified ZIP exists.
export async function serveDesktopDownload(request: Request, env: Env, publication: unknown, kind: 'update' | 'install' = 'update'): Promise<Response> {
    const response = request.method !== 'GET' && request.method !== 'HEAD'
        ? new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
        : await createDesktopDownloadResponse(request, env, publication, kind);
    if (new URL(request.url).pathname === '/downloads/desktop-beta.json'
        || new URL(request.url).pathname === '/downloads/desktop-install-beta.json') {
        // This public, credential-free feed is also read by the packaged Tauri WebView.
        response.headers.set('Access-Control-Allow-Origin', '*');
    }
    return response;
}

export function serveDesktopInstallDownload(request: Request, env: Env, publication: unknown): Promise<Response> {
    return serveDesktopDownload(request, env, publication, 'install');
}

async function createDesktopDownloadResponse(request: Request, env: Env, publication: unknown, kind: 'update' | 'install'): Promise<Response> {
    const payload = publication && typeof publication === 'object'
        ? (publication as Record<string, unknown>).release : null;
    const desktop = kind === 'install' ? parseDesktopInstallRelease(payload) : parseDesktopRelease(payload);
    const feedPath = kind === 'install' ? '/downloads/desktop-install-beta.json' : '/downloads/desktop-beta.json';
    const pathname = new URL(request.url).pathname;
    if (!desktop) return payload === null
        ? new Response(`Desktop ${kind} not published`, { status: 404, headers: { 'Cache-Control': 'no-store' } })
        : notPrepared();
    const downloadPath = new URL(desktop.downloadUrl).pathname;
    if (pathname !== feedPath && pathname !== downloadPath) {
        return new Response('Not found', { status: 404 });
    }
    try {
        const object = await env.RELEASES.head(downloadPath.slice('/downloads/'.length));
        if (!object || object.size !== desktop.bytes || object.customMetadata?.sha256 !== desktop.sha256) return notPrepared();
        if (pathname === feedPath) {
            return new Response(request.method === 'HEAD' ? null : JSON.stringify(payload), {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        }
        return serveArtifact(request, env, { ...desktop, downloadPath });
    } catch {
        return notPrepared();
    }
}

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

async function serveArtifact(request: Request, env: Env, release: { bytes: number; sha256: string; downloadPath: string }): Promise<Response> {
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
}

export default {
    async fetch(request, env): Promise<Response> {
        const pathname = new URL(request.url).pathname;
        if (!pathname.startsWith('/downloads/')) return env.ASSETS.fetch(request);
        if (pathname === '/downloads/desktop-install-beta.json' || pathname.startsWith('/downloads/lmo_audio_install_')) {
            return serveDesktopInstallDownload(request, env, desktopInstallPublication);
        }
        if (pathname === '/downloads/desktop-beta.json' || pathname.startsWith('/downloads/lmo_audio_update_')) {
            return serveDesktopDownload(request, env, desktopPublication);
        }
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
        if (release.bytes <= 0 || !/^[a-f0-9]{64}$/.test(release.sha256)) return notPrepared();
        if (pathname === '/downloads/engine-beta.json') {
            return new Response(request.method === 'HEAD' ? null : JSON.stringify(release), {
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            });
        }
        return serveArtifact(request, env, release);
    },
} satisfies ExportedHandler<Env>;
