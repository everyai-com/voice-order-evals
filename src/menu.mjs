// Menu model and pricing: turns a ticket into canonical line items and recomputes every
// price from menu/menu.json. All money is handled in integer cents.
import { readFileSync } from "node:fs";

export const cents = (dollars) => Math.round(Number(dollars) * 100);
export const money = (c) => `$${(c / 100).toFixed(2)}`;

export function loadMenu(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const defaultCrust = (menu) => Object.keys(menu.crusts).find((id) => menu.crusts[id].default);
const defaultSauce = (menu) => Object.keys(menu.sauces).find((id) => menu.sauces[id].default);
const priceFor = (price, size) => (typeof price === "number" ? price : price?.[size]);
const toppingCents = (menu, size) => cents(menu.topping_price[size]);

function quantityOf(line, label, errors) {
  const quantity = line.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    errors.push(`${label}: quantity must be a whole number of at least 1`);
    return 1;
  }
  return quantity;
}

function canonicalPizza(menu, line, label, errors) {
  const pizza = menu.pizzas[line.item];
  if (!pizza) {
    errors.push(`${label}: "${line.item}" is not a pizza on the menu`);
    return null;
  }
  const rules = menu.modifier_rules;
  const size = line.size;
  if (!menu.sizes[size]) errors.push(`${label}: size "${size}" is not on the menu`);
  const crust = line.crust ?? defaultCrust(menu);
  if (!menu.crusts[crust]) errors.push(`${label}: crust "${crust}" is not on the menu`);
  else if (!menu.crusts[crust].sizes.includes(size)) errors.push(`${label}: ${menu.crusts[crust].label} is not made in size "${size}"`);
  const sauce = line.sauce ?? pizza.sauce ?? defaultSauce(menu);
  if (!menu.sauces[sauce]) errors.push(`${label}: sauce "${sauce}" is not on the menu`);
  const sauceAmount = line.sauce_amount ?? "regular";
  if (!rules.sauce_amounts.includes(sauceAmount)) errors.push(`${label}: sauce_amount "${sauceAmount}" is not one of ${rules.sauce_amounts.join(", ")}`);
  const cheese = line.cheese ?? "regular";
  if (!rules.cheese_amounts.includes(cheese)) errors.push(`${label}: cheese "${cheese}" is not one of ${rules.cheese_amounts.join(", ")}`);

  const toppings = new Map(pizza.toppings.map((id) => [id, { id, placement: "whole", amount: "regular" }]));
  for (const id of line.remove ?? []) {
    if (!toppings.has(id)) errors.push(`${label}: cannot remove "${id}", it is not on a ${pizza.label}`);
    toppings.delete(id);
  }
  const seen = new Set();
  for (const entry of line.toppings ?? []) {
    const topping = typeof entry === "string" ? { id: entry } : entry;
    if (!isObject(topping) || !menu.toppings[topping.id]) {
      errors.push(`${label}: topping "${topping?.id ?? entry}" is not on the menu`);
      continue;
    }
    if (seen.has(topping.id)) errors.push(`${label}: topping "${topping.id}" is listed twice; use amount "extra" instead`);
    seen.add(topping.id);
    const placement = topping.placement ?? "whole";
    const amount = topping.amount ?? "regular";
    if (!rules.placements.includes(placement)) errors.push(`${label}: placement "${placement}" is not one of ${rules.placements.join(", ")}`);
    if (!rules.amounts.includes(amount)) errors.push(`${label}: amount "${amount}" is not one of ${rules.amounts.join(", ")}`);
    toppings.set(topping.id, { id: topping.id, placement, amount });
  }
  return {
    kind: "pizza",
    item: line.item,
    size,
    crust,
    sauce,
    sauce_amount: sauceAmount,
    cheese,
    toppings: [...toppings.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function canonicalItem(menu, line, label, errors) {
  const item = menu.items[line.item];
  if (!item) {
    errors.push(`${label}: "${line.item}" is not on the menu`);
    return null;
  }
  const canonical = { kind: "item", item: line.item };
  if (isObject(item.price)) {
    if (!Object.hasOwn(item.price, line.size ?? "")) errors.push(`${label}: ${item.label} needs a size, one of ${Object.keys(item.price).join(", ")}`);
    canonical.size = line.size;
  } else if (line.size !== undefined) {
    errors.push(`${label}: ${item.label} has no sizes`);
  }
  const options = {};
  const given = isObject(line.options) ? line.options : {};
  for (const [name, values] of Object.entries(item.options ?? {})) {
    if (!values.includes(given[name])) errors.push(`${label}: ${item.label} needs ${name}, one of ${values.join(", ")}`);
    options[name] = given[name];
  }
  for (const name of Object.keys(given)) if (!item.options?.[name]) errors.push(`${label}: ${item.label} has no option "${name}"`);
  canonical.options = options;
  return canonical;
}

function canonicalComponent(menu, component, label, errors) {
  if (!isObject(component)) {
    errors.push(`${label}: must be an object`);
    return null;
  }
  return menu.pizzas[component.item] ? canonicalPizza(menu, component, label, errors) : canonicalItem(menu, component, label, errors);
}

/** Assigns each deal component to the slot of the deal it fills. Returns slot specs aligned with components, or null. */
function assignDeal(deal, components) {
  const slots = deal.components.flatMap((spec) => Array.from({ length: spec.count }, () => spec));
  if (slots.length !== components.length) return null;
  const used = new Set();
  const assignment = [];
  for (const component of components) {
    const index = slots.findIndex((spec, i) => !used.has(i) && spec.kind === component.kind && spec.items.includes(component.item) && (!spec.size || spec.size === component.size));
    if (index === -1) return null;
    used.add(index);
    assignment.push(slots[index]);
  }
  return assignment;
}

function describeSlots(deal) {
  return deal.components.map((spec) => `${spec.count} x ${spec.size ? `${spec.size} ` : ""}${spec.items.join(" or ")}`).join(" + ");
}

function canonicalDeal(menu, line, label, errors) {
  const deal = menu.deals[line.deal];
  if (!deal) {
    errors.push(`${label}: deal "${line.deal}" is not on the menu`);
    return null;
  }
  const components = (Array.isArray(line.components) ? line.components : [])
    .map((component, i) => canonicalComponent(menu, component, `${label}.components[${i}]`, errors))
    .filter(Boolean);
  const canonical = { kind: "deal", deal: line.deal, components: components.sort((a, b) => keyOf(a).localeCompare(keyOf(b))) };
  if (!assignDeal(deal, canonical.components)) errors.push(`${label}: ${deal.label} must contain exactly ${describeSlots(deal)}`);
  return canonical;
}

export const keyOf = (canonical) => JSON.stringify(canonical);

/** Canonical form of one ticket line, with menu defaults filled in so equivalent orders compare equal. */
export function canonicalLine(menu, line, label, errors) {
  if (!isObject(line)) {
    errors.push(`${label}: must be an object`);
    return null;
  }
  if (line.deal !== undefined) return canonicalDeal(menu, line, label, errors);
  if (menu.pizzas[line.item]) return canonicalPizza(menu, line, label, errors);
  return canonicalItem(menu, line, label, errors);
}

function pizzaExtras(menu, canonical, allowance) {
  const pizza = menu.pizzas[canonical.item];
  const perTopping = toppingCents(menu, canonical.size) || 0;
  let extras = cents(menu.crusts[canonical.crust]?.upcharge?.[canonical.size] ?? 0);
  if (canonical.cheese === "extra") extras += perTopping;
  let units = 0;
  for (const topping of canonical.toppings) {
    const included = pizza.toppings.includes(topping.id);
    units += included ? (topping.amount === "extra" ? 1 : 0) : topping.amount === "extra" ? 2 : 1;
  }
  if (allowance !== undefined) units = Math.max(0, units - allowance);
  return extras + units * perTopping;
}

function unitCents(menu, canonical) {
  if (canonical.kind === "pizza") return cents(menu.pizzas[canonical.item].price[canonical.size] ?? 0) + pizzaExtras(menu, canonical);
  if (canonical.kind === "item") return cents(priceFor(menu.items[canonical.item].price, canonical.size) ?? 0);
  const deal = menu.deals[canonical.deal];
  const slots = assignDeal(deal, canonical.components) ?? [];
  let total = cents(deal.price);
  canonical.components.forEach((component, i) => {
    if (component.kind === "pizza") total += pizzaExtras(menu, component, slots[i]?.toppings_included);
  });
  return total;
}

function shortPizza(menu, canonical) {
  return menu.pizzas[canonical.item].label.replace(/ \(build your own\)$/i, "").toLowerCase();
}

function describeCanonical(menu, canonical) {
  if (canonical.kind === "item") {
    const item = menu.items[canonical.item];
    const details = [canonical.size, ...Object.values(canonical.options)].filter(Boolean);
    return `${item.label.toLowerCase()}${details.length ? ` (${details.join(", ").replace(/_/g, " ")})` : ""}`;
  }
  if (canonical.kind === "deal") {
    return `${menu.deals[canonical.deal].label.toLowerCase()} [${canonical.components.map((c) => describeCanonical(menu, c)).join(" | ")}]`;
  }
  const pizza = menu.pizzas[canonical.item];
  const mods = [];
  if (!menu.crusts[canonical.crust]?.default) mods.push((menu.crusts[canonical.crust]?.label ?? canonical.crust).toLowerCase());
  if (canonical.sauce !== (pizza.sauce ?? defaultSauce(menu))) mods.push((menu.sauces[canonical.sauce]?.label ?? canonical.sauce).toLowerCase());
  if (canonical.sauce_amount !== "regular") mods.push(canonical.sauce_amount === "none" ? "no sauce" : `${canonical.sauce_amount} sauce`);
  if (canonical.cheese !== "regular") mods.push(canonical.cheese === "none" ? "no cheese" : `${canonical.cheese} cheese`);
  const present = new Map(canonical.toppings.map((t) => [t.id, t]));
  for (const id of pizza.toppings) if (!present.has(id)) mods.push(`no ${id.replace(/_/g, " ")}`);
  for (const topping of canonical.toppings) {
    const included = pizza.toppings.includes(topping.id);
    if (included && topping.amount === "regular" && topping.placement === "whole") continue;
    const parts = [included ? "" : "+ ", topping.amount === "regular" ? "" : `${topping.amount} `, topping.id.replace(/_/g, " ")];
    if (topping.placement !== "whole") parts.push(` (${topping.placement} half)`);
    mods.push(parts.join(""));
  }
  return `${canonical.size} ${shortPizza(menu, canonical)}${mods.length ? `: ${mods.join(", ")}` : ""}`;
}

/** Human-readable description of a canonical line, used in reports. */
export function describe(menu, canonical, quantity) {
  return `${describeCanonical(menu, canonical)} x${quantity}`;
}

/**
 * Recomputes a ticket from the menu. Returns canonical lines with unit and line prices,
 * the subtotal, delivery fee, tax and total in cents, and every validation error found.
 */
export function priceTicket(menu, ticket) {
  const errors = [];
  if (!isObject(ticket)) return { lines: [], subtotal_cents: 0, delivery_fee_cents: 0, tax_cents: 0, total_cents: 0, errors: ["ticket must be an object"] };
  const orderType = ticket.order_type;
  if (!["pickup", "delivery"].includes(orderType)) errors.push(`order_type must be "pickup" or "delivery", got "${orderType}"`);
  if (orderType === "delivery" && !ticket.delivery_zip) errors.push("a delivery ticket needs delivery_zip");
  const items = Array.isArray(ticket.items) ? ticket.items : [];
  if (!items.length) errors.push("ticket has no items");

  const lines = [];
  items.forEach((line, i) => {
    const label = `items[${i}]`;
    const lineErrors = [];
    const canonical = canonicalLine(menu, line, label, lineErrors);
    const quantity = isObject(line) ? quantityOf(line, label, lineErrors) : 1;
    errors.push(...lineErrors);
    if (!canonical) return;
    if (canonical.kind === "deal") {
      const deal = menu.deals[canonical.deal];
      if (!deal.order_types.includes(orderType)) errors.push(`${label}: ${deal.label} is not available for ${orderType}`);
    }
    const unit = lineErrors.length ? 0 : unitCents(menu, canonical);
    lines.push({ key: keyOf(canonical), canonical, description: describeCanonical(menu, canonical), quantity, unit_cents: unit, line_cents: unit * quantity });
  });

  const subtotal = lines.reduce((sum, line) => sum + line.line_cents, 0);
  const fee = orderType === "delivery" ? cents(menu.delivery.fee) : 0;
  const rateBasisPoints = Math.round(menu.tax.rate * 10000);
  const tax = Math.floor((subtotal * rateBasisPoints + 5000) / 10000);
  return { lines, subtotal_cents: subtotal, delivery_fee_cents: fee, tax_cents: tax, total_cents: subtotal + fee + tax, errors };
}

/** Merges identical canonical lines, summing quantities. */
export function mergeLines(lines) {
  const merged = new Map();
  for (const line of lines) {
    const current = merged.get(line.key);
    if (current) current.quantity += line.quantity;
    else merged.set(line.key, { ...line });
  }
  return merged;
}

/** Whether the store is open at a local ISO time such as 2026-10-20T22:40:00-05:00, and when it next opens. */
export function storeStatus(menu, localIso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localIso ?? "");
  if (!match) throw new Error(`context.now must be a local ISO date-time, got "${localIso}"`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const now = hour * 60 + minute;
  const [open, close] = menu.store.hours[DAYS[weekday]];
  const isOpen = now >= toMinutes(open) && now < toMinutes(close);
  const nextOpen = now < toMinutes(open) ? open : menu.store.hours[DAYS[(weekday + 1) % 7]][0];
  return { open: isOpen, day: DAYS[weekday], hours: [open, close], next_open: nextOpen };
}

/** Every price a menu publishes, in cents: base prices, toppings, upcharges, sides, deals, fees. */
export function menuPrices(menu) {
  const prices = new Set();
  const add = (value) => {
    if (typeof value === "number") prices.add(cents(value));
    else if (isObject(value)) Object.values(value).forEach(add);
  };
  Object.values(menu.pizzas).forEach((pizza) => add(pizza.price));
  Object.values(menu.crusts).forEach((crust) => add(crust.upcharge));
  Object.values(menu.items).forEach((item) => add(item.price));
  Object.values(menu.deals).forEach((deal) => add(deal.price));
  add(menu.topping_price);
  add(menu.delivery.fee);
  add(menu.delivery.minimum_subtotal);
  return prices;
}
