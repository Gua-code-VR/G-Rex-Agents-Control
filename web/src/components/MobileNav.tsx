export type MobileTab = 'home' | 'projects' | 'history' | 'settings';

interface MobileNavProps {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
  pendingDecisions: number;
}

const TABS: Array<{ key: MobileTab; icon: string; label: string }> = [
  { key: 'home', icon: '🏠', label: 'Home' },
  { key: 'projects', icon: '📁', label: 'Progetti' },
  { key: 'history', icon: '📜', label: 'Storico' },
  { key: 'settings', icon: '⚙️', label: 'Impostazioni' },
];

/**
 * M7 — Navigazione mobile con barra in basso (§9).
 * Touch target minimo 44px, badge per decisioni pendenti.
 */
export function MobileNav({ active, onChange, pendingDecisions }: MobileNavProps) {
  return (
    <nav className="bottom-nav" role="navigation" aria-label="Navigazione principale">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={`bottom-nav-item ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
          aria-current={active === tab.key ? 'page' : undefined}
        >
          <span className="bottom-nav-icon">{tab.icon}</span>
          <span className="bottom-nav-label">{tab.label}</span>
          {tab.key === 'home' && pendingDecisions > 0 && (
            <span className="bottom-nav-badge">{pendingDecisions}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
