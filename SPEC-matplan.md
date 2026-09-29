# Spec: Matplan, inköpslista och externa recept

Bygger vidare på `CLAUDE.md`. Förutsätter att lager, inkorg och bekräftelsevy är på plats (steg 1–3).

Omfattar fyra delar:

- **0.** Utökad lagerpost – det som kandidatlistan, överlagervarningen och avdraget behöver
- **A.** Beställningsmodellen och matplansgenereringen
- **B.** Inköpslistan
- **C.** Receptbanken och inläsning av externa recept

---

## 0. Utökad lagerpost

Nya fält på `item`:

```
styles            // ["asiatiskt", "italienskt", ...] – stiltaggar, kan vara flera
role              // protein | kolhydrat | grönsak | mejeri | smaksättning | dessert | övrigt
kind              // generisk varutyp: "pasta", "bröd", "socker", "sojabönor"
opened            // true om förpackningen är öppnad
remaining         // hur mycket som är kvar av den öppnade förpackningen: 1 | 0.75 | 0.5 | 0.25
packageSize       // { qty: 500, unit: "g" } – en förpacknings innehåll, om känt
```

Nytt värde för `source`: `leftover` (rester från en lagad rätt).

### Hur fälten sätts

- **`styles`, `role`, `kind`** sätts av Claude i samma anrop som kvitto- och fototolkningen, alltså utan extra kostnad. Befintliga varor taggas en gång i efterhand med ett samlat anrop. Alla tre kan rättas i redigeringsdialogen.
- **`packageSize`** sparas i kopplingen artikelnummer → vara när kvittot anger det. Annars används en tabell med vanliga storlekar (crème fraiche 2 dl, nötfärs 500 g, pasta 500 g …).
- **`opened` och `remaining`** sätts från lagervyn: knappen **Öppnad** på en rad ger snabbval **Full · ¾ · ½ · ¼**. Raden visar då t.ex. "½ kvar". Gäller den öppnade förpackningen – 3 st med en öppnad till hälften är 2 hela och en halv. Sätts också automatiskt vid "Markera som lagad" (se A).
- **Rester** läggs in vid "Markera som lagad" om användaren svarar att det blev över: zon kyl, `source: leftover`, `perishDays: 3`.

`perishBy` räknas ut som `addedAt + perishDays` och lagras inte.

---

## A. Beställningen

Användaren beställer måltider, inte dagar – men varje måltid får en dag. Lagar man tre av fem kvällar ska planen vara för tre måltider.

### Indata

```
meals: [
  { date, type, style, maxMinutes, people }
]
```

- `date` – ISO-datum då måltiden ska lagas. Förvalt nästa lediga kväll, kan ändras.
- `type` – middag | lunch | matlåda | dessert | fredagsmys
- `style` – vardagsmat | asiatiskt | italienskt | husman | mexikanskt | fritt
- `maxMinutes` – 20 | 30 | 45 | fritt
- `people` – antal, förvalt 4

Varje måltid beställs separat. Det ska gå att blanda: två middagar på 30 minuter, en matlåda och en dessert.

### Stilen styr urvalet, inte bara prompten

Kandidatlistan viktas efter vald stil **innan** anropet till Claude, med hjälp av `styles` på lagerposterna.

Exempel från det befintliga lagret:

- **asiatiskt** – sojabönor, sushiris, ramen, Buldak, tahini, panko, sojasås, broccoli
- **italienskt** – spirali, spaghetti, risoni, Collezione, pesto, hushållsost, oliver, salami
- **mexikanskt** – tacosås, kidneybönor, majs, tortillas, tacokrydda, avokado, riven ost
- **husman** – potatis, morot, rödlök, lax, prinskorv, dill, ströbröd
- **dessert** – pärlsocker, florsocker, mjöl, kakao, bourbonvanilj, frysta bär, fruktmix, glass

### Generering i två steg

**Steg 1, i kod: bygg kandidatlistan.**

```
score = brådska + stilmatchning + öppnad förpackning
```

- **brådska** – rester och `probably_out` högst, sedan färskvaror nära `perishBy`, sedan fryst, sedan skafferi
- **stilmatchning** – träff på vald stil ger stort påslag
- **öppnad förpackning** – påslag, större ju mindre som är kvar

Plocka topp-kandidater per `role`. Skicka **30–40 varor**, inte hela lagret. Basvaror skickas som en kort lista utan poäng, eftersom de alltid finns. Skicka också de 10 senaste lagade rätterna, för variation.

Kandidatlistan ska gå att logga och testa utan att anropa Claude.

