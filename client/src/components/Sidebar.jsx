import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Sidebar() {
  const { logout, user } = useAuth();
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
        <a className="sidebar-link" href="http://unlimitedinboxes.com/tenants" target="_blank" rel="noreferrer">
          Tenants
        </a>
        <NavLink to="/orders" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Orders
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        {user?.plan === 'free' && (
          <a className="btn primary" href="https://unlimitedinboxes.com/upgrade" target="_blank" rel="noreferrer">
            Upgrade
          </a>
        )}
        <button className="btn ghost" onClick={handleLogout}>Sign out</button>
      </div>
    </aside>
  );
}
