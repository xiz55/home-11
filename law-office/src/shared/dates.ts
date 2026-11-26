// معالجة التواريخ: كل المواعيد تُعرض وتُدخل بتوقيت الرياض (Asia/Riyadh) بغض النظر عن منطقة الجهاز.
// - التاريخ المجرد (YYYY-MM-DD) يُحفظ نصًا كما هو فلا ينزاح بسبب UTC.
// - الموعد ذو الوقت يُحفظ لحظة فعلية بصيغة ISO UTC، ويُحوَّل للعرض بتوقيت الرياض.

import { OFFICE_TZ } from './constants';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: OFFICE_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function zonedParts(ms: number) {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

function offsetMs(ms: number): number {
  const z = zonedParts(ms);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** يحوّل تاريخًا ووقتًا محليين بتوقيت الرياض إلى لحظة ISO UTC. */
export function riyadhToUtcIso(date: string, time: string): string {
  if (!isValidDate(date) || !TIME_RE.test(time)) throw new Error('تاريخ أو وقت غير صالح');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ms = guess - offsetMs(guess);
  // تصحيح ثانٍ احتياطي لو اختلفت الإزاحة (لا يوجد توقيت صيفي في الرياض، لكن نُبقي الحساب عامًا)
  ms = guess - offsetMs(ms);
  return new Date(ms).toISOString();
}

/** يعيد التاريخ والوقت بتوقيت الرياض للحظة ISO. */
export function utcIsoToRiyadh(iso: string): { date: string; time: string } {
  const z = zonedParts(new Date(iso).getTime());
  return {
    date: `${z.year}-${pad(z.month)}-${pad(z.day)}`,
    time: `${pad(z.hour)}:${pad(z.minute)}`,
  };
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function todayRiyadh(now: Date = new Date()): string {
  return utcIsoToRiyadh(now.toISOString()).date;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function diffDays(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}

/** بداية اليوم ونهايته بتوقيت الرياض كلحظات UTC (لنطاقات الاستعلام). */
export function riyadhDayRangeUtc(date: string): { from: string; to: string } {
  return { from: riyadhToUtcIso(date, '00:00'), to: riyadhToUtcIso(addDays(date, 1), '00:00') };
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = الأحد
}

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

export function weekdayName(date: string): string {
  return WEEKDAYS[weekdayOf(date)];
}
export function monthName(month1: number): string {
  return MONTHS[month1 - 1];
}

/** 2026/11/23 — أرقام لاتينية لتطابق الوثائق الرسمية وأرقام القضايا. */
export function fmtDate(date: string | null | undefined): string {
  if (!date) return '—';
  if (!isValidDate(date)) return date;
  const [y, m, d] = date.split('-');
  return `${y}/${m}/${d}`;
}

export function fmtDateLong(date: string | null | undefined): string {
  if (!date || !isValidDate(date)) return fmtDate(date);
  const [y, m, d] = date.split('-').map(Number);
  return `${weekdayName(date)} ${d} ${monthName(m)} ${y}`;
}

export function fmtTime12(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'ص' : 'م';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const { date, time } = utcIsoToRiyadh(iso);
  return `${fmtDate(date)} — ${fmtTime12(time)}`;
}

export function fmtDateTimeLong(iso: string | null | undefined): string {
  if (!iso) return '—';
  const { date, time } = utcIsoToRiyadh(iso);
  return `${fmtDateLong(date)} — ${fmtTime12(time)}`;
}
