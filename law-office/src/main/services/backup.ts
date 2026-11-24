// النسخ الاحتياطي والتصدير والاستعادة.
// الحزمة ملف ZIP موثق (انظر docs/EXPORT_FORMAT.md): لقطة SQLite متسقة (VACUUM INTO تشمل بيانات WAL) + المرفقات + JSON لكل جدول + بيان بالبصمات.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import yauzl from 'yauzl';
import type { Ctx } from '../context';
import { uuid } from '../context';
import { Db } from '../db/db';
import { LATEST_SCHEMA_VERSION, currentSchemaVersion } from '../db/migrations';
import { AppError, mapFsError } from '../errors';
import { attachmentPath, resolveInside, type AppPaths } from '../paths';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from '../../shared/constants';
import { requireOwner } from './access';
import { logActivity } from './activity';
import { readSetting, writeSetting } from './settings';
import { todayRiyadh } from '../../shared/dates';

export const BACKUP_EXT = 'lobk';
const TABLES = [
  'users',
  'settings',
  'counters',
  'lookups',
  'clients',
  'cases',
  'case_parties',
  'user_case_access',
  'user_client_access',
  'stages',
  'related_works',
  'hearings',
  'hearing_changes',
  'tasks',
  'hearing_requests',
  'judgments',
  'deadlines',
  'memos',
  'memo_revisions',
  'contracts',
  'contract_cases',
  'fee_items',
  'payments',
  'expenses',
  'poas',
  'poa_cases',
  'documents',
  'document_versions',
  'memo_submissions',
  'case_analysis',
  'analysis_revisions',
  'evidence_items',
  'notes',
  'communications',
  'reminders',
  'activity_log',
  'integration_tokens',
  'consultations',
  'meetings',
  'meeting_items',
  'appointment_changes',
  'service_txns',
  'contract_adjustments',
  'consultation_opinions',
  'opinion_revisions',
];
const SENSITIVE_COLUMNS: Record<string, string[]> = { users: ['password_hash', 'recovery_hash'], integration_tokens: ['token_hash'] };

export interface Manifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  createdBy: string | null;
  officeName: string;
  counts: Record<string, number>;
  database: { path: string; size: number; sha256: string };
  files: { path: string; size: number; sha256: string }[];
  jsonTables: string[];
  /** بصمات بقية محتويات الحزمة (JSON والملف التعريفي) حتى يُكتشف أي تلف في أي جزء */
  extraFiles: { path: string; size: number; sha256: string }[];
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

const README = `حزمة نسخة احتياطية / تصدير كامل — برنامج إدارة مكتب المحاماة
Law office backup / full export package

المحتويات:
- manifest.json : بيان الحزمة (الإصدار، تاريخ الإنشاء، عدد السجلات، بصمة SHA-256 لكل ملف).
- database/office.sqlite : لقطة متسقة كاملة من قاعدة بيانات SQLite (تُستخدم للاستعادة).
- attachments/xx/<uuid>.<ext> : المرفقات بأسمائها الداخلية؛ الاسم الأصلي في جدول document_versions.original_name.
- data/<table>.json : نسخة مفتوحة من كل جدول بصيغة JSON (المفاتيح UUID والعلاقات محفوظة) للنقل إلى أنظمة أخرى.
  حقول تجزئة كلمات المرور ورموز التكامل لا تُكتب في JSON؛ تبقى فقط داخل قاعدة البيانات.

ملاحظة: الحزمة غير مشفرة. احفظها في مكان آمن، ويفضّل على قرص خارجي أو جهاز آخر؛ النسخة على القرص نفسه لا تحمي من تلف الجهاز.
التفاصيل الكاملة للبنية في ملف docs/EXPORT_FORMAT.md المرفق مع البرنامج.
`;

