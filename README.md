# Booli pendling

Se restiden till jobbet direkt på Booli. Skriptet lägger till **Pendling** och **Till station** i bostadens faktarad, en pendlingspoäng från 0 till 100 och, om du vill, en jämförelse med där du bor idag.

- Snabbaste vägen till dina resmål: kollektivtrafik, cykel eller gång till stationen plus tåg, eller cykel hela vägen
- Sista resan hem på kvällen
- Närmaste matbutik, skola och förskola, och körtid i rusning
- Fungerar i hela Sverige

## Installera

1. **Installera Tampermonkey** i din webbläsare från [tampermonkey.net](https://www.tampermonkey.net/).
   I Chrome och Edge behöver du också slå på **Tillåt användarskript** (i äldre versioner **Utvecklarläge**) under Tampermonkeys tilläggsinställningar.
2. **Klicka här: [Installera Booli pendlingspoäng](https://raw.githubusercontent.com/Aggsel/booli-pendling/main/booli-pendling.user.js)**
   Tampermonkey öppnar en installationsruta. Tryck på **Installera**.
3. **Öppna en bostad på [booli.se](https://www.booli.se)** och tryck på **Pendling: Ställ in** i faktaraden.
   Följ stegen under **Kom igång** för att lägga in en gratis nyckel från Trafiklab. Det tar ett par minuter.

## Uppdateringar

Tampermonkey letar efter nya versioner automatiskt och installerar dem. Dina inställningar och din nyckel finns kvar.

## Integritet

- Allt du ställer in, även din nuvarande adress, sparas bara i din webbläsare.
- Adressen skickas en gång till OpenStreetMap för att hitta platsen när du sparar den.
- Bostadens position skickas till Trafiklab och OpenStreetMap för att räkna ut restider. Inget skickas till Booli eller till någon annan.

## Data

- Kollektivtrafik: [Trafiklab](https://www.trafiklab.se) (ResRobot)
- Gång-, cykel- och bilvägar, butiker, skolor och adresser: © [OpenStreetMap](https://www.openstreetmap.org/copyright)-bidragsgivare

Körtid i rusning är en uppskattning. Närmaste skola betyder inte att ni får plats där.

## Något fungerar inte?

Skapa ett ärende under [Issues](https://github.com/Aggsel/booli-pendling/issues). Om restiderna verkar räknas från fel plats: öppna bostaden, välj **Kopiera positionsdata för felsökning** i Tampermonkeys meny och klistra in resultatet i ärendet.

## Licens

MIT
