/* Changing a price without a developer.
   ---------------------------------------------------------------------------
   The same arrangement as the opening hours. index.html's `data-price` is the
   DEFAULT — what the menu was published with and what "Menu price" puts back.
   A row in `settings` OVERRIDES single prices, by the id the till already uses:
   a dish, or "dish:option" for a bowl topping. The Worker writes the price in
   effect into the page and charges by the same answer (priceOf() in
   worker/pricing.js), so the guest, the basket and the charge read one figure.

   The list is not typed here. It is read out of the published index.html by
   the same parse the pricing uses, so a dish added to the menu appears on this
   page by itself and one removed disappears with it.

   Things deliberately NOT editable here:
     - an extra's price. "Salata Baladi +6,00 €" on a bowl IS Salata Baladi's
       price; change the dish and every extra follows.
     - a Menü's included drink. The Menü has one price and the drink is in it.

   The KAIRO Bowl is priced in two parts: its base (rice, noodles) has a
   price, and each topping adds to it. Both are set here, each by its own id.

   A value that is not a price REFUSES THE WHOLE SAVE, and the page comes back
   with every figure as it was typed and the bad ones marked. The alternative
   is a typo on a phone at nine in the evening publishing a 95-euro hummus. */

import { layout, esc, newNonce, adminHeaders } from './pages.js';
import { readSettings, writePrices, resetPrices, PRICE_MIN, PRICE_MAX } from '../settings.js';
import { menu } from '../site-data.js';
import { priceOf } from '../pricing.js';

const euro = (cents) => (cents / 100).toFixed(2).replace('.', ',');

/** Every price the restaurant can set, grouped and ordered as the menu is. */
async function priceable(env) {
  const dishes = await menu(env);
  const groups = [];
  for (const [id, dish] of dishes) {
    const name = dish.category || 'Weitere';
    let group = groups.find((g) => g.name === name);
    if (!group) groups.push((group = { name, rows: [] }));
    if (dish.price > 0) group.rows.push({ id, name: dish.name, base: dish.price });
    for (const g of dish.groups) {
      for (const o of g.options) {
        if (o.price > 0) {
          // A group that adds to the rest of the dish (the bowl's toppings,
          // on top of its base) is labelled so, so "+8,50" is not read as
          // the price of a whole bowl.
          const plus = g.surcharge ? ' (+ on top of the base)' : ' (base price)';
          group.rows.push({ id: id + ':' + o.id, name: dish.name + ' – ' + o.name + (dish.groups.length > 1 ? plus : ''),
                            base: o.price, sub: true });
        }
      }
    }
  }
  return { dishes, groups: groups.filter((g) => g.rows.length) };
}

