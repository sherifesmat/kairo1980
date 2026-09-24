/* The server's view of the business facts — read from the same files the
   browser reads, never retyped.

   config.js  -> hours, discounts, thresholds, payment switches
   zones.js   -> postcodes, minimums, delivery fees (generated from the xlsx)
   index.html -> dish ids and prices, straight off the markup

   The menu is the one source that cannot simply be imported: prices live on
   `.mitem[data-item][data-price]` elements. So it is read out of the published
   index.html through the ASSETS binding and cached for the life of the
   isolate. A price edit is a deploy, and a deploy is a new isolate, so the
   cache cannot serve a stale price.

   A dish may also carry choices: its own (the KAIRO Bowl's base and topping,
   written inside its row) and shared add-on groups defined once on the page
   and referenced by id. See menuData() for the shape. */

// The order of these three is load-bearing, exactly as it is in index.html:
// config.js reads `window.KAIRO_ZONES` while it is being evaluated, so zones.js
// has to have run first or `delivery.zones` is silently empty — and an empty
// zone list means every postcode looks like it is outside the delivery area.
import './browser-globals.js';
import '../zones.js';
import '../config.js';

export const CONFIG = globalThis.KAIRO_CONFIG;
export const ZONES = globalThis.KAIRO_ZONES;


/* --- reading the menu out of the markup -------------------------------------
   Every tag is matched once and its attributes are read one at a time, so the
   order they are written in never matters. */
const TAG_RE = /<[a-z][^>]*>/gi;
const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return m ? m[1] : null;
};
const hasClass = (tag, cls) =>
  new RegExp('\\sclass="(?:[^"]*\\s)?' + cls + '(?:\\s[^"]*)?"').test(tag);

/* Where one dish's markup stops: at the next dish, the next category heading
   or the end of the menu section, whichever comes first. Never a character
   count — a bowl with four trilingual toppings is long, and a window that cuts
   it short silently loses the toppings at the end. */
const BLOCK_END_RE = /<div\b[^>]*\bclass="[^"]*\b(?:mitem|cat-head)\b|<\/section>/g;

/* One cache per ASSETS binding. The binding is the same object for the life
   of an isolate, so production reads index.html once per deploy; a test that
   hands in its own markup gets its own parse instead of the first one made. */
const cache = new WeakMap();

/* The heading each dish sits under. Read the same way and for the same reason
   as the name: German, because the three spellings are one house rule apart and
   German is the one always present. Used by /admin/dishes so the sold-out list
   reads in the same groups and the same order as the printed menu — a cook
   hunting for a dish mid-service looks where the menu puts it. */