**Steg 2: anropa Claude.**

Modell `claude-sonnet-4-6`. Alla måltider i samma anrop. Anropet körs i en bakgrundsfunktion, precis som kvittotolkningen, eftersom en hel plan tar 30–60 sekunder. Appen visar "Planerar…" och hämtar resultatet när det är klart.

```json
{
  "meals": [
    {
      "date": "2026-10-02",
      "title": "...",
      "type": "middag",
      "style": "asiatiskt",
      "minutes": 25,
      "people": 4,
      "mainProtein": "kyckling",
      "uses": [{ "itemId": "...", "name": "...", "qty": 500, "unit": "g" }],
      "missing": [{ "name": "...", "qty": 1, "unit": "st" }],
      "substitutions": [{ "instead": "...", "use": "...", "note": "..." }],
      "thawAhead": [{ "name": "...", "hoursBefore": 12 }],
      "steps": ["..."]
    }
  ]
}
```

`uses` måste peka på riktiga `itemId` från kandidatlistan. `mainProtein` behövs för regel 1.

### Regler som kodas, inte promptas

Kontrollera resultatet och generera om den enskilda måltid som bryter mot en regel. **Högst två omförsök per måltid** – därefter visas rätten med en varning, så att kostnad och väntetid inte skenar.

1. Samma `mainProtein` får inte förekomma två dagar i rad.
2. Varje öppnad förpackning ska användas i minst en måltid.
3. Minst en måltid ska ha tom `missing`, alltså bara använda det som finns.
4. Ingen rätt med samma `mainProtein` **och** stil som lagats de senaste 14 dagarna får föreslås igen. (Titlar varierar för mycket för att jämföras.)
5. `minutes` får inte överstiga `maxMinutes`.

### Interaktion

- **Regenerera en måltid.** Byt ut en enskild rätt utan att göra om resten. Ett tryck, sedan en kort väntan (även den i bakgrunden).
- **Lås en måltid.** Låsta rätter ligger kvar och skickas med som kontext när övriga genereras om.
- **Markera som lagad.** Visar `uses` som en lista där varje rad har ett förval – **slut**, **öppnad ¾ / ½ / ¼** eller **kvar** – gissat utifrån mängden. Ett tryck på "Bekräfta" godkänner alla förval (grundprincip 3: ingenting ändras utan bekräftelse). Frågar sedan "Blev det rester?" och lägger i så fall in dem. Rätten läggs i historiken.
- **Påminnelse om upptining.** Dagen före en måltid med `thawAhead` visas en banderoll överst i appen: "Ta fram laxen till imorgon". Push-notiser är ett senare steg – de kräver Web Push, en schemalagd funktion och att appen ligger på hemskärmen.

---

## B. Inköpslistan

Inköpslistan är ett eget sparat dokument i Blobs, inte bara en vy av matplanen. Varor kommer från matplanens `missing`, från recept och från manuell inmatning.

1. **Kontrollera mot lagret.** Finns varan redan, även i en annan zon, tas den bort och användaren får en rad om var den finns ("Finns: nötfärs, frys").
2. **Överlagervarning.** Finns tre eller fler av samma `kind` (pasta, socker, bröd) läggs varan inte på listan utan en varning: "Du har redan 5 sorters pasta".
3. **Slå ihop mängder.** 200 g + 300 g crème fraiche blir en rad.
4. **Avrunda till förpackningsstorlek** med `packageSize` eller standardtabellen: 5 dl crème fraiche blir 2 × 2 dl.
5. **Gruppera efter butikens avdelning** – frukt och grönt, mejeri, kött och fisk, skafferi, frys.
6. **Bocka av.** Varor kan bockas av i butiken. När nästa kvitto läses in stryks de varor som köpts automatiskt.

### Export till ICA

Det finns inget officiellt API för ICA:s inköpslista.

1. **Kopiera till urklipp**, en vara per rad. Standardvägen. *Testa tidigt att ICA-appen verkligen delar upp inklistrade rader i separata varor.*
2. **Dela som text** via iOS delningsblad.

Integration mot ICA:s privata API är **struken**: den kräver BankID-inloggning, är odokumenterad och bryter troligen mot villkoren.

---

## C. Receptbanken och externa recept

### Inläsning

Samma inkorg, `/api/ingest`, med fältet `type=recipe`. Fält saknas → tolkas som kvitto eller zonfoto som i dag.

- **Ny iOS-genväg "Spara recept"**, en kopia av "Matlagret" som även skickar `type=recipe`. Det är säkrare och billigare än att låta Claude gissa om en bild är ett recept eller ett kylskåp.
- I appen: knappen **📖 Recept** under Att bekräfta.

