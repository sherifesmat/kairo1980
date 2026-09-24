/* The server's view of the business facts — read from the same files the
   browser reads, never retyped.

   config.js  -> hours, discounts, thresholds, payment switches
   zones.js   -> postcodes, minimums, delivery fees (generated from the xlsx)
   index.html -> dish ids and prices, straight off the markup

   The menu is the one source that cannot simply be imported: prices live on
   `.mitem[data-item][data-price]` elements. So it is read out of the published
   index.html through the ASSETS binding and cached for the life of the
   isolate. A price edit is a deploy, and a deploy is a new isolate, so the
   cache cannot serve a stale price. */

// The order of these three is load-bearing, exactly as it is in index.html:
// config.js reads `window.KAIRO_ZONES` while it is being evaluated, so zones.js
// has to have run first or `delivery.zones` is silently empty — and an empty
// zone list means every postcode looks like it is outside the delivery area.
import './browser-globals.js';
import '../zones.js';
import '../config.js';

export const CONFIG = globalThis.KAIRO_CONFIG;
export const ZONES = globalThis.KAIRO_ZONES;

// data-item="baba-ghanough" ... data-price="11.00", in either attribute order.
const ITEM_RE = /<div\b[^>]*\bclass="[^"]*\bmitem\b[^"]*"[^>]*>/g;
const ATTR_ITEM = /\bdata-item="([^"]+)"/;
const ATTR_PRICE = /\bdata-price="([^"]+)"/;
// The dish name inside that block. German is read rather than English because
// the two are identical by house rule — the printed menu, the signage and the
// delivery platforms all use one spelling — and German is the one that is
// always present.
const NAME_RE = /class="mname[^"]*"[^>]*\bdata-de="([^"]+)"/;
/* Configurable choices that own a price use a stable option id. Their canonical
   pricing key is `dish-id:option-id`; the price lives here in index.html and
   nowhere else. References to ordinary dishes deliberately carry no price and
   are resolved from the referenced dish's data-price instead. */
const ATTR_OPTION = /\\bdata-option="([^"]+)"/;
const ATTR_REF = /\\bdata-ref="([^"]+)"/;
const ATTR_GROUP = /\\bdata-group="([^"]+)"/;
const ATTR_MIN = /\\bdata-min="([^"]+)"/;
const ATTR_MAX = /\\bdata-max="([^"]+)"/;
const ATTR_DE = /\\bdata-de="([^"]+)"/;
/* Any element carrying data-option or data-ref is a selectable choice. Attribute
   order is intentionally irrelevant; each attribute is read independently. */
const CHOICE_RE = /<[^>]+\\b(?:data-option|data-ref)="[^"]+"[^>]*>/g;
/* The heading each dish sits under. Read the same way and for the same reason
   as the name: German, because the three spellings are one house rule apart and
   German is the one always present. Used by /admin/dishes so the sold-out list
   reads in the same groups and the same order as the printed menu — a cook
   hunting for a dish mid-service looks where the menu puts it. */
const CAT_RE = /<h3\b[^>]*\bclass="cat-name[^"]*"[^>]*\bdata-de="([^"]+)"/g;

let menuCache = null;

/** id -> { price (cents|null), name, category, options, choices }. `options` maps\n *  price-owning configurable choices by option id; `choices` contains every\n *  selectable choice (including zero-price bases and references), with group\n *  and min/max constraints. Throws if the menu cannot be read: charging
 *  a guest an amount we could not derive from the published menu is never
 *  acceptable. */
export async function menu(env) {
  if (menuCache) return menuCache;

  const res = await env.ASSETS.fetch(new Request('https://kairo1980.de/index.html'));
  if (!res.ok) throw new Error('menu unavailable: index.html returned ' + res.status);
  const html = await res.text();

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

  const found = new Map();
  ITEM_RE.lastIndex = 0;
  let match;
  while ((match = ITEM_RE.exec(html)) !== null) {
    const tag = match[0];
    const id = (tag.match(ATTR_ITEM) || [])[1];
    if (!id) continue;

    /* A dish block ends at the next .mitem opening tag, never at an arbitrary
       character count. This prevents choices leaking between adjacent dishes
       and permits arbitrarily long translated configurable-product markup. */
    const bodyStart = ITEM_RE.lastIndex;
    const next = html.slice(bodyStart).search(/<div\\b[^>]*\\bclass="[^"]*\\bmitem\\b[^"]*"[^>]*>/);
    const blockEnd = next < 0 ? html.length : bodyStart + next;
    const block = html.slice(match.index, blockEnd);

    const priceText = (tag.match(ATTR_PRICE) || [])[1];
    const parsedPrice = priceText == null ? NaN : parseFloat(priceText);
    const cents = Number.isFinite(parsedPrice) && parsedPrice > 0
      ? Math.round(parsedPrice * 100) : null;
    const name = (block.match(NAME_RE) || [])[1];

    const options = new Map();
    const choices = [];
    CHOICE_RE.lastIndex = 0;
    let choice;
    while ((choice = CHOICE_RE.exec(block)) !== null) {
      const choiceTag = choice[0];
      const optionId = (choiceTag.match(ATTR_OPTION) || [])[1] || null;
      const ref = (choiceTag.match(ATTR_REF) || [])[1] || null;
      const group = (choiceTag.match(ATTR_GROUP) || [])[1] || '';
      const minText = (choiceTag.match(ATTR_MIN) || [])[1];
      const maxText = (choiceTag.match(ATTR_MAX) || [])[1];
      const choicePriceText = (choiceTag.match(ATTR_PRICE) || [])[1];
      const label = decodeEntities((choiceTag.match(ATTR_DE) || [])[1] || optionId || ref || '');
      const choicePrice = choicePriceText == null ? null : Math.round(parseFloat(choicePriceText) * 100);
      const entry = {
        option: optionId, ref, group,
        min: minText == null ? null : Number(minText),
        max: maxText == null ? null : Number(maxText),
        name: label,
        price: Number.isFinite(choicePrice) ? choicePrice : null
      };
      choices.push(entry);
      if (optionId && entry.price != null && entry.price > 0) {
        options.set(optionId, {
          id: id + ':' + optionId,
          price: entry.price,
          name: label
        });
      }
    }

    /* Ordinary dishes require their own positive price. A configurable product
       may omit it when at least one of its choices owns the price; the selected
       option then supplies the unit price. */
    if (cents == null && !options.size) continue;
    found.set(id, {
      price: cents,
      name: decodeEntities(name || id),
      category: categoryAt(match.index),
      options,
      choices
    });
  }

  if (!found.size) throw new Error('menu unavailable: no priced items found in index.html');
  menuCache = found;
  return menuCache;
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
