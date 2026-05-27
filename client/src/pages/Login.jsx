import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const SIGN_IN_PATH = '/login';
const SIGN_UP_PATH = '/access';

export default function Login() {
  const { user, login, signUp } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isSignUp = location.pathname === SIGN_UP_PATH;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    return <Navigate to="/orders" replace />;
  }

  const handleModeChange = (path) => {
    setError('');
    navigate(path);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      if (isSignUp) {
        await signUp(email, password);
      } else {
        await login(email, password);
      }
      navigate('/orders', { replace: true });
    } catch (requestError) {
      setError(requestError.response?.data?.error || `Unable to ${isSignUp ? 'sign up' : 'sign in'} right now.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-card auth-card">
        <div className="auth-toggle" role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            className={`auth-toggle-btn ${!isSignUp ? 'active' : ''}`}
            onClick={() => handleModeChange(SIGN_IN_PATH)}
          >
            Sign In
          </button>
          <button
            type="button"
            className={`auth-toggle-btn ${isSignUp ? 'active' : ''}`}
            onClick={() => handleModeChange(SIGN_UP_PATH)}
          >
            Sign Up
          </button>
        </div>

        <h1 className="login-title">{isSignUp ? 'Sign Up' : 'Sign In'}</h1>
        <p className="login-subtitle">Unlimited Inboxes</p>

        <form className="login-form auth-form" onSubmit={handleSubmit}>
          <label>
            <span>Email</span>
            <input
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label>
            <span>Password</span>
            <input
              type="password"
              placeholder={isSignUp ? 'Create a password' : 'Enter your password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              required
            />
          </label>

          {error && (
            <div className="alert error auth-alert">
              <span>{error}</span>
              {!isSignUp && error.toLowerCase().includes('sign up') ? (
                <button
                  type="button"
                  className="auth-inline-link"
                  onClick={() => handleModeChange(SIGN_UP_PATH)}
                >
                  Sign Up
                </button>
              ) : null}
            </div>
          )}

          <button type="submit" className="btn accent auth-submit" disabled={submitting}>
            {submitting ? (isSignUp ? 'Creating Account...' : 'Signing In...') : (isSignUp ? 'Sign Up' : 'Sign In')}
          </button>
        </form>
      </div>
    </div>
  );
}
