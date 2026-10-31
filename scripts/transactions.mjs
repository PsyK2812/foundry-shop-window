import { add, cpToGp, deduct, formatCp, gpToCp } from "./currency.mjs";
import {
  MODULE_ID, baseUnitCp, escape, giveItem, isMerch, itemConfig, priceCp, resolve, shopConfig,
  stockOf, t, takeItem, walletCp
} from "./shop.mjs";

const CHANNEL = `module.${MODULE_ID}`;
const PITCH_IN_TIMEOUT = 3 * 60 * 1000;

/** Pending purchases waiting for pitch-ins (only on the GM client). */
const pending = new Map();

/* -------------------------------------------- */
/*  Socket plumbing                              */
/* -------------------------------------------- */

export function registerSocket() {
  game.socket.on(CHANNEL, msg => receive(msg));
}

function isActiveGM() {
  return game.user.isGM && (game.users.activeGM?.isSelf ?? true);
}

/** Send a message to "gm" or to a user id. Handles the local user without a round trip. */
function send(to, msg) {
  msg = { ...msg, to, senderId: game.user.id };
  const local = to === "gm" ? isActiveGM() : to === game.user.id;
  if (local) return receive(msg);
  game.socket.emit(CHANNEL, msg);
}

export function broadcast(msg) {
  game.socket.emit(CHANNEL, { ...msg, to: "all", senderId: game.user.id });
}

async function receive(msg) {
  const forMe = msg.to === "all" || msg.to === game.user.id || (msg.to === "gm" && isActiveGM());
  if (!forMe) return;
  try {
    switch (msg.action) {
      case "open": return Hooks.callAll(`${MODULE_ID}.open`, msg.shopUuid);
      case "close": return Hooks.callAll(`${MODULE_ID}.close`, msg.shopUuid);
      case "notify": return ui.notifications[msg.level ?? "info"](msg.message, { permanent: !!msg.permanent });
      case "buy": return gmHandleBuy(msg);
      case "sell": return gmHandleSell(msg);
      case "pitchInAsk": return playerAnswerPitchIn(msg);
      case "pitchInReply": return gmHandlePitchInReply(msg);
    }
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    if (game.user.isGM) ui.notifications.error(`Shop Window: ${err.message}`);
  }
}

function notify(userId, message, level = "info") {
  send(userId, { action: "notify", message, level });
}

/* -------------------------------------------- */
/*  Player side: send requests                   */
/* -------------------------------------------- */

function gmAvailable() {
  if (game.users.activeGM) return true;
  ui.notifications.warn(t("Notify.NoGM"));
  return false;
}

/**
 * @param {object} req  {shopUuid, itemId, qty, recipientUuid, containerId, payments:[{actorUuid, cp}], pitchIns:[{userId, cp}]}
 */
export function requestPurchase(req) {
  if (!gmAvailable()) return;
  send("gm", { action: "buy", requestId: foundry.utils.randomID(), ...req });
  if (!isActiveGM()) ui.notifications.info(t("Notify.RequestSent"));
}

/**
 * @param {object} req  {shopUuid, sellerUuid, itemId, qty, payeeUuid, askingCp}
 */
export function requestSale(req) {
  if (!gmAvailable()) return;
  send("gm", { action: "sell", requestId: foundry.utils.randomID(), ...req });
  if (!isActiveGM()) ui.notifications.info(t("Notify.SaleSent"));
}

/** Another player asked this user to pitch in. */
async function playerAnswerPitchIn(msg) {
  const { DialogV2 } = foundry.applications.api;
  const actors = game.actors.filter(a => a.system?.currency && a.isOwner && (!game.user.isGM || a.hasPlayerOwner));
  const affordable = actors.filter(a => walletCp(a) >= msg.cp);
  const options = affordable.map(a =>
    `<option value="${a.uuid}" ${a === game.user.character ? "selected" : ""}>${escape(a.name)} (${formatCp(walletCp(a))})</option>`).join("");

  const content = `
    <p>${t("PitchIn.Ask", { user: `<strong>${escape(msg.fromName)}</strong>`, amount: `<strong>${formatCp(msg.cp)}</strong>`,
      item: `<strong>${escape(msg.itemName)}</strong>`, shop: escape(msg.shopName) })}</p>
    ${affordable.length
      ? `<div class="form-group"><label>${t("PitchIn.PayFrom")}</label><select name="actorUuid">${options}</select></div>`
      : `<p class="notification warning">${t("PitchIn.CantAfford")}</p>`}`;

  const buttons = [{ action: "decline", label: t("Button.Decline"), icon: "fa-solid fa-xmark", callback: () => ({ accepted: false }) }];
  if (affordable.length) buttons.unshift({
    action: "pay", label: t("Button.Pay"), icon: "fa-solid fa-coins", default: true,
    callback: (event, button) => ({ accepted: true, actorUuid: button.form.elements.actorUuid.value })
  });

  const result = await DialogV2.wait({
    window: { title: t("PitchIn.Title"), icon: "fa-solid fa-hand-holding-dollar" },
    classes: ["shop-window-dialog"],
    content, buttons, rejectClose: false
  }) ?? { accepted: false };

  send("gm", { action: "pitchInReply", requestId: msg.requestId, userId: game.user.id, ...result });
}

