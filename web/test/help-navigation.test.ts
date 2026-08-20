import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_TOPIC_IDS, HELP_TOPICS } from '../src/content/help';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => fs.readFileSync(path.join(root, 'src', ...relative.split('/')), 'utf8');

describe('Help integrato', () => {
  it('espone Help nella navigazione desktop, mobile e nella route interna', () => {
    expect(read('components/Sidebar.tsx')).toContain("key: 'help'");
    expect(read('components/MobileNav.tsx')).toContain("key: 'help'");
    expect(read('App.tsx')).toContain("activeTab === 'help'");
    expect(read('App.tsx')).toContain('<HelpView activeTopic={helpTopic}');
  });

  it('mantiene una sola fonte contenuti per tutti gli argomenti richiesti', () => {
    expect(HELP_TOPICS.map((topic) => topic.id)).toEqual([...HELP_TOPIC_IDS]);
    expect(HELP_TOPICS.every((topic) => topic.title && topic.summary && topic.body.length > 0)).toBe(true);
    expect(HELP_TOPIC_IDS).toEqual([
      'primo-avvio',
      'progetti',
      'obiettivi',
      'runtime-provider-modello',
      'richiede-te',
      'monitor-attivita',
      'retry-fallback',
      'costi-budget',
      'native-workflow',
      'errori-comuni',
      'configurazione',
    ]);
  });

  it('collega le schermate complesse agli argomenti pertinenti', () => {
    const sources = [
      read('components/ControlRoom.tsx'),
      read('components/ProjectView.tsx'),
      read('components/ObjectiveView.tsx'),
      read('components/RequiresYouView.tsx'),
      read('components/ActivityMonitorView.tsx'),
      read('components/AiCatalogView.tsx'),
      read('components/SystemView.tsx'),
    ].join('\n');

    for (const topic of ['primo-avvio', 'progetti', 'obiettivi', 'runtime-provider-modello', 'richiede-te', 'monitor-attivita', 'retry-fallback', 'costi-budget', 'native-workflow', 'errori-comuni', 'configurazione']) {
      expect(sources).toContain(`topic="${topic}"`);
    }
  });
});
