import React, { useEffect, useMemo, useState } from 'react';
import { api, ramGB } from '../api.js';
import { Modal, Field, toast, Empty, PageHead } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';
import { resources } from '../i18n/index.js';

const CATS = ['all', 'database', 'devops', 'web', 'tool'];
const randPass = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[b % 57]).join('');
function templateLabel(tpl, field, t, locale, fallback) {
  const key = `marketplace.template.${tpl.id}.${field}`;
  return resources[locale][key] ? t(key) : fallback;
}

export default function Marketplace() {
  const { t, locale } = useI18n();
  const [templates, setTemplates] = useState(null);
  const [cat, setCat] = useState('all');
  const [deploying, setDeploying] = useState(null); // template đang mở wizard
  const [result, setResult] = useState(null);

  useEffect(() => {
    api('/marketplace/templates').then((d) => setTemplates(d.templates)).catch((e) => toast(e.message, 'error'));
  }, []);

  const shown = useMemo(() => !templates ? null : cat === 'all' ? templates : templates.filter((t) => t.category === cat), [templates, cat]);

  return (
    <>
      <PageHead title={t('navigation.marketplace')} count={shown?.length} />
      <p className="dim page-desc">{t('marketplace.description')}</p>

      <div className="tab-row" style={{ marginBottom: 16 }}>
        {CATS.map((key) => (
          <button key={key} className={`tab ${cat === key ? 'active' : ''}`} onClick={() => setCat(key)}>{t(`marketplace.category.${key}`)}</button>
        ))}
      </div>

      {!shown ? <Empty>{t('common.loading')}</Empty> : (
        <div className="mk-grid">
          {shown.map((tpl) => (
            <div key={tpl.id} className="card mk-card">
              <div className="mk-head">
                <span className="mk-emoji">{tpl.emoji}</span>
                <div>
                  <h4>{tpl.name}</h4>
                  <span className="dim">{templateLabel(tpl, 'tagline', t, locale, tpl.tagline)}</span>
                </div>
              </div>
              <div className="mk-meta">
                <span className="dim">{t('marketplace.minimum')} {tpl.min.vcpus} vCPU / {ramGB(tpl.min.ram)}</span>
                {tpl.ports.length > 0 && <span className="mono chip">{t('marketplace.ports')} {tpl.ports.join(', ')}</span>}
              </div>
              <button className="btn primary block" onClick={() => setDeploying(tpl)}>{t('marketplace.deploy')}</button>
            </div>
          ))}
        </div>
      )}

      {deploying && (
        <DeployModal tpl={deploying} onClose={() => setDeploying(null)}
          onDone={(r) => { setDeploying(null); setResult(r); }} />
      )}
      {result && <ResultModal r={result} onClose={() => setResult(null)} />}
    </>
  );
}

