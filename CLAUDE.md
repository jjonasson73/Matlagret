# Matlagret

Personlig app för matlagerhållning och matplanering. Ett hushåll (3–4 personer), byggd för mobil.

## Problemet

Man vet inte vad man har hemma, och därför blir det både svinn och dubbelköp. Konceptet är validerat i en chattsession: ett ICA-kvitto (PDF från Kivra) plus foton på kyl, frys och skafferi räckte för att ta fram en användbar matplan för fem dagar och halvera inköpslistan.

Observerade träffsäkerheter i valideringen:

| Källa | Igenkänning | Kommentar |
|---|---|---|
| Kvitto (Kivra-PDF) | ~100 % | Riktig text, artikelnummer, mängder |
| Kyl | ~75 % | Rester och varor från andra butiker syns bara här |
| Skafferi, torrvaror | ~85 % | Märkesvaror i kartong |
| Skafferi, bakning | ~60 % | Öppnade påsar, staplat, mycket dolt |
| Frys, hemmafryst | ~0 % | Omärkta påsar går inte att känna igen |

## Grundprinciper

1. **Lagret är den enda sanningen.** Allt annat är händelser som ändrar lagret.
2. **Fotot stämmer av mot lagret, det bygger inte upp det.** Därför räcker det att fota när något börjar ta slut.
3. **Ingenting ändras utan bekräftelse.** All tolkning blir förslag som användaren godkänner med ett tryck.
4. **Mät rättningstiden, inte träffsäkerheten.** Tar bekräftelsen mer än 30 sekunder slutar appen användas.
5. **Det som inte syns kan inte kännas igen.** Hemmafrysta påsar registreras vid infrysning, inte i efterhand.

## Datamodell

### Lagerpost (`item`)

```
id
name              // "Nötfärs 20%"
category          // protein | grönsak | mejeri | torrvara | krydda | snacks | dryck | övrigt
zone              // kyl | frys | skafferi | kryddor | basvara
qty, unit         // 2, "kg"
confidence        // sure | likely | unsure | confirmed
source            // receipt | photo | manual | harvest
articleNo         // ICA-artikelnummer, om det finns
addedAt           // ISO-datum
bestBefore        // om läsbart
perishDays        // hållbarhet i dagar från addedAt, per kategori
status            // active | probably_out | out
```

Fälten för matplan och inköpslista (`styles`, `role`, `kind`, `opened`, `remaining`, `packageSize`) beskrivs i `SPEC-matplan.md`.

### Säkerhetsnivåer

- `sure` – tydligt läsbar etikett eller rad på kvittot
- `likely` – rimlig tolkning, men inte säker
- `unsure` – gissning eller hemmafryst utan etikett
- `confirmed` – användaren har bekräftat

Hemmafrysta varor är alltid `unsure` tills användaren bekräftar dem. En felaktig `likely` är värre än en `unsure`, eftersom användaren inte kontrollerar den.

### Basvaror

Mjöl, socker, salt, olja, redning och liknande anges en gång vid uppstart och åldras aldrig. De fotas inte rutinmässigt. Skafferiet omsätts långsamt, så där kan registreringen vara noggrann från början.

### Åldringsmodell

Ett nattligt jobb sätter `status = probably_out` när `addedAt + perishDays` har passerat. Riktvärden: bladgrönsaker 5 dagar, färsk frukt 7, mjölk 7, färskt kött 3, bröd i rumstemperatur 4. Fryst och skafferi åldras inte.

### Användarregler

Regler som gäller alltid och som läggs på vid tolkning av kvitton. Kända regler för den här användaren:

- Köttfärs, fisk och bröd fryses alltid direkt.

## Arkitektur

Statisk frontend plus Netlify Functions. **Ingen Supabase.**

```
/api/ingest       POST, multipart. Tar emot PDF, bild eller text.
                  Kräver header x-api-key.
                  Kallar Claude, sparar förslag i Blobs, returnerar 200 snabbt.
/api/inventory    GET lager, POST bekräfta/ändra/ta bort
/api/suggest      POST { meals: [{ date, type, style, maxMinutes, people, creativity }] }
                  → matplan + inköpslista (se SPEC-matplan.md)
/api/pending      GET förslag som väntar på bekräftelse
/api/shopping     GET inköpslistan, POST lägg till (kontrolleras mot lagret),
                  bocka av, ta bort
```

