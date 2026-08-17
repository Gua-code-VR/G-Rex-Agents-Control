# G-Rex Agent Control

**Documento di progettazione --- V2**\
**Sorgente di verità corrente del prodotto · 16 agosto 2026**

## 0. Autorità e gerarchia documentale

Questo documento è la **sorgente di verità corrente per il comportamento
di prodotto di G-Rex Agent Control**.

I documenti di milestone e di progettazione tecnica (M1...M18, Execution
Plane Design e successivi) descrivono l'evoluzione e i dettagli
implementativi, ma **non prevalgono su questo documento** quando
contengono regole di prodotto superate.

In caso di conflitto: 1. prevalgono le invarianti e il modello operativo
definiti in questo documento; 2. le specifiche tecniche correnti devono
essere interpretate in modo compatibile con queste invarianti; 3. i
documenti di milestone precedenti restano storico progettuale e non
devono reintrodurre comportamenti successivamente superati.

In particolare è **superato** il vecchio paradigma secondo cui ogni
esito terminale, incluso un completamento riuscito, deve generare un
checkpoint pendente e una decisione umana.

------------------------------------------------------------------------

## 1. Scopo e principio di prodotto

G-Rex Agent Control governa più agenti di sviluppo dal PC o dallo
smartphone, riducendo al minimo il carico mentale dell'utente.

Agent Control non è un terminale remoto, non è una replica di VS Code e
non è un visualizzatore di log. È il **piano di controllo operativo
degli agenti**.

Principio autoritativo:

> **Normalità = silenzio. Eccezione = evidenza.**

L'utente deve poter capire in pochi secondi: - cosa sta lavorando; - su
quale progetto e obiettivo; - cosa è terminato; - se esiste davvero
qualcosa che richiede il suo intervento.

Tutto ciò che non aiuta una decisione operativa immediata deve essere
secondario, collassato oppure spostato in Audit/Diagnostica.

Un elemento con forte evidenza visiva deve significare:

> **Questa cosa merita la tua attenzione adesso.**

------------------------------------------------------------------------

### 1.1 Stato corrente ≠ storico

La separazione tra **stato operativo corrente** e **storico** è un principio trasversale e autoritativo del prodotto.

KPI, badge, contatori, sezioni di attenzione, readiness e viste operative devono derivare esclusivamente da condizioni **attualmente aperte, reali e pertinenti all’azione presente**.

Sessioni terminate, errori risolti, recovery conclusi, obiettivi completati/cancellati/interrotti, checkpoint chiusi e decisioni già prese appartengono allo storico. Restano persistiti e auditabili, ma **non devono contaminare lo stato operativo corrente**.

In particolare:

- `Richiede te` rappresenta solo azioni umane pendenti adesso;
- `Errori` rappresenta solo problemi correnti irrisolti;
- conteggi di lavoro attivo rappresentano solo esecuzioni realmente attive o in coda secondo la semantica corrente;
- elementi terminali o risolti non restano evidenziati come anomalie;
- la normalità non viene rappresentata mediante card, KPI o messaggi di assenza del problema.

La regola vale in modo uniforme per Control Room, Progetti, Obiettivi, Esecuzioni, Governance, Sistema e client mobile.

------------------------------------------------------------------------

## 2. Modello mentale fondamentale

### 2.1 Progetto

Il **Project** è un contenitore permanente associato a un repository.

Il repository viene configurato una volta e resta associato al progetto.
Non deve essere richiesto nuovamente a ogni obiettivo.

Un progetto può contenere nel tempo molti obiettivi. La conclusione di
un obiettivo non implica la creazione di un nuovo progetto.

### 2.2 Obiettivo

L'**Objective** è l'unità di lavoro.

Descrive cosa deve essere ottenuto. Può includere testo, invarianti,
criteri di accettazione e condizioni particolari, ma Agent Control deve
consentire anche il normale utilizzo con il solo testo dell'obiettivo.

Il limite applicativo di `objectiveText` è **50.000 caratteri**.
Frontend, API, validazione, persistenza e messaggi UI devono applicare
lo stesso limite. Nessun troncamento silenzioso.

### 2.3 Sessione agente

Una **AgentSession** rappresenta un ciclo di esecuzione dell'obiettivo.

