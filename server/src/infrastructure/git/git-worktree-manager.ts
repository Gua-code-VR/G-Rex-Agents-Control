import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * GitWorktreeManager (§19 V2): operazioni Git di basso livello per la
 * gestione delle workspace isolate. Nessuna logica di business: l'uso e
 * le decisioni appartengono a WorktreeService. Solo comandi Git non
 * interattivi (GIT_TERMINAL_PROMPT=0) con timeout applicativo.
 */

interface RunResult {
  stdout: string;
  stderr: string;
  /** Codice di uscita del processo, null se non determinabile (es. timeout). */
  status: number | null;
}

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          // Le workspace sono locali: nessuna fetch/push, nessun prompt.
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.autocrlf',
          GIT_CONFIG_VALUE_0: process.platform === 'win32' ? 'true' : 'false',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? (error as unknown as { code: number }).code
            : null;
          resolve({ stdout, stderr, status: code });
        } else {
          resolve({ stdout, stderr, status: 0 });
        }
      },
    );
  });
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** Nome del branch senza prefisso `refs/heads/`; null su detached HEAD. */
  branch: string | null;
}

export interface MergeResult {
  ok: boolean;
  /** 'up-to-date' | 'merged' | 'conflict' | 'error'. */
  result: string;
  error: string | null;
}

const GIT_AUTHOR = ['-c', 'user.name=G-Rex Agent Control', '-c', 'user.email=agent-control@g-rex.local'];

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Confronto case-insensitive dei percorsi su Windows (worktree path). */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

export class GitWorktreeManager {
  constructor(private readonly timeoutMs = 30_000) {}

  /** True se il percorso è dentro un working tree Git valido. */
  async verifyRepository(repositoryPath: string): Promise<boolean> {
    const probe = await runGit(repositoryPath, ['rev-parse', '--is-inside-work-tree'], this.timeoutMs);
    return probe.status === 0 && probe.stdout.trim() === 'true';
  }

  /** Stato della working tree: clean = nessuna modifica tracciata o untracked. */
  async isClean(repositoryPath: string): Promise<{ clean: boolean; dirtyPaths: string[] }> {
    const status = await runGit(repositoryPath, ['status', '--porcelain', '--untracked-files=normal'], this.timeoutMs);
    const dirtyPaths = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return { clean: status.status === 0 && dirtyPaths.length === 0, dirtyPaths };
  }

  async headSha(repositoryPath: string): Promise<string | null> {
    const rev = await runGit(repositoryPath, ['rev-parse', 'HEAD'], this.timeoutMs);
    return rev.status === 0 ? rev.stdout.trim() || null : null;
  }

  /** Branch corrente della working tree; null su detached HEAD o errore. */
  async currentBranch(repositoryPath: string): Promise<string | null> {
    const show = await runGit(repositoryPath, ['branch', '--show-current'], this.timeoutMs);
    if (show.status === 0 && show.stdout.trim()) return show.stdout.trim();
    const symbolic = await runGit(repositoryPath, ['symbolic-ref', '--short', '-q', 'HEAD'], this.timeoutMs);
    return symbolic.status === 0 && symbolic.stdout.trim() ? symbolic.stdout.trim() : null;
  }

