import type { GitStatus, Project } from '../domain/project.js';
import type { ProjectRepository } from '../infrastructure/db/project-repo.js';
import { readGitStatus } from '../infrastructure/git/git-status-reader.js';
import type { EventService } from './event-service.js';

export const EVENT_GIT_STATUS_REFRESHED = 'project.git_status.refreshed';
export const EVENT_GIT_STATUS_ERROR = 'project.git_status.error';

/** Errore applicativo per richieste non valide (es. repository non configurato). */
export class GitRefreshError extends Error {}

/**
 * Stato Git essenziale (§5): legge ramo/HEAD/dirty state dal repository
 * reale (evidenza SYSTEM, §6) e ne rende ufficiale lo snapshot dentro
 * Agent Control, in modo che sopravviva ai riavvii. Non tocca l'agente:
 * l'integrazione operativa resta a M3+.
 */
export class GitStatusService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly events: EventService,
  ) {}

  async refresh(projectId: string): Promise<Project | null> {
    const project = this.projects.getById(projectId);
    if (!project) return null;
    if (!project.repositoryPath) {
      throw new GitRefreshError('Nessun percorso repository configurato per questo progetto');
    }

    const snapshot = await readGitStatus(project.repositoryPath);
    this.projects.updateGitSnapshot(projectId, snapshot);
    this.events.log(snapshot.error ? EVENT_GIT_STATUS_ERROR : EVENT_GIT_STATUS_REFRESHED, {
      projectId,
      payload: {
        branch: snapshot.branch,
        head: snapshot.head,
        dirty: snapshot.dirty,
        error: snapshot.error,
      },
    });

    return this.projects.getById(projectId);
  }

  /**
   * Legge uno snapshot Git immediato senza aggiornare il progetto (§5):
   * usato come evidenza di inizio/fine lavoro durante il ciclo obiettivo.
   * Restituisce null se il progetto non esiste o non ha repository.
   */
  async readSnapshot(projectId: string): Promise<GitStatus | null> {
    const project = this.projects.getById(projectId);
    if (!project || !project.repositoryPath) return null;
    return readGitStatus(project.repositoryPath);
  }
}