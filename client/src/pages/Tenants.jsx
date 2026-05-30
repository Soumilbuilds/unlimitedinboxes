import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';

const LICENSE_OPTIONS = [
  {
    value: 'premium',
    label: 'US IP',
    unitPrice: 15
  },
  {
    value: 'normal',
    label: 'Asia IP',
    unitPrice: 20
  }
];

export default function Tenants() {
  const navigate = useNavigate();
  const [quantity, setQuantity] = useState(1);
  const [licenseType, setLicenseType] = useState('');

  const handleSubmit = (event) => {
    event.preventDefault();

    if (!licenseType || quantity < 1) {
      return;
    }

    const params = new URLSearchParams({
      quantity: String(quantity),
      license: licenseType
    });

    navigate(`/tenants/checkout?${params.toString()}`);
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content tenants-page">
        <div className="tenant-order-layout">
          <div className="tenant-order-intro">
            <h1 className="tenant-order-title">Get Microsoft Tenants In Bulk</h1>
          </div>

          <div className="tenant-order-card">
            <form className="form tenant-order-form" onSubmit={handleSubmit}>
              <label className="tenant-field">
                <span>Number Of Tenants Needed</span>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  value={quantity}
                  onChange={(event) => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    setQuantity(Number.isInteger(nextValue) && nextValue > 0 ? nextValue : 1);
                  }}
                  required
                />
              </label>

              {quantity >= 1 && (
                <div className="tenant-license-section">
                  <div className="tenant-section-label">What Type Of Tenant Do You Want?</div>
                  <div className="tenant-license-grid">
                    {LICENSE_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={`tenant-license-card ${licenseType === option.value ? 'active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="licenseType"
                          value={option.value}
                          checked={licenseType === option.value}
                          onChange={() => setLicenseType(option.value)}
                        />
                        <div className="tenant-license-copy">
                          <strong>{option.label}</strong>
                          <div className="helper-text">${option.unitPrice} + Processing Fee</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="tenant-order-actions">
                <button
                  type="submit"
                  className="btn accent tenant-submit-btn"
                  disabled={!licenseType || quantity < 1}
                >
                  Get Tenants
                </button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
