# M5 — Approvazione e prosecuzione

> Piano di implementazione · estratto dalla sorgente di verità
> (`G-Rex-Agent-Control-Progettazione-V1.md` §12).

---

## 1. Obiettivo

Rendere persistenti e operative le **decisioni umane** sui checkpoint:
approvazione, richiesta modifiche, stop e annullamento. Ogni decisione
trasforma un checkpoint `PENDING_DECISION` in `DECIDED`, produce effetti
sull'obiettivo e sul progetto, e viene registrata come entità
indipendente (`HumanDecision`) che lo storico ufficiale può ricostruire.

Nessun avanzamento è automatico: l'operatore conferma esplicitamente.

## 2. Capacità riutilizzabili

| # | Capacità | Perché è un mattone |
|---|----------|----------------------|
| C1 | Entità `HumanDecision` (dominio + persistence) | Base per storico decisioni (§5, §6-HUMAN) e per M6 tracciabilità |
| C2 | Lifecycle checkpoint `PENDING_DECISION → DECIDED` | Transizione di stato pulita, estendibile a futuri livelli decisionali |
| C3 | Servizio `DecisionService` | Logica applicativa centrata sulla decisione: validazione, effetti, eventi |
| C4 | API decisionale `POST /api/checkpoints/:id/decide` | Contratto HTTP per il web client e per futuri client (mobile M7) |
| C5 | Effetti della decisione su Objective e Project | Approvazione → COMPLETATO, request changes → nuovo ciclo, stop/cancel → ANNULLATO |
| C6 | Sorgente evidenze `HUMAN` | Completa il triangolo SYSTEM/AGENT/HUMAN del §6 |
| C7 | UI decisionale nel web client | Pulsanti di azione sui checkpoint pendenti + storico decisioni |

## 3. Lacune reali (gap rispetto al codice attuale)

| # | Gap | Severità |
|---|-----|----------|
| G1 | **Nessuna entità `HumanDecision`** — §5 la definisce ma M4 non l'ha implementata | Critica |
| G2 | **Checkpoint.status è literalmente `'PENDING_DECISION'`** — il tipo non ammette altri valori | Critica |
| G3 | **`objective.conclude()` porta a `RICHIEDE_ATTENZIONE`** ma non esiste il passaggio successivo a `COMPLETATO` | Critica |
| G4 | **Nessun endpoint decisionale** — non si può decidere su un checkpoint | Critica |
| G5 | **`EVIDENCE_SOURCES` è solo `['SYSTEM', 'AGENT']`** — `HUMAN` manca | Media |
| G6 | **La `cancel()` di ObjectiveService non passa per un checkpoint** — salta il ciclo decisionale | Media |
| G7 | **CheckpointList è read-only** — nessun pulsante di azione | Media |
| G8 | **La tabella `checkpoints` non ha colonne per lo stato deciso** (`decided_at`, `decision_type`) | Bassa |


## 4. Boundary e invarianti

### 4.1 Invarianti di progetto (§14) coinvolti

- **§14-INV3**: "Nessun obiettivo successivo parte senza autorizzazione umana nella V1."
  → La decisione APPROVE chiude l'obiettivo. REQUEST_CHANGES lascia aperto
  l'obiettivo corrente ma non avvia automaticamente nulla: serve un azione
  esplicita per creare una nuova sessione.

- **§14-INV4**: "Le evidenze dichiarate dall'agente non vengono presentate
  come verificate dal sistema."
  → Le decisioni HUMAN vengono etichettate con `EVIDENCE_SOURCE: HUMAN` e
  non mescolate con SYSTEM o AGENT.

- **§14-INV7**: "Lo storico ufficiale appartiene ad Agent Control, non alla
  singola sessione agente."
  → La `HumanDecision` è persistita in SQLite, indipendente dalla sessione.

### 4.2 Invarianti nuovi di M5

- **M5-INV1**: Un checkpoint `DECIDED` non può tornare `PENDING_DECISION`
  (la decisione è irreversibile).
- **M5-INV2**: Una `HumanDecision` non può essere modificata o cancellata
  dopo la creazione (append-only).
- **M5-INV3**: L'effetto di una decisione su Objective/Project è
  deterministico: stessa decisione + stesso stato → stesso risultato.
- **M5-INV4**: APPROVE su un checkpoint con outcome diverso da `COMPLETED`
  non porta l'obiettivo a `COMPLETATO` (richiede `REQUEST_CHANGES` o
  `STOP`).

## 5. Modello dati aggiuntivo

