# G-Rex Agent Control

Piano di controllo locale per più agenti di sviluppo, conforme alla sorgente di
verità [`docs/G-Rex-Agent-Control-Progettazione-V1.md`](docs/G-Rex-Agent-Control-Progettazione-V1.md).

**Stato: M6 — Storico e tracciabilità.**

## Cosa offre M2

- **Registro progetti**: registrazione e mantenimento di più progetti
  indipendenti con nome univoco, percorso repository, **obiettivo corrente**
  e **stato operativo** ufficiale (stati §4: Fermo, In avvio, In lavorazione,
  Richiede attenzione, Bloccato, Completato, Errore).
- **Stato Git essenziale** (§5/§6-SYSTEM): lettura dal repository reale di
  ramo corrente, HEAD, dirty state, ahead/behind e ultimo commit; lo
  snapshot è ufficiale e persistito in Agent Control (sopravvive al riavvio).
- Dashboard locale **React + Vite** (PWA responsive) con raggruppamento
  affidabile in **tre gruppi**: *Fermo*, *In lavorazione*, *Con problema*
  (dove problema include Richiede attenzione / Bloccato / Errore).
- Server locale (Node.js + TypeScript + Fastify) con API REST su
  `127.0.0.1` (nessuna esposizione pubblica) ed Event Store: ogni
  transizione di stato e ogni lettura Git viene tracciata.
- Port **AgentAdapter** astratto (nessuna sessione agente in M2: le sessioni
  Cline arrivano con M3+).
- Nessun servizio esterno richiesto per il funzionamento locale.

## Cosa offre M3

- **Obiettivi** (§5): un solo obiettivo attivo per progetto (invariante
  §14), con titolo, testo, invarianti, criteri di accettazione, condizione
  di stop e snapshot Git di inizio lavoro come evidenza (§6-SYSTEM).
- **Sessioni agente** (§5): ogni obiettivo nasce con la sua sessione
  iniziale. Avvio (`ATTIVA` → progetto `IN_LAVORAZIONE`), stop controllato
  (`INTERROTTA` → obiettivo e progetto `RICHIEDE_ATTENZIONE`),
  completamento (`COMPLETATA` con report e snapshot Git finale) e
  annullamento (obiettivo `ANNULLATO`, progetto `FERMO`).
- **Adapter agente** (§8): `fake` per demo/test deterministici, `cline`
  per l'integrazione con la CLI Cline (l'avvio reale del processo è
  pianificato per M4+).
- La dashboard espone il pannello **Obiettivi e sessioni agente** per ogni
  progetto registrato.

## Cosa offre M4

- **Checkpoint persistenti** per gli esiti di sessione: `COMPLETED`,
  `INTERRUPTED`, `BLOCKED`, `ERROR`.
- Checkpoint in stato `PENDING_DECISION` con evidenze verificate dal
  sistema e dichiarazioni dell'agente.
- Contatore `pendingDecisions` in `/api/status` e API REST per elencare
  e visualizzare checkpoint.
- Dashboard con storico checkpoint e stato decisionale.

## Cosa offre M5

- **Decisioni umane** su checkpoint `POST /api/checkpoints/:id/decide`.
- `HumanDecision` persistente e append-only per ogni checkpoint deciso.
- Effetti deterministici su `Objective` e `Project`:
  - `APPROVE` → obiettivo `COMPLETATO`, progetto `COMPLETATO`
  - `REQUEST_CHANGES` → obiettivo/progetto `RICHIEDE_ATTENZIONE`
  - `STOP` → obiettivo `RICHIEDE_ATTENZIONE`
  - `CANCEL` → obiettivo `ANNULLATO`, progetto `FERMO`
- UI del client per decidere direttamente dai checkpoint pendenti.

## Cosa offre M6

- **Storico persistente** e tracciabilità tramite endpoint `GET /api/events`.
- Filtri per `projectId`, `objectiveId` e `sessionId` sui record storici.
- Dashboard UI aggiornata per interrogare lo storico filtrato e ricostruire la sequenza degli eventi.
- Copertura testata con suite completa `npm run verify`.

## Requisiti

- Node.js ≥ 23.4 (richiesto da `node:sqlite`, il motore SQLite nativo di
  Node.js usato per la persistenza; consigliato ≥ 24) e npm.

## Installazione

```bash
npm install
```

## Avvio (sviluppo)

```bash
npm run dev
```

