// المرفقات: روابط مؤقتة موقعة، فحص الصلاحية لكل ملف، رفع يتحمل الانقطاع دون تكرار، والتحقق قبل اعتباره مكتملًا.
// المخزن هنا خادم محلي متوافق مع S3 يتحقق من التوقيع ومدته وبصمة المحتوى (بديل اختبار لـ Backblaze B2).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { SyncEngine } from '../../src/sync/engine';
import { BlobSync, type BlobStore } from '../../src/sync/blobs';
import { createCloudOffice, joinCloudOffice } from '../../src/sync/setup';
import { presignUrl } from '../../src/sync/s3presign';
import { handle, type Deps } from '../../supabase/functions/_shared/attachments';
import { attachmentPath } from '../../src/main/paths';
import { call, makeCore, makePdf, seedCompany, setupOwner, stageAndAttach, tmpDir, Clock, CONSULTANT } from '../unit/helpers';
import { PgTransport, PG_URL, adminQuery, createAuthUser, ensureSchema, newSession, pgAvailable } from './pg';

const available = await pgAvailable();
const d = available ? describe : describe.skip;

const B2 = { region: 'eu-central-003', bucket: 'law-office-test', keyId: 'testKeyId', appKey: 'testSecretKey' };

/** خادم S3 مصغر: يتحقق من توقيع SigV4 المؤقت وصلاحيته، ومن تطابق بصمة المحتوى الموقعة مع الجسم المرفوع. */
function fakeS3(clock: Clock) {
  const objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();
  let failNextPut = false;
  let puts = 0;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, `http://${req.headers.host}`);
    const chunks: Buffer[] = [];
    if (req.method === 'PUT' && failNextPut) {
      // انقطاع أثناء الرفع: نستقبل جزءًا ثم نقطع الاتصال
      failNextPut = false;
      req.once('data', () => req.socket.destroy());
      return;
    }
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const q = u.searchParams;
    const amzDate = q.get('X-Amz-Date')!;
    const expires = Number(q.get('X-Amz-Expires'));
    const signedNames = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter((h) => h !== 'host');
    const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
    if (clock.now().getTime() > date.getTime() + expires * 1000) return void res.writeHead(403).end('expired');
    const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
    const expected = await presignUrl({
      method: req.method as 'GET' | 'PUT' | 'HEAD',
      endpoint: `http://${req.headers.host}`,
      ...B2,
      key,
      accessKeyId: B2.keyId,
      secretAccessKey: B2.appKey,
      expiresSec: expires,
      date,
      signedHeaders: Object.fromEntries(signedNames.map((h) => [h, String(req.headers[h] ?? '')])),
    });
    if (new URL(expected.url).searchParams.get('X-Amz-Signature') !== q.get('X-Amz-Signature')) return void res.writeHead(403).end('SignatureDoesNotMatch');
    if (req.method === 'PUT') {
      puts++;
      const want = String(req.headers['x-amz-content-sha256'] ?? '');
      if (want && want !== 'UNSIGNED-PAYLOAD' && createHash('sha256').update(body).digest('hex') !== want) return void res.writeHead(400).end('XAmzContentSHA256Mismatch');
      objects.set(key, { body, meta: { 'x-amz-meta-sha256': String(req.headers['x-amz-meta-sha256'] ?? '') } });
      return void res.writeHead(200).end();
    }
    const o = objects.get(key);
    if (!o) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': String(o.body.length), ...o.meta });
    res.end(req.method === 'HEAD' ? undefined : o.body);
  });
  return {
    server,
    objects,
    failNextPut: () => (failNextPut = true),
    puts: () => puts,
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
  };
}

