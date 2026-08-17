import fs from 'node:fs';
import path from 'node:path';
import type { PricingProviderEntry, TokenPricing } from '../../domain/pricing.js';

/**
 * Lettore dell'archivio prodotto da G-Rex Pricing (fonte unica dei prezzi).
 * L'archivio è l'insieme di quattro file scritti atomicamente da G-Rex Pricing
 * (`FileStorage`): `meta.json`, `registry.json`, `archive.json`, `index.json`.
 * Agent Control NON duplica né hardcoda prezzi: li risolve da qui.
 */

interface ArchiveProvider {
  id: string;
  name: string;
  timezone: string;
  officialSiteUrl: string;
  sourceIds: string[];
  limits: Record<string, unknown>;
}

interface ArchiveModel {
  id: string;
  providerId: string;
  name: string;
  contextWindow: { maxInputTokens: number | null; maxOutputTokens: number | null };
  capabilities: string[];
}

interface TimeRange {
  start: string;
  end: string;
}

type WeeklySchedule = Partial<Record<string, TimeRange[]>>;

interface BandPricing {
  currency: string;
  inputPerToken: number | null;
  outputPerToken: number | null;
  cachedInputPerToken: number | null;
  cachedOutputPerToken: number | null;
  extra: Record<string, number>;
}

interface ArchiveTimeBand {
  id: string;
  name: string;
  timezone: string;
  priority: number;
  isDefault: boolean;
  schedule: WeeklySchedule | null;
  pricing: BandPricing;
}

interface ArchiveRecord {
  id: string;
  providerId: string;
  modelId: string;
  validFrom: string;
  validTo: string | null;
  timeBands: ArchiveTimeBand[];
}

export interface PricingArchive {
  providers: ArchiveProvider[];
  models: ArchiveModel[];
  records: ArchiveRecord[];
  /** record key (`provider::model`) → current record id */
  current: Record<string, string>;
}

/** Mappa archivio → chiave provider CLI Cline (`--provider`). Solo i provider
 *  presenti qui vengono selezionati (configurati e utilizzati). */
export type CliProviderMap = Record<string, string>;

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function wallClockParts(date: Date, timeZone: string): { dayOfWeek: string; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday').toLowerCase();
  let hour = Number.parseInt(get('hour'), 10);
  if (Number.isNaN(hour) || hour === 24) hour = 0;
  const minute = Number.parseInt(get('minute'), 10);
  return { dayOfWeek: WEEKDAYS.includes(day as (typeof WEEKDAYS)[number]) ? day : 'monday', hour, minute: Number.isNaN(minute) ? 0 : minute };
}

function minutesOfDay(value: string): number {
  const [h, m] = value.split(':').map((n) => Number(n));
  return (h ?? 0) * 60 + (m ?? 0);
}

function rangeMatches(range: TimeRange, hour: number, minute: number): boolean {
  const current = hour * 60 + minute;
  const start = minutesOfDay(range.start);
  const end = minutesOfDay(range.end);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end; // wrap midnight
}

function scheduleMatches(schedule: WeeklySchedule | null, day: string, hour: number, minute: number): boolean {
  if (!schedule) return false;
  const ranges = schedule[day];
  if (!ranges || ranges.length === 0) return false;
  return ranges.some((range) => rangeMatches(range, hour, minute));
}

/** Risolve la fascia temporale applicabile a `at` (logica del resolver G-Rex Pricing). */
export function resolveBand(record: ArchiveRecord, at: Date): ArchiveTimeBand {
  const matches: ArchiveTimeBand[] = [];
  let defaultBand: ArchiveTimeBand | undefined;
  for (const band of record.timeBands) {
    if (band.isDefault) { defaultBand = band; continue; }
    const parts = wallClockParts(at, band.timezone);
    if (scheduleMatches(band.schedule, parts.dayOfWeek, parts.hour, parts.minute)) matches.push(band);
  }
  if (matches.length > 0) {
    matches.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return matches[0];
  }
  return defaultBand ?? record.timeBands[0];
}

/** Carica l'archivio (fail-safe: null se assente/corrotto). */
export function loadPricingArchive(dir: string): PricingArchive | null {
  try {
    const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const meta = read('meta.json') as { schemaVersion?: number };
    if (typeof meta.schemaVersion !== 'number') return null;
    const registry = read('registry.json') as { providers?: ArchiveProvider[]; models?: ArchiveModel[] };
    const records = read('archive.json') as ArchiveRecord[];
    const index = read('index.json') as { current?: Record<string, string> };
    const recordIds = new Set(records.map((r) => r.id));
    const current: Record<string, string> = {};
    for (const [key, id] of Object.entries(index.current ?? {})) {
      if (recordIds.has(id)) current[key] = id;
    }
    return { providers: registry.providers ?? [], models: registry.models ?? [], records, current };
  } catch {
    return null;
  }
}

const recordKey = (providerId: string, modelId: string): string => `${providerId}::${modelId}`;

const toMillion = (perToken: number | null): number | null => perToken === null ? null : Number((perToken * 1_000_000).toFixed(6));

/**
 * Converte l'archivio in `PricingProviderEntry[]` per il catalogo Agent Control,
 * selezionando solo i provider nella mappa CLI e risolvendo la fascia corrente.
 */
export function archiveToPricingEntries(
  archive: PricingArchive,
  at: Date,
  cliProviderMap: CliProviderMap,
): PricingProviderEntry[] {
  const byId = new Map(archive.records.map((r) => [r.id, r]));
  const entries: PricingProviderEntry[] = [];
  for (const provider of archive.providers) {
    const cliProviderId = cliProviderMap[provider.id];
    if (!cliProviderId) continue; // non configurato/utilizzato → escluso
    const models: PricingProviderEntry['models'] = [];
    for (const model of archive.models.filter((m) => m.providerId === provider.id)) {
      const currentId = archive.current[recordKey(provider.id, model.id)];
      const record = currentId ? byId.get(currentId) : undefined;
      if (!record) continue;
      const band = resolveBand(record, at);
      const inputPerToken = band.pricing.inputPerToken;
      const outputPerToken = band.pricing.outputPerToken;
      const tokenPricing: TokenPricing = {
        inputPerToken,
        outputPerToken,
        cachedInputPerToken: band.pricing.cachedInputPerToken,
        cachedOutputPerToken: band.pricing.cachedOutputPerToken,
        currency: band.pricing.currency,
        extra: band.pricing.extra ?? {},
      };
      models.push({
        id: model.id,
        name: model.name,
        contextTokens: model.contextWindow.maxInputTokens,
        defaultOutputTokens: model.contextWindow.maxOutputTokens ?? 4000,
        pricing: { inputPerMillion: toMillion(inputPerToken), outputPerMillion: toMillion(outputPerToken), currency: 'USD' },
        pricingSchedule: null,
        tokenPricing,
      });
    }
    if (models.length > 0) {
      entries.push({ id: cliProviderId, name: provider.name, models });
    }
  }
  return entries;
}

