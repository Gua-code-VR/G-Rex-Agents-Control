import fs from 'node:fs';
import {
  pricingFileSchema,
  resolvePricingAt,
  type PricingProviderEntry,
} from '../domain/pricing.js';
import {
  archiveToPricingEntries,
  loadPricingArchive,
  type CliProviderMap,
} from '../infrastructure/pricing/g-rex-archive.js';

/**
 * Sorgente dei prezzi dichiarati per i provider diretti (M18): un file JSON
 * locale riscritto dall'operatore e riletto periodicamente, oppure — quando
 * configurato — l'archivio prodotto da G-Rex Pricing (fonte unica, prende la
 * precedenza sul file). Nessuna rete (§14).
 */
export class PricingCatalogService {
  private entries: PricingProviderEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly fallback: PricingProviderEntry[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly archiveDir?: string,
    private readonly cliProviderMap: CliProviderMap = {},
  ) {
    this.refresh();
  }

  list(): PricingProviderEntry[] { return this.entries; }

  refresh(): void {
    this.entries = this.readArchive() ?? this.readFile() ?? this.fallback;
  }

  startRefreshing(intervalMs: number): void {
    if (this.timer) clearInterval(this.timer);
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.refresh(), intervalMs);
      this.timer.unref?.();
    }
  }

  stopRefreshing(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Archivio G-Rex Pricing (fonte unica) → lista provider/modelli risolti. */
  private readArchive(): PricingProviderEntry[] | null {
    if (!this.archiveDir) return null;
    const archive = loadPricingArchive(this.archiveDir);
    if (!archive) return null;
    return archiveToPricingEntries(archive, this.now(), this.cliProviderMap);
  }

  private readFile(): PricingProviderEntry[] | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = pricingFileSchema.parse(JSON.parse(raw));
      const at = this.now();
      return parsed.providers.map((provider) => ({
        id: provider.id,
        name: provider.name ?? provider.id,
        models: provider.models.map((model) => {
          const effective = resolvePricingAt(model.pricing, at);
          return {
            id: model.id,
            name: model.name ?? model.id,
            contextTokens: model.contextTokens,
            defaultOutputTokens: model.defaultOutputTokens,
            pricing: { inputPerMillion: effective.inputPerMillion, outputPerMillion: effective.outputPerMillion, currency: 'USD' as const },
            pricingSchedule: Array.isArray(model.pricing) ? model.pricing : null,
          };
        }),
      }));
    } catch {
      return null;
    }
  }
}
