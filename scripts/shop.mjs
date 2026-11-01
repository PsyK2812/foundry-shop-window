import { applyDiscounts, toCp, walletToCp } from "./currency.mjs";

export const MODULE_ID = "shop-window";
export const STACKABLE_TYPES = ["consumable", "loot"];

/** Localize helper */
export function t(key, data) {
  const k = `SHOPWINDOW.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}

/** Read the per-shop settings stored on the merchant actor. */
export function shopConfig(actor) {
  const f = actor?.flags?.[MODULE_ID] ?? {};
  return {
    discount: Number(f.discount) || 0,
    autoGold: f.autoGold ?? game.settings.get(MODULE_ID, "defaultAutoGold"),
    requireApproval: f.requireApproval ?? game.settings.get(MODULE_ID, "defaultRequireApproval"),
    allowSelling: f.allowSelling ?? true,
    acceptGold: f.acceptGold ?? true,
    acceptTrades: f.acceptTrades ?? false,
    open: !!f.open
  };
}

/** Per-item shop settings. */
export function itemConfig(item) {
  const f = item?.flags?.[MODULE_ID] ?? {};
  return {
    hidden: f.hidden ?? game.settings.get(MODULE_ID, "hideNewItems"),
    discount: Number(f.discount) || 0,
    unlimited: !!f.unlimited
  };
}

/** Is this item something that can be bought/sold (has a price and a quantity)? */
export function isMerch(item) {
  return item?.system?.price !== undefined && item?.system?.quantity !== undefined;
}

/** Listed price of one unit in cp (before discounts). */
export function baseUnitCp(item) {
  const price = item?.system?.price ?? {};
  return toCp(price.value ?? 0, price.denomination || "gp");
}

/** Final price of `qty` units in cp after shop and item discounts. */
export function priceCp(shop, item, qty = 1) {
  const s = shopConfig(shop);
  const i = itemConfig(item);
  return applyDiscounts(baseUnitCp(item) * qty, [s.discount, i.discount]);
}

/**
 * Attunement state of an item: "required", "optional" or "".
 * Handles dnd5e 3+ strings and the older numeric values (1 = required, 2 = attuned).
 */
export function attunementOf(item) {
  const a = item?.system?.attunement;
  if (a === "required" || a === 1 || a === 2) return "required";
  if (a === "optional") return "optional";
  return "";
}

/** Localized rarity label, or "" for mundane items. */
export function rarityOf(item) {
  const r = item?.system?.rarity;
  if (!r) return { key: "", label: "" };
  const cfg = CONFIG.DND5E?.itemRarity?.[r];
  const label = typeof cfg === "string" ? cfg : cfg?.label ?? r;
  return { key: r, label: game.i18n.localize(label) };
}

/** Units the shop can still sell (Infinity when unlimited). */
export function stockOf(item) {
  if (itemConfig(item).unlimited) return Infinity;
  return Math.max(0, Number(item.system.quantity) || 0);
}

/**
 * Actors a user may pay with or deliver to.
 * Players: every actor they own that has a wallet. GMs: player-owned actors only.
 */
export function ownedActors(user = game.user, exclude = null) {
  return game.actors.filter(a => {
    if (a === exclude || !a.system?.currency) return false;
    if (!a.testUserPermission(user, "OWNER")) return false;
    if (user.isGM) return a.hasPlayerOwner;
    return true;
  }).sort((a, b) => {
    // assigned character first
    if (a === user.character) return -1;
    if (b === user.character) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Where a user may have a bought item delivered: their own characters first,
 * then other player characters and party (group) actors.
 */
export function deliveryTargets(user = game.user, exclude = null) {
  const own = ownedActors(user, exclude);
  const others = game.actors.filter(a => a !== exclude && !own.includes(a) && canDeliverTo(a, user))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { own, others };
}

/** Can `user` have items delivered to `actor`? */
export function canDeliverTo(actor, user) {
  if (!actor?.system?.currency && actor?.type !== "group") return false;
  if (actor.testUserPermission(user, "OWNER")) return true;
  return actor.type === "group" || (actor.type === "character" && actor.hasPlayerOwner);
}

export function walletCp(actor) {
  return walletToCp(actor?.system?.currency ?? {});
}

/** Containers on an actor, for "put it in my backpack". */
export function containersOf(actor) {
  return (actor?.items ?? []).filter(i => i.type === "container").sort((a, b) => a.name.localeCompare(b.name));
}

/** Other players who could be asked to pitch in. */
export function pitchInUsers() {
  return game.users.filter(u => u.active && !u.isGM && u !== game.user);
}

/** Add `qty` copies of `item` to `actor`, stacking when sensible. */
export async function giveItem(actor, item, qty, containerId = null) {
  containerId ||= null;
  if (STACKABLE_TYPES.includes(item.type)) {
    const existing = actor.items.find(i => i.type === item.type && i.name === item.name
      && (i.system.container ?? null) === containerId);
    if (existing) {
      await existing.update({ "system.quantity": (Number(existing.system.quantity) || 0) + qty });
      return existing;
    }
  }
  const data = item.toObject();
  delete data._id;
  data.system.quantity = qty;
  if ("container" in data.system) data.system.container = containerId;
  if ("equipped" in data.system) data.system.equipped = false;
  if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID];
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  return created;
}

/**
 * Remove `qty` units of `item` from its actor.
 * @param {boolean} keepAtZero  keep the item with quantity 0 (used for shop stock)
 */
export async function takeItem(item, qty, keepAtZero = false) {
  const left = (Number(item.system.quantity) || 0) - qty;
  if (left <= 0 && !keepAtZero) return item.delete();
  return item.update({ "system.quantity": Math.max(0, left) });
}

/** Resolve a uuid synchronously when possible. */
export function resolve(uuid) {
  if (!uuid) return null;
  try { return fromUuidSync(uuid); } catch { return null; }
}

export function escape(s) {
  return foundry.utils.escapeHTML ? foundry.utils.escapeHTML(String(s ?? "")) : String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
