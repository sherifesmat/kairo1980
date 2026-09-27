/* Which extras each dish offers, set up without a developer.
   ---------------------------------------------------------------------------
   Like the hours. index.html's hidden .addon-groups block and each dish's
   data-addons are the DEFAULT. Once this page is saved, a settings row holds
   the WHOLE setup — every group of extras, and for every dish the groups it
   offers — and the default is not consulted until "reset" deletes the row.
   One of the two is in effect, never a blend of both.

   What this page does not own:
     - the price of an extra. An extra IS a dish on the menu and costs what
       that dish costs (/admin/prices), wherever it is offered.
     - what a Menü includes. The drink of a 23-euro Menü is what the Menü is
       made of, not an optional extra, so that group stays as the menu has it
       and is shown here read-only.

   Every figure is checked against the menu on the way in AND on the way out
   (effectiveMenu() in worker/site-data.js), so a dish removed from the menu
   drops out of every group by itself. A value that is not valid REFUSES THE
   WHOLE SAVE and the page comes back as it was typed. */

import { layout, esc, newNonce, adminHeaders } from './pages.js';
import { readSettings, writeAddons, resetAddons } from '../settings.js';
import { menuData, effectiveMenu } from '../site-data.js';

const LANGS = ['de', 'en', 'ar'];

/** What the page needs: the dishes by menu group, which of them can be an
 *  extra, and the setup in effect. */
async function model(env, addons) {
  const data = await menuData(env);
  const effective = effectiveMenu(data, addons);
  const included = new Set();
  for (const d of data.dishes.values()) d.includes.forEach((g) => included.add(g));

  const categories = [];
  for (const [id, dish] of data.dishes) {
    const name = dish.category || 'Weitere';
    let c = categories.find((x) => x.name === name);
    if (!c) categories.push((c = { name, dishes: [] }));
    c.dishes.push({
      id, name: dish.name,
      // A plain priced dish can be an extra; one with choices of its own cannot.
      offerable: dish.price > 0 && !dish.groups.length && !dish.includes.length,
      includes: dish.includes
    });
  }
  const groups = [...effective.addonGroups.values()].filter((g) => !included.has(g.id));
  const fixed = [...effective.addonGroups.values()].filter((g) => included.has(g.id));
  const assigned = {};
  for (const [id, d] of effective.dishes) assigned[id] = d.addons;
  return { categories, groups, fixed, included, assigned, known: new Set(data.dishes.keys()) };
}

function unavailable() {
  const nonce = newNonce();
  const body = `<h1>Extras</h1>
<p class="err"><b>The saved extras cannot be read right now.</b> Nothing can be
changed until they can — try again in a minute.</p>`;
  return new Response(layout({ title: 'Extras', nonce, body, logout: true, back: '/admin', extraCss: CSS }), {
    status: 503, headers: adminHeaders(nonce)
  });
}

export async function page(request, env, url) {
  const { addons, unreadable } = await readSettings(env);
  if (unreadable) return unavailable();
  const m = await model(env, addons);
  const nonce = newNonce();
  const draft = {
    groups: m.groups.map((g) => ({ id: g.id, ...g.labels, max: String(g.max), refs: g.refs })),
    assigned: m.assigned,
    fresh: { de: '', en: '', ar: '', max: '1', refs: [] }
  };
  return new Response(render({ nonce, m, draft, errors: [], custom: !!addons, saved: url.searchParams.get('saved') }),
    { headers: adminHeaders(nonce) });
}

const slug = (text) => text.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'extras';

