// التحليل القانوني اليدوي: حقول منظمة يكتبها المستخدم — لا توليد آلي لأي رأي أو نص نظامي.
import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, notFound } from '../errors';
import { ANALYSIS_SECTIONS, type AnalysisSectionKey } from '../../shared/schemas';
import type { EvidenceKind, EvidenceReliability } from '../../shared/constants';
import { requireCase, requireCaseWritable } from './access';
import { logActivity } from './activity';

interface SectionValue {
  text: string;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

export function getAnalysis(ctx: Ctx, input: { caseId: string }) {
  requireCase(ctx, input.caseId);
  const row = ctx.db.get<{ sections: string; revision: number; created_at: string; updated_at: string; created_by_name: string | null; updated_by_name: string | null }>(
    `SELECT a.sections, a.revision, a.created_at, a.updated_at, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
     FROM case_analysis a LEFT JOIN users cu ON cu.id = a.created_by LEFT JOIN users uu ON uu.id = a.updated_by WHERE a.case_id = ?`,
    [input.caseId],
  );
  let sections: Record<string, SectionValue> = {};
  try {
    sections = row ? JSON.parse(row.sections) : {};
  } catch {
    sections = {};
  }
  const out = ANALYSIS_SECTIONS.map((s) => ({
    key: s.key,
    label: s.label,
    text: sections[s.key]?.text ?? '',
    updatedByName: sections[s.key]?.updatedByName ?? null,
    updatedAt: sections[s.key]?.updatedAt ?? null,
  }));
  return {
    sections: out,
    revision: row?.revision ?? 0,
    createdAt: row?.created_at ?? null,
    createdByName: row?.created_by_name ?? null,
    updatedAt: row?.updated_at ?? null,
    updatedByName: row?.updated_by_name ?? null,
    evidence: listEvidence(ctx, input.caseId),
  };
}

export function saveAnalysisSection(ctx: Ctx, input: { caseId: string; key: AnalysisSectionKey; text: string; baseRevision: number }) {
  const c = requireCaseWritable(ctx, input.caseId);
  const now = ctx.now().toISOString();
  let revision = 0;
  ctx.db.tx(() => {
    const row = ctx.db.get<{ sections: string; revision: number }>('SELECT sections, revision FROM case_analysis WHERE case_id = ?', [input.caseId]);
    if (row && row.revision !== input.baseRevision) {
      throw new AppError('CONFLICT', 'تم تعديل التحليل بعد فتحه (ربما في نافذة أخرى). انسخ نصك، ثم أعد تحميل الصفحة.', undefined, { revision: row.revision });
    }
    const sections: Record<string, SectionValue> = row ? JSON.parse(row.sections) : {};
    const oldText = sections[input.key]?.text ?? '';
    if (oldText === input.text) {
      revision = row?.revision ?? 0;
      return;
    }
    sections[input.key] = { text: input.text, updatedBy: ctx.user!.id, updatedByName: ctx.user!.displayName, updatedAt: now };
    revision = (row?.revision ?? 0) + 1;
    if (row) {
      ctx.db.run('UPDATE case_analysis SET sections = ?, revision = ?, updated_by = ?, updated_at = ? WHERE case_id = ?', [JSON.stringify(sections), revision, ctx.user!.id, now, input.caseId]);
    } else {
      ctx.db.run('INSERT INTO case_analysis (case_id, sections, revision, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        input.caseId,
        JSON.stringify(sections),
        revision,
        ctx.user!.id,
        now,
        ctx.user!.id,
        now,
      ]);
    }
    ctx.db.run('INSERT INTO analysis_revisions (id, case_id, section_key, old_text, new_text, revision, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      uuid(),
      input.caseId,
      input.key,
      oldText,
      input.text,
      revision,
      ctx.user!.id,
      now,
    ]);
    const label = ANALYSIS_SECTIONS.find((s) => s.key === input.key)!.label;
    // نسجل نشاطًا واحدًا لكل قسم خلال 10 دقائق لتجنب إغراق السجل بالحفظ التلقائي
    const recent = ctx.db.get(
      "SELECT id FROM activity_log WHERE entity_type = 'analysis' AND entity_id = ? AND user_id = ? AND summary = ? AND at > ? LIMIT 1",
      [input.caseId, ctx.user!.id, `تعديل التحليل: ${label}`, new Date(ctx.now().getTime() - 600_000).toISOString()],
    );
    if (!recent) logActivity(ctx, { action: 'update', entityType: 'analysis', entityId: input.caseId, caseId: input.caseId, clientId: c.client_id, summary: `تعديل التحليل: ${label}` });
  });
  return { revision, savedAt: now };
}

