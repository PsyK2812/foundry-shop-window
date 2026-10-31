import { ShopWindow } from "./shop-app.mjs";
import { buyDialog, sellDialog } from "./dialogs.mjs";
import { MODULE_ID, resolve, shopConfig, t } from "./shop.mjs";
import { broadcast, registerSocket } from "./transactions.mjs";

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, { scope: "world", config: true, ...data });
  reg("defaultAutoGold", {
    name: "SHOPWINDOW.Settings.AutoGold.Name", hint: "SHOPWINDOW.Settings.AutoGold.Hint",
    type: Boolean, default: true
  });
  reg("defaultRequireApproval", {
    name: "SHOPWINDOW.Settings.Approval.Name", hint: "SHOPWINDOW.Settings.Approval.Hint",
    type: Boolean, default: true
  });
  reg("hideNewItems", {
    name: "SHOPWINDOW.Settings.HideNew.Name", hint: "SHOPWINDOW.Settings.HideNew.Hint",
    type: Boolean, default: true, onChange: () => ShopWindow.instances.forEach(a => a.render())
  });
  reg("chatMessages", {
    name: "SHOPWINDOW.Settings.Chat.Name", hint: "SHOPWINDOW.Settings.Chat.Hint",
    type: Boolean, default: true
  });
});

/** Open a shop for the current user. Accepts an Actor, uuid or actor id. */
function openShop(actorOrUuid) {
  let shop = actorOrUuid;
  if (typeof shop === "string") shop = resolve(shop) ?? game.actors.get(shop) ?? game.actors.getName(shop);
  if (!(shop instanceof Actor)) return ui.notifications.warn(t("Notify.NoShop"));
  if (!game.user.isGM && !shopConfig(shop).open) return ui.notifications.warn(t("Notify.ShopClosed"));
  return ShopWindow.open(shop);
}

/* -------------------------------------------- */
/*  "Back to the shop" button for players        */
/* -------------------------------------------- */