/* -------------------------------------------- */
/*  GM side: purchases                           */
/* -------------------------------------------- */

/** Validate a purchase request. Throws an Error with a user-facing message. */
function validatePurchase(req) {
  const buyer = game.users.get(req.senderId);
  const shop = resolve(req.shopUuid);
  const item = shop?.items.get(req.itemId);
  if (!buyer || !shop || !item || !isMerch(item)) throw new Error(t("Error.ItemGone"));
  const cfg = shopConfig(shop);
  const qty = Math.max(1, Math.floor(Number(req.qty) || 1));
  if (!buyer.isGM && itemConfig(item).hidden) throw new Error(t("Error.ItemGone"));
  if (stockOf(item) < qty) throw new Error(t("Error.NotEnoughStock", { item: item.name }));

  const recipient = resolve(req.recipientUuid);
  if (!recipient || !recipient.testUserPermission(buyer, "OWNER")) throw new Error(t("Error.BadRecipient"));
  if (req.containerId && recipient.items.get(req.containerId)?.type !== "container") req.containerId = null;

  const total = priceCp(shop, item, qty);
  const payers = [];
  if (cfg.autoGold) {
    const byActor = new Map();
    for (const p of req.payments ?? []) {
      const actor = resolve(p.actorUuid);
      if (!actor || !actor.testUserPermission(buyer, "OWNER")) throw new Error(t("Error.BadPayer"));
      byActor.set(actor, (byActor.get(actor) ?? 0) + Math.max(0, Math.round(p.cp)));
    }
    for (const pi of req.pitchIns ?? []) {
      if (pi.status !== "accepted") continue;
      const actor = resolve(pi.actorUuid);
      const user = game.users.get(pi.userId);
      if (!actor || !user || !actor.testUserPermission(user, "OWNER")) throw new Error(t("Error.BadPayer"));
      byActor.set(actor, (byActor.get(actor) ?? 0) + Math.max(0, Math.round(pi.cp)));
    }
    const pitchTotal = (req.pitchIns ?? []).reduce((s, p) => s + Math.max(0, Math.round(p.cp)), 0);
    const ownTotal = (req.payments ?? []).reduce((s, p) => s + Math.max(0, Math.round(p.cp)), 0);
    if (ownTotal + pitchTotal !== total) throw new Error(t("Error.WrongAmount", { total: formatCp(total) }));
    for (const [actor, cp] of byActor) {
      if (cp <= 0) continue;
      if (walletCp(actor) < cp) throw new Error(t("Error.CantAfford", { actor: actor.name }));
      payers.push({ actor, cp });
    }
  }
  return { buyer, shop, item, qty, recipient, total, payers, cfg };
}

async function gmHandleBuy(req) {
  let v;
  try { v = validatePurchase(req); }
  catch (err) { return notify(req.senderId, err.message, "warn"); }

  req.pitchIns = (v.cfg.autoGold ? req.pitchIns ?? [] : [])
    .filter(p => p.cp > 0 && game.users.get(p.userId))
    .map(p => ({ ...p, cp: Math.round(p.cp), status: "waiting" }));

  if (!req.pitchIns.length) return gmFinalizeBuy(req);

  // Ask the other players and wait for their answers
  pending.set(req.requestId, req);
  req.timer = setTimeout(() => {
    if (!pending.delete(req.requestId)) return;
    notify(req.senderId, t("Notify.PitchInTimeout", { item: v.item.name }), "warn");
  }, PITCH_IN_TIMEOUT);
  for (const p of req.pitchIns) {
    send(p.userId, {
      action: "pitchInAsk", requestId: req.requestId, cp: p.cp,
      fromName: v.buyer.name, itemName: v.qty > 1 ? `${v.qty}× ${v.item.name}` : v.item.name, shopName: v.shop.name
    });
  }
  notify(req.senderId, t("Notify.WaitingPitchIn"));
}

