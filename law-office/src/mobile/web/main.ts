// نقطة بدء نسخة الآيفون: تشغيل المنطق المحلي أولًا، ثم الواجهة نفسها المستخدمة على سطح المكتب.
import './polyfills';
import { bootHost } from '../host';

const test = new URLSearchParams(location.search).has('testBackend');
bootHost({ testBackend: test })
  .then(() => import('../../renderer/main'))
  .catch((e) => {
    const root = document.getElementById('root')!;
    root.textContent = `تعذر فتح بيانات المكتب على هذا الجهاز: ${(e as Error).message}`;
    console.error(e);
  });
