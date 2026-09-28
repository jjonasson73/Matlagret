// Domänregler: kategorier, zoner, hållbarhet och användarens egna regler.

export const CATEGORIES = ["protein", "grönsak", "mejeri", "torrvara", "krydda", "snacks", "dryck", "övrigt"];
export const ZONES = ["kyl", "frys", "skafferi", "basvara"];
export const CONFIDENCE = ["sure", "likely", "unsure", "confirmed"];

// Användarregler som alltid gäller vid tolkning. Skickas med i prompten och
// tillämpas dessutom deterministiskt i applyZoneRules().
export const USER_RULES = [
  "Köttfärs, fisk och bröd fryses alltid direkt (zon = frys).",
];

const FREEZE_DIRECTLY = [
  /f[äa]rs/i, // nötfärs, blandfärs, fläskfärs, köttfärs
  /\b(fisk|lax|torsk|sej|kolja|r[öo]ding|fiskpinnar|fiskfil[eé])/i,
  /\b(br[öo]d|limpa|bagel|bullar?|baguett|fralla|frallor|tunnbr[öo]d|l[äa]ngtoast|toast)/i,
];

export function applyZoneRules(line) {
  if (line.zone === "basvara") return line;
  if (FREEZE_DIRECTLY.some((re) => re.test(line.name)) && !/knäck|skorpor|rån/i.test(line.name)) {
    return { ...line, zone: "frys", ruleApplied: "fryses direkt" };
  }
  return line;
}

// Hållbarhet i dagar från addedAt. null = åldras inte.
// Riktvärden: bladgrönsaker 5, färsk frukt 7, mjölk 7, färskt kött 3, bröd 4.
export function perishDays({ name = "", category, zone }) {
  if (zone === "frys" || zone === "skafferi" || zone === "basvara") return null;
  const n = name.toLowerCase();
  if (/sallad|spenat|ruccola|mache|bladgr|örtkruka|basilika|persilja|koriander/.test(n)) return 5;
  if (/mjölk|fil\b|filmjölk|grädde/.test(n)) return 7;
  if (/bröd|limpa|fralla|bagel|bulle/.test(n)) return 4;
  switch (category) {
    case "protein": return 3;
    case "grönsak": return 7;
    case "mejeri": return 14;
    case "dryck": return 30;
    default: return 14;
  }
}
