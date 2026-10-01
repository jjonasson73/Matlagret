// All kontakt med Claude. Anropas bara från funktioner, aldrig från webbläsaren.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CATEGORIES, ZONES, USER_RULES, STYLES, ROLES } from "./rules.mjs";
import { MEAL_TYPES, MEAL_STYLES, CREATIVITY } from "./plan.mjs";

export const MODEL = "claude-sonnet-4-6";

let client;
const anthropic = () => (client ??= new Anthropic());

const Category = z.enum(CATEGORIES);
const Zone = z.enum(ZONES);
const Guess = z.enum(["sure", "likely", "unsure"]);

// Taggar för matplan och inköpslista (SPEC-matplan.md, steg 0).
const Tags = {
  styles: z.array(z.enum(STYLES)).describe("Köksstilar varan passar i, tom om den är neutral"),
  role: z.enum(ROLES),
  kind: z.string().describe("Generisk varutyp i singular, gemener: 'pasta', 'bröd', 'socker', 'crème fraiche'"),
};
const PackageSize = z
  .object({ qty: z.number(), unit: z.string() })
  .nullable()
  .describe("En förpacknings innehåll, t.ex. { qty: 500, unit: 'g' }, om det går att utläsa");

const ReceiptLine = z.object({
  raw: z.string().describe("Raden exakt som den står på kvittot"),
  articleNo: z.string().nullable(),
  name: z.string().describe("Tydligt varunamn på svenska, t.ex. 'Crème fraiche lätt'"),
  category: Category,
  zone: Zone,
  qty: z.number(),
  unit: z.string().describe("st, kg, g, l, förp"),
  price: z.number().nullable().describe("Radsumma i kr efter ev. rabatt"),
  isFood: z.boolean(),
  confidence: Guess,
  alternatives: z.array(z.string()).describe("Helt andra varor som förkortningen kan betyda, oftast tom"),
  note: z.string().nullable(),
  ...Tags,
  packageSize: PackageSize,
});

export const Receipt = z.object({
  store: z.string().nullable(),
  date: z.string().nullable().describe("YYYY-MM-DD"),
  total: z.number().nullable(),
  lines: z.array(ReceiptLine),
});

const PhotoItem = z.object({
  inventoryId: z.string().nullable().describe("id från lagerlistan om varan redan finns där, annars null"),
  name: z.string(),
  category: Category,
  qty: z.number(),
  unit: z.string(),
  confidence: Guess,
  bestBefore: z.string().nullable().describe("YYYY-MM-DD om det går att läsa"),
  alternatives: z.array(z.string()),
  ...Tags,
});

export const Tagging = z.object({
  items: z.array(z.object({ id: z.string(), ...Tags })),
});

export const Photo = z.object({
  zone: Zone,
  seen: z.array(PhotoItem),
});

// Märken som ofta står avkortade på ICA-kvitton.
const BRANDS = [
  "Arla", "Bregott", "Bravo", "Skånemejerier", "Valio", "Oatly", "Proviva", "Yoggi", "Kelda", "Philadelphia",
  "Scan", "Findus", "Felix", "Garant", "ICA Basic", "ICA I love eco", "Änglamark", "Kungsörnen", "Zeta", "Barilla",
  "Santa Maria", "Knorr", "Kavli", "Pågen", "Polarbröd", "Wasa", "Lantmännen", "Gevalia", "Zoégas", "Löfbergs",
  "Marabou", "Cloetta", "OLW", "Estrella", "Heinz", "Johnny's", "Fontana", "Dafgårds", "Lithells",
  "Sibylla", "Gårdsfisk", "Abba", "Fiskeby", "Norrmejerier", "Gott & Enkelt", "Uncle Ben's", "Risenta",
];

const TAG_RULES = `Taggar för matplanering:
- styles: bara för varor som tydligt pekar ut ett kök (${STYLES.join(", ")}): sojasås, tortillas, tacokrydda, pesto, ramen. Stilen hör till receptet, inte till råvaran, så de flesta varor ska ha tom lista – mjölk, lök, ägg, potatis, ris, kyckling. Flera stilar går bra när varan är typisk för flera kök.
- role: varans roll i en måltid. protein (kött, fisk, ägg, bönor, tofu), kolhydrat (pasta, ris, potatis, bröd, tortillas), grönsak (även frukt och bär), mejeri, smaksättning (såser, kryddor, buljong, pesto), dessert (sötsaker, glass, bakning), övrigt.
- kind: generisk varutyp i singular och gemener, så att olika sorter av samma sak får samma kind ("Spirali" och "Spaghetti" → "pasta", "Pärlsocker" → "socker", "Levain" → "bröd").`;

