/**
 * The two HTML pages served on the storefront origin through the app proxy:
 * and the offline fallback.
 *
 * Both are built as strings rather than templates because they are small, they
 * have no shared layout with the admin, and keeping them dependency-free means
 * the storefront surface of this app pulls in nothing but express and sharp.
 */

// The launch target has to be worked out the same way the manifest works it
// out, or the check page will cheerfully pass a store whose app launches
// somewhere the worker cannot reach.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/**
 * JSON safe to embed in an inline <script>. Escaping "<" is what stops a value
 * containing "</script>" from ending the block early — the one way a merchant's
 * own app name could turn into markup.
 */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function offline(settings) {
  const bg = settings.backgroundColor;
  const fg = settings.themeColor;

  return `<!doctype html>
<html lang="${escapeHtml(settings.lang)}" dir="${escapeHtml(settings.dir)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — ${escapeHtml(settings.name)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: ${escapeHtml(bg)}; color: ${escapeHtml(fg)};
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .box { max-width: 380px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 20px; opacity: 0.75; }
  button { font: inherit; font-weight: 600; padding: 11px 22px; border: 0; border-radius: 10px;
    cursor: pointer; background: ${escapeHtml(fg)}; color: ${escapeHtml(bg)}; }
</style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(settings.offline.title)}</h1>
    <p>${escapeHtml(settings.offline.message)}</p>
    <button type="button" onclick="location.reload()">Try again</button>
  </div>
  <script>
    // Reload the moment connectivity returns, rather than making someone who is
    // already back online press a button to find out.
    addEventListener('online', function () { location.reload(); });
  </script>
</body>
</html>
`;
}

/**
 * The launch shell, served at the proxy root.
 *
 * This is the page the installed app opens, and it exists for one reason: it is
 * the only kind of page the service worker is allowed to control. A worker
 * served through the app proxy is scoped to /apps/pwa/, so a manifest pointing
 * start_url straight at the storefront launches into a page the worker has
 * never seen and cannot serve from cache. Pointing start_url here instead means
 * a cold launch with no connection lands on something we cached, rather than on
 * the browser's dinosaur.
 *
 * Online it is invisible: the redirect fires within a beat, and the customer
 * lands on the storefront exactly as before. `storeUrl` is the merchant's own
 * startUrl setting, never this page, so there is no way to build a loop.
 *
 * It registers the worker itself rather than leaving that to pwa.js on the
 * storefront. pwa.js only runs on storefront pages, so a shell that did not
 * register would be cacheable only for someone who had already browsed the shop
 * online in this browser — and the whole point of the shell is the launch that
 * happens when nothing else is available.
 */
function shell(settings, storeUrl, sw) {
  const bg = settings.backgroundColor;
  const fg = settings.themeColor;

  return `<!doctype html>
<html lang="${escapeHtml(settings.lang)}" dir="${escapeHtml(settings.dir)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(settings.name)}</title>
<meta name="robots" content="noindex">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: ${escapeHtml(bg)}; color: ${escapeHtml(fg)};
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .box { max-width: 380px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 20px; opacity: 0.75; }
  a.go, button { font: inherit; font-weight: 600; padding: 11px 22px; border: 0; border-radius: 10px;
    cursor: pointer; background: ${escapeHtml(fg)}; color: ${escapeHtml(bg)};
    text-decoration: none; display: inline-block; }
  /* Hidden until the script decides which of the two states applies, so a
     cached shell never flashes "you are offline" at someone who is online. */
  #states { visibility: hidden; }
</style>
</head>
<body>
  <div class="box" id="states">
    <div id="offline" hidden>
      <h1>${escapeHtml(settings.offline.title)}</h1>
      <p>${escapeHtml(settings.offline.message)}</p>
      <button type="button" onclick="location.reload()">Try again</button>
    </div>
    <div id="going">
      <h1>${escapeHtml(settings.name)}</h1>
      <p>Opening the store\u2026</p>
      <a class="go" href="${escapeHtml(storeUrl)}">Continue</a>
    </div>
  </div>
  <script>
    (function () {
      var store = ${jsonForScript(storeUrl)};
      var swUrl = ${jsonForScript(sw && sw.enabled ? sw.url : '')};
      var states = document.getElementById('states');

      function offline() {
        document.getElementById('going').hidden = true;
        document.getElementById('offline').hidden = false;
        states.style.visibility = 'visible';
      }

      if (navigator.onLine === false) {
        offline();
        // The launch happened with no connection; go the moment one returns.
        addEventListener('online', function () { location.replace(store); });
        return;
      }

      states.style.visibility = 'visible';

      // replace(), not assign(): the shell must not sit in history behind the
      // store, or Back from the first storefront page returns here and bounces
      // the customer straight forward again.
      var gone = false;
      function go() {
        if (gone) return;
        gone = true;
        location.replace(store);
      }

      if (!swUrl || !('serviceWorker' in navigator)) {
        go();
        return;
      }

      // Hold the launch only until the worker is actually running, so that THIS
      // visit is the one that caches the shell — but never for long. A slow
      // registration must not be the reason the store feels slow to open, so
      // whichever finishes first wins and the cache catches up next launch.
      setTimeout(go, 1500);
      navigator.serviceWorker.register(swUrl)
        .then(function () { return navigator.serviceWorker.ready; })
        .then(go, go);
    })();
  </script>
</body>
</html>
`;
}

module.exports = { escapeHtml, jsonForScript, offline, shell };