Uno stesso obiettivo può avere più sessioni nel tempo, ad esempio dopo
un riavvio.

### 2.4 Tentativo di esecuzione

Un **ExecutionAttempt** è il singolo tentativo concreto eseguito da un
runtime con uno specifico provider/modello.

Retry e fallback producono tentativi distinti e preservano lo storico.

### 2.5 Workspace Git isolata

Una **ExecutionWorkspace** è la working directory Git isolata assegnata al lavoro di un Objective quando l'esecuzione può interferire con altre esecuzioni sullo stesso repository.

Nel caso ordinario di repository Git, la workspace è realizzata tramite **Git worktree + branch dedicato**. Objective differenti che possono lavorare in parallelo sullo stesso Project non condividono la stessa working tree. Retry e fallback appartenenti alla stessa esecuzione riutilizzano invece la stessa workspace, così da preservare il lavoro già prodotto.

La workspace è infrastruttura dell'esecuzione: non cambia l'identità del Project o dell'Objective e non richiede modifiche al modello del runtime. Cline, Codex e gli altri runtime ricevono semplicemente il percorso isolato come `projectPath`/`cwd`.

### 2.6 Relazione

``` text
PROJECT / REPOSITORY
  └── OBJECTIVE 1
       └── WORKTREE / BRANCH dedicato
            ├── AgentSession 1
            │    ├── Attempt 1
            │    └── Attempt 2 (retry/fallback, stesso worktree)
            └── AgentSession 2 (eventuale Riavvia secondo policy workspace)
  └── OBJECTIVE 2
       └── WORKTREE / BRANCH differente
  └── ...
```

------------------------------------------------------------------------

## 3. Metodo operativo

Il paradigma operativo è:

``` text
OBIETTIVO
   ↓
SELEZIONE AUTOMATICA
   ↓
LAVORO AUTONOMO
   ↓
RECOVERY AUTOMATICO SE NECESSARIO
   ↓
┌───────────────────────────┬─────────────────────────────┐
│ SUCCESSO                  │ IMPOSSIBILE PROSEGUIRE     │
│ completamento automatico  │ intervento umano se serve  │
└───────────────────────────┴─────────────────────────────┘
```

L'agente sceglie autonomamente analisi, sequenza operativa e strumenti
entro i vincoli autorizzati.

**L'intervento umano non è una fase obbligatoria del lifecycle. È
un'eccezione.**

Il completamento tecnico riuscito conclude automaticamente l'obiettivo.
Non esiste approvazione umana ordinaria del lavoro riuscito.

L'autorizzazione umana resta necessaria quando esiste una vera decisione
non delegabile: budget, conflitto, scelta ambigua, impossibilità di
recovery o altra condizione esplicitamente governata.

------------------------------------------------------------------------

## 4. Lifecycle autorevole

### 4.1 Obiettivo riuscito

Quando il lavoro riesce:

1.  l'ExecutionAttempt termina `COMPLETED`;
2.  la AgentSession termina `COMPLETATA`;
3.  l'Objective passa automaticamente a `COMPLETATO`;
4.  viene persistito il report finale;
5.  il risultato compare in **Risultati recenti**;
6.  non viene creato un checkpoint `PENDING_DECISION` solo perché il
    lavoro è terminato;
7.  non viene generata una voce in **Richiede te**;
8.  il Project viene ricalcolato in base agli altri obiettivi reali.

### 4.2 Stato del progetto

Lo stato del Project è **derivato** dallo stato reale dei suoi
obiettivi/sessioni, non impostato manualmente dalla UI.

Un progetto senza lavoro attivo è disponibile per un nuovo obiettivo
(`FERMO` o equivalente operativo).

Il completamento di un obiettivo non deve rendere inutilizzabile il
progetto né obbligare a ricrearlo.

Se esistono altri obiettivi non terminali, lo stato progetto deve
rifletterli.

### 4.3 Errore recuperabile

Un errore recuperabile viene gestito automaticamente mediante
retry/fallback/restart secondo policy.

Finché il sistema può proseguire autonomamente: - l'obiettivo non
diventa una richiesta umana; - `Richiede te` non viene alimentato; -
l'errore non deve diventare rumore permanente nella Control Room; -
tentativi, errori e recovery restano tracciati in Audit.

