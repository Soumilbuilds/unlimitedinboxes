import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useBilling } from '../context/BillingContext';

export default function Sidebar() {
  const { logout, user } = useAuth();
  const { openUpgrade } = useBilling();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        Unlimited Inboxes
      </div>

      <nav className="sidebar-nav">
        <NavLink to="/orders" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Orders
        </NavLink>
        {user?.plan === 'paid' && (
          <NavLink to="/inboxes" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            Inboxes
          </NavLink>
        )}
      </nav>

      <div className="sidebar-footer">
        {user?.plan !== 'paid' && (
          <a className="btn accent" href="https://unlimitedinboxes.com/freeinboxes" target="_blank" rel="noreferrer">
            Free Inboxes
          </a>
        )}
        {user?.plan !== 'paid' && (
          <button className="btn primary" onClick={openUpgrade}>
            Upgrade
          </button>
        )}
        <button className="btn ghost" onClick={handleLogout}>Sign out</button>
      </div>
    </aside>
  );
}
