// منطق دالة الخادم للمرفقات — مستقل عن بيئة التشغيل حتى يُختبر في Node ويعمل في Supabase Edge (Deno).
// يتحقق من المستخدم عبر دوال SQL بصلاحياته هو (RLS)، ويوقّع روابط B2 مؤقتة، ويفحص الملف المرفوع قبل اعتماده.
import { presignUrl } from '../../../src/sync/s3presign.ts';

export interface B2Config {
  endpoint: string; // https://s3.<region>.backblazeb2.com
  region: string;
  bucket: string;
  keyId: string;
  appKey: string;
}

export interface Deps {
  /** استدعاء دالة SQL بهوية المستخدم صاحب الطلب (رمزه) — تخضع لـ RLS */
  userRpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** استدعاء دالة SQL بمفتاح الخدمة (داخل دالة الخادم فقط) */
  serviceRpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  b2: B2Config;
  fetch: typeof fetch;
  now?: () => Date;
}

const UPLOAD_TTL = 900; // 15 دقيقة
const DOWNLOAD_TTL = 300; // 5 دقائق

export type Req =
  | { action: 'upload-url'; office_id: string; version_id: string; sha256: string; size: number; ext: string }
  | { action: 'complete'; office_id: string; version_id: string }
  | { action: 'download-url'; office_id: string; version_id: string };

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
};

export async function handle(req: Req, d: Deps): Promise<{ status: number; body: Record<string, unknown> }> {
  const sign = (method: 'GET' | 'PUT' | 'HEAD', key: string, ttl: number, headers?: Record<string, string>) =>
    presignUrl({ method, endpoint: d.b2.endpoint, region: d.b2.region, bucket: d.b2.bucket, key, accessKeyId: d.b2.keyId, secretAccessKey: d.b2.appKey, expiresSec: ttl, date: d.now?.(), signedHeaders: headers });
  try {
    if (req.action === 'upload-url') {
      if (!/^[0-9a-f]{64}$/.test(req.sha256)) return { status: 400, body: { error: 'bad sha256' } };
      const r = (await d.userRpc('app_blob_request', { p_office: req.office_id, p_version: req.version_id, p_sha: req.sha256, p_size: req.size, p_ext: req.ext })) as { status: string; object_key: string };
      if (r.status === 'verified') return { status: 200, body: { status: 'verified' } };
      // بصمة المحتوى موقّعة: يرفض المخزن أي جسم لا يطابقها، ونحفظها في بيانات الملف للتحقق اللاحق
      const s = await sign('PUT', r.object_key, UPLOAD_TTL, {
        'x-amz-content-sha256': req.sha256,
        'x-amz-meta-sha256': req.sha256,
        'content-type': MIME[req.ext.toLowerCase()] ?? 'application/octet-stream',
      });
      return { status: 200, body: { status: 'pending', url: s.url, headers: s.headers, expires_in: UPLOAD_TTL } };
    }
    if (req.action === 'complete') {
      // المستخدم يجب أن يملك صلاحية القراءة على السجل؛ ثم فحص الملف الفعلي في المخزن
      const meta = (await d.userRpc('app_blob_access', { p_office: req.office_id, p_version: req.version_id }).catch((e) => ({ error: String(e) }))) as { status?: string; error?: string };
      if (meta.error) return { status: 403, body: { error: 'not allowed' } };
      if (meta.status === 'verified') return { status: 200, body: { status: 'verified' } };
      const pending = (await d.serviceRpc('app_blob_pending', { p_office: req.office_id, p_version: req.version_id })) as { object_key: string; sha256: string; size: number } | null;
      if (!pending) return { status: 404, body: { error: 'no pending upload' } };
      const h = await sign('HEAD', pending.object_key, 60);
      const head = await d.fetch(h.url, { method: 'HEAD', headers: h.headers });
      if (!head.ok) return { status: 409, body: { status: 'incomplete', error: `object not found (${head.status})` } };
      const len = Number(head.headers.get('content-length'));
      const sha = head.headers.get('x-amz-meta-sha256');
      if (len !== Number(pending.size) || sha !== pending.sha256) return { status: 409, body: { status: 'incomplete', error: 'size or checksum mismatch' } };
      await d.serviceRpc('app_blob_verified', { p_office: req.office_id, p_version: req.version_id, p_size: len, p_sha: sha });
      return { status: 200, body: { status: 'verified' } };
    }
    if (req.action === 'download-url') {
      const meta = (await d.userRpc('app_blob_access', { p_office: req.office_id, p_version: req.version_id })) as { status: string; object_key?: string; sha256?: string; size?: number };
      if (meta.status !== 'verified' || !meta.object_key) return { status: 409, body: { status: meta.status } };
      const s = await sign('GET', meta.object_key, DOWNLOAD_TTL);
      return { status: 200, body: { status: 'verified', url: s.url, sha256: meta.sha256, size: Number(meta.size), expires_in: DOWNLOAD_TTL } };
    }
    return { status: 400, body: { error: 'unknown action' } };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/not allowed|42501|permission/i.test(msg)) return { status: 403, body: { error: 'not allowed' } };
    if (/does not match|not allowed|size/i.test(msg)) return { status: 422, body: { error: msg } };
    if (/not synced/i.test(msg)) return { status: 409, body: { error: 'record not synced yet' } };
    return { status: 500, body: { error: 'internal' } };
  }
}