### 4.4 Errore terminale

Solo quando Agent Control non può proseguire automaticamente e serve
realmente una scelta dell'utente, la situazione diventa **actionable** e
può entrare in `Richiede te`.

### 4.5 STALE

`STALE` è una condizione tecnica da tentare di recuperare
automaticamente.

Se il processo è morto o non risponde: - finalizzare correttamente il
tentativo; - classificare l'errore; - applicare retry/fallback se
ammesso; - non creare un checkpoint pendente durante un recovery
automatico.

Solo quando il recovery è esaurito o impossibile, lo stato può diventare
terminale e richiedere l'utente.

------------------------------------------------------------------------

## 5. Richiede te

### 5.1 Definizione

**`Richiede te` non è un centro notifiche.**

Un elemento può comparire in `Richiede te` esclusivamente quando esiste
**adesso** un'azione o decisione che deve compiere l'utente.

Esempi: - approvazione budget realmente necessaria; - errore terminale
non recuperabile automaticamente; - conflitto che richiede una scelta; -
agente bloccato senza recovery automatico possibile; - altra decisione
esplicitamente umana.

Non devono comparire: - obiettivi completati; - sessioni completate; -
"Obiettivo completato"; - notifiche informative; - retry; - fallback; -
recovery riusciti; - errori già risolti; - heartbeat; - eventi
tecnici; - semplici elementi non letti.

### 5.2 Unread non significa actionable

`unread` e `requiresHumanAction` sono concetti distinti.

Una notifica informativa non letta **non può** alimentare `Richiede te`
solo perché non è stata letta.

### 5.3 Se non serve l'utente

Se non esiste alcuna azione umana pendente: - l'intera sezione
`Richiede te` è assente dalla Control Room; - non mostrare
`Richiede te = 0`; - non mostrare card vuote; - non mostrare "Nessun
intervento richiesto".

Il conteggio, quando presente, deve corrispondere esattamente al numero
di azioni umane realmente pendenti.

------------------------------------------------------------------------

## 6. Notifiche

Le notifiche sono semanticamente separate dalle richieste umane.

Una notifica può essere: - **informativa**; - **actionable**.

Solo una notifica actionable e ancora pendente può contribuire a
`Richiede te`.

Le notifiche informative possono essere consultabili o marcabili come
lette, ma non devono alterare KPI o viste dedicate all'intervento umano.

------------------------------------------------------------------------

## 7. Errori, recovery e KPI

### 7.1 Significato di Errore

Nella Control Room, **Errore significa problema corrente e ancora
irrisolto**.

Non significa "numero di errori avvenuti nella storia".

Errori recuperati, risolti o appartenenti a esecuzioni terminate: - non
contribuiscono al KPI `Errori`; - non restano evidenziati nella Control
Room; - restano disponibili in Audit/Diagnostica.

### 7.2 KPI condizionali

Le card/KPI di eccezione vengono renderizzate soltanto quando esiste
l'eccezione.

Esempi: - `Errori = 0` → card assente; - `Richiede te = 0` →
card/sezione assente; - nessun blocco → nessuna card di blocco; - nessun
problema → nessuna card che dica che non ci sono problemi.

Il layout deve ricomporsi automaticamente.

Non utilizzare spazio per comunicare l'assenza di anomalie.

------------------------------------------------------------------------

## 8. Destinazione delle informazioni

  ----------------------------------------------------------------------------
  Informazione       Destinazione            Richiede te?               Audit?
                     primaria                             
  ------------------ --------------- -------------------- --------------------
  Lavoro attualmente Lavoro in corso                   No                   Sì
  in esecuzione      / Esecuzioni                         

  Obiettivo          Risultati                     **No**                   Sì
  completato         recenti                              

  Notifica           Notifiche, se                 **No**      Sì se rilevante
  informativa        utile                                

  Retry/fallback     normalmente non               **No**                   Sì
  automatico         in evidenza                          

  Recovery riuscito  nessuna                       **No**                   Sì
                     evidenza                             
                     persistente                          
                     operativa                            

  Errore corrente    stato operativo               **No**                   Sì
  recuperabile       solo se utile                        
                     durante il                           
                     recovery                             

  Errore terminale   Control Room                  **Sì**                   Sì
  che richiede                                            
  scelta                                                  

  Approvazione       Control Room                  **Sì**                   Sì
  budget pendente                                         

  Heartbeat/evento   nessuna vista                 **No**                   Sì
  tecnico            operativa                            

  Errore storico     nessuna vista                 **No**                   Sì
  risolto            operativa                            
  ----------------------------------------------------------------------------

