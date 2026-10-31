/**
 * Pure currency helpers. Everything is calculated in copper pieces (cp) internally
 * so no floating point rounding errors creep into payments.
 */

/** Default coin values in copper. Overridden by CONFIG.DND5E.currencies when available. */
const DEFAULT_VALUES = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };

/** Return coin values in cp, read from the dnd5e config where possible. */
export function coinValues() {
  const cfg = globalThis.CONFIG?.DND5E?.currencies;
  if (!cfg) return { ...DEFAULT_VALUES };
  const values = {};
  for (const [key, data] of Object.entries(cfg)) {
    const conv = Number(data?.conversion);
    // dnd5e stores "how many of this coin make 1 gp"
    values[key] = conv > 0 ? Math.round(100 / conv) : DEFAULT_VALUES[key] ?? 0;
  }
  for (const k of Object.keys(DEFAULT_VALUES)) values[k] ??= DEFAULT_VALUES[k];
  return values;
}

/** Total value of a currency object in cp. */
export function walletToCp(currency = {}, values = coinValues()) {
  let total = 0;
  for (const [k, v] of Object.entries(values)) total += (Number(currency[k]) || 0) * v;
  return total;
}

/** Convert an amount of a given denomination to cp. */
export function toCp(amount, denomination = "gp", values = coinValues()) {
  return Math.round((Number(amount) || 0) * (values[denomination] ?? 100));
}

/** gp (decimal, as typed by a user) -> cp */
export function gpToCp(gp) {
  return Math.round((Number(gp) || 0) * 100);
}

/** cp -> gp number with up to 2 decimals */
export function cpToGp(cp) {
  return Math.round(cp) / 100;
}

/**
 * Human readable price, e.g. 1555 cp -> "15 gp 5 sp 5 cp".
 * Uses gp/sp/cp only (pp and ep are rarely used for prices).
 */
export function formatCp(cp) {
  cp = Math.max(0, Math.round(cp));
  if (cp === 0) return "0 gp";
  const gp = Math.floor(cp / 100);
  const sp = Math.floor((cp % 100) / 10);
  const c = cp % 10;
  const parts = [];
  if (gp) parts.push(`${gp.toLocaleString()} gp`);
  if (sp) parts.push(`${sp} sp`);
  if (c) parts.push(`${c} cp`);
  return parts.join(" ");
}

/**
 * Remove `cost` cp from a wallet, making change where needed.
 * Strategy: pay with the biggest coins that fit, then break the smallest
 * remaining coin that covers the rest and return the change in smaller coins.
 * @returns {object|null} the new wallet, or null if the wallet can't afford it
 */
export function deduct(currency, cost, values = coinValues()) {
  const wallet = {};
  for (const k of Object.keys(values)) wallet[k] = Math.max(0, Math.floor(Number(currency?.[k]) || 0));
  cost = Math.round(cost);
  if (cost <= 0) return wallet;
  if (walletToCp(wallet, values) < cost) return null;

  const desc = Object.keys(values).filter(k => values[k] > 0).sort((a, b) => values[b] - values[a]);
  let remaining = cost;
  for (const k of desc) {
    const take = Math.min(wallet[k], Math.floor(remaining / values[k]));
    wallet[k] -= take;
    remaining -= take * values[k];
  }
  if (remaining > 0) {
    // Every denomination that still has coins is worth more than `remaining`.
    const asc = [...desc].reverse();
    const breakCoin = asc.find(k => wallet[k] > 0 && values[k] >= remaining);
    if (!breakCoin) return null;
    wallet[breakCoin] -= 1;
    let change = values[breakCoin] - remaining;
    // Return change in gp/sp/cp (skip pp and ep so change stays tidy)
    for (const k of desc) {
      if (values[k] >= values[breakCoin]) continue;
      if (k === "ep" || k === "pp") continue;
      const n = Math.floor(change / values[k]);
      wallet[k] += n;
      change -= n * values[k];
    }
  }
  return wallet;
}

/**
 * Add `amount` cp to a wallet as gp, sp and cp.
 */
export function add(currency, amount, values = coinValues()) {
  const wallet = {};
  for (const k of Object.keys(values)) wallet[k] = Math.max(0, Math.floor(Number(currency?.[k]) || 0));
  let rest = Math.max(0, Math.round(amount));
  for (const k of ["gp", "sp", "cp"]) {
    const v = values[k];
    if (!v) continue;
    const n = Math.floor(rest / v);
    wallet[k] += n;
    rest -= n * v;
  }
  return wallet;
}

/**
 * Final price in cp after stacking percentage discounts multiplicatively.
 * Negative discounts are markups.
 */
export function applyDiscounts(baseCp, discounts = []) {
  let price = baseCp;
  for (const d of discounts) {
    const pct = Math.min(100, Number(d) || 0);
    price *= (100 - pct) / 100;
  }
  return Math.max(0, Math.round(price));
}
