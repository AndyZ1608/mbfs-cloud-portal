import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Coins, Cpu, HardDrive, MemoryStick, ReceiptText, RefreshCw, Server } from 'lucide-react';
import { api } from '../api.js';
import { Empty, Modal, PageHead, StatusBadge } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';
import {
  BILLING_FIELDS, billingValue, displayBillingValue, findInstances, firstBillingValue,
  flattenScalars, formatVnd, hasInstanceCosts, instanceId, labelFor,
} from '../utils/billing.js';

const SUMMARY_DETAIL_FIELDS = [
  ['billing.projectName', BILLING_FIELDS.projectName],
  ['billing.projectId', BILLING_FIELDS.projectId],
  ['billing.periodStart', BILLING_FIELDS.periodStart],
  ['billing.periodEnd', BILLING_FIELDS.periodEnd],
  ['billing.timezone', BILLING_FIELDS.timezone],
  ['billing.currency', BILLING_FIELDS.currency],
  ['billing.qualityStatus', BILLING_FIELDS.dataQuality],
];

const TECHNICAL_FIELDS = [
  ['billing.asOf', BILLING_FIELDS.asOf],
  ['billing.costComplete', BILLING_FIELDS.costComplete],
  ['billing.estimated', BILLING_FIELDS.estimated],
  ['billing.unratedSegments', BILLING_FIELDS.unratedSegments],
  ['billing.projectUnattributedCost', BILLING_FIELDS.unattributedCost, true],
];

const KNOWN_SUMMARY_KEYS = new Set(Object.values(BILLING_FIELDS).flat().map((key) => key.split('.').at(-1)));

function errorMessage(error, t) {
  if (error?.status === 403) return t('billing.noAccess');
  if (['billing_unavailable', 'billing_timeout', 'billing_invalid_response'].includes(error?.code) || [502, 503, 504].includes(error?.status)) {
    return t('billing.unavailable');
  }
  if (error?.code === 'billing_disabled') return t('billing.disabled');
  return error?.message || t('billing.loadFailed');
}

