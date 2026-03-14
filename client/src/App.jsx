import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { BillingProvider } from './context/BillingContext';
import Login from './pages/Login';
import Orders from './pages/Orders';
import Inboxes from './pages/Inboxes';
import Upgrade from './pages/Upgrade';

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
        <BillingProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/orders"
              element={
                <ProtectedRoute>
                  <Orders />
                </ProtectedRoute>
              }
            />
            <Route
              path="/inboxes"
              element={
                <ProtectedRoute>
                  <Inboxes />
                </ProtectedRoute>
              }
            />
            <Route
              path="/upgrade"
              element={
                <ProtectedRoute>
                  <Upgrade />
                </ProtectedRoute>
              }
            />
            <Route path="/" element={<Navigate to="/orders" replace />} />
            <Route path="*" element={<Navigate to="/orders" replace />} />
          </Routes>
        </BillingProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
