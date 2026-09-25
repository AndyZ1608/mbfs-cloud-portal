import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Field, Modal, toast } from './ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export function editFormFrom(data) {
  return {
    name: data.network.name || '', revision_number: data.network.revision_number,
    subnets: data.subnets.map((subnet) => ({
      id: subnet.id, revision_number: subnet.revision_number, name: subnet.name || '',
      cidr: subnet.cidr, ip_version: subnet.ip_version,
      gateway_ip: subnet.gateway_ip || '',
      dns: (subnet.dns_nameservers || []).join('\n'),
      pools: (subnet.allocation_pools || []).map((pool) => `${pool.start}, ${pool.end}`).join('\n'),
      dhcp: subnet.enable_dhcp === true,
      mode: subnet.mode, router_id: subnet.router_id || '',
    })),
  };
}

export function editBodyFrom(form) {
  return {
    name: form.name.trim(), revision_number: form.revision_number,
    subnets: form.subnets.map((subnet) => ({
      id: subnet.id, revision_number: subnet.revision_number, name: subnet.name.trim(),
      gateway_ip: subnet.gateway_ip.trim() || null,
      dns_nameservers: subnet.dns.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
      allocation_pools: subnet.pools.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [start, end] = line.split(/[\s,]+/).filter(Boolean);
        return { start: start || '', end: end || '' };
      }),
      mode: subnet.mode, router_id: subnet.mode === 'routed' ? subnet.router_id : null,
    })),
  };
}

export function isNetworkEditDirty(form, data) {
  return !!(form && data && JSON.stringify(editBodyFrom(form)) !== JSON.stringify(editBodyFrom(editFormFrom(data))));
}

export function NetworkEditForm({ original, form, routers, busy, onForm }) {
  const { t } = useI18n();
  const updateSubnet = (id, patch) => onForm((current) => ({ ...current,
    subnets: current.subnets.map((subnet) => subnet.id === id ? { ...subnet, ...patch } : subnet),
  }));
  return <div className="network-edit-form">
    <Field label={t('network.edit.networkName')}>
      <input value={form.name} disabled={busy} onChange={(event) => onForm((current) => ({ ...current, name: event.target.value }))} />
    </Field>
    <p className="dim mono network-edit-id">{t('network.edit.networkId')}: {original.network.id}</p>
    {form.subnets.map((subnet) => {
      const before = original.subnets.find((item) => item.id === subnet.id);
      const routingChange = (subnet.mode === 'routed' ? subnet.router_id : '') !== (before.router_id || '');
      const gatewayChange = subnet.gateway_ip !== (before.gateway_ip || '');
      return <section className="network-edit-subnet" key={subnet.id}>
        <h4>{t('network.edit.subnet')} · {subnet.name || subnet.id.slice(0, 8)}</h4>
        <p className="dim mono network-edit-id">{t('network.edit.subnetId')}: {subnet.id}</p>
        <Field label={t('network.edit.subnetName')}>
          <input value={subnet.name} disabled={busy} onChange={(event) => updateSubnet(subnet.id, { name: event.target.value })} />
        </Field>
        <div className="network-edit-facts">
          <div><span>{t('network.edit.cidr')}</span><strong className="mono">{subnet.cidr}</strong></div>
          <div><span>{t('network.edit.ipVersion')}</span><strong>IPv{subnet.ip_version}</strong></div>
          <div><span>{t('network.edit.dhcp')}</span><strong>{t(subnet.dhcp ? 'network.edit.dhcpEnabled' : 'network.edit.dhcpLegacyDisabled')}</strong></div>
        </div>
        <p className="field-hint">{t('network.edit.cidrImmutable')} {t(subnet.dhcp ? 'network.edit.dhcpRequired' : 'network.edit.dhcpLegacyHint')}</p>
        <fieldset className="network-mode-field">
          <legend className="field-label">{t('network.edit.mode')}</legend>
          <div className="network-mode-options">
            {['isolated', 'routed'].map((mode) => <label key={mode} className={`network-mode-option${subnet.mode === mode ? ' selected' : ''}`}>
              <input type="radio" name={`edit-mode-${subnet.id}`} value={mode} checked={subnet.mode === mode} disabled={busy}
                onChange={() => updateSubnet(subnet.id, { mode, router_id: mode === 'isolated' ? '' : subnet.router_id })} />
              {t(mode === 'routed' ? 'network.edit.routed' : 'network.edit.isolated')}
            </label>)}
          </div>
        </fieldset>
        {subnet.mode === 'routed' && <Field label={t('network.edit.router')}>
          <select value={subnet.router_id} disabled={busy} onChange={(event) => updateSubnet(subnet.id, { router_id: event.target.value })}>
            <option value="">— {t('networks.create.selectRouter')} —</option>
            {routers.map((router) => <option key={router.id} value={router.id}>{router.name}</option>)}
          </select>
        </Field>}
        {routingChange && <p className="network-edit-warning">{t(subnet.mode === 'isolated' ? 'network.edit.isolateWarning' : 'network.edit.routingWarning')}</p>}
        <Field label={t('network.edit.gateway')}>
          <input className="mono" value={subnet.gateway_ip} disabled={busy}
            onChange={(event) => updateSubnet(subnet.id, { gateway_ip: event.target.value })} />
        </Field>
        {gatewayChange && <p className="network-edit-warning">{t('network.edit.gatewayWarning')}</p>}
        <Field label={t('network.edit.dns')} hint={t('network.edit.dnsHint')}>
          <textarea className="mono" rows={2} value={subnet.dns} disabled={busy}
            onChange={(event) => updateSubnet(subnet.id, { dns: event.target.value })} />
        </Field>
        <Field label={t('network.edit.allocationPools')} hint={t('network.edit.poolHint')}>
          <textarea className="mono" rows={2} value={subnet.pools} disabled={busy || Number(subnet.ip_version) !== 4}
            onChange={(event) => updateSubnet(subnet.id, { pools: event.target.value })} />
        </Field>
      </section>;
    })}
    {form.subnets.length === 0 && <p className="dim">{t('network.edit.noSubnets')}</p>}
  </div>;
}

