import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadMenu, mergeLines, priceTicket, storeStatus } from "../src/menu.mjs";

const menu = loadMenu(fileURLToPath(new URL("../menu/menu.json", import.meta.url)));
const price = (items, extra = {}) => priceTicket(menu, { order_type: "pickup", items, ...extra });
const unit = (line, extra) => {
  const p = price([line], extra);
  assert.deepEqual(p.errors, []);
  return p.lines[0].unit_cents;
};

test("specialty and build-your-own base prices come from the menu", () => {
  assert.equal(unit({ item: "pepperoni", size: "large" }), 1699);
  assert.equal(unit({ item: "cheese", size: "small" }), 999);
});

test("added toppings cost the size's topping price, and extra counts as two", () => {
  assert.equal(unit({ item: "cheese", size: "medium", toppings: ["pepperoni"] }), 1299 + 175);
  assert.equal(unit({ item: "cheese", size: "medium", toppings: [{ id: "pepperoni", amount: "extra" }] }), 1299 + 350);
  assert.equal(unit({ item: "cheese", size: "medium", toppings: [{ id: "pepperoni", amount: "light" }] }), 1299 + 175);
});

test("half toppings are charged at the full topping price", () => {
  assert.equal(unit({ item: "cheese", size: "large", toppings: [{ id: "pepperoni", placement: "left" }, { id: "mushrooms", placement: "right" }] }), 1499 + 400);
});

test("included toppings: removing is free, extra costs one topping", () => {
  assert.equal(unit({ item: "supreme", size: "medium", remove: ["black_olives"] }), 1749);
  assert.equal(unit({ item: "supreme", size: "medium", toppings: [{ id: "mushrooms", amount: "extra" }] }), 1749 + 175);
});

test("crust upcharges, extra cheese and sauce changes", () => {
  assert.equal(unit({ item: "cheese", size: "medium", crust: "deep_dish" }), 1299 + 150);
  assert.equal(unit({ item: "cheese", size: "small", crust: "gluten_free" }), 999 + 200);
  assert.equal(unit({ item: "cheese", size: "large", cheese: "extra" }), 1499 + 200);
  assert.equal(unit({ item: "cheese", size: "large", sauce: "garlic_parmesan", sauce_amount: "extra" }), 1499);
});

test("menu constraints are reported as errors", () => {
  const errors = (line) => price([line]).errors.join("\n");
  assert.match(errors({ item: "cheese", size: "small", crust: "deep_dish" }), /Deep dish is not made in size "small"/);
  assert.match(errors({ item: "cheese", size: "large", crust: "gluten_free" }), /not made in size "large"/);
  assert.match(errors({ item: "cheese", size: "huge" }), /size "huge" is not on the menu/);
  assert.match(errors({ item: "cheese", size: "large", toppings: ["gummy_bears"] }), /topping "gummy_bears" is not on the menu/);
  assert.match(errors({ item: "pepperoni", size: "large", remove: ["onions"] }), /cannot remove "onions"/);
  assert.match(errors({ item: "cheese", size: "large", toppings: ["ham", "ham"] }), /listed twice/);
  assert.match(errors({ item: "wings", size: "8pc" }), /needs wing_sauce/);
  assert.match(errors({ item: "soda_2l", options: { flavor: "orange" } }), /needs flavor/);
  assert.match(errors({ item: "lobster" }), /"lobster" is not on the menu/);
  assert.match(errors({ item: "cheese", size: "large", quantity: 0 }), /quantity must be a whole number/);
});

