// سجل أوامر IPC: لكل أمر قناة مستقلة ومخطط تحقق ومستوى صلاحية. لا توجد قناة SQL عامة أو قراءة مسارات أو تشغيل أوامر.
import { z } from 'zod';
import type { Ctx } from '../context';
import type { AppCore } from '../core';
import { AppError } from '../errors';
import * as S from '../../shared/schemas';
import { LOOKUP_LIST_KEYS } from '../../shared/constants';
import * as auth from '../services/auth';
import * as settings from '../services/settings';
import * as clients from '../services/clients';
import * as cases from '../services/cases';
import * as hearings from '../services/hearings';
import * as judgments from '../services/judgments';
import * as memos from '../services/memos';
import * as documents from '../services/documents';
import * as analysis from '../services/analysis';
import * as tasks from '../services/tasks';
import * as calendar from '../services/calendar';
import * as finance from '../services/finance';
import * as notes from '../services/notes';
import * as search from '../services/search';
import * as timeline from '../services/timeline';
import * as reminders from '../services/reminders';
import * as reports from '../services/reports';
import * as backup from '../services/backup';
import * as integration from '../services/integration';
import { listActivity } from '../services/activity';
import { runtime } from '../runtime';
import fs from 'node:fs';
import path from 'node:path';

type Auth = 'public' | 'user' | 'owner';
interface Def<I extends z.ZodTypeAny, R> {
  auth: Auth;
  schema: I;
  handler: (ctx: Ctx, input: z.output<I>, core: AppCore) => R | Promise<R>;
  allowWhenLocked?: boolean;
  passive?: boolean;
}
function def<I extends z.ZodTypeAny, R>(auth: Auth, schema: I, handler: Def<I, R>['handler'], opts: { allowWhenLocked?: boolean; passive?: boolean } = {}): Def<I, R> {
  return { auth, schema, handler, ...opts };
}

const empty = z.object({}).strict().default({});
const byId = z.object({ id: S.id });
const byCase = z.object({ caseId: S.id });

function sessionUserView(ctx: Ctx) {
  const u = ctx.user!;
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, permissions: [...u.permissions] };
}

function startSession(core: AppCore, sessionKey: string, userId: string) {
  core.sessions.set(sessionKey, { userId, lastActivity: core.now().getTime(), locked: false, dirty: false });
}

