/* What the order actually costs.

   The browser computes the same figures in order.js to show the guest a
   running total. This module recomputes them from scratch, in cents, from the
   published menu and the generated zones — because the browser's number is a
   claim by an untrusted party. Nothing a client sends about money is used:
   the client says WHAT it wants, the server says what it COSTS.

   The rules mirror totals() in order.js exactly:
     - the discount applies to food, never to driving
     - the delivery fee sits outside the discount
     - the fee is waived from `business.freeDeliveryFrom` on the food subtotal,
       for every order alike — company and private are the same trip
     - the per-zone minimum is asked only of a private order that has to be
       driven out; pickup and company orders are never held to it
     - an unknown postcode charges no fee; that is agreed in the chat instead */

import { CONFIG, menuData, zoneFor } from './site-data.js';
import { readSettings } from './settings.js';

export const MAX_ITEMS = 200;

/* The two delivery rules, asked of the same config.js the browser reads.
   The server cannot trust the browser's answer — but it must never give a
   different one, so these are deliberately the same two questions by the same
   two names as in order.js. */

// Free delivery: one threshold, every order, company or private.
function freeDeliveryQualifies(subtotalCents) {
  const from = (CONFIG.business || {}).freeDeliveryFrom;
  return from != null && subtotalCents >= from * 100;
}

// The minimum order value is asked of a private order that has to be driven
// out, and of nothing else.
function minimumApplies(type, business) {
  const rule = (CONFIG.order || {}).minimumOrder || {};
  return business ? rule.business === true : rule[type] === true;
}

/**
 * @param {object} env
 * @param {{items: Record<string, number>, type: string, business: boolean, postcode: string}} req
 * @returns {Promise<{lines: Array, subtotal: number, discount: number, discountPercent: number,
 *                    fee: number, total: number, zone: object|null, belowMinimum: boolean}>}
 */