Una stessa informazione non deve essere duplicata in più sezioni con
significati incompatibili.

------------------------------------------------------------------------

## 9. Control Room

La Control Room rappresenta **il presente operativo**.

Deve privilegiare: - lavoro corrente; - progetti; - risultati recenti
compatti; - eventuali azioni realmente necessarie.

Non è un archivio storico.

### 9.1 Risultati recenti

I risultati recenti sono visibili in forma compatta.

Ogni risultato è **collassato di default** e mostra solo: - progetto; -
obiettivo; - stato; - breve sintesi utile.

Il report completo è visibile solo su espansione.

### 9.2 Attività recente

`Attività recente` è **collassata di default**.

Eventi tecnici come `project.read`, `projects.listed`,
`execution.attempt.progress`, heartbeat e simili non devono dominare la
Control Room.

I dettagli completi appartengono ad Audit.

### 9.3 Dettaglio obiettivo completato

Nel dettaglio di un obiettivo completato: - `Report finale` è collassato
di default; - `Sessioni agente` è collassato di default.

Le informazioni essenziali restano immediatamente visibili.

------------------------------------------------------------------------

## 10. Audit e Diagnostica

Audit/Diagnostica conserva la verità storica e tecnica: - eventi; -
heartbeat; - retry; - fallback; - errori storici; - recovery; -
attempt; - runtime/provider/modello; - costi; - decisioni; - stato
Git; - dettagli tecnici; - workspace/worktree/branch e operazioni di integrazione Git.

La rimozione di un'informazione dalla Control Room **non significa
cancellazione dello storico**.

Lo storico ufficiale appartiene ad Agent Control, non alla singola
sessione agente.

------------------------------------------------------------------------

## 11. Creazione progetto e riuso

### 11.1 Progetto senza obiettivo iniziale

Flusso:

``` text
Crea progetto
→ associa repository
→ salva progetto
→ seleziona/apre il progetto appena creato
→ porta direttamente a Nuovo obiettivo
```

Il progetto resta `FERMO` finché non viene creato/avviato un obiettivo.

### 11.2 Progetto con obiettivo iniziale

Flusso:

``` text
Crea progetto
→ associa repository
→ crea Objective reale
→ selezione automatica runtime/provider/modello
→ avvio automatico
```

Non richiedere una conferma ordinaria della selezione automatica.

Se l'avvio automatico non è possibile per una vera condizione governata,
il sistema deve rappresentare correttamente il motivo e richiedere
l'utente solo se necessario.

### 11.3 Nuovo obiettivo su progetto esistente

Il normale flusso deve essere:

``` text
Progetti
→ progetto
→ + Nuovo obiettivo
→ scrivi cosa vuoi ottenere
→ Avvia
```

Non richiedere nuovamente: - repository; - provider; - modello; - altre
configurazioni tecniche già note.

------------------------------------------------------------------------

## 12. Routing runtime/provider/modello

Il routing automatico è il comportamento ordinario.

La scelta deve rispettare le specifiche tecniche correnti: - catalogo
reale delle combinazioni disponibili; - capacità richieste; - finestra
di contesto; - costo stimato; - budget residuo; - affidabilità
storica; - apprendimento dalle esecuzioni precedenti.

Una selezione esplicita, quando supportata e realmente richiesta,
prevale sul routing automatico ma deve essere validata dal catalogo.

A ogni retry/fallback il provider/modello può essere ri-selezionato
secondo la policy corrente.

La scelta effettiva deve essere persistita nell'ExecutionAttempt ed
essere auditabile.

Le configurazioni di provider dismesse o escluse dal prodotto non devono
essere reintrodotte da documentazione storica.

------------------------------------------------------------------------

## 13. Riavvia e Cancella

Un obiettivo non completato deve offrire, quando pertinente, due azioni
semplici.

### 13.1 Riavvia