**Lagring:** Netlify Blobs. Hela lagret ryms i ett JSON-dokument (~150 rader). Håll lagringen bakom ett tunt gränssnitt (`store.get()` / `store.put()`) så att den går att byta ut.

**AI:** Anthropic Messages API, modell `claude-sonnet-4-6`. Anropas bara från funktioner, aldrig från webbläsaren. `ANTHROPIC_API_KEY` och `INGEST_KEY` läggs som miljövariabler i Netlify.

### Inkorgen

`/api/ingest` känner av typen själv:

- **PDF** → texttolkning av kvittot (ingen OCR behövs, Kivras PDF:er innehåller riktig text)
- **Bild** → bildigenkänning per zon
- **Text** → inklistrad kvittotext

Bilder krymps till cirka 1600 px innan de skickas till Claude.

### Kvittotolkning

Från PDF:en: butik, datum och rader med beskrivning, artikelnummer, mängd och summa.

- Sortera bort allt som inte är mat (papper, tvättmedel, hygien, pant, kassar).
- Tolka förkortningar ("Creme fraich lätt", "Norrloumi", "Majs förkokt vac").
- Lägg på användarreglerna för zon.
- Bygg en bestående koppling artikelnummer → vara, så att tolkningen blir bättre över tid.

### Fototolkning

Varje bild gäller en zon, som användaren väljer eller som Claude gissar.

- Syns i bilden och finns i lagret → bekräfta.
- Finns i lagret men syns inte → markera `probably_out`, ta inte bort.
- Syns men saknas i lagret → lägg till som `unsure` (varor från andra butiker, egen skörd, resor).
- Läs bäst före-datum när de går att läsa.

### Receptförslag

Indata: dagar, antal personer och inriktning. Prioritering:

1. Rester och varor som snart blir dåliga
2. Protein som redan finns i frysen
3. Preferenser
4. Så få inköp som möjligt

Utdata: en rätt per dag, påminnelser om vad som ska tas fram ur frysen dagen före, och en inköpslista som kontrollerats mot lagret. Inköpslistan ska gå att kopiera i ett format som passar ICA-appens inköpslista.

### Överlagervarning

Valideringen hittade överlager i fyra av sex bilder: 5 sorters pasta, 3 paket pärlsocker, 5 paket sojabönor och 8–9 bröd. En varning av typen "du har redan X" när något läggs på inköpslistan är en av appens mest värdefulla funktioner.

## iOS-genväg

Genvägen "Matlagret" finns redan och är byggd så här:

- Tar emot Bilder och PDF-filer från delningsbladet
- Upprepa med varje objekt i Genvägsinmatning
- Hämta innehållet från URL: POST till `/api/ingest`, header `x-api-key`, begäran som **Formulär** med fältet `file` (typ Fil) = Upprepa objekt

Funktionen måste alltså ta emot `multipart/form-data` med fältnamnet `file`, och avvisa anrop utan giltig `x-api-key`.

## Frontend

Ett enkelt PWA-gränssnitt med fyra vyer:

1. **Lager** – grupperat per zon, med färgkodad säkerhet och snabbknappar för slut och bekräfta
2. **Att bekräfta** – kön av förslag från inkorgen, ett tryck per rad, snabbval vid tveksamheter ("Crème fraiche eller gräddfil?")
3. **Matplan** – dagar och personer in, förslag ut, knapp för "lagat" som drar av från lagret
4. **Inköpslista** – kontrollerad mot lagret, med kopieringsknapp

Bilder tas direkt i appen med kameraknapp, som alternativ till genvägen.

## Byggordning

**Steg 1 (kvällens mål):** `/api/ingest` för PDF + kvittotolkning + lager i Blobs + en enkel lagervy. Då kan kvällens kvitto läsas in direkt.

**Steg 2:** Vy för bekräftelse, manuella justeringar, frysregistrering.

**Steg 3:** Bildtolkning per zon och avstämning mot lagret.

**Steg 4:** Receptförslag och inköpslista. Detaljerad spec och byggordning i `SPEC-matplan.md`.

**Steg 5:** Åldringsjobb och överlagervarning.

## Testdata

`testdata/` innehåller ett riktigt ICA-kvitto från Maxi ICA Stormarknad Gävle (2026-08-27, 58 rader, 2 970,74 kr). Tolkningen ska klara:

- Rabattrader som hör till raden ovanför ("Såser 2f53kr", "Delikatesspo 2f25kr")
- Mängd i både kg och styck
- Pantrad
- Varor som inte är mat (8 rader i det här kvittot)
