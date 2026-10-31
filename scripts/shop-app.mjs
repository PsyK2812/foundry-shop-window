import { formatCp } from "./currency.mjs";
import { buyDialog, sellDialog } from "./dialogs.mjs";
import {
  MODULE_ID, baseUnitCp, isMerch, itemConfig, priceCp, shopConfig, stockOf, t
} from "./shop.mjs";
import { broadcast } from "./transactions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditorImpl = () => foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor;

export class ShopWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, ShopWindow>} open windows by shop uuid */
  static instances = new Map();

  constructor(shop, options = {}) {
    super({ ...options, id: `shop-window-${shop.uuid.replace(/\./g, "-")}` });
    this.shop = shop;
    this.gmView = game.user.isGM;
    this.expanded = new Set();
  }

  static DEFAULT_OPTIONS = {
    classes: ["shop-window"],
    tag: "div",
    window: { icon: "fa-solid fa-store", resizable: true },
    position: { width: 640, height: 760 },
    actions: {
      buy: ShopWindow.#onBuy,
      sell: ShopWindow.#onSell,
      toggleExpand: ShopWindow.#onToggleExpand,
      toggleHidden: ShopWindow.#onToggleHidden,
      toggleUnlimited: ShopWindow.#onToggleUnlimited,
      revealAll: ShopWindow.#onRevealAll,
      hideAll: ShopWindow.#onHideAll,
      openPlayers: ShopWindow.#onOpenPlayers,
      closePlayers: ShopWindow.#onClosePlayers,
      togglePlayerView: ShopWindow.#onTogglePlayerView,
      openSheet: ShopWindow.#onOpenSheet
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/shop.hbs`, scrollable: [".sw-items"] }
  };

  get title() {
    return this.shop.name;
  }

  /** Open (or bring to front) the window for a shop. */
  static open(shop) {
    if (!shop) return null;
    let app = ShopWindow.instances.get(shop.uuid);
    if (!app) {
      app = new ShopWindow(shop);
      ShopWindow.instances.set(shop.uuid, app);
    }
    app.render({ force: true });
    if (app.rendered) app.bringToFront?.();
    return app;
  }

  static rerender(shop) {
    ShopWindow.instances.get(shop?.uuid)?.render();
  }

  async close(options) {
    ShopWindow.instances.delete(this.shop.uuid);
    return super.close(options);
  }

  async _prepareContext() {
    const shop = this.shop;
    const cfg = shopConfig(shop);
    const gmView = this.gmView;
    const TE = TextEditorImpl();
    const items = [];
    const merch = shop.items.filter(isMerch).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
    for (const item of merch) {
      const ic = itemConfig(item);
      if (ic.hidden && !gmView) continue;
      const base = baseUnitCp(item);
      const final = priceCp(shop, item, 1);
      const expanded = this.expanded.has(item.id);
      let description = "";
      if (expanded) {
        description = await TE.enrichHTML(item.system.description?.value ?? "", {
          secrets: game.user.isGM && gmView, relativeTo: item, rollData: item.getRollData?.() ?? {}
        });
        if (!description.trim()) description = `<p class="sw-muted">${t("Label.NoDescription")}</p>`;
      }
      items.push({
        id: item.id,
        name: item.name,
        img: item.img,
        typeLabel: game.i18n.localize(CONFIG.Item.typeLabels?.[item.type] ?? item.type),
        quantity: item.system.quantity,
        hidden: ic.hidden,
        unlimited: ic.unlimited,
        discount: ic.discount,
        soldOut: stockOf(item) <= 0,
        basePrice: formatCp(base),
        finalPrice: formatCp(final),
        discounted: final !== base,
        expanded,
        description
      });
    }
    let discountText = "";
    let discountClass = "";
    if (cfg.discount > 0) { discountText = t("Label.SaleBadge", { pct: cfg.discount }); discountClass = "sale"; }
    else if (cfg.discount < 0) { discountText = t("Label.MarkupBadge", { pct: -cfg.discount }); discountClass = "markup"; }
    return { shop, cfg, items, gmView, isGM: game.user.isGM, discountText, discountClass };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    // GM inputs
    el.querySelectorAll("input[name]").forEach(input => input.addEventListener("change", ev => this.#onInput(ev)));
    // Drag & drop: GM adds stock, players offer items for sale
    if (!this._dropBound) {
      this._dropBound = true;
      el.addEventListener("dragover", ev => ev.preventDefault());
      el.addEventListener("drop", ev => this.#onDrop(ev));
    }
  }

  async #onInput(event) {
    if (!game.user.isGM) return;
    const input = event.currentTarget;
    const itemId = input.closest("[data-item-id]")?.dataset.itemId;
    const item = itemId ? this.shop.items.get(itemId) : null;
    const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    switch (input.name) {
      case "shopDiscount": return this.shop.setFlag(MODULE_ID, "discount", Math.min(100, num(input.value)));
      case "autoGold": return this.shop.setFlag(MODULE_ID, "autoGold", input.checked);
      case "requireApproval": return this.shop.setFlag(MODULE_ID, "requireApproval", input.checked);
      case "allowSelling": return this.shop.setFlag(MODULE_ID, "allowSelling", input.checked);
      case "stock": return item?.update({ "system.quantity": Math.max(0, Math.floor(num(input.value))) });
      case "itemDiscount": return item?.setFlag(MODULE_ID, "discount", Math.min(100, num(input.value)));
    }
  }

  async #onDrop(event) {
    event.preventDefault();
    const TE = TextEditorImpl();
    let data;
    try { data = TE.getDragEventData(event); } catch { return; }
    if (data?.type !== "Item") return;
    const item = await Item.implementation.fromDropData(data);
    if (!item || !isMerch(item)) return ui.notifications.warn(t("Notify.NotMerch"));
    if (item.parent === this.shop) return;

    // A player dropping their own item = offer it for sale
    if (item.parent instanceof Actor && item.parent.isOwner && (!game.user.isGM || !this.gmView)) {
      if (!shopConfig(this.shop).allowSelling) return ui.notifications.warn(t("Error.NoSelling"));
      return sellDialog(this.shop, item.parent, item);
    }
    if (!game.user.isGM) return;
    const itemData = item.toObject();
    delete itemData._id;
    if ("container" in (itemData.system ?? {})) itemData.system.container = null;
    await this.shop.createEmbeddedDocuments("Item", [itemData]);
  }

  /* ---------------- actions ---------------- */

  static #item(target) {
    return this.shop.items.get(target.closest("[data-item-id]")?.dataset.itemId);
  }

  static async #onBuy(event, target) {
    const item = ShopWindow.#item.call(this, target);
    if (item) buyDialog(this.shop, item);
  }

  static async #onSell() {
    sellDialog(this.shop);
  }

  static #onToggleExpand(event, target) {
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    if (!id) return;
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
    this.render();
  }

  static async #onToggleHidden(event, target) {
    const item = ShopWindow.#item.call(this, target);
    if (item) await item.setFlag(MODULE_ID, "hidden", !itemConfig(item).hidden);
  }

  static async #onToggleUnlimited(event, target) {
    const item = ShopWindow.#item.call(this, target);
    if (item) await item.setFlag(MODULE_ID, "unlimited", !itemConfig(item).unlimited);
  }

  static async #setAllHidden(hidden) {
    const updates = this.shop.items.filter(isMerch).map(i => ({ _id: i.id, [`flags.${MODULE_ID}.hidden`]: hidden }));
    await this.shop.updateEmbeddedDocuments("Item", updates);
  }

  static #onRevealAll() { return ShopWindow.#setAllHidden.call(this, false); }
  static #onHideAll() { return ShopWindow.#setAllHidden.call(this, true); }

  static async #onOpenPlayers() {
    await this.shop.setFlag(MODULE_ID, "open", true);
    broadcast({ action: "open", shopUuid: this.shop.uuid });
    ui.notifications.info(t("Notify.Opened", { shop: this.shop.name }));
  }

  static async #onClosePlayers() {
    await this.shop.setFlag(MODULE_ID, "open", false);
    broadcast({ action: "close", shopUuid: this.shop.uuid });
  }

  static #onTogglePlayerView() {
    this.gmView = !this.gmView;
    this.render();
  }

  static #onOpenSheet() {
    this.shop.sheet.render(true);
  }
}