`Riavvia`: - mantiene Project e repository; - mantiene l'identità/intent
dell'obiettivo; - preserva lo storico precedente; - crea una nuova
AgentSession/esecuzione; - effettua una nuova selezione automatica
runtime/provider/modello; - non eredita come stato operativo corrente il
vecchio errore.

### 13.2 Cancella

`Cancella`: - chiude definitivamente l'obiettivo; - lo rimuove dalle
viste operative; - preserva la tracciabilità storica in Audit; - libera
il progetto per un nuovo obiettivo quando non esiste altro lavoro
attivo.

Gli obiettivi completati non mostrano queste azioni se non hanno
significato.

------------------------------------------------------------------------

## 14. Stati e sorgente autorevole

Stati, badge e conteggi devono derivare da una **semantica unica e
autorevole**.

Frontend e backend non devono applicare interpretazioni incompatibili.

In particolare: - niente override manuale dello stato Project; - Project
derivato dagli Objective/sessioni reali; - `Richiede te` derivato da
azioni umane pendenti, non dallo storico notifiche; - `Errori` derivato
da problemi correnti irrisolti, non dal totale storico; - risultati
derivati da Objective completati; - sessioni/attempt conservano i propri
stati tecnici senza contaminare impropriamente lo stato di prodotto.

Le incoerenze devono essere corrette **alla fonte**, non nascoste con
filtri cosmetici frontend.

------------------------------------------------------------------------

## 15. Bootstrap e autenticazione

Durante bootstrap/session restore l'interfaccia deve distinguere:

-   stato di inizializzazione → loading/stato neutro;
-   autenticazione realmente necessaria → login;
-   errore di rete reale e persistente → errore di connessione.

Non deve comparire il flash temporaneo **"Errore di connessione /
Autenticazione richiesta"** dopo un'autenticazione riuscita.

Uno stato transitorio di bootstrap non è un errore.

------------------------------------------------------------------------

## 16. Desktop e smartphone

Desktop e smartphone sono **client operativi dello stesso sistema**.

Lo smartphone non è una vista read-only.

Da smartphone deve essere possibile almeno: - vedere progetti e stato
corrente; - aprire un progetto; - creare un nuovo obiettivo; - scrivere
il testo e avviarlo; - vedere il lavoro in corso; - vedere solo le vere
richieste umane; - aprire i risultati; - Riavviare o Cancellare un
obiettivo non completato; - fermare un'esecuzione quando previsto.

Il flusso normale da progetto esistente deve restare:

``` text
Progetto → Nuovo obiettivo → testo → Avvia
```

Su mobile la riduzione del rumore è ancora più importante: log, storico
e sezioni secondarie non devono obbligare a scorrere per raggiungere le
azioni operative.

Accesso remoto previsto tramite rete privata (Tailscale/WireGuard) e
autenticazione applicativa. Nessuna esposizione pubblica diretta del
pannello.

------------------------------------------------------------------------

## 17. Evidenze e decisioni umane

Agent Control distingue: - **SYSTEM** --- evidenze deterministiche; -
**AGENT** --- conclusioni dichiarate dall'agente; - **HUMAN** --- vere
decisioni dell'utente.

Le decisioni umane restano persistenti e auditabili, ma **non
costituiscono una fase obbligatoria dopo ogni completamento**.

Checkpoint e HumanDecision continuano a essere strumenti validi per
condizioni che richiedono davvero una decisione, non per trasformare
ogni esito in un'approvazione.

------------------------------------------------------------------------

## 18. Execution Plane

Separazione fondamentale:

``` text
CONTROL PLANE
- Project
- Objective
- AgentSession
- stato di prodotto
- governance
- vere decisioni umane
- notifiche
- storico ufficiale

PROCESS SUPERVISOR
- orchestrazione
- ExecutionAttempt
- retry/fallback
- normalizzazione esiti

EXECUTION PLANE
- runtime concreti
- processi
- provider/modelli
- repository
- test
- Git
```

Un runtime non modifica direttamente lo stato ufficiale di
Objective/Project.

Retry e fallback preservano lo storico e non creano nuovi Objective.

Il percorso di lavoro passato al runtime può essere una workspace Git isolata. L'Execution Plane non deve assumere che il runtime lavori direttamente nella working tree principale del Project.

