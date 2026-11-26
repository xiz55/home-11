// المستندات: نسخ المرفق إلى مستودع البرنامج، الإصدارات، الروابط المتسقة، المعاينة، والفتح الآمن.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, forbidden, mapFsError, notFound } from '../errors';
import { ALLOWED_EXTENSIONS, MAX_ATTACHMENT_BYTES, DOC_CATEGORIES, type AllowedExt, type DocCategory, type DocStatus } from '../../shared/constants';
import { likeEscape, safeFileName, searchTokens } from '../../shared/text';
import { attachmentPath, resolveInside } from '../paths';
import { contentMatchesExt, extOf, isAllowedExt } from './filetypes';
import { canAccessCase, clientAccess, linkedScope, requireCase, requireCaseWritable, requireClient, requireLinked, requireUser } from './access';
import { logActivity } from './activity';
import { apptScope, requireConsultation, requireMeeting } from './appointments';

export interface StagedFile {
  token: string;
  sessionKey: string;
  file: string;
  originalName: string;
  ext: AllowedExt;
  size: number;
  sha256: string;
  createdAt: number;
}

const staged = new Map<string, StagedFile>();
const STAGE_TTL_MS = 6 * 3600_000;

let versionHook: ((versionId: string) => void) | null = null;
export function setVersionAddedHook(fn: ((versionId: string) => void) | null) {
  versionHook = fn;
}

export function cleanupStaging(stagingDir: string) {
  try {
    for (const f of fs.readdirSync(stagingDir)) {
      try {
        fs.rmSync(path.join(stagingDir, f), { force: true, recursive: true });
      } catch {
        /* تجاهل */
      }
    }
  } catch {
    /* المجلد غير موجود */
  }
  staged.clear();
}

function expireStaged() {
  const now = Date.now();
  for (const [k, v] of staged) {
    if (now - v.createdAt > STAGE_TTL_MS) {
      fs.rmSync(v.file, { force: true });
      staged.delete(k);
    }
  }
}

function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function validateNameAndSize(originalName: string, size: number): AllowedExt {
  const ext = extOf(originalName);
  if (!isAllowedExt(ext))
    throw new AppError('VALIDATION', `نوع الملف غير مدعوم (${ext || 'بدون امتداد'}). الأنواع المسموحة: PDF وWord (DOCX/DOC) والصور الشائعة.`);
  if (size <= 0) throw new AppError('VALIDATION', 'الملف فارغ.');
  if (size > MAX_ATTACHMENT_BYTES) throw new AppError('VALIDATION', `حجم الملف أكبر من الحد المسموح (${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} ميجابايت).`);
  return ext;
}

/** ينسخ ملفًا مختارًا من الجهاز إلى منطقة التجهيز ويحسب بصمته. لا ينشئ أي سجل بعد. */
export async function stageFromPath(ctx: Ctx, source: string, originalName = path.basename(source)): Promise<StagedFile> {
  requireUser(ctx);
  expireStaged();
  let st: fs.Stats;
  try {
    st = fs.statSync(source);
  } catch (e) {
    throw mapFsError(e);
  }
  if (!st.isFile()) throw new AppError('VALIDATION', 'المسار المختار ليس ملفًا.');
  const ext = validateNameAndSize(originalName, st.size);
  const free = freeBytes(ctx.paths.stagingDir);
  if (free !== null && free < st.size * 2 + 50 * 1024 * 1024) throw new AppError('STORAGE', 'مساحة القرص غير كافية لنسخ هذا الملف إلى مستودع البرنامج.');
  if (!contentMatchesExt(source, ext, st.size)) throw new AppError('VALIDATION', 'محتوى الملف لا يطابق امتداده، أو أن الملف تالف. لم يُرفق.');
  const token = uuid();
  const dest = resolveInside(ctx.paths.stagingDir, `${token}.${ext}`);
  const hash = createHash('sha256');
  try {
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(source);
      const ws = fs.createWriteStream(dest, { flags: 'wx' });
      rs.on('data', (chunk) => hash.update(chunk));
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      rs.pipe(ws);
    });
    const fd = fs.openSync(dest, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    if (fs.statSync(dest).size !== st.size) throw new AppError('STORAGE', 'اكتمل النسخ بحجم مختلف عن الأصل. لم يُرفق الملف.');
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw mapFsError(e);
  }
  const s: StagedFile = { token, sessionKey: ctx.sessionKey, file: dest, originalName: safeFileName(originalName, `مرفق.${ext}`), ext, size: st.size, sha256: hash.digest('hex'), createdAt: Date.now() };
  staged.set(token, s);
  return s;
}