export function analysisHistory(ctx: Ctx, input: { caseId: string }) {
  requireCase(ctx, input.caseId);
  return ctx.db
    .all<{ id: string; section_key: string; revision: number; saved_at: string; by_name: string | null; old_len: number; new_len: number }>(
      `SELECT r.id, r.section_key, r.revision, r.saved_at, u.display_name AS by_name, length(coalesce(r.old_text,'')) AS old_len, length(coalesce(r.new_text,'')) AS new_len
       FROM analysis_revisions r LEFT JOIN users u ON u.id = r.saved_by WHERE r.case_id = ? ORDER BY r.saved_at DESC LIMIT 300`,
      [input.caseId],
    )
    .map((r) => ({
      id: r.id,
      sectionKey: r.section_key,
      sectionLabel: ANALYSIS_SECTIONS.find((s) => s.key === r.section_key)?.label ?? r.section_key,
      revision: r.revision,
      savedAt: r.saved_at,
      byName: r.by_name,
      oldLength: r.old_len,
      newLength: r.new_len,
    }));
}

export function listEvidence(ctx: Ctx, caseId: string) {
  requireCase(ctx, caseId);
  return ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT e.*, d.title AS document_title, d.current_version, u.display_name AS by_name,
        (SELECT v.id FROM document_versions v WHERE v.document_id = d.id AND v.version_no = d.current_version) AS version_id
       FROM evidence_items e LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN users u ON u.id = e.updated_by
       WHERE e.case_id = ? ORDER BY e.kind, e.fact_date IS NULL, e.fact_date, e.sort_order, e.created_at`,
      [caseId],
    )
    .map((e) => ({
      id: String(e.id),
      kind: e.kind as EvidenceKind,
      statement: String(e.statement),
      factDate: e.fact_date as string | null,
      reliability: e.reliability as EvidenceReliability,
      documentId: e.document_id as string | null,
      documentTitle: e.document_title as string | null,
      documentVersionId: e.version_id as string | null,
      locationRef: e.location_ref as string | null,
      notes: e.notes as string | null,
      byName: e.by_name as string | null,
      updatedAt: String(e.updated_at),
    }));
}

export function saveEvidence(
  ctx: Ctx,
  input: { id: string | null; caseId: string; kind: EvidenceKind; statement: string; factDate: string | null; reliability: EvidenceReliability; documentId: string | null; locationRef: string | null; notes: string | null },
) {
  const c = requireCaseWritable(ctx, input.caseId);
  if (input.documentId) {
    const d = ctx.db.get<{ case_id: string | null; client_id: string }>('SELECT case_id, client_id FROM documents WHERE id = ?', [input.documentId]);
    if (!d || (d.case_id !== input.caseId && !(d.case_id === null && d.client_id === c.client_id)))
      throw new AppError('VALIDATION', 'المستند المختار لا يتبع هذه القضية أو عميلها', { documentId: 'اختر مستندًا من مستندات القضية' });
  }
  if (input.reliability === 'confirmed' && !input.documentId)
    throw new AppError('VALIDATION', 'صفة «مؤكدة بمستند» تتطلب ربط المستند المؤيد', { documentId: 'اختر المستند المؤيد أو غيّر درجة الثبوت' });
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ case_id: string }>('SELECT case_id FROM evidence_items WHERE id = ?', [id]);
      if (!ex || ex.case_id !== input.caseId) throw notFound('البند');
      ctx.db.run(
        'UPDATE evidence_items SET kind = ?, statement = ?, fact_date = ?, reliability = ?, document_id = ?, location_ref = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [input.kind, input.statement, input.factDate, input.reliability, input.documentId, input.locationRef, input.notes, ctx.user!.id, now, id],
      );
    } else {
      id = uuid();
      const max = ctx.db.get<{ m: number | null }>('SELECT max(sort_order) AS m FROM evidence_items WHERE case_id = ?', [input.caseId]);
      ctx.db.run(
        `INSERT INTO evidence_items (id, case_id, kind, statement, fact_date, reliability, document_id, location_ref, notes, sort_order, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.caseId, input.kind, input.statement, input.factDate, input.reliability, input.documentId, input.locationRef, input.notes, (max?.m ?? 0) + 10, ctx.user!.id, now, ctx.user!.id, now],
      );
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'evidence', entityId: id, caseId: input.caseId, clientId: c.client_id, summary: `${input.id ? 'تعديل' : 'إضافة'} بند في جدول الأدلة: ${input.statement.slice(0, 100)}` });
  });
  return { id };
}

export function removeEvidence(ctx: Ctx, input: { id: string }) {
  const e = ctx.db.get<{ case_id: string; statement: string }>('SELECT case_id, statement FROM evidence_items WHERE id = ?', [input.id]);
  if (!e) throw notFound('البند');
  const c = requireCaseWritable(ctx, e.case_id);
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM evidence_items WHERE id = ?', [input.id]);
    logActivity(ctx, { action: 'delete', entityType: 'evidence', entityId: input.id, caseId: e.case_id, clientId: c.client_id, summary: `حذف بند من جدول الأدلة: ${e.statement.slice(0, 100)}` });
  });
  return { ok: true };
}
