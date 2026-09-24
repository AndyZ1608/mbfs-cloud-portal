import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Server, HardDrive, Network, Globe, Shield, Disc3, KeyRound,
  BarChart3, Scale, DatabaseBackup, History, Store, Boxes, Wrench, PiggyBank,
  CalendarClock, Archive, ChevronDown, Activity,
} from 'lucide-react';
import { useI18n } from '../i18n/react.jsx';

// One source of truth for the existing portal routes. Some resources are tabs inside pages,
// not separate routes (for example Routers and Snapshots), so they do not get duplicate links.
export const NAVIGATION = [
  { to: '/', labelKey: 'navigation.dashboard', icon: LayoutDashboard, end: true },
  { key: 'compute', labelKey: 'navigation.compute', icon: Server, children: [
    { to: '/instances', labelKey: 'navigation.instances', icon: Server },
    { to: '/images', labelKey: 'navigation.images', icon: Disc3 },
    { to: '/keypairs', labelKey: 'navigation.keypairs', icon: KeyRound },
  ] },
  { key: 'storage', labelKey: 'navigation.storage', icon: HardDrive, children: [
    { to: '/volumes', labelKey: 'navigation.volumes', icon: HardDrive },
    { to: '/object-storage', labelKey: 'navigation.objectStorage', icon: Archive },
    { to: '/backup', labelKey: 'navigation.backup', icon: DatabaseBackup },
  ] },
  { key: 'network', labelKey: 'navigation.network', icon: Network, children: [
    { to: '/networks', labelKey: 'navigation.networks', icon: Network },
    { to: '/floating-ips', labelKey: 'navigation.floatingIps', icon: Globe },
    { to: '/security-groups', labelKey: 'navigation.securityGroups', icon: Shield },
    { to: '/load-balancers', labelKey: 'navigation.loadBalancers', icon: Scale },
  ] },
  { to: '/billing', labelKey: 'navigation.billing', icon: BarChart3, feature: 'billing' },
  { key: 'platform', labelKey: 'navigation.platform', icon: Boxes, children: [
    { to: '/kubernetes', labelKey: 'navigation.kubernetes', icon: Boxes },
    { to: '/marketplace', labelKey: 'navigation.marketplace', icon: Store },
  ] },
  { key: 'operations', labelKey: 'navigation.operations', icon: Activity, children: [
    { to: '/power', labelKey: 'navigation.power', icon: CalendarClock },
    { to: '/optimize', labelKey: 'navigation.optimize', icon: PiggyBank },
    { to: '/audit', labelKey: 'navigation.audit', icon: History },
    { to: '/admin', labelKey: 'navigation.admin', icon: Wrench, roles: ['admin'] },
  ] },
];

export function visibleNavigation({ config = {}, roles = [], navigation = NAVIGATION } = {}) {
  const permitted = (item) => (!item.feature || (item.feature === 'billing' && config.billingEnabled))
    && (!item.roles || item.roles.some((role) => roles?.includes(role)));
  return navigation.flatMap((entry) => {
    if (!entry.children) return permitted(entry) ? [entry] : [];
    const children = entry.children.filter(permitted);
    return children.length ? [{ ...entry, children }] : [];
  });
}

export function routeMatchesItem(pathname, item) {
  return pathname === item.to || (item.to !== '/' && pathname.startsWith(`${item.to}/`));
}

export function activeGroupForPath(pathname, navigation = NAVIGATION) {
  return navigation.find((entry) => entry.children?.some((item) => routeMatchesItem(pathname, item)))?.key || null;
}

export function toggleOpenGroup(current, key) {
  return current === key ? null : key;
}

export default function SidebarNavigation({ config, roles }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const entries = visibleNavigation({ config, roles });
  const activeGroup = activeGroupForPath(pathname, entries);
  const routeKey = `${pathname}:${activeGroup || ''}`;
  const [selection, setSelection] = useState({ routeKey, openGroup: activeGroup });
  // Route/visibility changes take precedence immediately; language changes leave selection intact.
  const openGroup = selection.routeKey === routeKey ? selection.openGroup : activeGroup;

  return (
    <nav className="sidebar-nav" aria-label={t('navigation.primary')}>
      {entries.map((entry) => {
        if (!entry.children) {
          const Icon = entry.icon;
          return <NavLink key={entry.to} to={entry.to} end={entry.end} title={t(entry.labelKey)} aria-label={t(entry.labelKey)}
            className={({ isActive }) => `nav-item nav-standalone${entry.to === '/' ? ' nav-dashboard' : ''}${isActive ? ' active' : ''}`}>
            <Icon size={17} aria-hidden="true" /><span>{t(entry.labelKey)}</span>
          </NavLink>;
        }
        const Icon = entry.icon;
        const isOpen = openGroup === entry.key;
        const isCurrent = activeGroup === entry.key;
        const groupId = `nav-group-${entry.key}`;
        return <div className={`nav-group${isCurrent ? ' current' : ''}`} key={entry.key}>
          <button type="button" className={`nav-group-trigger${isOpen ? ' expanded' : ''}`}
            aria-label={t(entry.labelKey)} aria-expanded={isOpen} aria-controls={groupId}
            title={t(entry.labelKey)} onClick={() => setSelection({ routeKey, openGroup: toggleOpenGroup(openGroup, entry.key) })}>
            <Icon size={17} aria-hidden="true" />
            <span className="nav-group-label">{t(entry.labelKey)}</span>
            <ChevronDown size={14} className="nav-group-chevron" aria-hidden="true" />
          </button>
          <div id={groupId} className="nav-children" hidden={!isOpen}>
            {entry.children.map((child) => {
              const ChildIcon = child.icon;
              return <NavLink key={child.to} to={child.to} title={t(child.labelKey)} aria-label={t(child.labelKey)}
                className={({ isActive }) => `nav-item nav-child${isActive ? ' active' : ''}`}>
                <ChildIcon size={15} aria-hidden="true" /><span>{t(child.labelKey)}</span>
              </NavLink>;
            })}
          </div>
        </div>;
      })}
    </nav>
  );
}