/** ينشئ حزمة كاملة في المسار المحدد. يُستخدم للنسخ الاحتياطي والتصدير ونسخة ما قبل الاستعادة. */
export async function writePackage(db: Db, paths: AppPaths, dest: string, meta: { appVersion: string; createdBy: string | null; now: Date }): Promise<Manifest> {
  const work = resolveInside(paths.tmpDir, `pkg-${uuid()}`);
  fs.mkdirSync(work, { recursive: true });
  const snap = path.join(work, 'office.sqlite');
  const tmpDest = `${dest}.part-${process.pid}`;
  try {
    // لقطة متسقة تشمل ما في ملف WAL — لا نسخ لملف قاعدة مفتوح
    db.raw.prepare('VACUUM INTO ?').run(snap);
    const sdb = new Db(snap, { readOnly: true });
    let manifest: Manifest;
    try {
      const ic = sdb.get<{ integrity_check: string }>('PRAGMA integrity_check');
      if (ic?.integrity_check !== 'ok') throw new AppError('INTEGRITY', 'فحص سلامة لقطة قاعدة البيانات فشل؛ لم تُنشأ النسخة.');
      const counts: Record<string, number> = {};
      const jsonFiles: { name: string; buf: Buffer }[] = [];
      for (const t of TABLES) {
        const rows = sdb.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
        counts[t] = rows.length;
        const hide = SENSITIVE_COLUMNS[t] ?? [];
        const cleaned = hide.length ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !hide.includes(k)))) : rows;
        jsonFiles.push({ name: `data/${t}.json`, buf: Buffer.from(JSON.stringify(cleaned, null, 1), 'utf8') });
      }
      const versions = sdb.all<{ stored_name: string; sha256: string; size: number; original_name: string }>('SELECT stored_name, sha256, size, original_name FROM document_versions');
      const files: Manifest['files'] = [];
      const missing: string[] = [];
      for (const v of versions) {
        const f = attachmentPath(paths, v.stored_name);
        if (!fs.existsSync(f)) {
          missing.push(v.original_name);
          continue;
        }
        const h = await sha256File(f);
        if (h !== v.sha256) missing.push(`${v.original_name} (تالف)`);
        files.push({ path: `attachments/${v.stored_name.slice(0, 2)}/${v.stored_name}`, size: fs.statSync(f).size, sha256: h });
      }
      if (missing.length)
        throw new AppError('INTEGRITY', `بعض المرفقات مفقودة أو تالفة في مستودع البرنامج (${missing.slice(0, 5).join('، ')}${missing.length > 5 ? '…' : ''}). شغّل «فحص سلامة المرفقات» من الإعدادات.`);
      const officeName = (() => {
        const r = sdb.get<{ value: string }>("SELECT value FROM settings WHERE key = 'office.name'");
        try {
          return r ? JSON.parse(r.value) : '';
        } catch {
          return '';
        }
      })();
      manifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        appVersion: meta.appVersion,
        schemaVersion: currentSchemaVersion(sdb),
        createdAt: meta.now.toISOString(),
        createdBy: meta.createdBy,
        officeName,
        counts,
        database: { path: 'database/office.sqlite', size: fs.statSync(snap).size, sha256: '' },
        files,
        jsonTables: jsonFiles.map((j) => j.name),
        extraFiles: [...jsonFiles.map((j) => ({ path: j.name, buf: j.buf })), { path: 'README.txt', buf: Buffer.from(README, 'utf8') }].map((x) => ({
          path: x.path,
          size: x.buf.length,
          sha256: createHash('sha256').update(x.buf).digest('hex'),
        })),
      };
      sdb.close();
      manifest.database.sha256 = await sha256File(snap);
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json');
      zip.addBuffer(Buffer.from(README, 'utf8'), 'README.txt');
      zip.addFile(snap, 'database/office.sqlite');
      for (const j of jsonFiles) zip.addBuffer(j.buf, j.name);
      for (const f of files) {
        const stored = path.basename(f.path);
        zip.addFile(attachmentPath(paths, stored), f.path, { compress: false });
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(tmpDest);
        ws.on('error', reject);
        ws.on('close', () => resolve());
        zip.outputStream.on('error', reject);
        zip.outputStream.pipe(ws);
        zip.end();
      });
      const fd = fs.openSync(tmpDest, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmpDest, dest);
    } finally {
      try {
        sdb.close();
      } catch {
        /* */
      }
    }
    return manifest;
  } catch (e) {
    fs.rmSync(tmpDest, { force: true });
    if (e instanceof AppError) throw e;
    throw mapFsError(e);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function sameDrive(a: string, b: string): boolean {
  const ra = path.parse(path.resolve(a)).root.toLowerCase();
  const rb = path.parse(path.resolve(b)).root.toLowerCase();
  if (process.platform === 'win32') return ra === rb;
  try {
    return fs.statSync(path.dirname(path.resolve(a))).dev === fs.statSync(path.resolve(b)).dev;
  } catch {
    return ra === rb;
  }
}

export async function createBackup(ctx: Ctx, appVersion: string, kind: 'backup' | 'export' = 'backup') {
  const u = requireOwner(ctx);
  const stamp = ctx.now().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const dest = await ctx.platform.showSaveFile({
    title: kind === 'backup' ? 'حفظ نسخة احتياطية' : 'تصدير كامل للبيانات',
    defaultName: `${kind === 'backup' ? 'نسخة-احتياطية' : 'تصدير-كامل'}-${stamp}.${BACKUP_EXT}`,
    filters: [{ name: 'حزمة مكتب المحاماة', extensions: [BACKUP_EXT] }],
  });
  if (!dest) return { saved: false as const };
  const finalDest = dest.toLowerCase().endsWith(`.${BACKUP_EXT}`) ? dest : `${dest}.${BACKUP_EXT}`;
  if (path.resolve(finalDest).startsWith(path.resolve(ctx.paths.dataDir) + path.sep))
    throw new AppError('VALIDATION', 'اختر مكانًا خارج مجلد بيانات البرنامج (مثل قرص خارجي أو مجلد آخر).');
  const manifest = await writePackage(ctx.db, ctx.paths, finalDest, { appVersion, createdBy: u.username, now: ctx.now() });
  const verify = await inspectPackageFile(finalDest, ctx.paths, { extract: false });
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    writeSetting(ctx.db, 'backup.lastBackupAt', now, now);
    writeSetting(ctx.db, 'backup.lastBackupPath', finalDest, now);
    logActivity(ctx, { action: kind, entityType: 'system', summary: `${kind === 'backup' ? 'نسخة احتياطية' : 'تصدير كامل'}: ${path.basename(finalDest)} — ${manifest.files.length} مرفق` });
  });
  return {
    saved: true as const,
    path: finalDest,
    size: fs.statSync(finalDest).size,
    attachments: manifest.files.length,
    counts: manifest.counts,
    verified: verify.ok,
    sameDriveWarning: sameDrive(finalDest, ctx.paths.dataDir),
  };
}

