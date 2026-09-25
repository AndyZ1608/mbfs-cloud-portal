import { useRef, useState } from 'react';
import { api } from './api.js';
import { toast } from './components/ui.jsx';
import { openInstanceConsole } from './console/navigation.js';
import { useI18n } from './i18n/react.jsx';
import { vmActionItems } from './vmActions.js';

// Shared controller for list and resource-detail actions. Dialogs remain the existing ones.
export default function useInstanceActions({ onChanged, onDeleted = () => {} }) {
  const { t } = useI18n();
  const [target, setTarget] = useState({ kind: null, server: null });
  const [deleting, setDeleting] = useState(false);
  const [pendingResize, setPendingResize] = useState(new Map());
  const deleteRequest = useRef(false);
  const actionRequests = useRef(new Set());
  const open = (kind, server) => setTarget({ kind, server });
  const close = () => setTarget({ kind: null, server: null });
  const changed = () => { onChanged?.(); };

  function syncServers(servers) {
    setPendingResize((current) => {
      const next = new Map(current);
      for (const server of servers) {
        if (next.has(server.id) && next.get(server.id) !== server.status) next.delete(server.id);
      }
      return next.size === current.size ? current : next;
    });
    setTarget((current) => {
      if (current.kind !== 'delete' || !current.server || deleteRequest.current) return current;
      const latest = servers.find((server) => server.id === current.server.id);
      if (!latest) return { kind: null, server: null };
      return latest.name === current.server.name ? current : { ...current, server: latest };
    });
  }

  async function act(server, action, label) {
    const finalizing = action === 'confirm-resize' || action === 'revert-resize';
    if (finalizing && (actionRequests.current.has(server.id) || pendingResize.has(server.id))) return;
    if (finalizing) {
      actionRequests.current.add(server.id);
      setPendingResize((current) => new Map(current).set(server.id, server.status));
    }
    try {
      await api(`/servers/${server.id}/action`, { method: 'POST', body: { action } });
      toast(t('instances.actionWithName', { action: label, name: server.name }), 'ok');
      if (finalizing) changed();
      setTimeout(changed, 800);
    } catch (error) {
      if (finalizing) setPendingResize((current) => { const next = new Map(current); next.delete(server.id); return next; });
      toast(error.message, 'error');
    } finally {
      if (finalizing) actionRequests.current.delete(server.id);
    }
  }

  async function rename(server) {
    const name = window.prompt(t('instances.renamePrompt'), server.name);
    if (!name || name.trim() === server.name) return;
    try {
      await api(`/servers/${server.id}`, { method: 'PUT', body: { name: name.trim() } });
      toast(t('instances.renamed', { name: name.trim() }), 'ok');
      changed();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function snapshot(server) {
    const name = window.prompt(t('instances.snapshotPrompt'), `${server.name}-snap-${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    try {
      await api(`/servers/${server.id}/action`, { method: 'POST', body: { action: 'snapshot', name } });
      toast(t('instances.snapshotStarted', { name }), 'ok');
      changed();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function confirmDelete() {
    const server = target.server;
    if (!server || deleteRequest.current) return;
    deleteRequest.current = true;
    setDeleting(true);
    try {
      await api(`/servers/${server.id}`, { method: 'DELETE' });
      toast(t('instances.deleteSent', { name: server.name }), 'ok');
      close();
      onDeleted(server);
      setTimeout(changed, 800);
    } catch (error) {
      toast(error.message, 'error');
      deleteRequest.current = false;
      setDeleting(false);
    }
  }

  function openDelete(server) {
    deleteRequest.current = false;
    setDeleting(false);
    open('delete', server);
  }

  function closeDelete() {
    if (deleteRequest.current) return;
    close();
    setDeleting(false);
  }

  function items(server) {
    return vmActionItems(server, { t, pendingResize: pendingResize.has(server.id), handlers: {
      console: () => openInstanceConsole(server.id),
      changePassword: () => open('password', server),
      rename: () => rename(server),
      networkCards: () => open('nic', server),
      securityGroups: () => open('sg', server),
      floatingIp: () => open('fip', server),
      snapshot: () => snapshot(server),
      start: () => act(server, 'start', t('instances.started')),
      stop: () => act(server, 'stop', t('instances.stopSent')),
      softReboot: () => act(server, 'reboot-soft', t('instances.rebooting')),
      hardReboot: () => act(server, 'reboot-hard', t('instances.rebooting')),
      resize: () => open('resize', server),
      confirmResize: () => act(server, 'confirm-resize', t('instances.confirmResizeSent')),
      revertResize: () => act(server, 'revert-resize', t('instances.revertResizeSent')),
      shelve: () => act(server, 'shelve', t('instances.shelving')),
      unshelve: () => act(server, 'unshelve', t('instances.unshelving')),
      rebuild: () => open('rebuild', server),
      delete: () => openDelete(server),
    } });
  }

  function dialogDone({ keepOpen = false } = {}) {
    if (!keepOpen) close();
    changed();
    setTimeout(changed, 800);
  }

  return { items, open, close, target, deleting, confirmDelete, closeDelete, dialogDone,
    pendingResize, setPendingResize, syncServers };
}
