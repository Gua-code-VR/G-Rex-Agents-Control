# Runtime Cline: provider operativi

Agent Control espone nella selezione manuale i provider/modelli Cline configurati
operativamente anche quando non e disponibile un listino G-Rex Pricing.

La variabile `GAC_CLINE_CONFIGURED_PROVIDERS` accetta un JSON con provider e
modelli selezionabili. Esempio:

```json
[
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "models": [
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "contextTokens": 64000,
        "defaultOutputTokens": 8000
      }
    ]
  }
]
```

Se la variabile non e impostata, Agent Control espone DeepSeek
`deepseek-v4-flash` come provider operativo Cline predefinito. I prezzi restano
`null` finche non arrivano da G-Rex Pricing, che rimane la fonte unica dei
listini.
