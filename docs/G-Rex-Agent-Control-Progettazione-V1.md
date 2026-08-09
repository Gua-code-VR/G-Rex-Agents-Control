# G-Rex Agent Control

**Documento di progettazione --- V1**

Sorgente di verità iniziale del progetto · 9 agosto 2026

Scopo: governare più agenti di sviluppo contemporaneamente dal PC o dal
cellulare, riducendo al minimo il carico mentale dell'utente e
mantenendo un controllo umano esplicito tra un obiettivo e il
successivo.

## 1. Principio di prodotto

L'utente deve poter capire in pochi secondi cosa stanno facendo gli
agenti, sapere quando hanno bisogno di una decisione e intervenire con
il minimo input possibile. Agent Control non è un terminale remoto e non
è una replica di VS Code: è il piano di controllo degli agenti.

## 2. Confine funzionale della V1

-   registrazione e gestione di più progetti indipendenti;

-   dashboard multi-agente con stato operativo comprensibile;

-   obiettivo corrente e storico essenziale degli obiettivi;

-   avvio e controllo di sessioni Cline senza dipendere dalla UI di VS
    Code;

-   checkpoint finale e richieste di attenzione;

-   approvazione, richiesta modifiche, stop e annullamento;

-   assegnazione di nuovi obiettivi nel formato agent-driven;

-   stato Git iniziale/finale come evidenza e guardrail;

-   accesso mobile tramite rete VPN privata;

-   autenticazione applicativa;

-   persistenza locale e recupero dopo riavvio.

Fuori dalla V1: shell remota libera, orchestrazione automatica fra
agenti, avvio automatico della milestone successiva, AI aggiuntiva per
giudicare l'agente, esposizione pubblica su Internet.

## 3. Metodo operativo

L'unità di lavoro è l'Obiettivo, non la chat. Ogni obiettivo può
contenere obiettivo, invarianti, criteri di accettazione e condizione di
stop. L'agente sceglie autonomamente analisi, sequenza operativa e
strumenti. Quando raggiunge lo stop, Agent Control richiede una
decisione umana.

``` text
OBIETTIVO → LAVORO AUTONOMO → EVIDENZE → STOP → DECISIONE UMANA
```

L'approvazione chiude l'obiettivo ma non autorizza automaticamente
quello successivo.

## 4. Stati operativi

  Stato                 Significato
  --------------------- -----------------------------------------------------
  Fermo                 Nessun obiettivo attivo.
  In avvio              Obiettivo assegnato; sessione agente in partenza.
  In lavorazione        Agente attivo sull'obiettivo.
  Richiede attenzione   È necessaria una decisione umana.
  Bloccato              L'agente non può proseguire autonomamente.
  Completato            Obiettivo approvato e chiuso.
  Errore                Problema tecnico dell'agente o dell'infrastruttura.

## 5. Modello dati minimo

Entità principali: Project, Objective, AgentSession, HumanDecision,
Event, Checkpoint.

**Project: **id, name, repository_path, current_branch, current_head,
status, current_objective_id, created_at, updated_at

**Objective: **id, project_id, title, objective_text, invariants,
acceptance_criteria, stop_condition, status, started_at, completed_at,
final_report, git_start\_*, git_end\_*

**AgentSession: **id, objective_id, agent_type, started_at, ended_at,
status, last_activity_at, process_reference, exit_reason

**HumanDecision: **id, objective_id, type (APPROVE / REQUEST_CHANGES /
STOP / CANCEL), note, created_at

**Event: **id, project_id, objective_id, session_id, type, timestamp,
payload

**Checkpoint: **objective_id, outcome, summary, acceptance_status,
evidence_summary, git_delta, tests_summary, warnings,
recommended_action, full_report_reference

Lo stato ufficiale del Project deriva dall'Objective corrente. Agent
Control è proprietario dello stato operativo; l'agente esegue il lavoro
ma non possiede la memoria ufficiale del progetto.

## 6. Evidenze e checkpoint

Agent Control distingue sempre ciò che è verificato dal sistema da ciò
che è dichiarato dall'agente e da ciò che è deciso dall'utente.

-   SYSTEM --- evidenze deterministiche: exit code, test, branch, HEAD,
    dirty state, processo.

-   AGENT --- conclusioni e verifiche dichiarate dall'agente.

-   HUMAN --- approvazioni, richieste di modifica, stop e annullamenti.

Il checkpoint deve permettere di prendere una decisione senza leggere il
log grezzo: esito, sintesi, criteri, test, delta Git, avvertenze, azione
raccomandata e riferimento al rapporto completo.

## 7. Architettura funzionale

``` text
Mobile / Browser (PWA)
        │
   Tailscale / VPN
        │
G-Rex Agent Control
 ├─ Web App / API
 ├─ Project Registry
 ├─ Objective Manager
 ├─ Agent Manager
 ├─ State & Event Store
 ├─ Checkpoint Builder
 ├─ Notification Manager
 ├─ Git Monitor
 └─ Agent Adapter
        │
    Cline Adapter
        │
      Cline
        │
    Repository
```

Separazione fondamentale: il CONTROL PLANE contiene obiettivi, stati,
approvazioni, notifiche e storico; l'EXECUTION PLANE contiene Cline,
processi, repository, test, Graphify e Git.

