// Matplanen (SPEC-matplan.md, del A): beställning, kandidatlista och regelkontroll.
// Ren logik utan lagring och utan Claude, så att den går att testa och logga.
import { normalize } from "./shopping.mjs";

export const MEAL_TYPES = ["middag", "lunch", "matlåda", "dessert", "fredagsmys"];
export const MEAL_STYLES = ["vardagsmat", "asiatiskt", "italienskt", "husman", "mexikanskt", "fritt"];
export const MAX_MINUTES = [20, 30, 45, null]; // null = fritt
export const CREATIVITY = ["känd", "ny"];
// Inköp: hemma = bara det som finns, få = högst några varor, fritt = ingen gräns.
export const SHOPPING = ["hemma", "få", "fritt"];
export const MAX_MISSING_FEW = 3;

export const CANDIDATE_LIMIT = 36;
// Utan inköp behöver Claude se mer av lagret för att ha något att välja på.
export const CANDIDATE_LIMIT_HOME = 50;
const HISTORY_DAYS = 14;
const MAX_MISSING_NEW = 2;

const DAY = 864e5;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// ---- Beställningen ----

// Fyller i förval och kontrollerar en beställning. Kastar vid fel.
export function normalizeOrder(meals, today = new Date()) {
  if (!Array.isArray(meals) || !meals.length) throw new Error("Beställ minst en måltid");
  if (meals.length > 10) throw new Error("Högst 10 måltider per plan");
  return meals.map((m, slot) => {
    const type = m.type ?? "middag";
    const style = m.style ?? "vardagsmat";
    const creativity = m.creativity ?? "känd";
    const shopping = m.shopping ?? "få";
    const maxMinutes = m.maxMinutes === "fritt" || m.maxMinutes == null ? null : Number(m.maxMinutes);
    if (!MEAL_TYPES.includes(type)) throw new Error(`Okänd måltidstyp: ${type}`);
    if (!MEAL_STYLES.includes(style)) throw new Error(`Okänd stil: ${style}`);
    if (!CREATIVITY.includes(creativity)) throw new Error(`Okänd kreativitet: ${creativity}`);
    if (!SHOPPING.includes(shopping)) throw new Error(`Okänt inköpsval: ${shopping}`);
    if (!MAX_MINUTES.includes(maxMinutes)) throw new Error(`Ogiltig tid: ${m.maxMinutes}`);
    const people = Number(m.people ?? 4);
    if (!(people >= 1 && people <= 12)) throw new Error("Antal personer ska vara 1–12");
    const date = m.date ? isoDay(m.date) : isoDay(today.getTime() + slot * DAY);
    return { slot, date, type, style, maxMinutes, people, creativity, shopping, anchors: m.anchors ?? [] };
  });
}

// ---- Kandidatlistan ----

const ROLE_FROM_CATEGORY = { protein: "protein", grönsak: "grönsak", mejeri: "mejeri", krydda: "smaksättning", snacks: "dessert" };
const roleOf = (item) => item.role ?? ROLE_FROM_CATEGORY[item.category] ?? (item.category === "torrvara" ? "kolhydrat" : "övrigt");

// Platser per roll, så att listan inte bara blir protein.
const QUOTA = { protein: 8, kolhydrat: 7, grönsak: 9, mejeri: 5, smaksättning: 5, dessert: 2, övrigt: 2 };

export function daysLeft(item, now = new Date()) {
  const ends = [];
  if (item.perishDays != null && item.addedAt) ends.push(new Date(item.addedAt).getTime() + item.perishDays * DAY);
  if (item.bestBefore) ends.push(new Date(item.bestBefore).getTime() + DAY);
  if (!ends.length) return null;
  return Math.floor((Math.min(...ends) - now.getTime()) / DAY);
}

