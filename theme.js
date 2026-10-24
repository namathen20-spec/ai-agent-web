// Apply the saved theme before first paint to avoid a flash of the wrong theme.
// Kept as a tiny synchronous head script so it runs before first paint. The full
// theme toggle (and its localStorage persistence) lives in app.js (initTheme).
(function () {
  'use strict';
  try {
    if (localStorage.getItem('aiAgent.theme') === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (e) { /* ignore */ }
})();