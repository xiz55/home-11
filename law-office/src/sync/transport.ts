// طبقة نقل عامة فوق دوال الخادم (RPC). التطبيقات تستخدم Supabase، والاختبارات اتصال PostgreSQL مباشرًا بالأدوار والسياسات نفسها.
import type { MemberStatus, PulledRecord, PushChange, PushResult, SyncTransport } from './engine';

export abstract class RpcTransport implements SyncTransport {
  abstract rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;

  push(officeId: string, changes: PushChange[]) {
    return this.rpc<PushResult[]>('sync_push', { p_office: officeId, p_changes: changes });
  }
  async pull(officeId: string, since: number, limit: number) {
    const rows = await this.rpc<PulledRecord[]>('sync_pull', { p_office: officeId, p_since: since, p_limit: limit });
    return rows.map((r) => ({ ...r, version: Number(r.version), seq: Number(r.seq) }));
  }
  async status(officeId: string) {
    const s = await this.rpc<MemberStatus | null>('sync_status', { p_office: officeId });
    if (!s || !s.member) return null;
    return { ...s, max_seq: Number(s.max_seq), member: { ...s.member, access_version: Number(s.member.access_version) } };
  }
  async reserveNumbers(officeId: string, name: string, count: number) {
    const r = await this.rpc<{ from: number; to: number }>('app_reserve_numbers', { p_office: officeId, p_name: name, p_count: count });
    return { from: Number(r.from), to: Number(r.to) };
  }
}

/** خطأ اتصال (لا شبكة/مهلة) — يبقي العمليات في الطابور دون فقد. */
export class OfflineError extends Error {
  constructor(msg = 'offline') {
    super(msg);
  }
}