export function stageFromBytes(ctx: Ctx, input: { name: string; bytes: Uint8Array }): StagedFile {
  requireUser(ctx);
  expireStaged();
  const ext = validateNameAndSize(input.name, input.bytes.byteLength);
  const token = uuid();
  const dest = resolveInside(ctx.paths.stagingDir, `${token}.${ext}`);
  try {
    const fd = fs.openSync(dest, 'wx');
    fs.writeSync(fd, input.bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw mapFsError(e);
  }
  if (!contentMatchesExt(dest, ext, input.bytes.byteLength)) {
    fs.rmSync(dest, { force: true });
    throw new AppError('VALIDATION', 'محتوى الملف لا يطابق امتداده، أو أن الملف تالف. لم يُرفق.');
  }
  const sha = createHash('sha256').update(input.bytes).digest('hex');
  const s: StagedFile = { token, sessionKey: ctx.sessionKey, file: dest, originalName: safeFileName(input.name, `مرفق.${ext}`), ext, size: input.bytes.byteLength, sha256: sha, createdAt: Date.now() };
  staged.set(token, s);
  return s;
}

export async function pickFile(ctx: Ctx) {
  requireUser(ctx);
  const exts = Object.keys(ALLOWED_EXTENSIONS);
  const chosen = await ctx.platform.showOpenFile({
    title: 'اختيار ملف لإرفاقه',
    filters: [
      { name: 'المستندات والصور المسموحة', extensions: exts },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Word', extensions: ['docx', 'doc'] },
    ],
  });
  if (!chosen) return null;
  const s = await stageFromPath(ctx, chosen);
  return describeStaged(ctx, s);
}

export function stageBytes(ctx: Ctx, input: { name: string; bytes: Uint8Array }) {
  return describeStaged(ctx, stageFromBytes(ctx, input));
}

function describeStaged(ctx: Ctx, s: StagedFile) {
  return { token: s.token, name: s.originalName, size: s.size, ext: s.ext, typeLabel: ALLOWED_EXTENSIONS[s.ext].label, duplicates: findDuplicates(ctx, s.sha256) };
}

/** نطاق المستندات المرئية: مستندات العميل/القضية بحسب الصلاحية، ومستندات الاستشارات والاجتماعات بحسب صلاحية الموعد. */
export function docScope(ctx: Ctx): { sql: string; params: Record<string, unknown> } {
  const l = linkedScope(ctx, 'd.client_id', 'd.case_id');
  if (l.sql === '1=1') return l;
  const k = apptScope(ctx, 'consultations', 'kk');
  const m = apptScope(ctx, 'meetings', 'mm');
  return {
    sql: `(${l.sql} OR (d.consultation_id IS NOT NULL AND d.consultation_id IN (SELECT kk.id FROM consultations kk WHERE ${k.sql}))
      OR (d.meeting_id IS NOT NULL AND d.meeting_id IN (SELECT mm.id FROM meetings mm WHERE ${m.sql})))`,
    params: { ...l.params, ...k.params, ...m.params },
  };
}

export function findDuplicates(ctx: Ctx, sha256: string) {
  const scope = docScope(ctx);
  return ctx.db
    .all<{ document_id: string; title: string; version_no: number; original_name: string; case_id: string | null; client_id: string | null }>(
      `SELECT v.document_id, d.title, v.version_no, v.original_name, d.case_id, d.client_id FROM document_versions v JOIN documents d ON d.id = v.document_id
       WHERE v.sha256 = :sha AND ${scope.sql} LIMIT 10`,
      { sha: sha256, ...scope.params },
    )
    .map((r) => ({ documentId: r.document_id, title: r.title, versionNo: r.version_no, originalName: r.original_name, caseId: r.case_id, clientId: r.client_id }));
}

function takeStaged(ctx: Ctx, token: string): StagedFile {
  const s = staged.get(token);
  if (!s || s.sessionKey !== ctx.sessionKey) throw new AppError('VALIDATION', 'انتهت صلاحية الملف المجهز أو لم يعد موجودًا. اختر الملف مرة أخرى.', { file: 'اختر الملف مرة أخرى' });
  if (!fs.existsSync(s.file)) {
    staged.delete(token);
    throw new AppError('STORAGE', 'الملف المجهز لم يعد موجودًا. اختر الملف مرة أخرى.');
  }
  return s;
}

export function discardStaged(ctx: Ctx, input: { token: string }) {
  const s = staged.get(input.token);
  if (s && s.sessionKey === ctx.sessionKey) {
    fs.rmSync(s.file, { force: true });
    staged.delete(input.token);
  }
  return { ok: true };
}

/** ينقل الملف المجهز إلى موقعه الدائم؛ يعيد الاسم الداخلي. على المستدعي حذف الملف إن فشل حفظ السجل. */
function commitStaged(ctx: Ctx, s: StagedFile): { storedName: string; finalPath: string } {
  const storedName = `${uuid()}.${s.ext}`;
  const finalPath = attachmentPath(ctx.paths, storedName);
  try {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.renameSync(s.file, finalPath);
  } catch (e) {
    try {
      fs.copyFileSync(s.file, finalPath, fs.constants.COPYFILE_EXCL);
      fs.rmSync(s.file, { force: true });
    } catch (e2) {
      fs.rmSync(finalPath, { force: true });
      throw mapFsError(e2 ?? e);
    }
  }
  staged.delete(s.token);
  return { storedName, finalPath };
}

interface Links {
  clientId: string | null;
  consultationId?: string | null;
  meetingId?: string | null;
  serviceTxnId?: string | null;
  caseId: string | null;
  stageId: string | null;
  hearingId: string | null;
  judgmentId: string | null;
  memoId: string | null;
  contractId: string | null;
  poaId: string | null;
  paymentId: string | null;
}

/** يمنع الروابط المتناقضة: كل عنصر مرتبط يجب أن يتبع العميل والقضية نفسيهما. */
export function normalizeLinks(ctx: Ctx, l: Links): Links {
  const out = { ...l, consultationId: l.consultationId ?? null, meetingId: l.meetingId ?? null, serviceTxnId: l.serviceTxnId ?? null };
  const bad = (field: string, msg: string) => new AppError('VALIDATION', msg, { [field]: msg });
  if (out.consultationId || out.meetingId) {
    // مستندات الاستشارة والاجتماع منفصلة عن ملفات القضايا: لا تُربط بقضية أو مرحلة أو جلسة
    if (out.consultationId && out.meetingId) throw bad('meetingId', 'المستند يتبع استشارة أو اجتماعًا وليس كليهما');
    if (out.caseId || out.stageId || out.hearingId || out.judgmentId || out.memoId || out.contractId || out.poaId || out.paymentId)
      throw bad('caseId', 'مستندات الاستشارات والاجتماعات لا تُربط بعناصر القضية');
    if (out.consultationId) {
      const k = ctx.db.get<{ client_id: string }>('SELECT client_id FROM consultations WHERE id = ?', [out.consultationId]);
      if (!k) throw bad('consultationId', 'الاستشارة غير موجودة');
      if (out.clientId && out.clientId !== k.client_id) throw bad('clientId', 'المستند لا يتبع صاحب الاستشارة');
      out.clientId = k.client_id;
    } else {
      const m = ctx.db.get<{ client_id: string | null }>('SELECT client_id FROM meetings WHERE id = ?', [out.meetingId]);
      if (!m) throw bad('meetingId', 'الاجتماع غير موجود');
      if (out.clientId && m.client_id && out.clientId !== m.client_id) throw bad('clientId', 'المستند لا يتبع الطرف المرتبط بالاجتماع');
      out.clientId = m.client_id;
    }
    if (out.serviceTxnId) {
      const t = ctx.db.get<{ consultation_id: string | null; meeting_id: string | null }>('SELECT consultation_id, meeting_id FROM service_txns WHERE id = ?', [out.serviceTxnId]);
      if (!t || t.consultation_id !== out.consultationId || t.meeting_id !== out.meetingId) throw bad('serviceTxnId', 'الحركة المالية لا تتبع هذا الموعد');
    }
    return out;
  }
  if (out.serviceTxnId) throw bad('serviceTxnId', 'سند الحركة يُرفق من صفحة الاستشارة أو الاجتماع');
  const client = l.clientId ? ctx.db.get('SELECT id FROM clients WHERE id = ?', [l.clientId]) : null;
  if (!client) throw bad('clientId', 'العميل غير موجود');
  const needCase = (field: string) => {
    if (!out.caseId) throw bad(field, 'اختر القضية أولًا لربط المستند بهذا العنصر');
  };
  if (out.caseId) {
    const c = ctx.db.get<{ client_id: string }>('SELECT client_id FROM cases WHERE id = ?', [out.caseId]);
    if (!c) throw bad('caseId', 'القضية غير موجودة');
    if (c.client_id !== out.clientId) throw bad('caseId', 'القضية لا تتبع العميل المختار');
  }
  if (out.hearingId) {
    needCase('hearingId');
    const h = ctx.db.get<{ case_id: string; stage_id: string }>('SELECT case_id, stage_id FROM hearings WHERE id = ?', [out.hearingId]);
    if (!h || h.case_id !== out.caseId) throw bad('hearingId', 'الجلسة لا تتبع القضية المختارة');
    if (out.stageId && out.stageId !== h.stage_id) throw bad('hearingId', 'الجلسة تتبع مرحلة مختلفة عن المرحلة المختارة');
    out.stageId = h.stage_id;
  }
  if (out.judgmentId) {
    needCase('judgmentId');
    const j = ctx.db.get<{ case_id: string; stage_id: string }>('SELECT case_id, stage_id FROM judgments WHERE id = ?', [out.judgmentId]);
    if (!j || j.case_id !== out.caseId) throw bad('judgmentId', 'الحكم لا يتبع القضية المختارة');
    if (out.stageId && out.stageId !== j.stage_id) throw bad('judgmentId', 'الحكم يتبع مرحلة مختلفة عن المرحلة المختارة');
    out.stageId = j.stage_id;
  }
  if (out.memoId) {
    needCase('memoId');
    const m = ctx.db.get<{ case_id: string; stage_id: string | null }>('SELECT case_id, stage_id FROM memos WHERE id = ?', [out.memoId]);
    if (!m || m.case_id !== out.caseId) throw bad('memoId', 'المذكرة لا تتبع القضية المختارة');
    if (!out.stageId && m.stage_id) out.stageId = m.stage_id;
  }
  if (out.stageId) {
    needCase('stageId');
    const s = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [out.stageId]);
    if (!s || s.case_id !== out.caseId) throw bad('stageId', 'المرحلة لا تتبع القضية المختارة');
  }
  if (out.contractId) {
    const k = ctx.db.get<{ client_id: string }>('SELECT client_id FROM contracts WHERE id = ?', [out.contractId]);
    if (!k || k.client_id !== out.clientId) throw bad('contractId', 'العقد لا يتبع العميل المختار');
  }
  if (out.poaId) {
    const p = ctx.db.get<{ client_id: string }>('SELECT client_id FROM poas WHERE id = ?', [out.poaId]);
    if (!p || p.client_id !== out.clientId) throw bad('poaId', 'الوكالة لا تتبع العميل المختار');
  }
  if (out.paymentId) {
    const p = ctx.db.get<{ client_id: string }>('SELECT client_id FROM payments WHERE id = ?', [out.paymentId]);
    if (!p || p.client_id !== out.clientId) throw bad('paymentId', 'الدفعة لا تتبع العميل المختار');
  }
  return out;
}

