import { describe, expect, it } from 'vitest';
import type { EventRecord } from '../src/api/client';
import { calculatePeakConcurrency, extractTeamRuns } from '../src/components/ActivityMonitorView';

function event(id: number, toolName: string, toolCallId: string, type: 'content_start' | 'content_end', data: Record<string, unknown> | Record<string, unknown>[]): EventRecord {
  return {
    id,
    projectId: 'p1',
    objectiveId: 'o1',
    sessionId: 's1',
    category: 'AGENT',
    type: 'execution.attempt.progress',
    timestamp: `2026-08-19T19:11:${String(id).padStart(2, '0')}.000Z`,
    payload: {
      attemptId: 'a1',
      metadata: {
        ts: `2026-08-19T19:11:${String(id).padStart(2, '0')}.000Z`,
        type: 'agent_event',
        event: {
          type,
          contentType: 'tool',
          toolCallId,
          toolName,
          ...(type === 'content_start' ? { input: data } : { output: data }),
        },
      },
    },
  };
}

describe('ActivityMonitor worker timeline', () => {
  it('ricostruisce run team e picco di concorrenza da eventi persistiti', () => {
    const events = [
      event(1, 'team_run_task', 'call-1', 'content_start', { agentId: 'worker-a', taskId: 'task_0001', task: 'Build server' }),
      event(2, 'team_run_task', 'call-1', 'content_end', { runId: 'run_00001', agentId: 'worker-a', status: 'queued' }),
      event(3, 'team_run_task', 'call-2', 'content_start', { agentId: 'worker-b', taskId: 'task_0002', task: 'Build web' }),
      event(4, 'team_run_task', 'call-2', 'content_end', { runId: 'run_00002', agentId: 'worker-b', status: 'queued' }),
      event(5, 'team_list_runs', 'call-3', 'content_end', [
        { id: 'run_00001', agentId: 'worker-a', taskId: 'task_0001', status: 'completed', startedAt: '2026-08-19T19:11:14.000Z', endedAt: '2026-08-19T19:11:23.000Z' },
        { id: 'run_00002', agentId: 'worker-b', taskId: 'task_0002', status: 'completed', startedAt: '2026-08-19T19:11:15.000Z', endedAt: '2026-08-19T19:11:20.000Z' },
      ]),
    ];

    const runs = extractTeamRuns(events);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ id: 'run_00001', worker: 'worker-a', task: 'task_0001', status: 'completed', durationMs: 9_000, overlaps: ['run_00002'] });
    expect(runs[1]).toMatchObject({ id: 'run_00002', worker: 'worker-b', task: 'task_0002', status: 'completed', durationMs: 5_000, overlaps: ['run_00001'] });
    expect(calculatePeakConcurrency(runs)).toMatchObject({ peak: 2 });
  });
});
