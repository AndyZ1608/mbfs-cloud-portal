import { useCallback, useEffect, useState } from 'react';
import { monitoringScopeKey } from './model.js';
import { loadVmMonitoring } from './provider.js';

export default function useVmMonitoring({ projectId, instanceId, range, provider = loadVmMonitoring }) {
  const scopeKey = monitoringScopeKey(projectId, instanceId, range);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState({ scopeKey: null, revision: -1, status: 'loading', data: null, error: null });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setSnapshot({ scopeKey, revision, status: 'loading', data: null, error: null });
    Promise.resolve().then(() => provider({ projectId, instanceId, range, signal: controller.signal }))
      .then((data) => {
        if (live) setSnapshot({ scopeKey, revision, status: 'ready', data, error: null });
      }).catch((error) => {
        if (live) setSnapshot({ scopeKey, revision, status: 'error', data: null, error });
      });
    return () => { live = false; controller.abort(); };
  }, [projectId, instanceId, range, scopeKey, revision, provider]);

  return {
    ...(snapshot.scopeKey === scopeKey && snapshot.revision === revision
      ? snapshot : { status: 'loading', data: null, error: null }),
    refresh,
  };
}
