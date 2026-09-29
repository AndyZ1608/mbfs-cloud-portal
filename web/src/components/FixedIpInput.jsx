import React, { useId, useRef } from 'react';
import { useI18n } from '../i18n/react.jsx';
import { composeSegmentedIp, fixedIpError, segmentedHostOctets, subnetAddressInfo } from '../fixedIp.js';

export default function FixedIpInput({ subnet, value, onChange, disabled = false,
  required = false, labelKey = 'instance.networkInterfaces.ipAddress' }) {
  const { t } = useI18n();
  const labelId = useId();
  const octetRefs = useRef([]);
  const info = subnetAddressInfo(subnet?.cidr);
  const octets = segmentedHostOctets(info, value);
  const error = fixedIpError(value, subnet);

  function changeOctet(index, text) {
    const next = [...octets];
    next[index] = text;
    onChange(composeSegmentedIp(info, next));
    if (/^\d{3}$/.test(text) && index < next.length - 1) octetRefs.current[index + 1]?.focus();
  }

  function keyDown(event, index) {
    if (event.key === '.' && index < octets.length - 1) {
      event.preventDefault();
      octetRefs.current[index + 1]?.focus();
    } else if (event.key === 'Backspace' && !octets[index] && index > 0) {
      octetRefs.current[index - 1]?.focus();
    }
  }

  function paste(event) {
    const text = event.clipboardData.getData('text').trim();
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return;
    event.preventDefault();
    onChange(text);
  }

  return <div className="field">
    <span id={labelId} className="field-label">{t(labelKey)}{required ? ' *' : ''}</span>
    {octets ? <div className="vm-ip-control" role="group" aria-labelledby={labelId}>
      <span className="vm-ip-prefix" aria-hidden="true">{info.fixedParts.join('.')}.</span>
      {octets.map((octet, index) => <React.Fragment key={index}>
        {index > 0 && <span className="vm-ip-dot" aria-hidden="true">.</span>}
        <input ref={(element) => { octetRefs.current[index] = element; }} type="text" inputMode="numeric"
          value={octet} maxLength={3} disabled={disabled} autoComplete="off"
          aria-label={t('instance.networkInterfaces.hostOctet', { index: index + 1 })}
          aria-invalid={!!error} aria-required={required} onChange={(event) => changeOctet(index, event.target.value)}
          onKeyDown={(event) => keyDown(event, index)} onPaste={paste} />
      </React.Fragment>)}
    </div> : <input aria-labelledby={labelId} aria-invalid={!!error} aria-required={required} value={value} disabled={disabled}
      onChange={(event) => onChange(event.target.value)} autoComplete="off" />}
    {subnet?.cidr && !octets && <span className="field-hint">{t('instance.networkInterfaces.subnet')}: {subnet.cidr}</span>}
    {error ? <span className="vm-ip-error" role="alert">{t(`instance.networkInterfaces.${error}`)}</span>
      : required ? !value && <span className="field-hint">{t('vip.addressRequired')}</span>
        : <span className="field-hint">{t('instance.networkInterfaces.autoAssignIp')}</span>}
  </div>;
}
