<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# 1. chce iść własną droga i nauczyć sie budować rozwiązania od podstaw.

2. gmail_search oraz read ale chciałbym aby posiadał tez inne mozliwosci. np ma grupować e-maile od dostawców/kurierów i na podstawie tego przygotować zestawienie paczek/ przesyłek jakie do mnie jadą oraz monitorować ich status na podstawie otrzymywanych wiadomości. 3. pełna automatyzacja 4. pro aktywnie, co kilka minut sprawdza poczte. 5 model ma byc w stanie pamiętać wątek związany z danym numerem przesyłki i byc w stanie aktualizować jej status, dobierz odpowiednie rozwiązanie które pozwoli na łatwe utrzymanie. 6. historia decyzji może byc zapamiętywania do późniejszej nauki. 7. Pierwotnie myślałem nad jednym agentem, ale jeśli dwa, agenty będą okej w tym przypadku, też będzie dobrze. 8. Heartbeat. 9 Agent nie będzie miał narzędzi do wysyłania, ani edycji więc nie potrzeba tej sekcji. 10. Myślę nad szybkim prototypem.11. Prosty interfejs webowy, to najlepsze rozwiązanie. Agent ma mi przygotować podsumowanie wiadomości oraz statusy przesyłek, jakie do mnie docierają. 12. Zaakceptuję każdy framework, który będzie utrzymywalny i będzie posiadał dobrą dokumentację, która umożliwi mi rozwijanie zastosowań agenta.

Mam teraz pełen obraz Twojego projektu i kontekst z lekcji AI_Devs 4. Czas na mapę architektury.

***

# 🗺️ Architektura Gmail Agent – Mapa Projektu

Odpowiedzi zebrałem w spójną architekturę opartą bezpośrednio na wzorcach z kursu: **S03E04** (narzędzia Gmail), **S03E03** (Heartbeat + proaktywność), **S02E03** (Observational Memory), **S05E04** (produkcyjna pętla agenta) i **S01E03** (MCP / Tool Design). [^1][^2][^3]

***

## 🏛️ Ogólna Architektura – 2 Agenty

Lekcja S02E04 i S05E04 uzasadniają podział na dwa wyspecjalizowane agenty zamiast jednego przeciążonego. Każdy ma wąską odpowiedzialność – to zwiększa stabilność i ułatwia debugowanie. [^3]

```
┌─────────────────────────────────────────────────────┐
│                   HEARTBEAT (co 5 min)               │
│              Cron/setInterval w Node.js              │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │   AGENT 1: CLASSIFIER   │  ← Lekki, szybki
          │  (gpt-5-mini / claude   │
          │   haiku)                │
          │  • gmail_search         │
          │  • gmail_read           │
          │  • Kategoryzuje maile   │
          │  • Wykrywa przesyłki    │
          │  • Zapisuje do SQLite   │
          └────────────┬────────────┘
                       │ delegateToAgent()
          ┌────────────▼────────────┐
          │   AGENT 2: TRACKER      │  ← Głębszy reasoning
          │  (claude-sonnet /       │
          │   gpt-5.2)              │
          │  • Odczytuje historię   │
          │  • Aktualizuje status   │
          │    przesyłek            │
          │  • Generuje podsumowanie│
          │  • Zapisuje do SQLite   │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │     WEB UI (Node.js     │
          │     Express + SSE)      │
          │  • Dashboard przesyłek  │
          │  • Podsumowanie dnia    │
          │  • Historia decyzji     │
          └─────────────────────────┘
```


***

## 🔧 Narzędzia Gmail (Tool Design wg S03E04)

Zbudujesz je od podstaw w TypeScript. Każde narzędzie zwraca **wspólną strukturę odpowiedzi** z polami: `nextAction`, `recovery`, `diagnostics` – dokładnie jak opisuje lekcja S03E04. Załączniki nigdy jako base64, tylko jako URL. [^1]


| Narzędzie | Opis | Agent |
| :-- | :-- | :-- |
| `gmail_search` | Szukaj po etykietach, nadawcy, dacie, frazie. Zwraca: id, snippet, hasAttachment, labels, isRead | CLASSIFIER |
| `gmail_read` | Czyta wątek z kontrolą szczegółowości (`summary` / `full`). Rozwiązuje threadId automatycznie | CLASSIFIER |
| `gmail_list_labels` | Lista etykiet – używana raz przy starcie do budowania kontekstu | CLASSIFIER |

> **Blokada hardcodowana w kodzie**: brak `gmail_send`, `gmail_modify`, `gmail_delete`. Agent ma dostęp **read-only**. To nie jest konfiguracja – to brak narzędzi. [^4]

