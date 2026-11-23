import { randomUUID } from 'node:crypto';
import type { Db } from './db/db';
import type { AppPaths } from './paths';
import type { Permission, Role } from '../shared/constants';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  permissions: Set<Permission>;
}

/** محولات نظام التشغيل (نوافذ الحوار، فتح الملفات، الإشعارات). تُحقن من Electron وتُستبدل في الاختبارات. */
export interface Platform {
  showOpenFile(opts: { title: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  showSaveFile(opts: { title: string; defaultName: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  openPath(p: string): Promise<string>; // يعيد نص الخطأ أو '' عند النجاح
  showItemInFolder(p: string): void;
  printHtml?(html: string): Promise<void>;
  htmlToPdf?(html: string): Promise<Buffer>;
}

export interface Ctx {
  db: Db;
  paths: AppPaths;
  user: SessionUser | null;
  sessionKey: string;
  platform: Platform;
  now(): Date;
}

export const uuid = (): string => randomUUID();
export const nowIso = (ctx: Ctx): string => ctx.now().toISOString();

export const nullPlatform: Platform = {
  async showOpenFile() {
    return null;
  },
  async showSaveFile() {
    return null;
  },
  async openPath() {
    return 'غير متاح';
  },
  showItemInFolder() {},
};
