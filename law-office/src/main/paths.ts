import fs from 'node:fs';
import path from 'node:path';

export interface AppPaths {
  dataDir: string;
  dbFile: string;
  attachmentsDir: string;
  stagingDir: string;
  workingDir: string;
  exportsDir: string;
  backupsDir: string;
  autoBackupsDir: string;
  tmpDir: string;
  integrationDir: string;
  accessLogDb: string;
  logsDir: string;
  lockFile: string;
}

export function buildPaths(dataDir: string): AppPaths {
  const d = path.resolve(dataDir);
  return {
    dataDir: d,
    dbFile: path.join(d, 'office.sqlite'),
    attachmentsDir: path.join(d, 'attachments'),
    stagingDir: path.join(d, 'attachments', '.staging'),
    workingDir: path.join(d, 'working-copies'),
    exportsDir: path.join(d, 'exports'),
    backupsDir: path.join(d, 'backups'),
    autoBackupsDir: path.join(d, 'backups', 'auto'),
    tmpDir: path.join(d, 'tmp'),
    integrationDir: path.join(d, 'integration'),
    accessLogDb: path.join(d, 'integration', 'access-log.sqlite'),
    logsDir: path.join(d, 'logs'),
    lockFile: path.join(d, 'app.lock'),
  };
}

export function ensureDirs(p: AppPaths): void {
  for (const dir of [
    p.dataDir,
    p.attachmentsDir,
    p.stagingDir,
    p.workingDir,
    p.exportsDir,
    p.backupsDir,
    p.autoBackupsDir,
    p.tmpDir,
    p.integrationDir,
    p.logsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** يتحقق أن المسار الناتج داخل المجلد الأساسي (منع اجتياز المسارات). */
export function resolveInside(base: string, ...parts: string[]): string {
  const b = path.resolve(base);
  const target = path.resolve(b, ...parts);
  const rel = path.relative(b, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('مسار غير مسموح');
  }
  return target;
}

/** مسار ملف المرفق الداخلي: attachments/ab/<uuid>.<ext> */
export function attachmentPath(p: AppPaths, storedName: string): string {
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(storedName)) throw new Error('اسم مرفق داخلي غير صالح');
  return resolveInside(p.attachmentsDir, storedName.slice(0, 2), storedName);
}

export function appendLog(p: AppPaths, line: string): void {
  try {
    fs.mkdirSync(p.logsDir, { recursive: true });
    fs.appendFileSync(path.join(p.logsDir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* لا يوقف السجل عمل البرنامج */
  }
}
