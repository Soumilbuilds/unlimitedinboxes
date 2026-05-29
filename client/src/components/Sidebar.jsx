import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useBilling } from '../context/BillingContext';

export default function Sidebar() {
  const { logout, user } = useAuth();
  const { billing, openUpgrade, openBillingPortal, reviewUrl } = useBilling();
  const navigate = useNavigate();
  const settingsRef = useRef(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleLogout = async () => {
    setSettingsOpen(false);
    await logout();
    navigate('/login');
  };

  const handleOpenBillingPortal = async () => {
    setSettingsOpen(false);
    await openBillingPortal();
  };

  useEffect(() => {
    if (!settingsOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!settingsRef.current?.contains(event.target)) {
        setSettingsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [settingsOpen]);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        Unlimited Inboxes
      </div>

      <nav className="sidebar-nav">
        <NavLink to="/orders" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Orders
        </NavLink>
        <NavLink to="/tenants" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Tenants
        </NavLink>
        <NavLink to="/redirects" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Redirects
        </NavLink>
        {(billing?.canOpenInboxesPage ?? user?.plan === 'paid') && (
          <NavLink to="/inboxes" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            Inboxes
          </NavLink>
        )}
        <NavLink to="/api" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          API
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        {!billing?.isPaid && (
          <a className="btn ghost" href={reviewUrl} target="_blank" rel="noreferrer">
            Leave Review
          </a>
        )}
        {!billing?.isPaid && (
          <button className="btn accent" onClick={() => void openUpgrade('standard')}>
            Upgrade
          </button>
        )}
        <div className="sidebar-settings" ref={settingsRef}>
          {settingsOpen && (
            <div className="sidebar-settings-panel">
              <div className="sidebar-settings-copy">
                <span className="sidebar-settings-label">Signed In As</span>
                <strong>{user?.email || 'Unknown user'}</strong>
              </div>
              {billing?.hasBillingPortal && (
                <button className="btn ghost sidebar-settings-action" onClick={() => void handleOpenBillingPortal()}>
                  Manage Billing
                </button>
              )}
              <button className="btn ghost sidebar-settings-action" onClick={handleLogout}>
                Sign Out
              </button>
            </div>
          )}
          <button
            className={`btn ghost sidebar-settings-trigger ${settingsOpen ? 'active' : ''}`}
            onClick={() => setSettingsOpen((currentValue) => !currentValue)}
          >
            Settings
          </button>
        </div>
      </div>
    </aside>
  );
}
