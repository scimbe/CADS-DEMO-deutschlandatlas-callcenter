// Explicit concept mapping for questions the Deutschlandatlas catalog cannot answer literally.
// The catalog (152 indicators, Kreis/Stadt level) has NO absolute population, population density or
// average age, no generic "Ärzte" (only Hausärzte je 100.000) and no Bundesland rows. Instead of a
// vague "no data", the call center says so concretely and answers with the closest REAL indicator.
// Pure + deterministic (no LLM): rewriteQuery() -> { query, prefix } (prefix is spoken before the answer).
import { placeFromQuery } from './text.mjs';

export const LANDESHAUPTSTADT = {
  'baden-württemberg': 'Stuttgart', bayern: 'München', berlin: null, brandenburg: 'Potsdam', bremen: null,
  hamburg: null, hessen: 'Wiesbaden', 'mecklenburg-vorpommern': 'Schwerin', niedersachsen: 'Hannover',
  'nordrhein-westfalen': 'Düsseldorf', 'rheinland-pfalz': 'Mainz', saarland: 'Saarbrücken', sachsen: 'Dresden',
  'sachsen-anhalt': 'Magdeburg', 'schleswig-holstein': 'Kiel', thüringen: 'Erfurt',
};
const lc = (s) => String(s || '').toLowerCase();

export function rewriteQuery(query) {
  const q = String(query || '').trim();
  if (!q) return { query: q, prefix: '' };
  const place = placeFromQuery(q) || (q.match(/\b([A-ZÄÖÜ][\wäöüß-]+(?:\s[A-ZÄÖÜ][\wäöüß-]+)?)\s*[?.!]?\s*$/) || [])[1] || '';
  let out = q, prefix = '';
  const key = lc(place).trim();
  // Bundesland -> Landeshauptstadt (city-states Berlin/Hamburg/Bremen are real rows already)
  if (Object.prototype.hasOwnProperty.call(LANDESHAUPTSTADT, key) && LANDESHAUPTSTADT[key]) {
    const city = LANDESHAUPTSTADT[key];
    out = out.replace(new RegExp(place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), city);
    prefix = `Für das Bundesland ${place} liegen im Deutschlandatlas keine Werte vor, nur für Städte und Kreise. Für die Landeshauptstadt ${city}: `;
  }
  const where = place && LANDESHAUPTSTADT[key] ? LANDESHAUPTSTADT[key] : place;
  if (/einwohner|bevölkerungszahl|bevölkerungsdichte|wie viele (menschen|leute)/i.test(out)
      && !/\b(je|pro)\s*\d|anteil|quote|kraft|saldo|kredit/i.test(out)) {
    out = `Wie hoch ist der Anteil der 65-Jährigen und Älteren an der Gesamtbevölkerung in ${where}?`;
    prefix += 'Eine absolute Einwohnerzahl oder Bevölkerungsdichte enthält der Deutschlandatlas nicht. Zur Bevölkerung kann ich Ihnen den Anteil der 65-Jährigen und Älteren nennen: ';
  } else if (/durchschnittsalter|medianalter|wie alt sind/i.test(out)) {
    out = `Wie hoch ist der Anteil der 65-Jährigen und Älteren an der Gesamtbevölkerung in ${where}?`;
    prefix += 'Ein Durchschnittsalter enthält der Deutschlandatlas nicht. Das Alter der Bevölkerung beschreibt dort der Anteil der 65-Jährigen und Älteren: ';
  } else if (/(?<![a-zäöüß])(ärzt|arzt)/i.test(out) && !/hausärzt/i.test(out)) {
    out = `Wie viele Hausärzte gibt es je 100.000 Einwohner in ${where}?`;
    prefix += 'Der Deutschlandatlas weist Hausärzte aus: ';
  }
  return { query: out, prefix };
}