const CAT_RE = /<h3\b[^>]*\bclass="cat-name[^"]*"[^>]*\bdata-de="([^"]+)"/g;

/**
 * The published menu.
 *
 * dishes: id -> {
 *   price     cents, or null for a dish priced entirely by its options
 *   name      German, as printed
 *   category  the heading it sits under
 *   groups    [{ id, name, options: [{ id, name, price|null }] }]
 *             the dish's OWN choices — pick exactly one per group
 *   addons    [groupId]  optional extras, charged at the referenced dish price
 *   includes  [groupId]  pick exactly one, already in the dish's price
 *   contains  [dishId]   what the dish is made of — sold out with any of them
 * }
 * addonGroups: id -> { id, name, max, refs: [dishId] }
 *
 * An add-on is a REFERENCE to a dish on the menu and carries no price of its
 * own: Salata Baladi costs what its own row says, wherever it is offered.
 * Throws if the menu cannot be read — charging an amount we could not derive
 * from the published menu is never acceptable.
 */
export async function menuData(env) {
  const hit = cache.get(env.ASSETS);
  if (hit) return hit;

  const res = await env.ASSETS.fetch(new Request('https://kairo1980.de/index.html'));
  if (!res.ok) throw new Error('menu unavailable: index.html returned ' + res.status);
  const data = parseMenu(await res.text());
  if (!data.dishes.size) throw new Error('menu unavailable: no priced items found in index.html');
  cache.set(env.ASSETS, data);
  return data;
}

/** id -> dish, in menu order. See menuData() for the shape. */
export async function menu(env) {
  return (await menuData(env)).dishes;
}

export function parseMenu(html) {
  /* Where each category heading starts, so a dish can be told which one it
     falls under by position — the markup nests nothing, the heading simply
     precedes its dishes. */
  const cats = [];
  CAT_RE.lastIndex = 0;
  let cat;
  while ((cat = CAT_RE.exec(html)) !== null) {
    cats.push({ at: cat.index, name: decodeEntities(cat[1]) });
  }
  const categoryAt = (index) => {
    let name = '';
    for (const entry of cats) {
      if (entry.at > index) break;
      name = entry.name;
    }
    return name;
  };

  const addonGroups = new Map();
  const dishes = new Map();
  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(html)) !== null) {
    const tag = match[0];

    const groupId = attr(tag, 'data-addon-group');
    if (groupId) {
      // Refs are empty spans inside the group's div; the group ends at its </div>.
      const end = html.indexOf('</div>', TAG_RE.lastIndex);
      const body = html.slice(TAG_RE.lastIndex, end < 0 ? html.length : end);
      const refs = [...body.matchAll(/\sdata-ref="([^"]+)"/g)].map((m) => m[1]);
      const max = parseInt(attr(tag, 'data-max'), 10);
      addonGroups.set(groupId, {
        id: groupId,
        name: decodeEntities(attr(tag, 'data-de') || groupId),
        max: Number.isFinite(max) && max > 0 ? max : refs.length,
        refs
      });
      continue;
    }

    if (!/^<div\b/i.test(tag) || !hasClass(tag, 'mitem')) continue;
    const id = attr(tag, 'data-item');
    if (!id) continue;

    BLOCK_END_RE.lastIndex = TAG_RE.lastIndex;
    const next = BLOCK_END_RE.exec(html);
    const block = html.slice(TAG_RE.lastIndex, next ? next.index : html.length);
    const dish = parseDish(tag, block);
    dish.category = categoryAt(match.index);
    if (!dish.name) dish.name = id;

    /* A dish needs a price of its own, or options that carry one. Anything
       else could only ever be priced at nothing. */
    if (dish.price == null && !dish.groups.some((g) => g.options.some((o) => o.price != null))) continue;
    dishes.set(id, dish);
  }

  return { dishes, addonGroups };
}

const words = (text) => (text || '').split(/\s+/).filter(Boolean);

function parseDish(tag, block) {
  const price = cents(attr(tag, 'data-price'));
  const dish = {
    price,
    name: '',
    category: '',
    groups: [],
    addons: words(attr(tag, 'data-addons')),
    includes: words(attr(tag, 'data-includes')),
    contains: words(attr(tag, 'data-contains'))
  };

  let group = null;
  let option = null;
  const inner = new RegExp(TAG_RE.source, 'gi');
  let m;
  while ((m = inner.exec(block)) !== null) {
    const t = m[0];
    const de = attr(t, 'data-de');
    if (!dish.name && hasClass(t, 'mname') && de) { dish.name = decodeEntities(de); continue; }

    const g = attr(t, 'data-group');
    if (g) {
      group = { id: g, name: decodeEntities(de || g), options: [] };
      dish.groups.push(group);
      option = null;
      continue;
    }
    const o = attr(t, 'data-option');
    if (o && group) {
      option = { id: o, name: o, price: cents(attr(t, 'data-price')) };
      group.options.push(option);
      continue;
    }
    // The option's printed name, in German for the same reason the dish's is.
    if (option && option.name === option.id && hasClass(t, 'mchoice-name') && de) {
      option.name = decodeEntities(de);
    }
  }
  return dish;
}

function cents(text) {
  if (text == null) return null;
  const value = parseFloat(text);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (whole, key) => ENTITIES[key] || whole);
}

/** The delivery zone for a postcode, or null when we do not serve it. */
export function zoneFor(postcode) {
  const plz = String(postcode || '').trim();
  if (!/^\d{5}$/.test(plz)) return null;
  const row = ZONES.find((z) => z[0] === plz);
  return row ? { postcode: row[0], place: row[1], minimum: row[3], fee: row[4] } : null;
}