interface DocMeta {
  title: string;
  description: string | null;
  category: DocCategory;
  docDate: string | null;
  hijriText: string | null;
  hijriSource: string | null;
  status: DocStatus;
  isInternal: boolean;
}

function insertVersion(ctx: Ctx, documentId: string, versionNo: number, s: StagedFile, storedName: string, note: string | null) {
  const vid = uuid();
  ctx.db.run(
    `INSERT INTO document_versions (id, document_id, version_no, original_name, stored_name, ext, mime, size, sha256, note, extraction_status, added_by, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [vid, documentId, versionNo, s.originalName, storedName, s.ext, ALLOWED_EXTENSIONS[s.ext].mime, s.size, s.sha256, note,
      ['pdf', 'docx'].includes(s.ext) ? 'pending' : 'unsupported', ctx.user!.id, ctx.now().toISOString()],
  );
  return vid;
}

/** صلاحية الكتابة/القراءة على مستند بحسب ارتباطه. */
function checkLinkAccess(ctx: Ctx, d: { client_id?: string | null; case_id?: string | null; consultation_id?: string | null; meeting_id?: string | null }, write: boolean) {
  if (d.consultation_id) requireConsultation(ctx, d.consultation_id);
  else if (d.meeting_id) requireMeeting(ctx, d.meeting_id);
  else if (d.case_id) {
    if (write) requireCaseWritable(ctx, d.case_id);
    else if (!canAccessCase(ctx, d.case_id)) throw forbidden('لا تملك صلاحية الوصول إلى هذا المستند');
  } else if (!d.client_id || clientAccess(ctx, d.client_id) !== 'full') {
    if (write && d.client_id) requireClient(ctx, d.client_id, 'full');
    throw forbidden('لا تملك صلاحية الوصول إلى هذا المستند');
  }
}

export function createDocument(ctx: Ctx, input: DocMeta & Links & { token: string; allowDuplicate: boolean; versionNote: string | null }) {
  requireUser(ctx);
  checkLinkAccess(ctx, { client_id: input.clientId, case_id: input.caseId, consultation_id: input.consultationId, meeting_id: input.meetingId }, true);
  const links = normalizeLinks(ctx, input);
  const s = takeStaged(ctx, input.token);
  if (!input.allowDuplicate) {
    const dups = findDuplicates(ctx, s.sha256);
    if (dups.length)
      throw new AppError('DUPLICATE', `هذا الملف مرفق مسبقًا باسم «${dups[0].title}». هل تريد إرفاقه مرة أخرى؟`, undefined, { duplicates: dups });
  }
  const { storedName, finalPath } = commitStaged(ctx, s);
  const id = uuid();
  const now = ctx.now().toISOString();
  let versionId = '';
  try {
    ctx.db.tx(() => {
      ctx.db.run(
        `INSERT INTO documents (id, title, description, category, doc_date, hijri_text, hijri_source, client_id, case_id, stage_id, hearing_id, judgment_id, memo_id,
          contract_id, poa_id, payment_id, consultation_id, meeting_id, service_txn_id, status, is_internal, current_version, created_by, created_at, updated_by, updated_at)
         VALUES (:id, :title, :description, :category, :doc_date, :hijri_text, :hijri_source, :client_id, :case_id, :stage_id, :hearing_id, :judgment_id, :memo_id,
          :contract_id, :poa_id, :payment_id, :consultation_id, :meeting_id, :service_txn_id, :status, :is_internal, 1, :uid, :now, :uid, :now)`,
        {
          id,
          title: input.title,
          description: input.description,
          category: input.category,
          doc_date: input.docDate,
          hijri_text: input.hijriText,
          hijri_source: input.hijriSource,
          client_id: links.clientId,
          case_id: links.caseId,
          stage_id: links.stageId,
          hearing_id: links.hearingId,
          judgment_id: links.judgmentId,
          memo_id: links.memoId,
          contract_id: links.contractId,
          poa_id: links.poaId,
          payment_id: links.paymentId,
          consultation_id: links.consultationId,
          meeting_id: links.meetingId,
          service_txn_id: links.serviceTxnId,
          status: input.status,
          is_internal: input.isInternal,
          uid: ctx.user!.id,
          now,
        },
      );
      versionId = insertVersion(ctx, id, 1, s, storedName, input.versionNote);
      logActivity(ctx, {
        action: 'create',
        entityType: 'document',
        entityId: id,
        caseId: links.caseId,
        clientId: links.clientId,
        summary: `إرفاق مستند (${DOC_CATEGORIES[input.category].label}): ${input.title} — ${s.originalName}`,
      });
    });
  } catch (e) {
    // لا نترك ملفًا يتيمًا ولا سجلًا يدّعي وجود مرفق مفقود
    fs.rmSync(finalPath, { force: true });
    throw e;
  }
  versionHook?.(versionId);
  return { id, versionId };
}

export function addVersion(ctx: Ctx, input: { documentId: string; token: string; note: string | null; allowDuplicate: boolean }) {
  const d = ctx.db.get<{ id: string; client_id: string | null; case_id: string | null; consultation_id: string | null; meeting_id: string | null; title: string; current_version: number; archived_at: string | null }>('SELECT * FROM documents WHERE id = ?', [input.documentId]);
  if (!d) throw notFound('المستند');
  checkLinkAccess(ctx, d, true);
  if (d.archived_at) throw new AppError('CONFLICT', 'المستند مؤرشف. ألغِ أرشفته أولًا.');
  const s = takeStaged(ctx, input.token);
  const cur = ctx.db.get<{ sha256: string }>('SELECT sha256 FROM document_versions WHERE document_id = ? AND version_no = ?', [d.id, d.current_version]);
  if (cur?.sha256 === s.sha256 && !input.allowDuplicate)
    throw new AppError('DUPLICATE', 'الملف المختار مطابق تمامًا للنسخة الحالية. هل تريد إضافته كنسخة جديدة رغم ذلك؟', undefined, { duplicates: [] });
  const { storedName, finalPath } = commitStaged(ctx, s);
  const next = d.current_version + 1;
  let versionId = '';
  try {
    ctx.db.tx(() => {
      versionId = insertVersion(ctx, d.id, next, s, storedName, input.note);
      ctx.db.run('UPDATE documents SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ?', [next, ctx.user!.id, ctx.now().toISOString(), d.id]);
      logActivity(ctx, { action: 'version', entityType: 'document', entityId: d.id, caseId: d.case_id, clientId: d.client_id, summary: `إضافة النسخة ${next} من «${d.title}» (النسخ السابقة محفوظة)` });
    });
  } catch (e) {
    fs.rmSync(finalPath, { force: true });
    throw e;
  }
  versionHook?.(versionId);
  return { versionId, versionNo: next };
}

export function updateDocument(ctx: Ctx, input: DocMeta & Links & { id: string }) {
  const d = ctx.db.get<{ client_id: string | null; case_id: string | null; consultation_id: string | null; meeting_id: string | null; service_txn_id: string | null; title: string }>('SELECT * FROM documents WHERE id = ?', [input.id]);
  if (!d) throw notFound('المستند');
  checkLinkAccess(ctx, d, true);
  if (d.consultation_id || d.meeting_id) {
    // مستند الموعد يبقى مرتبطًا بموعده
    input = { ...input, clientId: d.client_id, caseId: null, consultationId: d.consultation_id, meetingId: d.meeting_id, serviceTxnId: input.serviceTxnId ?? d.service_txn_id };
  } else {
    if (input.clientId !== d.client_id) throw new AppError('VALIDATION', 'لا يمكن نقل المستند إلى عميل آخر', { clientId: 'العميل ثابت' });
    if (input.caseId && input.caseId !== d.case_id) requireCaseWritable(ctx, input.caseId);
    if (!input.caseId && d.case_id) requireClient(ctx, d.client_id!, 'full');
  }
  const links = normalizeLinks(ctx, input);
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE documents SET title = :title, description = :description, category = :category, doc_date = :doc_date, hijri_text = :hijri_text, hijri_source = :hijri_source,
        case_id = :case_id, stage_id = :stage_id, hearing_id = :hearing_id, judgment_id = :judgment_id, memo_id = :memo_id, contract_id = :contract_id,
        poa_id = :poa_id, payment_id = :payment_id, service_txn_id = :service_txn_id, status = :status, is_internal = :is_internal, updated_by = :uid, updated_at = :now WHERE id = :id`,
      {
        id: input.id,
        title: input.title,
        description: input.description,
        category: input.category,
        doc_date: input.docDate,
        hijri_text: input.hijriText,
        hijri_source: input.hijriSource,
        case_id: links.caseId,
        stage_id: links.stageId,
        hearing_id: links.hearingId,
        judgment_id: links.judgmentId,
        memo_id: links.memoId,
        contract_id: links.contractId,
        poa_id: links.poaId,
        payment_id: links.paymentId,
        service_txn_id: links.serviceTxnId,
        status: input.status,
        is_internal: input.isInternal,
        uid: ctx.user!.id,
        now: ctx.now().toISOString(),
      },
    );
    logActivity(ctx, { action: 'update', entityType: 'document', entityId: input.id, caseId: links.caseId, clientId: d.client_id, summary: `تعديل بيانات المستند: ${input.title}` });
  });
  return { ok: true };
}

