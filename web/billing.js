/**
 * Which plan each shop is on.
 *
 * Billing itself is Shopify App Pricing (formerly Managed Pricing): the three
 * plans are defined in the Partner dashboard, the merchant subscribes on a page
 * Shopify hosts, and this app creates no charges, sees no card and — the part
 * that matters here — needs no Admin API scopes. That is what lets the billing
 * story fit an app with no OAuth flow and no stored access token.
 *
 * WHERE THE PLAN COMES FROM
 * ----------------------------------------------------------------------
 * Shopify App Pricing does not send webhooks for subscription changes; the
 * APP_SUBSCRIPTIONS_UPDATE topic was deprecated in April 2026. Two signals are
 * left, and this module uses both:
 *
 *   1. The redirect.  When a merchant finishes subscribing, Shopify sends them
 *      back to the app with `plan_handle` and `shop` on the URL. The admin
 *      passes that handle to POST /api/plan, which is behind a session token —
 *      so a plan is claimed by an authenticated merchant for their own shop,
 *      not by an anonymous GET. This covers every change made through the app.
 *
 *   2. The Partner API.  `activeSubscription(appId, shopId)` is the only way to
 *      see a change made outside the app — a cancellation from the merchant's
 *      Apps and sales channels settings, a freeze for non-payment. It needs
 *      Partner org credentials, so it is optional and off until configured.
 *
 * WITH RECONCILIATION OFF, THE RECORDED PLAN STANDS. That is a deliberate,
 * stated trade-off rather than an oversight: signal 1 is merchant-authenticated
 * but not cryptographically bound to a real subscription, so a merchant who
 * wanted the reports page badly enough could claim a handle they never paid
 * for. Configure the Partner credentials and reconcile() overrides them within
 * the hour. See "Billing" in the README.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const settingsStore = require('./settings.js');
const plans = require('./plans.js');

const PLANS_DIR = path.join(settingsStore.DATA_DIR, 'plans');

fs.mkdirSync(PLANS_DIR, { recursive: true });

/** The app's handle, as it appears in the Shopify App Pricing URL. Matches
 *  `handle` in shopify.app.toml; env-overridable so a fork does not have to
 *  patch code to point at its own listing. */
const APP_HANDLE = process.env.PWA_APP_HANDLE || 'proecomtech-storefront-pwa';

/* --------------------------------------------------- Partner API (optional) */

const PARTNER_ORG_ID = process.env.SHOPIFY_PARTNER_ORG_ID || '';
const PARTNER_TOKEN = process.env.SHOPIFY_PARTNER_API_TOKEN || '';
const PARTNER_APP_ID = process.env.SHOPIFY_PARTNER_APP_ID || '';
const PARTNER_API_VERSION = process.env.SHOPIFY_PARTNER_API_VERSION || '2026-07';

const PARTNER_CONFIGURED = Boolean(PARTNER_ORG_ID && PARTNER_TOKEN && PARTNER_APP_ID);

/** How long a reconciled answer is trusted before the Partner API is asked
 *  again. An hour: a cancellation that takes up to an hour to bite is a fair
 *  trade for not calling someone else's API on every admin page load. */
const RECONCILE_TTL_MS = 3600000;

const PARTNER_TIMEOUT_MS = 10000;

/* ------------------------------------------------------------------ storage */

/** shop -> record. Loaded lazily and kept, because the storefront's /pwa.js
 *  route reads the plan on every request and must not hit the disk for it. */
const cache = new Map();

/** shop -> promise, so ten admin page loads do not make ten Partner calls. */
const reconciling = new Map();

function planFile(shop) {
  return path.join(PLANS_DIR, path.basename(shop.toLowerCase()) + '.json');
}

function blank(shop) {
  return {
    version: 1,
    shop: shop || null,
    planId: 'free',
    planHandle: null,
    // How we came to believe this. Surfaced in the admin so a merchant and a
    // support engineer are looking at the same fact.
    source: 'default',
    claimedAt: null,
    verifiedAt: null,
    shopGid: null,
    cancelAtEndOfCycle: false,
    trialEndsAt: null,
    // Every change, oldest first, capped. A plan dispute is the one support
    // question where "what did it say last week" is the whole answer.
    history: [],
  };
}

const MAX_HISTORY = 20;

function hydrate(shop, stored) {
  const base = blank(shop);
  const record = { ...base, ...(stored || {}), shop };
  record.history = Array.isArray(record.history) ? record.history.slice(-MAX_HISTORY) : [];
  // The stored id is re-resolved rather than trusted: plan ids can be retired
  // between releases, and byId falls back to free for one it does not know.
  record.planId = plans.byId(record.planId).id;
  return record;
}

