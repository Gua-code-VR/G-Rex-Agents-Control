import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config — bind address esplicito (Tailscale/VPN)', () => {
  it('usa il loopback di default senza variabili', () => {
    expect(loadConfig({}).bindAddress).toBe('127.0.0.1');
  });

  it('accetta un bind address esplicito', () => {
    expect(loadConfig({ GAC_BIND_ADDRESS: '0.0.0.0' }).bindAddress).toBe('0.0.0.0');
    expect(loadConfig({ GAC_BIND_ADDRESS: '100.64.0.2' }).bindAddress).toBe('100.64.0.2');
  });

  it('mantiene GAC_BIND_ALL come alias booleano per 0.0.0.0', () => {
    expect(loadConfig({ GAC_BIND_ALL: 'true' }).bindAddress).toBe('0.0.0.0');
    expect(loadConfig({ GAC_BIND_ALL: 'false' }).bindAddress).toBe('127.0.0.1');
  });

  it('mantiene GAC_HOST come alias legacy', () => {
    expect(loadConfig({ GAC_HOST: '192.168.1.5' }).bindAddress).toBe('192.168.1.5');
  });

  it('risolve la precedenza GAC_BIND_ADDRESS > GAC_BIND_ALL > GAC_HOST', () => {
    expect(loadConfig({ GAC_BIND_ADDRESS: '10.0.0.1', GAC_BIND_ALL: 'true', GAC_HOST: '192.168.1.5' }).bindAddress).toBe('10.0.0.1');
    expect(loadConfig({ GAC_BIND_ALL: 'true', GAC_HOST: '192.168.1.5' }).bindAddress).toBe('0.0.0.0');
  });

  it('configura il limite del workflow multi-worker nativo entro limiti sicuri', () => {
    expect(loadConfig({}).nativeWorkflowMaxWorkers).toBe(4);
    expect(loadConfig({}).nativeWorkflowRuntimeIds).toEqual(['cline']);
    expect(loadConfig({ GAC_NATIVE_WORKFLOW_MAX_WORKERS: '99', GAC_NATIVE_WORKFLOW_RUNTIMES: 'codex, cline ' })).toMatchObject({
      nativeWorkflowEnabled: true,
      nativeWorkflowMaxWorkers: 4,
      nativeWorkflowRuntimeIds: ['codex', 'cline'],
    });
    expect(loadConfig({ GAC_NATIVE_WORKFLOW_ENABLED: 'false' }).nativeWorkflowEnabled).toBe(false);
  });
  it('espone la modalita di autenticazione corrente della CLI Codex (GAC_CODEX_AUTH), default api-key', () => {
    expect(loadConfig({}).codexAuth).toBe('api-key');
    expect(loadConfig({ GAC_CODEX_AUTH: 'chatgpt' }).codexAuth).toBe('chatgpt');
    expect(loadConfig({ GAC_CODEX_AUTH: 'ChatGPT' }).codexAuth).toBe('chatgpt');
    expect(loadConfig({ GAC_CODEX_AUTH: 'api-key' }).codexAuth).toBe('api-key');
    expect(loadConfig({ GAC_CODEX_AUTH: 'sconosciuto' }).codexAuth).toBe('api-key');
  });

});