### HumanDecision (§5)

```sql
CREATE TABLE IF NOT EXISTS human_decisions (
  id              TEXT PRIMARY KEY,
  checkpoint_id   TEXT NOT NULL,
  objective_id    TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  decision_type   TEXT NOT NULL,  -- APPROVE | REQUEST_CHANGES | STOP | CANCEL
  note            TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_human_decisions_objective
  ON human_decisions (objective_id);
CREATE INDEX IF NOT EXISTS idx_human_decisions_checkpoint
  ON human_decisions (checkpoint_id);
```

### Modifiche a `checkpoints`

- Lo stato si espande: `'PENDING_DECISION' | 'DECIDED'`
- Aggiunta colonna `decided_at TEXT` (null finché pendente)
- Aggiunta colonna `decision_type TEXT` (null finché pendente)

### Migrazione

Schema version: v4 → v5. DDL idempotente (IF NOT EXISTS + ALTER TABLE).

## 6. Effetti decisionali (transizioni)

| Decisione | Checkpoint outcome ammesso | Effetto su Objective | Effetto su Project | Note |
|-----------|---------------------------|---------------------|-------------------|------|
| **APPROVE** | `COMPLETED` | → `COMPLETATO` | → `COMPLETATO` | L'obiettivo è concluso e approvato. L'invariante §14 si libera. |
| **APPROVE** | `INTERRUPTED`, `BLOCKED`, `ERROR` | → `COMPLETATO` (override) | → `COMPLETATO` | L'operatore decide di accettare il risultato nonostante l'esito. |
| **REQUEST_CHANGES** | qualsiasi | resta `RICHIEDE_ATTENZIONE` | resta `RICHIEDE_ATTENZIONE` | Nessun avanzamento automatico. L'operatore dovrà poi creare una nuova sessione. |
| **STOP** | qualsiasi | → `ANNULLATO` | → `FERMO` | L'operatore decide di interrompere l'obiettivo. |
| **CANCEL** | qualsiasi | → `ANNULLATO` | → `FERMO` | Identico a STOP in effetti; semantica diversa per lo storico. |

### Dettaglio APPROVE

```
1. Checkpoint.status → DECIDED, decided_at = now, decision_type = APPROVE
2. HumanDecision.create(type=APPROVE, note, checkpoint_id, objective_id, project_id)
3. Objective.status → COMPLETATO (completedAt = now se non già impostato)
4. Project.status → COMPLETATO
5. Event: human_decision.created, objective.completed (se nuovo)
```

### Dettaglio REQUEST_CHANGES

```
1. Checkpoint.status → DECIDED, decided_at = now, decision_type = REQUEST_CHANGES
2. HumanDecision.create(type=REQUEST_CHANGES, note, ...)
3. Nessun cambio di stato a Objective/Project (restano RICHIEDE_ATTENZIONE)
4. Event: human_decision.created
```

### Dettaglio STOP / CANCEL

```
1. Checkpoint.status → DECIDED, decided_at = now, decision_type = STOP|CANCEL
2. HumanDecision.create(type=STOP|CANCEL, note, ...)
3. Objective.status → ANNULLATO (completedAt = now)
4. Chiudi eventuali sessioni ancora aperte → INTERROTTA
5. Project.currentObjectiveId → null, Project.currentObjective → null
6. Project.status → FERMO
7. Event: human_decision.created, objective.cancelled
```

## 7. Architettura implementativa

### Server

| Layer | File | Azione |
|-------|------|--------|
| **Dominio** | `domain/decision.ts` (nuovo) | `HumanDecision` interface, `DECISION_TYPES`, `DecisionType`, Zod schema |
| **Dominio** | `domain/checkpoint.ts` | Aggiungere `'DECIDED'` allo status, `decidedAt` e `decisionType` all'interfaccia |
| **Infra** | `infrastructure/db/schema.ts` | v4 → v5: tabella `human_decisions`, ALTER TABLE `checkpoints` |
| **Infra** | `infrastructure/db/decision-repo.ts` (nuovo) | `SqliteDecisionRepository` (create, listByObjective, listRecent) |
| **Infra** | `infrastructure/db/checkpoint-repo.ts` | Aggiungere `decide(id, type, decidedAt)`, aggiornare mapping |
| **Applicazione** | `application/decision-service.ts` (nuovo) | `DecisionService.decide()`: validazione, applicazione effetti, eventi |
| **API** | `api/routes.ts` | `POST /api/checkpoints/:id/decide`, `GET /api/decisions` |
| **Bootstrap** | `app.ts` | Iniettare `DecisionService` nei deps |