function DeployModal({ tpl, onClose, onDone }) {
  const { t, locale } = useI18n();
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useState(() => Object.fromEntries(tpl.params.map((p) => [p.key, p.generate ? randPass() : (p.default || '')])));
  const [f, setF] = useState({
    name: `${tpl.id}-01`, flavorRef: '', imageRef: '', network_id: '', key_name: '',
    create_sg: tpl.ports.length > 0, sg_cidr: '0.0.0.0/0', assign_fip: false, bfv: false, boot_volume_gb: Math.max(tpl.min.disk, 20),
  });

  useEffect(() => {
    Promise.all([api('/flavors'), api('/images'), api('/networks'), api('/keypairs')]).then(([fl, im, ne, kp]) => {
      const fits = fl.flavors.filter((x) => x.vcpus >= tpl.min.vcpus && x.ram >= tpl.min.ram && (x.disk === 0 || x.disk >= tpl.min.disk));
      const flavors = fits.length ? fits : fl.flavors;
      const images = im.images.filter((i) => i.status === 'active');
      const ubuntu = images.find((i) => /ubuntu/i.test(i.name || ''));
      const nets = ne.networks.filter((n) => !n['router:external']);
      setOpts({ flavors, images, nets, keypairs: kp.keypairs, fitted: fits.length > 0 });
      setF((x) => ({
        ...x,
        flavorRef: flavors[0]?.id || '',
        imageRef: (ubuntu || images[0])?.id || '',
        network_id: nets[0]?.id || '',
        key_name: kp.keypairs[0]?.name || '',
      }));
    }).catch((e) => toast(e.message, 'error'));
  }, [tpl]);

  async function submit() {
    if (!f.name.trim()) return toast(t('instances.nameRequired'), 'error');
    for (const p of tpl.params) if (!String(params[p.key] || '').trim()) return toast(t('marketplace.paramRequired', { label: templateLabel(tpl, `param.${p.key}`, t, locale, p.label) }), 'error');
    setBusy(true);
    try {
      const r = await api('/marketplace/deploy', {
        method: 'POST',
        body: {
          template_id: tpl.id, params,
          name: f.name.trim(), flavorRef: f.flavorRef, imageRef: f.imageRef,
          network_id: f.network_id, key_name: f.key_name || undefined,
          create_sg: f.create_sg, sg_cidr: f.sg_cidr, assign_fip: f.assign_fip,
          boot_volume_gb: f.bfv ? Number(f.boot_volume_gb) : undefined,
        },
      });
      onDone({ ...r, tpl, params });
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  return (
    <Modal title={t('marketplace.deployTitle', { name: `${tpl.emoji} ${tpl.name}` })} onClose={onClose} wide
      footer={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={submit} disabled={busy || !opts}>
          {t(busy ? (f.assign_fip ? 'marketplace.deployingFip' : 'marketplace.deploying') : 'marketplace.deploy')}
        </button></>}>
      {!opts ? <p>{t('common.loading')}</p> : (
        <>
          {tpl.params.length > 0 && (
            <>
              <p className="mk-section">{t('marketplace.appConfig')}</p>
              <div className="form-grid">
                {tpl.params.map((p) => (
                  <Field key={p.key} label={templateLabel(tpl, `param.${p.key}`, t, locale, p.label)}>
                    <div className="row-inline">
                      <input type={p.type === 'password' ? 'password' : 'text'} autoComplete={p.type === 'password' ? 'new-password' : undefined} className={p.type === 'password' ? 'mono' : ''}
                        value={params[p.key]} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} style={{ flex: 1 }} />
                      {p.generate && <button className="btn sm ghost" title={t('marketplace.generateRandom')} onClick={() => setParams({ ...params, [p.key]: randPass() })}>🎲</button>}
                    </div>
                  </Field>
                ))}
              </div>
            </>
          )}

          <p className="mk-section">{t('marketplace.vmConfig')}</p>
          <div className="form-grid">
            <Field label={t('instances.vmName')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label={t('instances.flavor')} hint={opts.fitted ? undefined : t('marketplace.noSuitableFlavor')}>
              <select value={f.flavorRef} onChange={(e) => setF({ ...f, flavorRef: e.target.value })}>
                {opts.flavors.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.vcpus} vCPU / {ramGB(x.ram)} / {x.disk} GB</option>)}
              </select>
            </Field>
            <Field label="Image" hint={t('marketplace.imageHint')}>
              <select value={f.imageRef} onChange={(e) => setF({ ...f, imageRef: e.target.value })}>
                {opts.images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </Field>
            <Field label="Network">
              <select value={f.network_id} onChange={(e) => setF({ ...f, network_id: e.target.value })}>
                {opts.nets.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
              </select>
            </Field>
            <Field label="SSH key">
              <select value={f.key_name} onChange={(e) => setF({ ...f, key_name: e.target.value })}>
                <option value="">— {t('instances.none')} —</option>
                {opts.keypairs.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
              </select>
            </Field>
            <Field label={t('instances.bootFromVolume')}>
              <div className="row-inline">
                <input type="checkbox" id="mk-bfv" checked={f.bfv} onChange={(e) => setF({ ...f, bfv: e.target.checked })} />
                <label htmlFor="mk-bfv">{t('instances.enable')}</label>
                {f.bfv && <><input type="number" min={tpl.min.disk} style={{ width: 90 }} value={f.boot_volume_gb}
                  onChange={(e) => setF({ ...f, boot_volume_gb: e.target.value })} /> <span className="dim">GB</span></>}
              </div>
            </Field>
          </div>

          <p className="mk-section">{t('marketplace.networkSecurity')}</p>
          {tpl.ports.length > 0 && (
            <label className="check-item" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={f.create_sg} onChange={(e) => setF({ ...f, create_sg: e.target.checked })} />
              {t('marketplace.openPorts')} <b className="mono">{tpl.ports.join(', ')}</b> {t('marketplace.from')}
              <input className="mono" style={{ width: 130 }} value={f.sg_cidr} onChange={(e) => setF({ ...f, sg_cidr: e.target.value })} disabled={!f.create_sg} />
            </label>
          )}
          <label className="check-item">
            <input type="checkbox" checked={f.assign_fip} onChange={(e) => setF({ ...f, assign_fip: e.target.checked })} />
            {t('marketplace.assignFip')} <span className="dim">{t('marketplace.fipWait')}</span>
          </label>
        </>
      )}
    </Modal>
  );
}

function ResultModal({ r, onClose }) {
  const { t, locale } = useI18n();
  const creds = r.tpl.params.filter((p) => p.type === 'password').map((p) => [templateLabel(r.tpl, `param.${p.key}`, t, locale, p.label), r.params[p.key]]);
  const accessKey = `marketplace.template.${r.tpl.id}.access`;
  const safeParams = Object.fromEntries(Object.entries(r.params).filter(([key]) => !/pass|token/i.test(key)));
  const access = resources[locale][accessKey] ? t(accessKey, { ...safeParams, ip: r.fip || t('marketplace.instanceIp') }) : r.access;
  return (
    <Modal title={t('marketplace.deployed', { name: r.tpl.name })} onClose={onClose}
      footer={<button className="btn primary" onClick={onClose}>{t('marketplace.done')}</button>}>
      <div className="kv">
        <div><span>{t('navigation.instances')}</span><span><b>{r.server.name}</b></span></div>
        {r.fip && <div><span>{t('marketplace.publicIp')}</span><span className="mono chip chip-fip">{r.fip}</span></div>}
        {r.security_group && <div><span>Security group</span><span className="mono">{r.security_group}</span></div>}
      </div>
      {creds.length > 0 && (
        <>
          <p className="mk-section">{t('marketplace.credentialsWarning')}</p>
          <div className="kv">
            {creds.map(([label, v]) => <div key={label}><span>{label}</span><span className="mono">{v}</span></div>)}
          </div>
        </>
      )}
      <p className="mk-section">{t('marketplace.access')}</p>
      <p>{access}</p>
      {r.warnings?.map((w, i) => <p key={i} className="warn-text">⚠ {resources[locale][`marketplace.warning.${r.warningCodes?.[i]}`]
        ? t(`marketplace.warning.${r.warningCodes[i]}`)
        : locale === 'vi' ? w : t('marketplace.warning.generic')}</p>)}
      <p className="dim">{t('marketplace.deployNote')}</p>
    </Modal>
  );
}
