// البحث العام: يطبّع النص العربي للمقارنة فقط، ويحترم صلاحيات المستخدم في كل نوع نتيجة.
import type { Ctx } from '../context';
import { likeEscape, searchTokens } from '../../shared/text';
import { caseScope, clientScope, linkedScope, requireUser } from './access';
import { apptScope } from './appointments';
import { docScope } from './documents';

export interface SearchHit {
  type: 'client' | 'case' | 'memo' | 'note' | 'communication' | 'document' | 'hearing' | 'consultation' | 'meeting';
  id: string;
  title: string;
  subtitle: string | null;
  snippet: string | null;
  caseId: string | null;
  clientId: string | null;
  consultationId?: string | null;
  meetingId?: string | null;
}

function cond(cols: string[], tokens: string[], prefix: string, p: Record<string, unknown>): string {
  return tokens
    .map((t, i) => {
      p[`${prefix}${i}`] = `%${likeEscape(t)}%`;
      return '(' + cols.map((c) => `${c} LIKE :${prefix}${i} ESCAPE '\\'`).join(' OR ') + ')';
    })
    .join(' AND ');
}

function snippetOf(text: string | null | undefined, tokens: string[]): string | null {
  if (!text) return null;
  const s = String(text).replace(/\s+/g, ' ');
  const norm = s.toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    idx = norm.indexOf(t);
    if (idx >= 0) break;
  }
  if (idx < 0) return s.slice(0, 140) + (s.length > 140 ? '…' : '');
  const start = Math.max(0, idx - 50);
  return (start > 0 ? '…' : '') + s.slice(start, start + 160) + (start + 160 < s.length ? '…' : '');
}