### Web Client

| Layer | File | Azione |
|-------|------|--------|
| **API** | `api/client.ts` | Tipo `HumanDecision`, `DecisionType`, metodo `decideCheckpoint()` |
| **Componenti** | `components/CheckpointList.tsx` | Pulsanti di azione su checkpoint `PENDING_DECISION` |
| **Componenti** | `components/DecisionForm.tsx` (nuovo) | Modale/form per confermare decisione con nota opzionale |
| **App** | `App.tsx` | Logica di chiamata API decisionale, aggiornamento stato |

## 8. API contratto

### POST /api/checkpoints/:id/decide

```jsonc
// Request
{
  "decision": "APPROVE" | "REQUEST_CHANGES" | "STOP" | "CANCEL",
  "note": "stringa opzionale (max 2000 caratteri)"
}

// Response 200
{
  "decision": { /* HumanDecision */ },
  "checkpoint": { /* Checkpoint aggiornato */ },
  "objective": { /* Objective aggiornato */ },
  "project": { /* Project aggiornato */ }
}

// Response 400 — checkpoint non trovato o non PENDING_DECISION
{ "message": "..." }
```

### GET /api/decisions

```jsonc
// Query: ?limit=N&objectiveId=xxx  (entrambi opzionali)
// Response 200
{
  "decisions": [ /* HumanDecision[] */ ]
}
```

## 9. Criteri di accettazione

| # | Criterio | Verificabile con |
|---|----------|-----------------|
| AC1 | APPROVE su checkpoint COMPLETED → objective COMPLETATO, project COMPLETATO | Test + API |
| AC2 | APPROVE su checkpoint NON-COMPLETED → errore 400 chiaro | Test |
| AC3 | REQUEST_CHANGES → objective resta RICHIEDE_ATTENZIONE, nessun auto-avvio | Test + API |
| AC4 | STOP/CANCEL → objective ANNULLATO, sessioni INTERROTTE, project FERMO | Test + API |
| AC5 | Il checkpoint passa da PENDING_DECISION a DECIDED dopo ogni decisione | Test + API |
| AC6 | La HumanDecision è persistita e recoverabile dopo riavvio | Test (buildApp × 2) |
| AC7 | La decisione è irreversibile: un checkpoint DECIDED non accetta nuove decisioni | Test |
| AC8 | Il contatore `pendingDecisions` in `/api/status` diminuisce dopo ogni decisione | Test |
| AC9 | Gli eventi `human_decision.created` vengono registrati nello State & Event Store | Test |
| AC10 | La sorgente HUMAN compare nelle evidenze del checkpoint deciso | Test + UI |
| AC11 | L'UI mostra pulsanti di azione sui checkpoint pendenti | Verifica manuale |
| AC12 | L'UI mostra lo storico decisioni | Verifica manuale |
| AC13 | Nessun avanzamento automatico: REQUEST_CHANGES non avvia sessioni | Test (invariante §14) |
| AC14 | La persistenza sopravvive al riavvio (decisioni + stato checkpoint) | Test (buildApp × 2) |

## 10. File da creare (nuovi)

| File | Scopo |
|------|-------|
| `server/src/domain/decision.ts` | Entità HumanDecision, tipi, Zod schema |
| `server/src/application/decision-service.ts` | DecisionService: decide(), effetti, validazione |
| `server/src/infrastructure/db/decision-repo.ts` | Repository SQLite per HumanDecision |
| `server/test/m5-decisions.test.ts` | Test di integrazione M5 |
| `web/src/components/DecisionForm.tsx` | Modale/form decisionale |

## 11. File da modificare

| File | Modifiche |
|------|-----------|
| `server/src/domain/checkpoint.ts` | Status union + `decidedAt`/`decisionType` in Checkpoint |
| `server/src/infrastructure/db/schema.ts` | v4→v5: DDL `human_decisions` + ALTER TABLE `checkpoints` |
| `server/src/infrastructure/db/checkpoint-repo.ts` | Metodi `decide()` + mapping aggiornato |
| `server/src/api/routes.ts` | Endpoint decisionali + aggiornamento ApiDeps |
| `server/src/app.ts` | Iniezione DecisionService |
| `web/src/api/client.ts` | Tipi + metodi API decisionali |
| `web/src/components/CheckpointList.tsx` | Pulsanti azione + callback |
| `web/src/App.tsx` | Logica decisionale + stato |

## 12. Ordine di implementazione