------------------------------------------------------------------------

## 19. Parallelismo e workspace Git

Il parallelismo sullo stesso repository deve essere ottenuto tramite **isolamento delle working directory**, non facendo lavorare più agenti contemporaneamente sulla working tree principale.

### 19.1 Regola di isolamento

Per ogni Objective/esecuzione parallela Agent Control crea e gestisce una workspace Git isolata, normalmente composta da:

-   un Git worktree dedicato;
-   un branch dedicato e identificabile;
-   un percorso persistito e auditabile associato al lavoro.

Objective differenti sullo stesso Project ricevono worktree differenti. Gli agenti non devono lavorare contemporaneamente direttamente sulla `main` o sulla working tree principale del repository.

### 19.2 Retry, fallback e continuità del lavoro

Retry e fallback della stessa esecuzione devono riutilizzare lo stesso worktree. Il cambio di runtime/provider/modello non deve perdere o ricreare inutilmente le modifiche già prodotte dall'esecuzione precedente.

Il `ProcessSupervisor` continua a essere responsabile di attempt, processi, retry, fallback, costi ed eventi. La gestione del lifecycle della workspace Git appartiene a un servizio separato (ad esempio `WorktreeManager`) e **non richiede la riscrittura dell'Execution Plane**.

### 19.3 Repository principale con modifiche locali

Prima di creare o integrare una workspace Agent Control deve verificare lo stato Git rilevante. Modifiche locali non committate nella working tree principale non devono essere ignorate, sovrascritte, incluse implicitamente o nascoste.

Se tali modifiche rendono insicura o ambigua la creazione della workspace o la successiva integrazione, Agent Control si ferma e crea una vera richiesta in `Richiede te`, spiegando in modo comprensibile cosa impedisce di procedere.

### 19.4 Verifica e integrazione finale

Il completamento dichiarato dall'agente non implica l'integrazione cieca delle modifiche. Agent Control verifica il risultato secondo le capacità disponibili e integra il lavoro nel repository di destinazione in modo controllato.

L'integrazione automatica può procedere soltanto quando è deterministica e sicura. Un conflitto Git reale, una destinazione incompatibile o un'altra scelta non delegabile entra in `Richiede te`. Un conflitto non deve essere risolto arbitrariamente cancellando modifiche dell'utente o di un altro Objective.

Il completamento dell'Objective deve distinguere il lavoro tecnico prodotto dalla sua integrazione: l'Objective è considerato riuscito secondo la policy corrente solo quando le condizioni di verifica e integrazione previste risultano soddisfatte.

### 19.5 Lifecycle e pulizia

Worktree e branch sono risorse gestite da Agent Control. La loro creazione, associazione, riuso, integrazione e rimozione devono essere tracciabili. La pulizia non deve eliminare una workspace che contiene lavoro non integrato o necessario a recovery, retry, fallback, Audit o decisione umana.

Dopo crash o riavvio del Control Plane, lo stato persistito delle workspace deve essere riconciliato con i worktree e i branch realmente presenti prima di avviare nuovo lavoro concorrente.

------------------------------------------------------------------------

## 20. Robustezza

-   heartbeat/`last_activity_at` distingue lavoro lungo da processo
    congelato;
-   STALE attiva prima il recovery automatico;
-   gli errori sono classificati;
-   retry/fallback sono applicati quando consentiti;
-   un errore diventa richiesta umana solo quando serve realmente;
-   dopo riavvio, lo stato persistito deve essere riconciliato con i
    processi reali;
-   log utente, eventi tecnici e log grezzo restano separati;
-   database/configurazione/report sono sottoposti a backup; i
    repository restano affidati a Git.

------------------------------------------------------------------------

## 21. Pricing e costi

Il catalogo prezzi è separato dalla logica di routing.

**G-Rex Pricing è la fonte unica dei listini.** Agent Control non mantiene un secondo listino manuale e non hardcoda prezzi dei provider/modelli. Consuma l'archivio prodotto/aggiornato da G-Rex Pricing e ne estrae soltanto i provider e modelli realmente configurati e utilizzabili dal sistema.

Agent Control utilizza il prezzo applicabile al momento dell'esecuzione e deve poter rappresentare le strutture tariffarie presenti nella fonte, comprese eventuali fasce orarie, cache e scaglioni dipendenti dalla dimensione della singola richiesta.

