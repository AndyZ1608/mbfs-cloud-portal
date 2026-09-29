import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { toast } from './components/ui.jsx';
import { useI18n } from './i18n/react.jsx';
import { canExtendVolume, validVolumeExtendSize } from '../../shared/volumeExtend.mjs';

export default function useVolumeExtend({ volumes, onRefresh, enabled = true }) {
  const { t } = useI18n();
  const pendingRef = useRef(new Map());
  const timersRef = useRef(new Map());
  const [pendingIds, setPendingIds] = useState(new Set());

  function release(id) {
    clearTimeout(timersRef.current.get(id));
    timersRef.current.delete(id);
    pendingRef.current.delete(id);
    setPendingIds(new Set(pendingRef.current.keys()));
  }

  useEffect(() => {
    for (const volume of Array.isArray(volumes) ? volumes : []) {
      const pending = pendingRef.current.get(volume.id);
      if (!pending) continue;
      if (volume.status === 'extending') pending.sawExtending = true;
      else if (volume.size >= pending.target || pending.sawExtending) release(volume.id);
    }
  }, [volumes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled || pendingIds.size === 0) return;
    const interval = setInterval(() => onRefresh(), 5000);
    return () => clearInterval(interval);
  }, [enabled, pendingIds.size, onRefresh]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
  }, []);

  async function extend(volume) {
    if (!canExtendVolume(volume.status) || pendingRef.current.has(volume.id)) return;
    const input = window.prompt(t('volumes.extendPrompt', { size: volume.size }), String(volume.size + 10));
    if (input === null) return;
    const newSize = Number(input);
    if (!validVolumeExtendSize(volume.size, newSize)) {
      toast(t(Number.isFinite(newSize) && newSize <= volume.size ? 'volumes.extendTooSmall' : 'volumes.extendSizeInvalid'), 'error');
      return;
    }
    pendingRef.current.set(volume.id, { target: newSize, sawExtending: false });
    setPendingIds(new Set(pendingRef.current.keys()));
    try {
      await api(`/volumes/${encodeURIComponent(volume.id)}/extend`, { method: 'POST', body: { new_size: newSize } });
      toast(t('volumes.extendRequested'), 'ok');
      onRefresh();
      // Allow retry if the provider never reports extending or a larger size.
      timersRef.current.set(volume.id, setTimeout(() => release(volume.id), 120000));
    } catch (error) { release(volume.id); toast(error.message, 'error'); }
  }

  return { extend, isPending: (id) => pendingIds.has(id) };
}
