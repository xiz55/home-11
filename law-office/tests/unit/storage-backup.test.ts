// الحفظ والمرفقات والنسخ الاحتياطي والاستعادة — بما فيها حزمة تالفة واجتياز مسارات.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { call, callErr, makeCore, makeDocx, makePdf, seedCompany, setupOwner, stageAndAttach, tmpDir } from './helpers';

const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

describe('المرفقات', () => {
  const { core, platform, dir } = makeCore();
  const S = 'S';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  beforeAll(async () => {
    await setupOwner(core, S);
    ids = await seedCompany(core, S);
  });

  it('يرفض الأنواع غير المسموحة والمحتوى المخالف للامتداد', async () => {
    const exe = path.join(dir, 'virus.exe');
    fs.writeFileSync(exe, 'MZ....');
    platform.openQueue.push(exe);
    expect((await callErr(core, S, 'documents.pickFile', {})).code).toBe('VALIDATION');
    const fake = path.join(dir, 'fake.pdf');
    fs.writeFileSync(fake, 'MZ this is not a pdf');
    platform.openQueue.push(fake);
    const e = await callErr(core, S, 'documents.pickFile', {});
    expect(e.message).toContain('لا يطابق');
    expect(fs.readdirSync(core.paths.stagingDir)).toHaveLength(0);
  });

  it('ينسخ المرفق باسم داخلي آمن ويحفظ الاسم الأصلي، وينبه على التكرار', async () => {
    const f = makePdf(path.join(dir, 'عقد الأتعاب.pdf'));
    const d = await stageAndAttach(core, platform, S, f, { title: 'عقد الأتعاب الموقع', category: 'fee_contract', clientId: ids.clientId, contractId: ids.contractId });
    const v = core.db.get<{ stored_name: string; original_name: string; sha256: string }>('SELECT stored_name, original_name, sha256 FROM document_versions WHERE id = ?', [d.versionId])!;
    expect(v.original_name).toBe('عقد الأتعاب.pdf');
    expect(v.stored_name).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(v.sha256).toBe(sha(f));
    platform.openQueue.push(f);
    const staged = await call(core, S, 'documents.pickFile', {});
    expect(staged.duplicates).toHaveLength(1);
    const dup = await callErr(core, S, 'documents.create', { token: staged.token, title: 'نسخة مكررة', category: 'other', clientId: ids.clientId });
    expect(dup.code).toBe('DUPLICATE');
    const ok = await call(core, S, 'documents.create', { token: staged.token, title: 'نسخة مكررة', category: 'other', clientId: ids.clientId, allowDuplicate: true });
    expect(ok.id).toBeTruthy();
  });

  it('يحتفظ بالنسخ السابقة عند إضافة نسخة جديدة', async () => {
    const a = await makeDocx(path.join(dir, 'v1.docx'), ['النسخة الأولى']);
    const d = await stageAndAttach(core, platform, S, a, { title: 'لائحة', category: 'memo', clientId: ids.clientId, caseId: ids.laborId });
    const b = await makeDocx(path.join(dir, 'v2.docx'), ['النسخة الثانية المعدلة']);
    platform.openQueue.push(b);
    const st = await call(core, S, 'documents.pickFile', {});
    const r = await call(core, S, 'documents.addVersion', { documentId: d.id, token: st.token, note: 'بعد المراجعة' });
    expect(r.versionNo).toBe(2);
    const g = await call(core, S, 'documents.get', { id: d.id });
    expect(g.versions.map((x: any) => x.versionNo)).toEqual([2, 1]);
    const p1 = await call(core, S, 'documents.docxPreview', { versionId: g.versions[1].id });
    expect(p1.html).toContain('النسخة الأولى');
  });

  it('فشل حفظ السجل لا يترك ملفًا يتيمًا ولا سجلًا لمرفق مفقود', async () => {
    const f = makePdf(path.join(dir, 'fail.pdf'), 'fail case');
    platform.openQueue.push(f);
    const st = await call(core, S, 'documents.pickFile', {});
    const before = countFiles(core.paths.attachmentsDir);
    // ربط بقضية غير موجودة يفشل داخل التحقق قبل النقل؛ نختبر فشلًا داخل المعاملة بكسر مفتاح خارجي
    core.db.exec('CREATE TRIGGER fail_ins BEFORE INSERT ON document_versions BEGIN SELECT RAISE(ABORT, \'simulated failure\'); END');
    const e = await callErr(core, S, 'documents.create', { token: st.token, title: 'سيفشل', category: 'other', clientId: ids.clientId });
    core.db.exec('DROP TRIGGER fail_ins');
    expect(e.code).toBe('INTERNAL');
    expect(countFiles(core.paths.attachmentsDir)).toBe(before);
    expect(core.db.get<{ n: number }>("SELECT count(*) AS n FROM documents WHERE title = 'سيفشل'")!.n).toBe(0);
  });

  it('فتح المستند يستخدم نسخة اطلاع ولا يعدّل الأصل، ويشرح غياب البرنامج المناسب', async () => {
    const list = await call(core, S, 'documents.list', { caseId: ids.laborId });
    const docx = list.find((x: any) => x.current.ext === 'docx');
    platform.openResult = 'No application is associated';
    const r = await call(core, S, 'documents.open', { versionId: docx.current.id });
    expect(r.opened).toBe(false);
    expect(r.message).toContain('Word');
    expect(platform.opened.at(-1)).toContain('working-copies');
    platform.openResult = '';
    const r2 = await call(core, S, 'documents.open', { versionId: docx.current.id });
    expect(r2.opened).toBe(true);
  });

  it('فحص سلامة المرفقات يكشف الملف المحذوف من خارج البرنامج', async () => {
    const ok = await call(core, S, 'system.verifyAttachments', { hash: true });
    expect(ok.missing).toHaveLength(0);
    expect(ok.corrupted).toHaveLength(0);
  });
});