/** The form, read into the saved shape — or the list of what is wrong. */
export function readForm(form, m) {
  const errors = [];
  const groups = {};
  const draft = { groups: [], assigned: {}, fresh: {} };
  const offerable = new Set(m.categories.flatMap((c) => c.dishes.filter((d) => d.offerable).map((d) => d.id)));

  const one = (prefix, id, label) => {
    const g = { id };
    for (const l of LANGS) g[l] = String(form.get(`${prefix}:${l}`) || '').trim();
    g.max = String(form.get(`${prefix}:max`) || '').trim();
    g.refs = form.getAll(`${prefix}:ref`).map(String).filter((r) => offerable.has(r));
    const bad = [];
    if (LANGS.some((l) => !g[l])) bad.push('a name in all three languages');
    if (LANGS.some((l) => g[l].length > 60)) bad.push('names of at most 60 characters');
    if (!g.refs.length) bad.push('at least one dish');
    const max = Number(g.max);
    if (!/^\d+$/.test(g.max) || max < 1 || max > Math.max(1, g.refs.length)) {
      bad.push(`"how many" from 1 to ${Math.max(1, g.refs.length)}`);
    }
    if (bad.length) errors.push(`${label}: needs ${bad.join(', ')}.`);
    return { g, max };
  };

  for (const id of form.getAll('group').map(String)) {
    if (!m.groups.some((g) => g.id === id) && !/^[a-z0-9-]{1,40}$/.test(id)) continue;
    if (m.included.has(id)) continue;             // a Menü's contents: not ours
    const removed = !!form.get(`g:${id}:remove`);
    const { g, max } = removed ? { g: { id, de: '', en: '', ar: '', max: '1', refs: [] }, max: 0 } : one(`g:${id}`, id, `"${form.get(`g:${id}:de`) || id}"`);
    draft.groups.push({ ...g, removed });
    if (!removed) groups[id] = { de: g.de, en: g.en, ar: g.ar, max, refs: g.refs };
  }

  // A new group only when it has been given a name; otherwise the empty
  // "new group" form is simply not filled in.
  const freshTyped = LANGS.some((l) => String(form.get(`new:${l}`) || '').trim());
  if (freshTyped) {
    let id = slug(String(form.get('new:de') || form.get('new:en') || ''));
    for (let n = 2; groups[id] || m.included.has(id) || m.groups.some((g) => g.id === id); n++) id = `${slug(String(form.get('new:de') || ''))}-${n}`;
    const { g, max } = one('new', id, 'The new group');
    draft.fresh = g;
    groups[id] = { de: g.de, en: g.en, ar: g.ar, max, refs: g.refs };
  } else {
    draft.fresh = { de: '', en: '', ar: '', max: '1', refs: [] };
  }

  const dishes = {};
  for (const c of m.categories) {
    for (const d of c.dishes) {
      const chosen = form.getAll(`d:${d.id}`).map(String).filter((g) => groups[g]);
      draft.assigned[d.id] = chosen;
      dishes[d.id] = chosen;
    }
  }
  return { value: { groups, dishes }, errors, draft };
}

export async function save(request, env) {
  const form = await request.formData();
  const { addons, unreadable } = await readSettings(env);
  if (unreadable) return unavailable();
  const m = await model(env, addons);
  const { value, errors, draft } = readForm(form, m);
  if (errors.length) {
    const nonce = newNonce();
    return new Response(render({ nonce, m, draft, errors, custom: !!addons, saved: null }), {
      status: 400, headers: adminHeaders(nonce)
    });
  }
  await writeAddons(env, value);
  return new Response(null, { status: 303, headers: { Location: '/admin/extras?saved=1', 'Cache-Control': 'no-store' } });
}

export async function reset(request, env) {
  if ((await readSettings(env)).unreadable) return unavailable();
  await resetAddons(env);
  return new Response(null, { status: 303, headers: { Location: '/admin/extras?saved=reset', 'Cache-Control': 'no-store' } });
}

const CSS = `
 .msg{padding:10px 12px;border:1px solid #bcd8b0;background:#eef6ea;color:#31601f;font-size:13.5px;margin-bottom:14px}
 .err{padding:10px 12px;border:1px solid #e0a0a0;background:#fbeaea;color:#8a1f1f;font-size:13.5px;margin-bottom:14px}
 .err li{margin:2px 0}
 h2{font-size:17px;margin:26px 0 8px}
 fieldset.group{border:1px solid #e6dcc9;background:#fff;padding:12px 14px;margin:0 0 14px}
 fieldset.group legend{font-weight:600;padding:0 6px}
 fieldset.removed{opacity:.55}
 .names{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:8px}
 .names label,.max label{font-size:12px;color:#7a6030;text-transform:none;letter-spacing:0;margin:0}
 .names input{width:100%;padding:7px;font-size:14px;border:1px solid #d9ccb0}
 .max input{width:60px;padding:7px;font-size:14px;border:1px solid #d9ccb0}
 .cat{font-size:11px;color:#7a6030;margin:10px 0 4px}
 .picks{display:flex;flex-wrap:wrap;gap:6px 14px}
 .picks label{display:flex;align-items:center;gap:6px;font-size:13.5px;text-transform:none;letter-spacing:0;margin:0}
 .remove{margin-top:10px;font-size:12.5px;color:#a0661a}
 ul.dishes{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e6dcc9}
 ul.dishes li{padding:10px 14px;border-bottom:1px solid #f0e8d8}
 ul.dishes li:last-child{border-bottom:none}
 .dn{font-size:14.5px;margin-bottom:4px}
 .fixed{font-size:12px;color:#7a6030}
 .save{position:sticky;bottom:0;z-index:5;background:#faf7f2;padding:12px 0 8px;margin-top:12px;box-shadow:0 -10px 14px -8px rgba(28,20,9,0.18)}
 button.save-btn{width:100%;padding:14px;font-size:15px;font-weight:600;border:0;background:#1c1409;color:#f5e8cc;cursor:pointer}
 form.reset-all{margin-top:22px}
 button.reset-btn{width:100%;padding:12px;font-size:14px;border:1px solid #c9b48a;background:#fff;color:#7a6030;cursor:pointer}
`;

