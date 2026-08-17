import { z } from 'zod';

/** Prezzo per milione di token (null = non configurato). */
export interface PricingRate {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
}

/** Finestra oraria di una schedule di prezzo (UTC, formato HH:MM, estremi inclusi). */
export interface PricingWindow extends PricingRate {
  from: string;
  to: string;
}

/** Prezzo piatto oppure schedule per fascia oraria. */
export type ModelPricingDefinition = PricingRate | PricingWindow[];

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;

const rateSchema = z.object({
  inputPerMillion: z.number().finite().nonnegative().nullable().default(null),
  outputPerMillion: z.number().finite().nonnegative().nullable().default(null),
});

const windowSchema = rateSchema.extend({
  from: z.string().regex(hhmm, 'Orario non valido (HH:MM atteso)'),
  to: z.string().regex(hhmm, 'Orario non valido (HH:MM atteso)'),
});

const pricingSchema = z.union([
  rateSchema,
  z.array(windowSchema).min(1),
]);

const pricingModelSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  contextTokens: z.number().int().positive().nullable().default(null),
  defaultOutputTokens: z.number().int().positive().default(4000),
  pricing: pricingSchema,
});

const pricingProviderSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  models: z.array(pricingModelSchema).min(1),
});

/** Schema del file prezzi dichiarati (M18), riscritto dall'operatore. */
export const pricingFileSchema = z.object({
  updatedAt: z.string().optional(),
  providers: z.array(pricingProviderSchema).min(1),
});

function pad(value: number): string { return String(value).padStart(2, '0'); }

function inWindow(hhmm: string, from: string, to: string): boolean {
  if (from <= to) return hhmm >= from && hhmm <= to;
  return hhmm >= from || hhmm <= to; // finestra a cavallo della mezzanotte
}

/** Risolve il prezzo effettivo a un istante (UTC): schedule → finestra corrente. */
export function resolvePricingAt(pricing: ModelPricingDefinition, date: Date): PricingRate {
  if (Array.isArray(pricing)) {
    const hhmm = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    const window = pricing.find((entry) => inWindow(hhmm, entry.from, entry.to));
    return window
      ? { inputPerMillion: window.inputPerMillion, outputPerMillion: window.outputPerMillion }
      : { inputPerMillion: null, outputPerMillion: null };
  }
  return { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion };
}

/** Prezzo per token (G-Rex Pricing, fonte unica) con split cache-miss/cache-hit. */
export interface TokenPricing {
  inputPerToken: number | null;
  outputPerToken: number | null;
  cachedInputPerToken: number | null;
  cachedOutputPerToken: number | null;
  currency: string;
  extra: Record<string, number>;
}

/** Modello risolto a un istante: prezzo effettivo piatto + schedule grezza. */
export interface PricingModelEntry {
  id: string;
  name: string;
  contextTokens: number | null;
  defaultOutputTokens: number;
  pricing: { inputPerMillion: number | null; outputPerMillion: number | null; currency: 'USD' };
  pricingSchedule: PricingWindow[] | null;
  /**
   * Prezzo per token risolto (fascia corrente) proveniente dall'archivio
   * G-Rex Pricing. Usato per calcolare il consuntivo dai token reali quando
   * il runtime non restituisce un costo monetario. Null se non disponibile.
   */
  tokenPricing?: TokenPricing | null;
}

export interface PricingProviderEntry {
  id: string;
  name: string;
  models: PricingModelEntry[];
}
