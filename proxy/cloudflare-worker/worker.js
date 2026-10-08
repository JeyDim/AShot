// Proxy for short screenshot links: https://advant.one/<box shared id> → the image itself.
//
// AShot turns https://app.box.com/s/<id> into https://advant.one/<id>.
// This worker serves the file behind that Box shared link *inline*, so the link opens
// as a picture in any browser (including phones) without the Box web app or a login.
// Requires the shared link access level "open" ("People with the link").
//
// Any other path is passed through to the origin, so the worker can sit on the main
// domain without breaking the existing site.

const ID = /^\/([A-Za-z0-9]{12,64})(?:\.(?:png|jpe?g|gif|webp))?\/?$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = ID.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(request.method)) {
      return fetch(request); // not a screenshot link → origin site
    }
    const id = match[1];

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/${id}`, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const boxHost = env.BOX_HOST || 'app.box.com';
    const upstream = await fetch(`https://${boxHost}/shared/static/${id}`, { redirect: 'follow' });
    if (!upstream.ok || !upstream.body) {
      return new Response('Снимок не найден или ссылка закрыта', {
        status: upstream.status === 404 ? 404 : 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const type = upstream.headers.get('content-type') || 'image/png';
    const response = new Response(upstream.body, {
      headers: {
        'content-type': type.startsWith('application/octet-stream') ? 'image/png' : type,
        'content-disposition': 'inline',
        'cache-control': `public, max-age=${env.CACHE_SECONDS || 86400}`,
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
