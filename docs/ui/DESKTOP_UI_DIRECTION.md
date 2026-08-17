# G-Rex Agent Control --- Desktop UI Direction

## Obiettivo

Su desktop G-Rex Agent Control deve essere una vera dashboard operativa
e sfruttare lo spazio orizzontale disponibile.

L'attuale interfaccia nasce mobile-first e non deve essere semplicemente
allargata mantenendo una lunga colonna verticale.

L'immagine `desktop-dashboard-reference.png` è un riferimento di
direzione visiva e strutturale, non un mockup da riprodurre pixel per
pixel.

## Desktop

Preferire:

-   sidebar di navigazione fissa;
-   utilizzo dell'intera larghezza disponibile;
-   KPI e informazioni operative principali nella parte superiore;
-   griglia multi-colonna;
-   progetti, esecuzioni, approvazioni, eccezioni, costi ed eventi
    organizzati per priorità;
-   pagine o viste dedicate per il dettaglio di progetto, obiettivo e
    sessione;
-   storico ExecutionAttempt e relative metriche nel contesto della
    sessione;
-   stato degli agenti e attività in corso immediatamente riconoscibili.

La dashboard principale deve permettere di capire rapidamente:

1.  cosa sta lavorando;
2.  cosa richiede intervento umano;
3.  cosa è andato storto;
4.  quanto si sta consumando/spendendo;
5.  quali progetti o obiettivi richiedono attenzione.

## Mobile

Mantenere l'approccio mobile-first già esistente:

-   layout prevalentemente verticale;
-   navigazione adatta al touch;
-   informazioni prioritarie prima dei dettagli;
-   nessuna dipendenza da hover o interazioni esclusivamente desktop.

Desktop e mobile devono offrire le stesse capacità, ma non devono
necessariamente utilizzare la stessa disposizione.

## Principi

Non rimuovere funzionalità esistenti per semplificare il layout.

Non duplicare la logica applicativa tra desktop e mobile.

Riutilizzare componenti e dati esistenti adattandone la composizione
responsive.

Evitare dashboard sovraccariche: il dettaglio deve essere raggiungibile
quando serve invece di mostrare tutto contemporaneamente.

Mantenere lo stile visivo attuale di G-Rex Agent Control salvo modifiche
necessarie a migliorare gerarchia, leggibilità e utilizzo dello spazio.

## Riferimento visivo

Vedere:

`docs/ui/desktop-dashboard-reference.png`

Usare l'immagine soprattutto come riferimento per:

-   sidebar;
-   gerarchia della dashboard;
-   KPI;
-   organizzazione a griglia;
-   densità informativa desktop;
-   separazione tra overview e viste di dettaglio.

Non copiarne necessariamente colori, testi, dati o proporzioni.