export async function quote(env, req) {
  const { dishes, addonGroups } = await menuData(env);

  /* THE ONE REFUSAL ON THIS SITE. An unknown postcode, a closed slot and a
     sub-minimum basket are all warnings that let the order through, because
     the guest may be right and we may be wrong. A dish the kitchen has run out
     of is not that: the ingredient is not in the building, and taking the money
     would mean ringing the guest back to say so. The browser dims it too, but
     the browser is not to be trusted with the answer. */
  const { soldOut, prices: overrides, unreadable } = await readSettings(env);
  /* Money is the one thing a settings outage may not paper over. The page may
     have shown a price the restaurant set at /admin; the defaults are not the
     same claim. The guest is offered the way this site always offers when a
     payment cannot be taken: send the order and pay on arrival. */
  if (unreadable) {
    throw new PricingError('prices_unavailable', 'Prices cannot be confirmed right now.');
  }
  const price = (id) => priceOf(dishes, overrides, id);
  const type = req.type === 'pickup' ? 'pickup' : 'delivery';
  const business = !!req.business;

  const lines = [];
  let subtotal = 0;
  let units = 0;

  for (const [key, rawQty] of Object.entries(req.items || {})) {
    const qty = Math.floor(Number(rawQty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const line = resolveLine(key, dishes, addonGroups, soldOut || {}, price);
    units += qty;
    if (units > MAX_ITEMS) throw new PricingError('too_many_items', 'Order exceeds ' + MAX_ITEMS + ' items');
    const amount = line.unit * qty;
    subtotal += amount;
    lines.push({ id: key, dish: line.dish, name: line.name, qty, unit: line.unit, amount,
                 ...(line.choices.length ? { choices: line.choices } : {}) });
  }

  if (!lines.length) throw new PricingError('empty_cart', 'The basket is empty');

  const order = CONFIG.order || {};
  const percent = (business && type === 'pickup' && order.businessPickupDiscountPercent != null)
    ? order.businessPickupDiscountPercent
    : (order.directDiscountPercent || 0);
  const discount = Math.round(subtotal * percent / 100);

  const zone = type === 'delivery' ? zoneFor(req.postcode) : null;
  const waived = freeDeliveryQualifies(subtotal);
  const fee = (zone && !waived) ? Math.round(zone.fee * 100) : 0;

  const total = subtotal - discount + fee;
  if (total <= 0) throw new PricingError('zero_total', 'Nothing to pay');

  return {
    lines,
    subtotal,
    discount,
    discountPercent: percent,
    fee,
    total,
    zone,
    freeDelivery: waived,
    // Advisory only, exactly as in the browser: a sub-minimum order is flagged
    // in the chat, never refused. It must not block a payment either — and it
    // is not raised at all against an order the minimum is not asked of.
    belowMinimum: !!(zone && minimumApplies(type, business) &&
                     subtotal < zone.minimum * 100)
  };
}

/* --- one basket line ---------------------------------------------------------
   The browser names a line by WHAT is in it, never by what it costs:

     hawawshy
     kairo-bowl|basis=nudeln|topping=kebda|getraenk=fritz-kola-0-33-l
     hawawshy-menue|menue-getraenk=hausgemachter-karkadeh-0-5-l

   Every choice is checked against the markup the price comes from, and a line
   that could not have been built from the menu on the page is refused rather
   than repaired: a guessed correction is an order nobody placed. */

const MAX_KEY = 400;

/** "dish|group=a,b|group2=c" -> { dish, picks: Map(group -> [ids]) } */
export function parseLineKey(key) {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY) return null;
  const [dish, ...parts] = key.split('|');
  if (!/^[a-z0-9-]+$/.test(dish)) return null;
  const picks = new Map();
  for (const part of parts) {
    const m = part.match(/^([a-z0-9-]+)=([a-z0-9-]+(?:,[a-z0-9-]+)*)$/);
    if (!m || picks.has(m[1])) return null;
    picks.set(m[1], m[2].split(','));
  }
  return { dish, picks };
}

/**
 * The price in effect for a dish or a "dish:option", in cents.
 *
 * The menu's own figure, unless the restaurant has set another at
 * /admin/prices. An override counts only for an id the CURRENT menu prices:
 * a dish since removed, an option with no price written, a mistyped id — all inert,
 * however long the row has sat in the database.
 */
export function priceOf(dishes, overrides, id) {
  const colon = id.indexOf(':');
  const dish = dishes.get(colon < 0 ? id : id.slice(0, colon));
  if (!dish) return null;
  let base = dish.price;
  if (colon >= 0) {
    const optionId = id.slice(colon + 1);
    const option = dish.groups.flatMap((g) => g.options).find((o) => o.id === optionId);
    base = option ? option.price : null;
  }
  if (!(base > 0)) return base;
  const override = overrides && overrides[id];
  return Number.isInteger(override) && override > 0 ? override : base;
}

function resolveLine(key, dishes, addonGroups, soldOut, price = (id) => priceOf(dishes, {}, id)) {
  const parsed = parseLineKey(key);
  if (!parsed) throw new PricingError('unknown_item', 'Unknown menu item: ' + String(key).slice(0, 80));
  const dish = dishes.get(parsed.dish);
  if (!dish) throw new PricingError('unknown_item', 'Unknown menu item: ' + parsed.dish);

  const refuse = (what) => { throw new PricingError('invalid_choice', dish.name + ': ' + what); };
  const gone = (name) => { throw new PricingError('sold_out', 'Currently unavailable: ' + name); };

  if (soldOut[parsed.dish]) gone(dish.name);
  // A Menü is its parts: no Hawawshy, no Hawawshy Menü.
  for (const part of dish.contains) {
    if (soldOut[part]) gone(dish.name);
  }

  const picks = new Map(parsed.picks);
  let unit = price(parsed.dish) || 0;
  const own = [];       // printed in brackets: the topping, the base, the drink of a Menü
  const extras = [];    // printed after a "+"
  const choices = [];

  for (const group of dish.groups) {
    const chosen = picks.get(group.id) || [];
    picks.delete(group.id);
    if (chosen.length !== 1) refuse('choose one ' + group.name);
    const option = group.options.find((o) => o.id === chosen[0]);
    if (!option) refuse('no such ' + group.name + ' ' + chosen[0]);
    if (soldOut[parsed.dish + ':' + option.id]) gone(dish.name + ' ' + option.name);
    const optionPrice = price(parsed.dish + ':' + option.id) || 0;
    unit += optionPrice;
    own.push(option.name);
    choices.push({ group: group.id, id: option.id, name: option.name, price: optionPrice });
  }

  const referenced = (groupId, included) => {
    const group = addonGroups.get(groupId);
    const chosen = picks.get(groupId) || [];
    picks.delete(groupId);
    if (!group) refuse('unknown group ' + groupId);
    if (included ? chosen.length !== 1 : chosen.length > group.max) {
      refuse(included ? 'choose one ' + group.name : 'at most ' + group.max + ' ' + group.name);
    }
    if (new Set(chosen).size !== chosen.length) refuse('duplicate ' + group.name);
    for (const ref of chosen) {
      const target = group.refs.includes(ref) && dishes.get(ref);
      // An extra costs what its own row costs today, override and all.
      const refPrice = target ? price(ref) : null;
      if (!target || !(refPrice > 0)) refuse('no such ' + group.name + ' ' + ref);
      if (soldOut[ref]) gone(target.name);
      const charged = included ? 0 : refPrice;
      unit += charged;
      (included ? own : extras).push(target.name);
      choices.push({ group: groupId, id: ref, name: target.name, price: charged });
    }
  };
  for (const groupId of dish.includes) referenced(groupId, true);
  for (const groupId of dish.addons) referenced(groupId, false);

  // Anything left is a group this dish does not offer.
  if (picks.size) refuse('does not offer ' + [...picks.keys()].join(', '));
  if (unit <= 0) throw new PricingError('unknown_item', 'Unpriced menu item: ' + parsed.dish);

  const name = dish.name +
    (own.length ? ' (' + own.join(', ') + ')' : '') +
    extras.map((n) => ' + ' + n).join('');
  return { dish: parsed.dish, name, unit, choices };
}

export class PricingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Cents -> the string PayPal wants: "23.40". */
export function toAmount(cents) {
  return (cents / 100).toFixed(2);
}