function load(shop) {
  const hit = cache.get(shop);
  if (hit) return hit;

  let record;
  try {
    record = hydrate(shop, JSON.parse(fs.readFileSync(planFile(shop), 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('plan read failed for ' + shop + ':', err.message);
    record = blank(shop);
  }

  cache.set(shop, record);
  return record;
}

function persist(shop, record) {
  const target = planFile(shop);
  const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  cache.set(shop, record);
  return record;
}

/** The shop's plan record. Never throws and never returns null — an unknown
 *  shop is on Free, which is the safe half of every decision here. */
function read(shop) {
  if (!settingsStore.isValidShop(shop)) return blank(shop);
  return load(shop);
}

function planFor(shop) {
  return plans.byId(read(shop).planId);
}

/**
 * Record a plan.
 *
 * A no-op when nothing moved, so a merchant reopening the admin does not write
 * a file and a history entry on every page load.
 */
function set(shop, planId, source, extra) {
  if (!settingsStore.isValidShop(shop)) throw new Error('invalid shop');

  const current = load(shop);
  const plan = plans.byId(planId);
  const now = new Date().toISOString();

  const changed = current.planId !== plan.id;
  const record = {
    ...current,
    ...(extra || {}),
    planId: plan.id,
    planHandle: plan.handle,
    source,
    claimedAt: changed ? now : (current.claimedAt || now),
  };

  if (changed) {
    record.history = current.history.concat([{ at: now, from: current.planId, to: plan.id, source }])
      .slice(-MAX_HISTORY);
    console.log('plan change for ' + shop + ': ' + current.planId + ' -> ' + plan.id + ' (' + source + ')');
  }

  return persist(shop, record);
}

/**
 * Claim the plan handle Shopify put on the redirect back from its pricing page.
 *
 * Reached only from a session-authenticated route, with the shop taken from the
 * token rather than from the request — so one merchant can never claim a plan
 * for another's shop, which is the half of this that can be enforced without
 * the Partner API.
 */
function claimHandle(shop, handle) {
  const plan = plans.resolve(handle);
  return set(shop, plan.id, 'shopify-redirect', { planHandle: String(handle || '').toLowerCase() });
}

/** Called on app/uninstalled, alongside the settings, asset, stats and report
 *  deletes. The cache entry goes first or the next write would restore it. */
function remove(shop) {
  if (!settingsStore.isValidShop(shop)) return;
  cache.delete(shop);
  reconciling.delete(shop);
  try {
    fs.rmSync(planFile(shop), { force: true });
  } catch (err) {
    console.error('plan delete failed for ' + shop + ':', err.message);
  }
}

/* -------------------------------------------------------------- entitlements */

/** Where a merchant goes to subscribe, change plan or cancel. Shopify hosts
 *  it; the app only has to get the URL right and open it in the top frame. */
function pricingUrl(shop) {
  const handle = String(shop || '').replace(/\.myshopify\.com$/i, '');
  return 'https://admin.shopify.com/store/' + handle + '/charges/' + APP_HANDLE + '/pricing_plans';
}

/**
 * Everything the admin and the storefront routes need to make a decision, in
 * one object, so no caller has to combine a plan with a counter itself and
 * risk doing it differently from the next caller.
 */
function statusFor(shop, installsThisMonth) {
  const record = read(shop);
  const plan = plans.byId(record.planId);

  return {
    planId: plan.id,
    planName: plan.name,
    planHandle: plan.handle,
    priceLabel: plan.priceLabel,
    perMonthLabel: plan.perMonthLabel,
    interval: plan.interval,
    sections: plan.sections,
    features: plan.features,
    source: record.source,
    verifiedAt: record.verifiedAt,
    // Whether the answer above is one the Partner API confirmed, or one this
    // app was told. The admin says which; see the Billing note in the README.
    verified: Boolean(record.verifiedAt),
    reconciliationConfigured: PARTNER_CONFIGURED,
    cancelAtEndOfCycle: Boolean(record.cancelAtEndOfCycle),
    trialEndsAt: record.trialEndsAt || null,
    allowance: plans.allowanceFor(plan.id, installsThisMonth),
    upgradeUrl: pricingUrl(shop),
    plans: plans.publicTable(plan.id),
  };
}

function can(shop, section) {
  return plans.can(read(shop).planId, section);
}

/** Whether the shop's plan includes an individual control, such as precache. */
function has(shop, feature) {
  return plans.has(read(shop).planId, feature);
}

/* ---------------------------------------------------- Partner reconciliation */

async function partnerQuery(query, variables) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARTNER_TIMEOUT_MS);

  try {
    const res = await fetch(
      'https://partners.shopify.com/' + PARTNER_ORG_ID + '/api/' + PARTNER_API_VERSION + '/graphql.json',
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': PARTNER_TOKEN },
        body: JSON.stringify({ query, variables }),
      }
    );

    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error('Partner API HTTP ' + res.status);
    if (body && body.errors && body.errors.length) {
      throw new Error(body.errors.map((e) => e.message).join('; '));
    }
    return (body && body.data) || {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The shop's Partner-side id, which activeSubscription needs and this app has
 * no other way to learn — it holds no Admin API token, and neither the session
 * token nor an app proxy request carries a shop id.
 *
 * Found through the transactions feed, which can be filtered by myshopify
 * domain and returns the shop node. A shop with no transactions cannot be a
 * paying shop, so a miss here is itself an answer, and the caller treats it as
 * one. Cached on the record once found: a shop's id never changes.
 */
const SHOP_GID_QUERY = `
  query ShopGid($domain: String!) {
    transactions(first: 1, shopMyshopifyDomain: $domain) {
      edges { node { ... on AppSubscriptionSale { shop { id myshopifyDomain } } } }
    }
  }
`;

const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      cancelAtEndOfCycle
      trialEndsAt
      items { handle description }
    }
  }
`;

async function shopGidFor(shop, record) {
  if (record.shopGid) return record.shopGid;

  const data = await partnerQuery(SHOP_GID_QUERY, { domain: shop });
  const edges = (data.transactions && data.transactions.edges) || [];
  for (const edge of edges) {
    const gid = edge && edge.node && edge.node.shop && edge.node.shop.id;
    if (gid) return gid;
  }
  return null;
}

/**
 * Ask Shopify what this shop is actually subscribed to, and make the record
 * agree.
 *
 * Every failure is non-fatal and leaves the recorded plan alone. The reasoning
 * is the same one that puts an unrecognised handle on the paid tier: a Partner
 * API outage must not downgrade paying merchants in a batch.
 *
 * A shop with no transactions and no active subscription is moved to Free —
 * that is the one downgrade path, and it is the case this whole function
 * exists for.
 */
async function reconcile(shop, options) {
  if (!PARTNER_CONFIGURED || !settingsStore.isValidShop(shop)) return read(shop);

  const record = load(shop);
  const force = Boolean(options && options.force);

  if (!force && record.verifiedAt && Date.now() - Date.parse(record.verifiedAt) < RECONCILE_TTL_MS) {
    return record;
  }

  const running = reconciling.get(shop);
  if (running) return running;

  const run = (async () => {
    const gid = await shopGidFor(shop, record);

    if (!gid) {
      // No transactions ever, so no subscription ever. Recording the check is
      // what stops this being repeated on every page load for every free shop.
      return set(shop, 'free', 'partner-api', {
        verifiedAt: new Date().toISOString(),
        cancelAtEndOfCycle: false,
        trialEndsAt: null,
      });
    }

    const data = await partnerQuery(ACTIVE_SUBSCRIPTION_QUERY, {
      appId: 'gid://shopify/App/' + PARTNER_APP_ID,
      shopId: gid,
    });

    const active = data.activeSubscription;
    const item = active && Array.isArray(active.items) ? active.items[0] : null;
    const plan = active ? plans.resolve(item && item.handle) : plans.byId('free');

    return set(shop, plan.id, 'partner-api', {
      shopGid: gid,
      planHandle: (item && item.handle) || plan.handle,
      verifiedAt: new Date().toISOString(),
      cancelAtEndOfCycle: Boolean(active && active.cancelAtEndOfCycle),
      trialEndsAt: (active && active.trialEndsAt) || null,
    });
  })()
    .catch((err) => {
      console.error('plan reconciliation failed for ' + shop + ':', err.message);
      return load(shop);
    })
    .finally(() => {
      reconciling.delete(shop);
    });

  reconciling.set(shop, run);
  return run;
}

module.exports = {
  APP_HANDLE,
  PARTNER_CONFIGURED,
  PLANS_DIR,
  RECONCILE_TTL_MS,
  can,
  claimHandle,
  has,
  planFor,
  pricingUrl,
  read,
  reconcile,
  remove,
  set,
  statusFor,
};
