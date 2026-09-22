import React, { useEffect, useMemo, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Empty, Modal, PageHead } from '../components/ui.jsx';

const ID_KEYS = ['instance_id', 'id', 'uuid', 'instance_uuid'];
const PREFERRED_COLUMNS = [
  'name', 'instance_name', 'instance_id', 'id', 'uuid', 'status',
  'vcpus', 'vcpu', 'ram', 'memory_mb', 'disk', 'runtime', 'billable_time',
  'cost', 'total_cost', 'amount', 'currency', 'last_updated', 'updated_at',
];

const isScalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const label = (key) => String(key).replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function displayValue(value, key = '') {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  if (typeof value === 'number') return value.toLocaleString('vi-VN', { maximumFractionDigits: 6 });
  if (typeof value === 'string' && /(date|time|updated|created|period_(start|end))/.test(key) && !Number.isNaN(Date.parse(value))) return fmtDate(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function flattenScalars(value, prefix = '', depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return [];
  const result = [];
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isScalar(child)) result.push([fullKey, child]);
    else if (!Array.isArray(child)) result.push(...flattenScalars(child, fullKey, depth + 1));
  }
  return result;
}

function findInstances(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['instances', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = findInstances(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function instanceId(row) {
  for (const key of ID_KEYS) if (row?.[key] !== undefined && row[key] !== null) return String(row[key]);
  return null;
}

function errorMessage(error) {
  if (error?.status === 403) return 'Bạn không có quyền xem dữ liệu Billing của project hiện tại.';
  if (['billing_unavailable', 'billing_timeout', 'billing_invalid_response'].includes(error?.code) || [502, 503, 504].includes(error?.status)) {
    return 'Billing service hiện không khả dụng. Các chức năng cloud khác vẫn hoạt động bình thường.';
  }
  if (error?.code === 'billing_disabled') return 'Tích hợp Billing đang được tắt bởi quản trị viên.';
  return error?.message || 'Không thể tải dữ liệu Billing.';
}

export default function Billing() {
  const [summary, setSummary] = useState(null);
  const [instancePayload, setInstancePayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [nextSummary, nextInstances] = await Promise.all([api('/billing'), api('/billing/instances')]);
      setSummary(nextSummary); setInstancePayload(nextInstances);
    } catch (nextError) {
      setError(nextError); setSummary(null); setInstancePayload(null);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const instances = useMemo(() => findInstances(instancePayload), [instancePayload]);
  const columns = useMemo(() => {
    const keys = new Set();
    for (const row of instances) for (const [key, value] of Object.entries(row || {})) if (isScalar(value)) keys.add(key);
    return [...PREFERRED_COLUMNS.filter((key) => keys.has(key)), ...[...keys].filter((key) => !PREFERRED_COLUMNS.includes(key))].slice(0, 12);
  }, [instances]);

  async function openDetail(row) {
    const id = instanceId(row);
    if (!id) return;
    setDetail({}); setDetailLoading(true); setDetailError(null);
    try { setDetail(await api(`/billing/instances/${encodeURIComponent(id)}`)); }
    catch (nextError) { setDetailError(nextError); }
    finally { setDetailLoading(false); }
  }

  return (
    <>
      <PageHead title="Billing"><button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Đang tải…' : 'Tải lại'}</button></PageHead>
      <p className="dim page-desc">Số liệu do Billing service cung cấp theo project trong Keystone token hiện tại.</p>

      {loading && <Empty>Đang tải dữ liệu Billing…</Empty>}
      {!loading && error && <BillingErrorState error={error} onRetry={load} />}
      {!loading && !error && (
        <>
          <Summary payload={summary} />
          <InstanceTable instances={instances} columns={columns} onOpen={openDetail} />
        </>
      )}

      {detail && (
        <Modal title="Chi tiết Billing máy ảo" onClose={() => { setDetail(null); setDetailError(null); }}
          footer={<button className="btn ghost" onClick={() => { setDetail(null); setDetailError(null); }}>Đóng</button>}>
          {detailLoading ? <Empty>Đang tải chi tiết…</Empty>
            : detailError ? <div className="notice-card err-text">{errorMessage(detailError)}</div>
              : <Detail payload={detail} />}
        </Modal>
      )}
    </>
  );
}

function Summary({ payload }) {
  const fields = flattenScalars(payload);
  return (
    <div className="card">
      <div className="card-head"><h4>Project Billing Summary</h4></div>
      {!fields.length ? <Empty>Billing service chưa trả về dữ liệu tổng hợp.</Empty> : (
        <div className="detail-grid">
          {fields.map(([key, value]) => <div key={key}><span>{label(key)}</span><b className="mono">{displayValue(value, key)}</b></div>)}
        </div>
      )}
    </div>
  );
}

function InstanceTable({ instances, columns, onOpen }) {
  return (
    <div className="card">
      <div className="card-head"><h4>Instance Billing</h4><span className="dim">{instances.length} bản ghi</span></div>
      {!instances.length ? <Empty>Không có bản ghi Billing máy ảo trong project hiện tại.</Empty> : (
        <div className="table-scroll"><table className="tbl">
          <thead><tr>{columns.map((key) => <th key={key}>{label(key)}</th>)}<th /></tr></thead>
          <tbody>{instances.map((row, index) => {
            const id = instanceId(row);
            return <tr key={id || index}>{columns.map((key) => <td key={key} className={/(id|uuid|cost|amount|price)/.test(key) ? 'mono' : ''}>{displayValue(row?.[key], key)}</td>)}
              <td><button className="btn sm ghost" disabled={!id} onClick={() => onOpen(row)}><ReceiptText size={14} /> Chi tiết</button></td></tr>;
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}

function Detail({ payload }) {
  const fields = flattenScalars(payload);
  if (!fields.length) return <Empty>Billing service không trả về trường chi tiết nào.</Empty>;
  return <div className="detail-grid">{fields.map(([key, value]) => <div key={key}><span>{label(key)}</span><b className="mono">{displayValue(value, key)}</b></div>)}</div>;
}

function BillingErrorState({ error, onRetry }) {
  return <div className="card notice-card"><b>{errorMessage(error)}</b>{error?.requestId && <p className="dim mono">Request ID: {error.requestId}</p>}
    <button className="btn ghost" onClick={onRetry}>Thử lại</button></div>;
}
