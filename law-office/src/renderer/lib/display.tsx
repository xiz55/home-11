import { Badge, Ltr } from '../components/ui';
import { fmtDate, fmtDateTime, fmtDateLong, utcIsoToRiyadh, fmtTime12 } from '../../shared/dates';

export function When({ at, dateOnly }: { at: string | null | undefined; dateOnly?: boolean }) {
  if (!at) return <span className="muted">—</span>;
  return <bdi dir="rtl" className="when">{dateOnly ? fmtDate(at) : fmtDateTime(at)}</bdi>;
}

export function TimeOf({ iso }: { iso: string }) {
  return <bdi dir="rtl">{fmtTime12(utcIsoToRiyadh(iso).time)}</bdi>;
}

export function DateLong({ date }: { date: string }) {
  return <span>{fmtDateLong(date)}</span>;
}

export const EVENT_KIND: Record<string, { label: string; tone: 'info' | 'neutral' | 'warning' }> = {
  hearing: { label: 'جلسة', tone: 'info' },
  task: { label: 'مهمة', tone: 'neutral' },
  deadline: { label: 'موعد إجرائي', tone: 'warning' },
  manual: { label: 'إجراء تالٍ', tone: 'neutral' },
  consultation: { label: 'استشارة', tone: 'neutral' },
  meeting: { label: 'اجتماع', tone: 'neutral' },
};

/** مسار فتح موعد من التقويم أو اللوحة. */
export function eventPath(e: { kind: string; id: string; caseId: string | null }): string | null {
  if (e.kind === 'consultation') return `/appointments/consultations/${e.id}`;
  if (e.kind === 'meeting') return `/appointments/meetings/${e.id}`;
  if (!e.caseId) return null;
  return e.kind === 'hearing' ? `/cases/${e.caseId}?tab=stages&hearing=${e.id}` : `/cases/${e.caseId}`;
}

export function NextEventCell({ ev }: { ev: { label: string; at: string; isDateOnly: boolean; confirmed: boolean; overdue: boolean; kind: string; responsible?: string | null } | null }) {
  if (!ev) return <span className="muted">لا يوجد موعد مسجل</span>;
  return (
    <div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span>{ev.label}</span>
        {!ev.confirmed && <Badge tone="warning">غير مؤكد</Badge>}
        {ev.overdue && <Badge tone="danger">متأخر</Badge>}
      </div>
      <div className="sub help">
        <When at={ev.at} dateOnly={ev.isDateOnly} />
        {ev.responsible ? ` — ${ev.responsible}` : ''}
      </div>
    </div>
  );
}

export function LastActionCell({ a }: { a: { label: string; at: string; isDateOnly: boolean } | null }) {
  if (!a) return <span className="muted">لم يُسجل إجراء</span>;
  return (
    <div>
      <div>{a.label}</div>
      <div className="sub help">
        <When at={a.at} dateOnly={a.isDateOnly} />
      </div>
    </div>
  );
}
