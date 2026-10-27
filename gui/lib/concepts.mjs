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
  // Vocabulary aliases: the catalog's shortlist matches on shared word stems, which misses compounds
  // ("Wahlbeteiligung" vs "Bundestagswahlbeteiligung") and everyday words ("Verschuldung").
  if (/(?<![a-zäöüß])wahlbeteiligung/i.test(out)) out = out.replace(/(?<![a-zäöüß])wahlbeteiligung/i, 'Bundestagswahlbeteiligung 2021');
  if (/(?<![a-zäöüß])(ver|über)?schuldung|(?<![a-zäöüß])schulden/i.test(out) && !/kommunal|kassenkredit|überschuldet/i.test(out)) {
    out = out.replace(/\b(wie hoch|wie viel)\b[^?]*?\b(in|für)\b/i, 'Wie hoch ist der Anteil überschuldeter Personen über 18 Jahre in');
    if (!/überschuldeter/i.test(out)) out = `Wie hoch ist der Anteil überschuldeter Personen über 18 Jahre in ${place || 'Deutschland'}?`;
    prefix += 'Zur Verschuldung weist der Deutschlandatlas den Anteil überschuldeter Personen aus: ';
  }
  const where = place && LANDESHAUPTSTADT[key] ? LANDESHAUPTSTADT[key] : place;
  // EXACT intents only. "Einkommen je Einwohner", "Steuereinnahmekraft je Einwohner" etc. are real indicators
  // that merely contain the word Einwohner — they must never be remapped (live defect: income -> 65+).
  const REAL_INDICATOR = /(\b(je|pro)\s+(\d[\d._]*\s*)?einwohner|einkommen|kraft|quote|anteil|saldo|kredit|schuld|arbeitslos|hausärzt|straftat|breitband|wahl)/i;
  const INCOME = /(einkommen|gehalt|gehälter|lohn|löhne|verdien|kaufkraft)/i;
  if (INCOME.test(out) && !/verfügbare[sn]? einkommen/i.test(out) && !/steuer|einnahme|geringfügig|beschäftig/i.test(out)) {
    const exact = /einkommen/i.test(out) && !/gehalt|gehälter|lohn|löhne|verdien|kaufkraft/i.test(out);
    out = `Wie hoch ist das verfügbare Einkommen privater Haushalte je Einwohner in ${where}?`;
    if (!exact) prefix += 'Löhne, Gehälter und Kaufkraft enthält der Deutschlandatlas nicht; das nächstliegende ist das verfügbare Einkommen je Einwohner: ';
  } else if (/(wie viele (einwohner|menschen|leute)|einwohnerzahl|bevölkerungszahl|bevölkerungsdichte|einwohnerdichte|wie groß ist die bevölkerung)/i.test(out)
      && !REAL_INDICATOR.test(out)) {    out = `Wie hoch ist der Anteil der 65-Jährigen und Älteren an der Gesamtbevölkerung in ${where}?`;
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
