/* Taking a dish off the menu because the kitchen has run out.
   ---------------------------------------------------------------------------
   The dish list is not typed here. It is read out of the published index.html
   through worker/site-data.js — the same parse the pricing uses — so a dish
   added to the menu appears on this page by itself, and one removed disappears
   with it. A second list of dish names maintained by hand is the bug this
   whole codebase is arranged to avoid.

   THIS IS THE ONE REFUSAL ON THE SITE. Everything else validates advisorily: an
   unknown postcode, a closed slot or a sub-minimum basket warns the guest and
   lets the order through, because losing a real order costs more than reading a
   message. A sold-out dish is different in kind — the ingredient is not in the
   building — so it is refused in the basket AND in worker/pricing.js, where the
   browser cannot argue with it.

   Each dish records WHEN it was marked, and the page says so, because the
   failure worth guarding against is not a dish switched off; it is a dish still
   switched off on Thursday because somebody ran out on Saturday and went home.
   That is the same reasoning the ordering switch carries an expiry for. */

import { layout, esc, newNonce, adminHeaders } from './pages.js';
import { readSettings, writeSoldOut } from '../settings.js';
import { menu } from '../site-data.js';

export async function page(request, env, url) {
  const [{ soldOut }, dishes] = await Promise.all([readSettings(env), menu(env)]);
  const nonce = newNonce();
  /* Grouped and ordered exactly as the printed menu is — NOT alphabetically.
     Someone hunting for a dish mid-service looks where the menu puts it, and
     `menu()` yields them in document order, so the groups fall out by simply
     keeping the order they arrive in. */
  const groups = [];
  for (const [id, dish] of dishes) {
    const name = dish.category || 'Weitere';
    let group = groups.find((g) => g.name === name);
    if (!group) groups.push((group = { name, dishes: [] }));
    group.dishes.push({ id, name: dish.name, price: dish.price });
    /* Each of the bowl's own options can run out on its own — no Kebda, but
       chicken is fine; no noodles, but there is rice. They are listed under
       the dish, by the name the menu prints, and switched off by the same
       "dish:option" id the till refuses. */
    for (const g of dish.groups || []) {
      for (const o of g.options) {
        group.dishes.push({ id: id + ':' + o.id, name: o.name, price: o.price, sub: true });
      }
    }
  }

  return new Response(
    render({ nonce, soldOut, groups, saved: url.searchParams.has('saved') }),
    { headers: adminHeaders(nonce) }
  );
}

export async function save(request, env) {
  const form = await request.formData();
  const { soldOut } = await readSettings(env);

  /* An unchecked box sends nothing, so the form cannot say "this one is back"
     on its own — the checked ones ARE the answer and everything else is
     available again. That is why the whole set is replaced rather than
     toggled: a toggle would need to know what the page was showing when it was
     drawn, and two people at two tills would fight over it. */
  const ids = form.getAll('soldout').map(String);
  await writeSoldOut(env, ids, soldOut);

  return new Response(null, {
    status: 303,
    headers: { Location: '/admin/dishes?saved=1', 'Cache-Control': 'no-store' }
  });
}

