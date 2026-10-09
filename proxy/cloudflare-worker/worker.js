// Proxy for short screenshot links: https://advant.one/<id> → the image itself.
//
// AShot uploads a screenshot to S3 (Yandex Object Storage) under a random id and gives the
// link https://advant.one/<id>. Links of the Box era (https://app.box.com/s/<id>, given out as
// https://advant.one/<id> too) keep working: an id that is not in the bucket is looked up in
// Box (needs the shared link access "open").
//
// The worker serves the picture *inline*, so the link opens as a picture in any browser
// (including phones) and in messenger previews. The bucket stays private: the worker reads it
// with its own read-only key (secrets S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY); without a key
// it reads anonymously (a bucket open for reading).
//
// Only pictures are shown inline; anything else is offered as a download, so the domain can
// never serve a page. Any other path is passed through to the origin, so the worker can sit on
// the main domain without breaking the existing site.

import { getObject } from './s3.js';

const ID = /^\/([A-Za-z0-9]{12,64})(?:\.(?:png|jpe?g|gif|webp))?\/?$/;
const PICTURE = /^image\/(png|jpeg|webp|gif)$/;

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

    let upstream = env.S3_BUCKET ? await fromS3(env, id) : null;
    // Not in the bucket (S3 answers 403 for a missing key when listing is not allowed): Box.
    if ((!upstream || upstream.status === 404 || upstream.status === 403) && env.BOX_FALLBACK !== 'off') {
      if (upstream) console.log(`${id}: S3 ${upstream.status}, trying Box`);
      upstream = await fetch(`https://${env.BOX_HOST || 'app.box.com'}/shared/static/${id}`, { redirect: 'follow' });
    }
    if (!upstream.ok || !upstream.body) {
      return new Response('Снимок не найден или ссылка закрыта', {
        status: upstream.status === 404 || upstream.status === 403 ? 404 : 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    let type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type || type === 'application/octet-stream') type = 'image/png'; // Box static links
    const picture = PICTURE.test(type);
    const disposition = upstream.headers.get('content-disposition') || '';
    const response = new Response(upstream.body, {
      headers: {
        'content-type': picture ? type : 'application/octet-stream',
        // The file name AShot stored (`inline; filename*=…`), but never inline for non-pictures.
        'content-disposition': picture ? (disposition.startsWith('inline') ? disposition : 'inline') : 'attachment',
        'cache-control': `public, max-age=${env.CACHE_SECONDS || 86400}`,
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function fromS3(env, id) {
  const prefix = (env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  return getObject({
    endpoint: env.S3_ENDPOINT || 'https://storage.yandexcloud.net',
    region: env.S3_REGION || 'ru-central1',
    bucket: env.S3_BUCKET,
    key: prefix ? `${prefix}/${id}` : id,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
}