Il consumo reale deve essere ricavato, quando disponibile, dagli eventi `usage` del runtime/provider e persistito con granularità sufficiente a ricostruire correttamente il costo. Per listini a scaglioni non è sufficiente il solo totale dell'intero attempt: deve restare disponibile il consumo della singola chiamata/iterazione necessario ad applicare la tariffa corretta.

Quando il runtime restituisce un costo monetario assente, nullo o non attendibile, Agent Control calcola il consuntivo dai token reali usando il listino fornito da G-Rex Pricing. Il costo effettivo misurato/calcolato resta distinto dal listino e alimenta l'apprendimento.

La UI ordinaria mostra un riepilogo comprensibile del consumo e del costo; il dettaglio tecnico per chiamata/iterazione resta in Audit/Diagnostica. Costi e KPI devono derivare da dati reali e correnti, senza duplicazioni o stime presentate come consuntivi.

------------------------------------------------------------------------

## 22. Invarianti di progetto

1.  Agent Control non dipende dalla UI di Cline o VS Code.
2.  Il modello operativo resta agent-agnostic tramite adapter.
3.  Il Project è permanente e conserva l'associazione al repository.
4.  L'Objective è l'unità di lavoro.
5.  Un completamento riuscito chiude automaticamente l'Objective.
6.  Un completamento riuscito **non richiede approvazione umana
    ordinaria**.
7.  `Richiede te` contiene esclusivamente azioni umane realmente
    pendenti.
8.  `unread` non implica `requiresHumanAction`.
9.  Recovery automatico precede l'escalation umana.
10. Errori storici/risolti non contaminano KPI operativi.
11. KPI di eccezione con valore zero non occupano la Control Room.
12. Lo stato Project è derivato, non impostato manualmente.
13. Lo storico tecnico appartiene ad Audit, non alla vista operativa.
14. La complessità tecnica non si riversa sulla dashboard ordinaria.
15. Il sistema non richiede nuovamente dati/configurazioni che già
    conosce.
16. Desktop e mobile offrono lo stesso ciclo operativo essenziale.
17. Riavvia preserva lo storico e crea una nuova esecuzione.
18. Cancella chiude il lavoro operativo ma non cancella la
    tracciabilità.
19. Le evidenze AGENT non vengono presentate come SYSTEM.
20. Nessuna porta del pannello è esposta direttamente a Internet.
21. Le selezioni runtime/provider/modello effettive sono auditabili.
22. Nessuna correzione UX deve falsificare lo stato reale nascondendo
    incoerenze di backend.
23. Stato corrente e storico sono semanticamente separati: elementi terminali, risolti o chiusi non contaminano KPI e viste operative.
24. G-Rex Pricing è la fonte unica dei listini; Agent Control ne è un consumatore selettivo e non hardcoda prezzi.
25. Objective paralleli sullo stesso repository lavorano in worktree Git isolati e branch dedicati.
26. Retry e fallback della stessa esecuzione preservano e riutilizzano la stessa workspace.
27. Gli agenti concorrenti non lavorano direttamente sulla `main`/working tree principale.
28. Modifiche locali o conflitti che rendono insicura l'operazione non vengono ignorati: quando richiedono una scelta reale entrano in `Richiede te`.
29. La gestione worktree resta separata dal `ProcessSupervisor` e non altera le responsabilità fondamentali dell'Execution Plane.
30. Normalità = silenzio; eccezione = evidenza.

------------------------------------------------------------------------

