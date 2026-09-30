# Spec: Matplan, inköpslista och externa recept

Bygger vidare på `CLAUDE.md`. Förutsätter att lager, inkorg och bekräftelsevy är på plats (steg 1–3).

Omfattar fyra delar:

- **0.** Utökad lagerpost – det som kandidatlistan, överlagervarningen och avdraget behöver
- **A.** Beställningsmodellen och matplansgenereringen, inklusive nya recept utifrån smakkombinationer
- **B.** Inköpslistan
- **C.** Receptbanken och inläsning av externa recept

---

## 0. Utökad lagerpost

Nya fält på `item`:

```
styles            // ["asiatiskt", ...] – bara för stilbärande varor, oftast tom (se nedan)
role              // protein | kolhydrat | grönsak | mejeri | smaksättning | dessert | övrigt
kind              // generisk varutyp: "pasta", "bröd", "socker", "sojabönor"
opened            // true om förpackningen är öppnad
remaining         // hur mycket som är kvar av den öppnade förpackningen: 1 | 0.75 | 0.5 | 0.25
packageSize       // { qty: 500, unit: "g" } – en förpacknings innehåll, om känt
```

Nytt värde för `source`: `leftover` (rester från en lagad rätt).

### Hur fälten sätts

- **`styles`, `role`, `kind`** sätts av Claude i samma anrop som kvitto- och fototolkningen, alltså utan extra kostnad. Befintliga varor taggas en gång i efterhand med ett samlat anrop. Alla tre kan rättas i redigeringsdialogen.
- **`styles` är medvetet gles.** Stilen hör till receptet, inte till råvaran. Bara varor som tydligt pekar ut ett kök får en stil – sojasås, tortillas, tacokrydda, pesto, ramen. Neutrala varor som mjölk, lök, ägg, potatis och ris lämnas utan. Att de flesta varor saknar stil är alltså rätt, inte en brist. `role` och `kind` ska däremot finnas på nästan alla varor.
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
  { date, type, style, maxMinutes, people, creativity }
]
```

- `date` – ISO-datum då måltiden ska lagas. Förvalt nästa lediga kväll, kan ändras.
- `type` – middag | lunch | matlåda | dessert | fredagsmys
- `style` – vardagsmat | asiatiskt | italienskt | husman | mexikanskt | fritt
- `maxMinutes` – 20 | 30 | 45 | fritt
- `people` – antal, förvalt 4
- `creativity` – känd (förval) | ny, se "Kreativitet" nedan

Varje måltid beställs separat. Det ska gå att blanda: två middagar på 30 minuter, en matlåda och en dessert.

### Stilen hör till måltiden

Stilen väljs i beställningen och är ett uppdrag till Claude: "hitta på en asiatisk middag". Claude får använda neutrala varor som kyckling, ris och broccoli i vilken stil som helst.

`styles` på lagerposterna används bara som en **liten knuff** när kandidatlistan byggs: har hushållet sojasås och sushiris hamnar de lite högre upp vid en asiatisk beställning, så att de används i stället för att köpas nytt. Det är aldrig ett krav, och en vara utan stil straffas inte.

Exempel på stilbärande varor i det befintliga lagret:

- **asiatiskt** – sushiris, ramen, Buldak, tahini, panko, sojasås
- **italienskt** – Collezione, pesto, oliver, salami
- **mexikanskt** – tacosås, tortillas, tacokrydda
- **husman** – prinskorv, ströbröd
- **dessert** – pärlsocker, florsocker, kakao, bourbonvanilj

### Generering i två steg

**Steg 1, i kod: bygg kandidatlistan.**

```
score = brådska + öppnad förpackning + stilknuff
```

- **brådska** – rester och `probably_out` högst, sedan färskvaror nära `perishBy`, sedan fryst, sedan skafferi
- **öppnad förpackning** – påslag, större ju mindre som är kvar
- **stilknuff** – litet påslag för varor vars `styles` matchar vald stil. Väger klart mindre än brådska.

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
- **Överraska mig.** Samma som "regenerera", men med `creativity: "ny"` (se nedan).

### Kreativitet: nya recept med smakkombinationer

Utöver kända rätter ska appen kunna hitta på något nytt utifrån vilka råvaror som passar ihop.

Varje måltid i beställningen får fältet:

```
creativity        // känd (förval) | ny
```

- **känd** – etablerade rätter i vald stil: pad thai, köttfärssås, tacos.
- **ny** – en rätt som inte behöver finnas som känt recept, byggd kring smakkombinationer.

**Så byggs en ny rätt**

1. **Ankare.** Utgå från 1–3 varor i lagret, i första hand de med högst brådska eller som är öppnade. Användaren kan också välja ankare själv ("gör något med rödbetorna och fetaosten").
2. **Smakkombinationer.** Claude väljer resten utifrån vilka råvaror som passar ihop – dels klassiska par som kockar använder (tomat–basilika, morot–kardemumma, jordgubbe–svartpeppar, lax–dill–citron), dels par som delar aromämnen (tanken bakom *food pairing*). Västerländsk matlagning parar ofta ingredienser med gemensamma aromer, medan östasiatisk oftare bygger på kontraster – det kan styra vilken sorts kombination som passar vald stil.
3. **Balans.** Rätten ska ha minst sälta, syra och fett i balans, gärna något sött, beskt, umami och krispigt. Saknas syra föreslås citron, vinäger eller inlagt – helst något som finns.
4. **En ny sak i taget.** Tekniken och grundformen ska vara bekanta (ugnsrostat, wok, gratäng, pasta), så att bara smakkombinationen är ny. Det ökar chansen att rätten blir god och att den hinns med inom `maxMinutes`.

**Extra fält i svaret för nya rätter**

```json
{
  "creativity": "ny",
  "pairings": [
    { "ingredients": ["rödbeta", "fetaost", "honung"], "why": "Jordig sötma möter salt syrlighet; honungen binder ihop." }
  ],
  "balance": { "salt": "fetaost", "syra": "citron", "fett": "olivolja", "krisp": "rostade solrosfrön" }
}
```

`pairings` visas i appen under rätten ("Varför det funkar"), så att man lär sig kombinationerna.

**Kunskapskälla.** Första versionen bygger på Claudes kunskap om smakkombinationer; ingen extern databas behövs. Blir förslagen enformiga kan en egen tabell med kombinationer läggas till senare – skriven av oss själva, eftersom etablerade uppslagsverk på området är upphovsrättsskyddade.

**Återkoppling.** Efter "Markera som lagad" för en ny rätt: **👍 / 👎** och **Spara som recept**. Tummen ned-kombinationer skickas med vid nästa generering ("undvik rödbeta + honung"), sparade hamnar i receptbanken (del C) och kan då föreslås som kända rätter.

Reglerna gäller även nya rätter. Dessutom: en ny rätt får ha högst två varor i `missing`.

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
5. **Kreativt läge:** `creativity: "ny"`, "Överraska mig", egna ankare, "Varför det funkar", tumme upp/ned.
6. **Receptinläsning** och avstämning, genvägen "Spara recept".
7. **Sparade recept** som kandidater i planen, inklusive sparade nya rätter.

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
- En middag med `creativity: "ny"` och ankare rödbeta + fetaost. Svaret ska ha `pairings` med motivering, `balance` med minst salt, syra och fett, högst två varor i `missing` och inte finnas i historiken.
- En kombination som fått tumme ned ska inte föreslås igen.

## Kostnad

Uppskattning med `claude-sonnet-4-6`: en hel plan ungefär 0,5–1 kr, en omgenererad måltid mindre. Tokenanvändningen loggas per anrop, precis som vid kvittotolkningen.