## 8. Architettura tecnica proposta

  -----------------------------------------------------------------------
  Area                                Decisione V1
  ----------------------------------- -----------------------------------
  Runtime/backend                     Node.js + TypeScript; Fastify

  Frontend                            React + TypeScript + Vite; PWA
                                      responsive

  Persistenza                         SQLite locale

  Accesso DB                          Drizzle ORM o accesso SQLite
                                      tipizzato leggero

  Validazione                         Zod

  Aggiornamenti                       REST per comandi; Server-Sent
                                      Events per eventi significativi

  Integrazione agenti                 AgentAdapter astratto +
                                      ClineAdapter

  Accesso remoto                      Tailscale/WireGuard; nessun port
                                      forwarding pubblico

  Autenticazione                      Utente amministratore singolo,
                                      password con hash forte, cookie
                                      HttpOnly, sessione con scadenza

  Esecuzione Windows                  Headless; in produzione avvio
                                      automatico/servizio Windows
  -----------------------------------------------------------------------

## 9. Esperienza mobile

La Home è ordinata per necessità di intervento, non alfabeticamente:
richieste di attenzione, problemi, agenti in lavorazione, progetti
fermi/completati. La schermata principale deve mostrare solo
informazioni operative e azioni essenziali.

-   Home --- riepilogo progetti e numero di decisioni richieste.

-   Scheda progetto --- stato, obiettivo, ultima attività, Git
    essenziale, stop controllato.

-   Checkpoint --- approva, richiedi modifiche, rapporto completo.

-   Nuovo obiettivo --- titolo, obiettivo, invarianti, criteri, stop;
    struttura standard precompilabile.

-   Storico --- obiettivi, sessioni, checkpoint, decisioni e stato Git.

-   Dettagli tecnici --- eventi, processo e log, disponibili ma non
    invasivi.

-   Impostazioni --- connessione, sicurezza, notifiche, agenti e
    progetti.

## 10. Sicurezza e controllo remoto

Percorso previsto: Telefono → Tailscale/WireGuard → PC Windows → Agent
Control → Cline → Repository. Il pannello non deve essere esposto
direttamente a Internet. La VPN non sostituisce l'autenticazione
applicativa. RustDesk rimane uno strumento di emergenza, non parte del
flusso ordinario.

Nella V1 non è disponibile una shell remota libera. Le azioni dal
telefono sono comandi di alto livello sugli obiettivi e sulle sessioni.

## 11. Robustezza

-   Heartbeat/last_activity_at per distinguere lavoro lungo da sessione
    congelata.

-   Stato STALE prima di dichiarare un errore definitivo.

-   Dopo un riavvio, un Objective RUNNING senza processo corrispondente
    diventa INTERRUPTED e richiede attenzione.

-   Separazione tra errore agente, errore Agent Control e problema di
    connettività.

-   Log separati in eventi utente, eventi tecnici e log grezzo agente.

-   Backup di database, configurazione e report; i repository restano
    affidati a Git.

## 12. Milestone V1

**M1 --- Fondazione operativa** Agent Control avviabile localmente,
dashboard disponibile, persistenza minima e riavvio senza perdita dello
stato.

**M2 --- Registro progetti e stato** Gestione affidabile di più progetti
indipendenti e stato Git essenziale.

**M3 --- Obiettivi e sessioni agente** Ciclo obiettivo → sessione Cline
→ stato operativo, senza dipendere dalla UI di VS Code.

**M4 --- Checkpoint e attenzione umana** Fine/blocco dell'agente
trasformati in checkpoint comprensibile e richiesta di decisione.

**M5 --- Approvazione e prosecuzione** Approvazione, richiesta
modifiche, stop e annullamento con decisioni persistite; nessun
avanzamento automatico.

**M6 --- Storico e tracciabilità** Ricostruzione persistente di
obiettivi, sessioni, decisioni, checkpoint e stato Git.

**M7 --- Mobile remoto sicuro** Uso reale da smartphone via Tailscale
con autenticazione e PWA, senza necessità ordinaria di RustDesk.

**M8 --- Notifiche e robustezza** Notifiche utili, rilevazione sessioni
stale/interrotte e recupero da interruzioni realistiche.

## 13. Requisiti di uscita V1

La V1 è conclusa quando dal telefono è possibile vedere tutti i
progetti, sapere quali agenti stanno lavorando, intervenire solo quando
serve, leggere un checkpoint, approvare o richiedere modifiche,
assegnare un nuovo obiettivo, fermare un agente e ricostruire lo storico
senza aprire VS Code.

## 14. Invarianti di progetto

-   Agent Control non deve diventare dipendente dalla UI di Cline o di
    VS Code.

-   Il modello operativo deve restare agent-agnostic tramite adapter.

-   Nessun obiettivo successivo parte senza autorizzazione umana nella
    V1.

-   Le evidenze dichiarate dall'agente non vengono presentate come
    verificate dal sistema.

-   Nessuna porta del pannello viene esposta direttamente a Internet.

-   La complessità tecnica non deve riversarsi sulla dashboard
    ordinaria.

-   Lo storico ufficiale appartiene ad Agent Control, non alla singola
    sessione agente.

-   Le milestone descrivono capacità e risultati verificabili, non
    sequenze prescrittive di implementazione.

## 15. Prossimo passo

Creare il repository autonomo G-Rex Agent Control, salvare questo
documento come sorgente di verità iniziale e affidare a un agente
esclusivamente M1 --- Fondazione operativa, definendo obiettivo,
invarianti, criteri di accettazione, evidenze richieste e condizione di
stop. L'agente mantiene autonomia su analisi e sequenza operativa.
