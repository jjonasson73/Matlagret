# Matlagret

Matlagerhållning och matplanering för ett hushåll. Se `CLAUDE.md` för bakgrund och designprinciper.

## Struktur

```
public/                      PWA (Lager, Att bekräfta, Matplan, Inköp)
netlify/functions/
  ingest.mjs                 POST /api/ingest     – inkorgen (PDF, bild, text)
  process-background.mjs     bakgrundsjobb som kör Claude-tolkningen
  pending.mjs                GET/POST /api/pending – förslag att bekräfta
  inventory.mjs              GET/POST /api/inventory
  suggest.mjs                POST /api/suggest    – steg 4, svarar 501 än så länge
  aging.mjs                  schemalagd nattlig åldring (03:00 UTC)
netlify/lib/
  store.mjs                  store.get()/put() – Netlify Blobs (eller lokala filer)
  claude.mjs                 prompter + strukturerade svar från Claude
  process.mjs                uppladdning → förslag
  inventory.mjs, pending.mjs lagrets och förslagskön logik
  rules.mjs                  kategorier, zoner, hållbarhet, användarregler
test/                        node --test, kör mot lokal fillagring utan Claude
```

## Flöde

1. Genvägen eller appen skickar en fil till `/api/ingest` (multipart, fält `file`, header `x-api-key`).
2. Filen sparas i Blobs, ett förslag med status `queued` läggs i kön och svaret kommer direkt.
3. `process-background` tolkar filen med Claude (`claude-sonnet-4-6`) och sätter förslaget till `ready`.
4. Under **Att bekräfta** godkänns raderna med ett tryck (eller alla på en gång). Först då ändras lagret.

Ett enskilt godkännande ger `confidence = confirmed`. "Godkänn alla" behåller Claudes säkerhetsnivå,
så att de gula och röda raderna syns i lagervyn tills någon har tittat på dem.

## Sätta upp Netlify

1. Skapa en site på Netlify från det här repot (Add new site → Import from Git). Byggkommandot kan lämnas tomt;
   `netlify.toml` anger `public/` och funktionskatalogen.
2. Lägg till miljövariabler under Site configuration → Environment variables:
   - `ANTHROPIC_API_KEY` – nyckel från console.anthropic.com
   - `INGEST_KEY` – en lång slumpsträng, t.ex. `openssl rand -hex 24`
3. Deploya. Netlify Blobs behöver ingen egen konfiguration.
4. Öppna siten i Safari → Dela → Lägg till på hemskärmen. Ange `INGEST_KEY` under ⚙︎ första gången.
5. I iOS-genvägen: sätt URL till `https://<din-site>.netlify.app/api/ingest` och `x-api-key` till samma `INGEST_KEY`.

Bakgrundsfunktionen (`process-background`) behövs eftersom en tolkning kan ta längre tid än
den vanliga funktionsgränsen. Kontrollera att din Netlify-plan har stöd för Background Functions.

## Lokalt

```sh
npm install
npm test                 # enhetstester, inga API-anrop
npx netlify dev          # hela appen lokalt, kräver .env med nycklarna ovan
```

`POST /api/ingest?sync=1` tolkar direkt i samma anrop i stället för i bakgrunden, vilket är
praktiskt vid lokal testning:

```sh
curl -H "x-api-key: $INGEST_KEY" -F file=@testdata/kvitto.pdf "http://localhost:8888/api/ingest?sync=1"
```

## Status

- [x] Steg 1: inkorg för PDF/text, kvittotolkning, lager i Blobs, lagervy
- [x] Steg 2: bekräftelsevy, manuella ändringar, frysregistrering (+ Lägg till, zon Frys)
- [x] Steg 3: fototolkning per zon, "Skanna hela" med flera foton
- [~] Steg 4 (se `SPEC-matplan.md`):
  - [x] 0. Stiltaggar, roll, varutyp, öppnad förpackning, rester
  - [x] 1. Inköpslista med kontroll mot lagret, överlagervarning, förpackningar, avdelningar, kopiering, avbockning via kvitto
  - [ ] 2–5. Kandidatlista, generering, lås/regenerera/lagad, kreativt läge
  - [ ] 6–7. Receptinläsning och sparade recept
- [x] Steg 5: nattligt åldringsjobb och överlagervarning
