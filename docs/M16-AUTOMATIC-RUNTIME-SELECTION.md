# M16 — Selezione automatica runtime/provider/modello

Quando un obiettivo non specifica esplicitamente un runtime, Agent Control valuta
tutte le combinazioni reali disponibili del catalogo M14. La scelta è
deterministica e considera disponibilità, capacità richieste, affidabilità
storica, costo stimato, budget residuo e azione della policy di progetto.

I runtime di test non partecipano al routing operativo. `fake` resta disponibile
solo come fallback controllato quando è il runtime predefinito dell'ambiente di
test e nessun runtime reale è disponibile.

La decisione completa è persistita dentro `ExecutionSelection`: modalità,
motivazione, punteggio selezionato, capacità richieste, contesto budget e tutte
le alternative valutate con ammissibilità e motivi. Lo stesso dato viene
registrato nell'evento di creazione e nei metadati dell'`ExecutionAttempt`.

Una scelta esplicita continua a prevalere sul router automatico ed è validata
dal catalogo come in M15.
