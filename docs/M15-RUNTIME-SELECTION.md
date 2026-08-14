# M15 — Selezione esplicita runtime/provider/modello

Ogni sessione conserva una `ExecutionSelection` normalizzata con `runtimeId`,
`providerId`, `modelId` e limite output. Il catalogo M14 è l'unica sorgente per
risolvere e validare la combinazione: runtime disponibile, provider compatibile,
modello esistente e limite output entro il massimo catalogato.

Prima dell'avvio iniziale, del retry o del fallback, Agent Control risolve la
selezione attraverso il catalogo. Gli `ExecutionAttempt` persistono la
combinazione effettiva nelle colonne runtime/provider/modello e nei metadati con
motivazione della scelta; lo storico API/UI la rende quindi auditabile.

Il fallback usa il runtime configurato dalla policy e lo sottopone alla stessa
validazione. La selezione esplicita resta disponibile e prevale sul routing
automatico introdotto successivamente da M16.
