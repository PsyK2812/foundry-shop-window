# Shop Window

A Foundry VTT module (v13–v14, dnd5e 5.x–6.x) that opens a market-stall style shop window for your players.

## Setting up a shop

1. Create an actor for the merchant (an NPC works well). Its portrait appears at the top of the stall.
2. Put the merchandise in the merchant's inventory. Each item's **quantity** is the stock.
3. Open the shop in one of these ways: the **Open Shop Window** button in the header of the actor's sheet, right-click the actor in the Actors sidebar, or use this macro:
   ```js
   game.modules.get("shop-window").api.open("Oleg's Trading Post"); // name, id or uuid
   ```
4. Click **Reveal** (the eye icon) on the items the players may see, or use **Reveal all**. New items start hidden. You can change that in the module settings.
5. Click **Open for players**. The shop pops up for every player and reopens for players who reconnect. **Close for players** closes it again.

You can drag items from the sidebar, a compendium or another sheet onto the window to add stock.

## GM controls

| Control | What it does |
|---|---|
| Eye icon | Hide or reveal one item |
| Stock box | Change the number in stock |
| ∞ | Unlimited stock |
| Tag % | Discount on that item. A negative value is a markup |
| Shop discount % | Discount on everything, multiplied with the item discount. A negative value is a markup |
| Automatic gold | Turn coin handling on or off for this shop |
| GM approves purchases | Each purchase waits for your Approve / Decline |
| Players can sell | Show or hide the sell button |
| Player view | See the shop exactly as the players do |

When players haggle, change the shop discount or the item discount. Players see the old price struck through next to the new price.

## Buying (players)

Click **Buy** next to an item to open the buy dialog:
- **Quantity**
- After the purchase is approved, a **Where should it go?** popup lets you pick the character (yours, the party, or another player's) and the container. Nothing is charged until you choose; cancelling it cancels the purchase.
- **Payment**: split the price across all your characters, e.g. 200 gp from A and 200 gp from B. The arrow button puts the rest on one character.
- **Ask another player to pitch in**: pick an online player and an amount. They get a popup, choose which of their characters pays, and accept or decline.

The GM gets an approval window that shows the full breakdown. When the GM approves, the coins are taken (with change made automatically), the item goes into the chosen inventory, the stock drops by the amount bought and a chat message is posted.

## Selling (players)

Click **Sell an item**, or drag an item from your sheet onto the shop window. Choose the item and quantity, optionally an asking price, and which character receives the coins. The GM types in what the merchant pays. The item moves into the merchant's stock as a hidden item.

## Notes

- A GM has to be online to trade, because all changes run on the GM's client.
- Pitch-in requests expire after 3 minutes.
- Item prices come from the dnd5e price field (value + denomination).
