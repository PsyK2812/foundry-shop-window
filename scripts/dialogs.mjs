import { cpToGp, formatCp, gpToCp } from "./currency.mjs";
import {
  baseUnitCp, containersOf, deliveryTargets, escape, isMerch, ownedActors, pitchInUsers, priceCp, shopConfig, stockOf, t, walletCp
} from "./shop.mjs";
import { requestPurchase, requestSale } from "./transactions.mjs";

const { DialogV2 } = foundry.applications.api;

/** DialogV2 passes (event, dialog) to render; older builds passed an element. */
function rootOf(arg) {
  if (arg instanceof HTMLElement) return arg;
  if (arg?.element instanceof HTMLElement) return arg.element;
  return arg?.[0] ?? null;
}

function containerOptions(actor) {
  return `<option value="">${t("Buy.MainInventory")}</option>` +
    containersOf(actor).map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join("");
}

/* -------------------------------------------- */
/*  Buy                                          */
/* -------------------------------------------- */

export async function buyDialog(shop, item) {
  const cfg = shopConfig(shop);
  const actors = ownedActors(game.user, shop);
  if (!actors.length) return ui.notifications.warn(t("Notify.NoActors"));
  const stock = stockOf(item);
  if (stock <= 0) return ui.notifications.warn(t("Error.NotEnoughStock", { item: item.name }));
  const maxQty = Number.isFinite(stock) ? stock : 999;
  const unit = priceCp(shop, item, 1);
  const others = pitchInUsers();

  const targets = deliveryTargets(game.user, shop);
  const optList = list => list.map(a => `<option value="${a.uuid}">${escape(a.name)}</option>`).join("");
  const actorOptions = `<option value="" selected disabled>${t("Buy.ChooseRecipient")}</option>`
    + (targets.own.length ? `<optgroup label="${t("Buy.YourCharacters")}">${optList(targets.own)}</optgroup>` : "")
    + (targets.others.length ? `<optgroup label="${t("Buy.OtherCharacters")}">${optList(targets.others)}</optgroup>` : "");
  const payRows = actors.map(a => `
    <div class="sw-pay-row" data-uuid="${a.uuid}" data-wallet="${walletCp(a)}">
      <img src="${a.img}" alt="">
      <span class="sw-pay-name">${escape(a.name)}<small>${t("Buy.Has", { amount: formatCp(walletCp(a)) })}</small></span>
      <button type="button" class="sw-mini" data-fill="${a.uuid}" data-tooltip="${t("Buy.PayAllHint")}"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>
      <input type="number" class="sw-pay" min="0" step="0.01" value="0"> <span>gp</span>
    </div>`).join("");
  const userOptions = others.map(u => `<option value="${u.id}">${escape(u.name)}</option>`).join("");

  const content = `
    <div class="sw-dialog">
      <div class="sw-approval-item"><img src="${item.img}"><div>
        <strong>${escape(item.name)}</strong><br>
        <span>${t("Buy.Each", { price: formatCp(unit) })}${unit !== baseUnitCp(item) ? ` <s>${formatCp(baseUnitCp(item))}</s>` : ""}</span>
      </div></div>

      <div class="form-group"><label>${t("Buy.Quantity")}</label>
        <input type="number" name="qty" value="1" min="1" max="${maxQty}" step="1"></div>
      <div class="form-group"><label>${t("Buy.DeliverTo")}</label><select name="recipient">${actorOptions}</select></div>
      <div class="form-group sw-container-group" hidden><label>${t("Buy.Container")}</label><select name="container"></select></div>

      <div class="sw-total">${t("Buy.Total")}: <strong data-total>${formatCp(unit)}</strong></div>

      ${cfg.autoGold ? `
      <fieldset class="sw-payments"><legend>${t("Buy.Payment")}</legend>
        ${payRows}
        <div class="sw-pitchins"></div>
        ${others.length ? `<button type="button" class="sw-add-pitch"><i class="fa-solid fa-user-plus"></i> ${t("Buy.AskPitchIn")}</button>`
          : `<p class="hint">${t("Buy.NoOthers")}</p>`}
        <div class="sw-remaining" data-remaining></div>
      </fieldset>` : `<p class="hint">${t("Buy.ManualGold")}</p>`}
      ${cfg.requireApproval && !game.user.isGM ? `<p class="hint"><i class="fa-solid fa-scale-balanced"></i> ${t("Buy.NeedsApproval")}</p>` : ""}
    </div>`;

  let readState = () => null;

  const render = (event, dialogOrEl) => {
    const root = rootOf(dialogOrEl) ?? rootOf(event?.target);
    if (!root) return;
    const form = root.querySelector("form") ?? root;
    const qtyInput = form.querySelector("[name=qty]");
    const recipient = form.querySelector("[name=recipient]");
    const container = form.querySelector("[name=container]");
    const confirm = root.querySelector('button[data-action="buy"]');
    const totalEl = form.querySelector("[data-total]");
    const remainingEl = form.querySelector("[data-remaining]");
    const pitchBox = form.querySelector(".sw-pitchins");

    const qty = () => Math.min(maxQty, Math.max(1, Math.floor(Number(qtyInput.value) || 1)));
    const total = () => priceCp(shop, item, qty());
    const rows = () => [...form.querySelectorAll(".sw-pay-row")];
    const pitchRows = () => [...form.querySelectorAll(".sw-pitch-row")];

    const update = () => {
      totalEl.textContent = formatCp(total());
      if (!cfg.autoGold) { if (confirm) confirm.disabled = !recipient.value; return; }
      let ok = true;
      let paid = 0;
      for (const r of rows()) {
        const cp = gpToCp(r.querySelector("input").value);
        const over = cp > Number(r.dataset.wallet) || cp < 0;
        r.classList.toggle("invalid", over);
        if (over) ok = false;
        paid += cp;
      }
      for (const r of pitchRows()) {
        const cp = gpToCp(r.querySelector("input").value);
        if (cp < 0) ok = false;
        paid += cp;
      }
      const remaining = total() - paid;
      if (remaining !== 0) ok = false;
      if (!recipient.value) ok = false;
      remainingEl.className = `sw-remaining ${remaining === 0 ? "ok" : "bad"}`;
      remainingEl.textContent = remaining === 0 ? t("Buy.Covered")
        : remaining > 0 ? t("Buy.Remaining", { amount: formatCp(remaining) })
        : t("Buy.TooMuch", { amount: formatCp(-remaining) });
      if (confirm) confirm.disabled = !ok;
    };

    qtyInput.addEventListener("input", update);
    const containerGroup = form.querySelector(".sw-container-group");
    recipient.addEventListener("change", () => {
      const actor = fromUuidSync(recipient.value);
      container.innerHTML = containerOptions(actor);
      containerGroup.hidden = !actor;
      update();
    });
    form.addEventListener("input", ev => { if (ev.target.matches(".sw-pay, .sw-pitch-amt")) update(); });
    form.querySelectorAll("[data-fill]").forEach(btn => btn.addEventListener("click", () => {
      let left = total() - pitchRows().reduce((s, r) => s + gpToCp(r.querySelector("input").value), 0);
      for (const r of rows()) {
        r.querySelector("input").value = r.dataset.uuid === btn.dataset.fill ? cpToGp(Math.max(0, left)) : 0;
      }
      update();
    }));
    form.querySelector(".sw-add-pitch")?.addEventListener("click", () => {
      const row = document.createElement("div");
      row.className = "sw-pitch-row";
      row.innerHTML = `<i class="fa-solid fa-hand-holding-dollar"></i>
        <select>${userOptions}</select>
        <input type="number" class="sw-pitch-amt" min="0" step="0.01" value="0"> <span>gp</span>
        <button type="button" class="sw-mini" data-tooltip="${t("Buy.Remove")}"><i class="fa-solid fa-trash"></i></button>`;
      row.querySelector("button").addEventListener("click", () => { row.remove(); update(); });
      pitchBox.append(row);
      update();
    });

    readState = () => ({
      qty: qty(),
      recipientUuid: recipient.value,
      containerId: container.value || null,
      payments: rows().map(r => ({ actorUuid: r.dataset.uuid, cp: gpToCp(r.querySelector("input").value) })).filter(p => p.cp > 0),
      pitchIns: pitchRows().map(r => ({ userId: r.querySelector("select").value, cp: gpToCp(r.querySelector("input").value) })).filter(p => p.cp > 0)
    });

    update();
  };

  const result = await DialogV2.wait({
    window: { title: t("Buy.Title", { item: item.name }), icon: "fa-solid fa-cart-shopping" },
    classes: ["shop-window-dialog"],
    position: { width: 460 },
    content,
    render,
    rejectClose: false,
    buttons: [
      { action: "buy", label: t("Button.Buy"), icon: "fa-solid fa-cart-shopping", default: true, callback: () => readState() },
      { action: "cancel", label: t("Button.Cancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
  if (!result) return;
  // Merge pitch-in rows for the same user
  const merged = new Map();
  for (const p of result.pitchIns) merged.set(p.userId, (merged.get(p.userId) ?? 0) + p.cp);
  result.pitchIns = [...merged].map(([userId, cp]) => ({ userId, cp }));
  requestPurchase({ shopUuid: shop.uuid, itemId: item.id, ...result });
}

/* -------------------------------------------- */
/*  Sell                                         */
/* -------------------------------------------- */

export async function sellDialog(shop, actor = null, item = null) {
  const cfg = shopConfig(shop);
  const actors = ownedActors(game.user, shop);
  if (!actors.length) return ui.notifications.warn(t("Notify.NoActors"));
  actor ??= actors[0];

  const itemOptions = (a, selected) => {
    const items = a.items.filter(i => isMerch(i) && (Number(i.system.quantity) || 0) > 0)
      .sort((x, y) => x.name.localeCompare(y.name));
    if (!items.length) return `<option value="">${t("Sell.NoItems")}</option>`;
    return items.map(i => `<option value="${i.id}" data-max="${i.system.quantity}" ${i === selected ? "selected" : ""}>${escape(i.name)}${i.system.quantity > 1 ? ` (×${i.system.quantity})` : ""}</option>`).join("");
  };
  const actorOptions = sel => actors.map(a => `<option value="${a.uuid}" ${a === sel ? "selected" : ""}>${escape(a.name)}</option>`).join("");

  const content = `
    <div class="sw-dialog">
      <p class="hint">${t("Sell.Intro", { shop: escape(shop.name) })}</p>
      <div class="form-group"><label>${t("Sell.From")}</label><select name="seller">${actorOptions(actor)}</select></div>
      <div class="form-group"><label>${t("Sell.Item")}</label><select name="item">${itemOptions(actor, item)}</select></div>
      <div class="form-group"><label>${t("Buy.Quantity")}</label><input type="number" name="qty" value="1" min="1" step="1"></div>
      <div class="form-group"><label>${t("Sell.Asking")}</label><input type="number" name="asking" min="0" step="0.01" placeholder="${t("Sell.AskingHint")}"></div>
      ${cfg.autoGold ? `<div class="form-group"><label>${t("Sell.PayTo")}</label><select name="payee">${actorOptions(actor)}</select></div>`
        : `<p class="hint">${t("Buy.ManualGold")}</p>`}
    </div>`;

  let readState = () => null;
  const render = (event, dialogOrEl) => {
    const root = rootOf(dialogOrEl) ?? rootOf(event?.target);
    if (!root) return;
    const form = root.querySelector("form") ?? root;
    const seller = form.querySelector("[name=seller]");
    const itemSel = form.querySelector("[name=item]");
    const qty = form.querySelector("[name=qty]");
    const payee = form.querySelector("[name=payee]");
    const confirm = root.querySelector('button[data-action="sell"]');
    const sync = () => {
      const max = Number(itemSel.selectedOptions[0]?.dataset.max) || 0;
      qty.max = max || 1;
      if (Number(qty.value) > max) qty.value = max || 1;
      if (confirm) confirm.disabled = !itemSel.value;
    };
    seller.addEventListener("change", () => {
      const a = fromUuidSync(seller.value);
      itemSel.innerHTML = itemOptions(a, null);
      if (payee) payee.value = seller.value;
      sync();
    });
    itemSel.addEventListener("change", sync);
    sync();
    readState = () => ({
      sellerUuid: seller.value,
      itemId: itemSel.value,
      qty: Math.max(1, Math.floor(Number(qty.value) || 1)),
      askingCp: gpToCp(form.querySelector("[name=asking]").value),
      payeeUuid: payee?.value ?? seller.value
    });
  };

  const result = await DialogV2.wait({
    window: { title: t("Sell.Title", { shop: shop.name }), icon: "fa-solid fa-hand-holding-dollar" },
    classes: ["shop-window-dialog"],
    position: { width: 420 },
    content, render, rejectClose: false,
    buttons: [
      { action: "sell", label: t("Button.Offer"), icon: "fa-solid fa-hand-holding-dollar", default: true, callback: () => readState() },
      { action: "cancel", label: t("Button.Cancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
  if (!result?.itemId) return;
  requestSale({ shopUuid: shop.uuid, ...result });
}
