# Strøm ⚡

Strømpris, nettleie, forbruk og kostnad på Windows-skrivebordet.

**[⬇ Last ned Strøm 2.7.0 for Windows](https://github.com/doxybox/strom/raw/main/last-ned/Strom-Setup-2.7.0.exe)** (`Strom-Setup-2.7.0.exe`, 0,6 MB)

## Hva den gjør

- **Strømprisen nå** – spotpris fra Nord Pool for ditt prisområde, med nettleie, avgifter og strømstøtte – eller Norgespris
- **Nettleie for 72 nettselskaper** – riktig energiledd for time, helg, helligdag og sesong, og kapasitetstrinn ([fri-nettleie](https://kraftsystemet.no/fri-nettleie/))
- **Time for time** i dag og i morgen, med de billigste timene fremover
- **Forbruk og kostnad** – live fra HAN-leser på hjemmenettet (finnes automatisk), eller fra Elhub-eksport
- **Varsler** når strømmen er billig, når morgendagens priser er klare, og før du havner i et dyrere kapasitetstrinn
- **Oppdaterer seg selv** – nye versjoner er signert og installeres automatisk

## Installere

1. Last ned `Strom-Setup-2.7.0.exe` fra lenken øverst (eller mappen [`last-ned/`](last-ned/))
2. Windows kan si «Windows beskyttet PC-en din» (programmet er ikke kodesignert): **Mer informasjon → Kjør likevel**
3. Følg veiviseren. Kjøremiljøet (Electron, ~150 MB) lastes ned under installasjonen og kontrolleres med SHA-256.

Krever Windows 10/11 (64-bit). Ingen administratortilgang.

## HAN-lesere

Støttet i dag: lesere med [amsreader-firmware](https://github.com/UtilitechAS/amsreader-firmware) (AmsLeser Pow-K, Pow-K+, Pow-U, Pow-P1 og hjemmelagde ESP-lesere). Nye lesertyper legges til som en «driver» i [`app/han.js`](app/han.js).

## Kilder og lisenser

- Spotpriser: Nord Pool (reserve: hvakosterstrommen.no)
- Nettleie: [fri-nettleie](https://github.com/kraftsystemet/fri-nettleie), CC BY 4.0
- Kjøremiljø: [Electron](https://www.electronjs.org/), MIT
- Prisene er beregninger – fakturaen gjelder alltid.
