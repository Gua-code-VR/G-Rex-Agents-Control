import { useState, type FormEvent } from 'react';
import { api } from '../api/client';

interface SettingsPageProps {
  onLogout: () => void;
  version: string;
}

/**
 * M7 — Pagina Impostazioni (§9, §10).
 *
 * Cambio password, informazioni server, disconnessione.
 * Ottimizzata per touch: pulsanti grandi, layout compatto.
 */
export function SettingsPage({ onLogout, version }: SettingsPageProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNew, setConfirmNew] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setMessage('');
    setError('');

    if (newPassword.length < 6) {
      setError('La nuova password deve avere almeno 6 caratteri.');
      return;
    }
    if (newPassword !== confirmNew) {
      setError('Le nuove password non coincidono.');
      return;
    }

    setBusy(true);
    try {
      await api.authChangePassword(currentPassword, newPassword);
      setMessage('Password cambiata con successo.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNew('');
    } catch {
      setError('Password corrente non valida.');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.authLogout();
    } finally {
      onLogout();
    }
  };

  return (
    <div className="settings-page">
      <h2 className="settings-title">⚙️ Impostazioni</h2>

      {/* Cambio password */}
      <section className="settings-section">
        <h3 className="settings-section-title">Sicurezza</h3>
        <form onSubmit={handleChangePassword} className="settings-form">
          <label className="settings-field">
            <span>Password corrente</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Password attuale"
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
          <label className="settings-field">
            <span>Nuova password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Almeno 6 caratteri"
              autoComplete="new-password"
              disabled={busy}
            />
          </label>
          <label className="settings-field">
            <span>Conferma nuova password</span>
            <input
              type="password"
              value={confirmNew}
              onChange={(e) => setConfirmNew(e.target.value)}
              placeholder="Ripeti la nuova password"
              autoComplete="new-password"
              disabled={busy}
            />
          </label>
          {message && <p className="settings-success">{message}</p>}
          {error && <p className="settings-error">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Attendere...' : 'Cambia password'}
          </button>
        </form>
      </section>

      {/* Informazioni server */}
      <section className="settings-section">
        <h3 className="settings-section-title">Server</h3>
        <div className="settings-info">
          <div className="settings-info-row">
            <span className="settings-info-label">Versione</span>
            <span className="settings-info-value">{version}</span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">Modalità</span>
            <span className="settings-info-value">Locale / VPN</span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">Protocollo</span>
            <span className="settings-info-value">HTTP (via Tailscale)</span>
          </div>
        </div>
      </section>

      {/* Disconnessione */}
      <section className="settings-section">
        <h3 className="settings-section-title">Sessione</h3>
        <button
          type="button"
          className="btn btn-danger settings-logout-btn"
          onClick={handleLogout}
        >
          🔒 Disconnetti
        </button>
        <p className="muted small" style={{ marginTop: '0.5rem' }}>
          Dopo la disconnessione sarai reindirizzato alla pagina di accesso.
        </p>
      </section>
    </div>
  );
}