const RECEIPT_SYSTEM = `Du tolkar svenska matkvitton (oftast ICA via Kivra) till lagerposter för ett hushåll.

Regler:
- En rad per vara. Rabattrader (t.ex. "Såser 2f53kr", "Delikatesspo 2f25kr") hör till raden ovanför: dra av rabatten från den radens price och skapa ingen egen rad för rabatten.
- Mängd kan vara i kg (viktvaror) eller styck. Använd det kvittot anger.
- Pant, bärkassar, papper, tvättmedel, hygien och annat som inte är mat: isFood = false.
- Tolka förkortningar till tydliga namn ("Creme fraich lätt" → "Crème fraiche lätt", "Norrloumi" → "Norrloumi grillost", "Majs förkokt vac" → "Majs förkokt vakuumpackad").
- ICA kortar ofta varunamn och märken på kvittot. Skriv ut hela märkesnamnet: "Brav" → Bravo, "Brego" → Bregott, "Skånemejer" → Skånemejerier, "Kungsörn" → Kungsörnen, "Santa M" → Santa Maria, "Philad" → Philadelphia.
- Vanliga svenska märken att känna igen: ${BRANDS.join(", ")}.
- Frukt och grönt står ofta med sortnamn: "Aroma", "Pink Lady", "Ingrid Marie", "Granny Smith" är äpplen, "Conference" är päron, "Cherry" och "Piccolo" är tomater. Tolka inte sortnamn som märken eller drycker.
- Viktvaror (kg) är nästan alltid frukt, grönt, kött, fisk eller ost – aldrig dryck.
- confidence: "sure" bara när raden är entydig. Hellre "unsure" än en felaktig "likely" – användaren kontrollerar inte "likely".
- alternatives: bara när förkortningen kan betyda helt olika varor ("Creme fraich" → crème fraiche eller gräddfil). Lista inte varianter av samma vara (fryst/torkad/på burk, olika fetthalter) och inte "Annan …". Hellre en tom lista än konstlade alternativ.
- Är varan tydlig men förpackningen okänd, välj den vanligaste formen och sätt confidence "sure".
- zone: kyl, frys eller skafferi efter hur varan normalt förvaras. Torra kryddor och kryddblandningar = kryddor (färska örter = kyl). Mjöl, socker, salt, olja och liknande = basvara.

${TAG_RULES}
- packageSize: en förpacknings innehåll när det står på raden eller är känt för varan ("Nötfärs 500g" → 500 g, "Mellanmjölk 1,5l" → 1.5 l), annars null.

Användarens egna regler (gäller alltid):
${USER_RULES.map((r) => "- " + r).join("\n")}`;

const PHOTO_SYSTEM = `Du stämmer av ett eller flera foton av en förvaringsplats (kyl, frys eller skafferi) mot hushållets lager.

- Flera foton visar olika delar av samma zon (hyllor, dörr, lådor). Samma vara kan synas i flera bilder – räkna den bara en gång.
- Lista allt du ser som är mat, i fältet seen.
- Om en vara motsvarar en post i lagerlistan: sätt inventoryId till postens id.
- Om varan inte finns i lagret: inventoryId = null och confidence högst "likely". Omärkta hemmafrysta påsar är alltid "unsure".
- Läs bäst före-datum när de syns tydligt.
- Hellre "unsure" än en felaktig "likely".

${TAG_RULES}`;

const TAG_SYSTEM = `Du sätter taggar på lagerposter i ett hushålls matlager, för matplanering och inköpslista. Returnera en post per id, i samma ordning.

${TAG_RULES}`;

function knownArticles(articles) {
  const entries = Object.entries(articles ?? {});
  if (!entries.length) return "";
  return (
    "\n\nKända artikelnummer från tidigare kvitton (använd dessa namn/kategorier/zoner):\n" +
    entries.map(([no, a]) => `${no}: ${a.name} (${a.category}, ${a.zone})`).join("\n")
  );
}