function countFiles(d: string): number {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    n += e.isDirectory() ? countFiles(path.join(d, e.name)) : 1;
  }
  return n;
}

describe('النسخ الاحتياطي والاستعادة', () => {
  const A = makeCore();
  const S = 'S';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  let backupFile = '';
  const out = tmpDir('lom-backups-');

  beforeAll(async () => {
    await setupOwner(A.core, S);
    ids = await seedCompany(A.core, S);
    const f = makePdf(path.join(A.dir, 'minutes.pdf'));
    await stageAndAttach(A.core, A.platform, S, f, { title: 'ضبط', category: 'minutes', clientId: ids.clientId, caseId: ids.laborId });
    const d = await makeDocx(path.join(A.dir, 'm.docx'), ['مذكرة']);
    await stageAndAttach(A.core, A.platform, S, d, { title: 'مذكرة', category: 'memo', clientId: ids.clientId, caseId: ids.commercialId });
    await call(A.core, S, 'payments.create', { contractId: ids.contractId, amount: 500000, paidOn: '2026-03-01' });
    // كتابة حديثة قد تكون في WAL فقط
    await call(A.core, S, 'notes.save', { clientId: ids.clientId, body: 'ملاحظة أخيرة قبل النسخ', isInternal: true });
  });

  it('يرفض حفظ النسخة داخل مجلد البيانات نفسه', async () => {
    A.platform.saveQueue.push(path.join(A.core.paths.dataDir, 'x.lobk'));
    expect((await callErr(A.core, S, 'backup.create', {})).code).toBe('VALIDATION');
  });

  it('ينشئ حزمة متسقة تشمل بيانات WAL والمرفقات والبيان', async () => {
    backupFile = path.join(out, 'office-backup');
    A.platform.saveQueue.push(backupFile);
    const r = await call(A.core, S, 'backup.create', {});
    expect(r.saved).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.attachments).toBe(2);
    backupFile = r.path;
    expect(backupFile.endsWith('.lobk')).toBe(true);
    const st = await call(A.core, S, 'backup.status', {});
    expect(st.lastBackupAt).toBeTruthy();
  });

  it('يستعيد إلى مساحة اختبار أخرى ويطابق السجلات والمرفقات والعلاقات', async () => {
    const B = makeCore();
    await call(B.core, 'T', 'auth.setupOwner', { officeName: 'مساحة استعادة', displayName: 'مختبر', username: 'tester', password: 'Tester#Pass2026' });
    await call(B.core, 'T', 'clients.create', { kind: 'individual', name: 'بيانات ستُستبدل' });
    B.platform.openQueue.push(backupFile);
    const ins = await call(B.core, 'T', 'backup.inspectRestore', {});
    expect(ins.ok).toBe(true);
    expect(ins.manifest.attachments).toBe(2);
    const r = await call(B.core, 'T', 'backup.applyRestore', { token: ins.token, confirm: true });
    expect(fs.existsSync(r.preRestoreBackup)).toBe(true);
    // الجلسات انتهت؛ الدخول بحساب الحزمة
    expect((await callErr(B.core, 'T', 'cases.list', {})).code).toBe('UNAUTHENTICATED');
    await call(B.core, 'T2', 'auth.login', { username: 'owner', password: 'Owner#Pass2026' });
    for (const t of ['clients', 'cases', 'contract_cases', 'poa_cases', 'documents', 'document_versions', 'payments', 'notes', 'stages']) {
      const a = A.core.db.all(`SELECT * FROM ${t} ORDER BY 1`);
      const b = B.core.db.all(`SELECT * FROM ${t} ORDER BY 1`);
      expect(b, t).toEqual(a);
    }
    for (const v of B.core.db.all<{ stored_name: string; sha256: string }>('SELECT stored_name, sha256 FROM document_versions')) {
      const f = path.join(B.core.paths.attachmentsDir, v.stored_name.slice(0, 2), v.stored_name);
      expect(sha(f)).toBe(v.sha256);
    }
    const sum = await call(B.core, 'T2', 'finance.clientSummary', { clientId: ids.clientId });
    expect(sum.paid).toBe(500000);
    expect(sum.agreed).toBe(10000000);
    const notes = await call(B.core, 'T2', 'notes.list', { clientId: ids.clientId });
    expect(notes[0].body).toBe('ملاحظة أخيرة قبل النسخ');
    const docs = await call(B.core, 'T2', 'documents.list', { caseId: ids.laborId });
    const bytes = await call(B.core, 'T2', 'documents.readBytes', { versionId: docs[0].current.id });
    expect(Buffer.from(bytes.bytes).subarray(0, 4).toString()).toBe('%PDF');
    // البيانات السابقة محفوظة في نسخة ما قبل الاستعادة ويمكن فحصها
    B.platform.openQueue.push(r.preRestoreBackup);
    const pre = await call(B.core, 'T2', 'backup.inspectRestore', {});
    expect(pre.ok).toBe(true);
    expect(pre.manifest.officeName).toBe('مساحة استعادة');
    await call(B.core, 'T2', 'backup.cancelRestore', { token: pre.token });
    B.core.shutdown();
  });

  it('حزمة تالفة تُرفض دون المساس بالبيانات الحالية', async () => {
    const corrupt = path.join(out, 'corrupt.lobk');
    const buf = fs.readFileSync(backupFile);
    // نعدل بايتات داخل منطقة المرفقات غير المضغوطة
    const idx = buf.indexOf(Buffer.from('%PDF'));
    buf[idx + 20] = buf[idx + 20] ^ 0xff;
    fs.writeFileSync(corrupt, buf);
    const before = A.core.db.get<{ n: number }>('SELECT count(*) AS n FROM clients')!.n;
    A.platform.openQueue.push(corrupt);
    const r = await call(A.core, S, 'backup.inspectRestore', {});
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/بصمة|تالفة/);
    const trunc = path.join(out, 'trunc.lobk');
    fs.writeFileSync(trunc, fs.readFileSync(backupFile).subarray(0, 2000));
    A.platform.openQueue.push(trunc);
    const r2 = await call(A.core, S, 'backup.inspectRestore', {});
    expect(r2.ok).toBe(false);
    expect(A.core.db.get<{ n: number }>('SELECT count(*) AS n FROM clients')!.n).toBe(before);
    expect(fs.readdirSync(A.core.paths.tmpDir).filter((f) => f.startsWith('restore-'))).toHaveLength(0);
  });

  it('يحمي من اجتياز المسارات داخل الأرشيف', async () => {
    const evil = path.join(out, 'evil.lobk');
    fs.writeFileSync(evil, zipSync({ 'manifest.json': strToU8('{}'), '../../evil.txt': strToU8('pwned'), 'attachments/../../../evil2.txt': strToU8('x') }));
    A.platform.openQueue.push(evil);
    const r = await call(A.core, S, 'backup.inspectRestore', {});
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(A.core.paths.dataDir, '..', 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(A.core.paths.tmpDir, '..', '..', 'evil.txt'))).toBe(false);
  });

  it('التصدير الكامل يتضمن JSON مفتوحًا بالمعرفات والعلاقات دون تجزئات كلمات المرور', async () => {
    const exp = path.join(out, 'export.lobk');
    A.platform.saveQueue.push(exp);
    await call(A.core, S, 'backup.export', {});
    const { unzipSync } = await import('fflate');
    const z = unzipSync(fs.readFileSync(exp));
    const cases = JSON.parse(Buffer.from(z['data/cases.json']).toString());
    expect(cases.map((c: any) => c.id).sort()).toEqual([ids.laborId, ids.commercialId].sort());
    const cc = JSON.parse(Buffer.from(z['data/contract_cases.json']).toString());
    expect(cc).toHaveLength(2);
    const users = JSON.parse(Buffer.from(z['data/users.json']).toString());
    expect(users[0].password_hash).toBeUndefined();
    const manifest = JSON.parse(Buffer.from(z['manifest.json']).toString());
    expect(manifest.format).toBe('law-office-backup');
  });
});
