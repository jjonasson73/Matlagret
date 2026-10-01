import { timingSafeEqual } from "node:crypto";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const error = (message, status = 400) => json({ error: message }, status);

// Alla /api-anrop kräver x-api-key = INGEST_KEY (genvägen och webbappen).
export function checkKey(req) {
  const expected = process.env.INGEST_KEY;
  if (!expected) return error("INGEST_KEY saknas i miljön", 500);
  const given = req.headers.get("x-api-key") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return error("Ogiltig API-nyckel", 401);
  return null;
}

// Fångar oväntade fel så att appen får ett begripligt meddelande (500 med text)
// i stället för Netlifys tomma 502, och så att felet hamnar i funktionsloggen.
export const safe = (name, fn) => async (req, context) => {
  const started = Date.now();
  try {
    return await fn(req, context);
  } catch (e) {
    console.error(`${name}: ${req.method} misslyckades efter ${Date.now() - started} ms`, e);
    return error(`Serverfel i ${name}: ${e.message}`, 500);
  }
};

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const today = () => new Date().toISOString().slice(0, 10);
