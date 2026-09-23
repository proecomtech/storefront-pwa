/**
 * End-to-end smoke test: boots the real server and exercises both surfaces.
 *
 * Run with the app directory as cwd:  node smoke.js
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = 3457;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOP = 'demo-store.myshopify.com';
const API_KEY = 'test-client-id';
const API_SECRET = 'test-client-secret';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-smoke-'));

let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + label);
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a session token the way App Bridge would. */
function sessionToken(overrides) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = Object.assign({
    iss: 'https://' + SHOP + '/admin',
    dest: 'https://' + SHOP,
    aud: API_KEY,
    sub: '1',
    exp: now + 60,
    nbf: now - 10,
    iat: now,
    jti: '1',
    sid: 'abc',
  }, overrides || {});
  const payload = b64url(JSON.stringify(claims));
  const secret = (overrides && overrides.__secret) || API_SECRET;
  const sig = b64url(crypto.createHmac('sha256', secret).update(header + '.' + payload).digest());
  return header + '.' + payload + '.' + sig;
}

/**
 * Wait for a condition the server reaches just after it answers.
 *
 * The webhook routes acknowledge Shopify and then erase, so the fetch resolving
 * says the 200 was sent, not that the files are gone yet (web/server.js,
 * eraseWhenSent). Polling is what the assertion actually means — "this is gone
 * shortly after the webhook" — and a fixed sleep would either be flaky on a
 * loaded machine or slow on an idle one. Returns false on timeout so the caller
 * still reports a real failure rather than hanging.
 */