export function setDocumentArchived(ctx: Ctx, input: { id: string; archived: boolean }) {
  const d = ctx.db.get<{ client_id: string | null; case_id: string | null; consultation_id: string | null; meeting_id: string | null; title: string }>('SELECT * FROM documents WHERE id = ?', [input.id]);
  if (!d) throw notFound('المستند');
  if (d.consultation_id || d.meeting_id) checkLinkAccess(ctx, d, true);
  else requireLinked(ctx, d.client_id!, d.case_id);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE documents SET archived_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.archived ? ctx.now().toISOString() : null, ctx.user!.id, ctx.now().toISOString(), input.id]);
    logActivity(ctx, { action: input.archived ? 'archive' : 'unarchive', entityType: 'document', entityId: input.id, caseId: d.case_id, clientId: d.client_id, summary: `${input.archived ? 'أرشفة' : 'إلغاء أرشفة'} المستند: ${d.title} (الملف محفوظ)` });
  });
  return { ok: true };
}

type DocRow = Record<string, string | number | null>;

function mapDoc(r: DocRow) {
  return {
    id: String(r.id),
    title: String(r.title),
    description: r.description as string | null,
    category: r.category as DocCategory,
    docDate: r.doc_date as string | null,
    hijriText: r.hijri_text as string | null,
    hijriSource: r.hijri_source as string | null,
    clientId: r.client_id as string | null,
    consultationId: r.consultation_id as string | null,
    consultationRef: (r.consultation_ref as string) ?? null,
    meetingId: r.meeting_id as string | null,
    meetingRef: (r.meeting_ref as string) ?? null,
    serviceTxnId: r.service_txn_id as string | null,
    clientName: (r.client_name as string) ?? null,
    caseId: r.case_id as string | null,
    caseFileNo: (r.case_file_no as string) ?? null,
    caseTitle: (r.case_title as string) ?? null,
    stageId: r.stage_id as string | null,
    hearingId: r.hearing_id as string | null,
    judgmentId: r.judgment_id as string | null,
    memoId: r.memo_id as string | null,
    contractId: r.contract_id as string | null,
    poaId: r.poa_id as string | null,
    paymentId: r.payment_id as string | null,
    status: r.status as DocStatus,
    isInternal: !!r.is_internal,
    currentVersion: Number(r.current_version),
    archivedAt: r.archived_at as string | null,
    createdAt: String(r.created_at),
    createdByName: (r.created_by_name as string) ?? null,
    updatedAt: String(r.updated_at),
    current: r.v_id
      ? {
          id: String(r.v_id),
          originalName: String(r.v_original_name),
          ext: String(r.v_ext) as AllowedExt,
          size: Number(r.v_size),
          addedAt: String(r.v_added_at),
          extractionStatus: String(r.v_extraction_status),
        }
      : null,
  };
}

