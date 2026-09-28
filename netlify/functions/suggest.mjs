// POST /api/suggest { days, people, focus } → receptförslag + inköpslista.
// Steg 4 i byggordningen – inte implementerat ännu.
import { error, checkKey } from "../lib/http.mjs";

export default async (req) => {
  const denied = checkKey(req);
  if (denied) return denied;
  return error("Receptförslag kommer i steg 4", 501);
};

export const config = { path: "/api/suggest" };
