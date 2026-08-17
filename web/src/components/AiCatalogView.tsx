import { useEffect, useState } from 'react';
import { api, type ProviderCatalogEntry } from '../api/client';

/**
 * Fase 9 — AI Catalog + Routing (§13 CONTROL_ROOM_SPEC.md).
 * Catalogo leggibile: runtime/provider/modello distinti, disponibilità,
 * capacità, pricing. Il routing resta governato da regole, non da scelte
 * manuali di modello.
 */
export function AiCatalogView() {
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);

  useEffect(() => {
    void api.getProviderCatalog().then((r) => setCatalog(r.catalog)).catch(() => setCatalog([]));
  }, []);

  return (
    <div className="ai-catalog-view">
      <section className="panel">
        <div className="panel-head"><h2>AI Catalog</h2></div>
        <p className="muted small">
          La selezione di runtime/provider/modello è governata automaticamente (affidabilità, budget, esiti storici).
          Qui espone la disponibilità reale, non i comandi manuali.
        </p>
      </section>

      {catalog.length === 0 ? (
        <section className="panel"><p className="muted">Nessun runtime catalogato.</p></section>
      ) : catalog.map((entry) => (
        <section className="panel catalog-entry" key={`${entry.runtime.id}:${entry.provider.id}`}>
          <div className="panel-head">
            <h2>{entry.runtime.name}</h2>
            <span className={`badge ${entry.runtime.available ? 'badge-completato' : 'badge-errore'}`}>
              {entry.runtime.available ? 'Disponibile' : 'Non disponibile'}
            </span>
          </div>
          <ul className="health-list">
            <li><span className="health-label">Tipo</span><span className="health-value">{entry.runtime.type}</span></li>
            <li><span className="health-label">Provider</span><span className="health-value">{entry.provider.name}</span></li>
            <li><span className="health-label">Capacità</span><span className="health-value">{entry.runtime.capabilities.join(', ') || '—'}</span></li>
            <li><span className="health-label">Modello predefinito</span><span className="health-value">{entry.runtime.defaultModel ?? 'gestito dal runtime'}</span></li>
          </ul>
          {entry.models.length > 0 && (
            <div className="catalog-models">
              <span className="objective-label">Modelli</span>
              {entry.models.map((model) => (
                <div className="needs-item" key={model.id}>
                  <p className="needs-summary"><strong>{model.name}</strong></p>
                  <p className="muted small">
                    {model.pricing.inputPerMillion === null || model.pricing.outputPerMillion === null
                      ? 'Pricing non configurato'
                      : `$${model.pricing.inputPerMillion}/M input · $${model.pricing.outputPerMillion}/M output`}
                    {' · '}max output {model.limits.defaultOutputTokens} token
                    {model.limits.contextTokens !== null ? ` · contesto ${model.limits.contextTokens} token` : ''}
                    {model.pricingSchedule ? ' · pricing per fasce orarie' : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
