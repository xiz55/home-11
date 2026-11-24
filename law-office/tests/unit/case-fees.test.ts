// جدول أتعاب القضية: مبلغ القضية، المقدم، المسدد، المتبقي — ومثال المستخدم حرفيًا.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { Db } from '../../src/main/db/db';
import { MIGRATIONS, migrate, currentSchemaVersion } from '../../src/main/db/migrations';
import { call, makeCore, setupOwner, tmpDir } from './helpers';

describe('أتعاب القضية والدفعة المقدمة', () => {
  it('مبلغ 10,000 ومقدم 3,000 ثم دفعة 2,000: المسدد 5,000 والمتبقي 5,000', async () => {
    const { core } = makeCore();
    const S = (await setupOwner(core)).session;
    const client = await call(core, S, 'clients.create', { kind: 'individual', name: 'عميل خيالي للأتعاب' });
    const c = await call(core, S, 'cases.create', { clientId: client.id, title: 'قضية خيالية' });
    const k = await call(core, S, 'contracts.create', { clientId: client.id, kind: 'fee', title: 'أتعاب القضية', scope: 'هذه القضية فقط', feeType: 'fixed', fixedAmount: 1000000, caseIds: [c.id] });
    await call(core, S, 'payments.create', { contractId: k.id, amount: 300000, paidOn: '2026-11-01', isAdvance: true });
    await call(core, S, 'payments.create', { contractId: k.id, amount: 200000, paidOn: '2026-11-10' });
    const [row] = await call(core, S, 'contracts.list', { caseId: c.id });
    expect(row.sharedAcrossCases).toBe(false);
    expect(row.totals).toMatchObject({ agreed: 1000000, advance: 300000, paid: 500000, remaining: 500000 });
    const sum = await call(core, S, 'finance.clientSummary', { clientId: client.id });
    expect(sum).toMatchObject({ agreed: 1000000, advance: 300000, paid: 500000, remaining: 500000 });
    const pays = await call(core, S, 'payments.list', { contractId: k.id });
    expect(pays.filter((p: any) => p.isAdvance)).toHaveLength(1);
    // إلغاء الدفعة المقدمة يعيد الحساب
    await call(core, S, 'payments.void', { id: pays.find((p: any) => p.isAdvance).id, reason: 'خطأ إدخال' });
    const [after] = await call(core, S, 'contracts.list', { caseId: c.id });
    expect(after.totals).toMatchObject({ advance: 0, paid: 200000, remaining: 800000 });
    const report = await call(core, S, 'reports.render', { type: 'fees', clientId: client.id });
    expect(report.html).toContain('المقدم');
    core.shutdown();
  });

  it('ترحيل قاعدة من الإصدار الأول يضيف خانة الدفعة المقدمة دون فقد البيانات', () => {
    const f = path.join(tmpDir(), 'v1.sqlite');
    const db = new Db(f);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    db.exec(MIGRATIONS[0].sql);
    db.run("INSERT INTO schema_migrations VALUES (1, 'initial schema', '2026-01-01')");
    expect(currentSchemaVersion(db)).toBe(1);
    migrate(db);
    expect(currentSchemaVersion(db)).toBe(2);
    const cols = db.all<{ name: string }>('PRAGMA table_info(payments)').map((x) => x.name);
    expect(cols).toContain('is_advance');
    db.close();
  });
});