/** Show a floating button for every open shop whose window the player has closed. */
function refreshReopenBar() {
  if (!game.ready) return;
  if (game.user.isGM) return refreshGMBar();
  let bar = document.getElementById("shop-window-reopen");
  const closed = game.actors.filter(a => shopConfig(a).open && !ShopWindow.instances.has(a.uuid));
  if (!closed.length) return bar?.remove();
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "shop-window-reopen";
    document.body.append(bar);
  }
  bar.replaceChildren(...closed.map(shop => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<img src="${shop.img}" alt=""><span>${t("Button.Reopen", { shop: foundry.utils.escapeHTML?.(shop.name) ?? shop.name })}</span>`;
    btn.addEventListener("click", () => ShopWindow.open(shop));
    return btn;
  }));
}
/* -------------------------------------------- */
/*  GM overview of open shops                    */
/* -------------------------------------------- */

const openShops = () => game.actors.filter(a => shopConfig(a).open).sort((a, b) => a.name.localeCompare(b.name));

async function closeShop(shop) {
  await shop.setFlag(MODULE_ID, "open", false);
  broadcast({ action: "close", shopUuid: shop.uuid });
}

async function closeAllShops() {
  for (const shop of openShops()) await closeShop(shop);
  ui.notifications.info(t("Notify.AllClosed"));
}

let gmPanelExpanded = false;

function refreshGMBar() {
  let bar = document.getElementById("shop-window-gm");
  const shops = openShops();
  if (!shops.length) { gmPanelExpanded = false; return bar?.remove(); }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "shop-window-gm";
    document.body.append(bar);
  }
  const esc = s => foundry.utils.escapeHTML?.(s) ?? s;
  bar.classList.toggle("expanded", gmPanelExpanded);
  bar.innerHTML = `
    <button type="button" class="sw-gm-pill" data-sw="toggle">
      <i class="fa-solid fa-store"></i> ${t(shops.length === 1 ? "GMBar.OneOpen" : "GMBar.ManyOpen", { n: shops.length })}
      <i class="fa-solid ${gmPanelExpanded ? "fa-chevron-up" : "fa-chevron-down"}"></i>
    </button>
    <div class="sw-gm-panel">
      ${shops.map(s => `
        <div class="sw-gm-shop" data-uuid="${s.uuid}">
          <img src="${s.img}" alt="">
          <span>${esc(s.name)}</span>
          <button type="button" data-sw="manage" data-tooltip="${t("GMBar.Manage")}"><i class="fa-solid fa-store"></i></button>
          <button type="button" data-sw="close" data-tooltip="${t("Button.CloseForPlayers")}"><i class="fa-solid fa-door-closed"></i></button>
        </div>`).join("")}
      <button type="button" class="sw-close-all" data-sw="closeAll"><i class="fa-solid fa-door-closed"></i> ${t("GMBar.CloseAll")}</button>
    </div>`;
  bar.onclick = ev => {
    const btn = ev.target.closest("[data-sw]");
    if (!btn) return;
    const shop = fromUuidSync(btn.closest("[data-uuid]")?.dataset.uuid ?? "");
    switch (btn.dataset.sw) {
      case "toggle": gmPanelExpanded = !gmPanelExpanded; return refreshGMBar();
      case "manage": return shop && ShopWindow.open(shop);
      case "close": return shop && closeShop(shop);
      case "closeAll": return closeAllShops();
    }
  };
}

Hooks.on(`${MODULE_ID}.windowChanged`, () => setTimeout(refreshReopenBar, 0));

Hooks.once("ready", () => {
  registerSocket();
  game.modules.get(MODULE_ID).api = { open: openShop, closeAll: closeAllShops, openShops, buyDialog, sellDialog, ShopWindow };
  if (game.user.isGM) refreshGMBar();

  // Players reconnecting while a shop is open get it back
  if (!game.user.isGM) {
    for (const actor of game.actors) if (shopConfig(actor).open) ShopWindow.open(actor);
    refreshReopenBar();
  }
});

/* Socket-driven open/close for players */
Hooks.on(`${MODULE_ID}.open`, uuid => {
  if (game.user.isGM) return;
  const shop = resolve(uuid);
  if (shop) ShopWindow.open(shop);
});
Hooks.on(`${MODULE_ID}.close`, uuid => {
  if (game.user.isGM) return;
  ShopWindow.instances.get(uuid)?.close();
});

/* Keep windows live */
Hooks.on("updateActor", (actor, changes) => {
  const app = ShopWindow.instances.get(actor.uuid);
  const openChange = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.open`);
  if (openChange !== undefined || foundry.utils.hasProperty(changes, "name") || foundry.utils.hasProperty(changes, "img")) {
    setTimeout(refreshReopenBar, 0);
  }
  if (!game.user.isGM && openChange === false) return app?.close();
  if (!game.user.isGM && openChange === true && !app) return ShopWindow.open(actor);
  app?.render();
});
for (const hook of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, item => { if (item.parent instanceof Actor) ShopWindow.rerender(item.parent); });
}
Hooks.on("deleteActor", actor => { ShopWindow.instances.get(actor.uuid)?.close(); setTimeout(refreshReopenBar, 0); });

/* Header button on actor sheets (GM only) */
function addHeaderControl(app, controls) {
  if (!game.user.isGM) return;
  const actor = app.document ?? app.actor;
  if (!(actor instanceof Actor)) return;
  if (controls.some(c => c.action === "shopWindowOpen")) return;
  app.options.actions ??= {};
  app.options.actions.shopWindowOpen = () => ShopWindow.open(actor);
  controls.push({
    action: "shopWindowOpen",
    icon: "fa-solid fa-store",
    label: "SHOPWINDOW.Button.OpenShop",
    onClick: () => ShopWindow.open(actor)
  });
}
Hooks.on("getHeaderControlsActorSheetV2", addHeaderControl);

/* Right-click in the Actors sidebar */
function addContextOption(app, options) {
  options.push({
    name: "SHOPWINDOW.Button.OpenShop",
    label: "SHOPWINDOW.Button.OpenShop",
    icon: '<i class="fa-solid fa-store"></i>',
    condition: () => game.user.isGM,
    callback: li => {
      const el = li instanceof HTMLElement ? li : li?.[0];
      const id = el?.dataset.entryId ?? el?.dataset.documentId;
      const actor = game.actors.get(id);
      if (actor) ShopWindow.open(actor);
    }
  });
}
Hooks.on("getActorContextOptions", addContextOption);
Hooks.on("getActorDirectoryEntryContext", addContextOption);