export default function Billing() {
  const { t } = useI18n();
  const [summary, setSummary] = useState(null);
  const [instancePayload, setInstancePayload] = useState(null);
  const [instanceDetails, setInstanceDetails] = useState({});
  const [costsLoading, setCostsLoading] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function load() {
    setLoading(true); setError(null); setInstanceDetails({}); setCostsLoading(new Set());
    try {
      const [nextSummary, nextInstances] = await Promise.all([api('/billing'), api('/billing/instances')]);
      setSummary(nextSummary); setInstancePayload(nextInstances);
    } catch (nextError) {
      setError(nextError); setSummary(null); setInstancePayload(null);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const instances = useMemo(() => findInstances(instancePayload), [instancePayload]);

  useEffect(() => {
    const missing = instances.filter((row) => instanceId(row) && !hasInstanceCosts(row));
    if (!missing.length) return undefined;
    let cancelled = false;
    setCostsLoading(new Set(missing.map(instanceId)));
    Promise.allSettled(missing.map(async (row) => {
      const id = instanceId(row);
      return [id, await api(`/billing/instances/${encodeURIComponent(id)}`)];
    })).then((results) => {
      if (cancelled) return;
      const next = {};
      for (const result of results) if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
      setInstanceDetails(next);
      setCostsLoading(new Set());
    });
    return () => { cancelled = true; };
  }, [instances]);

  async function openDetail(row) {
    const id = instanceId(row);
    if (!id) return;
    setDetail({}); setDetailLoading(true); setDetailError(null);
    try {
      const value = instanceDetails[id] || await api(`/billing/instances/${encodeURIComponent(id)}`);
      setDetail(value);
      if (!instanceDetails[id]) setInstanceDetails((current) => ({ ...current, [id]: value }));
    } catch (nextError) { setDetailError(nextError); }
    finally { setDetailLoading(false); }
  }

  return (
    <>
      <PageHead title="Billing">
        <button className="btn ghost" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'spin' : ''} size={15} />{t(loading ? 'common.loading' : 'billing.reload')}
        </button>
      </PageHead>
      <p className="dim page-desc">{t('billing.subtitle')}</p>

      {loading && <Empty>{t('billing.loading')}</Empty>}
      {!loading && error && <BillingErrorState error={error} onRetry={load} />}
      {!loading && !error && (
        <div className="billing-page">
          <BillingSummary payload={summary} instances={instances} />
          <InstanceTable instances={instances} details={instanceDetails} costsLoading={costsLoading} onOpen={openDetail} />
        </div>
      )}

      {detail && (
        <Modal wide title={t('billing.detailTitle')} onClose={() => { setDetail(null); setDetailError(null); }}
          footer={<button className="btn ghost" onClick={() => { setDetail(null); setDetailError(null); }}>{t('common.close')}</button>}>
          {detailLoading ? <Empty>{t('billing.detailLoading')}</Empty>
            : detailError ? <div className="notice-card err-text">{errorMessage(detailError, t)}</div>
              : <Detail payload={detail} />}
        </Modal>
      )}
    </>
  );
}

function BillingSummary({ payload, instances }) {
  const { t } = useI18n();
  const apiVmCount = billingValue(payload, BILLING_FIELDS.vmCount);
  const apiActiveCount = billingValue(payload, BILLING_FIELDS.activeVmCount);
  const activeFromList = instances.filter((row) => String(billingValue(row, BILLING_FIELDS.status) || '').toUpperCase() === 'ACTIVE').length;
  const metrics = [
    { label: t('billing.totalCost'), value: formatVnd(billingValue(payload, BILLING_FIELDS.totalCost)), icon: Coins, primary: true },
    { label: t('billing.vmCount'), value: displayBillingValue(apiVmCount ?? instances.length), icon: Server },
    { label: t('billing.activeVmCount'), value: displayBillingValue(apiActiveCount ?? activeFromList), icon: Activity },
    { label: t('billing.cpuCost'), value: formatVnd(billingValue(payload, BILLING_FIELDS.cpuCost)), icon: Cpu, money: true },
    { label: t('billing.ramCost'), value: formatVnd(billingValue(payload, BILLING_FIELDS.ramCost)), icon: MemoryStick, money: true },
    { label: t('billing.ssdCost'), value: formatVnd(billingValue(payload, BILLING_FIELDS.ssdCost)), icon: HardDrive, money: true },
  ];
  const unattributed = billingValue(payload, BILLING_FIELDS.unattributedCost);
  const additional = flattenScalars(payload).filter(([key]) => !KNOWN_SUMMARY_KEYS.has(key.split('.').at(-1)));

  return (
    <section aria-labelledby="billing-summary-title">
      <h3 className="billing-section-title" id="billing-summary-title">{t('billing.summaryTitle')}</h3>
      <div className="billing-metrics">
        {metrics.map(({ label, value, icon: Icon, primary, money }) => (
          <div className={`billing-metric ${primary ? 'billing-metric-primary' : ''}`} key={label}>
            <span className="billing-metric-icon"><Icon size={19} /></span>
            <div><span className="billing-metric-label">{label}</span><strong className={money || primary ? 'billing-money' : ''}>{value}</strong></div>
          </div>
        ))}
      </div>

      {unattributed !== undefined && (
        <div className="billing-unattributed">
          <span>{t('billing.unattributedCost')}</span>
          <strong>{formatVnd(unattributed)}</strong>
          <small>{t('billing.unattributedHint')}</small>
        </div>
      )}

      <div className="card billing-info-card">
        <div className="card-head"><div><h4>{t('billing.information')}</h4><span className="dim">{t('billing.periodContext')}</span></div></div>
        <div className="billing-info-grid">
          {SUMMARY_DETAIL_FIELDS.map(([key, aliases]) => (
            <InfoValue key={key} title={t(key)} value={billingValue(payload, aliases)} quality={key === 'billing.qualityStatus'} />
          ))}
        </div>
        <details className="billing-technical">
          <summary>{t('billing.technicalDetails')}</summary>
          <div className="billing-technical-grid">
            {TECHNICAL_FIELDS.map(([key, aliases, money]) => (
              <InfoValue key={key} title={t(key)} value={billingValue(payload, aliases)} money={money} />
            ))}
            {additional.map(([key, value]) => <InfoValue key={key} title={labelFor(key)} value={value} fieldKey={key} />)}
          </div>
        </details>
      </div>
    </section>
  );
}

function InfoValue({ title, value, quality, money, fieldKey = '' }) {
  return <div className="billing-info-item"><span>{title}</span>
    {quality && value !== undefined ? <StatusBadge status={String(value)} />
      : <strong className={money ? 'billing-money' : ''}>{money ? formatVnd(value) : displayBillingValue(value, fieldKey)}</strong>}
  </div>;
}

function resourceValue(row, details, aliases) {
  return firstBillingValue([details, row], aliases);
}

function ramGib(row, details) {
  const gib = resourceValue(row, details, BILLING_FIELDS.ramGib);
  if (gib !== undefined) return displayBillingValue(gib);
  const mib = resourceValue(row, details, BILLING_FIELDS.ramMib);
  return mib === undefined ? '—' : displayBillingValue(Number(mib) / 1024);
}

function InstanceTable({ instances, details, costsLoading, onOpen }) {
  const { t } = useI18n();
  return (
    <section className="card billing-instances" aria-labelledby="instance-billing-title">
      <div className="card-head"><div><h4 id="instance-billing-title">{t('billing.instanceTitle')}</h4><span className="dim">{t('billing.instanceHint')}</span></div><span className="billing-count">{instances.length} VM</span></div>
      {!instances.length ? <Empty>{t('billing.instanceEmpty')}</Empty> : (
        <div className="table-scroll"><table className="tbl billing-table">
          <thead><tr><th>{t('common.name')}</th><th>{t('billing.instanceId')}</th><th>{t('common.status')}</th><th className="num">vCPU</th><th className="num">{t('billing.ramGib')}</th><th className="num">{t('billing.ssdGib')}</th><th className="num">{t('billing.cpuCost')}</th><th className="num">{t('billing.ramCost')}</th><th className="num">{t('billing.ssdCost')}</th><th className="num">{t('billing.totalCost')}</th><th>{t('common.action')}</th></tr></thead>
          <tbody>{instances.map((row, index) => {
            const id = instanceId(row);
            const detailPayload = id ? details[id] : null;
            const sources = [detailPayload, row];
            const loadingCost = id && costsLoading.has(id);
            const money = (aliases) => loadingCost && firstBillingValue(sources, aliases) === undefined
              ? <span className="billing-cost-loading">{t('common.loading')}</span>
              : formatVnd(firstBillingValue(sources, aliases));
            return <tr key={id || index}>
              <td><strong>{displayBillingValue(resourceValue(row, detailPayload, BILLING_FIELDS.name))}</strong></td>
              <td><span className="mono billing-id" title={id || ''}>{id || '—'}</span></td>
              <td><StatusBadge status={resourceValue(row, detailPayload, BILLING_FIELDS.status)} /></td>
              <td className="num">{displayBillingValue(resourceValue(row, detailPayload, BILLING_FIELDS.vcpus))}</td>
              <td className="num">{ramGib(row, detailPayload)}</td>
              <td className="num">{displayBillingValue(resourceValue(row, detailPayload, BILLING_FIELDS.ssdGib))}</td>
              <td className="num billing-money-cell">{money(BILLING_FIELDS.cpuCost)}</td>
              <td className="num billing-money-cell">{money(BILLING_FIELDS.ramCost)}</td>
              <td className="num billing-money-cell">{money(BILLING_FIELDS.ssdCost)}</td>
              <td className="num billing-total-cell">{money(BILLING_FIELDS.totalCost)}</td>
              <td><button className="btn sm ghost" disabled={!id} onClick={() => onOpen(row)}><ReceiptText size={14} /> {t('common.details')}</button></td>
            </tr>;
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

function Detail({ payload }) {
  const { t } = useI18n();
  const fields = flattenScalars(payload);
  if (!fields.length) return <Empty>{t('billing.detailEmpty')}</Empty>;
  return <div className="detail-grid">{fields.map(([key, value]) => <div key={key}><span>{labelFor(key)}</span><b className="mono">{displayBillingValue(value, key)}</b></div>)}</div>;
}

function BillingErrorState({ error, onRetry }) {
  const { t } = useI18n();
  return <div className="card notice-card"><b>{errorMessage(error, t)}</b>{error?.requestId && <p className="dim mono">Request ID: {error.requestId}</p>}
    <button className="btn ghost" onClick={onRetry}>{t('common.retry')}</button></div>;
}
