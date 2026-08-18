import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { BillingProvider } from './context/BillingContext';
import Login from './pages/Login';
import Orders from './pages/Orders';
import Inboxes from './pages/Inboxes';
import API from './pages/API';
import Tenants from './pages/Tenants';
import TenantCheckout from './pages/TenantCheckout';
import Redirects from './pages/Redirects';
import BillingCheckout from './pages/BillingCheckout';
import APIBilling from './pages/APIBilling';
import Plans from './pages/Plans';

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
            <Route path="/access" element={<Login />} />
            <Route
              path="/billing"
              element={
                <ProtectedRoute>
                  <BillingCheckout />
                </ProtectedRoute>
              }
            />
            <Route
              path="/api-billing"
              element={
                <ProtectedRoute>
                  <APIBilling />
                </ProtectedRoute>
              }
            />
            <Route
              path="/plans"
              element={
                <ProtectedRoute>
                  <Plans />
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
              path="/tenants"
              element={
                <ProtectedRoute>
                  <Tenants />
                </ProtectedRoute>
              }
            />
            <Route
              path="/tenants/checkout"
              element={
                <ProtectedRoute>
                  <TenantCheckout />
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
              path="/api-docs"
              element={
                <ProtectedRoute>
                  <API />
                </ProtectedRoute>
              }
            />
            <Route
              path="/redirects"
              element={
                <ProtectedRoute>
                  <Redirects />
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