/** "since Saturday 18:40", in the restaurant's own clock. */
function since(iso) {
  try {
    return new Date(iso).toLocaleString('de-DE', {
      timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return '';
  }
}

/** Hours since a dish went off, for the nudge on anything long forgotten. */
function hoursOff(iso) {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? (Date.now() - at) / 3600000 : 0;
}

const CSS = `
 .msg{padding:10px 12px;border:1px solid #bcd8b0;background:#eef6ea;color:#31601f;
      font-size:13.5px;margin-bottom:14px}
 .warn{border:1px solid #e8c9a0;background:#fdf0e0;padding:10px 12px;margin-bottom:14px;
       font-size:13.5px;color:#a04a00}
 h2.cat{font-family:'Cinzel',serif;font-size:11px;letter-spacing:.14em;text-transform:uppercase;
        color:#7a6030;margin:20px 0 6px;display:flex;align-items:center;gap:8px}
 h2.cat:first-of-type{margin-top:4px}
 .cat-off{font-size:10px;letter-spacing:.06em;background:#fdf0e0;border:1px solid #e8c9a0;
          color:#a04a00;padding:2px 6px;text-transform:none}
 ul.dishes{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e6dcc9}
 li.dish{border-bottom:1px solid #f0e8d8}
 li.dish:last-child{border-bottom:none}
 label.row{display:flex;align-items:center;gap:12px;padding:12px 14px;cursor:pointer;
           margin:0;text-transform:none;letter-spacing:0}
 label.row input{width:24px;height:24px;flex:none;margin:0}
 .nm{flex:1;font-size:14.5px;color:#1c1409}
 .pr{color:#7a6030;font-size:13px;white-space:nowrap}
 li.dish.sub label.row{padding-inline-start:40px}
 li.dish.sub .nm{font-size:13.5px}
 li.dish.off{background:#fdf0e0}
 li.dish.off .nm{color:#a04a00;font-weight:600}
 .when{display:block;font-size:11.5px;color:#a04a00;font-weight:400;margin-top:2px}
 .save{position:sticky;bottom:0;z-index:5;background:#faf7f2;padding:12px 0 8px;
       margin-top:12px;box-shadow:0 -10px 14px -8px rgba(28,20,9,0.18)}
 button.save-btn{width:100%;padding:14px;font-size:15px;font-weight:600;border:0;
                 background:#1c1409;color:#f5e8cc;cursor:pointer}
`;

export function render({ nonce, groups, soldOut, saved }) {
  const dishes = groups.reduce((all, g) => all.concat(g.dishes), []);
  const off = dishes.filter((d) => soldOut[d.id]);
  const stale = off.filter((d) => hoursOff(soldOut[d.id]) > 24);

  const rowFor = (d) => {
    const markedAt = soldOut[d.id];
    return `<li class="dish ${markedAt ? 'off' : ''} ${d.sub ? 'sub' : ''}">
      <label class="row">
        <input type="checkbox" name="soldout" value="${esc(d.id)}" ${markedAt ? 'checked' : ''}>
        <span class="nm">${esc(d.name)}
          ${markedAt ? `<span class="when">ausverkauft seit ${esc(since(markedAt))}</span>` : ''}
        </span>
        ${d.price ? `<span class="pr">${(d.price / 100).toFixed(2).replace('.', ',')} €</span>` : ''}
      </label>
    </li>`;
  };

  const sections = groups.map((g) => {
    const offHere = g.dishes.filter((d) => soldOut[d.id]).length;
    return `<h2 class="cat">${esc(g.name)}
      ${offHere ? `<span class="cat-off">${offHere} off</span>` : ''}</h2>
      <ul class="dishes">${g.dishes.map(rowFor).join('')}</ul>`;
  }).join('');

  const body = `<h1>Sold out</h1>
<div class="sub">Tick anything the kitchen has run out of. It cannot be ordered
or paid for until you untick it.</div>

${saved ? '<p class="msg">Saved. Live now.</p>' : ''}

${stale.length ? `<div class="warn"><b>${stale.length} dish(es) have been off for
  more than a day.</b> If they are back, untick them — nothing turns them on by
  itself, and a dish left off is an order nobody can place.</div>` : ''}

<form method="post" action="/admin/dishes">
  ${sections}
  <div class="save">
    <button class="save-btn" type="submit">Save</button>
  </div>
</form>

<p class="note">${off.length
  ? `${off.length} of ${dishes.length} dishes are currently unavailable.`
  : 'Everything on the menu is available.'}
The list comes from the menu itself, so a new dish appears here on its own.</p>`;

  return layout({
    title: 'Sold out', nonce, body, logout: true, back: '/admin', extraCss: CSS
  });
}
