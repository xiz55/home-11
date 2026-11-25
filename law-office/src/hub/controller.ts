// تشغيل «خادم المكتب» وإعداده على جهاز المكتب: المنفذ، بريد Gmail لإرسال الرموز، بريد كل مستخدم، والأجهزة.
// كلمة مرور تطبيق Gmail تُحفظ في مخزن أسرار النظام (DPAPI على ويندوز) لا في قاعدة البيانات ولا في النسخ الاحتياطية.
import type http from 'node:http';
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import type { AppCore } from '../main/core';
import type { SecretStore } from '../sync/cloudService';
import { HubStore, ensureHubSchema, hubGet, hubSet } from './store';
import { createHubServer } from './server';
import type { Mailer } from './auth';
import { readSetting } from '../main/services/settings';

export interface HubControllerDeps {
  core: AppCore;
  secrets: SecretStore;
  webDir: string | null;
  /** للاختبار: بديل لإرسال البريد */
  mailer?: Mailer;
  onState?: () => void;
}

export function gmailMailer(user: string, pass: string): Mailer {
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  return {
    async send(to, subject, text) {
      await t.sendMail({ from: `"مكتب المحاماة" <${user}>`, to, subject, text });
    },
  };
}

export class HubController {
  private server: http.Server | null = null;
  readonly store: HubStore;
  private gmailUser: string | null = null;
  private gmailPass: string | null = null;

  constructor(private d: HubControllerDeps) {
    this.store = new HubStore(() => d.core.db);
  }

  private db() {
    return this.d.core.db;
  }

  async init() {
    ensureHubSchema(this.db());
    this.gmailUser = await this.d.secrets.get('hub.gmail.user');
    this.gmailPass = await this.d.secrets.get('hub.gmail.pass');
    if (hubGet(this.db(), 'enabled') === '1') await this.start();
  }

  private mailer(): Mailer {
    if (this.d.mailer) return this.d.mailer;
    // اختبارات التشغيل الفعلي فقط: تُكتب الرسالة في ملف بدل إرسالها (لا يُفعّل إلا بمتغير بيئة الاختبار)
    const box = process.env.LAWOFFICE_TEST_MAILBOX;
    if (box) return { send: async (to, subject, text) => fs.appendFileSync(box, JSON.stringify({ to, subject, text }) + '\n') };
    return {
      send: async (to, subject, text) => {
        if (!this.gmailUser || !this.gmailPass) throw new Error('البريد غير مضبوط');
        await gmailMailer(this.gmailUser, this.gmailPass).send(to, subject, text);
      },
    };
  }

  port(): number {
    return Number(hubGet(this.db(), 'port') ?? '8787');
  }

  running() {
    return !!this.server?.listening;
  }

  private async start() {
    if (this.running()) return;
    this.store.enable();
    const srv = createHubServer({ core: this.d.core, store: this.store, mailer: this.mailer(), webDir: this.d.webDir, officeName: () => readSetting(this.db(), 'office.name') });
    await new Promise<void>((ok, bad) => {
      srv.once('error', bad);
      // على هذا الجهاز فقط؛ الوصول من الخارج عبر Tailscale Funnel المشفّر
      srv.listen(this.port(), '127.0.0.1', () => ok());
    });
    this.server = srv;
  }

  async enable(port: number) {
    hubSet(this.db(), 'port', String(port));
    if (this.running()) await this.disable(false);
    await this.start();
    hubSet(this.db(), 'enabled', '1');
    this.d.onState?.();
  }

  async disable(persist = true) {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    if (persist) hubSet(this.db(), 'enabled', '0');
    this.d.onState?.();
  }

  async setGmail(user: string, pass: string) {
    this.gmailUser = user.trim().toLowerCase();
    this.gmailPass = pass.replace(/\s+/g, '');
    await this.d.secrets.set('hub.gmail.user', this.gmailUser);
    await this.d.secrets.set('hub.gmail.pass', this.gmailPass);
  }

  async sendTest(to: string) {
    await this.mailer().send(to, 'تجربة إرسال رمز التحقق', 'وصلت هذه الرسالة من برنامج المكتب: إعداد البريد يعمل، وستصلك رموز الدخول من الأجهزة الجديدة على هذا العنوان.');
  }

  setUserEmail(userId: string, email: string | null) {
    if (email) this.db().run('INSERT INTO hub_user_email (user_id, email) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email', [userId, email.trim().toLowerCase()]);
    else this.db().run('DELETE FROM hub_user_email WHERE user_id = ?', [userId]);
  }

  setPublicUrl(url: string | null) {
    hubSet(this.db(), 'public_url', url ? url.trim().replace(/\/+$/, '') : null);
  }

  revokeDevice(id: string) {
    this.db().run('UPDATE hub_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [this.d.core.now().toISOString(), id]);
    this.d.core.sessions.delete(`web-${id}`);
  }

  state() {
    const db = this.db();
    return {
      enabled: hubGet(db, 'enabled') === '1',
      running: this.running(),
      port: this.port(),
      publicUrl: hubGet(db, 'public_url'),
      gmailUser: this.gmailUser,
      gmailConfigured: !!(this.gmailUser && this.gmailPass),
      users: db.all<{ id: string; display_name: string; username: string; role: string; email: string | null }>(
        'SELECT u.id, u.display_name, u.username, u.role, e.email FROM users u LEFT JOIN hub_user_email e ON e.user_id = u.id WHERE u.active = 1 ORDER BY u.role DESC, u.display_name',
      ),
      devices: db.all<{ id: string; user_name: string; kind: string; name: string; platform: string; created_at: string; last_seen: string | null; revoked_at: string | null; trusted_until: string | null }>(
        'SELECT d.id, u.display_name AS user_name, d.kind, d.name, d.platform, d.created_at, d.last_seen, d.revoked_at, d.trusted_until FROM hub_devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.revoked_at IS NOT NULL, d.last_seen DESC',
      ),
    };
  }
}