async function parse({ system, content, schema }) {
  // Streaming så att ett stort max_tokens inte slår i HTTP-timeouten. Tänkandet
  // och JSON för ett långt kvitto (~60 rader) delar på samma budget.
  // effort "medium": det är extrahering, inte svår problemlösning.
  const stream = anthropic().messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: "medium", format: zodOutputFormat(schema) },
  });
  const res = await stream.finalMessage();
  console.log("Claude usage", JSON.stringify(res.usage));
  if (res.stop_reason === "refusal") throw new Error("Claude avböjde att tolka underlaget");
  if (res.stop_reason === "max_tokens") throw new Error("Svaret blev för långt (max_tokens)");
  if (!res.parsed_output) throw new Error("Kunde inte tolka svaret från Claude");
  return res.parsed_output;
}

export function parseReceiptPdf(pdf, { articles } = {}) {
  return parse({
    system: RECEIPT_SYSTEM + knownArticles(articles),
    schema: Receipt,
    content: [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") },
      },
      { type: "text", text: "Tolka kvittot." },
    ],
  });
}

export function parseReceiptText(text, { articles } = {}) {
  return parse({
    system: RECEIPT_SYSTEM + knownArticles(articles),
    schema: Receipt,
    content: [{ type: "text", text: `Tolka kvittot:\n\n${text}` }],
  });
}

export function parsePhoto(images, { zone, inventory }) {
  const list = inventory
    .filter((i) => i.status !== "out" && (!zone || i.zone === zone))
    .map((i) => `${i.id}: ${i.name}, ${i.qty} ${i.unit} (${i.zone})`)
    .join("\n");
  return parse({
    system: PHOTO_SYSTEM,
    schema: Photo,
    content: [
      ...images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: Buffer.from(img.data).toString("base64") },
      })),
      {
        type: "text",
        text:
          (images.length > 1 ? `${images.length} foton av samma zon. ` : "") +
          (zone ? `Zonen är: ${zone}.` : "Gissa vilken zon bilderna visar.") +
          `\n\nLagret just nu:\n${list || "(tomt)"}`,
      },
    ],
  });
}

// Engångstaggning av befintligt lager (poster utan role).
export function tagItems(items) {
  const list = items.map((i) => `${i.id}: ${i.name} (${i.category}, ${i.zone})`).join("\n");
  return parse({
    system: TAG_SYSTEM,
    schema: Tagging,
    content: [{ type: "text", text: `Tagga de här lagerposterna:\n\n${list}` }],
  });
}

// ---- Matplan (SPEC-matplan.md, del A) ----

const Amount = { name: z.string(), qty: z.number(), unit: z.string() };

const PlanMeal = z.object({
  slot: z.number().describe("Samma slot som i beställningen"),
  date: z.string(),
  title: z.string(),
  type: z.enum(MEAL_TYPES),
  style: z.enum(MEAL_STYLES),
  minutes: z.number().describe("Total tid från start till bord"),
  people: z.number(),
  creativity: z.enum(CREATIVITY),
  mainProtein: z.string().describe("Huvudprotein med ett ord i gemener: kyckling, nötfärs, lax, bönor, halloumi – eller ingen"),
  uses: z.array(z.object({ itemId: z.string(), ...Amount })).describe("Varor ur kandidatlistan med ungefärlig mängd"),
  missing: z.array(z.object(Amount)).describe("Det som måste köpas; basvaror räknas inte"),
  substitutions: z.array(z.object({ instead: z.string(), use: z.string(), note: z.string() })),
  thawAhead: z.array(z.object({ name: z.string(), hoursBefore: z.number() })),
  steps: z.array(z.string()),
  pairings: z.array(z.object({ ingredients: z.array(z.string()), why: z.string() })).describe("Bara för creativity ny, annars tom"),
  balance: z
    .object({ salt: z.string().nullable(), syra: z.string().nullable(), fett: z.string().nullable(), sött: z.string().nullable(), krisp: z.string().nullable() })
    .nullable()
    .describe("Bara för creativity ny, annars null"),
});

export const Plan = z.object({ meals: z.array(PlanMeal) });

