import { execFile } from 'node:child_process';
import type { GitStatus } from '../../domain/project.js';

interface RunResult {
  stdout: string;
  stderr: string;
}

function runGit(repositoryPath: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: repositoryPath,
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Legge lo stato Git essenziale (§5/§6-SYSTEM) di un repository locale:
 * ramo corrente, HEAD breve, dirty state, conteggio ahead/behind verso
 * l'upstream e ultimo commit. Non esegue alcun comando scritto da altri:
 * solo letture (git status, rev-parse, rev-list, log).
 */
export async function readGitStatus(repositoryPath: string): Promise<GitStatus> {
  const status: GitStatus = {
    fetchedAt: new Date().toISOString(),
    branch: null,
    head: null,
    dirty: false,
    ahead: null,
    behind: null,
    lastCommit: null,
    lastCommitAt: null,
    error: null,
  };

  try {
    const probe = await runGit(repositoryPath, ['rev-parse', '--is-inside-work-tree']);
    if (probe.stdout.trim() !== 'true') {
      status.error = 'Il percorso configurato non è un repository Git valido';
      return status;
    }
  } catch (err) {
    status.error = `Impossibile leggere il repository: ${errorMessage(err)}`;
    return status;
  }

  try {
    const branch = (await runGit(repositoryPath, ['branch', '--show-current'])).stdout.trim();
    status.branch = branch || null;
  } catch {
    // ramo non determinabile (es. detached): resta null
  }
  if (!status.branch) {
    try {
      const ref = (await runGit(repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
      status.branch = ref === 'HEAD' ? '(detached)' : ref || null;
    } catch {
      // repository senza commit: il ramo resterà null
    }
  }

  try {
    status.head = (await runGit(repositoryPath, ['rev-parse', '--short', 'HEAD'])).stdout.trim() || null;
  } catch {
    // nessun commit ancora
  }

  try {
    const lines = (await runGit(repositoryPath, ['status', '--porcelain'])).stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    status.dirty = lines.length > 0;
  } catch {
    // non determinabile: resta default
  }

  try {
    const counts = (
      await runGit(repositoryPath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    ).stdout
      .trim()
      .split(/\s+/);
    status.ahead = Number(counts[0]) || 0;
    status.behind = Number(counts[1]) || 0;
  } catch {
    // nessun upstream configurato: resta null
  }

  try {
    const log = (
      await runGit(repositoryPath, ['log', '-1', '--format=%s%x1F%cI'])
    ).stdout.trim();
    const [subject, date] = log.split(String.fromCharCode(0x1f));
    status.lastCommit = subject?.trim() || null;
    status.lastCommitAt = date?.trim() || null;
  } catch {
    // nessun commit ancora
  }

  return status;
}