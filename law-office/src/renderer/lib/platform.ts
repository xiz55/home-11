// نسخة الآيفون تضيف الصنف platform-ios إلى عنصر الصفحة الجذري (انظر src/mobile/host.ts).
export const isIOS = () => typeof document !== 'undefined' && document.documentElement.classList.contains('platform-ios');
