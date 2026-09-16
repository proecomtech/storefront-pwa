/**
 * The three plans, and what each one buys.
 *
 * Prices and plan names are defined in the Partner dashboard under Shopify App
 * Pricing — this app creates no charges in code and never sees a card. What
 * lives here is the other half: the handle Shopify gives each plan, so a
 * subscription can be matched to an entitlement, and the entitlement itself.
 *
 * The handles must match what is configured in the Partner dashboard. They are
 * env-overridable because a handle is typed into a dashboard by a human and the
 * spelling is not this file's to decide — see PWA_PLAN_HANDLE_* in
 * .env.example. Get one wrong and a paying merchant is matched to no plan,
 * which is why unmatched-but-paying falls to the paid tier rather than to Free:
 * see resolve().
 */

/**
 * The four navigation groups, as the admin renders them.
 *
 * `reports` is the only one a plan can withhold. The other three are what the
 * app is for — a merchant on the free plan can still configure the whole PWA,
 * and locking configuration behind a price would leave them with a broken
 * storefront rather than a reduced one.
 */
const SECTIONS = ['dashboard', 'settings', 'reports', 'help'];

const FREE_SECTIONS = ['dashboard', 'settings', 'help'];
const PAID_SECTIONS = ['dashboard', 'settings', 'reports', 'help'];

/**
 * How many installs the free plan covers in a UTC calendar month.
 *
 * It caps the app's own install card, not the browser's install menu — see
 * allowanceFor. A cap that could stop a customer installing a store they had
 * already found their own way to install would be the app sabotaging the
 * merchant, not limiting itself.
 */
const FREE_INSTALLS_PER_MONTH = 100;

function handleFor(key, fallback) {
  const value = process.env['PWA_PLAN_HANDLE_' + key];
  return (typeof value === 'string' && value.trim()) ? value.trim().toLowerCase() : fallback;
}

const PLANS = [
  {
    id: 'free',
    handle: handleFor('FREE', 'free'),
    name: 'Free',
    // Cents, not floats. Two of these prices are exact in binary and one is
    // not, and a plan table is not the place to find out which.
    priceCents: 0,
    interval: null,
    perMonthCents: 0,
    priceLabel: 'Free',
    perMonthLabel: 'Free',
    billingNote: 'No card, no expiry.',
    installsPerMonth: FREE_INSTALLS_PER_MONTH,
    sections: FREE_SECTIONS,
  },
  {
    id: 'monthly',
    handle: handleFor('MONTHLY', 'pro-monthly'),
    name: 'Pro',
    priceCents: 599,
    interval: 'month',
    perMonthCents: 599,
    priceLabel: '$5.99',
    perMonthLabel: '$5.99 / month',
    billingNote: 'Billed monthly. Cancel any time.',
    installsPerMonth: null,
    sections: PAID_SECTIONS,
  },
  {
    id: 'annual',
    handle: handleFor('ANNUAL', 'pro-annual'),
    name: 'Pro, yearly',
    // 4.99 x 12. Stated as the yearly total as well as the monthly rate,
    // because the yearly total is what actually leaves the merchant's account.
    priceCents: 5988,
    interval: 'year',
    perMonthCents: 499,
    priceLabel: '$59.88',
    perMonthLabel: '$4.99 / month',
    billingNote: 'Billed yearly at $59.88. Two months cheaper than monthly.',
    installsPerMonth: null,
    sections: PAID_SECTIONS,
  },
];

const BY_ID = new Map(PLANS.map((plan) => [plan.id, plan]));
const BY_HANDLE = new Map(PLANS.map((plan) => [plan.handle, plan]));

const FREE = BY_ID.get('free');

/** The saving the yearly plan advertises, worked out rather than typed. */
function annualSavingPercent() {
  const monthly = BY_ID.get('monthly').perMonthCents;
  const annual = BY_ID.get('annual').perMonthCents;
  return Math.round(((monthly - annual) / monthly) * 100);
}

function byId(id) {
  return BY_ID.get(id) || FREE;
}

/**
 * Match a Shopify plan handle to one of ours.
 *
 * An active subscription whose handle we do not recognise resolves to the
 * monthly plan, not to Free. A merchant is being charged; the failure mode of
 * a handle typo in the Partner dashboard must be "we gave away the reports
 * page", never "we took the money and locked them out". `null` is for the
 * genuinely unsubscribed and is the only path to Free.
 */
function resolve(handle) {
  if (!handle) return FREE;

  const key = String(handle).trim().toLowerCase();
  const matched = BY_HANDLE.get(key);
  if (matched) return matched;

  // A handle Shopify gave us for a plan that is not Free, that we cannot place.
  return key === FREE.handle ? FREE : BY_ID.get('monthly');
}

function can(planId, section) {
  return byId(planId).sections.includes(section);
}

/**
 * What is left of this month's free allowance.
 *
 * `exhausted` is what the storefront acts on: it stops the app offering the
 * install card. It deliberately does not make the manifest uninstallable —
 * that would break the browser's own install menu, and worse, would change how
 * the app looks to customers who installed it before the cap was reached.
 *
 * `used` can exceed `limit`. Installs from the browser's own menu still count,
 * and the counters are flushed on a timer, so the number is allowed to run past
 * the ceiling rather than being clamped to it. A merchant reading "104 of 100"
 * is reading the truth.
 */
function allowanceFor(planId, usedThisMonth) {
  const plan = byId(planId);
  const used = Math.max(0, Number(usedThisMonth) || 0);

  if (plan.installsPerMonth === null) {
    return { limited: false, used, limit: null, remaining: null, exhausted: false, percent: 0 };
  }

  const limit = plan.installsPerMonth;
  return {
    limited: true,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exhausted: used >= limit,
    percent: Math.min(100, Math.round((used / limit) * 100)),
  };
}

/**
 * The plan table the admin renders, with the current plan marked.
 *
 * Built here rather than in the admin so the prices a merchant reads and the
 * entitlements the server enforces come from one place.
 */
function publicTable(currentId) {
  return PLANS.map((plan) => ({
    id: plan.id,
    handle: plan.handle,
    name: plan.name,
    priceLabel: plan.priceLabel,
    perMonthLabel: plan.perMonthLabel,
    interval: plan.interval,
    billingNote: plan.billingNote,
    installsPerMonth: plan.installsPerMonth,
    sections: plan.sections,
    reports: plan.sections.includes('reports'),
    current: plan.id === currentId,
    savingPercent: plan.id === 'annual' ? annualSavingPercent() : 0,
  }));
}

module.exports = {
  FREE_INSTALLS_PER_MONTH,
  PLANS,
  SECTIONS,
  allowanceFor,
  annualSavingPercent,
  byId,
  can,
  publicTable,
  resolve,
};
