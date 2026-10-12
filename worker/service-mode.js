/* Render the active copy without overwriting the saved delivery translations. */
import { CONFIG } from './site-data.js';
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function withServiceMode(html, mode) {
  if (mode !== 'pickup') return html;
  let out = html.replace(/<body([^>]*)>/, (whole, attrs) => {
    if (/\bclass="/.test(attrs)) return '<body' + attrs.replace(/class="/, 'class="pickup-only ') + '>';
    return '<body class="pickup-only"' + attrs + '>';
  });
  out = out.replace(/(<p[^>]*class="payment-note"[^>]*>)[\s\S]*?(<\/p>)/g,
    '$1Zahlung bei Abholung oder online.$2');
  const opening = /<(p|span|h2|a|summary|title|meta)\b[^>]*\bdata-pickup-de="([^"]*)"[^>]*>/g;
  const matches = [...out.matchAll(opening)].reverse();
  for (const m of matches) {
    let tag = m[0];
    const href = tag.match(/\bdata-pickup-href="([^"]*)"/);
    if (href) tag = tag.replace(/(?<![-\w])href="[^"]*"/, 'href="' + href[1] + '"');
    const start = m.index;
    const end = start + m[0].length;
    if (m[1] === 'meta') {
      tag = tag.replace(/(?<![-\w])content="[^"]*"/, 'content="' + m[2] + '"');
      out = out.slice(0, start) + tag + out.slice(end);
    } else {
      const close = out.indexOf('</' + m[1] + '>', end);
      if (close !== -1) out = out.slice(0, start) + tag + escape(decode(m[2]).replace(/\{discount\}/g,
        String(CONFIG.order?.directDiscountPercent || 0))) + out.slice(close);
    }
  }
  // The source keeps its original regional service schema for delivery mode.
  out = out.replace(/(<script[^>]*id="serviceSchema"[^>]*>)([\s\S]*?)(<\/script>)/,
    (whole, before, raw, after) => {
      try {
        const d = JSON.parse(raw);
        d.name = 'Mittagessen für Teams zur Abholung in Hockenheim';
        d.description = 'Ägyptische Küche zur Abholung in Hockenheim. Keine Lieferung.';
        d.areaServed = ['Hockenheim'];
        return before + JSON.stringify(d).replace(/</g, '\\u003c') + after;
      } catch { return whole; }
    });
  return out;
}