  /** Elenca i worktree del repository (git worktree list --porcelain). */
  async listWorktrees(repositoryPath: string): Promise<WorktreeEntry[]> {
    const result = await runGit(repositoryPath, ['worktree', 'list', '--porcelain'], this.timeoutMs);
    if (result.status !== 0) return [];
    const entries: WorktreeEntry[] = [];
    let current: Partial<WorktreeEntry> | null = null;
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        if (current?.path) entries.push(current as WorktreeEntry);
        current = null;
        continue;
      }
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length).trim(), head: null, branch: null };
      } else if (line.startsWith('HEAD ')) {
        if (current) current.head = line.slice('HEAD '.length).trim() || null;
      } else if (line.startsWith('branch refs/heads/')) {
        if (current) current.branch = line.slice('branch refs/heads/'.length).trim();
      }
      // `detached` e `prunable` vengono ignorati: non servono qui.
    }
    if (current?.path) entries.push(current as WorktreeEntry);
    return entries;
  }

  /** True se esiste un worktree registrato al percorso indicato. */
  async worktreeExists(repositoryPath: string, worktreePath: string): Promise<boolean> {
    const entries = await this.listWorktrees(repositoryPath);
    return entries.some((entry) => samePath(entry.path, worktreePath));
  }

  /** True se il branch (refs/heads/<branch>) esiste nel repository. */
  async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    const ref = await runGit(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.timeoutMs);
    return ref.status === 0;
  }

  /** Crea un worktree con un nuovo branch dedicato (git worktree add -b). */
  async createBranchWorktree(repositoryPath: string, branch: string, worktreePath: string): Promise<void> {
    const result = await runGit(repositoryPath, ['worktree', 'add', '-b', branch, worktreePath], this.timeoutMs);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `git worktree add fallito (exit ${result.status})`);
    }
  }

  /** Aggiunge un worktree su un branch già esistente (recovery da crash). */
  async addWorktreeToBranch(repositoryPath: string, branch: string, worktreePath: string): Promise<void> {
    const result = await runGit(repositoryPath, ['worktree', 'add', worktreePath, branch], this.timeoutMs);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `git worktree add <branch> fallito (exit ${result.status})`);
    }
  }


  /**
   * Committa ogni modifica presente nel worktree sul suo branch. Usa
   * un'identità GAC (evidenza SYSTEM) così il commit non dipende dalla
   * configurazione Git dell'utente. Restituisce true se è stato creato
   * un nuovo commit.
   */
  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    const status = await runGit(worktreePath, ['status', '--porcelain', '--untracked-files=normal'], this.timeoutMs);
    if (status.status !== 0 || status.stdout.trim().length === 0) return false;
    const add = await runGit(worktreePath, ['add', '-A'], this.timeoutMs);
    if (add.status !== 0) {
      throw new Error(add.stderr.trim() || 'git add -A fallito');
    }
    const commit = await runGit(
      worktreePath,
      [...GIT_AUTHOR, 'commit', '-m', message],
      this.timeoutMs,
    );
    if (commit.status !== 0) {
      throw new Error(commit.stderr.trim() || 'git commit fallito');
    }
    return true;
  }

  /**
   * Integra il branch dedicato nella working tree principale con un merge
   * deterministico (--no-ff). Condizione richiesta: main pulito (verificato
   * dal chiamante). Un conflitto Git reale restituisce ok=false e il lavoro
   * resta preservato sul branch.
   */
  async mergeBranch(repositoryPath: string, branch: string): Promise<MergeResult> {
    const merge = await runGit(
      repositoryPath,
      [...GIT_AUTHOR, 'merge', '--no-ff', '-m', `GAC: integra lavoro obiettivo (${branch})`, branch],
      this.timeoutMs,
    );
    const combined = `${merge.stdout}\n${merge.stderr}`;
    if (merge.status === 0) {
      const result = /already up to date/i.test(combined) ? 'up-to-date' : 'merged';
      return { ok: true, result, error: null };
    }
    const isConflict = /CONFLICT|Merge conflict/i.test(combined);
    return {
      ok: false,
      result: isConflict ? 'conflict' : 'error',
      error: merge.stderr.trim() || merge.stdout.trim() || `git merge fallito (exit ${merge.status})`,
    };
  }

  /**
   * Rimuove il worktree (git worktree remove). Con force=true procede anche
   * con modifiche non committate. Un worktree già assente non è un errore.
   */
  async removeWorktree(repositoryPath: string, worktreePath: string, force = false): Promise<void> {
    if (!(await this.worktreeExists(repositoryPath, worktreePath))) return;
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);
    const result = await runGit(repositoryPath, args, this.timeoutMs);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `git worktree remove fallito (exit ${result.status})`);
    }
  }
}

