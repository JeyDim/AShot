// Reading an object of a private S3 bucket (Yandex Object Storage) from the worker:
// a GET signed with AWS Signature Version 4 (Web Crypto).
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const encoder = new TextEncoder();

/** `GET {endpoint}/{bucket}/{key}` (path-style); signed when the key is given. */
export async function getObject({ endpoint, region, bucket, key, accessKeyId, secretAccessKey }) {
  const path = key.split('/').map(encodeRfc3986).join('/');
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}/${path}`);
  if (!accessKeyId || !secretAccessKey) return fetch(url);
  const headers = { 'x-amz-content-sha256': EMPTY_HASH, 'x-amz-date': amzDate(new Date()) };
  headers.authorization = await authorization({ method: 'GET', url, region, accessKeyId, secretAccessKey, headers, payloadHash: EMPTY_HASH });
  return fetch(url, { headers });
}

/** The `Authorization` header for `headers` (plus `host`); `headers` must have `x-amz-date`. */
export async function authorization({ method, url, region, accessKeyId, secretAccessKey, headers, payloadHash }) {
  const signed = { host: url.host };
  for (const [name, value] of Object.entries(headers)) signed[name.toLowerCase()] = String(value).trim();
  const names = Object.keys(signed).sort();
  const now = signed['x-amz-date'];
  const date = now.slice(0, 8);
  const canonical = [method, url.pathname, url.search.slice(1), ...names.map((n) => `${n}:${signed[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)))].join('\n');
  let key = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date);
  for (const part of [region, 's3', 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

/** `20130524T000000Z`. */
export function amzDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(data)));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
