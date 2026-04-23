// Synchronous theme bootstrap. Runs before React mounts so initial paint
// already has the correct background. Loaded from /public/ (served as-is
// by Vite) so the strict CSP `script-src 'self'` covers it without needing
// an inline-script nonce.
//
// The dark-green theme has been removed — every route uses the light
// canvas. /admin keeps its own data-theme="admin" attribute since the
// admin stylesheet (ZADM) targets it directly; everything else is
// "light" so theme-light.css owns the paint.
/* eslint-disable no-unused-vars */
(function () {
  try {
    var p = location.pathname || '';
    var theme = (p.indexOf('/admin') === 0) ? 'admin' : 'light';

    document.documentElement.setAttribute('data-theme', theme);
    document.body && document.body.setAttribute('data-theme', theme);

    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#f8fafc';
    document.head.appendChild(meta);
  } catch (e) {
    try { document.documentElement.setAttribute('data-theme', 'light'); } catch (_) { /* noop */ }
  }
})();
/* eslint-enable no-unused-vars */
