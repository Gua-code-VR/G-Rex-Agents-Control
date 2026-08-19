import { useState, useRef, useEffect } from 'react';

export type MobileTab = 'control-room' | 'projects' | 'executions' | 'requires-you' | 'more';
export type MoreMenuItem = 'governance' | 'ai-catalog' | 'events-audit' | 'activity-monitor' | 'system' | 'settings';

interface MobileNavProps {
  activeTab: MobileTab | MoreMenuItem;
  onNavigate: (tab: MobileTab | MoreMenuItem) => void;
  pendingDecisions: number;
}

const MAIN_TABS: Array<{ key: MobileTab; icon: string; label: string }> = [
  { key: 'control-room', icon: '🎛️', label: 'Control' },
  { key: 'projects', icon: '📁', label: 'Progetti' },
  { key: 'executions', icon: '⚙️', label: 'Esecuzioni' },
  { key: 'requires-you', icon: '🔔', label: 'Richiede te' },
  { key: 'more', icon: '⋯', label: 'Altro' },
];

const MORE_ITEMS: Array<{ key: MoreMenuItem; icon: string; label: string }> = [
  { key: 'activity-monitor', icon: '📡', label: 'Monitor attività' },
  { key: 'governance', icon: '📊', label: 'Governance' },
  { key: 'ai-catalog', icon: '🤖', label: 'AI Catalog' },
  { key: 'events-audit', icon: '📜', label: 'Eventi / Audit' },
  { key: 'system', icon: '🖥️', label: 'Sistema' },
  { key: 'settings', icon: '⚙️', label: 'Impostazioni' },
];

/**
 * M7 — Navigazione mobile con barra in basso (§9).
 * Touch target minimo 44px, badge per decisioni pendenti.
 * Menu "Altro" per voci secondarie.
 */
export function MobileNav({ activeTab, onNavigate, pendingDecisions }: MobileNavProps) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Chiudi menu quando si clicca fuori
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (moreButtonRef.current && !moreButtonRef.current.contains(event.target as Node)) {
        if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
          setShowMoreMenu(false);
        }
      }
    };

    if (showMoreMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMoreMenu]);

  const handleTabClick = (tab: MobileTab) => {
    if (tab === 'more') {
      setShowMoreMenu(!showMoreMenu);
    } else {
      setShowMoreMenu(false);
      onNavigate(tab);
    }
  };

  const handleMoreItemClick = (item: MoreMenuItem) => {
    setShowMoreMenu(false);
    onNavigate(item);
  };

  const isMainTabActive = (tab: MobileTab) => activeTab === tab;
  const isMoreItemActive = (item: MoreMenuItem) => activeTab === item;

  return (
    <>
      <nav 
        className="bottom-nav" 
        role="navigation" 
        aria-label="Navigazione principale mobile"
      >
        {MAIN_TABS.map((tab) => (
          <button
            key={tab.key}
            ref={tab.key === 'more' ? moreButtonRef : undefined}
            type="button"
            className={`bottom-nav-item ${isMainTabActive(tab.key) ? 'active' : ''} ${tab.key === 'more' && showMoreMenu ? 'more-open' : ''}`}
            onClick={() => handleTabClick(tab.key)}
            aria-current={isMainTabActive(tab.key) ? 'page' : undefined}
            aria-expanded={tab.key === 'more' ? showMoreMenu : undefined}
            aria-haspopup={tab.key === 'more' ? 'true' : undefined}
          >
            <span className="bottom-nav-icon">{tab.icon}</span>
            <span className="bottom-nav-label">{tab.label}</span>
            {tab.key === 'requires-you' && pendingDecisions > 0 && (
              <span className="bottom-nav-badge" aria-label={`${pendingDecisions} decisioni pendenti`}>
                {pendingDecisions}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Menu "Altro" - overlay style per mobile */}
      {showMoreMenu && (
        <div className="more-menu-overlay" onClick={() => setShowMoreMenu(false)} aria-hidden="true">
          <div 
            className="more-menu" 
            ref={menuRef}
            role="menu"
            aria-label="Altre opzioni"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="more-menu-arrow" />
            {MORE_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={`more-menu-item ${isMoreItemActive(item.key) ? 'active' : ''}`}
                onClick={() => handleMoreItemClick(item.key)}
              >
                <span className="more-menu-icon">{item.icon}</span>
                <span className="more-menu-label">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
