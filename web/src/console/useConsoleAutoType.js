import { useCallback, useEffect, useRef, useState } from 'react';
import { ConsoleSessionUnavailableError, createConsoleAutoTyper } from './autoType.js';

const INITIAL_STATE = { phase: 'idle', current: 0, total: 0, message: '' };

export default function useConsoleAutoType({ rfbRef, connected, sessionKey }) {
  const connectedRef = useRef(connected);
  const mountedRef = useRef(true);
  const [state, setState] = useState(INITIAL_STATE);
  const typerRef = useRef(null);

  connectedRef.current = connected;
  if (!typerRef.current) {
    typerRef.current = createConsoleAutoTyper({
      getSession: () => rfbRef.current,
      isSessionAvailable: (session) => connectedRef.current && rfbRef.current === session,
    });
  }

  const cancel = useCallback(() => {
    typerRef.current.cancel();
  }, []);

  const start = useCallback(async (text) => {
    setState({ phase: 'typing', current: 0, total: 0, message: '' });
    try {
      const result = await typerRef.current.start(text, {
        appendEnter: true,
        onProgress: ({ current, total }) => {
          if (mountedRef.current) setState({ phase: 'typing', current, total, message: '' });
        },
      });
      if (mountedRef.current) setState({ phase: 'complete', ...result, message: 'Đã nhập xong.' });
    } catch (error) {
      if (!mountedRef.current) return;
      if (error?.name === 'AbortError') {
        setState((current) => ({ ...current, phase: 'cancelled', message: 'Đã huỷ auto-type.' }));
      } else {
        setState((current) => ({ ...current, phase: 'error', message: error?.message || 'Không thể auto-type vào console.' }));
      }
    }
  }, []);

  useEffect(() => {
    if (!connected && typerRef.current.active) {
      typerRef.current.cancel(new ConsoleSessionUnavailableError());
    }
  }, [connected]);

  useEffect(() => {
    typerRef.current.cancel();
    setState(INITIAL_STATE);
  }, [sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    window.addEventListener('pagehide', cancel);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', cancel);
      typerRef.current.cancel();
    };
  }, [cancel]);

  return { state, start, cancel, typing: state.phase === 'typing' };
}
