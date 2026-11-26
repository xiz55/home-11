// نسخة الآيفون والرابط الآمن تضيفان الصنف platform-ios إلى عنصر الصفحة الجذري (لا ميزات سطح المكتب)،
// والرابط الآمن يضيف platform-web أيضًا (كل شيء يُنفّذ على جهاز المكتب).
export const isIOS = () => typeof document !== 'undefined' && document.documentElement.classList.contains('platform-ios');
export const isWeb = () => typeof document !== 'undefined' && document.documentElement.classList.contains('platform-web');