async function gmHandlePitchInReply(msg) {
  const req = pending.get(msg.requestId);
  if (!req) return;
  const p = req.pitchIns.find(p => p.userId === msg.senderId && p.status === "waiting");
  if (!p) return;
  if (!msg.accepted) {
    clearTimeout(req.timer);
    pending.delete(req.requestId);
    const name = game.users.get(msg.senderId)?.name ?? "?";
    return notify(req.senderId, t("Notify.PitchInDeclined", { user: name }), "warn");
  }
  p.status = "accepted";
  p.actorUuid = msg.actorUuid;
  if (req.pitchIns.every(p => p.status === "accepted")) {
    clearTimeout(req.timer);
    pending.delete(req.requestId);
    return gmFinalizeBuy(req);
  }
}

function paymentList(payers) {
  return payers.map(p => `<li>${escape(p.actor.name)}: <strong>${formatCp(p.cp)}</strong></li>`).join("");
}

async function gmFinalizeBuy(req) {
  let v;
  try { v = validatePurchase(req); }
  catch (err) { return notify(req.senderId, err.message, "warn"); }

  // GM approval
  if (v.cfg.requireApproval && !(v.buyer.isGM)) {
    const base = baseUnitCp(v.item) * v.qty;
    const ic = itemConfig(v.item);
    const discounts = [];
    if (v.cfg.discount) discounts.push(`${t("Label.ShopDiscount")}: ${v.cfg.discount}%`);
    if (ic.discount) discounts.push(`${t("Label.ItemDiscount")}: ${ic.discount}%`);
    const content = `
      <div class="sw-approval">
        <div class="sw-approval-item"><img src="${v.item.img}"><div>
          <strong>${v.qty}× ${escape(v.item.name)}</strong><br>
          ${t("Approval.Buyer")}: ${escape(v.buyer.name)} → ${escape(v.recipient.name)}
        </div></div>
        <p>${t("Approval.Listed")}: ${formatCp(base)}${discounts.length ? ` (${discounts.join(", ")})` : ""}<br>
        <strong>${t("Approval.Total")}: ${formatCp(v.total)}</strong></p>
        ${v.cfg.autoGold
          ? `<p>${t("Approval.PaidBy")}:</p><ul>${paymentList(v.payers)}</ul>`
          : `<p><em>${t("Approval.ManualGold")}</em></p>`}
      </div>`;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Approval.TitleBuy", { shop: v.shop.name }), icon: "fa-solid fa-scale-balanced" },
      classes: ["shop-window-dialog"],
      content, rejectClose: false,
      yes: { label: t("Button.Approve"), icon: "fa-solid fa-check" },
      no: { label: t("Button.Decline"), icon: "fa-solid fa-xmark" }
    });
    if (!ok) return notify(req.senderId, t("Notify.Declined", { item: v.item.name }), "warn");
    try { v = validatePurchase(req); } // something might have changed while the dialog was open
    catch (err) { return notify(req.senderId, err.message, "warn"); }
  }

  // Take the money
  for (const p of v.payers) {
    const wallet = deduct(p.actor.system.currency, p.cp);
    if (!wallet) return notify(req.senderId, t("Error.CantAfford", { actor: p.actor.name }), "warn");
    await p.actor.update({ "system.currency": wallet });
  }
  // Move the goods
  await giveItem(v.recipient, v.item, v.qty, req.containerId);
  if (!itemConfig(v.item).unlimited) await takeItem(v.item, v.qty, true);

  notify(req.senderId, t("Notify.Bought", { item: `${v.qty}× ${v.item.name}`, actor: v.recipient.name }));
  for (const p of req.pitchIns ?? []) if (p.userId !== req.senderId) {
    notify(p.userId, t("Notify.PitchInDone", { amount: formatCp(p.cp), item: v.item.name }));
  }
  if (game.settings.get(MODULE_ID, "chatMessages")) {
    const paid = v.cfg.autoGold && v.payers.length ? `<ul>${paymentList(v.payers)}</ul>` : "";
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: v.shop }),
      content: `<div class="sw-chat"><img src="${v.item.img}"><p>${t("Chat.Bought", {
        actor: `<strong>${escape(v.recipient.name)}</strong>`, item: `<strong>${v.qty}× ${escape(v.item.name)}</strong>`,
        price: `<strong>${formatCp(v.total)}</strong>` })}</p></div>${paid}`
    });
  }
}

