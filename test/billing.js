/**
 * Plan changes against a stubbed Shopify.
 *
 * The smoke test runs the real server, whose live plan check always fails there
 * (no real store behind it), so it never sees what Shopify reports after a
 * downgrade. This loads billing.js in-process with the Admin API stubbed, which
 * is the only way to reproduce "switched to Free, still on Pro".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-billing-'));

const shopifyAdmin = require('../web/shopify-admin.js');
const plans = require('../web/plans.js');
const billing = require('../web/billing.js');

let failed = 0;
let passed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + label);
  } else {
    failed++;
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

/** What the stubbed Admin API reports as the shop's active subscriptions. */
let reported = [];
shopifyAdmin.activeSubscriptions = async () => reported;

const SHOP = 'downgrade-test.myshopify.com';
const HOUR = 3600000;

function sub(name, amount, createdAt, interval) {
  return {
    id: 'gid://shopify/AppSubscription/1',
    name,
    status: 'ACTIVE',
    test: true,
    trialDays: 0,
    createdAt,
    currentPeriodEnd: null,
    interval: interval || 'EVERY_30_DAYS',
    price: { amount: String(amount), currencyCode: 'USD' },
  };
}

(async () => {
  console.log('\n== handles and subscriptions that mean Free ==');
  ok('the configured free handle is Free', plans.resolve(plans.byId('free').handle).id === 'free');
  ok('a near-miss free handle is Free, not Monthly', plans.resolve('free-plan').id === 'free');
  ok('so is one with an underscore', plans.resolve('basic_free').id === 'free');
  ok('an unknown paid handle is still Monthly', plans.resolve('pro-mystery').id === 'monthly');
  ok('a $0 paid plan is not Free (dev stores and discounts read $0)',
    plans.fromSubscription(sub('Premium', '0.00', new Date().toISOString(), 'ANNUAL')).id === 'annual');
  ok('a subscription named Free is Free', plans.fromSubscription(sub('Free', '0.00', new Date().toISOString())).id === 'free');
  ok('a paid subscription is still paid', plans.fromSubscription(sub('Pro', 5.99, new Date().toISOString())).id === 'monthly');
  ok('a paid plan that mentions a free trial is still paid',
    plans.fromSubscription(sub('Pro Monthly - 7 day free trial', 5.99, new Date().toISOString())).id === 'monthly');

  console.log('\n== downgrade while Shopify still lists the old plan ==');
  const paidSince = new Date(Date.now() - 10 * 24 * HOUR).toISOString();
  reported = [sub('Pro Monthly', 5.99, paidSince)];

  billing.claimHandle(SHOP, 'pro-monthly');
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('the shop starts on Pro', billing.read(SHOP).planId === 'monthly', billing.read(SHOP).planId);

  // What POST /api/plan does with ?plan_handle=free: claim, then a forced
  // live check that still sees the subscription being wound down.
  billing.claimHandle(SHOP, 'free');
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('choosing Free sticks, even though the old plan is still reported',
    billing.read(SHOP).planId === 'free', billing.read(SHOP).planId);

  await billing.syncLive(SHOP, 'token', { force: true });
  ok('and survives the next admin load', billing.read(SHOP).planId === 'free', billing.read(SHOP).planId);

  reported = [];
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('once Shopify drops the old plan, the shop is still Free', billing.read(SHOP).planId === 'free');
  ok('and the downgrade guard is cleared', billing.read(SHOP).downgradedAt === null);

  console.log('\n== upgrading again after a downgrade ==');
  // As POST /api/plan does it: the claim, then a check that still sees the
  // old plan, then later a different subscription the merchant bought.
  reported = [sub('Pro Monthly', 5.99, paidSince)];
  billing.claimHandle(SHOP, 'free');
  await billing.syncLive(SHOP, 'token', { force: true });
  const annual = sub('Pro Annual', 59.88, new Date().toISOString(), 'ANNUAL');
  annual.id = 'gid://shopify/AppSubscription/3';
  reported = [annual];
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('a subscription bought after the downgrade is honoured',
    billing.read(SHOP).planId === 'annual', billing.read(SHOP).planId);

  console.log('\n== upgrading with no plan_handle on the way back ==');
  // Only the live check sees the upgrade; nothing clears the guard first.
  reported = [sub('Pro Monthly', 5.99, paidSince)];
  billing.claimHandle(SHOP, 'free');
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('the downgrade pins the old subscription', billing.read(SHOP).leftSubscriptionId === reported[0].id,
    billing.read(SHOP).leftSubscriptionId);
  const fresh = sub('Pro Monthly', 5.99, new Date(Date.now() - 30000).toISOString());
  fresh.id = 'gid://shopify/AppSubscription/2';
  reported = [fresh];
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('a new subscription upgrades the shop, even with Shopify\'s clock behind ours',
    billing.read(SHOP).planId === 'monthly', billing.read(SHOP).planId);
  ok('and the guard is gone', billing.read(SHOP).downgradedAt === null && billing.read(SHOP).leftSubscriptionId === null);

  console.log('\n== Shopify reactivates the plan they left ==');
  billing.claimHandle(SHOP, 'free');
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('downgraded while the old plan is listed', billing.read(SHOP).planId === 'free', billing.read(SHOP).planId);
  // Same subscription id comes back, but the redirect says they chose Pro.
  billing.claimHandle(SHOP, 'pro-monthly');
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('choosing Pro again on Shopify\'s page upgrades the shop',
    billing.read(SHOP).planId === 'monthly', billing.read(SHOP).planId);

  console.log('\n== Shopify records Free as a $0 subscription ==');
  billing.claimHandle(SHOP, 'pro-monthly');
  reported = [sub('Free', '0.00', new Date().toISOString())];
  await billing.syncLive(SHOP, 'token', { force: true });
  ok('a live $0 subscription moves the shop to Free', billing.read(SHOP).planId === 'free', billing.read(SHOP).planId);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
