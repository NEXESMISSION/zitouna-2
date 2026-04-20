// Synchronous theme bootstrap. Runs before React mounts so initial paint
// already has the correct background — prevents the dark→light flash on
// /admin and the light→dark flash on /login. Loaded from /public/ (served
// as-is by Vite) so the strict CSP `script-src 'self'` covers it without
// needing an inline-script nonce. See docs/AUDIT/01_SECURITY_FINDINGS.md
// (S-C4, S-L4).
/* eslint-disable no-unused-vars */
(function () {
  try {
    var p = location.pathname || '';
    var theme = 'dark';
    if (p.indexOf('/admin') === 0) theme = 'admin';
    else if (p === '/login' || p === '/register' || p === '/forgot-password' || p === '/reset-password') theme = 'auth';
    document.documentElement.setAttribute('data-theme', theme);
    var color = theme === 'admin' ? '#f8fafc' : '#071009';
    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.appendChild(meta);
  } catch (e) {
    /* Plan 06 §9 hardening: if ANY of the above throws, force a
       predictable data-theme="dark" so the CSS cascade has a known
       starting point (prevents flash-of-unstyled-content). The outer
       swallow is still fine — this inner try is belt-and-suspenders. */
    try { document.documentElement.setAttribute('data-theme', 'dark'); } catch (_) { /* noop */ }
  }
})();
/* eslint-enable no-unused-vars */