const PLAN_SYSTEM = `Du planerar måltider för ett svenskt hushåll utifrån det de har hemma. Svara med en måltid per beställd slot, i samma ordning, och behåll slot, date, type, style, people och creativity från beställningen.

Prioritering:
1. Rester och varor som snart blir dåliga (markerade i kandidatlistan).
2. Protein som redan finns i frysen.
3. Vald stil och tid.
4. Så få inköp som möjligt.

Regler:
- uses får bara innehålla varor ur kandidatlistan, med deras exakta id som itemId. Allt annat som behövs ska ligga i missing.
- Basvaror och kryddor i listan "Finns alltid" får användas fritt och ska inte stå i uses eller missing.
- Mängder ska räcka för antal personer. Öppnade förpackningar (markerade) ska användas.
- minutes får inte överstiga max tid. Räkna med verklig tid, inklusive förberedelser.
- Använder rätten något från frysen som behöver tinas: lägg det i thawAhead med hoursBefore (oftast 12–24).
- Variera huvudprotein mellan dagar i rad och undvik det som lagats nyligen.
- substitutions: när något i lagret kan ersätta en vanlig ingrediens i rätten ("crème fraiche i stället för grädde").
- steps: 4–8 korta steg på svenska.
- type dessert eller fredagsmys: söta rätter eller mys, inte middag.
- inköp: "inga – bara det som finns" betyder att missing måste vara tom; anpassa rätten efter lagret hellre än tvärtom (byt ingrediens, använd substitutions). "högst 3 varor" betyder högst tre poster i missing. "fritt" betyder att inköp är okej om rätten blir bättre.

creativity:
- "känd": en etablerad rätt i vald stil (pad thai, köttfärssås, tacos, pytt i panna). pairings tom, balance null.
- "ny": en rätt som inte behöver finnas som känt recept. Utgå från ankarvarorna om sådana finns, annars de mest brådskande. Välj resten utifrån smakkombinationer – klassiska par som kockar använder och par som delar aromämnen. Balansera salt, syra och fett, gärna något sött och krispigt. Håll tekniken bekant (ugnsrostat, wok, gratäng, pasta, sallad) så att bara kombinationen är ny. Högst två varor i missing. Förklara 1–3 kombinationer i pairings och fyll balance.`;

const fmtQty = (c) => `${c.qty} ${c.unit}`;

function candidateLine(c) {
  const notes = [
    c.leftover && "rester",
    c.why,
    c.opened && `öppnad, ${c.remaining == null ? "" : `${Math.round(c.remaining * 100)} % kvar`}`,
  ].filter(Boolean);
  return `${c.id} | ${c.name} | ${fmtQty(c)} | ${c.zone} | ${c.role}${notes.length ? " | " + notes.join(", ") : ""}`;
}

function orderLine(o) {
  return [
    `slot ${o.slot}: ${o.date}`,
    o.type,
    `stil ${o.style}`,
    `max ${o.maxMinutes ?? "fritt"} min`,
    `${o.people} personer`,
    `creativity ${o.creativity}`,
    `inköp ${{ hemma: "inga – bara det som finns", få: "högst 3 varor", fritt: "fritt" }[o.shopping ?? "få"]}`,
    o.anchors?.length ? `ankare: ${o.anchors.join(", ")}` : null,
  ].filter(Boolean).join(", ");
}

// Planera en eller flera måltider. fixed = måltider som ligger kvar (låsta eller
// redan godkända) och skickas med som sammanhang; hints = extra krav per slot.
export function planMeals({ order, candidates, basics, history = [], fixed = [], hints = {}, avoid = [] }) {
  const parts = [
    `Beställning:\n${order.map(orderLine).join("\n")}`,
    `Kandidatlista (id | namn | mängd | zon | roll | notering):\n${candidates.map(candidateLine).join("\n")}`,
    `Finns alltid: ${basics.join(", ") || "salt, peppar, olja"}`,
  ];
  if (history.length) parts.push(`Lagat nyligen:\n${history.map((h) => `${h.date}: ${h.title} (${h.mainProtein}, ${h.style})`).join("\n")}`);
  if (fixed.length) parts.push(`Ligger redan i planen (ändra inte, men variera mot dem):\n${fixed.map((m) => `${m.date}: ${m.title} (${m.mainProtein}, ${m.style})`).join("\n")}`);
  if (avoid.length) parts.push(`Kombinationer som hushållet inte gillade – undvik:\n${avoid.join("\n")}`);
  const hintLines = Object.entries(hints).flatMap(([slot, list]) => list.map((h) => `slot ${slot}: ${h}`));
  if (hintLines.length) parts.push(`Måste rättas från förra förslaget:\n${hintLines.join("\n")}`);
  return parse({
    system: PLAN_SYSTEM,
    schema: Plan,
    content: [{ type: "text", text: parts.join("\n\n") }],
  });
}