test("deals: price, topping allowance, upcharges and composition", () => {
  const deal = (components, order = {}) => price([{ deal: "two_medium_two_topping", components }], order);
  const ok = deal([{ item: "cheese", size: "medium", toppings: ["pepperoni", "mushrooms"] }, { item: "cheese", size: "medium" }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.subtotal_cents, 1999);
  const third = deal([{ item: "cheese", size: "medium", toppings: ["pepperoni", "bacon", "jalapenos"] }, { item: "cheese", size: "medium" }]);
  assert.equal(third.subtotal_cents, 1999 + 175);
  const extra = deal([{ item: "cheese", size: "medium", toppings: [{ id: "pepperoni", amount: "extra" }, "ham"] }, { item: "cheese", size: "medium", crust: "deep_dish" }]);
  assert.equal(extra.subtotal_cents, 1999 + 175 + 150);
  assert.match(deal([{ item: "supreme", size: "medium" }, { item: "supreme", size: "medium" }]).errors.join(), /must contain exactly 2 x medium cheese/);
  assert.match(deal([{ item: "cheese", size: "large" }, { item: "cheese", size: "medium" }]).errors.join(), /must contain exactly/);
  assert.match(deal([{ item: "cheese", size: "medium" }]).errors.join(), /must contain exactly/);
});

test("the carryout deal is rejected for delivery", () => {
  const p = priceTicket(menu, { order_type: "delivery", delivery_zip: "43206", items: [{ deal: "large_specialty_carryout", components: [{ item: "supreme", size: "large" }] }] });
  assert.match(p.errors.join(), /not available for delivery/);
});

test("tax is rounded half up on the subtotal, and the delivery fee is not taxed", () => {
  const pickup = price([{ item: "pepperoni", size: "large" }]);
  assert.equal(pickup.tax_cents, 127); // 1699 * 7.5% = 127.425
  assert.equal(pickup.total_cents, 1826);
  const delivery = priceTicket(menu, { order_type: "delivery", delivery_zip: "43201", items: [{ item: "cheese", size: "medium" }, { item: "garlic_knots" }] });
  assert.equal(delivery.subtotal_cents, 1898);
  assert.equal(delivery.tax_cents, 142);
  assert.equal(delivery.delivery_fee_cents, 399);
  assert.equal(delivery.total_cents, 1898 + 399 + 142);
  const half = price([{ item: "water", quantity: 2 }, { item: "ranch_dip", quantity: 2 }]); // 556 * 7.5% = 41.7
  assert.equal(half.tax_cents, 42);
});

test("equivalent ways of writing the same order compare equal", () => {
  const a = price([{ item: "pepperoni", size: "large" }, { item: "pepperoni", size: "large" }]);
  const b = price([{ item: "pepperoni", size: "large", crust: "hand_tossed", sauce: "marinara", sauce_amount: "regular", cheese: "regular", toppings: [{ id: "pepperoni", placement: "whole", amount: "regular" }], quantity: 2 }]);
  assert.deepEqual([...mergeLines(a.lines).keys()], [...mergeLines(b.lines).keys()]);
  assert.equal(mergeLines(a.lines).values().next().value.quantity, 2);
  const d1 = price([{ deal: "two_medium_two_topping", components: [{ item: "cheese", size: "medium", toppings: ["ham"] }, { item: "cheese", size: "medium", toppings: ["onions", "bacon"] }] }]);
  const d2 = price([{ deal: "two_medium_two_topping", components: [{ item: "cheese", size: "medium", toppings: ["bacon", "onions"] }, { item: "cheese", size: "medium", toppings: [{ id: "ham" }] }] }]);
  assert.equal(d1.lines[0].key, d2.lines[0].key);
});

test("a ticket that is not an object, has no items or no delivery ZIP is invalid", () => {
  assert.deepEqual(priceTicket(menu, null).errors, ["ticket must be an object"]);
  assert.match(priceTicket(menu, { order_type: "pickup", items: [] }).errors.join(), /no items/);
  assert.match(priceTicket(menu, { order_type: "delivery", items: [{ item: "water" }] }).errors.join(), /needs delivery_zip/);
  assert.match(priceTicket(menu, { order_type: "dine_in", items: [{ item: "water" }] }).errors.join(), /order_type/);
});

test("store hours, including the next opening time", () => {
  assert.equal(storeStatus(menu, "2026-10-23T18:30:00-05:00").open, true);
  const late = storeStatus(menu, "2026-10-20T22:40:00-05:00");
  assert.equal(late.open, false);
  assert.equal(late.day, "tue");
  assert.equal(late.next_open, "10:30");
  assert.equal(storeStatus(menu, "2026-10-25T10:45:00-05:00").next_open, "11:00"); // Sunday opens at 11:00
  assert.equal(storeStatus(menu, "2026-10-24T22:30:00-05:00").open, true); // Saturday closes at 23:00
  assert.throws(() => storeStatus(menu, "tonight"), /context.now/);
});
