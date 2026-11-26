// إن تعذّر تشغيل الصفحة على هذا المتصفح تظهر رسالة الخطأ بدل شاشة بيضاء (يُحمّل قبل البرنامج).
(function () {
  function show(msg) {
    var r = document.getElementById('root');
    if (!r || window.__lawBooted) return;
    r.innerHTML = '<div style="padding:24px 16px;font-family:system-ui;color:#900;direction:rtl;line-height:1.8">تعذر تشغيل الصفحة على هذا المتصفح. صوّر هذه الرسالة:<small style="direction:ltr;display:block;color:#555;margin-top:8px;word-break:break-all">' + String(msg).replace(/</g, '&lt;') + '<br>' + navigator.userAgent + '</small></div>';
  }
  window.addEventListener('error', function (e) { show((e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')); });
  window.addEventListener('unhandledrejection', function (e) { show(e.reason && (e.reason.stack || e.reason.message) || e.reason); });
  setTimeout(function () { if (!window.__lawBooted && !document.querySelector('.auth-screen, .app')) show('انتهت مهلة التحميل (20 ثانية)'); }, 20000);
})();
