// Vanliga matvaror för förslag medan man skriver. Generella namn, inte märken.
export const GROCERIES = [
  // Frukt och grönt
  "Avokado", "Aubergine", "Banan", "Basilika", "Blomkål", "Blåbär", "Broccoli", "Brysselkål", "Champinjoner",
  "Citron", "Clementiner", "Dill", "Druvor", "Färskpotatis", "Gräslök", "Grönkål", "Gul lök", "Gurka",
  "Hallon", "Ingefära", "Isbergssallad", "Jordgubbar", "Kiwi", "Koriander", "Körsbärstomater", "Lime",
  "Mango", "Melon", "Mynta", "Morötter", "Nektariner", "Paprika", "Palsternacka", "Persilja", "Plommon",
  "Potatis", "Purjolök", "Päron", "Rödbetor", "Rödkål", "Rödlök", "Romansallad", "Ruccola", "Rotselleri",
  "Salladslök", "Sallad", "Schalottenlök", "Sockerärtor", "Spenat", "Sötpotatis", "Tomater", "Vitkål",
  "Vitlök", "Zucchini", "Äpplen", "Apelsiner", "Chili", "Haricots verts", "Majskolvar", "Pumpa", "Rädisor",
  "Sparris", "Svamp", "Fänkål", "Kålrot", "Squash",
  // Mejeri och ägg
  "Crème fraiche", "Cottage cheese", "Fetaost", "Filmjölk", "Grädde", "Gräddfil", "Grekisk yoghurt",
  "Halloumi", "Havremjölk", "Hushållsost", "Keso", "Kvarg", "Lättmjölk", "Matlagningsgrädde", "Mellanmjölk",
  "Mjölk", "Mozzarella", "Parmesan", "Philadelphiaost", "Prästost", "Riven ost", "Smör", "Standardmjölk",
  "Vispgrädde", "Yoghurt", "Ägg", "Bregott", "Västerbottensost", "Cheddar", "Getost", "Ricotta",
  "Mascarpone", "Turkisk yoghurt", "Kesella",
  // Kött, fisk och vegetariskt protein
  "Bacon", "Blandfärs", "Biff", "Chorizo", "Falukorv", "Fläskfilé", "Fläskkotlett", "Fläskkarré",
  "Grillkorv", "Kassler", "Kycklingbröst", "Kycklingfilé", "Kycklingfärs", "Kycklinglårfilé", "Kyckling hel",
  "Köttbullar", "Köttfärs", "Lammfärs", "Nötfärs", "Pulled pork", "Prinskorv", "Salami", "Skinka",
  "Högrevsfärs", "Entrecôte", "Fläskfärs", "Rökt skinka", "Leverpastej",
  "Lax", "Laxfilé", "Torsk", "Torskfilé", "Sej", "Kolja", "Räkor", "Fiskpinnar", "Tonfisk", "Makrill i tomat",
  "Sill", "Kallrökt lax", "Varmrökt lax", "Rödspätta", "Musslor",
  "Tofu", "Quorn", "Sojafärs", "Kikärtor", "Kidneybönor", "Svarta bönor", "Vita bönor",
  "Röda linser", "Gröna linser", "Edamamebönor", "Sojabönor",
  // Skafferi
  "Pasta", "Spaghetti", "Penne", "Makaroner", "Fusilli", "Tagliatelle", "Lasagneplattor", "Gnocchi",
  "Ris", "Jasminris", "Basmatiris", "Risottoris", "Sushiris", "Matvete", "Bulgur", "Couscous", "Quinoa",
  "Nudlar", "Äggnudlar", "Risnudlar", "Havregryn", "Müsli", "Flingor", "Mannagryn",
  "Vetemjöl", "Grahamsmjöl", "Rågmjöl", "Majsstärkelse", "Strösocker", "Florsocker", "Farinsocker",
  "Pärlsocker", "Vaniljsocker", "Bakpulver", "Bikarbonat", "Jäst", "Kakao", "Mörk choklad", "Honung", "Sirap",
  "Olivolja", "Rapsolja", "Matolja", "Sesamolja", "Vinäger", "Balsamvinäger", "Äppelcidervinäger",
  "Krossade tomater", "Passerade tomater", "Tomatpuré", "Kokosmjölk", "Buljong", "Hönsbuljong",
  "Grönsaksbuljong", "Kalvfond", "Sojasås", "Fisksås", "Ostronsås", "Sweet chilisås", "Sriracha",
  "Ketchup", "Senap", "Majonnäs", "Pesto", "Tacosås", "Tacokrydda", "Tortillabröd", "Tacoskal",
  "Salsa", "Majs", "Kapris", "Oliver", "Soltorkade tomater", "Jordnötssmör", "Tahini", "Sylt",
  "Lingonsylt", "Panko", "Ströbröd", "Nötter", "Cashewnötter", "Mandlar", "Valnötter", "Russin",
  "Solrosfrön", "Pumpafrön", "Sesamfrön", "Chiafrön", "Kaffe", "Te", "Knäckebröd", "Ramen",
  // Kryddor och basvaror
  "Salt", "Svartpeppar", "Paprikapulver", "Spiskummin", "Kanel", "Kardemumma", "Curry", "Gurkmeja",
  "Oregano", "Timjan", "Rosmarin", "Chiliflakes", "Vitlökspulver", "Lagerblad", "Muskot", "Ingefärspulver",
  "Garam masala", "Cayennepeppar", "Rökt paprika", "Vaniljstång", "Redning",
  // Bröd
  "Bröd", "Rågbröd", "Limpa", "Formfranska", "Baguette", "Frallor", "Hamburgerbröd", "Korvbröd",
  "Pitabröd", "Naanbröd", "Surdegsbröd", "Tunnbröd", "Bagels",
  // Fryst
  "Frysta ärter", "Frysta bär", "Frysta hallon", "Frysta blåbär", "Wokgrönsaker", "Frysta grönsaker",
  "Pommes frites", "Glass", "Fryst spenat", "Fryst broccoli", "Fryst mango", "Fiskgratäng",
  // Dryck
  "Apelsinjuice", "Äppeljuice", "Mineralvatten", "Läsk", "Saft",
];
