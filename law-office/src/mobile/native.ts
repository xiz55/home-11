// واجهات الإضافات الأصلية في مشروع الآيفون (ios/App/App/LawPlugins.swift):
// - LawKeychain: حفظ جلسة الدخول وأسرار الجهاز في Keychain (لا تُنقل لأجهزة أخرى ولا تدخل نسخ iCloud).
// - LawPrint: الطباعة عبر AirPrint، وتحويل HTML إلى PDF مقسّم صفحات A4.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface KeychainPlugin {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}
interface PrintPlugin {
  print(o: { html: string; jobName: string }): Promise<void>;
  pdf(o: { html: string; landscape: boolean }): Promise<{ base64: string }>;
}

export const isNative = () => Capacitor.isNativePlatform();
export const Keychain = registerPlugin<KeychainPlugin>('LawKeychain');
export const LawPrint = registerPlugin<PrintPlugin>('LawPrint');
