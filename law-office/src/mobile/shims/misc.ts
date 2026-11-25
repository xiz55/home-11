// بدائل صغيرة لوحدات النظام غير الموجودة في الآيفون. ما لا ينطبق على الآيفون يرمي خطأً واضحًا عند استخدامه.
export const hostname = () => 'iPhone';
export const platform = () => 'ios';
export const tmpdir = () => '/tmp';
export const homedir = () => '/';
export const EOL = '\n';
const os = { hostname, platform, tmpdir, homedir, EOL };
export default os;

export class Worker {
  constructor() {
    throw new Error('worker_threads not available on iOS');
  }
}
export const isMainThread = true;
export const parentPort = null;

function notOnIos(): never {
  throw new Error('هذه العملية (حزمة النسخة الاحتياطية المضغوطة) متاحة على نسخة سطح المكتب فقط.');
}
export class ZipFile {
  constructor() {
    notOnIos();
  }
}
export const open = notOnIos;
export const fromBuffer = notOnIos;
