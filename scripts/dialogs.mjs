import { cpToGp, formatCp, gpToCp } from "./currency.mjs";
import {
  baseUnitCp, escape, isMerch, ownedActors, pitchInUsers, priceCp, shopConfig, stockOf, t, walletCp
} from "./shop.mjs";
import { requestPurchase, requestSale, requestTrade } from "./transactions.mjs";

const { DialogV2 } = foundry.applications.api;

/** DialogV2 passes (event, dialog) to render; older builds passed an element. */
function rootOf(arg) {
  if (arg instanceof HTMLElement) return arg;
  if (arg?.element instanceof HTMLElement) return arg.element;
  return arg?.[0] ?? null;
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
      <p class="hint"><i class="fa-solid fa-box-open"></i> ${t("Buy.DestinationLater")}</p>
    </div>`;

  let readState = () => null;

  const render = (event, dialogOrEl) => {
    const root = rootOf(dialogOrEl) ?? rootOf(event?.target);
    if (!root) return;
    const form = root.querySelector("form") ?? root;
    const qtyInput = form.querySelector("[name=qty]");
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
      if (!cfg.autoGold) { if (confirm) confirm.disabled = false; return; }
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
      remainingEl.className = `sw-remaining ${remaining === 0 ? "ok" : "bad"}`;
      remainingEl.textContent = remaining === 0 ? t("Buy.Covered")
        : remaining > 0 ? t("Buy.Remaining", { amount: formatCp(remaining) })
        : t("Buy.TooMuch", { amount: formatCp(-remaining) });
      if (confirm) confirm.disabled = !ok;
    };

    qtyInput.addEventListener("input", update);
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
/*  Shared: drag items in from your sheets       */
/* -------------------------------------------- */

/**
 * Wire a drop zone + list of offered items into a dialog.
 * @param {HTMLElement} root
 * @param {{item: Item, qty: number}[]} offered  mutated in place
 * @param {Actor} shop
 * @param {Function} onChange
 */
function offerPicker(root, offered, shop, onChange) {
  const list = root.querySelector(".sw-offer-list");
  const zone = root.querySelector(".sw-dropzone");

  const draw = () => {
    list.innerHTML = "";
    for (const o of offered) {
      const max = Number(o.item.system.quantity) || 1;
      const row = document.createElement("div");
      row.className = "sw-offer-row";
      row.innerHTML = `<img src="${o.item.img}" alt="">
        <span class="sw-pay-name">${escape(o.item.name)}<small>${escape(o.item.parent.name)} · ${t("Trade.Listed", { price: formatCp(baseUnitCp(o.item)) })}${max > 1 ? ` · ×${max}` : ""}</small></span>
        <input type="number" min="1" max="${max}" step="1" value="${o.qty}" ${max <= 1 ? "disabled" : ""} data-tooltip="${t("Buy.Quantity")}">
        <button type="button" class="sw-mini" data-tooltip="${t("Buy.Remove")}"><i class="fa-solid fa-trash"></i></button>`;
      row.querySelector("input").addEventListener("input", ev => {
        o.qty = Math.min(max, Math.max(1, Math.floor(Number(ev.target.value) || 1)));
        onChange();
      });
      row.querySelector("button").addEventListener("click", () => {
        offered.splice(offered.indexOf(o), 1);
        draw();
      });
      list.append(row);
    }
    zone.classList.toggle("has-items", offered.length > 0);
    onChange();
  };

  const onDrop = async ev => {
    ev.preventDefault();
    ev.stopPropagation();
    zone.classList.remove("over");
    const TE = foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    let data;
    try { data = TE.getDragEventData(ev); } catch { return; }
    if (data?.type !== "Item") return;
    const dropped = await Item.implementation.fromDropData(data);
    if (!dropped || !(dropped.parent instanceof Actor) || dropped.parent === shop || !dropped.parent.isOwner) {
      return ui.notifications.warn(t("Trade.OwnItemsOnly"));
    }
    if (!isMerch(dropped) || (Number(dropped.system.quantity) || 0) < 1) return ui.notifications.warn(t("Notify.NotMerch"));
    if (offered.some(o => o.item === dropped)) return;
    offered.push({ item: dropped, qty: 1 });
    draw();
  };
  root.addEventListener("dragover", ev => { ev.preventDefault(); zone.classList.add("over"); });
  root.addEventListener("dragleave", ev => { if (!root.contains(ev.relatedTarget)) zone.classList.remove("over"); });
  root.addEventListener("drop", onDrop);
  draw();
}

const offerFieldset = legend => `
  <fieldset class="sw-offer"><legend>${legend}</legend>
    <div class="sw-offer-list"></div>
    <div class="sw-dropzone"><i class="fa-solid fa-hand-holding-hand"></i> ${t("Trade.DropHere")}</div>
    <div class="sw-values"></div>
  </fieldset>`;

/* -------------------------------------------- */
/*  Sell                                         */
/* -------------------------------------------- */

export async function sellDialog(shop, actor = null, item = null) {
  const cfg = shopConfig(shop);
  const actors = ownedActors(game.user, shop);
  if (!actors.length) return ui.notifications.warn(t("Notify.NoActors"));

  /** @type {{item: Item, qty: number}[]} */
  const offered = item ? [{ item, qty: 1 }] : [];
  const payeeOptions = `<option value="" selected disabled>${t("Sell.ChoosePayee")}</option>` +
    actors.map(a => `<option value="${a.uuid}">${escape(a.name)}</option>`).join("");

  const content = `
    <div class="sw-dialog">
      <p class="hint">${t("Sell.Intro", { shop: escape(shop.name) })}</p>
      ${offerFieldset(t("Sell.Offer"))}
      <div class="form-group"><label>${t("Sell.Asking")}</label><input type="number" name="asking" min="0" step="0.01" placeholder="${t("Sell.AskingHint")}"></div>
      ${cfg.autoGold ? `<div class="form-group"><label>${t("Sell.PayTo")}</label><select name="payee">${payeeOptions}</select></div>`
        : `<p class="hint">${t("Buy.ManualGold")}</p>`}
      <div class="form-group stacked"><label>${t("Trade.Note")}</label>
        <textarea name="note" placeholder="${t("Sell.NoteHint")}"></textarea></div>
    </div>`;

  let readState = () => null;
  const render = (event, dialogOrEl) => {
    const root = rootOf(dialogOrEl) ?? rootOf(event?.target);
    if (!root) return;
    const payee = root.querySelector("[name=payee]");
    const values = root.querySelector(".sw-values");
    const confirm = root.querySelector('button[data-action="sell"]');
    const update = () => {
      const cp = offered.reduce((s, o) => s + baseUnitCp(o.item) * o.qty, 0);
      values.textContent = offered.length ? t("Sell.Value", { value: formatCp(cp) }) : "";
      if (confirm) confirm.disabled = !offered.length || (payee && !payee.value);
    };
    payee?.addEventListener("change", update);
    offerPicker(root, offered, shop, update);
    readState = () => offered.length ? {
      offered: offered.map(o => ({ actorUuid: o.item.parent.uuid, itemId: o.item.id, qty: o.qty })),
      askingCp: gpToCp(root.querySelector("[name=asking]").value),
      payeeUuid: payee?.value || null,
      note: root.querySelector("[name=note]").value.trim()
    } : null;
  };

  const result = await DialogV2.wait({
    window: { title: t("Sell.Title", { shop: shop.name }), icon: "fa-solid fa-hand-holding-dollar" },
    classes: ["shop-window-dialog"],
    position: { width: 460 },
    content, render, rejectClose: false,
    buttons: [
      { action: "sell", label: t("Button.Offer"), icon: "fa-solid fa-hand-holding-dollar", default: true, callback: () => readState() },
      { action: "cancel", label: t("Button.Cancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
  if (!result) return;
  requestSale({ shopUuid: shop.uuid, ...result });
}

/* -------------------------------------------- */
/*  Trade                                        */
/* -------------------------------------------- */

export async function tradeDialog(shop, item) {
  const stock = stockOf(item);
  if (stock <= 0) return ui.notifications.warn(t("Error.NotEnoughStock", { item: item.name }));
  const maxQty = Number.isFinite(stock) ? stock : 999;
  const wantedUnit = baseUnitCp(item);

  /** @type {{item: Item, qty: number}[]} */
  const offered = [];

  const content = `
    <div class="sw-dialog">
      <div class="sw-approval-item"><img src="${item.img}"><div>
        <strong>${escape(item.name)}</strong><br>
        <span>${t("Trade.Worth", { price: formatCp(wantedUnit) })}</span>
      </div></div>
      <div class="form-group"><label>${t("Buy.Quantity")}</label>
        <input type="number" name="qty" value="1" min="1" max="${maxQty}" step="1"></div>
      ${offerFieldset(t("Trade.Offer"))}
      <div class="form-group stacked"><label>${t("Trade.Note")}</label>
        <textarea name="note" placeholder="${t("Trade.NoteHint")}"></textarea></div>
      <p class="hint"><i class="fa-solid fa-scale-balanced"></i> ${t("Trade.NeedsApproval")}</p>
    </div>`;

  let readState = () => null;
  const render = (event, dialogOrEl) => {
    const root = rootOf(dialogOrEl) ?? rootOf(event?.target);
    if (!root) return;
    const qtyInput = root.querySelector("[name=qty]");
    const values = root.querySelector(".sw-values");
    const confirm = root.querySelector('button[data-action="trade"]');

    const qty = () => Math.min(maxQty, Math.max(1, Math.floor(Number(qtyInput.value) || 1)));
    const update = () => {
      const offerCp = offered.reduce((s, o) => s + baseUnitCp(o.item) * o.qty, 0);
      values.textContent = t("Trade.Values", { offer: formatCp(offerCp), wanted: formatCp(wantedUnit * qty()) });
      if (confirm) confirm.disabled = !offered.length;
    };
    offerPicker(root, offered, shop, update);
    qtyInput.addEventListener("input", update);

    readState = () => offered.length ? {
      qty: qty(),
      offered: offered.map(o => ({ actorUuid: o.item.parent.uuid, itemId: o.item.id, qty: o.qty })),
      note: root.querySelector("[name=note]").value.trim()
    } : null;
  };

  const result = await DialogV2.wait({
    window: { title: t("Trade.Title", { item: item.name }), icon: "fa-solid fa-right-left" },
    classes: ["shop-window-dialog"],
    position: { width: 460 },
    content, render, rejectClose: false,
    buttons: [
      { action: "trade", label: t("Button.OfferTrade"), icon: "fa-solid fa-right-left", default: true, callback: () => readState() },
      { action: "cancel", label: t("Button.Cancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
  if (!result) return;
  requestTrade({ shopUuid: shop.uuid, itemId: item.id, ...result });
}
