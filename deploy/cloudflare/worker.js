const API_PATH = /^\/(?:videos(?:\/|$)|search(?:\/|$)|query(?:\/|$)|health(?:\/|$)|docs(?:\/|$)|openapi\.json$)/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname !== '/' && !API_PATH.test(incoming.pathname)) {
      return Response.json({ detail: 'Not found' }, { status: 404 });
    }
    if (!METHODS.has(request.method)) {
      return Response.json({ detail: 'Method not allowed' }, { status: 405 });
    }
    if (!env.API_ORIGIN) {
      return Response.json({ detail: 'Demo backend is not configured' }, { status: 503 });
    }
    const target = new URL(env.API_ORIGIN);
    if (!['http:', 'https:'].includes(target.protocol)) {
      return Response.json({ detail: 'Invalid backend configuration' }, { status: 503 });
    }
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-Forwarded-Host', incoming.host);
    headers.set('X-Forwarded-Proto', 'https');
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set('Cache-Control', 'no-store');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');
      responseHeaders.set('Referrer-Policy', 'no-referrer');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch {
      return Response.json({ detail: 'Demo backend is temporarily unavailable' }, { status: 502 });
    }
  },
};
