# G-Rex Agent Control — Agent Rules

## Fonte autorevole
Prima di modificare comportamento, architettura o interfaccia di G-Rex Agent Control, individuare e leggere la specifica V2 autorevole presente nel repository.

La V2 definisce il contratto di prodotto. In caso di conflitto con documenti di milestone, commenti, implementazioni precedenti o assunzioni storiche, prevale la V2.

Non duplicare in questo file la specifica di prodotto: usare questo `AGENTS.md` come guida operativa e la V2 come fonte dei requisiti.

## Metodo operativo
- Comprendere il flusso reale prima di modificarlo.
- Correggere la causa alla fonte; evitare workaround puramente cosmetici o duplicazioni di logica.
- Non introdurre redesign o nuove astrazioni se non necessari all'obiettivo o alla V2.
- Preservare l'architettura esistente quando soddisfa già il contratto.
- Preferire una sorgente unica per stato, derivazioni e regole condivise.
- Non simulare capacità che backend o runtime non possiedono realmente.
- Mantenere compatibilità con dati persistenti e comportamenti esistenti quando non sono in conflitto con la V2.

## Invarianti di prodotto
- **Normalità = silenzio; eccezione = evidenza.**
- **Stato corrente ≠ storico.** Errori risolti, sessioni concluse, checkpoint chiusi e condizioni non più attive non devono alterare KPI, badge, readiness o attenzione corrente.
- **`Richiede te` significa esclusivamente azione umana realmente pendente.** Completamenti informativi, notifiche non lette, vecchi errori e stati tecnici non azionabili non vi appartengono.
- Il recovery automatico viene prima dell'escalation umana quando il sistema può ragionevolmente procedere da solo.
- Il progetto è un'entità permanente associata al repository; obiettivi, sessioni e attempt ne costituiscono il lavoro nel tempo.
- Provider e modello scelti dal routing devono essere quelli realmente usati dal runtime e devono restare auditabili.
- Desktop e mobile devono mantenere la stessa semantica operativa; il mobile non deve diventare una versione funzionalmente diversa del prodotto.

## Execution Plane e workspace Git
- Preservare la separazione tra Control Plane ed Execution Plane definita dalla V2.
- `ProcessSupervisor` resta responsabile del lifecycle dei processi e degli attempt, inclusi retry, fallback, costi ed eventi; non rifarlo per introdurre funzionalità ortogonali.
- Le workspace Git isolate/worktree sono una responsabilità separata dall'orchestrazione dei processi.
- Obiettivi paralleli sullo stesso repository devono lavorare in worktree/branch distinti.
- Retry e fallback appartenenti alla stessa esecuzione devono riutilizzare la stessa workspace, preservando il lavoro già prodotto.
- Agenti concorrenti non devono lavorare direttamente sulla working tree principale.
- Stato Git incompatibile con una creazione o integrazione sicura e conflitti reali che richiedono una scelta umana devono seguire la semantica `Richiede te` prevista dalla V2.
- Non risolvere automaticamente conflitti in modo arbitrario o con rischio di perdita delle modifiche.

## Pricing, provider e consumo
- **G-Rex Pricing è la fonte unica dei listini.**
- Agent Control consuma selettivamente dall'archivio G-Rex Pricing solo provider e modelli configurati/utilizzabili.
- Non hardcodare prezzi in Agent Control e non creare una seconda fonte manuale di verità.
- Supportare attraverso il modello pricing previsto dalla V2 le strutture necessarie, incluse quando presenti fasce temporali, cache hit/miss e scaglioni legati ai token.
- Il costo effettivo deve derivare dai dati di consumo reali quando il runtime non fornisce un costo monetario affidabile.
- Conservare la granularità di consumo necessaria ad applicare correttamente il listino, mantenendo la UI ordinaria sintetica.
- API key, token, password e altri segreti non devono essere inseriti nel repository o nei file versionati.

## Verifica
Per ogni modifica eseguire le verifiche pertinenti al suo impatto, privilegiando evidenze reali rispetto a semplici assunzioni:
- regression test mirati;
- suite interessate;
- typecheck;
- build;
- verifica runtime/end-to-end quando il comportamento dipende da processi, CLI, persistenza o integrazioni reali;
- verifica responsive/mobile quando viene modificata la UI;
- migrazioni e compatibilità con dati esistenti quando viene modificata la persistenza.

Non dichiarare verificato ciò che non è stato realmente verificato. Dichiarare esplicitamente eventuali limiti residui.

Non eseguire commit o push salvo richiesta esplicita dell'utente.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Windows shell rules

This project runs on Windows.

When executing terminal commands:
- Prefer native Windows commands compatible with PowerShell or CMD.
- Do not use Unix-only commands such as `head`, `tail`, `grep`, `sed`, `awk`, `cat`, or `xargs` unless you have verified they are available.
- In PowerShell, prefer `Select-Object -First N` instead of `head -N`, `Select-Object -Last N` instead of `tail -N`, `Select-String` instead of `grep`, and `Get-Content` instead of `cat`.
- Avoid long or obfuscated PowerShell one-liners when a direct executable command or a short Python script can do the same job.
- Prefer calling `graphify` directly when using Graphify.
