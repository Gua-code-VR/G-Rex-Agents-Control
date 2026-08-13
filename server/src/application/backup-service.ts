import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { EventService } from './event-service.js';

export interface BackupResult { directory: string; createdAt: string; files: string[]; }

/** Local, timestamped backup of the durable control-plane state and a safe config report. */
export class BackupService {
  constructor(private readonly config: AppConfig, private readonly events: EventService) {}

  create(): BackupResult {
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[:.]/g, '-');
    const directory = path.join(this.config.dataDir, 'backups', stamp);
    fs.mkdirSync(directory, { recursive: true });
    const files: string[] = [];
    if (fs.existsSync(this.config.dbPath)) {
      const database = path.join(directory, 'gac.sqlite');
      fs.copyFileSync(this.config.dbPath, database);
      files.push(path.basename(database));
    }
    const report = path.join(directory, 'report.json');
    fs.writeFileSync(report, JSON.stringify({ createdAt, schema: 7, database: path.basename(this.config.dbPath) }, null, 2));
    files.push(path.basename(report));
    const configuration = path.join(directory, 'config.json');
    fs.writeFileSync(configuration, JSON.stringify({
      host: this.config.host, port: this.config.port, defaultRuntime: this.config.defaultRuntime,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs, staleCheckIntervalMs: this.config.staleCheckIntervalMs,
    }, null, 2));
    files.push(path.basename(configuration));
    this.events.log('backup.created', { category: 'TECHNICAL', payload: { directory, files } });
    return { directory, createdAt, files };
  }
}