export function render({ nonce, m, draft, errors, custom, saved }) {
  const names = (prefix, g) => `<div class="names">${LANGS.map((l) => `
    <label>${{ de: 'Deutsch', en: 'English', ar: 'العربية' }[l]}
      <input name="${prefix}:${l}" value="${esc(g[l] || '')}" maxlength="60" ${l === 'ar' ? 'dir="rtl"' : ''}></label>`).join('')}
  </div>
  <div class="max"><label>How many may a guest pick? <input name="${prefix}:max" value="${esc(g.max || '')}" inputmode="numeric"></label></div>`;

  const picks = (prefix, chosen) => m.categories.map((c) => {
    const ds = c.dishes.filter((d) => d.offerable);
    if (!ds.length) return '';
    return `<div class="cat">${esc(c.name)}</div><div class="picks">${ds.map((d) => `
      <label><input type="checkbox" name="${prefix}:ref" value="${esc(d.id)}" ${chosen.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')}</div>`;
  }).join('');

  const groupBlock = (g) => `<fieldset class="group ${g.removed ? 'removed' : ''}">
    <legend>${esc(g.de || g.id)}</legend>
    <input type="hidden" name="group" value="${esc(g.id)}">
    ${names(`g:${g.id}`, g)}
    ${picks(`g:${g.id}`, g.refs || [])}
    <label class="remove"><input type="checkbox" name="g:${esc(g.id)}:remove" ${g.removed ? 'checked' : ''}> Remove this group (and from every dish)</label>
  </fieldset>`;

  const allGroups = draft.groups.filter((g) => !g.removed);
  const dishRows = m.categories.map((c) => `<h3 class="cat">${esc(c.name)}</h3><ul class="dishes">${c.dishes.map((d) => `
    <li><div class="dn">${esc(d.name)}</div>
      <div class="picks">${allGroups.map((g) => `
        <label><input type="checkbox" name="d:${esc(d.id)}" value="${esc(g.id)}" ${(draft.assigned[d.id] || []).includes(g.id) ? 'checked' : ''}> ${esc(g.de || g.id)}</label>`).join('') || '<span class="fixed">No groups yet.</span>'}</div>
      ${d.includes.length ? `<div class="fixed">Included in the price (set by the menu): ${esc(m.fixed.filter((f) => d.includes.includes(f.id)).map((f) => f.labels.de).join(', '))}</div>` : ''}
    </li>`).join('')}</ul>`).join('');

  const body = `<h1>Extras</h1>
<div class="sub">What a guest can add to a dish — a drink, a side, a sauce. An extra is a dish
on the menu and costs what that dish costs (change it at <a href="/admin/prices">Prices</a>).
${custom ? 'Currently using the extras saved here.' : 'Currently using the extras from the menu.'}
Once saved, a dish added to the menu later offers no extras until you tick it below.</div>

${saved === '1' ? '<p class="msg">Saved. Live now.</p>' : ''}
${saved === 'reset' ? '<p class="msg">The extras are back to the menu’s.</p>' : ''}
${errors.length ? `<div class="err"><b>Nothing was saved.</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}

<form method="post" action="/admin/extras">
  <h2>Groups of extras</h2>
  ${draft.groups.map(groupBlock).join('') || '<p>No groups.</p>'}

  <h2>New group</h2>
  <fieldset class="group">
    <legend>New group</legend>
    ${names('new', draft.fresh)}
    ${picks('new', draft.fresh.refs || [])}
  </fieldset>

  <h2>Which dish offers which group</h2>
  ${dishRows}

  <div class="save"><button class="save-btn" type="submit">Save</button></div>
</form>

${custom ? `<form class="reset-all" method="post" action="/admin/extras/reset">
  <button class="reset-btn" type="submit">Put the extras back to the menu’s</button>
</form>` : ''}`;

  return layout({ title: 'Extras', nonce, body, logout: true, back: '/admin', extraCss: CSS });
}
