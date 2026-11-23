// المبالغ تُحفظ بالهللة (عدد صحيح) لتجنب أخطاء الكسور العشرية.

export function parseAmount(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
  s = s.replace(/[٬,\s]/g, '').replace(/٫/g, '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  const halalas = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(halalas)) return NaN;
  return halalas;
}

const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtAmount(halalas: number | null | undefined, withCurrency = true): string {
  if (halalas === null || halalas === undefined) return '—';
  const s = nf.format(halalas / 100);
  return withCurrency ? `${s} ر.س` : s;
}

export function amountToInput(halalas: number | null | undefined): string {
  if (halalas === null || halalas === undefined) return '';
  const whole = Math.trunc(halalas / 100);
  const frac = Math.abs(halalas % 100);
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : String(whole);
}
