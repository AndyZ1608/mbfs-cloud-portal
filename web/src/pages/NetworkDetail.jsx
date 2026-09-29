import React, { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Empty } from '../components/ui.jsx';
import { useI18n } from '../i18n/react.jsx';

export default function NetworkDetailRoute() {
  const { networkId } = useParams();
  const { sess } = useOutletContext();
  return <NetworkDetail key={`${sess.project.id}:${networkId}`} networkId={networkId} />;
}

function NetworkDetail({ networkId }) {
  const { t } = useI18n();
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    api('/networks').then(({ networks }) => {
      if (!live) return;
      const network = networks.find((item) => item.id === networkId);
      setState(network ? { network } : { error: t('errors.resource_not_found') });
    }).catch((error) => { if (live) setState({ error: error.message }); });
    return () => { live = false; };
  }, [networkId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.loading) return <Empty>{t('common.loading')}</Empty>;
  if (state.error) return <div className="vm-detail-error" role="alert">{state.error}</div>;
  const network = state.network;
  return <div className="vm-detail-page">
    <nav className="vm-detail-breadcrumb"><Link to="/networks">{t('navigation.networks')}</Link> / {network.name}</nav>
    <div className="card vm-detail-header"><div className="vm-detail-heading"><div><h2>{network.name}</h2>
      <span className="mono dim">{network.id}</span></div></div></div>
    <section className="card vm-detail-content"><h3>{t('network.detail.subnets')}</h3>
      {!network.subnet_details?.length ? <Empty>{t('network.detail.noSubnets')}</Empty> : <div className="vm-detail-table"><table className="tbl">
        <thead><tr><th>{t('common.name')}</th><th>CIDR</th><th>{t('subnet.detail.gateway')}</th><th>DHCP</th></tr></thead>
        <tbody>{network.subnet_details.map((subnet) => <tr key={subnet.id}>
          <td><Link className="link" to={`/networks/${encodeURIComponent(network.id)}/subnets/${encodeURIComponent(subnet.id)}`}>
            {subnet.name || subnet.cidr}</Link></td><td className="mono">{subnet.cidr}</td>
          <td className="mono">{subnet.gateway_ip || '—'}</td><td>{t(subnet.enable_dhcp ? 'networks.on' : 'networks.off')}</td>
        </tr>)}</tbody></table></div>}
    </section>
  </div>;
}
