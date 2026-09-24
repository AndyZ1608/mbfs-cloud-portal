import React from 'react';
import { useI18n } from '../i18n/react.jsx';

export function newInterface(networks = []) {
  const network = networks[0];
  return {
    network_id: network?.id || '',
    subnet_id: network?.subnet_details?.[0]?.id || '',
    ip_address: '',
  };
}

export function subnetsForNetwork(networks, networkId) {
  return networks.find((network) => network.id === networkId)?.subnet_details || [];
}

export function selectInterfaceNetwork(networkId) {
  return { network_id: networkId, subnet_id: '', ip_address: '' };
}

export function addInterface(interfaces, networks) {
  return [...interfaces, newInterface(networks)];
}

export function removeInterface(interfaces, index) {
  return interfaces.length > 1 ? interfaces.filter((_, at) => at !== index) : interfaces;
}

export function validInterfaces(interfaces, networks) {
  return Array.isArray(interfaces) && interfaces.length > 0 && interfaces.every((item) =>
    item.network_id && item.subnet_id && subnetsForNetwork(networks, item.network_id).some((subnet) => subnet.id === item.subnet_id));
}

export default function NetworkInterfaceFields({ value, onChange, networks, index, onRemove, disabled = false }) {
  const { t } = useI18n();
  const subnets = subnetsForNetwork(networks, value.network_id);
  return <div className="vm-interface-card">
    <div className="vm-interface-heading">
      <strong>{t('instance.networkInterfaces.interface')} {index + 1}</strong>
      {onRemove && <button className="btn ghost sm" type="button" onClick={onRemove} disabled={disabled}>{t('instance.networkInterfaces.remove')}</button>}
    </div>
    <div className="vm-interface-grid">
      <label className="field"><span className="field-label">{t('instance.networkInterfaces.network')} *</span>
        <select value={value.network_id} disabled={disabled} onChange={(event) => onChange(selectInterfaceNetwork(event.target.value))}>
          <option value="">{t('instance.networkInterfaces.chooseNetwork')}</option>
          {networks.map((network) => <option key={network.id} value={network.id}>{network.name}</option>)}
        </select>
      </label>
      <label className="field"><span className="field-label">{t('instance.networkInterfaces.subnet')} *</span>
        <select value={value.subnet_id} disabled={disabled || !value.network_id} onChange={(event) => onChange({ ...value, subnet_id: event.target.value, ip_address: '' })}>
          <option value="">{t('instance.networkInterfaces.chooseSubnet')}</option>
          {subnets.map((subnet) => <option key={subnet.id} value={subnet.id}>{subnet.name || subnet.cidr} — {subnet.cidr}</option>)}
        </select>
      </label>
      <label className="field"><span className="field-label">{t('instance.networkInterfaces.ipAddress')}</span>
        <input value={value.ip_address} disabled={disabled || !value.subnet_id} onChange={(event) => onChange({ ...value, ip_address: event.target.value })}
          placeholder={t('instance.networkInterfaces.ipOptional')} autoComplete="off" />
      </label>
      <div className="field"><span className="field-label">{t('instance.networkInterfaces.securityGroup')}</span>
        <span className="vm-interface-default">{t('instance.networkInterfaces.defaultSecurityGroup')}</span>
      </div>
    </div>
  </div>;
}
