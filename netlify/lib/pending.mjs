// Förslagskön: allt som tolkats men inte bekräftats.
import { store, KEYS } from "./store.mjs";
import { addOrMerge, findItem } from "./inventory.mjs";
import { articleFields } from "./rules.mjs";

const KEEP_DONE_DAYS = 7;

export async function loadPending() {
  return (await store.get(KEYS.pending)) ?? [];
}

export async function savePending(list) {
  const cutoff = Date.now() - KEEP_DONE_DAYS * 864e5;
  const kept = list.filter((p) => p.status !== "done" || Date.parse(p.updatedAt ?? p.createdAt) > cutoff);
  await store.put(KEYS.pending, kept);
  return kept;
}

export async function updateProposal(id, fn) {
  const list = await loadPending();
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  fn(p);
  p.updatedAt = new Date().toISOString();
  await savePending(list);
  return p;
}

// Tillämpa en godkänd rad på lagret. `individual` = användaren har tittat på
// just den här raden, då räknas den som bekräftad.
export function applyLine(inv, articles, proposal, line, { individual }) {
  const confidence = individual ? "confirmed" : line.confidence;
  switch (line.action) {
    case "add": {
      const item = addOrMerge(inv, {
        ...line,
        confidence,
        source: proposal.source,
        addedAt: proposal.meta?.date ?? undefined,
      });
      // Lär bara in rader som användaren har tittat på, eller som redan var säkra.
      // Annars låser "Godkänn alla" fast felaktiga gissningar.
      if (line.articleNo && (individual || line.confidence === "sure")) {
        articles[line.articleNo] = articleFields(line);
      }
      return item;
    }
    case "confirm": {
      const item = findItem(inv, line.itemId);
      if (!item) return null;
      item.status = "active";
      if (line.bestBefore) item.bestBefore = line.bestBefore;
      if (individual) item.confidence = "confirmed";
      item.lastSeenAt = proposal.createdAt;
      return item;
    }
    case "probably_out": {
      const item = findItem(inv, line.itemId);
      if (item && item.status === "active") item.status = "probably_out";
      return item;
    }
    default:
      return null;
  }
}

export function isFinished(p) {
  return p.lines.every((l) => l.action === "skip" || l.decision);
}
