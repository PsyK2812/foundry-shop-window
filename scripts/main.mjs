import { ShopWindow } from "./shop-app.mjs";
import { buyDialog, sellDialog } from "./dialogs.mjs";
import { MODULE_ID, resolve, shopConfig, t } from "./shop.mjs";
import { registerSocket } from "./transactions.mjs";

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

Hooks.once("ready", () => {
  registerSocket();
  game.modules.get(MODULE_ID).api = { open: openShop, buyDialog, sellDialog, ShopWindow };

  // Players reconnecting while a shop is open get it back
  if (!game.user.isGM) {
    for (const actor of game.actors) if (shopConfig(actor).open) ShopWindow.open(actor);
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
  if (!game.user.isGM && openChange === false) return app?.close();
  if (!game.user.isGM && openChange === true && !app) return ShopWindow.open(actor);
  app?.render();
});
for (const hook of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, item => { if (item.parent instanceof Actor) ShopWindow.rerender(item.parent); });
}
Hooks.on("deleteActor", actor => ShopWindow.instances.get(actor.uuid)?.close());

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
