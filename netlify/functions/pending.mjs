// GET  /api/pending – förslag som väntar på bekräftelse.
// POST /api/pending – besluta om förslag:
//   { id, lineId, decision: "accept" | "reject", edits?: { name, zone, qty, ... } }
//   { id, acceptAll: true }   godkänn alla obeslutade rader
//   { id, rejectAction: "probably_out" }   avvisa alla obeslutade rader av en typ
//   { id, dismiss: true }     släng hela förslaget
//   { id, retry: true }       tolka om (efter fel)
import { store, KEYS } from "../lib/store.mjs";
import { json, error, checkKey } from "../lib/http.mjs";
import { loadInventory, saveInventory } from "../lib/inventory.mjs";
import { loadPending, savePending, applyLine, isFinished } from "../lib/pending.mjs";
import { applyZoneRules } from "../lib/rules.mjs";
import { startBackground } from "../lib/process.mjs";
import { emptyList, strikeBought } from "../lib/shopping.mjs";

const LINE_EDITS = ["name", "category", "zone", "qty", "unit", "bestBefore", "styles", "role", "kind"];

export default async (req) => {
  const denied = checkKey(req);
  if (denied) return denied;

  if (req.method === "GET") {
    const list = await loadPending();
    return json({ pending: list.filter((p) => p.status !== "done") });
  }
  if (req.method !== "POST") return error("Använd GET eller POST", 405);

  const body = await req.json().catch(() => null);
  if (!body?.id) return error("id saknas");

  const list = await loadPending();
  const p = list.find((x) => x.id === body.id);
  if (!p) return error("Förslaget finns inte", 404);

  if (body.dismiss) {
    p.status = "done";
    p.dismissed = true;
    p.updatedAt = new Date().toISOString();
    await savePending(list);
    return json({ ok: true });
  }

  if (body.retry) {
    p.status = "queued";
    p.error = null;
    p.createdAt = new Date().toISOString();
    delete p.startedAt;
    await savePending(list);
    await startBackground(req, p.id);
    return json({ ok: true, proposal: p });
  }

  if (p.status !== "ready") return error(`Förslaget är inte klart (${p.status})`, 409);

  const inv = await loadInventory();
  const articles = (await store.get(KEYS.articles)) ?? {};

  const applied = [];
  if (body.rejectAction) {
    for (const line of p.lines) {
      if (line.action === body.rejectAction && !line.decision) line.decision = "rejected";
    }
  } else if (body.acceptAll) {
    for (const line of p.lines) {
      if (line.action === "skip" || line.decision) continue;
      applyLine(inv, articles, p, line, { individual: false });
      line.decision = "accepted";
      applied.push(line);
    }
  } else {
    const line = p.lines.find((l) => l.lineId === String(body.lineId));
    if (!line) return error("Raden finns inte", 404);
    if (line.decision) return error("Raden är redan besluten", 409);
    if (body.decision === "accept") {
      if (body.edits) {
        for (const k of LINE_EDITS) if (k in body.edits) line[k] = body.edits[k];
        if (!("zone" in body.edits)) Object.assign(line, applyZoneRules(line));
      }
      // En överhoppad icke-mat-rad kan räddas genom att godkännas.
      if (line.action === "skip") line.action = "add";
      applyLine(inv, articles, p, line, { individual: true });
      line.decision = "accepted";
      applied.push(line);
    } else if (body.decision === "reject") {
      line.decision = "rejected";
    } else {
      return error("decision måste vara accept eller reject");
    }
  }

  if (isFinished(p)) p.status = "done";
  p.updatedAt = new Date().toISOString();
  await saveInventory(inv);
  await store.put(KEYS.articles, articles);
  await savePending(list);

  // Det som finns på kvittot är köpt: bocka av det på inköpslistan.
  if (p.source === "receipt" && applied.length) {
    const shopping = (await store.get(KEYS.shopping)) ?? emptyList();
    if (strikeBought(shopping, applied.filter((l) => l.action === "add")).length) {
      shopping.updatedAt = new Date().toISOString();
      await store.put(KEYS.shopping, shopping);
    }
  }
  return json({ ok: true, proposal: p, inventory: inv });
};

export const config = { path: "/api/pending" };
