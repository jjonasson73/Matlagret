// All kontakt med Claude. Anropas bara från funktioner, aldrig från webbläsaren.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CATEGORIES, ZONES, USER_RULES } from "./rules.mjs";

export const MODEL = "claude-sonnet-4-6";

let client;
const anthropic = () => (client ??= new Anthropic());

const Category = z.enum(CATEGORIES);
const Zone = z.enum(ZONES);
const Guess = z.enum(["sure", "likely", "unsure"]);

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
  alternatives: z.array(z.string()).describe("Andra rimliga tolkningar av förkortningen, tom om säker"),
  note: z.string().nullable(),
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
- Ange alternatives när en förkortning kan betyda flera varor.
- zone: kyl, frys eller skafferi efter hur varan normalt förvaras. Mjöl, socker, salt, olja och liknande = basvara.

Användarens egna regler (gäller alltid):
${USER_RULES.map((r) => "- " + r).join("\n")}`;

const PHOTO_SYSTEM = `Du stämmer av ett foto av en förvaringsplats (kyl, frys eller skafferi) mot hushållets lager.

- Lista allt du ser i bilden som är mat, i fältet seen.
- Om en vara motsvarar en post i lagerlistan: sätt inventoryId till postens id.
- Om varan inte finns i lagret: inventoryId = null och confidence högst "likely". Omärkta hemmafrysta påsar är alltid "unsure".
- Läs bäst före-datum när de syns tydligt.
- Hellre "unsure" än en felaktig "likely".`;

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

export function parsePhoto(image, mediaType, { zone, inventory }) {
  const list = inventory
    .filter((i) => i.status !== "out" && (!zone || i.zone === zone))
    .map((i) => `${i.id}: ${i.name}, ${i.qty} ${i.unit} (${i.zone})`)
    .join("\n");
  return parse({
    system: PHOTO_SYSTEM,
    schema: Photo,
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(image).toString("base64") } },
      {
        type: "text",
        text:
          (zone ? `Bilden visar zonen: ${zone}.` : "Gissa vilken zon bilden visar.") +
          `\n\nLagret just nu:\n${list || "(tomt)"}`,
      },
    ],
  });
}