const ALLOWED_ENTRY = /^(manifest\.json|README\.txt|database\/office\.sqlite|data\/[a-z_]+\.json|attachments\/[0-9a-f]{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,5})$/;

interface Inspection {
  ok: boolean;
  manifest: Manifest | null;
  errors: string[];
  stagingDir: string | null;
}

/** يفحص الحزمة قبل أي استبدال: صيغة الأسماء، البيان، البصمات، سلامة القاعدة، ووجود المرفقات. */
export async function inspectPackageFile(file: string, paths: AppPaths, opts: { extract: boolean }): Promise<Inspection> {
  const errors: string[] = [];
  let manifest: Manifest | null = null;
  const stagingDir = opts.extract ? resolveInside(paths.tmpDir, `restore-${uuid()}`) : null;
  if (stagingDir) fs.mkdirSync(stagingDir, { recursive: true });
  const hashes = new Map<string, { size: number; sha256: string }>();
  try {
    await new Promise<void>((resolve, reject) => {
      yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
        if (err || !zip) return reject(new AppError('INTEGRITY', 'الملف ليس حزمة صالحة أو أنه تالف (تعذرت قراءة محتواه).'));
        let failed = false;
        const fail = (e: unknown) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(e);
        };
        zip.on('error', () => fail(new AppError('INTEGRITY', 'الحزمة تالفة: تعذرت قراءة بعض محتوياتها.')));
        zip.on('end', () => {
          if (!failed) resolve();
        });
        zip.on('entry', (entry: yauzl.Entry) => {
          const name = entry.fileName;
          if (name.endsWith('/')) return zip.readEntry();
          if (!ALLOWED_ENTRY.test(name) || name.includes('..') || name.includes('\\')) {
            return fail(new AppError('INTEGRITY', `الحزمة تحتوي مسارًا غير مسموح (${name.slice(0, 80)}). رُفضت لحمايتك.`));
          }
          zip.openReadStream(entry, (e2, rs) => {
            if (e2 || !rs) return fail(new AppError('INTEGRITY', 'الحزمة تالفة: تعذر فتح أحد ملفاتها.'));
            const h = createHash('sha256');
            let size = 0;
            const chunks: Buffer[] = [];
            let ws: fs.WriteStream | null = null;
            const wantBuffer = name === 'manifest.json';
            if (stagingDir && !wantBuffer && !name.startsWith('data/') && name !== 'README.txt') {
              const target = resolveInside(stagingDir, ...name.split('/'));
              fs.mkdirSync(path.dirname(target), { recursive: true });
              ws = fs.createWriteStream(target, { flags: 'wx' });
              ws.on('error', (we) => fail(mapFsError(we)));
            }
            rs.on('data', (d: Buffer) => {
              h.update(d);
              size += d.length;
              if (wantBuffer) chunks.push(d);
              if (ws) ws.write(d);
            });
            rs.on('error', () => fail(new AppError('INTEGRITY', 'الحزمة تالفة: فشل فك ضغط أحد الملفات.')));
            rs.on('end', () => {
              hashes.set(name, { size, sha256: h.digest('hex') });
              if (wantBuffer) {
                try {
                  manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                  return fail(new AppError('INTEGRITY', 'بيان الحزمة (manifest.json) غير قابل للقراءة.'));
                }
              }
              if (ws) ws.end(() => zip.readEntry());
              else zip.readEntry();
            });
          });
        });
        zip.readEntry();
      });
    });
  } catch (e) {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, manifest: null, errors: [(e as Error).message], stagingDir: null };
  }
  const m = manifest as Manifest | null;
  if (!m) errors.push('الحزمة لا تحتوي بيانًا (manifest.json).');
  else {
    if (m.format !== BACKUP_FORMAT) errors.push('هذه الحزمة ليست من برنامج إدارة مكتب المحاماة.');
    if (m.formatVersion > BACKUP_FORMAT_VERSION) errors.push('الحزمة أُنشئت بإصدار أحدث من البرنامج. حدّث البرنامج ثم أعد المحاولة.');
    if (m.schemaVersion > LATEST_SCHEMA_VERSION) errors.push(`بنية قاعدة البيانات في الحزمة (${m.schemaVersion}) أحدث من هذا الإصدار (${LATEST_SCHEMA_VERSION}).`);
    const db = hashes.get('database/office.sqlite');
    if (!db) errors.push('الحزمة لا تحتوي قاعدة البيانات.');
    else if (db.sha256 !== m.database?.sha256 || db.size !== m.database?.size) errors.push('بصمة قاعدة البيانات لا تطابق البيان — الحزمة معدلة أو تالفة.');
    const listed = new Set<string>(['manifest.json', 'database/office.sqlite', ...(m.files ?? []).map((f) => f.path), ...(m.extraFiles ?? []).map((f) => f.path)]);
    for (const name of hashes.keys()) if (!listed.has(name)) errors.push(`ملف غير مذكور في البيان داخل الحزمة: ${name}`);
    for (const f of m.extraFiles ?? []) {
      const got = hashes.get(f.path);
      if (!got) errors.push(`ملف مذكور في البيان غير موجود في الحزمة: ${f.path}`);
      else if (got.sha256 !== f.sha256 || got.size !== f.size) errors.push(`بصمة الملف لا تطابق البيان — الحزمة تالفة: ${f.path}`);
    }
    if (!Array.isArray(m.extraFiles)) errors.push('البيان لا يتضمن بصمات كل محتويات الحزمة.');
    for (const f of m.files ?? []) {
      const got = hashes.get(f.path);
      if (!got) errors.push(`مرفق مذكور في البيان غير موجود في الحزمة: ${f.path}`);
      else if (got.sha256 !== f.sha256 || got.size !== f.size) errors.push(`بصمة المرفق لا تطابق البيان: ${f.path}`);
      if (errors.length > 20) break;
    }
  }
  if (!errors.length && stagingDir && m) {
    const dbFile = path.join(stagingDir, 'database', 'office.sqlite');
    let sdb: Db | null = null;
    try {
      sdb = new Db(dbFile, { readOnly: true });
      const ic = sdb.get<{ integrity_check: string }>('PRAGMA integrity_check');
      if (ic?.integrity_check !== 'ok') errors.push('فحص سلامة قاعدة البيانات داخل الحزمة فشل.');
      const fk = sdb.all('PRAGMA foreign_key_check');
      if (fk.length) errors.push(`توجد علاقات غير متسقة داخل قاعدة البيانات (${fk.length}).`);
      const ver = currentSchemaVersion(sdb);
      if (ver !== m.schemaVersion) errors.push('إصدار البنية في القاعدة لا يطابق البيان.');
      const owner = sdb.get<{ n: number }>("SELECT count(*) AS n FROM users WHERE role = 'owner'");
      if (!owner?.n) errors.push('الحزمة لا تحتوي حساب صاحب المكتب.');
      const listed = new Map((m.files ?? []).map((f) => [path.basename(f.path), f]));
      for (const v of sdb.all<{ stored_name: string; sha256: string; size: number; original_name: string }>('SELECT stored_name, sha256, size, original_name FROM document_versions')) {
        const f = listed.get(v.stored_name);
        if (!f) errors.push(`المرفق «${v.original_name}» مسجل في القاعدة لكنه غير موجود في الحزمة.`);
        else if (f.sha256 !== v.sha256) errors.push(`المرفق «${v.original_name}» لا يطابق بصمته المسجلة.`);
        if (errors.length > 20) break;
      }
    } catch (e) {
      errors.push('تعذر فتح قاعدة البيانات داخل الحزمة: ' + (e as Error).message);
    } finally {
      sdb?.close();
    }
  }
  if (errors.length && stagingDir) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, manifest: m, errors, stagingDir: null };
  }
  return { ok: errors.length === 0, manifest: m, errors, stagingDir };
}