## 23. Matrice comportamentale autoritativa

  -----------------------------------------------------------------------------------------------
  Evento/condizione   Automazione       Control Room       Richiede te Risultati    Audit
  ------------------- ----------------- ------------------ ----------- ------------ -------------
  Sistema sano,       nessuna           vista tranquilla   assente     eventuali    disponibile
  nessun lavoro                                                        recenti      
                                                                       compatti     

  Objective in        continua          lavoro in corso    no          no           sì
  esecuzione                                                                        

  Objective           completa          risultato compatto **no**      **sì**       sì
  completato          automaticamente                                               

  Notifica            nessuna           normalmente no     **no**      se           sì
  informativa non                                                      pertinente   
  letta                                                                             

  Errore recuperabile retry/fallback    solo stato utile   **no**      no           sì
                                        corrente                                    

  Recovery riuscito   continua          anomalia scompare  **no**      no           sì

  STALE recuperabile  recovery          solo se utile      **no**      no           sì

  Errore terminale    chiusura coerente problema corrente  solo se     no           sì
  senza scelta                                             serve                    
  possibile                                                azione                   

  Errore terminale    attende           evidenziato        **sì**      no           sì
  con scelta umana                                                                  

  Budget da           attende           evidenziato        **sì**      no           sì
  autorizzare                                                                       

  Errore storico      nessuna           **no**             **no**      no           sì
  risolto                                                                           

  Heartbeat/evento    automatico        **no**             **no**      no           sì
  tecnico                                                                           

  Objective non       attende azione    Riavvia/Cancella   solo se la  no           sì
  completato                                               causa                    
                                                           richiede                 
                                                           scelta                   

  Objective paralleli crea/riusa        lavoro isolato     **no**      no           sì
  stesso repository   worktree distinti in workspace Git                            

  Dirty state         non procede se    problema corrente  **sì** se   no           sì
  incompatibile       operazione non                        serve                    
                      sicura                                scelta                   

  Conflitto reale     sospende          integrazione       **sì**      no           sì
  in integrazione     integrazione      bloccata                                     
  -----------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## 24. Requisiti di verifica permanenti

Le modifiche che toccano lifecycle o Control Room devono proteggere
almeno queste invarianti con test:

-   un completamento riuscito non entra in `Richiede te`;
-   una notifica informativa non entra in `Richiede te`;
-   `unread` da solo non implica intervento umano;
-   recovery automatico non crea richiesta umana;
-   errore recuperato non conta come errore corrente;
-   errore storico non compare nei KPI operativi;
-   con zero richieste `Richiede te` non viene renderizzato;
-   con zero errori il KPI Errori non viene renderizzato;
-   Project mantiene il repository tra un Objective e il successivo;
-   progetto senza obiettivo iniziale porta a Nuovo obiettivo;
-   progetto con obiettivo iniziale crea e avvia l'Objective;
-   Objective completato produce un risultato, non un'approvazione;
-   Riavvia preserva storico e crea nuova esecuzione;
-   Cancella preserva Audit;
-   bootstrap non produce falsi errori;
-   `objectiveText` accetta correttamente fino a 50.000 caratteri;
-   comportamento operativo essenziale verificato anche con viewport
    mobile;
-   elementi terminali/risolti non contaminano conteggi, KPI o readiness correnti;
-   Agent Control usa G-Rex Pricing come fonte dei listini senza prezzi hardcodati;
-   il consumo per singola chiamata/iterazione resta disponibile quando necessario per applicare correttamente pricing a scaglioni;
-   un costo assente o nullo restituito dal runtime può essere ricostruito dai consumi reali e dal listino corrente;
-   due Objective paralleli sullo stesso repository ricevono worktree e branch distinti;
-   retry/fallback della stessa esecuzione riutilizzano la stessa workspace e preservano il lavoro prodotto;
-   il runtime riceve il `cwd`/`projectPath` del worktree isolato e non la working tree principale quando l'isolamento è richiesto;
-   modifiche locali incompatibili nella working tree principale non vengono ignorate o sovrascritte;
-   un conflitto reale di integrazione produce una richiesta umana senza perdita delle modifiche;
-   crash/riavvio riconcilia lo stato persistito con worktree e branch realmente presenti;
-   la pulizia non elimina workspace con lavoro non integrato o ancora necessario.

------------------------------------------------------------------------

## 25. Regola per le future implementazioni

Prima di implementare una modifica che tocca stati, lifecycle, Control
Room, notifiche, errori, decisioni umane, workspace Git o parallelismo, l'agente deve verificare la
compatibilità con questo documento.

Le milestone descrivono capacità tecniche e storia evolutiva; **questo
documento definisce il comportamento corrente del prodotto**.

Quando codice e documentazione divergono, non si deve scegliere
arbitrariamente il comportamento esistente: la divergenza deve essere
identificata e l'implementazione riallineata alla specifica corrente,
salvo esplicita nuova decisione di prodotto.
