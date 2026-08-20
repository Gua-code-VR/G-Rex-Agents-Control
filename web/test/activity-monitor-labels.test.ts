import { describe, expect, it } from 'vitest';
import type { EventRecord } from '../src/api/client';
import { eventKindLabel, isErrorEvent, runStatusLabel } from '../src/components/ActivityMonitorView';

function event(type: string, payload: unknown = null): EventRecord {
  return {
    id: 1,
    projectId: 'p1',
    objectiveId: 'o1',
    sessionId: 's1',
    category: 'TECHNICAL',
    type,
    timestamp: '2026-08-19T19:11:00.000Z',
    payload,
  };
}

describe('ActivityMonitorView — etichette degli eventi', () => {
  it('eventKindLabel mappa i bucket noti e lascia invariati gli sconosciuti', () => {
    expect(eventKindLabel('tool')).toBe('Strumento');
    expect(eventKindLabel('retry')).toBe('Retry');
    expect(eventKindLabel('sconosciuto')).toBe('sconosciuto');
  });

  it('runStatusLabel mappa gli stati noti e lascia invariati gli sconosciuti', () => {
    expect(runStatusLabel('completed')).toBe('Completato');
    expect(runStatusLabel('failed')).toBe('Fallito');
    expect(runStatusLabel(null)).toBe('—');
    expect(runStatusLabel('cancelled')).toBe('Annullato');
    expect(runStatusLabel('CUSTOM')).toBe('CUSTOM');
  });

  it('isErrorEvent riconosce gli errori correnti e ignora gli heartbeat', () => {
    expect(isErrorEvent(event('execution.attempt.failed', { error: 'command failed', message: 'exit 1' }))).toBe(true);
    expect(isErrorEvent(event('session.heartbeat'))).toBe(false);
    expect(isErrorEvent(event('workflow.native.finalized', { outcome: 'FAILED' }))).toBe(true);
  });
});