export function globalSearch(ctx: Ctx, input: { q: string }) {
  requireUser(ctx);
  const tokens = searchTokens(input.q);
  if (!tokens.length) return { query: input.q, hits: [] as SearchHit[], counts: {} as Record<string, number> };
  const hits: SearchHit[] = [];

  {
    const s = clientScope(ctx, 'cl.id');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(["arnorm(cl.name)", "arnorm(coalesce(cl.short_name,''))", "arnorm(coalesce(cl.phone,''))", "arnorm(coalesce(cl.id_number,''))", "arnorm(coalesce(cl.rep_name,''))", "arnorm(coalesce(cl.email,''))"], tokens, 'c', p);
    for (const r of ctx.db.all<{ id: string; name: string; kind: string; phone: string | null; status: string }>(
      `SELECT cl.id, cl.name, cl.kind, cl.phone, cl.status FROM clients cl WHERE ${s.sql} AND ${w} ORDER BY cl.status = 'archived', cl.name LIMIT 30`,
      p,
    ))
      hits.push({ type: 'client', id: r.id, title: r.name, subtitle: [r.kind === 'individual' ? 'فرد' : r.kind === 'company' ? 'شركة' : 'منشأة', r.phone, r.status === 'archived' ? 'مؤرشف' : null].filter(Boolean).join(' — '), snippet: null, caseId: null, clientId: r.id });
  }
  {
    const s = caseScope(ctx, 'c.id');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(
      [
        'arnorm(c.title)',
        'arnorm(c.file_no)',
        'arnorm(cl.name)',
        "arnorm(coalesce(c.subject,''))",
        "arnorm(coalesce(c.notes,''))",
        "arnorm(coalesce((SELECT group_concat(cp.name, ' ') FROM case_parties cp WHERE cp.case_id = c.id),''))",
        "arnorm(coalesce((SELECT group_concat(st.official_case_no, ' ') FROM stages st WHERE st.case_id = c.id),''))",
      ],
      tokens,
      'k',
      p,
    );
    for (const r of ctx.db.all<{ id: string; title: string; file_no: string; client_id: string; client_name: string; status: string; archived: number; subject: string | null; notes: string | null }>(
      `SELECT c.id, c.title, c.file_no, c.client_id, cl.name AS client_name, c.status, c.archived, c.subject, c.notes FROM cases c JOIN clients cl ON cl.id = c.client_id
       WHERE ${s.sql} AND ${w} ORDER BY c.archived, c.updated_at DESC LIMIT 40`,
      p,
    )) {
      const opp = ctx.db.all<{ name: string }>('SELECT name FROM case_parties WHERE case_id = ? AND is_opponent = 1', [r.id]).map((x) => x.name);
      const nos = ctx.db.all<{ n: string }>('SELECT official_case_no AS n FROM stages WHERE case_id = ? AND official_case_no IS NOT NULL', [r.id]).map((x) => x.n);
      hits.push({
        type: 'case',
        id: r.id,
        title: r.title,
        subtitle: [`ملف ${r.file_no}`, r.client_name, opp.length ? 'الخصم: ' + opp.join('، ') : null, nos.length ? 'رقم: ' + nos.join('، ') : null, r.status === 'closed' ? 'مقفلة' : null, r.archived ? 'مؤرشفة' : null]
          .filter(Boolean)
          .join(' — '),
        snippet: null,
        caseId: r.id,
        clientId: r.client_id,
      });
    }
  }
  {
    const s = caseScope(ctx, 'm.case_id');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(['arnorm(m.title)', "arnorm(coalesce(m.body,''))"], tokens, 'm', p);
    for (const r of ctx.db.all<{ id: string; title: string; body: string | null; case_id: string; file_no: string; client_id: string; status: string }>(
      `SELECT m.id, m.title, m.body, m.case_id, c.file_no, c.client_id, m.status FROM memos m JOIN cases c ON c.id = m.case_id WHERE ${s.sql} AND ${w} ORDER BY m.updated_at DESC LIMIT 30`,
      p,
    ))
      hits.push({ type: 'memo', id: r.id, title: r.title, subtitle: `مذكرة — ملف ${r.file_no}`, snippet: snippetOf(r.body, tokens), caseId: r.case_id, clientId: r.client_id });
  }
  {
    const s = linkedScope(ctx, 'n.client_id', 'n.case_id');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(['arnorm(n.body)'], tokens, 'n', p);
    for (const r of ctx.db.all<{ id: string; body: string; case_id: string | null; client_id: string; client_name: string }>(
      `SELECT n.id, n.body, n.case_id, n.client_id, cl.name AS client_name FROM notes n JOIN clients cl ON cl.id = n.client_id WHERE n.deleted_at IS NULL AND ${s.sql} AND ${w} ORDER BY n.created_at DESC LIMIT 30`,
      p,
    ))
      hits.push({ type: 'note', id: r.id, title: `ملاحظة — ${r.client_name}`, subtitle: null, snippet: snippetOf(r.body, tokens), caseId: r.case_id, clientId: r.client_id });
  }
  {
    const s = linkedScope(ctx, 'm.client_id', 'm.case_id');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(['arnorm(m.summary)', "arnorm(coalesce(m.contact_person,''))"], tokens, 'x', p);
    for (const r of ctx.db.all<{ id: string; summary: string; case_id: string | null; client_id: string; client_name: string; occurred_on: string }>(
      `SELECT m.id, m.summary, m.case_id, m.client_id, cl.name AS client_name, m.occurred_on FROM communications m JOIN clients cl ON cl.id = m.client_id WHERE m.deleted_at IS NULL AND ${s.sql} AND ${w} ORDER BY m.occurred_on DESC LIMIT 20`,
      p,
    ))
      hits.push({ type: 'communication', id: r.id, title: `سجل تواصل — ${r.client_name}`, subtitle: r.occurred_on, snippet: snippetOf(r.summary, tokens), caseId: r.case_id, clientId: r.client_id });
  }
  {
    const s = caseScope(ctx, 'h.case_id');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(["arnorm(coalesce(h.summary,''))", "arnorm(coalesce(h.outcome,''))", "arnorm(coalesce(h.office_commitments,''))"], tokens, 'h', p);
    for (const r of ctx.db.all<{ id: string; summary: string | null; outcome: string | null; case_id: string; file_no: string; client_id: string; starts_at: string }>(
      `SELECT h.id, h.summary, h.outcome, h.case_id, c.file_no, c.client_id, h.starts_at FROM hearings h JOIN cases c ON c.id = h.case_id WHERE ${s.sql} AND ${w} ORDER BY h.starts_at DESC LIMIT 20`,
      p,
    ))
      hits.push({ type: 'hearing', id: r.id, title: `ملخص جلسة — ملف ${r.file_no}`, subtitle: r.starts_at, snippet: snippetOf(r.summary ?? r.outcome, tokens), caseId: r.case_id, clientId: r.client_id });
  }
  {
    const s = apptScope(ctx, 'consultations', 'k');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(
      ['arnorm(k.title)', 'arnorm(k.ref_no)', 'arnorm(cl.name)', "arnorm(coalesce(cl.phone,''))", "arnorm(coalesce(k.category,''))", "arnorm(coalesce(k.description,''))", "arnorm(coalesce(k.questions,''))",
        "arnorm(coalesce((SELECT group_concat(o.title || ' ' || coalesce(o.body,''), ' ') FROM consultation_opinions o WHERE o.consultation_id = k.id),''))"],
      tokens,
      'co',
      p,
    );
    for (const r of ctx.db.all<{ id: string; ref_no: string; title: string; client_id: string; client_name: string; case_id: string | null; starts_at: string; description: string | null }>(
      `SELECT k.id, k.ref_no, k.title, k.client_id, cl.name AS client_name, k.case_id, k.starts_at, k.description FROM consultations k JOIN clients cl ON cl.id = k.client_id
       WHERE ${s.sql} AND ${w} ORDER BY k.starts_at DESC LIMIT 30`,
      p,
    ))
      hits.push({ type: 'consultation', id: r.id, title: r.title, subtitle: `استشارة ${r.ref_no} — ${r.client_name}`, snippet: snippetOf(r.description, tokens), caseId: r.case_id, clientId: r.client_id });
  }
  {
    const s = apptScope(ctx, 'meetings', 'm');
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(
      ['arnorm(m.title)', 'arnorm(m.ref_no)', "arnorm(coalesce(cl.name,''))", "arnorm(coalesce(m.purpose,''))", 'arnorm(m.participants)', "arnorm(coalesce(m.agenda,''))", "arnorm(coalesce(m.minutes,''))",
        "arnorm(coalesce((SELECT group_concat(i.text, ' ') FROM meeting_items i WHERE i.meeting_id = m.id),''))"],
      tokens,
      'mt',
      p,
    );
    for (const r of ctx.db.all<{ id: string; ref_no: string; title: string; client_id: string | null; client_name: string | null; case_id: string | null; minutes: string | null; purpose: string | null }>(
      `SELECT m.id, m.ref_no, m.title, m.client_id, cl.name AS client_name, m.case_id, m.minutes, m.purpose FROM meetings m LEFT JOIN clients cl ON cl.id = m.client_id
       WHERE ${s.sql} AND ${w} ORDER BY m.starts_at DESC LIMIT 30`,
      p,
    ))
      hits.push({ type: 'meeting', id: r.id, title: r.title, subtitle: `اجتماع ${r.ref_no}${r.client_name ? ' — ' + r.client_name : ''}`, snippet: snippetOf(r.minutes ?? r.purpose, tokens), caseId: r.case_id, clientId: r.client_id });
  }
  {
    const s = docScope(ctx);
    const p: Record<string, unknown> = { ...s.params };
    const w = cond(['arnorm(d.title)', "arnorm(coalesce(d.description,''))", "arnorm(coalesce(v.original_name,''))", "coalesce(v.extracted_norm,'')"], tokens, 'd', p);
    for (const r of ctx.db.all<{ id: string; title: string; description: string | null; case_id: string | null; client_id: string | null; client_name: string | null; file_no: string | null; original_name: string; extracted_text: string | null; ext: string; consultation_id: string | null; meeting_id: string | null }>(
      `SELECT d.id, d.title, d.description, d.case_id, d.client_id, d.consultation_id, d.meeting_id, cl.name AS client_name, c.file_no, v.original_name, v.extracted_text, v.ext FROM documents d
       LEFT JOIN clients cl ON cl.id = d.client_id LEFT JOIN cases c ON c.id = d.case_id JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
       WHERE ${s.sql} AND ${w} ORDER BY d.archived_at IS NOT NULL, d.updated_at DESC LIMIT 40`,
      p,
    ))
      hits.push({
        type: 'document',
        id: r.id,
        title: r.title,
        subtitle: [r.original_name, r.file_no ? `ملف ${r.file_no}` : r.client_name].filter(Boolean).join(' — '),
        snippet: snippetOf(r.description, tokens) ?? (r.extracted_text ? 'وُجدت المطابقة في النص المستخرج من الملف' : null),
        caseId: r.case_id,
        clientId: r.client_id,
        consultationId: r.consultation_id,
        meetingId: r.meeting_id,
      });
  }
  const counts: Record<string, number> = {};
  for (const h of hits) counts[h.type] = (counts[h.type] ?? 0) + 1;
  return { query: input.q, hits, counts };
}
