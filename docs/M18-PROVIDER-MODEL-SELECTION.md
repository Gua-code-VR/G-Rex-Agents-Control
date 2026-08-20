# M18 — Selezione automatica provider diretto + modello per attempt

Prima di ogni attempt Cline, Agent Control sceglie automaticamente provider
diretto e modello tra quelli dichiarati, usando quattro segnali: costo,
contesto (finestra di token), budget residuo e affidabilità storica. La
decisione resta deterministica, auditabile e retro-compatibile con la
configurazione singola pre-M18.

## Fonte dei prezzi

I prezzi non sono inventati né recuperati dalla rete (§14: tutto locale).
L'operatore dichiara i provider diretti in un file JSON locale
(`GAC_PRICING_FILE`, default `./data/pricing.json`), riletto periodicamente
(`GAC_PRICING_REFRESH_MS`, default 60 s). Il file ha questa forma:

```json
{
  "updatedAt": "2026-08-15T12:00:00Z",
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "models": [
        {
          "id": "deepseek-chat",
          "name": "DeepSeek V3",
          "contextTokens": 64000,
          "defaultOutputTokens": 4000,
          "pricing": { "inputPerMillion": 0.27, "outputPerMillion": 1.10 }
        },
        {
          "id": "deepseek-reasoner",
          "contextTokens": 64000,
          "pricing": [
            { "from": "00:00", "to": "16:29", "inputPerMillion": 0.55, "outputPerMillion": 2.19 },
            { "from": "16:30", "to": "23:59", "inputPerMillion": 0.27, "outputPerMillion": 1.10 }
          ]
        }
      ]
    }
  ]
}
```

- `pricing` può essere **piatto** (`inputPerMillion`/`outputPerMillion`) oppure
  una **schedule** di finestre orarie (UTC, estremi inclusi). Il prezzo effettivo
  viene risolto sul tempo corrente a ogni refresh, così una fascia oraria resta
  corretta senza riavvio.
- Se il file è assente o non valido, si ricade sulle env singole
  `GAC_CLINE_PROVIDER`/`GAC_CLINE_MODEL`/`GAC_CLINE_INPUT_PRICE_PER_MILLION`/
  `GAC_CLINE_OUTPUT_PRICE_PER_MILLION` (retro-compatibilità).
- Il costo **misurato a consuntivo** (`cost_actual` degli attempt) resta un
  segnale separato e corregge automaticamente le derive del listino dichiarato.

## Criteri di selezione

Il router M16/M17 valuta ogni combinazione (runtime, provider, modello) e
attribuisce un punteggio basato su: affidabilità storica, efficienza di costo
appresa, costo stimato dal catalogo, budget residuo e capacità richieste. M18
aggiunge un vincolo **autoritativo**:

- **Contesto**: se `contextTokens` è dichiarato e i token di input stimati
  dell'obiettivo lo superano, il modello è **escluso** (non un semplice
  declassamento) con motivazione esplicita nel candidato.

## Ri-selezione a ogni attempt

A ogni retry o fallback, il provider+modello viene **ri-scelto** dal router
entro il runtime target (non riusato dalla selezione iniziale). Una selezione
**esplicita** dell'operatore continua a prevalere: viene solo ri-validata dal
catalogo, come in M15.

## Auditabilità

La decisione completa resta in `ExecutionSelection` (`mode`, `reason`,
`candidates`, `learningVersion: M18-v1`) e nei metadati dell'`ExecutionAttempt`;
il provider effettivo è registrato in `provider_name` per consentire lo storico
per provider/modello e il breakdown di governance.

## Autenticazione runtime e disponibilità modello

La combinazione (runtime, provider, modello) deve essere supportata
dall'**autenticazione corrente** del runtime: non viene proposta né avviata
alcuna combinazione non supportata. L'autenticazione corrente della CLI Codex è
dichiarata dall'operatore con `GAC_CODEX_AUTH` (`api-key` di default, oppure
`chatgpt` per un account ChatGPT).

- Con `api-key` (default, retro-compatibile) `codex-default` resta proposto come
  oggi.
- Con `chatgpt`, l'alias `codex-default` **non è supportato**: `CodexProvider`
  esclude il modello dal catalogo (modello gestito dal runtime, nessun
  `modelId`), la validazione rifiuta un `codex-default` esplicito e l'avvio lo
  blocca. Selezione automatica e UI ereditano l'esclusione dall'unica sorgente
  del catalogo. L'esclusione vale in ogni caso, anche se l'operatore configura
  `GAC_CODEX_MODEL` proprio con l'alias (in qualsiasi maiuscola/minuscola):
  in quella situazione il catalogo tratta il modello come gestito dal runtime e
  il guard di avvio blocca comunque un caso variato.

Un modello esplicito configurato con `GAC_CODEX_MODEL` resta rispettato
(la scelta dell'operatore prevale), purché nomini un modello realmente
supportato dall'autenticazione corrente.

