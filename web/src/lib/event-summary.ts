/**
 * Riassunto leggibile del payload di un evento, senza JSON grezzo.
 * Estrae i campi più significativi (messaggio, motivo, titolo, stato)
 * e li unisce in una singola riga compatta.
 */
export function summarizeEventPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);
  const record = payload as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  };
  const summary = pick('message', 'reason', 'title', 'summary', 'error', 'detail');
  if (summary) return summary;
  const status = pick('status', 'outcome', 'decision', 'decisionType', 'state');
  return status ?? '';
}
