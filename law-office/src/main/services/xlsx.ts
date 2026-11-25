// كاتب XLSX محلي بسيط (Office Open XML) دون مكتبات خارجية: نص مضمّن، أرقام بقيمها الدقيقة، اتجاه ورقة من اليمين لليسار،
// صف عناوين مثبت ومكرر عند الطباعة. المبالغ تُكتب من الهللات بحساب صحيح دون كسور عائمة.
import { zipSync, strToU8 } from 'fflate';

export type XCell = { t: 's'; v: string } | { t: 'n'; v: number; money?: boolean } | { t: 'money'; halalas: number } | null;

export interface XSheet {
  name: string;
  columns: { label: string; width?: number }[];
  rows: XCell[][];
  /** صفوف تمهيدية تُكتب قبل صف العناوين (عنوان التقرير والفترة) */
  preface?: string[];
}

const xmlEsc = (s: string) =>
  s
    // محارف التحكم غير مسموحة في XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** يحوّل الهللات إلى نص عشري دقيق (مثل 12345 ← 123.45) دون المرور بقسمة عائمة. */
export function halalasToDecimal(h: number): string {
  const neg = h < 0;
  const a = Math.abs(Math.trunc(h));
  return `${neg ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function safeSheetName(name: string, used: Set<string>): string {
  let n = name.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'ورقة';
  let k = 2;
  const base = n;
  while (used.has(n)) n = `${base.slice(0, 28)} ${k++}`;
  used.add(n);
  return n;
}

function cellXml(ref: string, c: XCell, style?: number): string {
  if (c === null) return '';
  if (c.t === 's') return `<c r="${ref}" t="inlineStr" s="${style ?? 3}"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
  if (c.t === 'money') return `<c r="${ref}" s="2"><v>${halalasToDecimal(c.halalas)}</v></c>`;
  return `<c r="${ref}" s="${c.money ? 2 : 4}"><v>${Number.isFinite(c.v) ? c.v : 0}</v></c>`;
}

function sheetXml(sh: XSheet, index: number): { xml: string; headerRow: number } {
  const pre = sh.preface ?? [];
  const headerRow = pre.length + 1;
  const rows: string[] = [];
  pre.forEach((p, i) => rows.push(`<row r="${i + 1}">${cellXml(`A${i + 1}`, { t: 's', v: p }, i === 0 ? 5 : 3)}</row>`));
  rows.push(`<row r="${headerRow}">${sh.columns.map((c, i) => cellXml(`${colName(i)}${headerRow}`, { t: 's', v: c.label }, 1)).join('')}</row>`);
  sh.rows.forEach((r, ri) => {
    const rn = headerRow + 1 + ri;
    rows.push(`<row r="${rn}">${r.map((c, ci) => cellXml(`${colName(ci)}${rn}`, c)).join('')}</row>`);
  });
  const lastCol = colName(Math.max(sh.columns.length - 1, 0));
  const lastRow = headerRow + sh.rows.length;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView rightToLeft="1" workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>${sh.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? Math.min(Math.max(c.label.length + 4, 12), 60)}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
${sh.rows.length ? `<autoFilter ref="A${headerRow}:${lastCol}${lastRow}"/>` : ''}
<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;Cصفحة &amp;P من &amp;N</oddFooter></headerFooter>
</worksheet>`;
  return { xml, headerRow };
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font><font><b/><sz val="13"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3ECDD"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD8DCE0"/></left><right style="thin"><color rgb="FFD8DCE0"/></right><top style="thin"><color rgb="FFD8DCE0"/></top><bottom style="thin"><color rgb="FFD8DCE0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1" readingOrder="2"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1" readingOrder="2"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" readingOrder="2"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function buildXlsx(sheets: XSheet[], meta: { title: string; createdAt: string }): Promise<Buffer> {
  const used = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));
  // ضغط ZIP بمكتبة fflate (تعمل على سطح المكتب والآيفون بالنتيجة نفسها)
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const add = (name: string, content: string) => (entries[name] = [strToU8(content), { mtime: new Date(meta.createdAt) }]);
  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
  );
  add(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
  );
  add(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEsc(meta.title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${meta.createdAt}</dcterms:created>
</cp:coreProperties>`,
  );
  const definedNames: string[] = [];
  const sheetXmls = named.map((s, i) => {
    const r = sheetXml(s, i);
    // تكرار صف العناوين في كل صفحة مطبوعة
    definedNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${s.name.replace(/'/g, "''")}'!$${r.headerRow}:$${r.headerRow}</definedName>`);
    if (s.rows.length) definedNames.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${s.name.replace(/'/g, "''")}'!$A$${r.headerRow}:$${colName(Math.max(s.columns.length - 1, 0))}$${r.headerRow + s.rows.length}</definedName>`);
    return r.xml;
  });
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${named.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${definedNames.map((d) => d.replace(/'([^']*)'!/, (_m, n) => `'${xmlEsc(n)}'!`)).join('')}</definedNames>
</workbook>`,
  );
  add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  add('xl/styles.xml', STYLES);
  sheetXmls.forEach((x, i) => add(`xl/worksheets/sheet${i + 1}.xml`, x));
  const out = zipSync(entries, { level: 6 });
  return Promise.resolve(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
}
