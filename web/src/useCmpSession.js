import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';

// Both portal layouts use the same cookie-backed session and login behavior.
export default function useCmpSession() {
  const [session, setSession] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    api('/auth/session')
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) navigate('/login', { replace: true }); });
    return () => { active = false; };
  }, [navigate]);
  return session;
}