Stöd för:

- **Skärmdump** från TikTok, Instagram eller Reels, där receptet står i bildtexten – den väg som fungerar bäst
- **Foto** på en kokbokssida eller en handskriven lapp
- **Inklistrad text** från en blogg eller ett meddelande
- **Länk** till en receptsida, som hämtas på serversidan. Fungerar för bloggar och receptsajter, men i praktiken inte för TikTok och Instagram, som kräver inloggning och JavaScript. Hämtningen tillåter bara `http(s)` mot publika adresser, med tidsgräns och storleksgräns.

### Tolkning

```json
{
  "title": "...",
  "sourceType": "social | bok | text | länk",
  "sourceUrl": "...",
  "servings": 2,
  "minutes": 25,
  "style": ["asiatiskt"],
  "ingredients": [
    { "name": "...", "qty": 200, "unit": "g", "confidence": "sure|likely|unsure" }
  ],
  "steps": ["..."]
}
```

**Portioner.** Sociala recept är oftast för 2 personer, hushållet är 3–4. Skala automatiskt vid visning och avrunda uppåt till hela förpackningar i inköpslistan. Visa originalportionerna, så att skalningen går att kontrollera.

**Vaga mängder.** "Lite soja", "en skvätt olja" och "efter smak" tolkas till en rimlig mängd och märks `unsure`. Fråga inte användaren.

Recepten sparas i Blobs under en egen nyckel, `recipes`.

### Avstämning mot lagret

När ett recept visas delas ingredienserna i tre grupper:

- **Finns** – med zon angiven ("nötfärs, frys")
- **Behöver köpas** – med skalad mängd
- **Kan bytas** – mot något i lagret, med en kort motivering ("crème fraiche i stället för grädde", "spirali i stället för penne")

En knapp lägger de saknade varorna på inköpslistan.

### Integration med matplanen

Sparade recept blir kandidater vid generering. Matchar ett sparat recept beställningens stil och tid, och kan lagas med det som finns eller med få inköp, ska det föreslås före ett påhittat recept. Markera det tydligt i planen ("ditt sparade recept").

---

## Byggordning

0. **Utökad lagerpost:** `styles`, `role`, `kind`, `opened`/`remaining`, `packageSize`, rester. Taggning vid kvittotolkning, engångstaggning av befintligt lager, knappen Öppnad i lagervyn.
1. **Inköpslistan:** sparad lista, manuell inmatning, kontroll mot lagret, överlagervarning, sammanslagning, avrundning, avdelningar, kopieringsknapp, avbockning via kvitto.
2. **Beställningsmodellen och kandidatlistan** i kod (utan AI, testbar med logg).
3. **Generering via Claude** i bakgrunden, plus regelkontrollen.
4. **Regenerera och lås** per måltid, **markera som lagad** med bekräftelselistan, upptiningsbanderoll.
5. **Receptinläsning** och avstämning, genvägen "Spara recept".
6. **Sparade recept** som kandidater i planen.

Inköpslistan kommer före matplanen eftersom överlagervarningen är det mest värdefulla, och den går att använda direkt med manuellt inlagda varor.

## Testdata

Testfallen nedan utgår från det riktiga lagret. Spara därför en ögonblicksbild av lagret i `testdata/inventory.json` (via en export i appen) och kör testerna mot den, så att de inte ändras när lagret ändras.

## Testfall

- Beställning: 2 middagar (asiatiskt, 30 min) + 1 dessert. Med testlagret ska desserten inte kräva några inköp.
- Beställning: 3 middagar italienskt. Ska välja pasta som redan finns och inte lägga pasta på inköpslistan.
- Två middagar med kyckling som huvudprotein på dagar i rad ska ge omgenerering av den andra.
- Skärmdump av ett TikTok-recept för 2 personer. Ska skalas till 4 och dela ingredienserna i finns och behöver köpas.
- Inköpslista med crème fraiche i två rätter (200 g + 300 g). Ska slås ihop till en rad med två förpackningar.
- Pasta på inköpslistan när lagret har fem sorters pasta. Ska ge överlagervarning i stället för en rad.
- Nötfärs 500 g i en lagad rätt när lagret har 2 st à 500 g. Förvalet ska bli "1 st kvar".

## Kostnad

Uppskattning med `claude-sonnet-4-6`: en hel plan ungefär 0,5–1 kr, en omgenererad måltid mindre. Tokenanvändningen loggas per anrop, precis som vid kvittotolkningen.
