import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('M1 - ExecutionAttempt persistence', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-ea-'));
  let built: BuiltApp;
  let projectId: string;
  let objectiveId: string;
  let sessionId: string;

  beforeAll(async () => {
    built = await buildApp(
      loadConfig({ GAC_DATA_DIR: dataDir, GAC_LOG_LEVEL: 'silent', GAC_AGENT_MODE: 'fake' }),
    );
    const projectRes = await built.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'ea-demo' },
    });
    projectId = projectRes.json().project.id;

    const objectiveRes = await built.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/objectives`,
      payload: {
        title: 'ExecutionAttempt foundation',
        objectiveText: 'Verify execution attempt persistence in the M1 supervisor.',
      },
    });
    objectiveId = objectiveRes.json().objective.id;
    sessionId = objectiveRes.json().session.id;
  });

  afterAll(async () => {
    await built.app.close();
    built.services.db.close();
  });

  it('crea un ExecutionAttempt quando la sessione viene avviata', async () => {
    const startRes = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/start`,
    });
    expect(startRes.statusCode).toBe(200);
    const { session } = startRes.json();
    expect(session.status).toBe('ATTIVA');
    expect(session.processReference).toContain('fake-');

    const attemptRow = built.services.db
      .prepare('SELECT * FROM execution_attempts WHERE session_id = ?')
      .get(sessionId) as { id: string; status: string; process_reference: string | null } | undefined;
    expect(attemptRow).toBeDefined();
    expect(attemptRow?.status).toBe('STARTED');
    expect(attemptRow?.process_reference).toBe(session.processReference);

    const eventRow = built.services.db
      .prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT 1')
      .get('execution.attempt.started') as { payload: string | null } | undefined;
    expect(eventRow).toBeDefined();
    expect(eventRow?.payload).toContain('attemptId');
  });

  it('chiude l’ExecutionAttempt quando la sessione viene fermata', async () => {
    const stopRes = await built.app.inject({
      method: 'POST',
      url: `/api/objectives/${objectiveId}/sessions/${sessionId}/stop`,
      payload: { reason: 'Stop di test della execution attempt' },
    });
    expect(stopRes.statusCode).toBe(200);
    const { session } = stopRes.json();
    expect(session.status).toBe('INTERROTTA');

    const attemptRow = built.services.db
      .prepare('SELECT * FROM execution_attempts WHERE session_id = ? ORDER BY attempt_index DESC LIMIT 1')
      .get(sessionId) as {
      id: string;
      status: string;
      ended_at: string | null;
      reason: string | null;
    } | undefined;
    expect(attemptRow).toBeDefined();
    expect(attemptRow?.status).toBe('CANCELLED');
    expect(attemptRow?.ended_at).toBeTruthy();
    expect(attemptRow?.reason).toBe('Stop di test della execution attempt');
  });
});
