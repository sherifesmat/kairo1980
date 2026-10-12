/* The allergen letters live in one place: the legend the menu generates.
   The FAQs on the home page and the catering page each once carried their own
   copy, "(a Gluten, g Milch, h Schalenfrüchte, k Sesam)", in three languages.
   Six hand-written copies went stale the day egg was declared. Loop
   ALLERGENS_FROM_LABELS (sherifesmat/KBOSS), point C. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// "(a Gluten, g Milch, …)", "(a gluten, g milk, …)", "(a جلوتين، g لبن، …)":
// a parenthesis that opens on a lone code letter and names a second one.
const LETTER_LIST = /\(\s*[a-n]\s+[^()]{1,40}?[,،]\s*[a-n]\s+[^()]*\)/u;

for (const file of ['index.html', 'firmencatering.html']) {
  const html = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  for (const lang of ['de', 'en', 'ar']) {
    test(`${file} ${lang}: no hand-written allergen letter list`, () => {
      const texts = [...html.matchAll(new RegExp(`data-${lang}="([^"]*)"`, 'g'))].map((m) => m[1]);
      const stale = texts.filter((t) => LETTER_LIST.test(t));
      assert.deepEqual(stale, [], `a copied legend is back in ${file} (${lang})`);
    });
  }
  test(`${file}: no hand-written allergen letter list in the rendered text`, () => {
    const visible = html.replace(/<[^>]*>/g, ' ');
    assert.equal(LETTER_LIST.test(visible), false);
  });
}
