import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Tenants from './pages/Tenants';
import Orders from './pages/Orders';
import Logs from './pages/Logs';
import Mailboxes from './pages/Mailboxes';
import EmailAuth from './pages/EmailAuth';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/tenants"
            element={
              <ProtectedRoute>
                <Tenants />
              </ProtectedRoute>
            }
          />
          <Route
            path="/orders"
            element={
              <ProtectedRoute>
                <Orders />
              </ProtectedRoute>
            }
          />
          <Route
            path="/logs"
            element={
              <ProtectedRoute>
                <Logs />
              </ProtectedRoute>
            }
          />
          <Route
            path="/mailboxes"
            element={
              <ProtectedRoute>
                <Mailboxes />
              </ProtectedRoute>
            }
          />
          <Route
            path="/email-auth"
            element={
              <ProtectedRoute>
                <EmailAuth />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/tenants" replace />} />
          <Route path="*" element={<Navigate to="/tenants" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
