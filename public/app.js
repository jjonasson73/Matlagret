// Matlagret – enkel PWA utan ramverk.

const ZONES = [
  ["kyl", "Kyl"],
  ["frys", "Frys"],
  ["skafferi", "Skafferi"],
  ["kryddor", "Kryddor"],
  ["basvara", "Basvaror"],
];
const CONFIDENCE_LABEL = { sure: "säker", likely: "trolig", unsure: "osäker", confirmed: "bekräftad" };
const FRACTION = { 1: "full", 0.75: "¾", 0.5: "½", 0.25: "¼" };
const ACTION_LABEL = { add: "Lägg till", confirm: "Finns kvar", probably_out: "Troligen slut", skip: "Ej mat" };

const $ = (sel) => document.querySelector(sel);

// Liten hjälpare för att bygga DOM utan innerHTML (namn kommer från kvitton).
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// ---- API ----

const getKey = () => {
  try {
    return localStorage.getItem("matlagret.key") ?? "";
  } catch {
    return "";
  }
};

async function api(path, { method = "GET", body, form } = {}) {
  const headers = { "x-api-key": getKey() };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: form ?? (body && JSON.stringify(body)) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    openSettings();
    throw new Error("Ange API-nyckeln först");
  }
  if (!res.ok) throw new Error(data.error ?? `Fel ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(e.message);
  }
};

// ---- State ----

const state = { inventory: { items: [] }, pending: [], view: "lager" };

async function refresh() {
  const [inv, pen] = await Promise.all([api("/api/inventory"), api("/api/pending")]);
  state.inventory = inv;
  state.pending = pen.pending;
  render();
}

// ---- Lager ----

function renderInventory() {
  const showOut = $("#show-out").checked;
  const root = $("#inventory");
  root.replaceChildren();
  const items = state.inventory.items.filter((i) => showOut || i.status !== "out");
  if (!items.length) {
    root.append(h("p", { class: "empty" }, "Lagret är tomt. Läs in ett kvitto under Att bekräfta."));
    return;
  }
  for (const [zone, label] of ZONES) {
    const inZone = items
      .filter((i) => i.zone === zone)
      .sort((a, b) => a.category.localeCompare(b.category, "sv") || a.name.localeCompare(b.name, "sv"));
    if (!inZone.length) continue;
    root.append(
      h("h2", { class: "zone" }, label, h("span", { class: "count" }, String(inZone.length))),
      h("ul", { class: "items" }, inZone.map(itemRow)),
    );
  }
}

function itemRow(item) {
  const confirm = run(async () => {
    state.inventory = await api("/api/inventory", { method: "POST", body: { action: "confirm", id: item.id } }).then((r) => r.inventory);
    render();
  });
  const out = run(async () => {
    state.inventory = await api("/api/inventory", { method: "POST", body: { action: "out", id: item.id } }).then((r) => r.inventory);
    render();
    toast(`${item.name} markerad som slut`);
  });
  return h(
    "li",
    { class: `item conf-${item.confidence} status-${item.status}` },
    h("span", { class: "dot", title: CONFIDENCE_LABEL[item.confidence] }),
    h(
      "button",
      { class: "name", onclick: () => openItemDialog(item) },
      item.name,
      h("small", {},
        `${fmtQty(item.qty)} ${item.unit}`,
        item.opened ? ` · öppnad, ${FRACTION[item.remaining] ?? ""} kvar` : "",
        item.source === "leftover" ? " · rester" : "",
        item.status === "probably_out" ? " · troligen slut" : "",
        item.bestBefore ? ` · bf ${item.bestBefore}` : "",
      ),
    ),
    item.status === "out"
      ? null
      : [
          h("button", { class: "quick open", onclick: () => openOpenedDialog(item), "aria-label": "Öppnad", title: "Öppnad förpackning" }, item.opened ? FRACTION[item.remaining] : "◐"),
          item.confidence !== "confirmed" || item.status === "probably_out"
            ? h("button", { class: "quick ok", onclick: confirm, "aria-label": "Bekräfta" }, "✓")
            : null,
          h("button", { class: "quick out", onclick: out, "aria-label": "Slut" }, "Slut"),
        ],
  );
}

const fmtQty = (q) => (Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/\.?0+$/, "").replace(".", ","));

const ITEM_FIELDS = ["name", "qty", "unit", "zone", "category", "bestBefore", "kind", "role"];

// Samma dialog används för lagerposter och för rader som väntar på bekräftelse.
function openDialog({ title, values, canDelete, canLeftover = false, onSave }) {
  const dlg = $("#dlg-item");
  const form = $("#form-item");
  form.reset();
  $("#dlg-item-title").textContent = title;
  $("#dlg-delete").hidden = !canDelete;
  $("#leftover-row").hidden = !canLeftover;
  for (const k of ITEM_FIELDS) form.elements[k].value = values[k] ?? "";
  for (const box of form.querySelectorAll('[name="styles"]')) box.checked = (values.styles ?? []).includes(box.value);
  dlg.onclose = run(async () => {
    if (dlg.returnValue === "cancel" || !dlg.returnValue) return;
    const data = new FormData(form);
    const fields = Object.fromEntries(data);
    fields.styles = data.getAll("styles");
    fields.qty = Number(fields.qty);
    if (!fields.bestBefore) fields.bestBefore = null;
    if (fields.leftover) fields.source = "leftover";
    delete fields.leftover;
    await onSave(dlg.returnValue, fields);
  });
  dlg.showModal();
}

function openOpenedDialog(item) {
  const dlg = $("#dlg-open");
  $("#dlg-open-title").textContent = `Hur mycket ${item.name} är kvar?`;
  dlg.onclose = run(async () => {
    const v = dlg.returnValue;
    if (!v || v === "cancel") return;
    const remaining = v === "none" ? null : Number(v);
    state.inventory = (await api("/api/inventory", { method: "POST", body: { action: "open", id: item.id, remaining } })).inventory;
    render();
  });
  dlg.returnValue = "";
  dlg.showModal();
}

function openLineDialog(p, l) {
  openDialog({
    title: "Ändra och godkänn",
    values: l,
    canDelete: false,
    onSave: (_, fields) => decide({ id: p.id, lineId: l.lineId, decision: "accept", edits: fields }),
  });
}

function openItemDialog(item) {
  openDialog({
    title: item ? "Ändra" : "Lägg till",
    values: item ?? { zone: "frys", category: "övrigt", qty: 1, unit: "st" },
    canDelete: !!item,
    canLeftover: !item,
    onSave: (action, fields) => saveItem(item, action, fields),
  });
}

async function saveItem(item, action, fields) {
  let body;
  if (action === "delete") body = { action: "delete", id: item.id };
  else if (item) body = { action: "update", id: item.id, fields };
  else body = { action: "add", item: fields };
  state.inventory = (await api("/api/inventory", { method: "POST", body })).inventory;
  render();
}

// ---- Att bekräfta ----

function renderPending() {
  const root = $("#pending");
  root.replaceChildren();
  if (!state.pending.length) {
    root.append(h("p", { class: "empty" }, "Inget att bekräfta. Dela ett kvitto från Kivra via genvägen, eller fota här ovanför."));
    return;
  }
  for (const p of [...state.pending].reverse()) root.append(proposalCard(p));
}

function proposalCard(p) {
  const title =
    p.source === "photo"
      ? `${p.meta?.photos > 1 ? `Skanning (${p.meta.photos} foton)` : "Foto"} · ${p.meta?.zone ?? ""}${p.meta?.scope === "full" ? " · hela zonen" : ""}`
      : p.meta?.store
        ? `${p.meta.store}${p.meta.date ? " · " + p.meta.date : ""}`
        : p.filename;
  const card = h("article", { class: "proposal" }, h("header", {}, h("h3", {}, title), p.meta?.total ? h("span", {}, `${p.meta.total} kr`) : null));

  if (p.status === "queued" || p.status === "processing") {
    // En tolkning tar normalt under två minuter; bakgrundsjobb avbryts efter 15.
    const since = Date.parse(p.startedAt ?? p.createdAt);
    const stuck = Date.now() - since > (p.status === "queued" ? 2 : 16) * 60e3;
    card.append(
      h("p", { class: "muted" }, h("span", { class: "spinner" }), p.status === "queued" ? " I kö…" : " Tolkar…"),
    );
    if (stuck) {
      card.append(
        h("p", { class: "error" }, "Det här verkar ha fastnat."),
        h("menu", {},
          h("button", { onclick: run(() => decide({ id: p.id, dismiss: true })) }, "Släng"),
          h("button", { class: "primary", onclick: run(() => decide({ id: p.id, retry: true })) }, "Försök igen"),
        ),
      );
    }
    return card;
  }
  if (p.status === "error") {
    card.append(
      h("p", { class: "error" }, p.error ?? "Något gick fel"),
      h("menu", {},
        h("button", { onclick: run(() => decide({ id: p.id, dismiss: true })) }, "Släng"),
        h("button", { class: "primary", onclick: run(() => decide({ id: p.id, retry: true })) }, "Försök igen"),
      ),
    );
    return card;
  }

  const open = p.lines.filter((l) => !l.decision && l.action !== "skip");
  const skipped = p.lines.filter((l) => l.action === "skip" && !l.decision);
  const done = p.lines.filter((l) => l.decision);

  card.append(h("ul", { class: "lines" }, open.map((l) => lineRow(p, l))));
  if (skipped.length) {
    card.append(
      h("details", {}, h("summary", {}, `${skipped.length} rader som inte är mat`), h("ul", { class: "lines" }, skipped.map((l) => lineRow(p, l)))),
    );
  }
  if (done.length) card.append(h("p", { class: "muted" }, `${done.length} rader klara`));
  const outs = open.filter((l) => l.action === "probably_out").length;
  card.append(
    h("menu", {},
      h("button", { onclick: run(() => decide({ id: p.id, dismiss: true })) }, "Släng allt"),
      outs ? h("button", { onclick: run(() => decide({ id: p.id, rejectAction: "probably_out" })) }, `Inget är slut (${outs})`) : null,
      open.length ? h("button", { class: "primary", onclick: run(() => decide({ id: p.id, acceptAll: true })) }, `Godkänn alla ${open.length}`) : null,
    ),
  );
  return card;
}

function lineRow(p, l) {
  const accept = (edits) =>
    run(() => decide({ id: p.id, lineId: l.lineId, decision: "accept", edits: { ...(l.zoneChanged && { zone: l.zone }), ...edits } }));
  const cycleZone = () => {
    l.zone = nextZone[l.zone];
    l.zoneChanged = true;
    renderPending();
  };
  const reject = run(() => decide({ id: p.id, lineId: l.lineId, decision: "reject" }));
  const nextZone = { kyl: "frys", frys: "skafferi", skafferi: "kryddor", kryddor: "basvara", basvara: "kyl" };
  return h(
    "li",
    { class: `line conf-${l.confidence} action-${l.action}` },
    h("span", { class: "dot", title: CONFIDENCE_LABEL[l.confidence] }),
    h(
      "div",
      { class: "what" },
      h("button", { class: "line-name", onclick: () => openLineDialog(p, l), title: "Ändra" }, h("strong", {}, l.name), " ✎"),
      h("small", {},
        `${fmtQty(l.qty)} ${l.unit} · `,
        l.action === "add"
          ? h("button", { class: "zone-chip", title: "Byt zon", onclick: cycleZone }, `${l.zone} ↻`)
          : ACTION_LABEL[l.action],
        l.raw && l.raw !== l.name ? ` · ”${l.raw}”` : "",
        l.ruleApplied ? ` · ${l.ruleApplied}` : "",
      ),
      l.alternatives?.length
        ? h("div", { class: "alts" }, "Eller: ", l.alternatives.map((a) => h("button", { class: "chip", onclick: accept({ name: a }) }, a)))
        : null,
    ),
    h("button", { class: "quick no", onclick: reject, "aria-label": "Avvisa" }, "✕"),
    h("button", { class: "quick ok", onclick: accept(), "aria-label": "Godkänn" }, "✓"),
  );
}

async function decide(body) {
  const res = await api("/api/pending", { method: "POST", body });
  if (res.inventory) state.inventory = res.inventory;
  const pen = await api("/api/pending");
  state.pending = pen.pending;
  render();
}

// ---- Inkorg från appen ----

async function send(form) {
  toast("Skickar…");
  await api("/api/ingest", { method: "POST", form });
  toast("Mottaget – tolkar");
  await refresh();
}

$("#in-photo").addEventListener("change", run(async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", await shrink(file), "foto.jpg");
  const zone = $("#photo-zone").value;
  if (zone) form.append("zone", zone);
  e.target.value = "";
  await send(form);
}));

// ---- Skanna hela zonen: flera foton, ett förslag ----

const MAX_SCAN = 8;
const scan = { photos: [], zone: null };

function renderScan() {
  $("#scan").hidden = !scan.zone;
  $("#scan-title").textContent = `Skanna hela ${scan.zone ?? ""}`;
  $("#scan-thumbs").replaceChildren(...scan.photos.map((b) => h("img", { src: URL.createObjectURL(b), alt: "" })));
  $("#scan-done").disabled = !scan.photos.length;
  $("#scan-done").textContent = `Klar – skicka ${scan.photos.length} foton`;
}

function resetScan() {
  scan.photos = [];
  scan.zone = null;
  renderScan();
}

$("#btn-scan").addEventListener("click", () => {
  const zone = $("#photo-zone").value;
  if (!zone) return toast("Välj zon först: kyl, frys eller skafferi");
  scan.zone = zone;
  scan.photos = [];
  renderScan();
});

$("#scan-photo").addEventListener("change", run(async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (scan.photos.length >= MAX_SCAN) return toast(`Högst ${MAX_SCAN} foton`);
  scan.photos.push(await shrink(file));
  renderScan();
}));

$("#scan-cancel").addEventListener("click", resetScan);

$("#scan-done").addEventListener("click", run(async () => {
  const form = new FormData();
  scan.photos.forEach((b, i) => form.append("file", b, `skanning${i + 1}.jpg`));
  form.append("zone", scan.zone);
  form.append("scope", "full");
  resetScan();
  await send(form);
}));

$("#in-file").addEventListener("change", run(async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file.type.startsWith("image/") ? await shrink(file) : file, file.name);
  e.target.value = "";
  await send(form);
}));

$("#btn-paste").addEventListener("click", () => {
  const dlg = $("#dlg-paste");
  dlg.querySelector("textarea").value = "";
  dlg.onclose = run(async () => {
    const text = dlg.querySelector("textarea").value.trim();
    if (dlg.returnValue !== "send" || !text) return;
    const form = new FormData();
    form.append("text", text);
    await send(form);
  });
  dlg.showModal();
});

// Krymp bilder i webbläsaren innan uppladdning (servern krymper också).
async function shrink(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

// ---- Navigering & inställningar ----

function render() {
  renderInventory();
  renderPending();
  const n = state.pending.filter((p) => p.status === "ready").length;
  $("#badge").hidden = !n;
  $("#badge").textContent = String(n);
  // Fråga igen om något fortfarande tolkas.
  clearTimeout(render.poll);
  if (state.pending.some((p) => p.status === "queued" || p.status === "processing")) {
    render.poll = setTimeout(run(refresh), 4000);
  }
}

function show(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
$("#show-out").addEventListener("change", renderInventory);
$("#btn-add").addEventListener("click", () => openItemDialog(null));
$("#btn-settings").addEventListener("click", () => openSettings());
$('#form-item [name="leftover"]').addEventListener("change", (e) => {
  if (e.target.checked) $('#form-item [name="zone"]').value = "kyl";
});
$("#btn-tag").addEventListener("click", run(async () => {
  const res = await api("/api/inventory", { method: "POST", body: { action: "tagAll" } });
  toast(res.untagged ? `Taggar ${res.untagged} varor – klart om en minut` : "Alla varor är redan taggade");
}));

function openSettings() {
  const dlg = $("#dlg-settings");
  if (dlg.open) return;
  dlg.querySelector("input").value = getKey();
  dlg.onclose = () => {
    if (dlg.returnValue !== "save") return;
    try {
      localStorage.setItem("matlagret.key", dlg.querySelector("input").value.trim());
    } catch {}
    run(refresh)();
  };
  dlg.showModal();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && getKey() && run(refresh)());

if (getKey()) run(refresh)();
else openSettings();
