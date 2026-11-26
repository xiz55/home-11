// استخراج النص محليًا من PDF (نصي) وDOCX — لا يرسل أي محتوى خارج الجهاز.
// الصور الممسوحة ضوئيًا لا تحتوي نصًا قابلًا للاستخراج، ولا ندّعي ذلك.
import fs from 'node:fs';

export async function extractDocx(file: string): Promise<string> {
  const mammoth = await import('mammoth');
  const r = await mammoth.extractRawText({ buffer: fs.readFileSync(file) });
  return r.value;
}

let pdfjsP: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
async function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = worker;
      return import('pdfjs-dist/legacy/build/pdf.mjs');
    })();
  }
  return pdfjsP;
}

export async function extractPdf(file: string, maxPages = 400): Promise<string> {
  const lib = await pdfjs();
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await lib.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const parts: string[] = [];
  try {
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return parts.join('\n').replace(/[ \t]+/g, ' ').trim();
}

export async function extractText(file: string, ext: string): Promise<{ status: 'done' | 'none' | 'unsupported'; text: string | null }> {
  if (ext === 'docx') {
    const t = (await extractDocx(file)).trim();
    return t ? { status: 'done', text: t } : { status: 'none', text: null };
  }
  if (ext === 'pdf') {
    const t = await extractPdf(file);
    // ملف PDF ممسوح ضوئيًا لا يعطي نصًا؛ نسجل ذلك بوضوح
    return t.replace(/\s/g, '').length > 10 ? { status: 'done', text: t } : { status: 'none', text: null };
  }
  return { status: 'unsupported', text: null };
}
