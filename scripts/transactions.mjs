import { add, cpToGp, deduct, formatCp, gpToCp } from "./currency.mjs";
import {
  MODULE_ID, baseUnitCp, canDeliverTo, containersOf, deliveryTargets, escape, giveItem, isMerch, itemConfig, priceCp, resolve, shopConfig,
  stockOf, t, takeItem, walletCp
} from "./shop.mjs";

const CHANNEL = `module.${MODULE_ID}`;
const PITCH_IN_TIMEOUT = 3 * 60 * 1000;
const DESTINATION_TIMEOUT = 10 * 60 * 1000;

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
      case "trade": return gmHandleTrade(msg);
      case "pitchInAsk": return playerAnswerPitchIn(msg);
      case "pitchInReply": return gmHandlePitchInReply(msg);
      case "chooseDestination": return playerChooseDestination(msg);
      case "destinationReply": return gmHandleDestination(msg);
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

/**
 * @param {object} req  {shopUuid, itemId, qty, offered:[{actorUuid, itemId, qty}], note}
 */
export function requestTrade(req) {
  if (!gmAvailable()) return;
  send("gm", { action: "trade", requestId: foundry.utils.randomID(), ...req });
  if (!isActiveGM()) ui.notifications.info(t("Notify.TradeSent"));
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

/** The purchase went through: ask the buyer where the item should go. */
async function playerChooseDestination(msg) {
  const { DialogV2 } = foundry.applications.api;
  const shop = resolve(msg.shopUuid);
  const targets = deliveryTargets(game.user, shop);
  const optList = list => list.map(a => `<option value="${a.uuid}">${escape(a.name)}</option>`).join("");
  const containerOptions = actor => `<option value="">${t("Buy.MainInventory")}</option>` +
    containersOf(actor).map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join("");

  const content = `
    <div class="sw-dialog">
      <div class="sw-approval-item"><img src="${msg.itemImg}"><div>
        <strong>${escape(msg.itemName)}</strong><br>${t("Destination.Intro")}
      </div></div>
      <div class="form-group"><label>${t("Buy.DeliverTo")}</label><select name="recipient">
        <option value="" selected disabled>${t("Buy.ChooseRecipient")}</option>
        ${targets.own.length ? `<optgroup label="${t("Buy.YourCharacters")}">${optList(targets.own)}</optgroup>` : ""}
        ${targets.others.length ? `<optgroup label="${t("Buy.OtherCharacters")}">${optList(targets.others)}</optgroup>` : ""}
      </select></div>
      <div class="form-group sw-container-group" hidden><label>${t("Buy.Container")}</label><select name="container"></select></div>
    </div>`;

  let readState = () => null;
  const render = (event, dialogOrEl) => {
    const root = dialogOrEl instanceof HTMLElement ? dialogOrEl : dialogOrEl?.element;
    if (!root) return;
    const recipient = root.querySelector("[name=recipient]");
    const container = root.querySelector("[name=container]");
    const group = root.querySelector(".sw-container-group");
    const confirm = root.querySelector('button[data-action="deliver"]');
    if (confirm) confirm.disabled = true;
    recipient.addEventListener("change", () => {
      const actor = fromUuidSync(recipient.value);
      container.innerHTML = containerOptions(actor);
      group.hidden = !actor;
      if (confirm) confirm.disabled = !actor;
    });
    readState = () => recipient.value ? { recipientUuid: recipient.value, containerId: container.value || null } : null;
  };

  const result = await DialogV2.wait({
    window: { title: t("Destination.Title"), icon: "fa-solid fa-box-open" },
    classes: ["shop-window-dialog"],
    position: { width: 420 },
    content, render, rejectClose: false,
    buttons: [
      { action: "deliver", label: t("Button.Deliver"), icon: "fa-solid fa-check", default: true, callback: () => readState() },
      { action: "cancel", label: t("Button.CancelPurchase"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
  send("gm", { action: "destinationReply", requestId: msg.requestId, ...(result ?? { cancelled: true }) });
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
  if (req.kind !== "trade" && !cfg.acceptGold && !buyer.isGM) throw new Error(t("Error.NoGold"));

  let recipient = null;
  if (req.recipientUuid) {
    recipient = resolve(req.recipientUuid);
    if (!recipient || !canDeliverTo(recipient, buyer)) throw new Error(t("Error.BadRecipient"));
    if (req.containerId && recipient.items.get(req.containerId)?.type !== "container") req.containerId = null;
  }

  const total = priceCp(shop, item, qty);
  const payers = [];
  if (cfg.autoGold && req.kind !== "trade") {
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
  if (!req || req.stage === "destination") return;
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
          ${t("Approval.Buyer")}: ${escape(v.buyer.name)}
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

  askDestination(req, v);
}

/** Ask the buyer where the item should go. Nothing changes hands until they answer. */
function askDestination(req, v) {
  req.stage = "destination";
  pending.set(req.requestId, req);
  req.timer = setTimeout(() => {
    if (!pending.delete(req.requestId)) return;
    cancelPurchase(req, t("Notify.DestinationTimeout", { item: v.item.name }));
  }, DESTINATION_TIMEOUT);
  send(req.senderId, {
    action: "chooseDestination", requestId: req.requestId, shopUuid: req.shopUuid,
    itemName: `${v.qty}× ${v.item.name}`, itemImg: v.item.img
  });
}

function cancelPurchase(req, message) {
  notify(req.senderId, message, "warn");
  for (const p of req.pitchIns ?? []) if (p.status === "accepted" && p.userId !== req.senderId) notify(p.userId, message, "warn");
}

async function gmHandleDestination(msg) {
  const req = pending.get(msg.requestId);
  if (!req || req.stage !== "destination" || msg.senderId !== req.senderId) return;
  clearTimeout(req.timer);
  pending.delete(req.requestId);
  const shop = resolve(req.shopUuid);
  const itemName = shop?.items.get(req.itemId)?.name ?? "?";
  if (msg.cancelled || !msg.recipientUuid) {
    return cancelPurchase(req, t(req.kind === "trade" ? "Notify.TradeCancelled" : "Notify.PurchaseCancelled", { item: itemName }));
  }
  req.recipientUuid = msg.recipientUuid;
  req.containerId = msg.containerId || null;
  return req.kind === "trade" ? gmExecuteTrade(req) : gmExecuteBuy(req);
}

async function gmExecuteBuy(req) {
  let v;
  try { v = validatePurchase(req); if (!v.recipient) throw new Error(t("Error.BadRecipient")); }
  catch (err) { return cancelPurchase(req, err.message); }

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
/*  GM side: trades                              */
/* -------------------------------------------- */

function validateTrade(req) {
  req.kind = "trade";
  const copy = { ...req, payments: [], pitchIns: [] };
  const v = validatePurchase(copy);
  req.containerId = copy.containerId;
  if (!v.cfg.acceptTrades) throw new Error(t("Error.NoTrades"));
  const offered = [];
  for (const o of req.offered ?? []) {
    const actor = resolve(o.actorUuid);
    const item = actor?.items.get(o.itemId);
    if (!actor || !item || actor === v.shop) throw new Error(t("Error.OfferGone"));
    if (!actor.testUserPermission(v.buyer, "OWNER")) throw new Error(t("Error.BadPayer"));
    const qty = Math.max(1, Math.floor(Number(o.qty) || 1));
    if ((Number(item.system.quantity) || 0) < qty) throw new Error(t("Error.NotEnoughOwned", { item: item.name }));
    offered.push({ actor, item, qty });
  }
  if (!offered.length) throw new Error(t("Error.OfferGone"));
  return { ...v, offered };
}

function offerList(offered) {
  return offered.map(o => `<li><img src="${o.item.img}" class="sw-li-img"> ${o.qty}× ${escape(o.item.name)}
    <small>(${escape(o.actor.name)}, ${formatCp(baseUnitCp(o.item) * o.qty)})</small></li>`).join("");
}

async function gmHandleTrade(req) {
  let v;
  try { v = validateTrade(req); }
  catch (err) { return notify(req.senderId, err.message, "warn"); }

  // Trades always need the GM's okay
  if (!v.buyer.isGM) {
    const offerCp = v.offered.reduce((s, o) => s + baseUnitCp(o.item) * o.qty, 0);
    const content = `
      <div class="sw-approval">
        <div class="sw-approval-item"><img src="${v.item.img}"><div>
          <strong>${v.qty}× ${escape(v.item.name)}</strong> (${formatCp(baseUnitCp(v.item) * v.qty)})<br>
          ${t("Approval.Buyer")}: ${escape(v.buyer.name)}
        </div></div>
        <p>${t("Approval.Offers")}:</p>
        <ul class="sw-offer-ul">${offerList(v.offered)}</ul>
        <p>${t("Trade.Values", { offer: formatCp(offerCp), wanted: formatCp(baseUnitCp(v.item) * v.qty) })}</p>
        ${req.note ? `<blockquote>${escape(req.note)}</blockquote>` : ""}
      </div>`;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Approval.TitleTrade", { shop: v.shop.name }), icon: "fa-solid fa-right-left" },
      classes: ["shop-window-dialog"],
      content, rejectClose: false,
      yes: { label: t("Button.Accept"), icon: "fa-solid fa-check" },
      no: { label: t("Button.Decline"), icon: "fa-solid fa-xmark" }
    });
    if (!ok) return notify(req.senderId, t("Notify.TradeDeclined", { item: v.item.name }), "warn");
    try { v = validateTrade(req); }
    catch (err) { return notify(req.senderId, err.message, "warn"); }
  }
  askDestination(req, v);
}

async function gmExecuteTrade(req) {
  let v;
  try { v = validateTrade(req); if (!v.recipient) throw new Error(t("Error.BadRecipient")); }
  catch (err) { return cancelPurchase(req, err.message); }

  // Offered items go to the merchant (hidden until revealed)
  for (const o of v.offered) {
    const stocked = await giveItem(v.shop, o.item, o.qty, null);
    if (stocked && stocked.flags?.[MODULE_ID]?.hidden === undefined) await stocked.setFlag(MODULE_ID, "hidden", true);
    await takeItem(o.item, o.qty, false);
  }
  // Wanted item goes to the chosen inventory
  await giveItem(v.recipient, v.item, v.qty, req.containerId);
  if (!itemConfig(v.item).unlimited) await takeItem(v.item, v.qty, true);

  notify(req.senderId, t("Notify.Traded", { item: `${v.qty}× ${v.item.name}`, actor: v.recipient.name }));
  if (game.settings.get(MODULE_ID, "chatMessages")) {
    const gave = v.offered.map(o => `${o.qty}× ${escape(o.item.name)}`).join(", ");
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: v.shop }),
      content: `<div class="sw-chat"><img src="${v.item.img}"><p>${t("Chat.Traded", {
        actor: `<strong>${escape(v.recipient.name)}</strong>`, item: `<strong>${v.qty}× ${escape(v.item.name)}</strong>`,
        offer: `<strong>${gave}</strong>` })}</p></div>`
    });
  }
}

/* -------------------------------------------- */
/*  GM side: selling                             */
/* -------------------------------------------- */

function validateSale(req) {
  const seller = game.users.get(req.senderId);
  const shop = resolve(req.shopUuid);
  if (!seller || !shop) throw new Error(t("Error.ItemGone"));
  const cfg = shopConfig(shop);
  if (!cfg.allowSelling) throw new Error(t("Error.NoSelling"));
  const offered = [];
  for (const o of req.offered ?? []) {
    const actor = resolve(o.actorUuid);
    const item = actor?.items.get(o.itemId);
    if (!actor || !item || actor === shop || !isMerch(item)) throw new Error(t("Error.OfferGone"));
    if (!actor.testUserPermission(seller, "OWNER")) throw new Error(t("Error.BadPayer"));
    const qty = Math.max(1, Math.floor(Number(o.qty) || 1));
    if ((Number(item.system.quantity) || 0) < qty) throw new Error(t("Error.NotEnoughOwned", { item: item.name }));
    offered.push({ actor, item, qty });
  }
  if (!offered.length) throw new Error(t("Error.OfferGone"));
  let payee = resolve(req.payeeUuid);
  if (!payee || !payee.testUserPermission(seller, "OWNER")) payee = offered[0].actor;
  return { seller, shop, offered, payee, cfg };
}

async function gmHandleSell(req) {
  let v;
  try { v = validateSale(req); }
  catch (err) { return notify(req.senderId, err.message, "warn"); }

  const listedTotal = v.offered.reduce((s, o) => s + baseUnitCp(o.item) * o.qty, 0);
  const rows = v.offered.map((o, i) => {
    const listed = baseUnitCp(o.item) * o.qty;
    // Suggest the asking price spread by value, otherwise half the listed value
    const suggested = req.askingCp > 0
      ? Math.round(listedTotal ? req.askingCp * listed / listedTotal : req.askingCp / v.offered.length)
      : Math.round(listed / 2);
    return `<div class="sw-offer-row">
      <img src="${o.item.img}" alt="">
      <span class="sw-pay-name">${o.qty}× ${escape(o.item.name)}<small>${escape(o.actor.name)} · ${t("Trade.Listed", { price: formatCp(listed) })}</small></span>
      <input type="number" class="sw-sell-price" data-index="${i}" min="0" step="0.01" value="${cpToGp(suggested)}"> <span>gp</span>
    </div>`;
  }).join("");

  const content = `
    <div class="sw-approval">
      <p>${t("Approval.Seller")}: <strong>${escape(v.seller.name)}</strong></p>
      <div class="sw-offer-list">${rows}</div>
      <p>${t("Approval.Listed")}: ${formatCp(listedTotal)}<br>
      ${req.askingCp > 0 ? `${t("Approval.Asking")}: <strong>${formatCp(req.askingCp)}</strong>` : t("Approval.NoAsking")}</p>
      ${req.note ? `<blockquote>${escape(req.note)}</blockquote>` : ""}
      <p class="sw-total">${t("Approval.Offer")}: <strong data-sell-total></strong></p>
      ${v.cfg.autoGold ? `<p class="hint">${t("Approval.PaidTo", { actor: escape(v.payee.name) })}</p>`
        : `<p class="hint"><em>${t("Approval.ManualGold")}</em></p>`}
    </div>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Approval.TitleSell", { shop: v.shop.name }), icon: "fa-solid fa-scale-balanced" },
    classes: ["shop-window-dialog"],
    position: { width: 460 },
    content, rejectClose: false,
    render: (event, dialogOrEl) => {
      const root = dialogOrEl instanceof HTMLElement ? dialogOrEl : dialogOrEl?.element;
      if (!root) return;
      const totalEl = root.querySelector("[data-sell-total]");
      const sum = () => { totalEl.textContent = formatCp([...root.querySelectorAll(".sw-sell-price")].reduce((s, i) => s + gpToCp(i.value), 0)); };
      root.addEventListener("input", ev => { if (ev.target.matches(".sw-sell-price")) sum(); });
      sum();
    },
    buttons: [
      { action: "approve", label: t("Button.Buy"), icon: "fa-solid fa-check", default: true,
        callback: (event, button) => ({ prices: [...button.form.querySelectorAll(".sw-sell-price")].map(i => Math.max(0, gpToCp(i.value))) }) },
      { action: "decline", label: t("Button.Decline"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
  if (!result) return notify(req.senderId, t("Notify.SaleDeclined"), "warn");

  try { v = validateSale(req); }
  catch (err) { return notify(req.senderId, err.message, "warn"); }

  const price = result.prices.reduce((s, p) => s + p, 0);
  if (v.cfg.autoGold && price > 0) {
    await v.payee.update({ "system.currency": add(v.payee.system.currency, price) });
  }
  // Into the shop: hidden until the GM reveals it
  for (const o of v.offered) {
    const stocked = await giveItem(v.shop, o.item, o.qty, null);
    if (stocked && stocked.flags?.[MODULE_ID]?.hidden === undefined) await stocked.setFlag(MODULE_ID, "hidden", true);
    await takeItem(o.item, o.qty, false);
  }

  const names = v.offered.map(o => `${o.qty}× ${o.item.name}`).join(", ");
  notify(req.senderId, t("Notify.Sold", { item: names, price: formatCp(price) }));
  if (game.settings.get(MODULE_ID, "chatMessages")) {
    const lines = v.offered.map((o, i) => `<li>${o.qty}× ${escape(o.item.name)}: <strong>${formatCp(result.prices[i] ?? 0)}</strong></li>`).join("");
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: v.shop }),
      content: `<p>${t("Chat.Sold", { actor: `<strong>${escape(v.payee.name)}</strong>`,
        item: `<strong>${escape(names)}</strong>`, price: `<strong>${formatCp(price)}</strong>` })}</p><ul>${lines}</ul>`
    });
  }
}