// Brådska: rester och troligen slut först, sedan färskvaror nära sista dag,
// sedan fryst (protein i frysen före övrigt), sist skafferi.
export function urgency(item, now = new Date()) {
  if (item.source === "leftover" && item.zone !== "frys") return { score: 100, why: "rester" };
  if (item.status === "probably_out") return { score: 80, why: "kanske slut – använd det som finns" };
  const left = daysLeft(item, now);
  if (left != null) {
    const score = Math.max(20, Math.min(75, 75 - left * 8));
    const why = left <= 0 ? "går ut idag" : left <= 2 ? `går ut om ${left} d` : null;
    return { score, why };
  }
  if (item.zone === "frys") return { score: roleOf(item) === "protein" ? 35 : 25, why: null };
  return { score: 10, why: null };
}

const openedBonus = (item) => (item.opened ? 15 + Math.round((1 - (item.remaining ?? 1)) * 20) : 0);

// Basvaror och kryddor finns alltid och skickas som en kort lista, inte som kandidater.
const ALWAYS_THERE = ["basvara", "kryddor"];

// Liten knuff för stilbärande varor – väger klart mindre än brådska.
const STYLE_NUDGE = 8;

export function buildCandidates(inventory, order, { now = new Date(), limit } = {}) {
  limit ??= order.some((m) => m.shopping === "hemma") ? CANDIDATE_LIMIT_HOME : CANDIDATE_LIMIT;
  const styles = new Set(order.map((m) => m.style));
  const wantsDessert = order.some((m) => m.type === "dessert" || m.type === "fredagsmys");
  const quota = { ...QUOTA, dessert: wantsDessert ? 6 : QUOTA.dessert };
  const anchors = new Set(order.flatMap((m) => m.anchors ?? []));

  const scored = inventory.items
    .filter((i) => (i.status === "active" || i.status === "probably_out") && !ALWAYS_THERE.includes(i.zone))
    .map((item) => {
      const u = urgency(item, now);
      const nudge = (item.styles ?? []).some((s) => styles.has(s)) ? STYLE_NUDGE : 0;
      const anchor = anchors.has(item.id) ? 1000 : 0;
      return { item, role: roleOf(item), why: u.why, score: u.score + openedBonus(item) + nudge + anchor };
    })
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const used = {};
  for (const c of scored) {
    if ((used[c.role] ?? 0) < (quota[c.role] ?? 2)) {
      picked.push(c);
      used[c.role] = (used[c.role] ?? 0) + 1;
    }
  }
  // Fyll på med de högst poängsatta som inte fick plats i sin roll.
  for (const c of scored) {
    if (picked.length >= limit) break;
    if (!picked.includes(c)) picked.push(c);
  }

  const candidates = picked
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, role, why, score }) => ({
      id: item.id,
      name: item.name,
      qty: item.qty,
      unit: item.unit,
      zone: item.zone,
      role,
      kind: item.kind ?? null,
      opened: !!item.opened,
      remaining: item.remaining ?? null,
      leftover: item.source === "leftover",
      why,
      score,
    }));

  // Basvaror och kryddor finns alltid; de skickas som en kort lista utan poäng.
  const basics = inventory.items
    .filter((i) => i.status !== "out" && ALWAYS_THERE.includes(i.zone))
    .map((i) => i.name);

  return { candidates, basics };
}

// ---- Regelkontrollen ----

const proteinKey = (p) => normalize(p ?? "");
const NO_PROTEIN = new Set(["", "ingen", "inget", "vegetariskt", "vegetarisk"]);