/* -------------------------------------------- */
/*  GM side: selling                             */
/* -------------------------------------------- */

function validateSale(req) {
  const seller = game.users.get(req.senderId);
  const shop = resolve(req.shopUuid);
  const actor = resolve(req.sellerUuid);
  const item = actor?.items.get(req.itemId);
  if (!seller || !shop || !actor || !item || !isMerch(item)) throw new Error(t("Error.ItemGone"));
  if (!actor.testUserPermission(seller, "OWNER")) throw new Error(t("Error.BadPayer"));
  const qty = Math.max(1, Math.floor(Number(req.qty) || 1));
  if ((Number(item.system.quantity) || 0) < qty) throw new Error(t("Error.NotEnoughOwned", { item: item.name }));
  const cfg = shopConfig(shop);
  if (!cfg.allowSelling) throw new Error(t("Error.NoSelling"));
  let payee = resolve(req.payeeUuid) ?? actor;
  if (!payee.testUserPermission(seller, "OWNER")) payee = actor;
  return { seller, shop, actor, item, qty, payee, cfg };
}

async function gmHandleSell(req) {
  let v;
  try { v = validateSale(req); }
  catch (err) { return notify(req.senderId, err.message, "warn"); }

  const base = baseUnitCp(v.item) * v.qty;
  const suggested = req.askingCp > 0 ? req.askingCp : Math.round(base / 2);
  const content = `
    <div class="sw-approval">
      <div class="sw-approval-item"><img src="${v.item.img}"><div>
        <strong>${v.qty}× ${escape(v.item.name)}</strong><br>
        ${t("Approval.Seller")}: ${escape(v.seller.name)} (${escape(v.actor.name)})
      </div></div>
      <p>${t("Approval.Listed")}: ${formatCp(base)}<br>
      ${req.askingCp > 0 ? `${t("Approval.Asking")}: <strong>${formatCp(req.askingCp)}</strong>` : t("Approval.NoAsking")}</p>
      <div class="form-group">
        <label>${t("Approval.Offer")}</label>
        <input type="number" name="gp" min="0" step="0.01" value="${cpToGp(suggested)}" autofocus>
      </div>
      ${v.cfg.autoGold ? `<p class="hint">${t("Approval.PaidTo", { actor: escape(v.payee.name) })}</p>`
        : `<p class="hint"><em>${t("Approval.ManualGold")}</em></p>`}
    </div>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Approval.TitleSell", { shop: v.shop.name }), icon: "fa-solid fa-scale-balanced" },
    classes: ["shop-window-dialog"],
    content, rejectClose: false,
    buttons: [
      { action: "approve", label: t("Button.Buy"), icon: "fa-solid fa-check", default: true,
        callback: (event, button) => ({ cp: gpToCp(button.form.elements.gp.value) }) },
      { action: "decline", label: t("Button.Decline"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
  if (!result) return notify(req.senderId, t("Notify.SaleDeclined", { item: v.item.name }), "warn");

  try { v = validateSale(req); }
  catch (err) { return notify(req.senderId, err.message, "warn"); }

  const price = Math.max(0, result.cp);
  if (v.cfg.autoGold && price > 0) {
    await v.payee.update({ "system.currency": add(v.payee.system.currency, price) });
  }
  // Into the shop: hidden until the GM reveals it
  const stocked = await giveItem(v.shop, v.item, v.qty, null);
  if (stocked && stocked.flags?.[MODULE_ID]?.hidden === undefined) {
    await stocked.setFlag(MODULE_ID, "hidden", true);
  }
  await takeItem(v.item, v.qty, false);

  notify(req.senderId, t("Notify.Sold", { item: `${v.qty}× ${v.item.name}`, price: formatCp(price) }));
  if (game.settings.get(MODULE_ID, "chatMessages")) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: v.shop }),
      content: `<div class="sw-chat"><img src="${v.item.img}"><p>${t("Chat.Sold", {
        actor: `<strong>${escape(v.actor.name)}</strong>`, item: `<strong>${v.qty}× ${escape(v.item.name)}</strong>`,
        price: `<strong>${formatCp(price)}</strong>` })}</p></div>`
    });
  }
}
