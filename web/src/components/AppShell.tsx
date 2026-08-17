import { useState, useEffect } from 'react';
import { Sidebar, type NavSection } from './Sidebar';
import { MobileNav, type MobileTab, type MoreMenuItem } from './MobileNav';
import { RightDrawer } from './RightDrawer';

interface AppShellProps {
  children: React.ReactNode;
  activeSection: NavSection | MobileTab | MoreMenuItem;
  onNavigate: (section: NavSection | MobileTab | MoreMenuItem) => void;
  pendingDecisions: number;
  costToday?: number | null;
  rightDrawerTitle?: string;
  rightDrawerContent?: React.ReactNode;
  rightDrawerOpen?: boolean;
  onCloseRightDrawer?: () => void;
  headerActions?: React.ReactNode;
}

export function AppShell({
  children,
  activeSection,
  onNavigate,
  pendingDecisions,
  costToday,
  rightDrawerTitle = 'Richiede il tuo intervento',
  rightDrawerContent,
  rightDrawerOpen = false,
  onCloseRightDrawer,
  headerActions,
}: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkBreakpoints = () => {
      const width = window.innerWidth;
      setIsMobile(width < 640);
      
      if (width >= 640 && width < 1024) {
        setSidebarCollapsed(true);
      } else if (width >= 1024) {
        setSidebarCollapsed(false);
      }
    };

    checkBreakpoints();
    window.addEventListener('resize', checkBreakpoints);
    return () => window.removeEventListener('resize', checkBreakpoints);
  }, []);

  const toggleSidebar = () => setSidebarCollapsed(!sidebarCollapsed);

  const showSidebar = !isMobile;
  const showBottomNav = isMobile;

  const sidebarActiveSection = showSidebar ? activeSection : 'control-room';
  const mobileActiveTab = showBottomNav ? activeSection : 'control-room';

  return (
    <div className="app-shell">
      <AppHeader 
        showSidebar={showSidebar}
        isMobile={isMobile}
        sidebarCollapsed={sidebarCollapsed}
        toggleSidebar={toggleSidebar}
        pendingDecisions={pendingDecisions}
        onNavigate={onNavigate}
        headerActions={headerActions}
        costToday={costToday}
      />
      <div className="app-body">
        {showSidebar && (
          <Sidebar
            activeSection={sidebarActiveSection as NavSection}
            onNavigate={onNavigate}
            pendingDecisions={pendingDecisions}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebar}
          />
        )}
        <main 
          className="app-main" 
          role="main"
          style={{ paddingBottom: showBottomNav ? '90px' : '24px' }}
        >
          {children}
        </main>
        <RightDrawer
          isOpen={rightDrawerOpen}
          onClose={onCloseRightDrawer || (() => {})}
          title={rightDrawerTitle}
          position="right"
        >
          {rightDrawerContent}
        </RightDrawer>
      </div>
      {showBottomNav && (
        <MobileNav
          activeTab={mobileActiveTab as MobileTab | MoreMenuItem}
          onNavigate={onNavigate}
          pendingDecisions={pendingDecisions}
        />
      )}
      {isMobile && showSidebar && sidebarCollapsed && (
        <div className="sidebar-mobile-overlay" onClick={toggleSidebar} aria-hidden="true" />
      )}
    </div>
  );
}

function AppHeader({
  showSidebar,
  isMobile,
  sidebarCollapsed,
  toggleSidebar,
  pendingDecisions,
  onNavigate,
  headerActions,
  costToday,
}: {
  showSidebar: boolean;
  isMobile: boolean;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  pendingDecisions: number;
  onNavigate: (section: NavSection | MobileTab | MoreMenuItem) => void;
  headerActions?: React.ReactNode;
  costToday?: number | null;
}) {
  return (
    <header className="app-header" role="banner">
      <div className="header-left">
        {showSidebar && !isMobile && (
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Espandi navigazione' : 'Comprimi navigazione'}
            aria-expanded={!sidebarCollapsed}
            aria-controls="main-sidebar"
          >
            ☰
          </button>
        )}
        <div className="header-brand">
          <span className="brand-mark" aria-hidden="true">🦖</span>
          <span className="brand-text">G-Rex Control Room</span>
        </div>
      </div>
      
      <div className="header-center">
        {!isMobile && (
          <div className="system-indicators" aria-label="Stato sistema">
            <span className="status-indicator status-ok" title="Sistema operativo">
              <span className="status-dot" aria-hidden="true">●</span>
              <span className="status-label">Sistema OK</span>
            </span>
            <span className="status-indicator status-cost" title="Spesa rilevata">
              <span className="cost-icon" aria-hidden="true">€</span>
              <span className="cost-value">{costToday === null || costToday === undefined ? '—' : `€${costToday.toFixed(2)}`}</span>
            </span>
          </div>
        )}
      </div>

      <div className="header-right">
        {headerActions}
        {pendingDecisions > 0 && (
          <button
            type="button"
            className="pending-decisions-btn"
            onClick={() => onNavigate('requires-you')}
            aria-label={`${pendingDecisions} decisioni pendenti - vai a Richiede te`}
          >
            <span className="notification-icon" aria-hidden="true">🔔</span>
            <span className="notification-badge">{pendingDecisions}</span>
          </button>
        )}
        <span className="app-version" aria-hidden="true">v0.4.0</span>
      </div>
    </header>
  );
}