const pendingRestores = new Map<string, { sessionKey: string; stagingDir: string; file: string; manifest: Manifest; createdAt: number }>();

export async function inspectRestore(ctx: Ctx, input: { filePath?: string } = {}) {
  requireOwner(ctx);
  const file =
    input.filePath ??
    (await ctx.platform.showOpenFile({ title: 'اختيار حزمة نسخة احتياطية للاستعادة', filters: [{ name: 'حزمة مكتب المحاماة', extensions: [BACKUP_EXT, 'zip'] }] }));
  if (!file) return { selected: false as const };
  const r = await inspectPackageFile(file, ctx.paths, { extract: true });
  if (!r.ok || !r.manifest || !r.stagingDir) {
    logActivity(ctx, { action: 'restore', entityType: 'system', summary: `رفض حزمة استعادة غير سليمة: ${path.basename(file)}`, details: { errors: r.errors.slice(0, 10) } });
    return { selected: true as const, ok: false as const, errors: r.errors };
  }
  for (const [k, v] of pendingRestores) {
    if (v.sessionKey === ctx.sessionKey) {
      fs.rmSync(v.stagingDir, { recursive: true, force: true });
      pendingRestores.delete(k);
    }
  }
  const token = uuid();
  pendingRestores.set(token, { sessionKey: ctx.sessionKey, stagingDir: r.stagingDir, file, manifest: r.manifest, createdAt: Date.now() });
  return {
    selected: true as const,
    ok: true as const,
    token,
    fileName: path.basename(file),
    manifest: {
      createdAt: r.manifest.createdAt,
      createdBy: r.manifest.createdBy,
      appVersion: r.manifest.appVersion,
      schemaVersion: r.manifest.schemaVersion,
      officeName: r.manifest.officeName,
      counts: r.manifest.counts,
      attachments: r.manifest.files.length,
    },
  };
}