const DOC_SELECT = `SELECT d.*, cl.name AS client_name, c.file_no AS case_file_no, c.title AS case_title, u.display_name AS created_by_name,
  kk.ref_no AS consultation_ref, mm.ref_no AS meeting_ref,
  v.id AS v_id, v.original_name AS v_original_name, v.ext AS v_ext, v.size AS v_size, v.added_at AS v_added_at, v.extraction_status AS v_extraction_status
  FROM documents d LEFT JOIN clients cl ON cl.id = d.client_id LEFT JOIN cases c ON c.id = d.case_id LEFT JOIN users u ON u.id = d.created_by
  LEFT JOIN consultations kk ON kk.id = d.consultation_id LEFT JOIN meetings mm ON mm.id = d.meeting_id
  LEFT JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version`;

export function listDocuments(
  ctx: Ctx,
  input: {
    q: string | null;
    clientId: string | null;
    caseId: string | null;
    stageId: string | null;
    hearingId: string | null;
    judgmentId: string | null;
    memoId: string | null;
    contractId: string | null;
    poaId: string | null;
    consultationId?: string | null;
    meetingId?: string | null;
    category?: DocCategory | null;
    archived: 'active' | 'archived' | 'all';
    clientLevelOnly: boolean;
  },
) {
  requireUser(ctx);
  const scope = docScope(ctx);
  const where = [scope.sql];
  const p: Record<string, unknown> = { ...scope.params };
  const eq = (col: string, key: string, v: string | null | undefined) => {
    if (v) {
      where.push(`${col} = :${key}`);
      p[key] = v;
    }
  };
  eq('d.client_id', 'clientId', input.clientId);
  eq('d.case_id', 'caseId', input.caseId);
  eq('d.stage_id', 'stageId', input.stageId);
  eq('d.hearing_id', 'hearingId', input.hearingId);
  eq('d.judgment_id', 'judgmentId', input.judgmentId);
  eq('d.memo_id', 'memoId', input.memoId);
  eq('d.contract_id', 'contractId', input.contractId);
  eq('d.poa_id', 'poaId', input.poaId);
  eq('d.category', 'category', input.category ?? null);
  eq('d.consultation_id', 'consultationId', input.consultationId ?? null);
  eq('d.meeting_id', 'meetingId', input.meetingId ?? null);
  if (input.clientLevelOnly) where.push('d.case_id IS NULL AND d.consultation_id IS NULL AND d.meeting_id IS NULL');
  if (input.archived === 'active') where.push('d.archived_at IS NULL');
  else if (input.archived === 'archived') where.push('d.archived_at IS NOT NULL');
  searchTokens(input.q ?? '').forEach((t, i) => {
    const k = `q${i}`;
    where.push(`(arnorm(d.title) LIKE :${k} ESCAPE '\\' OR arnorm(coalesce(d.description,'')) LIKE :${k} ESCAPE '\\' OR arnorm(coalesce(v.original_name,'')) LIKE :${k} ESCAPE '\\'
      OR coalesce(v.extracted_norm,'') LIKE :${k} ESCAPE '\\' OR arnorm(coalesce(cl.name,'')) LIKE :${k} ESCAPE '\\' OR coalesce(c.file_no,'') LIKE :${k} ESCAPE '\\')`);
    p[k] = `%${likeEscape(t)}%`;
  });
  return ctx.db.all<DocRow>(`${DOC_SELECT} WHERE ${where.join(' AND ')} ORDER BY coalesce(d.doc_date, substr(d.created_at,1,10)) DESC, d.created_at DESC LIMIT 3000`, p).map(mapDoc);
}

