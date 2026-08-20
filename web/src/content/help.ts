export const HELP_TOPIC_IDS = [
  'primo-avvio',
  'progetti',
  'obiettivi',
  'runtime-provider-modello',
  'richiede-te',
  'monitor-attivita',
  'retry-fallback',
  'costi-budget',
  'native-workflow',
  'errori-comuni',
  'configurazione',
] as const;

export type HelpTopicId = typeof HELP_TOPIC_IDS[number];

export interface HelpTopic {
  id: HelpTopicId;
  title: string;
  summary: string;
  body: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'primo-avvio',
    title: 'Primo avvio',
    summary: 'Cosa controllare prima di far lavorare gli agenti.',
    body: [
      'Apri Sistema e verifica che il Control Plane sia pronto e che almeno un runtime risulti disponibile.',
      'Crea un progetto, collega il repository se il lavoro riguarda codice, poi descrivi il primo obiettivo in linguaggio naturale.',
      'Se qualcosa non è configurato, Agent Control lo mostra come stato operativo o come voce in Richiede te quando serve una tua decisione.',
    ],
  },
  {
    id: 'progetti',
    title: 'Progetti',
    summary: 'Il contenitore stabile del lavoro nel tempo.',
    body: [
      'Un progetto rappresenta un contesto di lavoro: può essere collegato a un repository Git oppure essere usato per attività non legate al codice.',
      'Dentro lo stesso progetto puoi avviare molti obiettivi. La fine di un obiettivo non chiude il progetto.',
      'Quando c’è un repository, Agent Control usa workspace isolati per evitare che obiettivi paralleli si pestino i piedi.',
    ],
  },
  {
    id: 'obiettivi',
    title: 'Obiettivi',
    summary: 'L’unità di lavoro che descrive cosa deve essere ottenuto.',
    body: [
      'Scrivi cosa vuoi ottenere. Titolo, criteri e condizioni avanzate aiutano, ma non sono obbligatori per partire.',
      'L’esecuzione automatica è il flusso normale: Agent Control sceglie runtime, provider e modello in base a disponibilità, storico e budget.',
      'Usa la scelta manuale solo quando hai un motivo preciso per vincolare runtime, provider o modello.',
    ],
  },
  {
    id: 'runtime-provider-modello',
    title: 'Runtime, provider e modello',
    summary: 'Tre livelli diversi della stessa selezione AI.',
    body: [
      'Il runtime è il motore operativo locale che esegue il lavoro, per esempio Cline.',
      'Il provider è il servizio o backend AI usato dal runtime, per esempio un endpoint compatibile o un provider configurato.',
      'Il modello è il modello AI specifico. A volte è scelto da Agent Control, a volte resta gestito dal runtime.',
      'AI Catalog mostra ciò che è realmente disponibile adesso; non è una lista teorica.',
    ],
  },
  {
    id: 'richiede-te',
    title: 'Richiede te',
    summary: 'Solo decisioni umane pendenti adesso.',
    body: [
      'Questa vista non è uno storico errori. Mostra solo ciò che aspetta una tua scelta per poter continuare.',
      'Esempi: approvare un budget, consentire un’azione runtime, scegliere come gestire un errore terminale o annullare un obiettivo.',
      'Se Agent Control può recuperare da solo con retry o fallback, non dovrebbe chiederti intervento.',
    ],
  },
  {
    id: 'monitor-attivita',
    title: 'Monitor attività',
    summary: 'Una lettura operativa di tentativi, eventi e worker.',
    body: [
      'Il Monitor attività ricostruisce cosa sta succedendo usando eventi già persistiti: sessioni, tentativi, costi, heartbeat e worker.',
      'La timeline worker/run è utile quando un runtime divide il lavoro in più attività parallele.',
      'Il Monitor è diagnostico: mostra ciò che è accaduto, ma la fonte dello stato resta Agent Control.',
    ],
  },
  {
    id: 'retry-fallback',
    title: 'Retry e fallback',
    summary: 'Come Agent Control prova a recuperare senza disturbarti.',
    body: [
      'Un retry riprova lo stesso lavoro preservando storico e workspace.',
      'Un fallback passa a un runtime alternativo quando la policy lo prevede.',
      'Ogni tentativo resta tracciato separatamente, così puoi capire cosa è stato provato e perché.',
    ],
  },
  {
    id: 'costi-budget',
    title: 'Costi e budget',
    summary: 'Governance sui consumi senza bloccare il lavoro ordinario.',
    body: [
      'Agent Control registra stime e costi effettivi quando il runtime fornisce dati affidabili o quando il pricing è disponibile.',
      'Il budget serve a prevenire spese non autorizzate. Se serve approvazione, la richiesta appare in Richiede te.',
      'Quando il pricing non è disponibile, la UI lo indica invece di inventare un costo.',
    ],
  },
  {
    id: 'native-workflow',
    title: 'Native workflow multi-worker',
    summary: 'Orchestrazione parallela governata dal Control Plane.',
    body: [
      'Il native workflow chiede al runtime compatibile di scomporre l’obiettivo, usare worker paralleli, rispettare dipendenze e fare join finale.',
      'Agent Control resta l’unica fonte di verità per stato, routing, budget, retry, worktree e audit.',
      'Il limite dei worker è configurabile. Di default il workflow nativo è abilitato per Cline, estendibile ad altri runtime configurati.',
    ],
  },
  {
    id: 'errori-comuni',
    title: 'Errori comuni',
    summary: 'Come leggere i problemi più frequenti.',
    body: [
      'Runtime non disponibile: la CLI non è installata, non è sul PATH o è disabilitata da configurazione.',
      'Provider o modello non selezionabile: la combinazione non è nel catalogo corrente o non è compatibile con il runtime scelto.',
      'Budget bloccante: l’obiettivo supera la soglia e richiede approvazione.',
      'Problemi Git: repository assente, stato non leggibile o conflitto che richiede una scelta umana.',
    ],
  },
  {
    id: 'configurazione',
    title: 'Configurazione',
    summary: 'Dove intervenire quando la UI segnala un limite ambientale.',
    body: [
      'Le opzioni principali sono variabili d’ambiente. La UI non modifica automaticamente runtime, provider o credenziali del PC.',
      'Per Cline verifica comando, provider configurati, modelli disponibili e archivio pricing se vuoi stime di costo affidabili.',
      'Per il native workflow puoi impostare abilitazione, numero massimo di worker e lista runtime tramite configurazione.',
    ],
  },
];

export function helpTopicById(id: HelpTopicId): HelpTopic {
  return HELP_TOPICS.find((topic) => topic.id === id) ?? HELP_TOPICS[0];
}