export function cancelRestore(ctx: Ctx, input: { token: string }) {
  requireOwner(ctx);
  const p = pendingRestores.get(input.token);
  if (p && p.sessionKey === ctx.sessionKey) {
    fs.rmSync(p.stagingDir, { recursive: true, force: true });
    pendingRestores.delete(input.token);
  }
  return { ok: true };
}

export interface DbSwapper {
  close(): void;
  reopen(): Db;
}

/** تطبيق الاستعادة: نسخة تلقائية من الحالة الحالية أولًا، ثم استبدال ذري مع تراجع عند الفشل. */
export async function applyRestore(ctx: Ctx, input: { token: string }, appVersion: string, swapper: DbSwapper) {
  const u = requireOwner(ctx);
  const p = pendingRestores.get(input.token);
  if (!p || p.sessionKey !== ctx.sessionKey) throw new AppError('VALIDATION', 'انتهت صلاحية طلب الاستعادة. اختر الحزمة مرة أخرى.');
  pendingRestores.delete(input.token);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  const preBackup = path.join(ctx.paths.autoBackupsDir, `قبل-الاستعادة-${stamp}.${BACKUP_EXT}`);
  try {
    await writePackage(ctx.db, ctx.paths, preBackup, { appVersion, createdBy: u.username, now: ctx.now() });
  } catch (e) {
    fs.rmSync(p.stagingDir, { recursive: true, force: true });
    throw new AppError('STORAGE', 'تعذر إنشاء نسخة تلقائية من البيانات الحالية قبل الاستعادة، لذلك لم تُستبدل البيانات. ' + (e as Error).message);
  }
  const moved = resolveInside(ctx.paths.tmpDir, `replaced-${stamp}`);
  fs.mkdirSync(moved, { recursive: true });
  const dbFiles = [ctx.paths.dbFile, `${ctx.paths.dbFile}-wal`, `${ctx.paths.dbFile}-shm`];
  const stagedAttachments = path.join(p.stagingDir, 'attachments');
  swapper.close();
  let swapped = false;
  try {
    for (const f of dbFiles) if (fs.existsSync(f)) fs.renameSync(f, path.join(moved, path.basename(f)));
    fs.renameSync(ctx.paths.attachmentsDir, path.join(moved, 'attachments'));
    swapped = true;
    fs.renameSync(path.join(p.stagingDir, 'database', 'office.sqlite'), ctx.paths.dbFile);
    if (fs.existsSync(stagedAttachments)) fs.renameSync(stagedAttachments, ctx.paths.attachmentsDir);
    else fs.mkdirSync(ctx.paths.attachmentsDir, { recursive: true });
    fs.mkdirSync(ctx.paths.stagingDir, { recursive: true });
    const db = swapper.reopen();
    const ic = db.get<{ quick_check: string }>('PRAGMA quick_check');
    if (ic?.quick_check !== 'ok') throw new Error('فحص السلامة بعد الاستعادة فشل');
    ctx.db = db;
  } catch (e) {
    // تراجع كامل إلى البيانات السابقة
    try {
      swapper.close();
    } catch {
      /* */
    }
    if (swapped) {
      for (const f of dbFiles) fs.rmSync(f, { force: true });
      fs.rmSync(ctx.paths.attachmentsDir, { recursive: true, force: true });
      for (const f of dbFiles) {
        const src = path.join(moved, path.basename(f));
        if (fs.existsSync(src)) fs.renameSync(src, f);
      }
      if (fs.existsSync(path.join(moved, 'attachments'))) fs.renameSync(path.join(moved, 'attachments'), ctx.paths.attachmentsDir);
    }
    ctx.db = swapper.reopen();
    fs.rmSync(p.stagingDir, { recursive: true, force: true });
    throw new AppError('STORAGE', 'فشلت الاستعادة وأُعيدت البيانات السابقة كما كانت. ' + (e as Error).message);
  }
  fs.rmSync(p.stagingDir, { recursive: true, force: true });
  fs.rmSync(moved, { recursive: true, force: true });
  logActivity(ctx, {
    action: 'restore',
    entityType: 'system',
    summary: `استعادة البيانات من ${path.basename(p.file)} (نسخة ${p.manifest.createdAt.slice(0, 10)}). نسخة ما قبل الاستعادة: ${path.basename(preBackup)}`,
  }, { id: ctx.db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [u.id]) ? u.id : null, username: u.username });
  return { ok: true, preRestoreBackup: preBackup };
}

