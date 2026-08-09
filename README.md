# G-Rex Agent Control

Piano di controllo locale per più agenti di sviluppo, conforme alla sorgente di
verità [`docs/G-Rex-Agent-Control-Progettazione-V1.md`](docs/G-Rex-Agent-Control-Progettazione-V1.md).

**Stato: M2 — Registro progetti e stato.**

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
npm test       # test automatici (health, API progetti, stato e Git essenziale, persistenza al riavvio)
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

> Per l'invariante di sicurezza (§14) non va configurato un host pubblico
> (es. `0.0.0.0`).

## Struttura

```
server/   Control plane: API, dominio, persistenze, Event Store, stato Git, adapter
web/      Dashboard PWA (React + Vite)
docs/     Sorgente di verità progettuale
```

La separazione Control Plane / Execution Plane segue §7 del documento di
progettazione: in M2 esiste solo il Control Plane, che include il registro
progetti e lo stato operativo; l'Execution Plane (Cline, sessioni, processi)
arriverà con M3+.