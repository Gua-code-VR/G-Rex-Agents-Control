import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('navigazione e layout notifiche', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'src', 'components', 'AppShell.tsx'), 'utf8');

  it('renderizza il pannello Notifiche solo nella Control Room', () => {
    const controlRoomStart = app.indexOf("activeTab === 'control-room'");
    const projectsStart = app.indexOf("activeTab === 'projects'");
    const notificationsPanel = app.indexOf('<h2>Notifiche ({notifications.length})</h2>');

    expect(controlRoomStart).toBeGreaterThan(-1);
    expect(projectsStart).toBeGreaterThan(controlRoomStart);
    expect(notificationsPanel).toBeGreaterThan(controlRoomStart);
    expect(notificationsPanel).toBeLessThan(projectsStart);
  });

  it('mantiene nell header solo la campanella con badge per le azioni pendenti', () => {
    expect(shell).toContain('pending-decisions-btn');
    expect(shell).toContain('notification-badge');
    expect(shell).not.toContain('<h2>Notifiche');
  });
});
