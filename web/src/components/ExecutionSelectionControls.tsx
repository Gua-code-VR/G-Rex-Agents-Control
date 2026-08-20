import { useEffect, useMemo, useState } from 'react';
import { api, type ProviderCatalogEntry } from '../api/client';
import type { ExecutionSelectionValue } from '../lib/execution-selection';
import { defaultModelId, filterOperationalCatalog, modelsForProvider, providersForRuntime } from '../lib/provider-catalog';

interface Props {
  value: ExecutionSelectionValue;
  onChange: (value: ExecutionSelectionValue) => void;
  disabled?: boolean;
}

/**
 * Componente condiviso per la selezione Runtime/Provider/Modello.
 *
 * Un'unica sorgente di opzioni (catalogo operativo, con `fake` nascosto quando
 * esiste un runtime reale) riusata da tutte le schermate: la semantica di
 * selezione resta identica ovunque.
 */
export function ExecutionSelectionControls({ value, onChange, disabled = false }: Props) {
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);

  useEffect(() => {
    void api.getProviderCatalog()
      .then((result) => setCatalog(filterOperationalCatalog(result.catalog)))
      .catch(() => setCatalog([]));
  }, []);

  const providers = useMemo(() => providersForRuntime(catalog, value.runtimeId), [catalog, value.runtimeId]);
  const models = useMemo(() => modelsForProvider(catalog, value.runtimeId, value.providerId), [catalog, value.runtimeId, value.providerId]);

  const setRuntime = (runtimeId: string) => {
    const nextProviders = providersForRuntime(catalog, runtimeId);
    const providerId = nextProviders[0]?.id ?? '';
    onChange({ runtimeId, providerId, modelId: defaultModelId(catalog, runtimeId, providerId) });
  };
  const setProvider = (providerId: string) => {
    onChange({ runtimeId: value.runtimeId, providerId, modelId: defaultModelId(catalog, value.runtimeId, providerId) });
  };
  const setModel = (modelId: string) => {
    onChange({ runtimeId: value.runtimeId, providerId: value.providerId, modelId });
  };

  return (
    <div className="runtime-selection">
      <label className="field">Runtime
        <select value={value.runtimeId} onChange={(e) => setRuntime(e.target.value)} disabled={disabled}>
          <option value="">Seleziona runtime</option>
          {catalog.map((entry) => <option key={entry.runtime.id} value={entry.runtime.id} disabled={!entry.runtime.available}>{entry.runtime.name}{entry.runtime.available ? '' : ' (non disponibile)'}</option>)}
        </select>
      </label>
      <label className="field">Provider
        <select value={value.providerId} disabled={disabled || !value.runtimeId || providers.length === 0}
          onChange={(e) => setProvider(e.target.value)}>
          <option value="">{providers.length ? 'Seleziona provider' : 'Nessun provider'}</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
      </label>
      <label className="field">Modello
        <select value={value.modelId} disabled={disabled || !value.providerId || models.length === 0}
          onChange={(e) => setModel(e.target.value)}>
          <option value="">{models.length ? 'Seleziona modello' : 'Gestito dal runtime'}</option>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
    </div>
  );
}
