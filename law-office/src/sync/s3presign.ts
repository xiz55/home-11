// توقيع AWS Signature V4 لروابط مؤقتة (S3 / Backblaze B2 المتوافق). يعمل في Node وDeno (دوال الخادم) والمتصفح عبر WebCrypto.
// يُستخدم في دالة الخادم فقط حيث توجد المفاتيح؛ التطبيقات لا تحمل مفاتيح B2.

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

/** ترميز URI وفق متطلبات SigV4 (RFC 3986، مع إبقاء / في المسار). */
export function uriEncode(s: string, encodeSlash = true): string {
  return [...enc.encode(s)]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      if (c === '/' && !encodeSlash) return c;
      return '%' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');
}

export interface PresignInput {
  method: 'GET' | 'PUT' | 'HEAD';
  endpoint: string; // مثل https://s3.eu-central-003.backblazeb2.com
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSec: number;
  date?: Date;
  /** ترويسات إضافية موقّعة يجب أن يرسلها العميل كما هي (مثل بصمة المحتوى) */
  signedHeaders?: Record<string, string>;
}

/** رابط موقّع مؤقت بأسلوب المسار (path-style). */
export async function presignUrl(p: PresignInput): Promise<{ url: string; headers: Record<string, string> }> {
  const d = p.date ?? new Date();
  const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const host = new URL(p.endpoint).host;
  const canonicalUri = p.bucket ? `/${uriEncode(p.bucket)}/${uriEncode(p.key, false)}` : `/${uriEncode(p.key, false)}`;
  const scope = `${day}/${p.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host, ...Object.fromEntries(Object.entries(p.signedHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])) };
  const headerNames = Object.keys(headers).sort();
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${p.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(p.expiresSec),
    'X-Amz-SignedHeaders': headerNames.join(';'),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');
  const canonicalHeaders = headerNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const payloadHash = headers['x-amz-content-sha256'] ?? 'UNSIGNED-PAYLOAD';
  const canonicalRequest = [p.method, canonicalUri, canonicalQuery, canonicalHeaders, headerNames.join(';'), payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let k = await hmac(enc.encode('AWS4' + p.secretAccessKey), day);
  k = await hmac(k, p.region);
  k = await hmac(k, 's3');
  k = await hmac(k, 'aws4_request');
  const sig = hex(await hmac(k, stringToSign));
  const { host: _h, ...clientHeaders } = headers;
  return { url: `${p.endpoint.replace(/\/$/, '')}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${sig}`, headers: clientHeaders };
}
