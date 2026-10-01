// Tunt lagringsgränssnitt: store.get(key) / store.put(key, value).
// Netlify Blobs i drift. Sätt MATLAGRET_LOCAL_STORE=<katalog> för att köra mot
// JSON-filer lokalt (tester, experiment) – då byts bara den här filen ut.
import { getStore } from "@netlify/blobs";
import { promises as fs } from "node:fs";
import path from "node:path";

const localDir = process.env.MATLAGRET_LOCAL_STORE;

function blobStore(name) {
  const s = getStore({ name, consistency: "strong" });
  return {
    get: (key) => s.get(key, { type: "json" }),
    put: (key, value) => s.setJSON(key, value),
    del: (key) => s.delete(key),
    getBinary: async (key) => {
      const res = await s.getWithMetadata(key, { type: "arrayBuffer" });
      return res ? { data: Buffer.from(res.data), metadata: res.metadata } : null;
    },
    putBinary: (key, data, metadata) => s.set(key, data, { metadata }),
  };
}

function fileStore(name) {
  const dir = path.join(localDir, name);
  const file = (key) => path.join(dir, encodeURIComponent(key));
  const read = async (p) => {
    try {
      return await fs.readFile(p);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  };
  return {
    get: async (key) => {
      const buf = await read(file(key) + ".json");
      return buf ? JSON.parse(buf.toString("utf8")) : null;
    },
    put: async (key, value) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key) + ".json", JSON.stringify(value, null, 2));
    },
    del: (key) => fs.rm(file(key) + ".json", { force: true }),
    getBinary: async (key) => {
      const data = await read(file(key) + ".bin");
      if (!data) return null;
      const meta = await read(file(key) + ".meta.json");
      return { data, metadata: meta ? JSON.parse(meta.toString("utf8")) : {} };
    },
    putBinary: async (key, data, metadata = {}) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key) + ".bin", Buffer.from(data));
      await fs.writeFile(file(key) + ".meta.json", JSON.stringify(metadata));
    },
  };
}

const open = (name) => (localDir ? fileStore(name) : blobStore(name));

// "data": lagret, förslagskön, artikelkopplingar, basvaror.
// "uploads": råa filer från inkorgen (PDF, bilder, text).
export const store = open("matlagret");
export const uploads = open("uploads");

export const KEYS = {
  inventory: "inventory",
  pending: "pending",
  articles: "articles",
  shopping: "shopping",
};
