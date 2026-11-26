# نسخة الآيفون: البناء والتوزيع

## البنية
- مشروع Xcode في `ios/` أنشأه Capacitor 7 (Swift Package Manager، دون CocoaPods). المعرّف: `sa.lawoffice.shahrani`، ويدعم iOS 14 فما فوق.
- يشغّل الواجهة نفسها ومنطق البرنامج نفسه (`src/main/services`) داخل التطبيق:
  - SQLite بنسخة WebAssembly (`sql.js`) عبر `src/mobile/sqlite-shim.ts`، الذي يحاكي `node:sqlite` المستخدم على سطح المكتب. **مجموعة اختبارات البرنامج نفسها تُشغَّل على هذا المحرك** (`npm run test:sqljs`).
  - ملفات التطبيق في `Library/NoCloud` (خارج نسخ iCloud الاحتياطية للجهاز، ومحمية بتشفير بيانات iOS) عبر `src/mobile/shims/vfs.ts`.
  - أسرار الجهاز وجلسة الدخول في Keychain (إضافة `native/law-native`، إتاحة «لهذا الجهاز فقط»).
  - الطباعة (AirPrint) وتحويل التقارير إلى PDF على الجهاز نفسه.

## البناء
```
npm ci
npm run build:mobile          # يبني dist/mobile وينسخه إلى مشروع Xcode
open ios/App/App.xcodeproj    # على ماك فيه Xcode
```

## ما تم وما لم يتم
| البند | الحالة |
|---|---|
| بناء المشروع للمحاكي ولأجهزة iPhone (دون توقيع) على Xcode في GitHub Actions | يُنفّذ في كل تحديث (`.github/workflows/law-office-ios.yml`) |
| تشغيل التطبيق على محاكي iOS، وإنشاء قاعدة البيانات وفحص سلامتها وبقاؤها بعد إعادة الفتح، ولقطة شاشة | يُنفّذ في المسار نفسه |
| تشغيل البناء نفسه في متصفح بمقاس iPhone: إنشاء حساب، إضافة بيانات، البقاء بعد إعادة الفتح، القائمة والبطاقات، والمزامنة مع Supabase محلي في الاتجاهين | منفّذ |
| تثبيت على جهاز iPhone فعلي | **لم يُنفّذ** — يحتاج عضوية Apple Developer وتوقيعًا |
| TestFlight | **لم يُنفّذ** — يحتاج العضوية وموافقتك |

## خطوات TestFlight (بعد موافقتك وتوفر العضوية)
1. الاشتراك في Apple Developer Program باسم المكتب أو باسمك (رسوم سنوية تحددها Apple).
2. في Xcode: Signing & Capabilities ← اختيار الفريق (Team)، مع إبقاء المعرّف `sa.lawoffice.shahrani` أو تغييره.
3. في App Store Connect: إنشاء التطبيق بالمعرّف نفسه.
4. Xcode ← Product ← Archive ← Distribute App ← App Store Connect ← Upload.
5. في App Store Connect ← TestFlight: إضافة نفسك والمستشارين مختبرين داخليين، ثم التثبيت من تطبيق TestFlight على الهاتف.

ملف IPA غير موقّع **لا يُثبَّت** على iPhone بتنزيله؛ التثبيت عبر TestFlight أو توزيع معتمد من Apple فقط.
