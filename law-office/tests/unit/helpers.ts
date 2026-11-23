import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { AppCore } from '../../src/main/core';
import type { Platform } from '../../src/main/context';
import { extractText } from '../../src/main/extract/core';
import { loadReportFonts } from '../../src/main/services/reports';

export class FakePlatform implements Platform {
  openQueue: (string | null)[] = [];
  saveQueue: (string | null)[] = [];
  opened: string[] = [];
  shown: string[] = [];
  openResult = '';
  printed: string[] = [];
  async showOpenFile() {
    return this.openQueue.shift() ?? null;
  }
  async showSaveFile() {
    return this.saveQueue.shift() ?? null;
  }
  async openPath(p: string) {
    this.opened.push(p);
    return this.openResult;
  }
  showItemInFolder(p: string) {
    this.shown.push(p);
  }
  async printHtml(html: string) {
    this.printed.push(html);
  }
  async htmlToPdf(html: string) {
    return Buffer.from('%PDF-1.4 fake ' + html.length);
  }
}

export function tmpDir(prefix = 'lom-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export class Clock {
  t: number;
  constructor(iso = '2026-11-23T07:00:00.000Z') {
    this.t = new Date(iso).getTime();
  }
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export function makeCore(dir = tmpDir(), clock = new Clock()) {
  const platform = new FakePlatform();
  loadReportFonts(path.resolve('node_modules/@fontsource/ibm-plex-sans-arabic/files'));
  const core = new AppCore(path.join(dir, 'data'), platform, clock.now, { inlineExtractor: extractText });
  return { core, platform, clock, dir };
}

export async function call<T = any>(core: AppCore, session: string, channel: string, payload?: unknown): Promise<T> {
  const r = await core.dispatch(session, channel, payload);
  if (!r.ok) throw new Error(`${channel} failed: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.fields ?? {})}`);
  return r.data as T;
}

export async function callErr(core: AppCore, session: string, channel: string, payload?: unknown) {
  const r = await core.dispatch(session, channel, payload);
  if (r.ok) throw new Error(`${channel} unexpectedly succeeded`);
  return r.error;
}

/** ملف PDF نصي صغير صالح (نص لاتيني) لاختبار المعاينة والاستخراج. */
export function makePdf(file: string, text = 'Hearing minutes sample text'): string {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, out, 'latin1');
  return file;
}

/** ملف DOCX صغير صالح بنص عربي. */
export async function makeDocx(file: string, paragraphs: string[]): Promise<string> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    '[Content_Types].xml',
  );
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    '_rels/.rels',
  );
  const body = paragraphs.map((p) => `<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  zip.addBuffer(
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    'word/document.xml',
  );
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    ws.on('close', () => resolve());
    ws.on('error', reject);
    zip.outputStream.pipe(ws);
    zip.end();
  });
  return file;
}

export const OWNER = { officeName: 'مكتب تجريبي — بيانات خيالية', displayName: 'المالك التجريبي', username: 'owner', password: 'Owner#Pass2026' };
export const CONSULTANT = { displayName: 'مستشار تجريبي', username: 'consultant', password: 'Consult#Pass2026' };

export async function setupOwner(core: AppCore, session = 'S-owner') {
  const r = await call<{ recoveryCode: string }>(core, session, 'auth.setupOwner', OWNER);
  return { session, recoveryCode: r.recoveryCode };
}

/** يجهز كيانات رحلة القبول: شركة بعقد شامل ووكالة، وقضيتان مرتبطتان بهما. */
export async function seedCompany(core: AppCore, s: string) {
  const client = await call<{ id: string }>(core, s, 'clients.create', {
    kind: 'company',
    name: 'شركة المثال التجريبية',
    shortName: 'المثال',
    phone: '0500000001',
    email: 'info@example.test',
    repName: 'ممثل خيالي',
    repTitle: 'المدير التنفيذي',
    relationshipSummary: 'عقد شامل لتمثيل الشركة في منازعاتها (بيانات خيالية للاختبار).',
  });
  const labor = await call<{ id: string; fileNo: string }>(core, s, 'cases.create', {
    clientId: client.id,
    title: 'مطالبة عمالية — موظف سابق (خيالي)',
    caseType: 'عمالية',
    subject: 'مطالبة بمستحقات نهاية الخدمة',
    openedOn: '2026-01-10',
    parties: [{ name: 'خصم عمالي خيالي', role: 'مدعٍ', isOpponent: true }],
    firstStage: { stageType: 'الدرجة الأولى', courtType: 'المحاكم العمالية', courtName: 'المحكمة العمالية التجريبية', circuit: 'الدائرة 3', officialCaseNo: '4470001234', startedOn: '2026-01-15', status: 'ongoing' },
  });
  const commercial = await call<{ id: string; fileNo: string }>(core, s, 'cases.create', {
    clientId: client.id,
    title: 'نزاع توريد — مورد خيالي',
    caseType: 'تجارية',
    openedOn: '2026-02-01',
    claimAmount: 25000000,
    parties: [{ name: 'مؤسسة التوريد الخيالية', role: 'مدعى عليه', isOpponent: true }],
    firstStage: { stageType: 'الدرجة الأولى', courtType: 'المحاكم التجارية', courtName: 'المحكمة التجارية التجريبية', officialCaseNo: '4470009999', startedOn: '2026-02-05', status: 'ongoing' },
  });
  const contract = await call<{ id: string }>(core, s, 'contracts.create', {
    clientId: client.id,
    kind: 'fee',
    title: 'عقد أتعاب شامل 2026',
    scope: 'تمثيل الشركة في القضية العمالية والقضية التجارية المحددتين فقط.',
    feeType: 'mixed',
    fixedAmount: 10000000,
    percentage: 5,
    percentageBasis: 'من المبلغ المحكوم به فعليًا في القضية التجارية',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    caseIds: [labor.id, commercial.id],
  });
  const poa = await call<{ id: string }>(core, s, 'poas.create', {
    clientId: client.id,
    poaNo: '470000111',
    issuer: 'جهة توثيق خيالية',
    issuedOn: '2026-01-05',
    expiresOn: '2027-01-04',
    scope: 'المرافعة والمدافعة في القضايا العمالية والتجارية المحددة.',
    caseIds: [labor.id, commercial.id],
  });
  return { clientId: client.id, laborId: labor.id, commercialId: commercial.id, contractId: contract.id, poaId: poa.id };
}

export async function stageAndAttach(core: AppCore, platform: FakePlatform, s: string, file: string, meta: Record<string, unknown>) {
  platform.openQueue.push(file);
  const staged = await call<{ token: string }>(core, s, 'documents.pickFile', {});
  return call<{ id: string; versionId: string }>(core, s, 'documents.create', { ...meta, token: staged.token });
}