// Returnerar { bySlot: { [slot]: [skäl] }, hints: { [slot]: [instruktion] } }.
// Bara de måltider som bryter mot en regel genereras om.
export function validatePlan(meals, order, candidates, { history = [], now = new Date(), locked = [] } = {}) {
  const bySlot = {};
  const hints = {};
  const flag = (slot, reason, hint) => {
    if (locked.includes(slot)) return;
    (bySlot[slot] ??= []).push(reason);
    if (hint) (hints[slot] ??= []).push(hint);
  };
  const ids = new Set(candidates.map((c) => c.id));
  const bySlotOrder = Object.fromEntries(order.map((o) => [o.slot, o]));

  for (const m of meals) {
    const o = bySlotOrder[m.slot];
    // Regel 5: tiden.
    if (o?.maxMinutes && m.minutes > o.maxMinutes) {
      flag(m.slot, `tar ${m.minutes} min, max ${o.maxMinutes}`, `Rätten måste gå att laga på högst ${o.maxMinutes} minuter.`);
    }
    // uses måste peka på riktiga varor.
    const unknown = m.uses.filter((u) => !ids.has(u.itemId));
    if (unknown.length) {
      flag(m.slot, `okända varor: ${unknown.map((u) => u.name).join(", ")}`, "Använd bara itemId från kandidatlistan; allt annat ska ligga i missing.");
    }
    // Nya rätter får ha högst två inköp.
    // Inköpsvalet.
    if (o?.shopping === "hemma" && m.missing.length) {
      flag(m.slot, `kräver inköp: ${m.missing.map((x) => x.name).join(", ")}`,
        "Använd bara det som finns i kandidatlistan och bland basvarorna – missing ska vara tom. Byt ut det som saknas.");
    } else if (o?.shopping === "få" && m.missing.length > MAX_MISSING_FEW) {
      flag(m.slot, `${m.missing.length} inköp, max ${MAX_MISSING_FEW}`, `Högst ${MAX_MISSING_FEW} varor i missing – använd mer av det som finns.`);
    }
    if (o?.creativity === "ny" && m.missing.length > MAX_MISSING_NEW) {
      flag(m.slot, `ny rätt med ${m.missing.length} inköp`, `En ny rätt får ha högst ${MAX_MISSING_NEW} varor i missing.`);
    }
    // Regel 4: inte samma protein och stil som lagats de senaste 14 dagarna.
    const recent = history.find(
      (h) =>
        now - new Date(h.date) <= HISTORY_DAYS * DAY &&
        !NO_PROTEIN.has(proteinKey(h.mainProtein)) &&
        proteinKey(h.mainProtein) === proteinKey(m.mainProtein) &&
        h.style === m.style,
    );
    if (recent) {
      flag(m.slot, `${m.mainProtein} ${m.style} lagades ${recent.date}`, `Undvik ${m.mainProtein} i ${m.style} stil – det lagades nyligen.`);
    }
  }

  // Regel 1: samma huvudprotein två dagar i rad.
  const byDate = [...meals].sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot);
  for (let i = 1; i < byDate.length; i++) {
    const prev = byDate[i - 1];
    const cur = byDate[i];
    const gap = (new Date(cur.date) - new Date(prev.date)) / DAY;
    const p = proteinKey(cur.mainProtein);
    if (gap <= 1 && !NO_PROTEIN.has(p) && p === proteinKey(prev.mainProtein)) {
      flag(cur.slot, `${cur.mainProtein} två dagar i rad`, `Välj ett annat huvudprotein än ${cur.mainProtein}.`);
    }
  }

  // Regel 2: varje öppnad förpackning i minst en måltid.
  const usedIds = new Set(meals.flatMap((m) => m.uses.map((u) => u.itemId)));
  const unusedOpened = candidates.filter((c) => c.opened && !usedIds.has(c.id));
  if (unusedOpened.length) {
    const target = pickSlot(meals, locked, (m) => m.missing.length);
    if (target != null) {
      flag(target, `öppnat som inte används: ${unusedOpened.map((c) => c.name).join(", ")}`,
        `Använd de öppnade förpackningarna: ${unusedOpened.map((c) => `${c.name} (${c.id})`).join(", ")}.`);
    }
  }

  // Regel 3: minst en måltid helt utan inköp – om användaren inte valt "gärna inköp".
  const freeShopping = order.every((o) => o.shopping === "fritt");
  if (meals.length && !freeShopping && meals.every((m) => m.missing.length)) {
    const target = pickSlot(meals, locked, (m) => -m.missing.length);
    if (target != null) flag(target, "alla måltider kräver inköp", "Den här rätten ska gå att laga helt med det som finns – missing ska vara tom.");
  }

  return { bySlot, hints };
}

// Den olåsta måltid som får högst värde enligt fn.
function pickSlot(meals, locked, fn) {
  const open = meals.filter((m) => !locked.includes(m.slot));
  if (!open.length) return null;
  return open.reduce((best, m) => (fn(m) > fn(best) ? m : best)).slot;
}
