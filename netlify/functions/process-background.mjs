// Bakgrundsfunktion (upp till 15 min): kör Claude-tolkningen av en uppladdning.
import { checkKey } from "../lib/http.mjs";
import { processJob } from "../lib/process.mjs";

export default async (req) => {
  if (checkKey(req)) return;
  const { id } = await req.json();
  await processJob(id);
};