/** لقطة يومية تلقائية لقاعدة البيانات فقط داخل مجلد البيانات (تحمي من الأخطاء، لا من تلف الجهاز). */
export function autoSnapshot(db: Db, paths: AppPaths, now: Date, keep = 7): string | null {
  const last = readSetting(db, 'backup.lastAutoSnapshotAt');
  if (last && todayRiyadh(new Date(last)) === todayRiyadh(now)) return null;
  const file = path.join(paths.autoBackupsDir, `يومية-${todayRiyadh(now)}.sqlite`);
  try {
    fs.rmSync(file, { force: true });
    db.raw.prepare('VACUUM INTO ?').run(file);
    writeSetting(db, 'backup.lastAutoSnapshotAt', now.toISOString(), now.toISOString());
    const daily = fs
      .readdirSync(paths.autoBackupsDir)
      .filter((f) => f.startsWith('يومية-') && f.endsWith('.sqlite'))
      .sort();
    for (const old of daily.slice(0, Math.max(0, daily.length - keep))) fs.rmSync(path.join(paths.autoBackupsDir, old), { force: true });
    return file;
  } catch {
    return null;
  }
}

export function backupStatus(ctx: Ctx) {
  requireOwner(ctx);
  return {
    lastBackupAt: readSetting(ctx.db, 'backup.lastBackupAt'),
    lastBackupPath: readSetting(ctx.db, 'backup.lastBackupPath'),
    reminderDays: readSetting(ctx.db, 'backup.reminderDays'),
    lastAutoSnapshotAt: readSetting(ctx.db, 'backup.lastAutoSnapshotAt'),
    autoBackups: fs.existsSync(ctx.paths.autoBackupsDir)
      ? fs
          .readdirSync(ctx.paths.autoBackupsDir)
          .filter((f) => !f.startsWith('.'))
          .map((f) => ({ name: f, size: fs.statSync(path.join(ctx.paths.autoBackupsDir, f)).size }))
      : [],
  };
}
