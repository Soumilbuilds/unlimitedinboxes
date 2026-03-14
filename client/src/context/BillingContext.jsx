import { createContext, useContext, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

const BillingContext = createContext(null);

export function BillingProvider({ children }) {
  const navigate = useNavigate();

  const value = useMemo(
    () => ({
      openUpgrade: () => navigate('/upgrade')
    }),
    [navigate]
  );

  return (
    <BillingContext.Provider value={value}>
      {children}
    </BillingContext.Provider>
  );
}

export function useBilling() {
  const ctx = useContext(BillingContext);
  if (!ctx) {
    throw new Error('useBilling must be used within BillingProvider');
  }
  return ctx;
}