***

## 💾 Pamięć – Podejście Hybrydowe

Lekcja S02E03 i S05E05 wskazują, że **Observational Memory** wystarczy do kompresji kontekstu. Ale do śledzenia przesyłek (trwała wiedza o numerach, statusach) potrzebujemy **SQLite** – lekkiej, łatwej w utrzymaniu bazy lokalnej bez zewnętrznych zależności. [^5]

```
┌─────────────────────────────────────────┐
│              SQLite (lokalnie)           │
├──────────────────┬──────────────────────┤
│  TABLE parcels   │  TABLE decisions     │
│  ─ tracking_no   │  ─ timestamp         │
│  ─ carrier       │  ─ email_id          │
│  ─ status        │  ─ action_taken      │
│  ─ last_update   │  ─ agent_reasoning   │
│  ─ history (JSON)│  ─ outcome           │
└──────────────────┴──────────────────────┘
```

- **Przesyłki** → SQLite – każdy numer ma historię statusów (JSON array w jednym polu)
- **Decyzje agenta** → SQLite – tabela `decisions` do późniejszej nauki (odpowiedź na pytanie 6)
- **Kompresja kontekstu** → Observational Memory przy ~30k tokenów – agent zapisuje obserwacje, nie pełną historię

***

## 🔁 Pętla Heartbeat (wg S03E03)

Lekcja S03E03 dokładnie opisuje mechanikę heartbeat – regularne wywołanie sprawdzające stan systemu. Implementacja w Node.js: [^2]

```typescript
// heartbeat.ts
const INTERVAL_MS = 5 * 60 * 1000; // 5 minut

async function heartbeat() {
  const lastChecked = await db.getLastChecked();
  const message = `
    Check Gmail for new messages since ${lastChecked}.
    Focus on: courier/delivery emails, order confirmations,
    shipping updates. Update parcel statuses in DB.
    Current tracked parcels: ${await db.getActiveParcels()}
  `;
  await runClassifierAgent(message);
}

setInterval(heartbeat, INTERVAL_MS);
```

> Kluczowa zasada z S05E04: heartbeat odświeża "rezerwację" aktywności – jeśli proces padnie, scheduler automatycznie ponawia. W Twojej wersji lokalnej: prosty `setInterval` + flaga `isRunning` zapobiega nakładaniu się wywołań. [^3]

***

## 📦 Wykrywanie Przesyłek – Logika Klasyfikacji

Agent 1 (Classifier) używa system promptu z instrukcją rozpoznawania nadawców kurierskich. To nie są "reguły w kodzie" – to **prompt engineering** + **narzędzia z ograniczeniami**:

```
Jesteś klasyfikatorem emaili. Skupiasz się wyłącznie na:
- Potwierdzeniach zamówień (Amazon, Allegro, sklepy)
- Powiadomieniach kurierskich (DHL, DPD, InPost, UPS, GLS, FedEx, Poczta Polska)
- Aktualizacjach statusu przesyłek
- Powiadomieniach o dostawie/odebraniu

Dla każdego pasującego emaila wyciągnij:
- numer_sledzen ia (tracking number)
- carrier (firma kurierska)
- status (ordered / shipped / in_transit / out_for_delivery / delivered)
- estimated_delivery (jeśli podano)

Jeśli email nie dotyczy przesyłek → ignoruj, zwróć { skip: true }
```


***

## 🏗️ Struktura Projektu w VSC

```
gmail-agent/
├── src/
│   ├── agents/
│   │   ├── classifier.ts      ← Agent 1: klasyfikacja + wykrywanie przesyłek
│   │   └── tracker.ts         ← Agent 2: śledzenie statusów + podsumowania
│   ├── tools/
│   │   ├── gmail-search.ts    ← Narzędzie #1
│   │   ├── gmail-read.ts      ← Narzędzie #2
│   │   └── gmail-labels.ts    ← Narzędzie #3
│   ├── memory/
│   │   ├── db.ts              ← SQLite (better-sqlite3)
│   │   └── observations.ts    ← Observational Memory
│   ├── core/
│   │   ├── heartbeat.ts       ← Główna pętla co 5 min
│   │   ├── agent-loop.ts      ← Pętla ReAct (plan→act→observe)
│   │   └── llm-provider.ts    ← Wspólny interfejs (OpenAI/Anthropic)
│   ├── ui/
│   │   ├── server.ts          ← Express + SSE (real-time updates)
│   │   └── public/
│   │       └── index.html     ← Dashboard (vanilla JS + SSE)
│   └── index.ts               ← Entry point
├── data/
│   └── gmail-agent.db         ← SQLite plik
├── credentials.json           ← Google OAuth (gitignore!)
├── .env                       ← Klucze API (gitignore!)
└── package.json
```