function requireDocAccess(ctx: Ctx, documentId: string) {
  const d = ctx.db.get<{ client_id: string | null; case_id: string | null; consultation_id: string | null; meeting_id: string | null }>('SELECT client_id, case_id, consultation_id, meeting_id FROM documents WHERE id = ?', [documentId]);
  if (!d) throw notFound('المستند');
  checkLinkAccess(ctx, d, false);
  return d;
}

export function getDocument(ctx: Ctx, input: { id: string }) {
  requireUser(ctx);
  requireDocAccess(ctx, input.id);
  const row = ctx.db.get<DocRow>(`${DOC_SELECT} WHERE d.id = ?`, [input.id])!;
  const versions = ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT v.id, v.version_no, v.original_name, v.ext, v.size, v.sha256, v.note, v.extraction_status, v.added_at, u.display_name AS added_by_name,
         length(coalesce(v.extracted_text,'')) AS text_length
       FROM document_versions v LEFT JOIN users u ON u.id = v.added_by WHERE v.document_id = ? ORDER BY v.version_no DESC`,
      [input.id],
    )
    .map((v) => ({
      id: String(v.id),
      versionNo: Number(v.version_no),
      originalName: String(v.original_name),
      ext: String(v.ext) as AllowedExt,
      size: Number(v.size),
      sha256: String(v.sha256),
      note: v.note as string | null,
      extractionStatus: String(v.extraction_status),
      textLength: Number(v.text_length),
      addedAt: String(v.added_at),
      addedByName: v.added_by_name as string | null,
    }));
  const links: { label: string; kind: string; id: string }[] = [];
  const d = mapDoc(row);
  if (d.stageId) {
    const s = ctx.db.get<{ stage_type: string }>('SELECT stage_type FROM stages WHERE id = ?', [d.stageId]);
    if (s) links.push({ kind: 'stage', id: d.stageId, label: `المرحلة: ${s.stage_type}` });
  }
  if (d.hearingId) links.push({ kind: 'hearing', id: d.hearingId, label: 'جلسة مرتبطة' });
  if (d.judgmentId) links.push({ kind: 'judgment', id: d.judgmentId, label: 'حكم مرتبط' });
  if (d.memoId) {
    const m = ctx.db.get<{ title: string }>('SELECT title FROM memos WHERE id = ?', [d.memoId]);
    if (m) links.push({ kind: 'memo', id: d.memoId, label: `المذكرة: ${m.title}` });
  }
  if (d.contractId) {
    const k = ctx.db.get<{ title: string }>('SELECT title FROM contracts WHERE id = ?', [d.contractId]);
    if (k) links.push({ kind: 'contract', id: d.contractId, label: `العقد: ${k.title}` });
  }
  if (d.poaId) links.push({ kind: 'poa', id: d.poaId, label: 'وكالة مرتبطة' });
  return { document: d, versions, links };
}

/** في وضع المزامنة: تنزيل ملف النسخة عند فتحه إن لم يكن على هذا الجهاز (بعد التحقق من الصلاحية محليًا). */
let blobEnsurer: ((versionId: string) => Promise<void>) | null = null;
export function setBlobEnsurer(fn: ((versionId: string) => Promise<void>) | null) {
  blobEnsurer = fn;
}
/** الآيفون: تحميل محتوى ملف المرفق من مخزن الجهاز إلى الذاكرة قبل قراءته (سطح المكتب لا يحتاجه). */
let fileLoader: ((file: string) => Promise<void>) | null = null;
export function setFileLoader(fn: ((file: string) => Promise<void>) | null) {
  fileLoader = fn;
}
async function ensureLocal(ctx: Ctx, versionId: string) {
  const v = ctx.db.get<{ document_id: string; stored_name: string }>('SELECT document_id, stored_name FROM document_versions WHERE id = ?', [versionId]);
  if (!v) throw notFound('نسخة المستند');
  requireDocAccess(ctx, v.document_id);
  if (!fs.existsSync(attachmentPath(ctx.paths, v.stored_name)) && blobEnsurer) {
    try {
      await blobEnsurer(versionId);
    } catch (e) {
      throw new AppError('STORAGE', `تعذر تنزيل الملف الآن: ${(e as Error).message}`);
    }
  }
  if (fileLoader) await fileLoader(attachmentPath(ctx.paths, v.stored_name));
}

function versionRow(ctx: Ctx, versionId: string) {
  const v = ctx.db.get<{ id: string; document_id: string; stored_name: string; original_name: string; ext: AllowedExt; mime: string; size: number; version_no: number; sha256: string }>(
    'SELECT id, document_id, stored_name, original_name, ext, mime, size, version_no, sha256 FROM document_versions WHERE id = ?',
    [versionId],
  );
  if (!v) throw notFound('نسخة المستند');
  requireDocAccess(ctx, v.document_id);
  const file = attachmentPath(ctx.paths, v.stored_name);
  if (!fs.existsSync(file))
    throw new AppError('INTEGRITY', 'ملف هذه النسخة غير موجود في مستودع البرنامج. قد يكون حُذف من خارج البرنامج؛ استعد آخر نسخة احتياطية أو أعد إرفاقه.');
  return { ...v, file };
}

export async function readVersionBytes(ctx: Ctx, input: { versionId: string }) {
  requireUser(ctx);
  await ensureLocal(ctx, input.versionId);
  const v = versionRow(ctx, input.versionId);
  const kind = ALLOWED_EXTENSIONS[v.ext].kind;
  if (kind !== 'pdf' && kind !== 'image') throw new AppError('VALIDATION', 'المعاينة المباشرة متاحة لملفات PDF والصور فقط.');
  return { bytes: new Uint8Array(fs.readFileSync(v.file)), mime: v.mime, name: v.original_name };
}

export async function docxPreview(ctx: Ctx, input: { versionId: string }) {
  requireUser(ctx);
  await ensureLocal(ctx, input.versionId);
  const v = versionRow(ctx, input.versionId);
  if (v.ext !== 'docx') throw new AppError('VALIDATION', 'المعاينة النصية متاحة لملفات DOCX فقط.');
  const mammoth = await import('mammoth');
  const buffer = fs.readFileSync(v.file);
  const r = await mammoth.convertToHtml({ buffer }, { includeDefaultStyleMap: true });
  return { html: r.value, warnings: r.messages.slice(0, 20).map((m) => m.message) };
}

function workingCopy(ctx: Ctx, v: { file: string; original_name: string; version_no: number; ext: string; id: string }) {
  const dir = resolveInside(ctx.paths.workingDir, v.id);
  fs.mkdirSync(dir, { recursive: true });
  const base = safeFileName(v.original_name.replace(/\.[^.]+$/, ''), 'مستند');
  const target = resolveInside(dir, `${base} - نسخة ${v.version_no}.${v.ext}`);
  try {
    if (fs.existsSync(target)) fs.chmodSync(target, 0o644);
    fs.copyFileSync(v.file, target);
    fs.chmodSync(target, 0o444); // للاطلاع فقط — الأصل المحفوظ لا يتأثر
  } catch (e) {
    throw mapFsError(e);
  }
  return target;
}

/** يفتح نسخة اطلاع من المستند بالبرنامج الافتراضي في نظام التشغيل (ويندوز أو ماك)؛ الأصل المؤرشف لا يُفتح للتعديل. */
export async function openVersion(ctx: Ctx, input: { versionId: string }) {
  requireUser(ctx);
  await ensureLocal(ctx, input.versionId);
  const v = versionRow(ctx, input.versionId);
  const target = workingCopy(ctx, v);
  const err = await ctx.platform.openPath(target);
  if (err) {
    const kind = ALLOWED_EXTENSIONS[v.ext].kind;
    const mac = process.platform === 'darwin';
    const hint =
      kind === 'docx' || kind === 'doc'
        ? mac
          ? 'لا يوجد برنامج مثبت على هذا الماك يفتح ملفات Word. ثبّت Microsoft Word أو Pages أو LibreOffice، أو أظهر الملف في Finder.'
          : 'لا يوجد برنامج مثبت لفتح ملفات Word على هذا الجهاز. ثبّت Microsoft Word أو بديلًا متوافقًا (مثل LibreOffice)، أو اعرض الملف في مجلده.'
        : mac
          ? 'لا يوجد برنامج على هذا الماك يفتح هذا النوع من الملفات. يمكنك إظهار الملف في Finder وفتحه يدويًا.'
          : 'لا يوجد برنامج افتراضي لفتح هذا النوع من الملفات على هذا الجهاز. يمكنك إظهار الملف في مجلده وفتحه يدويًا.';
    return { opened: false, message: hint, detail: err };
  }
  logActivity(ctx, { action: 'update', entityType: 'document_open', entityId: v.document_id, summary: `فتح نسخة اطلاع: ${v.original_name}` });
  return { opened: true, message: 'فُتحت نسخة للاطلاع. لحفظ تعديلاتك أضفها للبرنامج كنسخة جديدة من المستند.' };
}

export async function showVersionInFolder(ctx: Ctx, input: { versionId: string }) {
  requireUser(ctx);
  await ensureLocal(ctx, input.versionId);
  const v = versionRow(ctx, input.versionId);
  const target = workingCopy(ctx, v);
  ctx.platform.showItemInFolder(target);
  return { ok: true };
}

export async function exportVersion(ctx: Ctx, input: { versionId: string }) {
  requireUser(ctx);
  await ensureLocal(ctx, input.versionId);
  const v = versionRow(ctx, input.versionId);
  const dest = await ctx.platform.showSaveFile({ title: 'تصدير نسخة من المستند', defaultName: safeFileName(v.original_name), filters: [{ name: v.ext.toUpperCase(), extensions: [v.ext] }] });
  if (!dest) return { saved: false };
  try {
    fs.copyFileSync(v.file, dest);
  } catch (e) {
    throw mapFsError(e);
  }
  logActivity(ctx, { action: 'export', entityType: 'document', entityId: v.document_id, summary: `تصدير نسخة من المستند: ${v.original_name}` });
  return { saved: true, path: dest };
}

export function versionText(ctx: Ctx, input: { versionId: string }) {
  requireUser(ctx);
  const v = ctx.db.get<{ document_id: string; extracted_text: string | null; extraction_status: string }>('SELECT document_id, extracted_text, extraction_status FROM document_versions WHERE id = ?', [input.versionId]);
  if (!v) throw notFound('نسخة المستند');
  requireDocAccess(ctx, v.document_id);
  return { status: v.extraction_status, text: v.extracted_text };
}

/** فحص سلامة المرفقات: وجود الملف وتطابق البصمة. */
export function verifyAttachments(ctx: Ctx, opts: { hash?: boolean } = {}) {
  const rows = ctx.db.all<{ id: string; document_id: string; stored_name: string; sha256: string; size: number; original_name: string }>('SELECT id, document_id, stored_name, sha256, size, original_name FROM document_versions');
  const missing: { versionId: string; originalName: string }[] = [];
  const corrupted: { versionId: string; originalName: string }[] = [];
  for (const r of rows) {
    const f = attachmentPath(ctx.paths, r.stored_name);
    if (!fs.existsSync(f)) {
      missing.push({ versionId: r.id, originalName: r.original_name });
      continue;
    }
    if (fs.statSync(f).size !== r.size) {
      corrupted.push({ versionId: r.id, originalName: r.original_name });
      continue;
    }
    if (opts.hash) {
      const h = createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      if (h !== r.sha256) corrupted.push({ versionId: r.id, originalName: r.original_name });
    }
  }
  return { total: rows.length, missing, corrupted };
}

export function caseDocumentsAccessible(ctx: Ctx, caseId: string) {
  requireCase(ctx, caseId);
}
