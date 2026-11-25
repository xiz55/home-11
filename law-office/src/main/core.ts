// نواة التطبيق المستقلة عن واجهة Electron: قاعدة البيانات، المسارات، الجلسات، ومُرسل الأوامر.
// تُستخدم من main.ts وفي الاختبارات مباشرة (بما فيها اختبار استدعاء الأوامر دون الواجهة).
import fs from 'node:fs';
import path from 'node:path';
import { Db } from './db/db';
import { migrate, currentSchemaVersion, LATEST_SCHEMA_VERSION } from './db/migrations';
import { buildPaths, ensureDirs, appendLog, type AppPaths } from './paths';
import { nullPlatform, type Ctx, type Platform } from './context';
import { AppError } from './errors';
import { loadSessionUser } from './services/auth';
import { readSetting, seedDefaults } from './services/settings';
import { setVersionAddedHook, cleanupStaging } from './services/documents';
import { ExtractionQueue } from './extract/queue';
import { markMissed } from './services/reminders';
import { autoSnapshot } from './services/backup';
import { REGISTRY, type MethodName } from './ipc/registry';
import { zodFieldErrors } from '../shared/schemas';
import { ZodError } from 'zod';
import type { CloudService } from '../sync/cloudService';
import type { HubClient } from '../sync/hubClient';
import type { HubController } from '../hub/controller';

export interface Session {
  userId: string;
  lastActivity: number;
  locked: boolean;
  dirty: boolean;
}

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; fields?: Record<string, string>; extra?: Record<string, unknown> } };

/** قبل ترقية بنية قاعدة بيانات قائمة: لقطة متسقة كاملة (VACUUM INTO) تُحفظ مع النسخ التلقائية. فشلها يمنع الترقية. */
export function preMigrationSnapshot(db: Db, paths: AppPaths, now: Date): string | null {
  const cur = currentSchemaVersion(db);
  if (cur === 0 || cur >= LATEST_SCHEMA_VERSION) return null;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(paths.autoBackupsDir, `قبل-الترقية-بنية${cur}-${stamp}.sqlite`);
  fs.mkdirSync(paths.autoBackupsDir, { recursive: true });
  db.raw.prepare('VACUUM INTO ?').run(file);
  const check = new Db(file, { readOnly: true });
  try {
    const ic = check.get<{ integrity_check: string }>('PRAGMA integrity_check');
    if (ic?.integrity_check !== 'ok') throw new Error('فحص سلامة نسخة ما قبل الترقية فشل؛ لم تُطبق الترقية.');
  } finally {
    check.close();
  }
  appendLog(paths, `pre-migration snapshot ${cur} -> ${LATEST_SCHEMA_VERSION}: ${file}`);
  return file;
}

export class AppCore {
  db!: Db;
  readonly paths: AppPaths;
  readonly sessions = new Map<string, Session>();
  extraction: ExtractionQueue;
  /** خدمة الحساب السحابي والمزامنة (اختيارية؛ تُضبط من العملية الرئيسية) */
  cloud: CloudService | null = null;
  /** هذا الجهاز «خادم المكتب» (جهاز المكتب الدائم) */
  hub: HubController | null = null;
  /** هذا الجهاز مرتبط بخادم المكتب (الماك) */
  hubClient: HubClient | null = null;
  onLocked?: (sessionKey: string) => void;
  private noExtraction = false;

  constructor(
    dataDir: string,
    public platform: Platform = nullPlatform,
    public now: () => Date = () => new Date(),
    opts: { extractWorkerFile?: string | null; inlineExtractor?: ConstructorParameters<typeof ExtractionQueue>[3]; noExtraction?: boolean } = {},
  ) {
    this.paths = buildPaths(dataDir);
    ensureDirs(this.paths);
    this.openDb();
    cleanupStaging(this.paths.stagingDir);
    try {
      fs.rmSync(this.paths.workingDir, { recursive: true, force: true });
      fs.mkdirSync(this.paths.workingDir, { recursive: true });
    } catch {
      /* نسخة اطلاع مفتوحة في برنامج آخر */
    }
    this.extraction = new ExtractionQueue(() => this.db, this.paths, opts.extractWorkerFile ?? null, opts.inlineExtractor);
    // الآيفون: لا استخراج نصوص محليًا؛ تبقى النسخ «بانتظار الاستخراج» ويستخرجها جهاز سطح المكتب بعد المزامنة
    this.noExtraction = !!opts.noExtraction;
    setVersionAddedHook((vid) => (this.noExtraction ? undefined : this.extraction.enqueue(vid)));
  }

