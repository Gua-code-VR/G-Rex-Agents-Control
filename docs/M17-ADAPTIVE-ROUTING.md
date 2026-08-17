# M17 — Adaptive Routing & Performance Learning

Il routing automatico usa gli esiti normalizzati già persistiti per imparare nel
tempo quale combinazione runtime/provider/modello funziona meglio. Non modifica
gli adapter e non aggira disponibilità, capacità o policy di budget: questi
vincoli restano filtri autoritativi prima dello scoring adattivo.

Ogni obiettivo viene classificato deterministicamente come `BUG_FIX`,
`CODE_CHANGE`, `TESTING`, `DOCUMENTATION`, `ANALYSIS` o `GENERAL`. Per ogni
candidato il router combina lo storico globale con quello specifico del tipo,
applicando smoothing quando i campioni specifici sono pochi.

I segnali appresi sono:

- qualità verificata da stato dell'obiettivo, acceptance del checkpoint e
  decisione umana;
- completamento tecnico e affidabilità;
- frequenza di retry e fallback;
- durata media;
- costo effettivo medio (o stima quando il dato effettivo manca);
- richieste di modifica, stop, cancellazioni e checkpoint problematici.

La decisione resta riproducibile e auditabile in `ExecutionSelection`: versione
del modello di apprendimento, tipo di obiettivo, numerosità globale e specifica,
metriche normalizzate, punteggio, motivazioni, alternative scartate e contesto
di policy. La stessa spiegazione viene conservata nei metadati del tentativo
effettivamente avviato.

Lo storico non rende mai eleggibile una combinazione indisponibile,
incompatibile o vietata dalla policy. A parità di punteggio rimane il tie-break
deterministico già introdotto in M16.