export const REGISTRY = {
  // ———— الجلسة والمصادقة ————
  'auth.state': def(
    'public',
    empty,
    (ctx, _i, core) => {
      const s = core.sessions.get(ctx.sessionKey);
      if (s) core.checkIdle(ctx.sessionKey);
      const user = s ? auth.loadSessionUser(ctx, s.userId) : null;
      if (s && !user) core.sessions.delete(ctx.sessionKey);
      return {
        initialized: auth.isInitialized(ctx),
        officeName: settings.readSetting(ctx.db, 'office.name'),
        user: user ? { id: user.id, username: user.username, displayName: user.displayName, role: user.role, permissions: [...user.permissions] } : null,
        locked: !!(s && user && s.locked),
        idleMinutes: settings.readSetting(ctx.db, 'security.idleLockMinutes'),
        appVersion: runtime.appVersion,
        customDataDir: runtime.customDataDir ? ctx.paths.dataDir : null,
      };
    },
    { passive: true },
  ),
  'auth.setupOwner': def('public', S.setupOwnerInput, async (ctx, i, core) => {
    const r = await auth.setupOwner(ctx, i);
    startSession(core, ctx.sessionKey, r.user.id);
    return { recoveryCode: r.recoveryCode };
  }),
  'auth.login': def('public', S.loginInput, async (ctx, i, core) => {
    const u = await auth.login(ctx, i);
    startSession(core, ctx.sessionKey, u.id);
    return { ok: true };
  }),
  'auth.recover': def('public', S.recoverInput, async (ctx, i, core) => {
    const r = await auth.recoverOwner(ctx, i);
    startSession(core, ctx.sessionKey, r.user.id);
    return { recoveryCode: r.recoveryCode };
  }),
  'auth.unlock': def(
    'user',
    S.unlockInput,
    async (ctx, i, core) => {
      const s = core.sessions.get(ctx.sessionKey)!;
      if (!(await auth.verifyUserPassword(ctx, s.userId, i.password))) {
        throw new AppError('VALIDATION', 'كلمة المرور غير صحيحة', { password: 'كلمة المرور غير صحيحة' });
      }
      s.locked = false;
      s.lastActivity = core.now().getTime();
      return { ok: true };
    },
    { allowWhenLocked: true },
  ),
  'auth.logout': def(
    'user',
    empty,
    (ctx, _i, core) => {
      core.sessions.delete(ctx.sessionKey);
      return { ok: true };
    },
    { allowWhenLocked: true },
  ),
  'auth.lock': def('user', empty, (ctx, _i, core) => {
    const s = core.sessions.get(ctx.sessionKey)!;
    s.locked = true;
    return { ok: true };
  }),
  'auth.changePassword': def('user', S.changePasswordInput, (ctx, i) => auth.changePassword(ctx, i)),
  'auth.regenerateRecoveryCode': def('owner', z.object({ password: z.string().min(1).max(200) }), (ctx, i) => auth.regenerateRecoveryCode(ctx, i)),
  'auth.me': def('user', empty, (ctx) => sessionUserView(ctx), { passive: true }),
  'session.ping': def('user', empty, () => ({ ok: true })),
  'ui.setDirty': def(
    'public',
    z.object({ dirty: z.boolean() }),
    (ctx, i, core) => {
      const s = core.sessions.get(ctx.sessionKey);
      if (s) s.dirty = i.dirty;
      return { ok: true };
    },
    { passive: true },
  ),

  // ———— المستخدمون ————
  'users.list': def('owner', empty, (ctx) => auth.listUsers(ctx)),
  'users.assignable': def('user', empty, (ctx) => auth.listAssignableUsers(ctx), { passive: true }),
  'users.create': def('owner', S.userCreateInput, (ctx, i) => auth.createUser(ctx, i)),
  'users.update': def('owner', S.userUpdateInput, (ctx, i) => auth.updateUser(ctx, i)),
  'users.resetPassword': def('owner', S.userResetPasswordInput, (ctx, i) => auth.resetUserPassword(ctx, i)),
  'users.getAccess': def('owner', z.object({ userId: S.id }), (ctx, i) => auth.getUserAccess(ctx, i)),
  'users.setAccess': def('owner', S.userAccessInput, (ctx, i) => auth.setUserAccess(ctx, i)),

  // ———— الإعدادات والقوائم ————
  'settings.get': def('user', empty, (ctx) => settings.getSettings(ctx), { passive: true }),
  'settings.update': def('owner', S.settingsPatchInput, (ctx, i) => {
    const r = settings.updateSettings(ctx, i as never);
    if (i['reminders.hearingOffsets'] || i['reminders.taskTime'] || i['reminders.enabled'] !== undefined) reminders.rebuildAllReminders(ctx);
    return r;
  }),
  'lookups.list': def('user', z.object({ listKey: z.enum(LOOKUP_LIST_KEYS).nullish() }).default({}), (ctx, i) => settings.listLookups(ctx, i.listKey), { passive: true }),
  'lookups.add': def('owner', S.lookupAddInput, (ctx, i) => settings.addLookup(ctx, i)),
  'lookups.update': def('owner', S.lookupUpdateInput, (ctx, i) => settings.updateLookup(ctx, i)),
  'system.info': def('owner', empty, (ctx) => {
    const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
    let attachmentsBytes = 0;
    let attachmentsCount = 0;
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          attachmentsBytes += size(p);
          attachmentsCount++;
        }
      }
    };
    walk(ctx.paths.attachmentsDir);
    return {
      dataDir: ctx.paths.dataDir,
      dbFile: ctx.paths.dbFile,
      dbBytes: size(ctx.paths.dbFile) + size(ctx.paths.dbFile + '-wal'),
      attachmentsDir: ctx.paths.attachmentsDir,
      attachmentsBytes,
      attachmentsCount,
      autoBackupsDir: ctx.paths.autoBackupsDir,
      appVersion: runtime.appVersion,
      execPath: runtime.execPath,
      isPackaged: runtime.isPackaged,
      customDataDir: runtime.customDataDir,
    };
  }),
  'system.openDataFolder': def('owner', empty, async (ctx) => {
    const err = await ctx.platform.openPath(ctx.paths.dataDir);
    return { ok: !err, message: err || null };
  }),
  'system.openGuide': def('user', empty, async (ctx) => {
    const f = path.join(runtime.docsDir, 'دليل-الاستخدام.html');
    if (!fs.existsSync(f)) throw new AppError('NOT_FOUND', 'ملف الدليل غير موجود في مجلد البرنامج');
    const err = await ctx.platform.openPath(f);
    return { ok: !err, message: err || null };
  }),
  'system.verifyAttachments': def('owner', z.object({ hash: z.boolean().default(false) }).default({}), (ctx, i) => documents.verifyAttachments(ctx, { hash: i.hash })),
  'activity.list': def('owner', z.object({ caseId: S.optId, userId: S.optId, limit: z.number().int().min(1).max(1000).default(200), before: z.string().max(40).nullish() }).default({}), (ctx, i) => listActivity(ctx, i)),

  // ———— الرئيسية والبحث ————
  'dashboard.get': def('user', empty, (ctx) => calendar.dashboard(ctx), { passive: true }),
  'search.global': def('user', z.object({ q: z.string().max(200) }), (ctx, i) => search.globalSearch(ctx, i)),

  // ———— العملاء ————
  'clients.list': def('user', S.clientListInput, (ctx, i) => clients.listClients(ctx, i)),
  'clients.options': def('user', empty, (ctx) => clients.clientOptions(ctx), { passive: true }),
  'clients.get': def('user', byId, (ctx, i) => clients.getClient(ctx, i)),
  'clients.create': def('user', S.clientInput, (ctx, i) => clients.createClient(ctx, i)),
  'clients.update': def('user', S.clientUpdateInput, (ctx, i) => clients.updateClient(ctx, i)),
  'clients.setStatus': def('user', S.clientStatusInput, (ctx, i) => clients.setClientStatus(ctx, i)),
  'clients.similar': def('user', S.similarClientsInput, (ctx, i) => clients.findSimilarClients(ctx, i), { passive: true }),

  // ———— القضايا ————
  'cases.list': def('user', S.caseListInput, (ctx, i) => cases.listCases(ctx, i)),
  'cases.options': def('user', z.object({ clientId: S.optId }).default({}), (ctx, i) => cases.caseOptions(ctx, i), { passive: true }),
  'cases.get': def('user', byId, (ctx, i) => cases.getCase(ctx, i)),
  'cases.create': def('user', S.caseCreateInput, (ctx, i) => cases.createCase(ctx, i)),
  'cases.update': def('user', S.caseUpdateInput, (ctx, i) => cases.updateCase(ctx, i)),
  'cases.closeChecklist': def('user', byId, (ctx, i) => cases.closeChecklist(ctx, i)),
  'cases.close': def('user', S.caseCloseInput, (ctx, i) => cases.closeCase(ctx, i)),
  'cases.reopen': def('user', S.caseReopenInput, (ctx, i) => cases.reopenCase(ctx, i)),
  'cases.setArchived': def('user', S.caseArchiveInput, (ctx, i) => cases.setCaseArchived(ctx, i)),
  'cases.timeline': def('user', byId, (ctx, i) => timeline.caseTimeline(ctx, i)),
  'parties.save': def('user', S.partySaveInput, (ctx, i) => cases.saveParty(ctx, i)),
  'parties.remove': def('user', byId, (ctx, i) => cases.removeParty(ctx, i)),
  'stages.list': def('user', byCase, (ctx, i) => cases.listStages(ctx, i.caseId)),
  'stages.create': def('user', S.stageCreateInput, (ctx, i) => cases.createStage(ctx, i)),
  'stages.update': def('user', S.stageUpdateInput, (ctx, i) => cases.updateStage(ctx, i)),
  'stages.remove': def('user', byId, (ctx, i) => cases.removeStage(ctx, i)),
  'relatedWorks.save': def('user', S.relatedWorkInput, (ctx, i) => cases.saveRelatedWork(ctx, i)),

  // ———— الجلسات والأحكام ————
  'hearings.list': def('user', byCase, (ctx, i) => hearings.listHearingsForCase(ctx, i.caseId)),
  'hearings.get': def('user', byId, (ctx, i) => hearings.getHearing(ctx, i)),
  'hearings.create': def('user', S.hearingCreateInput, (ctx, i) => hearings.createHearing(ctx, i)),
  'hearings.update': def('user', S.hearingUpdateInput, (ctx, i) => hearings.updateHearing(ctx, i)),
  'hearings.saveRequest': def('user', S.hearingRequestInput, (ctx, i) => hearings.saveHearingRequest(ctx, i)),
  'hearings.removeRequest': def('user', byId, (ctx, i) => hearings.removeHearingRequest(ctx, i)),
  'hearings.requestToTask': def('user', S.requestToTaskInput, (ctx, i) => hearings.requestToTask(ctx, i)),
  'judgments.list': def('user', byCase, (ctx, i) => judgments.listJudgments(ctx, i.caseId)),
  'judgments.create': def('user', S.judgmentCreateInput, (ctx, i) => judgments.createJudgment(ctx, i)),
  'judgments.update': def('user', S.judgmentUpdateInput, (ctx, i) => judgments.updateJudgment(ctx, i)),
  'deadlines.list': def('user', byCase, (ctx, i) => judgments.listDeadlines(ctx, i.caseId)),
  'deadlines.save': def('user', S.deadlineInput, (ctx, i) => judgments.saveDeadline(ctx, i)),

  // ———— المذكرات ————
  'memos.list': def('user', byCase, (ctx, i) => memos.listMemos(ctx, i.caseId)),
  'memos.get': def('user', byId, (ctx, i) => memos.getMemo(ctx, i)),
  'memos.create': def('user', S.memoCreateInput, (ctx, i) => memos.createMemo(ctx, i)),
  'memos.update': def('user', S.memoUpdateInput, (ctx, i) => memos.updateMemo(ctx, i)),
  'memos.setStatus': def('user', S.memoStatusInput, (ctx, i) => memos.setMemoStatus(ctx, i)),
  'memos.recordSubmission': def('user', S.memoSubmissionInput, (ctx, i) => memos.recordSubmission(ctx, i)),
  'memos.duplicate': def('user', byId, (ctx, i) => memos.duplicateMemo(ctx, i)),
  'memos.revision': def('user', byId, (ctx, i) => memos.getMemoRevision(ctx, i)),

  // ———— المستندات ————
  'documents.pickFile': def('user', empty, (ctx) => documents.pickFile(ctx)),
  'documents.stageBytes': def('user', S.stageBytesInput, (ctx, i) => documents.stageBytes(ctx, i)),
  'documents.discardStaged': def('user', z.object({ token: z.string().uuid() }), (ctx, i) => documents.discardStaged(ctx, i)),
  'documents.create': def('user', S.documentCreateInput, (ctx, i) => documents.createDocument(ctx, i)),
  'documents.addVersion': def('user', S.documentAddVersionInput, (ctx, i) => documents.addVersion(ctx, i)),
  'documents.update': def('user', S.documentUpdateInput, (ctx, i) => documents.updateDocument(ctx, i)),
  'documents.setArchived': def('user', z.object({ id: S.id, archived: z.boolean() }), (ctx, i) => documents.setDocumentArchived(ctx, i)),
  'documents.list': def('user', S.documentListInput, (ctx, i) => documents.listDocuments(ctx, i)),
  'documents.get': def('user', byId, (ctx, i) => documents.getDocument(ctx, i)),
  'documents.readBytes': def('user', z.object({ versionId: S.id }), (ctx, i) => documents.readVersionBytes(ctx, i)),
  'documents.docxPreview': def('user', z.object({ versionId: S.id }), (ctx, i) => documents.docxPreview(ctx, i)),
  'documents.open': def('user', z.object({ versionId: S.id }), (ctx, i) => documents.openVersion(ctx, i)),
  'documents.showInFolder': def('user', z.object({ versionId: S.id }), (ctx, i) => documents.showVersionInFolder(ctx, i)),
  'documents.export': def('user', z.object({ versionId: S.id }), (ctx, i) => documents.exportVersion(ctx, i)),
  'documents.text': def('user', z.object({ versionId: S.id }), (ctx, i) => documents.versionText(ctx, i)),

  // ———— التحليل ————
  'analysis.get': def('user', byCase, (ctx, i) => analysis.getAnalysis(ctx, i)),
  'analysis.saveSection': def('user', S.analysisSaveInput, (ctx, i) => analysis.saveAnalysisSection(ctx, i)),
  'analysis.history': def('user', byCase, (ctx, i) => analysis.analysisHistory(ctx, i)),
  'evidence.save': def('user', S.evidenceInput, (ctx, i) => analysis.saveEvidence(ctx, i)),
  'evidence.remove': def('user', byId, (ctx, i) => analysis.removeEvidence(ctx, i)),

  // ———— المهام والتقويم والتنبيهات ————
  'tasks.list': def('user', S.taskListInput, (ctx, i) => tasks.listTasks(ctx, i)),
  'tasks.create': def('user', S.taskInput, (ctx, i) => tasks.createTask(ctx, i)),
  'tasks.update': def('user', S.taskUpdateInput, (ctx, i) => tasks.updateTask(ctx, i)),
  'tasks.setStatus': def('user', S.taskStatusInput, (ctx, i) => tasks.setTaskStatus(ctx, i)),
  'calendar.events': def('user', S.calendarInput, (ctx, i) => calendar.calendarEvents(ctx, i)),
  'reminders.missed': def('user', empty, (ctx) => reminders.missedReminders(ctx), { passive: true }),
  'reminders.acknowledge': def('user', z.object({ ids: z.array(S.id).max(500) }), (ctx, i) => reminders.acknowledgeReminders(ctx, i)),

  // ———— المالية والعقود والوكالات ————
  'contracts.list': def('user', z.object({ clientId: S.optId, caseId: S.optId }).default({}), (ctx, i) => finance.listContracts(ctx, i)),
  'contracts.get': def('user', byId, (ctx, i) => finance.getContract(ctx, i)),
  'contracts.create': def('user', S.contractInput, (ctx, i) => finance.createContract(ctx, i)),
  'contracts.update': def('user', S.contractUpdateInput, (ctx, i) => finance.updateContract(ctx, i)),
  'feeItems.save': def('user', S.feeItemInput, (ctx, i) => finance.saveFeeItem(ctx, i)),
  'payments.list': def('user', z.object({ contractId: S.optId, clientId: S.optId }).default({}), (ctx, i) => finance.listPayments(ctx, i)),
  'payments.create': def('user', S.paymentInput, (ctx, i) => finance.createPayment(ctx, i)),
  'payments.void': def('user', S.paymentVoidInput, (ctx, i) => finance.voidPayment(ctx, i)),
  'expenses.list': def('user', z.object({ clientId: S.optId, caseId: S.optId }).default({}), (ctx, i) => finance.listExpenses(ctx, i)),
  'expenses.save': def('user', S.expenseInput, (ctx, i) => finance.saveExpense(ctx, i)),
  'finance.clientSummary': def('user', z.object({ clientId: S.id }), (ctx, i) => finance.clientFinanceSummary(ctx, i.clientId)),
  'finance.officeSummary': def('user', empty, (ctx) => finance.officeFinanceSummary(ctx)),
  'poas.list': def('user', z.object({ clientId: S.optId, caseId: S.optId }).default({}), (ctx, i) => finance.listPoas(ctx, i)),
  'poas.create': def('user', S.poaInput, (ctx, i) => finance.createPoa(ctx, i)),
  'poas.update': def('user', S.poaUpdateInput, (ctx, i) => finance.updatePoa(ctx, i)),

  // ———— الملاحظات وسجل التواصل ————
  'notes.list': def('user', z.object({ clientId: S.id, caseId: S.optId }), (ctx, i) => notes.listNotes(ctx, i)),
  'notes.save': def('user', S.noteInput, (ctx, i) => notes.saveNote(ctx, i)),
  'notes.remove': def('user', byId, (ctx, i) => notes.removeNote(ctx, i)),
  'comms.list': def('user', z.object({ clientId: S.id, caseId: S.optId }), (ctx, i) => notes.listComms(ctx, i)),
  'comms.save': def('user', S.commInput, (ctx, i) => notes.saveComm(ctx, i)),

  // ———— التقارير ————
  'reports.render': def('user', S.reportInput, (ctx, i) => reports.renderReport(ctx, i)),
  'reports.print': def('user', S.reportInput, (ctx, i) => reports.printReport(ctx, i)),
  'reports.savePdf': def('user', S.reportInput, (ctx, i) => reports.saveReportPdf(ctx, i)),

  // ———— النسخ الاحتياطي والاستعادة ————
  'backup.status': def('owner', empty, (ctx) => backup.backupStatus(ctx), { passive: true }),
  'backup.create': def('owner', empty, (ctx) => backup.createBackup(ctx, runtime.appVersion, 'backup')),
  'backup.export': def('owner', empty, (ctx) => backup.createBackup(ctx, runtime.appVersion, 'export')),
  'backup.inspectRestore': def('owner', empty, (ctx) => backup.inspectRestore(ctx)),
  'backup.cancelRestore': def('owner', z.object({ token: z.string().uuid() }), (ctx, i) => backup.cancelRestore(ctx, i)),
  'backup.applyRestore': def('owner', z.object({ token: z.string().uuid(), confirm: z.literal(true) }), async (ctx, i, core) => {
    const r = await backup.applyRestore(ctx, { token: i.token }, runtime.appVersion, { close: () => core.closeDb(), reopen: () => core.openDb() });
    core.db = ctx.db;
    reminders.rebuildAllReminders({ ...ctx, db: core.db });
    core.extraction.enqueuePending();
    // البيانات تغيرت كليًا: تنتهي كل الجلسات ويُطلب تسجيل الدخول من جديد
    core.sessions.clear();
    return r;
  }),

  // ———— التكامل الاختياري ————
  'integration.state': def('owner', empty, (ctx) => integration.integrationState(ctx)),
  'integration.setEnabled': def('owner', z.object({ enabled: z.boolean(), acknowledged: z.boolean().default(false) }), (ctx, i) => integration.setIntegrationEnabled(ctx, i)),
  'integration.createToken': def('owner', S.integrationTokenInput, (ctx, i) => integration.createIntegrationToken(ctx, i)),
  'integration.revokeToken': def('owner', byId, (ctx, i) => integration.revokeIntegrationToken(ctx, i)),
  'integration.accessLog': def('owner', empty, (ctx) => integration.integrationAccessLog(ctx)),
};

export type Registry = typeof REGISTRY;
export type MethodName = keyof Registry;
export type MethodInput<K extends MethodName> = z.input<Registry[K]['schema']>;
export type MethodOutput<K extends MethodName> = Awaited<ReturnType<Registry[K]['handler']>>;