async function serviceRpc(name: string, args: Record<string, unknown>) {
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    const keys = Object.keys(args);
    const r = await c.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as v`, keys.map((k) => args[k]));
    await c.query('commit');
    return r.rows[0].v;
  } finally {
    await c.end();
  }
}

function fileStore(core: { paths: Parameters<typeof attachmentPath>[0] }): BlobStore {
  return {
    has: (n) => fs.existsSync(attachmentPath(core.paths, n)),
    read: (n) => new Uint8Array(fs.readFileSync(attachmentPath(core.paths, n))),
    write: (n, b) => {
      const f = attachmentPath(core.paths, n);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, b);
    },
    remove: (n) => fs.rmSync(attachmentPath(core.paths, n), { force: true }),
  };
}

d('المرفقات عبر مخزن خاص بروابط مؤقتة', () => {
  const clock = new Clock('2026-11-25T09:00:00.000Z');
  const s3 = fakeS3(clock);
  let endpoint = '';
  const A = makeCore(tmpDir(), clock);
  const B = makeCore(tmpDir(), clock);
  let tA: PgTransport, tB: PgTransport;
  let eA: SyncEngine, eB: SyncEngine;
  let bA: BlobSync, bB: BlobSync;
  let officeId = '';
  let versionId = '';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  const deps = (t: PgTransport): Deps => ({ userRpc: (n, a) => t.rpc(n, a), serviceRpc, b2: { endpoint, ...B2 }, fetch, now: clock.now });
  const api = (t: PgTransport) => ({ call: (req: Record<string, unknown>) => handle(req as never, deps(t)) });

  beforeAll(async () => {
    await ensureSchema();
    endpoint = await s3.start();
    const owner = await createAuthUser(`blob-owner-${Date.now()}@example.test`);
    tA = new PgTransport(owner.userId, owner.sessionId);
    tB = new PgTransport(owner.userId, await newSession(owner.userId));
    await setupOwner(A.core, 'S');
    ids = await seedCompany(A.core, 'S');
    const pdf = makePdf(path.join(A.dir, 'minutes.pdf'), 'Hearing minutes for blob test');
    const r = await stageAndAttach(A.core, A.platform, 'S', pdf, { title: 'ضبط جلسة', category: 'minutes', clientId: ids.clientId, caseId: ids.laborId });
    versionId = r.versionId;
    officeId = await createCloudOffice(A.core.db, tA, { officeName: 'مكتب مرفقات تجريبي', localOwnerId: (await call(A.core, 'S', 'auth.me')).id, displayName: 'مالك' });
    eA = new SyncEngine(() => A.core.db, tA, clock.now);
    eB = new SyncEngine(() => B.core.db, tB, clock.now);
    bA = new BlobSync(() => A.core.db, api(tA), fileStore(A.core), fetch, clock.now);
    bB = new BlobSync(() => B.core.db, api(tB), fileStore(B.core), fetch, clock.now);
    await eA.sync();
    joinCloudOffice(B.core.db, officeId);
    await eB.sync();
  });
  afterAll(() => s3.server.close());

  it('السجل يصل قبل الملف؛ والملف لا يُعد مكتملًا قبل رفعه والتحقق منه', async () => {
    bB.scan();
    expect(bB.state(versionId)?.state).toBe('remote');
    await expect(bB.download(versionId)).rejects.toThrow(/لم يكتمل رفعه/);
    // انقطاع أثناء الرفع ثم إعادة المحاولة
    s3.failNextPut();
    const first = await bA.uploadPending();
    expect(first.failed).toBe(1);
    expect(bA.state(versionId)?.state).toBe('failed');
    const blob1 = await adminQuery<{ status: string }>('select status from blobs where version_id = $1', [versionId]);
    expect(blob1[0].status).toBe('pending');
    const second = await bA.uploadPending();
    expect(second.uploaded).toBe(1);
    expect(bA.state(versionId)?.state).toBe('uploaded');
    expect(s3.objects.size).toBe(1); // لا تكرار
    const blob2 = await adminQuery<{ status: string }>('select status from blobs where version_id = $1', [versionId]);
    expect(blob2[0].status).toBe('verified');
    // إعادة الطلب لا ترفع مجددًا
    const puts = s3.puts();
    await bA.upload(versionId);
    expect(s3.puts()).toBe(puts);
  });

  it('التنزيل على جهاز آخر يتحقق من البصمة ويفتح المستند داخل التطبيق', async () => {
    await bB.download(versionId);
    expect(bB.state(versionId)?.state).toBe('local');
    B.core.sessions.set('S-B', { userId: A.core.db.get<{ id: string }>("SELECT id FROM users WHERE role = 'owner'")!.id, lastActivity: clock.now().getTime(), locked: false, dirty: false });
    const bytes = await call(B.core, 'S-B', 'documents.readBytes', { versionId });
    expect(Buffer.from(bytes.bytes).toString('latin1')).toContain('Hearing minutes for blob test');
  });

  it('الخادم يرفض ملفًا لا يطابق سجله، ورابطًا منتهيًا أو معدلًا، ومستخدمًا غير مخول', async () => {
    // بيانات لا تطابق السجل
    const bad = await handle({ action: 'upload-url', office_id: officeId, version_id: versionId, sha256: 'a'.repeat(64), size: 10, ext: 'pdf' }, deps(tA));
    expect(bad.status).toBe(422);
    // رابط تنزيل منتهي المدة
    const r = await handle({ action: 'download-url', office_id: officeId, version_id: versionId }, deps(tA));
    expect(r.status).toBe(200);
    clock.advance(301_000);
    expect((await fetch(String(r.body.url))).status).toBe(403);
    // رابط معدّل لملف آخر
    const r2 = await handle({ action: 'download-url', office_id: officeId, version_id: versionId }, deps(tA));
    const tampered = String(r2.body.url).replace(versionId, randomUUID());
    expect((await fetch(tampered)).status).toBe(403);
    // رفع جسم مختلف عن البصمة الموقعة
    const up = await presignUrl({ method: 'PUT', endpoint, ...B2, key: `${officeId}/${versionId}`, accessKeyId: B2.keyId, secretAccessKey: B2.appKey, expiresSec: 60, date: clock.now(), signedHeaders: { 'x-amz-content-sha256': 'b'.repeat(64) } });
    expect((await fetch(up.url, { method: 'PUT', headers: up.headers, body: 'other content' })).status).toBe(400);
    // مستشار لا يملك القضية
    const cons = await createAuthUser(`blob-cons-${Date.now()}@example.test`);
    const local = await call(A.core, 'S', 'users.create', { ...CONSULTANT, username: 'cons2', permissions: [] });
    await eA.sync();
    await tA.rpc('app_link_member', { p_office: officeId, p_user: cons.userId, p_local_user: local.id, p_display_name: 'مستشار', p_permissions: [] });
    const tC = new PgTransport(cons.userId, cons.sessionId);
    expect((await handle({ action: 'download-url', office_id: officeId, version_id: versionId }, deps(tC))).status).toBe(403);
    // دالة الاعتماد لا يستدعيها المستخدم مباشرة
    await expect(tA.rpc('app_blob_verified', { p_office: officeId, p_version: versionId, p_size: 1, p_sha: 'x' })).rejects.toThrow();
  });

  it('الآيفون: «إتاحة دون اتصال» للملف المختار وإزالة النسخة المحلية دون حذفه من الخادم', async () => {
    await bB.evict(versionId);
    expect(bB.state(versionId)?.state).toBe('remote');
    bB.setPinned(versionId, true);
    const r = await bB.downloadAll(true);
    expect(r.downloaded).toBe(1);
    expect(bB.state(versionId)).toMatchObject({ state: 'local', pinned: true });
    expect(bB.summary().localBytes).toBeGreaterThan(0);
  });
});
