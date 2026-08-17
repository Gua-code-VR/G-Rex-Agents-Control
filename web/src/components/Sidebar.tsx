import { useState } from 'react';

export type NavSection = 
  | 'control-room' 
  | 'projects' 
  | 'objectives' 
  | 'executions' 
  | 'requires-you'
  | 'governance' 
  | 'ai-catalog' 
  | 'events-audit' 
  | 'system' 
  | 'settings';

interface SidebarProps {
  id?: string;
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  pendingDecisions: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const PRIMARY_NAV: Array<{ key: NavSection; icon: string; label: string; badge?: number }> = [
  { key: 'control-room', icon: '🎛️', label: 'Control Room' },
  { key: 'projects', icon: '📁', label: 'Progetti' },
  { key: 'objectives', icon: '🎯', label: 'Obiettivi' },
  { key: 'executions', icon: '⚙️', label: 'Esecuzioni' },
  { key: 'requires-you', icon: '🔔', label: 'Richiede te', badge: 0 }, // badge will be overridden
];

const SECONDARY_NAV: Array<{ key: NavSection; icon: string; label: string }> = [
  { key: 'governance', icon: '📊', label: 'Governance' },
  { key: 'ai-catalog', icon: '🤖', label: 'AI Catalog' },
  { key: 'events-audit', icon: '📜', label: 'Eventi / Audit' },
  { key: 'system', icon: '🖥️', label: 'Sistema' },
  { key: 'settings', icon: '⚙️', label: 'Impostazioni' },
];

export function Sidebar({ 
  id,
  activeSection, 
  onNavigate, 
  pendingDecisions, 
  collapsed = false,
  onToggleCollapse 
}: SidebarProps) {
  const [hovered, setHovered] = useState<NavSection | null>(null);

  const renderNavItem = (item: { key: NavSection; icon: string; label: string; badge?: number }) => {
    const isActive = activeSection === item.key;
    const badge = item.key === 'requires-you' ? pendingDecisions : (item.badge ?? 0);
    
    return (
      <button
        key={item.key}
        type="button"
        className={`nav-item ${isActive ? 'active' : ''} ${collapsed && !hovered && !isActive ? 'collapsed' : ''}`}
        onClick={() => onNavigate(item.key)}
        onMouseEnter={() => setHovered(item.key)}
        onMouseLeave={() => setHovered(null)}
        aria-current={isActive ? 'page' : undefined}
        title={collapsed && !isActive ? item.label : undefined}
      >
        <span className="nav-icon">{item.icon}</span>
        {!collapsed || isActive || hovered === item.key ? (
          <span className="nav-label">{item.label}</span>
        ) : null}
        {badge > 0 && (
          <span className="nav-badge">{badge}</span>
        )}
      </button>
    );
  };

  return (
    <aside id={id} className={`app-sidebar ${collapsed ? 'collapsed' : ''}`} role="navigation" aria-label="Navigazione principale">
      <div className="sidebar-header">
        {!collapsed && (
          <div className="sidebar-brand">
            <span className="brand-mark">🦖</span>
            <span className="brand-text">G-Rex Control</span>
          </div>
        )}
        {collapsed && onToggleCollapse && (
          <button 
            type="button" 
            className="sidebar-toggle" 
            onClick={onToggleCollapse}
            aria-label="Espandi sidebar"
            aria-expanded={!collapsed}
          >
            ☰
          </button>
        )}
      </div>
      
      <nav className="sidebar-nav">
        <div className="nav-section primary">
          {!collapsed && <h3 className="nav-section-title">PRINCIPALE</h3>}
          {PRIMARY_NAV.map(item => renderNavItem({ ...item, badge: item.key === 'requires-you' ? pendingDecisions : item.badge }))}
        </div>
        
        <div className="nav-section secondary">
          {!collapsed && <h3 className="nav-section-title">SECONDARIO</h3>}
          {SECONDARY_NAV.map(item => renderNavItem(item))}
        </div>
      </nav>
      
      <div className="sidebar-footer">
        {!collapsed && (
          <div className="system-status">
            <span className="status-indicator ok" aria-label="Sistema OK">●</span>
            <span className="status-text">Sistema OK</span>
          </div>
        )}
      </div>
    </aside>
  );
}