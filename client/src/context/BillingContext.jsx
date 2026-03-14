import { createContext, useContext, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import UpgradeCheckoutModal from '../components/UpgradeCheckoutModal';
import { useAuth } from './AuthContext';

const BillingContext = createContext(null);

export function BillingProvider({ children }) {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const value = useMemo(
    () => ({
      openUpgrade: () => setUpgradeOpen(true),
      closeUpgrade: () => setUpgradeOpen(false)
    }),
    []
  );

  return (
    <BillingContext.Provider value={value}>
      {children}
      <UpgradeCheckoutModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onUpgraded={async () => {
          await refreshUser({ force: true, minIntervalMs: 0 });
          setUpgradeOpen(false);
          navigate('/orders');
        }}
      />
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