/** "9,50", "9.50", "9" -> 950; anything else -> null. */
export function parseEuro(text) {
  const m = String(text || '').trim().replace(/\s*€$/, '').match(/^(\d{1,3})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

/* When the saved prices cannot be read, this page cannot say what is live —
   and a save from it would replace overrides nobody was shown. So it says so
   and changes nothing, the same way the till refuses to charge. */
function unavailable() {
  const nonce = newNonce();
  const body = `<h1>Prices</h1>
<p class="err"><b>The saved prices cannot be read right now.</b> Nothing can be
changed until they can — try again in a minute. Online payment is paused
meanwhile; orders still arrive in the chat to be paid on arrival.</p>`;
  return new Response(layout({ title: 'Prices', nonce, body, logout: true, back: '/admin', extraCss: CSS }), {
    status: 503, headers: adminHeaders(nonce)
  });
}

export async function page(request, env, url) {
  const [{ prices, unreadable }, { dishes, groups }] = await Promise.all([readSettings(env), priceable(env)]);
  if (unreadable) return unavailable();
  const nonce = newNonce();
  const values = {};
  for (const g of groups) {
    for (const r of g.rows) values[r.id] = euro(priceOf(dishes, prices, r.id));
  }
  return new Response(
    render({ nonce, groups, prices, values, errors: [], saved: url.searchParams.get('saved') }),
    { headers: adminHeaders(nonce) }
  );
}

export async function save(request, env) {
  const form = await request.formData();
  const { prices, unreadable } = await readSettings(env);
  if (unreadable) return unavailable();
  const { groups } = await priceable(env);

  const next = {};
  const values = {};
  const errors = [];
  for (const g of groups) {
    for (const r of g.rows) {
      const typed = String(form.get('price:' + r.id) || '');
      values[r.id] = typed;
      if (form.get('reset:' + r.id)) { values[r.id] = euro(r.base); continue; }
      const cents = parseEuro(typed);
      if (cents == null || cents < PRICE_MIN || cents > PRICE_MAX) {
        errors.push(r.id);
        continue;
      }
      // The menu's own figure is not an override; storing it would only hide
      // the next change made to index.html.
      if (cents !== r.base) next[r.id] = cents;
    }
  }

  if (errors.length) {
    const nonce = newNonce();
    return new Response(render({ nonce, groups, prices, values, errors, saved: null }), {
      status: 400, headers: adminHeaders(nonce)
    });
  }

  await writePrices(env, next);
  return new Response(null, {
    status: 303, headers: { Location: '/admin/prices?saved=1', 'Cache-Control': 'no-store' }
  });
}

/* Every price back to the menu's, in one tap and on purpose: its own form and
   its own POST, so it can never be the side effect of saving the page. */
export async function reset(request, env) {
  if ((await readSettings(env)).unreadable) return unavailable();
  await resetPrices(env);
  return new Response(null, {
    status: 303, headers: { Location: '/admin/prices?saved=reset', 'Cache-Control': 'no-store' }
  });
}

const CSS = `
 .msg{padding:10px 12px;border:1px solid #bcd8b0;background:#eef6ea;color:#31601f;
      font-size:13.5px;margin-bottom:14px}
 .err{padding:10px 12px;border:1px solid #e0a0a0;background:#fbeaea;color:#8a1f1f;
      font-size:13.5px;margin-bottom:14px}
 h2.cat{font-family:'Cinzel',serif;font-size:11px;letter-spacing:.14em;text-transform:uppercase;
        color:#7a6030;margin:20px 0 6px}
 ul.prices{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e6dcc9}
 li.price{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #f0e8d8;flex-wrap:wrap}
 li.price:last-child{border-bottom:none}
 li.price.sub{padding-inline-start:34px}
 li.price.changed{background:#fdf6e8}
 li.price.bad{background:#fbeaea}
 .nm{flex:1;min-width:140px;font-size:14.5px;color:#1c1409}
 .std{display:block;font-size:11.5px;color:#a0661a;margin-top:2px}
 .amt{display:flex;align-items:center;gap:6px}
 .amt input{width:84px;padding:8px;font-size:15px;text-align:end;border:1px solid #d9ccb0}
 li.price.bad .amt input{border-color:#c0392b}
 label.reset{display:flex;align-items:center;gap:6px;font-size:12px;color:#7a6030;margin:0;
             text-transform:none;letter-spacing:0}
 .save{position:sticky;bottom:0;z-index:5;background:#faf7f2;padding:12px 0 8px;
       margin-top:12px;box-shadow:0 -10px 14px -8px rgba(28,20,9,0.18)}
 button.save-btn{width:100%;padding:14px;font-size:15px;font-weight:600;border:0;
                 background:#1c1409;color:#f5e8cc;cursor:pointer}
 form.reset-all{margin-top:22px}
 button.reset-btn{width:100%;padding:12px;font-size:14px;border:1px solid #c9b48a;
                  background:#fff;color:#7a6030;cursor:pointer}
`;

export function render({ nonce, groups, prices, values, errors, saved }) {
  const rowFor = (r) => {
    const changed = Number.isInteger(prices[r.id]) && prices[r.id] !== r.base;
    const bad = errors.includes(r.id);
    return `<li class="price ${r.sub ? 'sub' : ''} ${changed ? 'changed' : ''} ${bad ? 'bad' : ''}">
      <span class="nm">${esc(r.name)}
        ${changed ? `<span class="std">Menu price: ${euro(r.base)} €</span>` : ''}
      </span>
      <span class="amt"><input name="price:${esc(r.id)}" value="${esc(values[r.id] || '')}"
        inputmode="decimal" autocomplete="off" aria-label="${esc(r.name)}"> €</span>
      ${changed ? `<label class="reset"><input type="checkbox" name="reset:${esc(r.id)}"> Menu price</label>` : ''}
    </li>`;
  };

  const overridden = Object.keys(prices).length;
  const body = `<h1>Prices</h1>
<div class="sub">Type a new price and save. It is on the website, in the basket
and in what is charged the moment you save. An extra (a drink or a side) costs
what that dish costs, so change the dish itself.</div>

${saved === '1' ? '<p class="msg">Saved. Live now.</p>' : ''}
${saved === 'reset' ? '<p class="msg">Every price is back to the menu.</p>' : ''}
${errors.length ? `<p class="err"><b>Nothing was saved.</b> ${errors.length} price(s) marked in red
  are not a price between ${euro(PRICE_MIN)} € and ${euro(PRICE_MAX)} € — write them like 9,50.</p>` : ''}

<form method="post" action="/admin/prices">
  ${groups.map((g) => `<h2 class="cat">${esc(g.name)}</h2>
    <ul class="prices">${g.rows.map(rowFor).join('')}</ul>`).join('')}
  <div class="save">
    <button class="save-btn" type="submit">Save</button>
  </div>
</form>

${overridden ? `<form class="reset-all" method="post" action="/admin/prices/reset">
  <button class="reset-btn" type="submit">Put every price back to the menu (${overridden} changed)</button>
</form>` : ''}

<p class="note">The list comes from the menu itself, so a new dish appears here on its own.
Remember Lieferando and Uber Eats: their prices are set in their own portals.</p>`;

  return layout({
    title: 'Prices', nonce, body, logout: true, back: '/admin', extraCss: CSS
  });
}
