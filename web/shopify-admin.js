/**
 * The one Admin API question this app asks: what is this shop subscribed to?
 *
 * The app has no scopes and no OAuth flow, but it does not need either for
 * this. Token exchange turns the App Bridge session token the admin already
 * sends into an Admin API access token, and `currentAppInstallation` needs no
 * scopes at all — an app may always read its own installation. So the plan the
 * admin shows can come from Shopify itself, on every load, rather than from
 * whatever the last pricing-page redirect said.
 *
 * The access token is held in memory and nowhere else. Losing it on a restart
 * costs one exchange on the next admin load; writing it to disk would make this
 * app a holder of credentials, which the rest of it carefully is not.
 *
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
 */

const API_KEY = process.env.SHOPIFY_API_KEY || '';
const API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-07';

const TIMEOUT_MS = 10000;

/** shop -> { token, expiresAt }. expiresAt is null for a non-expiring token. */
const tokens = new Map();

/** Refresh this long before Shopify says the token expires. */
const EXPIRY_MARGIN_MS = 60000;

async function post(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Shopify did not answer in time' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shopify's own words for a refusal. A bare status code tells nobody whether
 * the problem is the token, the app's configuration or the store, and the body
 * almost always says which.
 */
function reason(res) {
  const errors = res.json && res.json.errors;
  if (Array.isArray(errors)) return errors.map((e) => (e && e.message) || String(e)).join('; ');
  if (errors && typeof errors === 'object') return JSON.stringify(errors);
  if (errors) return String(errors);
  return String(res.text || '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'no details given';
}

/** Swap a verified session token for an offline Admin API token. */
async function exchange(shop, sessionToken) {
  if (!API_KEY || !API_SECRET) throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET must both be set');
  if (!sessionToken) throw new Error('no session token to exchange');

  const res = await post('https://' + shop + '/admin/oauth/access_token', {}, {
    client_id: API_KEY,
    client_secret: API_SECRET,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: sessionToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    // The Admin API refuses non-expiring offline tokens outright (HTTP 403).
    // An expiring one comes with a refresh token, which this app ignores: every
    // caller has a fresh session token, so an expired access token is simply
    // exchanged again.
    expiring: '1',
  });

  const token = res.json && res.json.access_token;
  if (!res.ok || !token) {
    const reason = (res.json && (res.json.error_description || res.json.error)) || 'HTTP ' + res.status;
    throw new Error('token exchange failed: ' + reason);
  }

  const entry = {
    token,
    expiresAt: res.json.expires_in ? Date.now() + Number(res.json.expires_in) * 1000 : null,
  };
  tokens.set(shop, entry);
  return entry.token;
}

async function tokenFor(shop, sessionToken) {
  const hit = tokens.get(shop);
  if (hit && (hit.expiresAt === null || hit.expiresAt - EXPIRY_MARGIN_MS > Date.now())) return hit.token;
  return exchange(shop, sessionToken);
}

async function graphql(shop, sessionToken, query, variables) {
  const url = 'https://' + shop + '/admin/api/' + ADMIN_API_VERSION + '/graphql.json';

  let token = await tokenFor(shop, sessionToken);
  let res = await post(url, { 'X-Shopify-Access-Token': token }, { query, variables });

  // A token revoked by an uninstall and reinstall, expired early, or — a 403 —
  // one cached before a change in what Shopify accepts. One fresh exchange,
  // then give up rather than loop.
  if (res.status === 401 || res.status === 403) {
    tokens.delete(shop);
    token = await exchange(shop, sessionToken);
    res = await post(url, { 'X-Shopify-Access-Token': token }, { query, variables });
  }

  if (!res.ok) throw new Error('Admin API HTTP ' + res.status + ': ' + reason(res));
  if (res.json && res.json.errors && res.json.errors.length) {
    throw new Error(res.json.errors.map((e) => e.message).join('; '));
  }
  return (res.json && res.json.data) || {};
}

const ACTIVE_SUBSCRIPTIONS_QUERY = `
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        trialDays
        createdAt
        currentPeriodEnd
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                interval
                price { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The shop's active subscriptions to this app, newest first, flattened to the
 * fields the plan logic reads. An empty array means the shop is on no paid plan.
 */
async function activeSubscriptions(shop, sessionToken) {
  const data = await graphql(shop, sessionToken, ACTIVE_SUBSCRIPTIONS_QUERY, {});
  const list = (data.currentAppInstallation && data.currentAppInstallation.activeSubscriptions) || [];

  return list
    .map((sub) => {
      const recurring = (sub.lineItems || [])
        .map((item) => item && item.plan && item.plan.pricingDetails)
        .find((details) => details && details.__typename === 'AppRecurringPricing');

      return {
        id: sub.id,
        name: sub.name || '',
        status: sub.status,
        test: Boolean(sub.test),
        trialDays: sub.trialDays || 0,
        createdAt: sub.createdAt || null,
        currentPeriodEnd: sub.currentPeriodEnd || null,
        interval: recurring ? recurring.interval : null,
        price: recurring && recurring.price ? recurring.price : null,
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Called on app/uninstalled: the token died with the installation. */
function forget(shop) {
  tokens.delete(shop);
}

module.exports = {
  ADMIN_API_VERSION,
  activeSubscriptions,
  forget,
};