  openDb(): Db {
    this.db = new Db(this.paths.dbFile);
    preMigrationSnapshot(this.db, this.paths, this.now());
    migrate(this.db, () => this.now().toISOString());
    seedDefaults(this.db, this.now().toISOString());
    return this.db;
  }

  closeDb() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* */
    }
    this.db.close();
  }

  startup() {
    const ctx = this.systemCtx();
    markMissed(ctx);
    autoSnapshot(this.db, this.paths, this.now());
    if (!this.noExtraction) this.extraction.enqueuePending();
  }

  systemCtx(): Ctx {
    return { db: this.db, paths: this.paths, user: null, sessionKey: 'system', platform: this.platform, now: this.now };
  }

  idleMs(): number {
    return Math.max(1, readSetting(this.db, 'security.idleLockMinutes')) * 60_000;
  }

  /** يتحقق من الخمول ويقفل الجلسة عند تجاوز المدة. */
  checkIdle(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey);
    if (!s || s.locked) return false;
    if (this.now().getTime() - s.lastActivity > this.idleMs()) {
      s.locked = true;
      this.onLocked?.(sessionKey);
      return true;
    }
    return false;
  }

  async dispatch(sessionKey: string, channel: string, payload: unknown): Promise<ApiResult> {
    const def = (REGISTRY as Record<string, (typeof REGISTRY)[MethodName]>)[channel];
    if (!def) return { ok: false, error: { code: 'NOT_FOUND', message: 'أمر غير معروف' } };
    try {
      const parsed = def.schema.safeParse(payload ?? {});
      if (!parsed.success) {
        return { ok: false, error: { code: 'VALIDATION', message: 'تحقق من الحقول المظللة', fields: zodFieldErrors(parsed.error) } };
      }
      const session = this.sessions.get(sessionKey) ?? null;
      let user = null;
      if (def.auth !== 'public') {
        if (!session) throw new AppError('UNAUTHENTICATED', 'انتهت الجلسة. سجّل الدخول مرة أخرى.');
        this.checkIdle(sessionKey);
        if (session.locked && !def.allowWhenLocked) throw new AppError('LOCKED', 'الجلسة مقفلة بسبب الخمول. أدخل كلمة المرور للمتابعة.');
        user = loadSessionUser({ db: this.db } as Ctx, session.userId);
        if (!user) {
          this.sessions.delete(sessionKey);
          throw new AppError('UNAUTHENTICATED', 'الحساب غير متاح أو موقوف. سجّل الدخول مرة أخرى.');
        }
        if (def.auth === 'owner' && user.role !== 'owner') throw new AppError('FORBIDDEN', 'هذا الإجراء متاح لصاحب المكتب فقط');
        if (!def.passive && !session.locked) session.lastActivity = this.now().getTime();
      }
      const ctx: Ctx = { db: this.db, paths: this.paths, user, sessionKey, platform: this.platform, now: this.now };
      const data = await def.handler(ctx, parsed.data as never, this);
      // أي تعديل محلي يُجدول مزامنة قريبة (الطابور الدائم يحفظه حتى لو لم يتوفر اتصال)
      if (this.cloud && !def.passive && !channel.startsWith('cloud.')) this.cloud.localChanged();
      if (this.hubClient && !def.passive && !channel.startsWith('hub.')) this.hubClient.localChanged();
      return { ok: true, data };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, fields: e.fields, extra: e.extra } };
      if (e instanceof ZodError) return { ok: false, error: { code: 'VALIDATION', message: 'تحقق من الحقول المظللة', fields: zodFieldErrors(e) } };
      const err = e as Error;
      appendLog(this.paths, `ERROR ${channel}: ${err?.stack ?? err}`);
      if (/SQLITE_FULL|disk is full|ENOSPC/i.test(err?.message ?? '')) return { ok: false, error: { code: 'STORAGE', message: 'مساحة القرص غير كافية. لم يُحفظ التغيير.' } };
      if (/SQLITE_BUSY|database is locked/i.test(err?.message ?? '')) return { ok: false, error: { code: 'CONFLICT', message: 'قاعدة البيانات مشغولة مؤقتًا. أعد المحاولة بعد لحظات.' } };
      return { ok: false, error: { code: 'INTERNAL', message: 'حدث خطأ غير متوقع ولم يُحفظ التغيير. سُجّل الخطأ في سجل البرنامج.' } };
    }
  }

  shutdown() {
    this.extraction.stop();
    this.closeDb();
  }
}
