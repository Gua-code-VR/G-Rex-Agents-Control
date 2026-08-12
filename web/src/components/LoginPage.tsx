import { useState, type FormEvent } from 'react';
import { api } from '../api/client';

/**
 * M7 — Pagina di login / setup password (§8, §10).
 *
 * Se la password non è ancora impostata, mostra il form di setup.
 * Altrimenti, mostra il form di login.
 */
export function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [isSetup, setIsSetup] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Verifica stato auth all'avvio
  if (isSetup === null) {
    void api.authStatus().then((status) => {
      setIsSetup(!status.passwordSet);
    });
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">🦖</div>
          <p className="muted">Caricamento...</p>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('La password deve avere almeno 6 caratteri.');
      return;
    }

    if (isSetup && password !== confirmPassword) {
      setError('Le password non coincidono.');
      return;
    }

    setBusy(true);
    try {
      if (isSetup) {
        await api.authSetup(password);
      } else {
        await api.authLogin(password);
      }
      onAuthenticated();
    } catch {
      setError(isSetup ? 'Errore durante il setup.' : 'Credenziali non valide.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">🦖</div>
        <h1 className="login-title">G-Rex Agent Control</h1>
        <p className="login-subtitle">
          {isSetup ? 'Imposta la password di amministrazione' : 'Accedi per continuare'}
        </p>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Almeno 6 caratteri"
              autoFocus
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              disabled={busy}
            />
          </label>

          {isSetup && (
            <label className="login-field">
              <span>Conferma password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Ripeti la password"
                autoComplete="new-password"
                disabled={busy}
              />
            </label>
          )}

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="btn btn-primary login-btn" disabled={busy}>
            {busy ? 'Attendere...' : isSetup ? 'Imposta password' : 'Accedi'}
          </button>
        </form>
      </div>
    </div>
  );
}