1. **Dominio**: `domain/decision.ts` (nuovo) → `domain/checkpoint.ts` (estendi status)
2. **Persistenza**: `schema.ts` (v5) → `decision-repo.ts` (nuovo) → `checkpoint-repo.ts` (estendi)
3. **Applicazione**: `decision-service.ts` (nuovo, con tutti gli effetti)
4. **API**: `routes.ts` (endpoint) → `app.ts` (iniezione)
5. **Test**: `m5-decisions.test.ts` — tutti i criteri AC1–AC10, AC13–AC14
6. **Web**: `client.ts` → `DecisionForm.tsx` → `CheckpointList.tsx` → `App.tsx`
7. **Verifica**: `npm test` server + build web + verifica manuale

## 13. Decisioni aperte — approvate

| # | Domanda | Scelta | Effetto deciso |
|---|---------|--------|----------------|
| D1 | **REQUEST_CHANGES: objective torna a IN_LAVORAZIONE o resta RICHIEDE_ATTENZIONE?** | **A** | Resta `RICHIEDE_ATTENZIONE`. Nessuna sessione parte automaticamente (§14-INV3). L'operatore avvia esplicitamente. |
| D2 | **STOP e CANCEL: stesso effetto?** | **B** | `STOP` interrompe la sessione/lavoro corrente ma **non annulla** l'obiettivo (resta `RICHIEDE_ATTENZIONE`). `CANCEL` porta l'obiettivo a `ANNULLATO` e il progetto a `FERMO`. Intenti e conseguenze distinti. |
| D3 | **La note nella decisione è obbligatoria?** | **A** | Note sempre opzionali. Coerenza con `stopSessionSchema` e `blockSessionSchema` esistenti. |
| D4 | **Un obiettivo COMPLETATO può avere una nuova sessione?** | **A** | `COMPLETATO` è terminale e non si riapre nella V1. Se il lavoro non è soddisfacente, l'operatore usa `REQUEST_CHANGES` o crea un nuovo Objective. |
| D5 | **Gestione Objective COMPLETATO da parte di cancel()?** | **A** (corretto) | Nessun nuovo endpoint DELETE. Riutilizza `cancel()`, ma `cancel()` deve **rifiutare** un obiettivo già `COMPLETATO` (errore esplicito). |

### Tabella transizioni di stato (decise)

| Decisione | Stato objective prima | Stato objective dopo | Stato project dopo |
|-----------|----------------------|---------------------|-------------------|
| APPROVE | qualunque non terminale | `COMPLETATO` | `COMPLETATO` |
| REQUEST_CHANGES | qualunque non terminale | `RICHIEDE_ATTENZIONE` | `RICHIEDE_ATTENZIONE` |
| STOP | qualunque non terminale | `RICHIEDE_ATTENZIONE` | `RICHIEDE_ATTENZIONE` |
| CANCEL | qualunque non terminale (≠ `COMPLETATO`) | `ANNULLATO` | `FERMO` |
| CANCEL | `COMPLETATO` | **ERRORE** (rifiutato) | — |

> **Nota su STOP vs REQUEST_CHANGES**: entrambe lasciano l'obiettivo in `RICHIEDE_ATTENZIONE`, ma il tipo semantico della decisione è diverso nel record `HumanDecision`. STOP = "ferma qui per ora"; REQUEST_CHANGES = "servono modifiche". Lo storico M6 può distinguerli.

## 14. Non incluso in M5

- Riapertura di obiettivi COMPLETATI (eventuale M6+)
- Notifiche push sulle decisioni pendenti (M8)
- Accesso mobile con touch ottimizzato (M7)
- Filtri avanzati sulle decisioni (storico per progetto, per tipo, per data)
- Rollback di una decisione (append-only per design)

## 15. Sorgenti di riferimento

| Riferimento | Sezione | Cosa si applica a M5 |
|-------------|---------|---------------------|
| Design doc | §5 Modello dati | HumanDecision entity, campos |
| Design doc | §6 Evidenze e checkpoint | Triangolo SYSTEM/AGENT/HUMAN, decidere senza log grezzo |
| Design doc | §12 M5 | "Approvazione, richiesta modifiche, stop e annullamento con decisioni persistite" |
| Design doc | §14 Invarianti | INV3 (nessun avanzamento automatico), INV4 (evidenze non confuse), INV7 (storico) |
| M4 checkpoint.ts | linee 14, 31 | "HUMAN compare solo con le decisioni di M5" |
| M4 checkpoint.ts | linee 84-85 | "la consumazione è M5" |