***

## 🖥️ Web UI – Dashboard Przesyłek

Prosty interfejs webowy (Express + Server-Sent Events) – bez frameworków frontendowych, zgodnie z filozofią kursu "brak frameworków = większa elastyczność": [^3]

```
┌─────────────────────────────────────────────┐
│  📦 Gmail Agent Dashboard                   │
│  Ostatni scan: 3 min temu  [Scan teraz]     │
├─────────────────────────────────────────────┤
│  AKTYWNE PRZESYŁKI                          │
│  ─────────────────────────────────────────  │
│  📦 DHL #1234567890    → W drodze  (DHL)    │
│     Szac. dostawa: jutro 8-12              │
│                                             │
│  📦 InPost #PL987654   → Paczkomat  ✅      │
│     Gotowa do odbioru od 2h                │
├─────────────────────────────────────────────┤
│  PODSUMOWANIE DNIA                          │
│  Agent: "Dziś oczekujesz 2 paczek.         │
│  Zamówienie #XYZ z Allegro zostało         │
│  przekazane do DHL..."                      │
├─────────────────────────────────────────────┤
│  HISTORIA DECYZJI    [eksportuj CSV]        │
│  10:03 - Nowy mail DPD → tracking dodany   │
│  09:47 - Status InPost: delivered          │
└─────────────────────────────────────────────┘
```

SSE (`/api/stream`) zapewnia **live updates** – UI odświeża się bez pollingu, gdy agent zakończy skan.

***

## 🛠️ Stack Techniczny

Wybór uzasadniony dobrą dokumentacją i łatwością utrzymania, jak prosiłeś:


| Element | Wybór | Uzasadnienie |
| :-- | :-- | :-- |
| **Runtime** | Node.js + TypeScript | Całość przykładów z kursu, doskonała dokumentacja |
| **LLM Provider** | Vercel AI SDK | Wspólny interfejs dla Claude/OpenAI, łatwa podmiana modelu |
| **Agent 1 (Classifier)** | `claude-haiku-3-5` lub `gpt-5-mini` | Tani, szybki – musi działać co 5 min |
| **Agent 2 (Tracker)** | `claude-sonnet-4-5` | Głębszy reasoning do śledzenia wątków |
| **Baza danych** | `better-sqlite3` | Lokalna, zero konfiguracji, świetna dokumentacja |
| **Gmail API** | `googleapis` SDK | Oficjalne SDK Google, dobrze znane LLM |
| **Web Server** | Express.js | Minimalny, łatwy w utrzymaniu |
| **Ewaluacja** | Promptfoo (opcjonalnie) | Dokładnie jak w S03E04 |


***

## 🚀 Mapa Wdrożenia – Etapy

Podejście **szybki prototyp → iteracja**, zgodne z Twoją odpowiedzią:

1. **Etap 1 (MVP)** – Narzędzia Gmail + autoryzacja OAuth + `gmail_search` zwracający dane. Test ręczny w VSC z Claude Code
2. **Etap 2** – Agent Classifier z prostym system promptem + SQLite dla przesyłek. Test na żywej skrzynce
3. **Etap 3** – Heartbeat loop + Agent Tracker (delegacja). Pierwsze automatyczne podsumowania
4. **Etap 4** – Web UI z dashboardem + SSE. Historia decyzji widoczna w przeglądarce
5. **Etap 5** – Observational Memory + optymalizacja modeli (tańszy model dla Classifier po testach Promptfoo)

***

Masz teraz pełną mapę. Następny krok to **Etap 1**: zbudowanie narzędzia `gmail_search` od podstaw z właściwą strukturą `nextAction`/`recovery` według wzorca z S03E04. Czy chcesz zacząć właśnie od tego?
<span style="display:none">[^6]</span>

<div align="center">⁂</div>

[^1]: s03e04-budowanie-narzedzi-na-podstawie-danych-testowych-1774477151-1.md

[^2]: s03e03-kontekstowy-feedback-wspierajacy-skutecznosc-agentow-1774391034-1.md

[^3]: s05e04-produkcja-1775717856.md

[^4]: s01e05-zarzadzanie-jawnymi-oraz-niejawnymi-limitami-modeli-1773377197.md

[^5]: s05e05-secret-1775803400.md

[^6]: s04e03-kontekstowa-wspolpraca-z-ai-1774999647.md

