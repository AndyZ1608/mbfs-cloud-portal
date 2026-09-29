import React from 'react';
import { useI18n } from '../i18n/react.jsx';
import FixedIpInput from './FixedIpInput.jsx';
import { fixedIpError } from '../fixedIp.js';

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

export function selectInterfaceSubnet(value, subnetId) {
  return { ...value, subnet_id: subnetId, ip_address: '' };
}

export function addInterface(interfaces, networks) {
  return [...interfaces, newInterface(networks)];
}

export function removeInterface(interfaces, index) {
  return interfaces.length > 1 ? interfaces.filter((_, at) => at !== index) : interfaces;
}

export function validInterfaces(interfaces, networks) {
  return interfaceValidationError(interfaces, networks) === null;
}

export function interfaceValidationError(interfaces, networks) {
  if (!Array.isArray(interfaces) || !interfaces.length) return 'instance.networkInterfaces.required';
  for (const item of interfaces) {
    const subnet = subnetsForNetwork(networks, item?.network_id).find((candidate) => candidate.id === item?.subnet_id);
    if (!item?.network_id || !subnet) return 'instance.networkInterfaces.required';
    const error = fixedIpError(item.ip_address, subnet);
    if (error) return `instance.networkInterfaces.${error}`;
  }
  return null;
}

export function interfaceRequestSpec({ network_id, subnet_id, ip_address }) {
  return { network_id, subnet_id, ip_address: ip_address.trim() || null };
}

export default function NetworkInterfaceFields({ value, onChange, networks, index, onRemove, disabled = false }) {
  const { t } = useI18n();
  const subnets = subnetsForNetwork(networks, value.network_id);
  const subnet = subnets.find((candidate) => candidate.id === value.subnet_id);
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
        <select value={value.subnet_id} disabled={disabled || !value.network_id} onChange={(event) => onChange(selectInterfaceSubnet(value, event.target.value))}>
          <option value="">{t('instance.networkInterfaces.chooseSubnet')}</option>
          {subnets.map((subnet) => <option key={subnet.id} value={subnet.id}>{subnet.name || subnet.cidr} — {subnet.cidr}</option>)}
        </select>
      </label>
      <FixedIpInput subnet={subnet} value={value.ip_address} disabled={disabled || !subnet}
        onChange={(ip_address) => onChange({ ...value, ip_address })} />
      <div className="field"><span className="field-label">{t('instance.networkInterfaces.securityGroup')}</span>
        <span className="vm-interface-default">{t('instance.networkInterfaces.defaultSecurityGroup')}</span>
      </div>
    </div>
  </div>;
}
