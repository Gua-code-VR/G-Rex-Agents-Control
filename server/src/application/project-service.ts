import type {
  CreateProjectInput,
  Project,
  ProjectStatus,
  UpdateProjectInput,
} from '../domain/project.js';
import {
  createProjectInputSchema,
  projectStatusGroup,
  setProjectStatusSchema,
  updateProjectSchema,
} from '../domain/project.js';
import type { ProjectRepository } from '../infrastructure/db/project-repo.js';
import type { EventService } from './event-service.js';

export const EVENT_PROJECT_CREATED = 'project.created';
export const EVENT_PROJECT_UPDATED = 'project.updated';
export const EVENT_PROJECT_STATUS_CHANGED = 'project.status_changed';
export const EVENT_PROJECT_READ = 'project.read';
export const EVENT_PROJECTS_LISTED = 'projects.listed';
export const EVENT_APP_STARTED = 'app.started';
export const EVENT_APP_STOPPED = 'app.stopped';

/**
 * Project Registry (§7): registrazione, aggiornamento, lettura e stato
 * operativo dei progetti. La validazione con Zod è la fonte normativa;
 * lo stato ufficiale appartiene ad Agent Control (§5) e ogni transizione
 * viene registrata nello State & Event Store.
 */
export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly events: EventService,
  ) {}

  register(input: unknown): Project {
    const parsed = createProjectInputSchema.parse(input) as CreateProjectInput;
    const project = this.projects.create(parsed);
    this.events.log(EVENT_PROJECT_CREATED, {
      projectId: project.id,
      payload: {
        name: project.name,
        repositoryPath: project.repositoryPath,
        hasObjective: project.currentObjective !== null,
      },
    });
    return project;
  }

  list(): Project[] {
    const all = this.projects.list();
    this.events.log(EVENT_PROJECTS_LISTED, { payload: { count: all.length } });
    return all;
  }

  getById(id: string): Project | null {
    const project = this.projects.getById(id);
    if (project) {
      this.events.log(EVENT_PROJECT_READ, { projectId: project.id });
    }
    return project;
  }

  /** Aggiorna repository_path e/o obiettivo corrente del progetto. */
  update(id: string, input: unknown): Project | null {
    const parsed = updateProjectSchema.parse(input) as UpdateProjectInput;
    const updated = this.projects.update(id, parsed);
    if (updated) {
      this.events.log(EVENT_PROJECT_UPDATED, {
        projectId: updated.id,
        payload: {
          repositoryPath: updated.repositoryPath,
          currentObjective: updated.currentObjective,
        },
      });
    }
    return updated;
  }

  /** Imposta lo stato operativo ufficiale e registra la transizione. */
  setStatus(id: string, input: unknown): Project | null {
    const parsed = setProjectStatusSchema.parse(input);
    const current = this.projects.getById(id);
    if (!current) return null;
    const updated = this.projects.setStatus(id, parsed.status as ProjectStatus);
    if (updated) {
      this.events.log(EVENT_PROJECT_STATUS_CHANGED, {
        projectId: updated.id,
        payload: {
          from: current.status,
          to: updated.status,
          fromGroup: projectStatusGroup(current.status),
          toGroup: projectStatusGroup(updated.status),
        },
      });
    }
    return updated;
  }

  /**
   * Allinea l'obiettivo corrente denormalizzato del progetto (§5): viene
   * chiamato dal ciclo obiettivo (M3) quando un Objective viene creato,
   * cancellato o subentra come corrente. Aggiorna sia il testo sia l'id
   * della relazione current_objective_id.
   */
  setCurrentObjective(id: string, objectiveId: string | null, title: string | null): Project | null {
    const updated = this.projects.setCurrentObjective(id, objectiveId, title);
    if (updated) {
      this.events.log(EVENT_PROJECT_UPDATED, {
        projectId: updated.id,
        payload: {
          currentObjectiveId: updated.currentObjectiveId,
          currentObjective: updated.currentObjective,
        },
      });
    }
    return updated;
  }
}