async function eventually(condition, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  for (;;) {
    if (condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function proxyUrlFor(shop, p) {
  return BASE + '/pwa/proxy' + p + (p.includes('?') ? '&' : '?') +
    'shop=' + shop + '&path_prefix=%2Fapps%2Fpwa';
}

function proxyUrl(p) {
  return proxyUrlFor(SHOP, p);
}

function adminFor(shop, p, options) {
  const opts = options || {};
  const token = sessionToken({ dest: 'https://' + shop, iss: 'https://' + shop + '/admin' });
  opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
  return fetch(BASE + p, opts);
}

function admin(p, options) {
  return adminFor(SHOP, p, options);
}

const isPng = (buf) => buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

async function run() {
  console.log('\n== storefront proxy surface ==');

  let res = await fetch(BASE + '/healthz');
  const health = await res.json();
  ok('GET /healthz is 200', res.status === 200, 'got ' + res.status);
  ok('/healthz reports the api key and secret are set', health.apiKey === true && health.apiSecret === true);

  res = await fetch(proxyUrl('/manifest.json'));
  const manifest = await res.json();
  ok('manifest is 200', res.status === 200, 'got ' + res.status);
  ok('manifest content type', (res.headers.get('content-type') || '').includes('application/manifest+json'),
    res.headers.get('content-type'));
  ok('manifest launches at the shell, inside the worker scope',
    manifest.start_url === '/apps/pwa/', manifest.start_url);
  ok('manifest scope is still the whole storefront', manifest.scope === '/', manifest.scope);
  ok('manifest id is pinned to scope, so the move does not orphan installs',
    manifest.id === '/', manifest.id);
  ok('manifest display is standalone', manifest.display === 'standalone');
  ok('manifest has 192 and 512 icons',
    manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  ok('manifest has maskable icons', manifest.icons.some((i) => i.purpose === 'maskable'));
  ok('icon srcs use the forwarded proxy base',
    manifest.icons.every((i) => i.src.startsWith('/apps/pwa/')), manifest.icons[0].src);
  ok('manifest is cached briefly', (res.headers.get('cache-control') || '').includes('max-age=300'),
    res.headers.get('cache-control'));

  console.log('\n== launch shell ==');

  res = await fetch(proxyUrl('/'));
  const shell = await res.text();
  ok('the proxy root serves the shell', res.status === 200, 'got ' + res.status);
  ok('the shell is html',
    (res.headers.get('content-type') || '').includes('text/html'), res.headers.get('content-type'));
  ok('the shell forwards to the merchant store URL, not to itself',
    shell.includes('"/?source=pwa"') && !shell.includes('location.replace("/apps/pwa/")'));
  ok('the shell replaces rather than pushes history', shell.includes('location.replace'));
  ok('the shell has an offline state to fall back on', shell.includes('You are offline'));
  ok('the shell is kept out of search results', shell.includes('name="robots" content="noindex"'));

  res = await fetch(proxyUrl('/sw.js'));
  const swSource = await res.text();
  const swCfg = JSON.parse(swSource.match(/var CFG = (\{.*?\});/)[1]);
  ok('the worker is told where its shell is', swCfg.shellUrl === '/apps/pwa/', swCfg.shellUrl);
  ok('the shell is precached, so a cold offline launch has something to show',
    swCfg.precache.includes('/apps/pwa/'), JSON.stringify(swCfg.precache));
  ok('the offline page is precached too',
    swCfg.precache.includes('/apps/pwa/offline'), JSON.stringify(swCfg.precache));
  ok('the worker exempts its own pages from the blanket /apps/ exclusion',
    swSource.includes('var OURS = [CFG.shellUrl, CFG.offlineUrl]'));
  ok('but still refuses to cache the cart and checkout',
    swSource.includes('/^\\/cart/') && swSource.includes('/^\\/checkout/'));
  ok('the header is still sent, for the day Shopify stops stripping it',
    res.headers.get('service-worker-allowed') === '/', res.headers.get('service-worker-allowed'));

  console.log('\n== turning the worker off falls back to the store ==');

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceWorker: { enabled: false, offlinePage: true, cacheVersion: 1 } }),
  });
  ok('the worker can be switched off', res.status === 200, 'got ' + res.status);

  res = await fetch(proxyUrl('/manifest.json'));
  const plain = await res.json();
  ok('with no worker the app launches straight at the store',
    plain.start_url === '/?source=pwa', plain.start_url);
  ok('and its identity is unchanged either way', plain.id === '/', plain.id);

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceWorker: { enabled: true, offlinePage: true, cacheVersion: 1 } }),
  });
  ok('and back on again', res.status === 200, 'got ' + res.status);

  // A manifest fetched without a shop is the "hit the backend directly" case.
  res = await fetch(BASE + '/pwa/proxy/manifest.json');
  ok('manifest without ?shop is 400', res.status === 400, 'got ' + res.status);

  res = await fetch(proxyUrl('/icon-512.png'));
  let body = Buffer.from(await res.arrayBuffer());
  ok('placeholder icon-512 renders a PNG', res.status === 200 && isPng(body), 'status ' + res.status);
  ok('icons are immutable-cached', (res.headers.get('cache-control') || '').includes('immutable'));

  res = await fetch(proxyUrl('/icon-192-maskable.png'));
  body = Buffer.from(await res.arrayBuffer());
  ok('maskable icon renders a PNG', res.status === 200 && isPng(body), 'status ' + res.status);

  res = await fetch(proxyUrl('/apple-touch-icon.png'));
  ok('apple-touch-icon renders', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())));

  res = await fetch(proxyUrl('/splash-1170x2532.png'));
  ok('iOS splash renders for a known device', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())),
    'status ' + res.status);

  res = await fetch(proxyUrl('/splash-13x17.png'));
  ok('an unlisted splash size is 404', res.status === 404, 'got ' + res.status);

  res = await fetch(proxyUrl('/icon-999.png'));
  ok('an unlisted icon size is 404', res.status === 404, 'got ' + res.status);

  res = await fetch(proxyUrl('/sw.js'));
  const sw = await res.text();
  ok('sw.js is 200', res.status === 200);
  ok('sw.js sends Service-Worker-Allowed', res.headers.get('service-worker-allowed') === '/');
  ok('sw.js is not long-cached', (res.headers.get('cache-control') || '').includes('no-cache'));
  ok('sw.js config is substituted', !sw.includes('__SW_CONFIG__') && sw.includes('cachePrefix'));

  res = await fetch(proxyUrl('/pwa.js'));
  const pwa = await res.text();
  ok('pwa.js is 200', res.status === 200);
  ok('pwa.js config is substituted', !pwa.includes('__PWA_CONFIG__'));
  ok('pwa.js carries the iOS splash table', pwa.includes('-webkit-device-pixel-ratio'));
  ok('pwa.js js content type', (res.headers.get('content-type') || '').includes('javascript'));

  // Preview mode. These assert the wiring in the served script, not the card
  // appearing — that needs a browser. What they pin down is that the three
  // gates a preview has to clear all consult PREVIEW, since a preview that
  // silently obeys the delay is the exact failure it exists to rule out.
  ok('pwa.js reads the preview flag from the URL', pwa.includes('pwa-preview=1'));
  ok('a preview skips the delay', pwa.includes('var delay = PREVIEW ? 0 :'));
  ok('a preview ignores dismissal and install history', pwa.includes('if (PREVIEW) return true;'));
  ok('a preview shows the card even where nothing can install',
    pwa.includes('if (PREVIEW || deferredPrompt || instructionsFor(platform()).length)'));
  ok('a preview writes no analytics', pwa.includes('|| PREVIEW) return;'));
  ok('closing a preview does not suppress the real card',
    pwa.includes('if (PREVIEW) return hideCard();'));

  // Parse what is actually served, not the template. A substitution that lands
  // in the wrong place still yields parseable JavaScript, so also assert the
  // config reached the assignment the script reads at runtime.
  for (const [label, source, token] of [['pwa.js', pwa, 'var CFG = {'], ['sw.js', sw, 'var CFG = {']]) {
    try {
      new (require('vm').Script)(source, { filename: label });
      ok('served ' + label + ' parses', true);
    } catch (err) {
      ok('served ' + label + ' parses', false, err.message);
    }
    ok('served ' + label + ' assigns a real config object', source.includes(token));
  }

  res = await fetch(proxyUrl('/offline'));
  ok('offline page is 200 and not stored', res.status === 200 && (res.headers.get('cache-control') || '').includes('no-store'));

  res = await fetch(proxyUrl('/check'));
  const check = await res.text();
  ok('check page is 200', res.status === 200);
  ok('check page links the manifest', check.includes('<link rel="manifest" href="/apps/pwa/manifest.json">'));

  /*
   * Parse the script the page actually serves, not the module that built it.
   * That script lives inside a template literal, so every backslash in it is
   * consumed once before a browser sees it: a regex written /\/x/ arrives as
   * //x, which is a line comment, which silently swallows the rest of the
   * line. node --check on pages.js cannot see any of that — the string is
   * valid either way — and the page still returns 200 with the whole check
   * page dead. Only parsing the output catches it.
   */
  const checkScript = (check.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  ok('the check page carries an inline script', checkScript.length > 1000);
  ok('and it parses',
    (() => { try { new Function(checkScript); return true; } catch (e) { return false; } })());
  ok('no regex in it was flattened into a comment', !/[^:]\/\/[a-z]+\(\?:/.test(checkScript));

  res = await fetch(proxyUrl('/health'));
  ok('proxy health is 200', res.status === 200);

  console.log('\n== admin authentication ==');

  res = await fetch(BASE + '/api/settings');
  ok('settings with no token is 401', res.status === 401, 'got ' + res.status);

  res = await fetch(BASE + '/api/settings', { headers: { Authorization: 'Bearer ' + sessionToken({ __secret: 'wrong' }) } });
  ok('settings with a token signed by the wrong secret is 401', res.status === 401, 'got ' + res.status);

  res = await fetch(BASE + '/api/settings', { headers: { Authorization: 'Bearer ' + sessionToken({ exp: 1 }) } });
  ok('an expired token is 401', res.status === 401, 'got ' + res.status);

  res = await fetch(BASE + '/api/settings', { headers: { Authorization: 'Bearer ' + sessionToken({ aud: 'someone-else' }) } });
  ok('a token minted for another app is 401', res.status === 401, 'got ' + res.status);

  res = await admin('/api/settings');
  const loaded = await res.json();
  ok('a valid token loads settings', res.status === 200 && loaded.shop === SHOP, 'status ' + res.status);

  console.log('\n== settings validation ==');

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Demo Store',
      shortName: 'Demo',
      startUrl: 'https://evil.example/steal',
      scope: '/',
      themeColor: '#0a5c36',
      backgroundColor: '#ffffff',
      display: 'standalone',
      shortcuts: [{ name: 'Sale', url: '/collections/sale' }, { name: 'Bad', url: '//evil.example' }],
      assets: { icon: { present: true, rev: 'forged' } },
    }),
  });
  const saved = await res.json();
  ok('save is 200', res.status === 200, 'got ' + res.status);
  ok('an external start_url is rejected', saved.settings.startUrl === '/?source=pwa', saved.settings.startUrl);
  ok('the rejection is reported', saved.warnings.some((w) => w.includes('Start URL')));
  ok('a protocol-relative shortcut is dropped', saved.settings.shortcuts.length === 1);
  ok('a client cannot forge an uploaded icon', saved.settings.assets.icon.present === false);
  ok('the name is saved', saved.settings.name === 'Demo Store');

  res = await fetch(proxyUrl('/manifest.json'));
  const m2 = await res.json();
  ok('the manifest reflects the saved name', m2.name === 'Demo Store', m2.name);
  ok('the manifest reflects the saved shortcut', (m2.shortcuts || []).length === 1);
  ok('the manifest theme colour is saved', m2.theme_color === '#0a5c36', m2.theme_color);

  console.log('\n== master switch ==');

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, saved.settings, { enabled: false })),
  });
  const off = await res.json();
  ok('the app can be switched off', off.settings.enabled === false);

  res = await fetch(proxyUrl('/manifest.json'));
  const mOff = await res.json();
  ok('a disabled manifest is still served', res.status === 200);
  ok('a disabled manifest is not installable', mOff.display === 'browser', mOff.display);
  ok('display_override drops to browser only', JSON.stringify(mOff.display_override) === '["browser"]');

  res = await fetch(proxyUrl('/pwa.js'));
  const offScript = await res.text();
  ok('a disabled pwa.js is inert but valid', res.status === 200 && !offScript.includes('beforeinstallprompt'));

  res = await fetch(proxyUrl('/health'));
  ok('health reports the switch', (await res.json()).enabled === false);

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, saved.settings, { enabled: true, categories: ['shopping', 'lifestyle'] })),
  });
  const backOn = await res.json();
  ok('the app can be switched back on', backOn.settings.enabled === true);
  ok('categories are saved', backOn.settings.categories.join(',') === 'shopping,lifestyle');

  res = await fetch(proxyUrl('/manifest.json'));
  const mOn = await res.json();
  ok('re-enabling restores the display mode', mOn.display === 'standalone', mOn.display);
  ok('the manifest carries the categories', (mOn.categories || []).join(',') === 'shopping,lifestyle');

  console.log('\n== icon upload ==');

  const sharp = require(path.join(APP, 'node_modules', 'sharp'));
  const logo = await sharp({
    create: { width: 600, height: 600, channels: 3, background: '#c0392b' },
  }).png().toBuffer();

  res = await admin('/api/assets/icon', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: logo,
  });
  const uploaded = await res.json();
  ok('icon upload is 200', res.status === 200, 'got ' + res.status + ' ' + JSON.stringify(uploaded).slice(0, 120));
  ok('the icon is recorded as present', uploaded.settings.assets.icon.present === true);
  ok('the icon dimensions are measured', uploaded.settings.assets.icon.width === 600);
  ok('a preview thumbnail comes back', typeof uploaded.previews.icon === 'string' &&
    uploaded.previews.icon.startsWith('data:image/png;base64,'));
  ok('a maskable preview comes back too', typeof uploaded.previews.iconMaskable === 'string' &&
    uploaded.previews.iconMaskable.startsWith('data:image/png;base64,'));
  ok('the two previews differ', uploaded.previews.icon !== uploaded.previews.iconMaskable);

  // The placeholder must preview as well, or the admin looks broken before the
  // first upload — which is exactly when a merchant needs to see something.
  res = await admin('/api/assets/icon', { method: 'DELETE' });
  const cleared = await res.json();
  ok('the icon can be removed', cleared.settings.assets.icon.present === false);
  ok('the placeholder still previews', typeof cleared.previews.icon === 'string' &&
    cleared.previews.icon.startsWith('data:image/png;base64,'));

  // Put it back for the remaining checks.
  await admin('/api/assets/icon', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: logo });

  res = await fetch(proxyUrl('/manifest.json'));
  const m3 = await res.json();
  // The URL rev is renderRev, not the upload's own hash: it also covers the
  // colours the maskable and splash renders are drawn from. So assert that it
  // moved, not what it equals.
  ok('uploading an icon changes every icon URL',
    m3.icons[0].src !== manifest.icons[0].src, m3.icons[0].src);

  res = await fetch(proxyUrl('/icon-512.png'));
  ok('the uploaded icon renders at 512', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())));

  // A too-small logo must be refused rather than upscaled into a blurry icon.
  const small = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#000' } }).png().toBuffer();
  res = await admin('/api/assets/icon', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: small });
  ok('a logo under 512px is rejected', res.status === 400, 'got ' + res.status);

  res = await admin('/api/assets/icon', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('not an image') });
  ok('a non-image body is rejected', res.status === 400, 'got ' + res.status);

  res = await admin('/api/assets/nonsense', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: logo });
  ok('an unknown asset kind is rejected', res.status === 400, 'got ' + res.status);

  console.log('\n== colour changes bust the year-long icon cache ==');

  // The maskable icons are padded with the background colour and the splash
  // screens are drawn on it, so a colour change must move their URLs — they are
  // served immutable for a year and there is no other way to flush them.
  const beforeColour = await (await fetch(proxyUrl('/manifest.json'))).json();
  const beforePwa = await (await fetch(proxyUrl('/pwa.js'))).text();

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, backOn.settings, { backgroundColor: '#123456' })),
  });
  ok('the background colour saves', (await res.json()).settings.backgroundColor === '#123456');

  const afterColour = await (await fetch(proxyUrl('/manifest.json'))).json();
  const afterPwa = await (await fetch(proxyUrl('/pwa.js'))).text();

  ok('the maskable icon URL changes with the background colour',
    beforeColour.icons[1].src !== afterColour.icons[1].src, afterColour.icons[1].src);
  ok('the splash URLs in pwa.js change too',
    beforePwa !== afterPwa && afterPwa.includes('/splash-'));
  ok('background_color is reflected in the manifest', afterColour.background_color === '#123456');

  res = await fetch(proxyUrl('/icon-192-maskable.png'));
  ok('the recoloured maskable icon renders', res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())));

  console.log('\n== forcing a refresh ==');

  const swVersion = async () =>
    JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text()).match(/var CFG = (\{.*?\});/)[1]).version;

  const derivedDir = path.join(DATA_DIR, 'assets', SHOP, 'derived');

  // Ask for a splash and an icon first, so there is something on disk to clear.
  await fetch(proxyUrl('/splash-1170x2532.png'));
  await fetch(proxyUrl('/icon-512.png'));
  ok('derived renders are cached on disk', fs.existsSync(derivedDir) &&
    fs.readdirSync(derivedDir).length > 0);

  const iconsBefore = (await (await fetch(proxyUrl('/manifest.json'))).json()).icons[0].src;
  const swBefore = await swVersion();
  const renderVersionBefore = (await (await admin('/api/settings')).json()).settings.renderVersion;

  res = await fetch(BASE + '/api/cache/clear', { method: 'POST' });
  ok('forcing a refresh needs a session token', res.status === 401, 'got ' + res.status);

  res = await admin('/api/cache/clear', { method: 'POST' });
  const refreshed = await res.json();
  ok('forcing a refresh is 200', res.status === 200, 'got ' + res.status);
  ok('it bumps the render version',
    refreshed.settings.renderVersion === renderVersionBefore + 1, String(refreshed.settings.renderVersion));
  ok('it bumps the service worker cache version',
    (await swVersion()) === swBefore + 1, String(await swVersion()));
  // Not "the directory is empty": the response re-renders the admin's preview
  // thumbnails, so it legitimately holds fresh files at the new rev by the time
  // we look. What must be gone is everything keyed on the old one, or the
  // superseded renders would sit there forever under keys nothing asks for.
  const oldRev = new URL('http://x' + iconsBefore).searchParams.get('v');
  const survivors = fs.existsSync(derivedDir)
    ? fs.readdirSync(derivedDir).filter((f) => f.includes(oldRev))
    : [];
  ok('it clears the superseded renders off disk', survivors.length === 0, survivors.join(','));
  ok('and the rev it cleared was a real one', Boolean(oldRev), String(oldRev));
  ok('previews are re-rendered for the admin', typeof refreshed.previews.icon === 'string' &&
    refreshed.previews.icon.startsWith('data:image/png;base64,'));

  const iconsAfter = (await (await fetch(proxyUrl('/manifest.json'))).json()).icons[0].src;
  ok('every icon URL moves, so the year-long cache cannot serve the old one',
    iconsAfter !== iconsBefore, iconsBefore + ' -> ' + iconsAfter);

  res = await fetch(proxyUrl('/icon-512.png'));
  ok('icons still render at the new address',
    res.status === 200 && isPng(Buffer.from(await res.arrayBuffer())), 'status ' + res.status);

  // Nothing the merchant chose may move: a refresh is a cache operation, not an
  // edit, and a button that quietly reset a colour would be worse than no
  // button at all.
  ok('the merchant’s own settings are untouched',
    refreshed.settings.name === backOn.settings.name &&
    refreshed.settings.backgroundColor === '#123456' &&
    refreshed.settings.enabled === true,
    JSON.stringify({ n: refreshed.settings.name, b: refreshed.settings.backgroundColor }));

  // The subtle one. sanitise() builds its result by spreading defaults(), so a
  // counter that is not carried across explicitly is silently reset to 1 by the
  // merchant's next save — undoing the refresh they just asked for.
  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, refreshed.settings, { name: 'Renamed After Refresh' })),
  });
  const afterSave = await res.json();
  ok('an ordinary save does not undo the refresh',
    afterSave.settings.renderVersion === renderVersionBefore + 1,
    String(afterSave.settings.renderVersion));
  ok('and a client cannot forge the render version',
    (await (await admin('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, refreshed.settings, { renderVersion: 9999 })),
    })).json()).settings.renderVersion === renderVersionBefore + 1);

  console.log('\n== install counters ==');

  // The storefront sends these as a bare beacon: POST, no body, event name in
  // the query string, shop supplied by the proxy.
  function event(type) {
    return fetch(proxyUrl('/event?type=' + type), { method: 'POST' });
  }

  res = await event('shown');
  ok('an event beacon is 204', res.status === 204, 'got ' + res.status);
  ok('the beacon is never cached', (res.headers.get('cache-control') || '').includes('no-store'));

  await event('shown');
  await event('clicked');
  await event('installed');
  await event('installed');
  await event('launch');

  res = await event('not-an-event');
  ok('an unknown event name is still 204', res.status === 204, 'got ' + res.status);


  res = await fetch(BASE + '/pwa/proxy/event?type=installed', { method: 'POST' });
  ok('an event without ?shop is 400', res.status === 400, 'got ' + res.status);

  res = await admin('/api/stats');
  const counts = await res.json();
  ok('stats need a session token', (await fetch(BASE + '/api/stats')).status === 401);
  ok('stats are 200 for a valid token', res.status === 200, 'got ' + res.status);
  ok('installs are counted', counts.totals.installed === 2, JSON.stringify(counts.totals));
  ok('card impressions are counted', counts.totals.shown === 2, JSON.stringify(counts.totals));
  ok('taps are counted', counts.totals.clicked === 1);
  ok('app opens are counted', counts.totals.launch === 1);
  // Checked against the list the server declares rather than against a count,
  // so adding an event does not fail a test whose point is that a made-up one
  // is refused.
  ok('an unknown event name is not stored',
    !('not-an-event' in counts.totals) &&
    Object.keys(counts.totals).every((k) => counts.events.includes(k)),
    JSON.stringify(counts.totals));
  ok('the window defaults to 30 days', counts.windowDays === 30, String(counts.windowDays));
  ok('the series has a row per day, including the empty ones', counts.series.length === 30,
    String(counts.series.length));
  ok('today is the last row of the series',
    counts.series[29].date === new Date().toISOString().slice(0, 10), counts.series[29].date);
  ok('today carries the installs just recorded', counts.series[29].installed === 2);
  ok('the window is clamped to the retention period',
    (await (await admin('/api/stats?days=9999')).json()).windowDays === 180);

  // Run before the flood below, which deliberately fills the shop's minute:
  // anything counted after it would be dropped by design.
  function deviceEvent(type, platform) {
    return fetch(proxyUrl('/event?type=' + type + '&p=' + platform), { method: 'POST' });
  }

  await deviceEvent('installed', 'ios');
  await deviceEvent('installed', 'android');
  await deviceEvent('dismissed', 'ios');
  await deviceEvent('dismissed', 'desktop');
  await deviceEvent('installed', 'martian');

  const counted = await (await admin('/api/stats')).json();
  ok('dismissals are counted', counted.recent.dismissed === 2, String(counted.recent.dismissed));
  // The per-device breakdown is a paid feature, and this shop is still on the
  // free plan, so it is withheld here by design. It is asserted in the plans
  // section below, once the shop has been upgraded.

  // The ceiling is per shop, not per address: behind nginx every request comes
  // from 127.0.0.1, and behind Shopify's app proxy every legitimate storefront
  // event in the fleet shares a handful of edge addresses.
  const flood = [];
  for (let i = 0; i < 1400; i++) flood.push(event('shown'));
  await Promise.all(flood);

  const capped = await (await admin('/api/stats')).json();
  ok('a flood is capped rather than counted',
    capped.totals.shown > 1000 && capped.totals.shown <= 1202, String(capped.totals.shown));
  ok('the cap does not disturb the other counters',
    capped.totals.installed === 5 && capped.totals.launch === 1, JSON.stringify(capped.totals));

  // The storefront script has to be told where to send them, or nothing above
  // ever happens on a real store.
  res = await fetch(proxyUrl('/pwa.js'));
  const counting = await res.text();
  ok('pwa.js carries the event endpoint', counting.includes('"eventUrl":"/apps/pwa/event"'));
  ok('pwa.js counts installs off appinstalled', counting.includes("addEventListener('appinstalled'"));
  ok('pwa.js sends by beacon so an unloading page still counts',
    counting.includes('navigator.sendBeacon'));
  ok('pwa.js tags each beacon with a device family', counting.includes("'&p=' + encodeURIComponent(deviceFamily())"));

  console.log('\n== install message ==');

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      install: {
        title: 'Install our app!',
        benefits: ['Faster shopping', '  Exclusive discounts  ', '', 'Light on memory',
                   'Four', 'Five', 'Six is one too many'],
        buttonBackgroundColor: '#000000',
        buttonTextColor: '#ffffff',
      },
    }),
  });
  const withBenefits = await res.json();
  ok('benefits are stored', withBenefits.settings.install.benefits.length === 5,
    JSON.stringify(withBenefits.settings.install.benefits));
  ok('blank benefit lines are dropped, not stored as gaps',
    withBenefits.settings.install.benefits.indexOf('') === -1);
  ok('benefit text is trimmed',
    withBenefits.settings.install.benefits[1] === 'Exclusive discounts',
    withBenefits.settings.install.benefits[1]);
  ok('a sixth benefit is refused with a reason',
    withBenefits.warnings.some((warning) => warning.includes('benefits are kept')),
    JSON.stringify(withBenefits.warnings));

  res = await fetch(proxyUrl('/pwa.js'));
  const withCard = await res.text();
  ok('the storefront script carries the benefit lines', withCard.includes('"Exclusive discounts"'));
  ok('and the button colours it should paint',
    withCard.includes('"buttonBackgroundColor":"#000000"') && withCard.includes('"buttonTextColor":"#ffffff"'));

  // Blank means "follow the theme colour", and the pair has to be resolved
  // before it reaches a browser — a blank in the CSS would be no button at all.
  await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ themeColor: '#0b5fff', install: { buttonBackgroundColor: '', buttonTextColor: '' } }),
  });
  const themed = await (await fetch(proxyUrl('/pwa.js'))).text();
  ok('an unset button colour falls back to the theme colour',
    themed.includes('"buttonBackgroundColor":"#0b5fff"'), 'theme colour not applied');
  ok('and gets a label colour chosen for legibility',
    themed.includes('"buttonTextColor":"#ffffff"'), 'label colour not derived');

  console.log('\n== offline page ==');

  await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offline: { title: 'Oops! The connection has been lost.', message: 'Check your connectivity and try again.' },
    }),
  });

  const offlineHtml = await (await fetch(proxyUrl('/offline'))).text();
  ok('the offline page uses the merchant wording',
    offlineHtml.includes('Oops! The connection has been lost.') &&
    offlineHtml.includes('Check your connectivity and try again.'));

  const shellHtml = await (await fetch(proxyUrl('/'))).text();
  ok('and so does the launch shell, so the two never disagree',
    shellHtml.includes('Oops! The connection has been lost.'));

  const offlineSw = JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text())
    .match(/var CFG = (\{[\s\S]*?\});/)[1]);
  ok('the worker gets the same wording for its last-resort response',
    offlineSw.offlineText.includes('Oops! The connection has been lost.'));

  console.log('\n== cache assets ==');

  const beforeCache = (await (await admin('/api/settings')).json()).settings.serviceWorker.cacheVersion;

  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceWorker: {
        cache: { enabled: true, homePage: true, googleFonts: false, storefront: false, cssFiles: true, images: true },
        precache: {
          enabled: true,
          urls: [
            '/cdn/shop/t/1/assets/base.css',
            '//cdn.shopify.com/s/files/1/0085/assets/main.js',
            'https://fonts.googleapis.com/css2?family=Inter',
            'https://evil.example.com/tracker.js',
            'javascript:alert(1)',
          ],
        },
      },
    }),
  });
  const cached = await res.json();
  ok('cache rules are stored', cached.settings.serviceWorker.cache.googleFonts === false &&
    cached.settings.serviceWorker.cache.images === true);
  ok('storefront and Shopify CDN precache URLs are kept',
    cached.settings.serviceWorker.precache.urls.length === 3,
    JSON.stringify(cached.settings.serviceWorker.precache.urls));
  // The precache list is fetched by every first-time visitor's browser on this
  // app's say-so. A third-party URL in it would be this app making that request.
  ok('a third-party precache URL is refused',
    !cached.settings.serviceWorker.precache.urls.some((u) => u.includes('evil.example.com')),
    JSON.stringify(cached.settings.serviceWorker.precache.urls));
  ok('and so is a scheme that is not https',
    !cached.settings.serviceWorker.precache.urls.some((u) => u.startsWith('javascript:')));
  ok('the merchant is told what was dropped',
    cached.warnings.some((warning) => warning.includes('precache')), JSON.stringify(cached.warnings));
  ok('a protocol-relative URL is normalised to https',
    cached.settings.serviceWorker.precache.urls.includes('https://cdn.shopify.com/s/files/1/0085/assets/main.js'),
    JSON.stringify(cached.settings.serviceWorker.precache.urls));

  // A worker whose rules changed must not go on serving the cache built under
  // the old ones, and the only lever for that is the version in the cache name.
  ok('changing the cache rules bumps the cache version',
    cached.settings.serviceWorker.cacheVersion > beforeCache,
    beforeCache + ' -> ' + cached.settings.serviceWorker.cacheVersion);

  const swText = await (await fetch(proxyUrl('/sw.js'))).text();
  const swConfig = JSON.parse(swText.match(/var CFG = (\{[\s\S]*?\});/)[1]);
  ok('the worker is handed the cache rules', swConfig.cache.googleFonts === false);
  // The cache rules themselves are on every plan; the precache list is not, and
  // this shop is still on the free plan here. Both sides of that are asserted
  // in the plans section below — including that the list survives the wait.
  ok('the shell is still precached first, whatever else is on the list',
    swConfig.precache[0] === '/apps/pwa/', JSON.stringify(swConfig.precache));
  // addAll() is all-or-nothing, so one 404 in a merchant's pasted list would
  // leave the shell uncached too.
  ok('the worker precaches entries one at a time so one bad URL cannot block install',
    swText.includes('precacheOne(cache, url)'));

  // Switched off, the list must not be handed over at all — leaving it in and
  // relying on a flag would precache it anyway on the first install.
  await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceWorker: { precache: { enabled: false, urls: cached.settings.serviceWorker.precache.urls } },
    }),
  });
  const swOff = JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text())
    .match(/var CFG = (\{[\s\S]*?\});/)[1]);
  ok('a disabled precache list is not sent to the worker',
    !swOff.precache.some((u) => u.includes('base.css')), JSON.stringify(swOff.precache));

  console.log('\n== reports and setup ==');

  // Authentication is checked before the plan is, so these hold on any plan.
  // What the paid plan buys is asserted in the plans section below, which is
  // also where the report list itself is exercised — on a free shop these
  // routes answer 402 by design.
  ok('reports need a session token', (await fetch(BASE + '/api/reports')).status === 401);
  ok('the setup check needs a session token', (await fetch(BASE + '/api/setup')).status === 401);

  console.log('\n== plans and entitlements ==');

  ok('the plan needs a session token', (await fetch(BASE + '/api/plan')).status === 401);

  let planStatus = await (await admin('/api/plan')).json();
  ok('a new shop is on the free plan', planStatus.planId === 'free', planStatus.planId);
  ok('the free plan carries a monthly install allowance',
    planStatus.allowance.limited && planStatus.allowance.limit === 100,
    JSON.stringify(planStatus.allowance));
  ok('the free plan covers dashboard, settings and help',
    planStatus.sections.join(',') === 'dashboard,settings,help', planStatus.sections.join(','));
  ok('but not reports', planStatus.sections.indexOf('reports') === -1);
  ok('and not precaching', planStatus.features.indexOf('precache') === -1,
    JSON.stringify(planStatus.features));
  ok('all three plans are offered', planStatus.plans.length === 3,
    planStatus.plans.map((p) => p.id).join(','));
  ok('the paid plans are $5.99 monthly and $4.99 a month yearly',
    planStatus.plans[1].priceLabel === '$5.99' && planStatus.plans[2].perMonthLabel === '$4.99 / month',
    planStatus.plans.map((p) => p.priceLabel).join(' / '));
  ok('the yearly plan states its real yearly total',
    planStatus.plans[2].priceLabel === '$59.88', planStatus.plans[2].priceLabel);
  ok('and the saving is worked out, not typed',
    planStatus.plans[2].savingPercent === 17, String(planStatus.plans[2].savingPercent));
  ok('the upgrade link points at Shopify\'s own plan page',
    planStatus.upgradeUrl === 'https://admin.shopify.com/store/demo-store/charges/' +
      'proecomtech-storefront-pwa/pricing_plans', planStatus.upgradeUrl);
  // Without Partner credentials the app cannot re-check a plan with Shopify.
  // It has to say so rather than implying the answer is authoritative.
  ok('an unverified plan says so', planStatus.verified === false);

  // Reports are the paid section, and the server — not the admin — is what
  // enforces that. A gate the UI draws and the API does not is decorative.
  for (const [label, path, options] of [
    ['listing reports', '/api/reports', undefined],
    ['reading a report', '/api/reports/abc', undefined],
    ['generating a report', '/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['deleting a report', '/api/reports/abc', { method: 'DELETE' }],
  ]) {
    res = await admin(path, options);
    ok('the free plan is refused ' + label, res.status === 402, 'got ' + res.status);
  }

  const refusal = await (await admin('/api/reports')).json();
  ok('the refusal names the way out', Boolean(refusal.upgradeUrl) && refusal.section === 'reports',
    JSON.stringify(refusal));

  // The Home page is on every plan and reads this route, so it must answer —
  // minus the device split, which is what the Analytics page buys.
  const freeStats = await (await admin('/api/stats')).json();
  ok('the free plan still gets its install totals', typeof freeStats.totals.installed === 'number');
  ok('but not the device breakdown',
    freeStats.platformsWithheld === true && !freeStats.platformRecent,
    JSON.stringify(Object.keys(freeStats)));

  // The setup wizard is Help & Support, which every plan includes.
  ok('the quick setup wizard is not gated', (await admin('/api/setup')).status !== 402);

  /*
   * Precache is a paid control inside a free section, so it is enforced on the
   * save rather than on a route. The list itself is deliberately kept: a shop
   * that upgrades later should get its files back, not an empty box.
   */
  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceWorker: {
        precache: { enabled: true, urls: ['/cdn/shop/t/1/assets/base.css'] },
      },
    }),
  });
  const freePrecache = await res.json();
  ok('the free plan cannot switch precaching on',
    freePrecache.settings.serviceWorker.precache.enabled === false,
    JSON.stringify(freePrecache.settings.serviceWorker.precache));
  ok('but its file list is kept for when it upgrades',
    freePrecache.settings.serviceWorker.precache.urls.length === 1,
    JSON.stringify(freePrecache.settings.serviceWorker.precache.urls));
  ok('and the merchant is told why, not silently overruled',
    freePrecache.warnings.some((w) => w.includes('Precaching is on the paid plans')),
    JSON.stringify(freePrecache.warnings));

  const freeSw = JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text())
    .match(/var CFG = (\{[\s\S]*?\});/)[1]);
  ok('and the worker is never handed the list on a free plan',
    !freeSw.precache.some((u) => u.includes('base.css')), JSON.stringify(freeSw.precache));

  res = await admin('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planHandle: 'pro-annual' }),
  });
  planStatus = await res.json();
  ok('a plan handle from Shopify\'s redirect is claimed', planStatus.planId === 'annual', planStatus.planId);
  ok('the paid plan unlocks reports', planStatus.sections.indexOf('reports') !== -1);
  ok('and precaching', planStatus.features.indexOf('precache') !== -1,
    JSON.stringify(planStatus.features));
  ok('and removes the install cap', planStatus.allowance.limited === false,
    JSON.stringify(planStatus.allowance));

  // The list saved while the shop was on the free plan is still there, so
  // turning the switch on is all the merchant has to do.
  res = await admin('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceWorker: {
        precache: { enabled: true, urls: ['/cdn/shop/t/1/assets/base.css'] },
      },
    }),
  });
  ok('a paid plan can switch precaching on',
    (await res.json()).settings.serviceWorker.precache.enabled === true);

  const paidSw = JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text())
    .match(/var CFG = (\{[\s\S]*?\});/)[1]);
  ok('and the worker is handed the list',
    paidSw.precache.includes('/cdn/shop/t/1/assets/base.css'), JSON.stringify(paidSw.precache));

  /*
   * The downgrade. `enabled: true` is still on disk and nobody has to press
   * Save ever again, so the entitlement has to be read where the list is
   * served, not only where it was written.
   */
  await admin('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planHandle: 'free' }),
  });
  const downgradedSw = JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text())
    .match(/var CFG = (\{[\s\S]*?\});/)[1]);
  ok('a shop that downgrades stops being precached without touching its settings',
    !downgradedSw.precache.some((u) => u.includes('base.css')), JSON.stringify(downgradedSw.precache));
  ok('the app shell is still precached, whatever the plan',
    downgradedSw.precache[0] === '/apps/pwa/', JSON.stringify(downgradedSw.precache));
  ok('and the stored switch is untouched, so upgrading restores it without a re-save',
    (await (await admin('/api/settings')).json()).settings.serviceWorker.precache.enabled === true);

  await admin('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planHandle: 'pro-annual' }),
  });
  const restoredSw = JSON.parse((await (await fetch(proxyUrl('/sw.js'))).text())
    .match(/var CFG = (\{[\s\S]*?\});/)[1]);
  ok('upgrading again brings the list straight back',
    restoredSw.precache.includes('/cdn/shop/t/1/assets/base.css'), JSON.stringify(restoredSw.precache));

  res = await admin('/api/reports');
  const emptyReports = await res.json();
  ok('reports answer once the plan covers them', res.status === 200, 'got ' + res.status);
  ok('a store with no reports gets an empty list',
    Array.isArray(emptyReports.reports) && emptyReports.reports.length === 0);
  ok('an unknown report id is 404', (await admin('/api/reports/deadbeef')).status === 404);
  ok('deleting an unknown report is 404',
    (await admin('/api/reports/deadbeef', { method: 'DELETE' })).status === 404);

  // The device split, from the events recorded in the counters section above.
  const split = await (await admin('/api/stats')).json();
  ok('the device breakdown comes back on a paid plan', Boolean(split.platformRecent));
  ok('iOS installs are counted separately', split.platformRecent.ios.installed === 1,
    JSON.stringify(split.platformRecent.ios));
  ok('Android installs are counted separately', split.platformRecent.android.installed === 1);
  ok('dismissals are split by device too',
    split.platformRecent.ios.dismissed === 1 && split.platformRecent.desktop.dismissed === 1);
  // An open key space on a public endpoint is the thing not to have. The
  // device family arrives in a query string anyone can type, so "martian" must
  // collapse into the existing bucket rather than become a fifth one.
  ok('an unrecognised device family does not create a bucket',
    Object.keys(split.platformRecent).sort().join(',') === 'android,desktop,ios,other',
    Object.keys(split.platformRecent).join(','));
  ok('the device split adds up to the total',
    split.platformRecent.ios.installed + split.platformRecent.android.installed +
    split.platformRecent.desktop.installed + split.platformRecent.other.installed ===
    split.recent.installed, JSON.stringify(split.platformRecent));
  ok('all-time totals are split by device as well', split.platformTotals.ios.installed === 1);
  // Two earlier installs carried no device at all, and the third was the
  // unrecognised one. Counters with no device to attribute them to stay in
  // `other` — inventing one would be worse than admitting it.
  ok('events with no device, and unrecognised ones, both land in other',
    split.platformTotals.other.installed === 3, JSON.stringify(split.platformTotals.other));

  ok('a claim needs a session token',
    (await fetch(BASE + '/api/plan', { method: 'POST' })).status === 401);
  res = await admin('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planHandle: '../../etc/passwd' }),
  });
  ok('a plan handle that is not one is refused', res.status === 400, 'got ' + res.status);

  // A handle we do not recognise, on a shop that is being charged for
  // something. Falling back to Free would mean taking the money and locking
  // the merchant out; the paid tier is the safe direction to fail.
  await admin('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planHandle: 'some-legacy-plan' }),
  });
  ok('an unrecognised paid handle grants the paid tier rather than locking out',
    (await (await admin('/api/plan')).json()).sections.indexOf('reports') !== -1);

  console.log('\n== the free install cap ==');

  /*
   * Its own shop, for two reasons. The rate-limit ceiling is per shop and the
   * flood earlier in this file has already spent the first shop's minute, so
   * these installs would be dropped. And a plan is per shop — running this
   * beside a shop that has just been moved to a paid plan is the cheapest proof
   * that the two do not leak into each other.
   */
  const CAP_SHOP = 'cap-test.myshopify.com';
  const capEvent = (type) => fetch(
    proxyUrlFor(CAP_SHOP, '/event?type=' + type + '&p=android'), { method: 'POST' }
  );

  let cap = await (await adminFor(CAP_SHOP, '/api/plan')).json();
  ok('a second shop starts on its own free plan', cap.planId === 'free' && cap.allowance.used === 0,
    JSON.stringify(cap.allowance));
  ok('and is unaffected by the first shop\'s upgrade',
    (await (await admin('/api/plan')).json()).planId !== 'free');

  const allowed = await (await fetch(proxyUrlFor(CAP_SHOP, '/pwa.js'))).text();
  ok('an untouched free shop is told to offer the install card',
    allowed.includes('"enabled":true'));

  for (let i = 0; i < 40; i++) await capEvent('installed');
  cap = await (await adminFor(CAP_SHOP, '/api/plan')).json();
  ok('the allowance counts this month\'s installs',
    cap.allowance.used === 40 && cap.allowance.remaining === 60, JSON.stringify(cap.allowance));
  ok('and is not exhausted yet', cap.allowance.exhausted === false);

  for (let i = 0; i < 65; i++) await capEvent('installed');
  cap = await (await adminFor(CAP_SHOP, '/api/plan')).json();
  ok('the free allowance reports itself exhausted past 100',
    cap.allowance.exhausted === true, JSON.stringify(cap.allowance));
  // Installs from the browser's own menu keep arriving and keep counting, so
  // the figure is allowed to run past the ceiling rather than being clamped to
  // it. A merchant reading "105 of 100" is reading the truth.
  ok('and does not clamp the real number to the limit',
    cap.allowance.used === 105, JSON.stringify(cap.allowance));

  const cappedScript = await (await fetch(proxyUrlFor(CAP_SHOP, '/pwa.js'))).text();
  ok('the storefront stops being told to offer the install card',
    cappedScript.includes('"enabled":false'), 'install.enabled was not switched off');

  // The cap limits the app, not the store. A manifest switched to display:
  // browser would break the browser's own install menu and change how the app
  // looks for everyone who installed before the cap was reached.
  const cappedManifest = await (await fetch(proxyUrlFor(CAP_SHOP, '/manifest.json'))).json();
  ok('but the store is still installable by any other route',
    cappedManifest.display === 'standalone', cappedManifest.display);

  const cappedHealth = await (await fetch(proxyUrlFor(CAP_SHOP, '/health'))).json();
  ok('health says which plan and how much of the allowance is gone',
    cappedHealth.plan === 'free' && cappedHealth.installCardOffered === false &&
    /105 of 100 this month/.test(cappedHealth.installAllowance),
    JSON.stringify(cappedHealth.installAllowance));

  await adminFor(CAP_SHOP, '/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planHandle: 'pro-monthly' }),
  });
  const uncapped = await (await fetch(proxyUrlFor(CAP_SHOP, '/pwa.js'))).text();
  ok('upgrading puts the install card back', uncapped.includes('"enabled":true'));
  ok('and the allowance stops being a limit',
    (await (await adminFor(CAP_SHOP, '/api/plan')).json()).allowance.limited === false);

  console.log('\n== the admin screen ==');

  res = await fetch(BASE + '/?shop=' + SHOP);
  const adminHtml = await res.text();
  ok('the admin renders', res.status === 200, 'got ' + res.status);
  ok('it is framed only by this shop and the Shopify admin',
    (res.headers.get('content-security-policy') || '').includes('frame-ancestors https://' + SHOP));

  const ROUTES = ['home', 'configuration', 'install-message', 'cache-assets', 'offline-page',
                  'settings', 'reports', 'analytics', 'setup', 'faqs', 'plans'];
  for (const route of ROUTES) {
    ok('the admin carries the ' + route + ' page', adminHtml.includes('data-page="' + route + '"'));
  }
  ok('the sidebar links every page',
    adminHtml.split('data-route="').length - 1 === ROUTES.length,
    String(adminHtml.split('data-route="').length - 1) + ' links for ' + ROUTES.length + ' pages');
  // The padlock and the diversion to the plans page are drawn from these, so a
  // page with no section would silently be ungateable.
  ok('every sidebar link declares the plan section it needs',
    adminHtml.split('data-section="').length - 1 === ROUTES.length);
  ok('both report pages carry an upgrade panel for merchants on the free plan',
    adminHtml.includes('id="reportsLocked"') && adminHtml.includes('id="analyticsLocked"'));

  // The preview URL is built server-side because the client only ever learns
  // the shop from a signed token, which arrives after this markup is written.
  ok('the admin carries a storefront preview link for the install card',
    adminHtml.includes('data-preview="https://' + SHOP + '/?pwa-preview=1"') &&
    adminHtml.includes('id="previewLink"'));
  // Duplicate ids would make getElementById return whichever page came first,
  // and the save bar is on five of them.
  const adminIds = (adminHtml.match(/ id="[^"]+"/g) || []).map((s) => s.slice(5, -1));
  ok('no id is used twice across the ten pages',
    new Set(adminIds).size === adminIds.length, String(adminIds.length - new Set(adminIds).size) + ' duplicates');
  // Data arrives over /api/settings, never in the document. The only scripts
  // are App Bridge and /admin.js; an inline one would mean a merchant value had
  // been interpolated into the page.
  ok('the admin carries no inline script',
    (adminHtml.match(/<script/g) || []).length === 2 &&
    adminHtml.includes('cdn.shopify.com/shopifycloud/app-bridge.js') &&
    adminHtml.includes('src="/admin.js"'),
    String((adminHtml.match(/<script/g) || []).length) + ' script tags');

  res = await fetch(BASE + '/admin.js');
  const adminScript = await res.text();
  ok('the admin script is served', res.status === 200 && adminScript.length > 1000);
  ok('it carries no unsubstituted placeholders', !adminScript.includes('MAX_BENEFITS'));
  // A parse error here is a blank admin with nothing in the server log.
  ok('and it parses', (() => { try { new Function(adminScript); return true; } catch (e) { return false; } })());

  console.log('\n== uninstall webhook ==');

  const payload = Buffer.from(JSON.stringify({ shop_domain: SHOP }));
  res = await fetch(BASE + '/webhooks/app/uninstalled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': 'wrong', 'X-Shopify-Shop-Domain': SHOP },
    body: payload,
  });
  ok('a webhook with a bad HMAC is 401', res.status === 401, 'got ' + res.status);
  ok('settings survive a rejected webhook', fs.existsSync(path.join(DATA_DIR, 'shops', SHOP + '.json')));

  const hmac = crypto.createHmac('sha256', API_SECRET).update(payload).digest('base64');
  res = await fetch(BASE + '/webhooks/app/uninstalled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Shop-Domain': SHOP },
    body: payload,
  });
  ok('a valid uninstall webhook is 200', res.status === 200, 'got ' + res.status);
  ok('settings are deleted on uninstall',
    await eventually(() => !fs.existsSync(path.join(DATA_DIR, 'shops', SHOP + '.json'))));
  ok('uploaded assets are deleted on uninstall',
    await eventually(() => !fs.existsSync(path.join(DATA_DIR, 'assets', SHOP))));

  // Asserted through the API rather than off the disk: the counts are held in
  // memory between flushes, so a file that is absent proves nothing. What has
  // to be true is that the in-memory copy went with the file — otherwise the
  // next flush would write the departed merchant's counts straight back.
  const afterUninstall = await (await admin('/api/stats')).json();
  ok('install counts are deleted on uninstall',
    afterUninstall.totals.installed === 0 && afterUninstall.lastEventAt === null,
    JSON.stringify(afterUninstall.totals));
  ok('the stats file is gone too',
    await eventually(() => !fs.existsSync(path.join(DATA_DIR, 'stats', SHOP + '.json'))));

  // Shopify cancels the subscription on uninstall. Keeping the plan record
  // would mean a merchant reinstalling next year arrived already entitled to a
  // plan they had stopped paying for.
  ok('the plan record is deleted on uninstall',
    await eventually(() => !fs.existsSync(path.join(DATA_DIR, 'plans', SHOP + '.json'))));
  ok('and a reinstalled shop is back on the free plan',
    (await (await admin('/api/plan')).json()).planId === 'free');
  // The other shop's data is untouched by this shop's uninstall.
  ok('another shop keeps its plan',
    (await (await adminFor('cap-test.myshopify.com', '/api/plan')).json()).planId === 'monthly');

  console.log('\n== compliance webhooks ==');

  // Posted the way Shopify posts them: topic in a header, one route for all three.
  const compliance = (topic, hmacValue) => {
    const raw = Buffer.from(JSON.stringify({ shop_domain: 'cap-test.myshopify.com', topic }));
    return fetch(BASE + '/webhooks/compliance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': hmacValue === undefined
          ? crypto.createHmac('sha256', API_SECRET).update(raw).digest('base64')
          : hmacValue,
        'X-Shopify-Shop-Domain': 'cap-test.myshopify.com',
        'X-Shopify-Topic': topic,
      },
      body: raw,
    });
  };

  // This loop is the automated review check reproduced: a wrong signature has to
  // be rejected on every compliance topic, not only on the one that deletes.
  for (const topic of ['customers/data_request', 'customers/redact', 'shop/redact']) {
    res = await compliance(topic, 'wrong');
    ok(topic + ' with a bad HMAC is 401', res.status === 401, 'got ' + res.status);
  }
  ok('and a rejected shop/redact deletes nothing',
    fs.existsSync(path.join(DATA_DIR, 'plans', 'cap-test.myshopify.com.json')));

  res = await compliance('customers/data_request');
  const dataRequest = await res.json();
  ok('a valid customers/data_request is 200', res.status === 200, 'got ' + res.status);
  ok('and reports that no customer data is held', dataRequest.customer_data_stored === false);

  res = await compliance('customers/redact');
  ok('a valid customers/redact is 200', res.status === 200, 'got ' + res.status);
  // The redact topics are about customers; the shop's own records stay put.
  ok('and leaves the shop own records alone',
    fs.existsSync(path.join(DATA_DIR, 'plans', 'cap-test.myshopify.com.json')));

  res = await compliance('shop/redact');
  ok('a valid shop/redact is 200', res.status === 200, 'got ' + res.status);
  ok('and erases that shop',
    await eventually(() =>
      !fs.existsSync(path.join(DATA_DIR, 'plans', 'cap-test.myshopify.com.json')) &&
      !fs.existsSync(path.join(DATA_DIR, 'shops', 'cap-test.myshopify.com.json'))));

  // Shopify retries a non-2xx for 48 hours, so a shop that is already gone — the
  // normal case, since app/uninstalled ran 48 hours earlier — is still a 200.
  res = await compliance('shop/redact');
  ok('a repeat shop/redact is still 200', res.status === 200, 'got ' + res.status);

  console.log('\n== storefront diagnosis ==');

  // In-process, because what is being tested is a pure classifier and standing
  // up a fake Shopify storefront to reach it through generate() would test the
  // fake. DATA_DIR is set first so requiring the module does not create a
  // reports directory inside the repo.
  process.env.DATA_DIR = DATA_DIR;
  const reportsModule = require(path.join(APP, 'web', 'reports.js'));
  const MANIFEST_URL = 'https://' + SHOP + '/apps/pwa/manifest.json';
  const diagnose = (res, body) => reportsModule.explainManifestFailure(res, body, MANIFEST_URL);

  // A locked store answers 200 with the password page, which is why "not valid
  // JSON" used to be all a merchant was told — the status code says nothing is
  // wrong and the body is a login form.
  const locked = diagnose({ status: 200, ok: true, url: MANIFEST_URL },
    '<!doctype html><html><body class="template-password"></body></html>');
  ok('a password page is named as one, not as bad JSON',
    /password protected/i.test(locked) && /Online Store > Preferences/.test(locked), locked);

  ok('a redirect to /password counts too',
    /password protected/i.test(diagnose({ status: 200, ok: true, url: 'https://' + SHOP + '/password' },
      '<!doctype html><html></html>')));

  // Shopify's own 404 page, verbatim markers from a real response.
  const missing = diagnose({ status: 404, ok: false, url: MANIFEST_URL },
    '<!DOCTYPE html>\n<html class="shop-404" lang="en">');
  ok('Shopify\'s 404 page is reported as the proxy not routing',
    /app proxy is not routing/.test(missing), missing);

  // Any other HTML is the theme, which means the same thing and needs saying
  // differently — there is no 404 to point at.
  const themePage = diagnose({ status: 200, ok: true, url: MANIFEST_URL },
    '<!doctype html><html><body>a theme page</body></html>');
  ok('a theme page is reported as the proxy not routing',
    /web page rather than the manifest/.test(themePage) && /app proxy/.test(themePage), themePage);

  // The original message survives for the case it was actually about.
  ok('genuinely broken JSON still reads as broken JSON',
    /not with valid JSON/.test(diagnose({ status: 200, ok: true, url: MANIFEST_URL }, '{"name":')));

  // Four distinct causes must not collapse into one sentence again.
  ok('the four causes give four different answers',
    new Set([locked, missing, themePage]).size === 3);
}

const server = spawn(process.execPath, ['web/server.js'], {
  cwd: APP,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR,
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    PWA_VERIFY_PROXY: 'false',
    NODE_ENV: 'test',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer(attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  try {
    if (!(await waitForServer(40))) throw new Error('server did not start\n' + serverLog);
    await run();
  } catch (err) {
    failures.push('threw: ' + err.message);
    console.error(err);
  } finally {
    server.kill();
    console.log('\n--- server log ---\n' + serverLog.trim());
    console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) failures.forEach((f) => console.log('  FAILED: ' + f));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(failures.length ? 1 : 0);
  }
})();
