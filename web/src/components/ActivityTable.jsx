import React from 'react';
import { activityStatus, activityTimestamp, vmActivityName } from '../activityPresentation.js';
import { useI18n } from '../i18n/react.jsx';

export default function ActivityTable({ entries, actionFor, currentNames, currentName }) {
  const { t } = useI18n();
  return <div className="activity-table-wrap"><table className="tbl activity-table">
    <thead><tr>
      <th>{t('audit.time')}</th><th>{t('audit.user')}</th><th>{t('activity.action')}</th>
      <th>{t('activity.vm')}</th><th>{t('activity.status')}</th>
    </tr></thead>
    <tbody>{entries.map((event, index) => {
      const status = activityStatus(event, t);
      return <tr key={`${event.ts}-${index}`}>
        <td className="activity-time">{activityTimestamp(event.ts)}</td>
        <td>{event.user || '—'}</td>
        <td>{actionFor(event)}</td>
        <td className="activity-vm">{vmActivityName(event, t, currentNames, currentName)}</td>
        <td><span className={`badge badge-${status.tone}`}><i />{status.label}</span></td>
      </tr>;
    })}</tbody>
  </table></div>;
}