Avvia server (API su `http://127.0.0.1:3000`) e dashboard
(`http://127.0.0.1:5173`) con proxy `/api` verso il backend.

Solo il server:

```bash
npm run dev:server
```

Solo la dashboard:

```bash
npm run dev:web
```

## Verifiche

```bash
npm test       # test automatici (health, API progetti, stato e Git essenziale, obiettivi/sessioni agente, persistenza al riavvio)
npm run build  # typecheck + build server e web
npm run verify # build + test (evidenza di accettazione)
```

## Registro e stato operativo (M2)

Ogni progetto ha un **stato ufficiale** mantenuto da Agent Control
(§5: lo stato appartiene alla piattaforma, non all'agente). La dashboard
raggruppa gli stati §4 in tre macro-gruppi:

| Gruppo dashboard | Stati §4 |
| --- | --- |
| Fermo | Fermo, Completato |
| In lavorazione | In avvio, In lavorazione |
| Con problema | Richiede attenzione, Bloccato, Errore |

### Stato Git essenziale

Per un progetto con `repository_path` configurato, Agent Control può
leggere (sola lettura) dal repository reale: ramo corrente, HEAD breve,
albero sporco (§6-SYSTEM `dirty state`), `ahead`/`behind` rispetto
all'upstream e ultimo commit. Lo snapshot viene salvato nel database
locale: è quindi disponibile anche dopo i riavvii. Se il percorso non è
un repository valido, lo snapshot registra l'errore in modo esplicito.

### Endpoint

| Metodo | Percorso | Descrizione |
| --- | --- | --- |
| `GET` | `/api/status` | Riepilogo per stato e per gruppo (fermo/lavoro/problema) |
| `GET` | `/api/projects` | Elenco progetti |
| `GET` | `/api/projects/:id` | Dettaglio progetto |
| `POST` | `/api/projects` | Registra un progetto (nome, repository facoltativo, obiettivo corrente) |
| `PATCH` | `/api/projects/:id` | Aggiorna repository e/o obiettivo corrente |
| `PATCH` | `/api/projects/:id/status` | Imposta lo stato operativo ufficiale |
| `POST` | `/api/projects/:id/git-status` | Riletta e persiste lo stato Git essenziale |
| `GET` | `/api/projects/:id/objectives` | Elenca gli obiettivi del progetto |
| `POST` | `/api/projects/:id/objectives` | Crea un obiettivo (con la sessione iniziale) |
| `GET` | `/api/objectives/:id` | Dettaglio obiettivo con le sue sessioni |
| `POST` | `/api/objectives/:id/sessions/:sessionId/start` | Avvia la sessione agente |
| `POST` | `/api/objectives/:id/sessions/:sessionId/stop` | Ferma la sessione (→ richiede attenzione) |
| `POST` | `/api/objectives/:id/complete` | Completa l'obiettivo (report + snapshot Git finale) |
| `POST` | `/api/objectives/:id/cancel` | Annulla l'obiettivo |
| `GET` | `/api/events` | Eventi recenti (State & Event Store) |

## Persistenza e configurazione

La cartella dati predefinita è `data/` (creata al primo avvio). Variabili
d'ambiente opzionali:

| Variabile | Default | Descrizione |
| --- | --- | --- |
| `GAC_HOST` | `127.0.0.1` | Bind del server API (mantenere locale) |
| `GAC_PORT` | `3000` | Porta del server API |
| `GAC_DATA_DIR` | `./data` | Cartella di persistenza (SQLite) |
| `GAC_LOG_LEVEL` | `info` | Livello di log Fastify |
| `GAC_CLINE_COMMAND` | `cline` | Comando della CLI Cline (percorso o nome sul PATH) |
| `GAC_CLINE_ENABLED` | `true` | Abilita l'adapter Cline (`false` per disabilitarlo) |
| `GAC_AGENT_MODE` | `cline` | Adapter agente: `fake` (demo/test) o `cline` |

> Per l'invariante di sicurezza (§14) non va configurato un host pubblico
> (es. `0.0.0.0`).

## Struttura

```
server/   Control plane: API, dominio, persistenze, Event Store, stato Git, adapter
web/      Dashboard PWA (React + Vite)
docs/     Sorgente di verità progettuale
```

La separazione Control Plane / Execution Plane segue §7 del documento di
progettazione: il Control Plane include registro progetti, stato operativo
e il ciclo obiettivo → sessione agente (M3); l'Execution Plane (avvio
effettivo dei processi Cline) arriverà con M4+.