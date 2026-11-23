// تطبيع النص العربي لأغراض البحث فقط — النص الأصلي لا يُعدَّل أبدًا.

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;
const TATWEEL = /ـ/g;

export function normalizeArabic(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input).normalize('NFKC');
  s = s.replace(TASHKEEL, '').replace(TATWEEL, '');
  s = s
    .replace(/[آأإٱٲٳ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ؤ/g, 'و') // ؤ → و
    .replace(/ئ/g, 'ي') // ئ → ي
    .replace(/[ی]/g, 'ي') // ی فارسية → ي
    .replace(/[ک]/g, 'ك'); // ک → ك
  s = s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
  s = s.toLowerCase();
  s = s.replace(/[‌-‏‪-‮⁦-⁩]/g, ''); // محارف الاتجاه الخفية
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** تقسيم عبارة البحث إلى كلمات مطبّعة. */
export function searchTokens(q: string): string[] {
  return normalizeArabic(q)
    .split(/[\s,،؛;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

/** يهرّب محارف LIKE الخاصة. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export function trimOrNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

export function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** اسم ملف آمن للعرض أو الحفظ خارج البرنامج (لا يستخدم داخليًا للتخزين). */
export function safeFileName(name: string, fallback = 'ملف'): string {
  const cleaned = String(name)
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
  if (!cleaned || reserved.test(cleaned)) return fallback;
  return cleaned;
}