export default function NetworkEditModal({ networkId, onClose, onDone }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let mounted = true;
    api(`/networks/${encodeURIComponent(networkId)}/edit`).then((loaded) => {
      if (mounted) { setData(loaded); setForm(editFormFrom(loaded)); }
    }).catch((failure) => { if (mounted) setError(failure.message); });
    return () => { mounted = false; };
  }, [networkId]);

  const dirty = isNetworkEditDirty(form, data);
  async function submit() {
    if (submitting.current || !dirty) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const body = editBodyFrom(form);
      if (body.subnets.some((subnet) => subnet.mode === 'routed' && !subnet.router_id)) {
        setError(t('network.edit.routerRequired'));
        return;
      }
      await api(`/networks/${encodeURIComponent(networkId)}`, { method: 'PATCH', body });
      toast(t('network.edit.updated'), 'ok');
      onDone();
    } catch (failure) {
      setError(failure.message);
      // Provider conflicts or uncertain partial failures invalidate the form's revision/topology snapshot.
      if (failure.status === 409 || ['network_edit_failed', 'network_edit_subnet_failed',
        'network_edit_routing_failed', 'network_edit_partial_failure'].includes(failure.code)) {
        try {
          const fresh = await api(`/networks/${encodeURIComponent(networkId)}/edit`);
          setData(fresh);
          setForm(editFormFrom(fresh));
        } catch { /* Keep the original error visible; closing and reopening retries the load. */ }
      }
    }
    finally { submitting.current = false; setBusy(false); }
  }

  return <Modal title={t('network.edit.title')} wide onClose={() => { if (!busy) onClose(); }}
    footer={<><button className="btn ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn primary" disabled={busy || !dirty || !!error && !data} onClick={submit}>
        {t('network.edit.save')}
      </button></>}>
    {error && <p className="account-password-error" role="alert">{error}</p>}
    {!data && !error && <p>{t('common.loading')}</p>}
    {data && form && <NetworkEditForm original={data} form={form} routers={data.routers} busy={busy} onForm={setForm} />}
  </Modal>;
}
