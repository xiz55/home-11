import fs from 'node:fs';
import { ALLOWED_EXTENSIONS, type AllowedExt } from '../../shared/constants';

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

export function isAllowedExt(ext: string): ext is AllowedExt {
  return Object.prototype.hasOwnProperty.call(ALLOWED_EXTENSIONS, ext);
}

function readHeadTail(file: string, size: number): { head: Buffer; tail: Buffer } {
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(size, 65536);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    const tailLen = Math.min(size, 65536);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, Math.max(0, size - tailLen));
    return { head, tail };
  } finally {
    fs.closeSync(fd);
  }
}

/** يتحقق من أن محتوى الملف يطابق امتداده (توقيع البايتات الأولى) — يمنع تمرير ملفات تنفيذية باسم مستند. */
export function contentMatchesExt(file: string, ext: AllowedExt, size: number): boolean {
  if (size < 4) return false;
  const { head, tail } = readHeadTail(file, size);
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  switch (ext) {
    case 'pdf':
      return head.subarray(0, 1024).includes('%PDF-');
    case 'docx':
      return starts(0x50, 0x4b, 0x03, 0x04) && (head.includes('word/') || tail.includes('word/'));
    case 'doc':
      return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case 'jpg':
    case 'jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'gif':
      return head.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'webp':
      return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'bmp':
      return starts(0x42, 0x4d);
    case 'tif':
    case 'tiff':
      return starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a);
    case 'heic':
      return head.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(head.subarray(8, 12).toString('latin1'));
    default:
      return false;
  }
}
