import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Sidebar() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-glow" />
        Unlimited Mailboxes
      </div>

      <nav className="sidebar-nav">
        <NavLink to="/tenants" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Tenants
        </NavLink>
        <NavLink to="/orders" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Orders
        </NavLink>
        <NavLink to="/mailboxes" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Mailboxes
        </NavLink>
        <NavLink to="/email-auth" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          SPF/DKIM/DMARC
        </NavLink>
        <NavLink to="/logs" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          Logs
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <button className="btn ghost" onClick={handleLogout}>Sign out</button>
      </div>
    </aside>
  );
}
