import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('viewport mobile (§16 V2)', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

  it('dichiara una viewport responsive per mobile', () => {
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
    expect(html).toContain('initial-scale=1.0');
  });

  it('ha un breakpoint mobile attivo', () => {
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*639px\s*\)/);
  });

  it('su mobile ordina «Richiede te» prima del monitoraggio passivo (§2/§5)', () => {
    expect(css.toLowerCase()).toContain('richiede te');
    expect(css.toLowerCase()).toContain('monitoraggio passivo');
  });
});
