import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('navigazione e layout notifiche', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'src', 'components', 'AppShell.tsx'), 'utf8');

  it('non renderizza alcun pannello Notifiche', () => {
    expect(app).not.toContain('<h2>Notifiche');
    expect(app).not.toContain('markNotificationsRead');
    expect(app).not.toContain('listNotifications');

    // il tab control-room non rende alcun pannello Notifiche
    const controlRoomStart = app.indexOf("activeTab === 'control-room'");
    const projectsStart = app.indexOf("activeTab === 'projects'");
    expect(controlRoomStart).toBeGreaterThan(-1);
    expect(projectsStart).toBeGreaterThan(controlRoomStart);

    const controlRoomBlock = app.slice(controlRoomStart, projectsStart);
    expect(controlRoomBlock).not.toContain('Notifiche');
  });

  it('mantiene nell header solo la campanella con badge per le azioni pendenti', () => {
    expect(shell).toContain('pending-decisions-btn');
    expect(shell).toContain('notification-badge');
    expect(shell).not.toContain('<h2>Notifiche');
  });
});
