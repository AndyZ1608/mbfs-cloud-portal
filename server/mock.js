// mock.js — giả lập OpenStack API (OS_MOCK=true) để demo UI không cần cluster thật
import { randomUUID } from 'crypto';

const uid = () => randomUUID();
const now = () => new Date().toISOString();

// ---------- state ----------
const flavors = [
  { id: 'f-small', name: 'm1.small', vcpus: 1, ram: 2048, disk: 20 },
  { id: 'f-medium', name: 'm1.medium', vcpus: 2, ram: 4096, disk: 40 },
  { id: 'f-large', name: 'm1.large', vcpus: 4, ram: 8192, disk: 80 },
  { id: 'f-xlarge', name: 'm1.xlarge', vcpus: 8, ram: 16384, disk: 160 },
];

const images = [
  { id: uid(), name: 'Ubuntu 22.04 LTS', status: 'active', visibility: 'public', size: 652804096, disk_format: 'qcow2', created_at: '2026-01-10T03:00:00Z' },
  { id: uid(), name: 'Ubuntu 24.04 LTS', status: 'active', visibility: 'public', size: 701235200, disk_format: 'qcow2', created_at: '2026-03-02T03:00:00Z' },
  { id: uid(), name: 'Rocky Linux 9', status: 'active', visibility: 'public', size: 1258291200, disk_format: 'qcow2', created_at: '2026-02-15T03:00:00Z' },
  { id: uid(), name: 'Windows Server 2022', status: 'active', visibility: 'private', size: 12884901888, disk_format: 'qcow2', created_at: '2026-04-20T03:00:00Z' },
];

const netInternal = { id: uid(), name: 'net-internal', status: 'ACTIVE', 'router:external': false, shared: false, subnets: [] };
const netDmz = { id: uid(), name: 'net-dmz', status: 'ACTIVE', 'router:external': false, shared: false, subnets: [] };
const netPublic = { id: uid(), name: 'public', status: 'ACTIVE', 'router:external': true, shared: true, subnets: [] };
const networks = [netInternal, netDmz, netPublic];

const subnets = [
  { id: uid(), name: 'subnet-internal', network_id: netInternal.id, cidr: '10.10.10.0/24', gateway_ip: '10.10.10.1', ip_version: 4, enable_dhcp: true, dns_nameservers: ['8.8.8.8'] },
  { id: uid(), name: 'subnet-dmz', network_id: netDmz.id, cidr: '10.20.0.0/24', gateway_ip: '10.20.0.1', ip_version: 4, enable_dhcp: true, dns_nameservers: [] },
  { id: uid(), name: 'subnet-public', network_id: netPublic.id, cidr: '203.0.113.0/24', gateway_ip: '203.0.113.1', ip_version: 4, enable_dhcp: false, dns_nameservers: [] },
];
subnets.forEach((s) => networks.find((n) => n.id === s.network_id).subnets.push(s.id));

const sgDefault = { id: uid(), name: 'default', description: 'Default security group', security_group_rules: [] };
const sgWeb = { id: uid(), name: 'web-server', description: 'HTTP/HTTPS/SSH', security_group_rules: [] };
const secgroups = [sgDefault, sgWeb];
function addRule(sg, dir, proto, min, max, cidr) {
  sg.security_group_rules.push({ id: uid(), security_group_id: sg.id, direction: dir, ethertype: 'IPv4', protocol: proto, port_range_min: min, port_range_max: max, remote_ip_prefix: cidr });
}
addRule(sgDefault, 'egress', null, null, null, null);
addRule(sgWeb, 'egress', null, null, null, null);
addRule(sgWeb, 'ingress', 'tcp', 22, 22, '10.0.0.0/8');
addRule(sgWeb, 'ingress', 'tcp', 80, 80, '0.0.0.0/0');
addRule(sgWeb, 'ingress', 'tcp', 443, 443, '0.0.0.0/0');

const keypairs = [{ name: 'hieptd-key', fingerprint: 'a1:b2:c3:d4:e5:f6:07:18:29:3a:4b:5c:6d:7e:8f:90', public_key: 'ssh-ed25519 AAAAC3Nza...' }];

const servers = [];
const ports = [];
function seedServer(name, flavor, imageIdx, ip, status) {
  const s = {
    id: uid(), name, status, created: '2026-05-11T08:30:00Z', updated: now(),
    flavor: { ...flavors.find((f) => f.id === flavor), original_name: flavors.find((f) => f.id === flavor).name },
    image: { id: images[imageIdx].id }, key_name: 'hieptd-key',
    security_groups: [{ name: 'default' }],
    addresses: { 'net-internal': [{ addr: ip, 'OS-EXT-IPS:type': 'fixed' }] },
    'os-extended-volumes:volumes_attached': [],
    'OS-EXT-STS:task_state': null, 'OS-EXT-AZ:availability_zone': 'nova',
  };
  servers.push(s);
  ports.push({ id: uid(), network_id: netInternal.id, device_id: s.id, device_owner: 'compute:nova', fixed_ips: [{ ip_address: ip, subnet_id: subnets[0].id }], status: 'ACTIVE' });
  return s;
}
const sv1 = seedServer('portal-web-01', 'f-medium', 0, '10.10.10.11', 'ACTIVE');
const sv2 = seedServer('db-postgres-01', 'f-large', 1, '10.10.10.12', 'ACTIVE');
seedServer('runner-ci-01', 'f-small', 0, '10.10.10.13', 'SHUTOFF');
sv1.security_groups = [{ name: 'default' }, { name: 'web-server' }];

const routers = [{ id: uid(), name: 'rt-main', status: 'ACTIVE', external_gateway_info: { network_id: netPublic.id } }];
ports.push({ id: uid(), network_id: netInternal.id, device_id: routers[0].id, device_owner: 'network:router_interface', fixed_ips: [{ ip_address: '10.10.10.1', subnet_id: subnets[0].id }], status: 'ACTIVE' });

const fip1 = { id: uid(), floating_ip_address: '203.0.113.15', floating_network_id: netPublic.id, port_id: ports[0].id, fixed_ip_address: '10.10.10.11', status: 'ACTIVE' };
const fip2 = { id: uid(), floating_ip_address: '203.0.113.16', floating_network_id: netPublic.id, port_id: null, fixed_ip_address: null, status: 'DOWN' };
const floatingips = [fip1, fip2];
sv1.addresses['net-internal'].push({ addr: fip1.floating_ip_address, 'OS-EXT-IPS:type': 'floating' });

const volumes = [
  { id: uid(), name: 'data-postgres', size: 100, status: 'in-use', volume_type: 'ssd', bootable: 'false', created_at: '2026-05-11T09:00:00Z', attachments: [{ server_id: sv2.id, device: '/dev/vdb' }] },
  { id: uid(), name: 'backup-vol', size: 50, status: 'available', volume_type: 'hdd', bootable: 'false', created_at: '2026-06-01T09:00:00Z', attachments: [] },
];
sv2['os-extended-volumes:volumes_attached'] = [{ id: volumes[0].id }];

const snapshots = [{ id: uid(), name: 'snap-data-postgres-0601', volume_id: volumes[0].id, size: 100, status: 'available', created_at: '2026-06-01T02:00:00Z' }];

// ---------- auth mock ----------
export function mockAuth(username) {
  return { token: 'mock-unscoped-' + username + '::' + uid(), user: { id: 'u-' + username, name: username, domain: { name: 'Default' } } };
}
export function mockProjects() {
  return [
    { id: 'p-demo', name: 'demo-project', enabled: true },
    { id: 'p-devops', name: 'devops-team', enabled: true },
  ];
}
export function mockScope(projectId, unscopedToken) {
  const uname = (String(unscopedToken || '').match(/^mock-unscoped-(.+)::/) || [])[1] || 'demo';
  const p = mockProjects().find((x) => x.id === projectId) || mockProjects()[0];
  return { token: 'mock-scoped-' + uid(), user: { id: 'u-' + uname, name: uname, domain: { name: 'Default' } }, project: p, catalog: [], roles: uname === 'admin' ? ['admin', 'member'] : ['member'], expires: new Date(Date.now() + 8 * 3600e3).toISOString() };
}

// ---------- API mock router ----------
function parse(path) {
  const u = new URL('http://x' + path);
  return { path: u.pathname.replace(/\/+$/, '') || '/', q: u.searchParams };
}
const notFound = () => { const e = new Error('Không tìm thấy tài nguyên (mock)'); e.status = 404; return e; };

export function mockFetch(svc, method, rawPath, body) {
  const { path, q } = parse(rawPath);
  const m = method.toUpperCase();

  if (svc === 'compute') return mockCompute(m, path, body);
  if (svc === 'network') return mockNetwork(m, path, q, body);
  if (svc === 'volume') return mockVolume(m, path, body);
  if (svc === 'image') return mockImage(m, path, body);
  if (svc === 'lb') return mockLb(m, path, q, body);
  if (svc === 'identity') return mockIdentity(m, path, q, body);
  throw notFound();
}

function serverIps(s) {
  return s.addresses;
}

function mockCompute(m, path, body) {
  let dmt;
  if ((dmt = path.match(/^\/servers\/([^/]+)\/diagnostics$/)) && m === 'GET') return mockDiagnostics(dmt[1]);
  if (m === 'GET' && path === '/os-hypervisors/statistics') {
    return { hypervisor_statistics: { count: 3, vcpus: 96, vcpus_used: 41, memory_mb: 393216, memory_mb_used: 176128, local_gb: 6000, local_gb_used: 2150, running_vms: servers.length + 11, current_workload: 0 } };
  }
  let qmt;
  if ((qmt = path.match(/^\/os-quota-sets\/([^/]+)$/))) {
    mockQuotas[qmt[1]] = mockQuotas[qmt[1]] || { instances: 100, cores: 171, ram: 122880, volumes: 100, gigabytes: 135, snapshots: 10, floatingip: 50, network: 100, security_group: 10 };
    if (m === 'GET') return { quota_set: mockQuotas[qmt[1]] };
    if (m === 'PUT') { Object.assign(mockQuotas[qmt[1]], body.quota_set); return { quota_set: mockQuotas[qmt[1]] }; }
  }
  let mt;
  if (m === 'GET' && path === '/servers/detail') return { servers };
  if (m === 'POST' && path === '/servers') {
    const b = body.server;
    const count = Math.min(Number(b.max_count || 1), 10);
    const created = [];
    for (let i = 0; i < count; i++) {
      const name = count > 1 ? `${b.name}-${i + 1}` : b.name;
      const fl = flavors.find((f) => f.id === b.flavorRef) || flavors[0];
      const netId = (b.networks && b.networks[0] && b.networks[0].uuid) || netInternal.id;
      const net = networks.find((n) => n.id === netId) || netInternal;
      const ip = '10.10.10.' + (20 + servers.length + i);
      const s = {
        id: uid(), name, status: 'BUILD', created: now(), updated: now(),
        flavor: { ...fl, original_name: fl.name },
        image: { id: b.imageRef || (b.block_device_mapping_v2 ? b.block_device_mapping_v2[0].uuid : images[0].id) },
        key_name: b.key_name || null,
        security_groups: b.security_groups || [{ name: 'default' }],
        addresses: {},
        'os-extended-volumes:volumes_attached': [],
        'OS-EXT-STS:task_state': 'spawning', 'OS-EXT-AZ:availability_zone': 'nova',
      };
      servers.push(s);
      created.push(s);
      setTimeout(() => {
        s.status = 'ACTIVE';
        s['OS-EXT-STS:task_state'] = null;
        s.addresses[net.name] = [{ addr: ip, 'OS-EXT-IPS:type': 'fixed' }];
        ports.push({ id: uid(), network_id: net.id, device_id: s.id, device_owner: 'compute:nova', fixed_ips: [{ ip_address: ip, subnet_id: (net.subnets[0] || '') }], status: 'ACTIVE' });
      }, 6000);
    }
    return { server: created[0] };
  }
  if ((mt = path.match(/^\/servers\/([^/]+)$/))) {
    const s = servers.find((x) => x.id === mt[1]);
    if (!s) throw notFound();
    if (m === 'GET') return { server: { ...s, addresses: serverIps(s) } };
    if (m === 'DELETE') {
      servers.splice(servers.indexOf(s), 1);
      floatingips.forEach((f) => { const p = ports.find((pp) => pp.id === f.port_id); if (p && p.device_id === s.id) { f.port_id = null; f.status = 'DOWN'; f.fixed_ip_address = null; } });
      for (let i = ports.length - 1; i >= 0; i--) if (ports[i].device_id === s.id) ports.splice(i, 1);
      volumes.forEach((v) => { v.attachments = v.attachments.filter((a) => a.server_id !== s.id); if (!v.attachments.length && v.status === 'in-use') v.status = 'available'; });
      return null;
    }
  }
  if ((mt = path.match(/^\/servers\/([^/]+)$/)) && m === 'PUT') {
    const s = servers.find((x) => x.id === mt[1]);
    if (!s) throw notFound();
    if (body?.server?.name) s.name = body.server.name;
    return { server: s };
  }
  if ((mt = path.match(/^\/servers\/([^/]+)\/action$/)) && m === 'POST') {
    const s = servers.find((x) => x.id === mt[1]);
    if (!s) throw notFound();
    if ('os-start' in body) s.status = 'ACTIVE';
    else if ('os-stop' in body) s.status = 'SHUTOFF';
    else if ('pause' in body) s.status = 'PAUSED';
    else if ('unpause' in body) s.status = 'ACTIVE';
    else if ('reboot' in body) { s.status = 'REBOOT'; setTimeout(() => (s.status = 'ACTIVE'), 4000); }
    else if ('resize' in body) {
      const fl = flavors.find((f) => f.id === body.resize.flavorRef);
      if (!fl) throw notFound();
      s.status = 'RESIZE';
      setTimeout(() => { s.status = 'VERIFY_RESIZE'; s._pendingFlavor = fl; }, 3000);
    }
    else if ('confirmResize' in body) {
      if (s._pendingFlavor) { s.flavor = { ...s._pendingFlavor, original_name: s._pendingFlavor.name }; delete s._pendingFlavor; }
      s.status = 'ACTIVE';
    }
    else if ('revertResize' in body) { delete s._pendingFlavor; s.status = 'ACTIVE'; }
    else if ('os-getConsoleOutput' in body) {
      const lines = [
        `[    0.000000] Linux version 5.15.0-generic (buildd@mock) #mock SMP`,
        `[    1.204311] virtio_net virtio0 ens3: renamed from eth0`,
        `[    2.881904] cloud-init[812]: Cloud-init v. 24.1 running 'init'`,
        `[    3.107257] cloud-init[812]: ci-info: | ens3 | True | 10.10.10.x | 255.255.255.0 |`,
        `[    4.559200] cloud-init[988]: SSH host keys generated.`,
        ``,
        `${s.name} login: `,
      ];
      return { output: lines.join('\n') };
    }
    else if ('createImage' in body) {
      const img = { id: uid(), name: body.createImage.name, status: 'active', visibility: 'private', size: 2147483648, disk_format: 'qcow2', created_at: now() };
      images.unshift(img);
      return { image_id: img.id };
    }
    return null;
  }
  if ((mt = path.match(/^\/servers\/([^/]+)\/remote-consoles$/)) && m === 'POST') {
    return { remote_console: { protocol: 'vnc', type: 'novnc', url: 'https://novnc.mbfs.vn/vnc_auto.html?path=%3Ftoken%3Dmock-' + mt[1].slice(0, 8) } };
  }
  if (path.match(/^\/os-simple-tenant-usage\/[^/]+$/) && m === 'GET') {
    const nowMs = Date.now();
    const server_usages = servers.map((s) => {
      const hours = Math.min(720, Math.max(0.5, (nowMs - new Date(s.created).getTime()) / 3600000));
      const h = Math.round(hours * 100) / 100;
      return {
        instance_id: s.id, name: s.name, state: s.status === 'SHUTOFF' ? 'stopped' : 'active',
        vcpus: s.flavor.vcpus, memory_mb: s.flavor.ram, local_gb: s.flavor.disk,
        hours: h, uptime: Math.round(h * 3600), started_at: s.created, ended_at: null,
      };
    });
    const sum = (fn) => Math.round(server_usages.reduce((a, u) => a + fn(u), 0) * 100) / 100;
    return {
      tenant_usage: {
        server_usages,
        total_hours: sum((u) => u.hours),
        total_vcpus_usage: sum((u) => u.vcpus * u.hours),
        total_memory_mb_usage: sum((u) => u.memory_mb * u.hours),
        total_local_gb_usage: sum((u) => u.local_gb * u.hours),
      },
    };
  }
  if ((mt = path.match(/^\/servers\/([^/]+)\/os-volume_attachments$/))) {
    const s = servers.find((x) => x.id === mt[1]);
    if (!s) throw notFound();
    if (m === 'GET') return { volumeAttachments: volumes.filter((v) => v.attachments.some((a) => a.server_id === s.id)).map((v) => ({ id: v.id, volumeId: v.id, serverId: s.id, device: v.attachments[0].device })) };
    if (m === 'POST') {
      const v = volumes.find((x) => x.id === body.volumeAttachment.volumeId);
      if (!v) throw notFound();
      v.status = 'attaching';
      setTimeout(() => { v.status = 'in-use'; v.attachments = [{ server_id: s.id, device: '/dev/vdb' }]; s['os-extended-volumes:volumes_attached'].push({ id: v.id }); }, 2000);
      return { volumeAttachment: { id: v.id, volumeId: v.id, serverId: s.id } };
    }
  }
  if ((mt = path.match(/^\/servers\/([^/]+)\/os-volume_attachments\/([^/]+)$/)) && m === 'DELETE') {
    const s = servers.find((x) => x.id === mt[1]);
    const v = volumes.find((x) => x.id === mt[2]);
    if (!s || !v) throw notFound();
    v.status = 'detaching';
    setTimeout(() => { v.status = 'available'; v.attachments = []; s['os-extended-volumes:volumes_attached'] = s['os-extended-volumes:volumes_attached'].filter((a) => a.id !== v.id); }, 2000);
    return null;
  }
  if (m === 'GET' && path === '/flavors/detail') return { flavors };
  if (m === 'GET' && path === '/os-keypairs') return { keypairs: keypairs.map((k) => ({ keypair: k })) };
  if (m === 'POST' && path === '/os-keypairs') {
    const k = { name: body.keypair.name, fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99', public_key: body.keypair.public_key || 'ssh-ed25519 AAAA-generated-mock' };
    keypairs.push(k);
    const out = { keypair: { ...k } };
    if (!body.keypair.public_key) out.keypair.private_key = '-----BEGIN OPENSSH PRIVATE KEY-----\n(mock private key - demo mode)\nb3BlbnNzaC1rZXktdjEAAAAA...\n-----END OPENSSH PRIVATE KEY-----\n';
    return out;
  }
  if ((mt = path.match(/^\/os-keypairs\/([^/]+)$/)) && m === 'DELETE') {
    const i = keypairs.findIndex((k) => k.name === decodeURIComponent(mt[1]));
    if (i < 0) throw notFound();
    keypairs.splice(i, 1);
    return null;
  }
  if (m === 'GET' && path === '/limits') {
    const used = servers.reduce((a, s) => ({ cores: a.cores + (s.flavor.vcpus || 0), ram: a.ram + (s.flavor.ram || 0) }), { cores: 0, ram: 0 });
    return { limits: { absolute: { maxTotalInstances: 20, totalInstancesUsed: servers.length, maxTotalCores: 40, totalCoresUsed: used.cores, maxTotalRAMSize: 98304, totalRAMUsed: used.ram } } };
  }
  throw notFound();
}

function mockNetwork(m, path, q, body) {
  let qmt;
  if ((qmt = path.match(/^\/v2\.0\/quotas\/([^/]+)$/)) && !path.endsWith('.json')) {
    mockQuotas[qmt[1]] = mockQuotas[qmt[1]] || { instances: 100, cores: 171, ram: 122880, volumes: 100, gigabytes: 135, snapshots: 10, floatingip: 50, network: 100, security_group: 10 };
    if (m === 'GET') return { quota: mockQuotas[qmt[1]] };
    if (m === 'PUT') { Object.assign(mockQuotas[qmt[1]], body.quota); return { quota: mockQuotas[qmt[1]] }; }
  }
  let mt;
  if (path === '/v2.0/networks' && m === 'GET') {
    let list = networks;
    if (q.get('router:external') === 'true') list = networks.filter((n) => n['router:external']);
    return { networks: list };
  }
  if (path === '/v2.0/networks' && m === 'POST') {
    const n = { id: uid(), name: body.network.name, status: 'ACTIVE', 'router:external': false, shared: false, subnets: [] };
    networks.push(n);
    return { network: n };
  }
  if ((mt = path.match(/^\/v2\.0\/networks\/([^/]+)$/)) && m === 'DELETE') {
    const i = networks.findIndex((n) => n.id === mt[1]);
    if (i < 0) throw notFound();
    if (ports.some((p) => p.network_id === mt[1] && p.device_owner.startsWith('compute'))) { const e = new Error('Network đang được máy ảo sử dụng'); e.status = 409; throw e; }
    for (let j = subnets.length - 1; j >= 0; j--) if (subnets[j].network_id === mt[1]) subnets.splice(j, 1);
    networks.splice(i, 1);
    return null;
  }
  if (path === '/v2.0/subnets' && m === 'GET') return { subnets };
  if (path === '/v2.0/subnets' && m === 'POST') {
    const s = { id: uid(), ip_version: 4, enable_dhcp: true, dns_nameservers: [], ...body.subnet };
    if (!s.gateway_ip) s.gateway_ip = s.cidr.replace(/\.\d+\/\d+$/, '.1');
    subnets.push(s);
    const n = networks.find((x) => x.id === s.network_id);
    if (n) n.subnets.push(s.id);
    return { subnet: s };
  }
  if (path === '/v2.0/ports' && m === 'GET') {
    let list = ports;
    const dev = q.get('device_id');
    if (dev) list = list.filter((p) => p.device_id === dev);
    const ids = q.getAll('id');
    if (ids.length) list = list.filter((p) => ids.includes(p.id));
    return { ports: list };
  }
  if (path === '/v2.0/floatingips' && m === 'GET') return { floatingips };
  if (path === '/v2.0/floatingips' && m === 'POST') {
    const f = { id: uid(), floating_ip_address: '203.0.113.' + (20 + floatingips.length), floating_network_id: body.floatingip.floating_network_id, port_id: null, fixed_ip_address: null, status: 'DOWN' };
    const pid = body.floatingip.port_id;
    if (pid) {
      const port = ports.find((p) => p.id === pid);
      if (!port) throw notFound();
      f.port_id = pid;
      f.fixed_ip_address = port.fixed_ips[0]?.ip_address || null;
      f.status = 'ACTIVE';
      const srv = servers.find((s) => s.id === port.device_id);
      if (srv) {
        const netName = (networks.find((n) => n.id === port.network_id) || {}).name || 'net';
        (srv.addresses[netName] = srv.addresses[netName] || []).push({ addr: f.floating_ip_address, 'OS-EXT-IPS:type': 'floating' });
      }
    }
    floatingips.push(f);
    return { floatingip: f };
  }
  if ((mt = path.match(/^\/v2\.0\/floatingips\/([^/]+)$/))) {
    const f = floatingips.find((x) => x.id === mt[1]);
    if (!f) throw notFound();
    if (m === 'PUT') {
      const pid = body.floatingip.port_id;
      // gỡ IP nổi khỏi addresses của server cũ
      const oldPort = ports.find((p) => p.id === f.port_id);
      if (oldPort) {
        const oldSrv = servers.find((s) => s.id === oldPort.device_id);
        if (oldSrv) Object.values(oldSrv.addresses).forEach((arr) => { const i = arr.findIndex((a) => a.addr === f.floating_ip_address); if (i >= 0) arr.splice(i, 1); });
      }
      f.port_id = pid || null;
      if (pid) {
        const p = ports.find((x) => x.id === pid);
        f.fixed_ip_address = p ? p.fixed_ips[0].ip_address : null;
        f.status = 'ACTIVE';
        const srv = p && servers.find((s) => s.id === p.device_id);
        if (srv) {
          const netName = (networks.find((n) => n.id === p.network_id) || {}).name || 'net';
          (srv.addresses[netName] = srv.addresses[netName] || []).push({ addr: f.floating_ip_address, 'OS-EXT-IPS:type': 'floating' });
        }
      } else { f.fixed_ip_address = null; f.status = 'DOWN'; }
      return { floatingip: f };
    }
    if (m === 'DELETE') { floatingips.splice(floatingips.indexOf(f), 1); return null; }
  }
  if (path === '/v2.0/security-groups' && m === 'GET') return { security_groups: secgroups };
  if (path === '/v2.0/security-groups' && m === 'POST') {
    const g = { id: uid(), name: body.security_group.name, description: body.security_group.description || '', security_group_rules: [] };
    addRule(g, 'egress', null, null, null, null);
    secgroups.push(g);
    return { security_group: g };
  }
  if ((mt = path.match(/^\/v2\.0\/security-groups\/([^/]+)$/)) && m === 'DELETE') {
    const i = secgroups.findIndex((g) => g.id === mt[1]);
    if (i < 0) throw notFound();
    secgroups.splice(i, 1);
    return null;
  }
  if (path === '/v2.0/security-group-rules' && m === 'POST') {
    const r = { id: uid(), ethertype: 'IPv4', ...body.security_group_rule };
    const g = secgroups.find((x) => x.id === r.security_group_id);
    if (!g) throw notFound();
    g.security_group_rules.push(r);
    return { security_group_rule: r };
  }
  if ((mt = path.match(/^\/v2\.0\/security-group-rules\/([^/]+)$/)) && m === 'DELETE') {
    for (const g of secgroups) {
      const i = g.security_group_rules.findIndex((r) => r.id === mt[1]);
      if (i >= 0) { g.security_group_rules.splice(i, 1); return null; }
    }
    throw notFound();
  }
  if (path === '/v2.0/routers' && m === 'GET') return { routers };
  if (path === '/v2.0/routers' && m === 'POST') {
    const r = { id: uid(), name: body.router.name, status: 'ACTIVE', external_gateway_info: body.router.external_gateway_info || null };
    routers.push(r);
    return { router: r };
  }
  if ((mt = path.match(/^\/v2\.0\/routers\/([^/]+)\/add_router_interface$/)) && m === 'PUT') {
    const r = routers.find((x) => x.id === mt[1]);
    const s = subnets.find((x) => x.id === body.subnet_id);
    if (!r || !s) throw notFound();
    ports.push({ id: uid(), network_id: s.network_id, device_id: r.id, device_owner: 'network:router_interface', fixed_ips: [{ ip_address: s.gateway_ip, subnet_id: s.id }], status: 'ACTIVE' });
    return { subnet_id: s.id, port_id: ports[ports.length - 1].id };
  }
  if ((mt = path.match(/^\/v2\.0\/routers\/([^/]+)\/remove_router_interface$/)) && m === 'PUT') {
    const i = ports.findIndex((p) => p.device_id === mt[1] && p.fixed_ips.some((f) => f.subnet_id === body.subnet_id));
    if (i < 0) throw notFound();
    ports.splice(i, 1);
    return { subnet_id: body.subnet_id };
  }
  if ((mt = path.match(/^\/v2\.0\/routers\/([^/]+)$/)) && m === 'DELETE') {
    if (ports.some((p) => p.device_id === mt[1])) { const e = new Error('Router còn interface, hãy gỡ interface trước'); e.status = 409; throw e; }
    const i = routers.findIndex((r) => r.id === mt[1]);
    if (i < 0) throw notFound();
    routers.splice(i, 1);
    return null;
  }
  if ((mt = path.match(/^\/v2\.0\/quotas\/([^/]+)\/details\.json$/)) && m === 'GET') {
    return { quota: { floatingip: { limit: 10, used: floatingips.length, reserved: 0 }, network: { limit: 10, used: networks.length, reserved: 0 }, router: { limit: 5, used: routers.length, reserved: 0 }, security_group: { limit: 20, used: secgroups.length, reserved: 0 }, port: { limit: 100, used: ports.length, reserved: 0 } } };
  }
  throw notFound();
}

function mockVolume(m, path, body) {
  let qmt;
  if ((qmt = path.match(/^\/os-quota-sets\/([^/]+)$/))) {
    mockQuotas[qmt[1]] = mockQuotas[qmt[1]] || { instances: 100, cores: 171, ram: 122880, volumes: 100, gigabytes: 135, snapshots: 10, floatingip: 50, network: 100, security_group: 10 };
    if (m === 'GET') return { quota_set: mockQuotas[qmt[1]] };
    if (m === 'PUT') { Object.assign(mockQuotas[qmt[1]], body.quota_set); return { quota_set: mockQuotas[qmt[1]] }; }
  }
  let mt;
  if (m === 'GET' && path === '/volumes/detail') return { volumes };
  if (m === 'POST' && path === '/volumes') {
    const v = { id: uid(), name: body.volume.name || '', size: Number(body.volume.size), status: 'creating', volume_type: body.volume.volume_type || 'ssd', bootable: 'false', created_at: now(), attachments: [] };
    volumes.push(v);
    setTimeout(() => (v.status = 'available'), 2500);
    return { volume: v };
  }
  if ((mt = path.match(/^\/volumes\/([^/]+)$/)) && m === 'DELETE') {
    const v = volumes.find((x) => x.id === mt[1]);
    if (!v) throw notFound();
    if (v.status === 'in-use') { const e = new Error('Volume đang gắn vào máy ảo, hãy tháo trước'); e.status = 400; throw e; }
    volumes.splice(volumes.indexOf(v), 1);
    return null;
  }
  if ((mt = path.match(/^\/volumes\/([^/]+)\/action$/)) && m === 'POST') {
    const v = volumes.find((x) => x.id === mt[1]);
    if (!v) throw notFound();
    if (body['os-extend']) {
      v.status = 'extending';
      setTimeout(() => { v.size = Number(body['os-extend'].new_size); v.status = v.attachments.length ? 'in-use' : 'available'; }, 2000);
    }
    return null;
  }
  if (m === 'GET' && path === '/snapshots/detail') return { snapshots };
  if (m === 'POST' && path === '/snapshots') {
    const src = volumes.find((v) => v.id === body.snapshot.volume_id);
    const s = { id: uid(), name: body.snapshot.name, volume_id: body.snapshot.volume_id, size: src ? src.size : 0, status: 'creating', created_at: now() };
    snapshots.push(s);
    setTimeout(() => (s.status = 'available'), 2500);
    return { snapshot: s };
  }
  if ((mt = path.match(/^\/snapshots\/([^/]+)$/)) && m === 'DELETE') {
    const i = snapshots.findIndex((s) => s.id === mt[1]);
    if (i < 0) throw notFound();
    snapshots.splice(i, 1);
    return null;
  }
  if (m === 'GET' && path === '/types') return { volume_types: [{ id: 't1', name: 'ssd' }, { id: 't2', name: 'hdd' }] };
  if (m === 'GET' && path === '/limits') {
    const used = volumes.reduce((a, v) => a + v.size, 0);
    return { limits: { absolute: { maxTotalVolumes: 30, totalVolumesUsed: volumes.length, maxTotalVolumeGigabytes: 1000, totalGigabytesUsed: used, maxTotalSnapshots: 30, totalSnapshotsUsed: snapshots.length } } };
  }
  throw notFound();
}

function mockImage(m, path, body) {
  let mt;
  if (m === 'GET' && path === '/v2/images') return { images };
  if (m === 'POST' && path === '/v2/images') {
    const img = {
      id: uid(), name: body.name, status: 'queued', visibility: body.visibility || 'private',
      disk_format: body.disk_format, container_format: body.container_format || 'bare',
      size: null, min_disk: body.min_disk || 0, min_ram: body.min_ram || 0, created_at: now(),
    };
    images.unshift(img);
    return img;
  }
  if ((mt = path.match(/^\/v2\/images\/([^/]+)\/file$/)) && m === 'PUT') {
    const img = images.find((i) => i.id === mt[1]);
    if (!img) throw notFound();
    img.status = 'saving';
    img.size = body?.size || 0;
    setTimeout(() => { img.status = 'active'; }, 2500);
    return null;
  }
  if ((mt = path.match(/^\/v2\/images\/([^/]+)$/)) && m === 'DELETE') {
    const img = images.find((i) => i.id === mt[1]);
    if (!img) throw notFound();
    if (img.visibility === 'public') { const e = new Error('Không thể xoá image public (cần quyền admin)'); e.status = 403; throw e; }
    images.splice(images.indexOf(img), 1);
    return null;
  }
  throw notFound();
}

// ---------- Octavia (Load Balancer) ----------

const loadbalancers = [];
const lbListeners = [];
const lbPools = [];

function seedLb() {
  const vipPort = { id: uid(), network_id: netInternal.id, device_id: 'lb-seed', device_owner: 'octavia', fixed_ips: [{ ip_address: '10.10.10.200', subnet_id: subnets[0].id }], status: 'ACTIVE' };
  ports.push(vipPort);
  const pool = {
    id: uid(), name: 'lb-web-pool', protocol: 'HTTP', lb_algorithm: 'ROUND_ROBIN',
    provisioning_status: 'ACTIVE', operating_status: 'ONLINE',
    members: [
      { id: uid(), name: 'portal-web-01', address: '10.10.10.11', protocol_port: 80, operating_status: 'ONLINE', provisioning_status: 'ACTIVE', subnet_id: subnets[0].id },
    ],
    healthmonitor: { id: uid(), type: 'HTTP', delay: 5, timeout: 5, max_retries: 3, url_path: '/', operating_status: 'ONLINE' },
  };
  pool.healthmonitor_id = pool.healthmonitor.id;
  lbPools.push(pool);
  const lb = {
    id: uid(), name: 'lb-web', description: '', provider: 'amphora',
    vip_address: '10.10.10.200', vip_subnet_id: subnets[0].id, vip_port_id: vipPort.id,
    provisioning_status: 'ACTIVE', operating_status: 'ONLINE', created_at: '2026-06-20T04:00:00Z',
    listeners: [],
  };
  const lis = { id: uid(), name: 'lb-web-listener', protocol: 'HTTP', protocol_port: 80, default_pool_id: pool.id, loadbalancer_id: lb.id, provisioning_status: 'ACTIVE', operating_status: 'ONLINE' };
  lbListeners.push(lis);
  lb.listeners = [{ id: lis.id }];
  pool.loadbalancers = [{ id: lb.id }];
  loadbalancers.push(lb);
}
seedLb();

let lbVipCounter = 201;

function mockLb(m, path, q, body) {
  let mt;
  if (m === 'GET' && path === '/v2/lbaas/loadbalancers') return { loadbalancers };
  if ((mt = path.match(/^\/v2\/lbaas\/loadbalancers\/([^/]+)$/)) && m === 'GET') {
    const lb = loadbalancers.find((x) => x.id === mt[1]);
    if (!lb) throw notFound();
    return { loadbalancer: lb };
  }
  if (m === 'POST' && path === '/v2/lbaas/loadbalancers') {
    const spec = body.loadbalancer;
    const vip = `10.10.10.${lbVipCounter++}`;
    const vipPort = { id: uid(), network_id: netInternal.id, device_id: 'lb-' + vip, device_owner: 'octavia', fixed_ips: [{ ip_address: vip, subnet_id: spec.vip_subnet_id }], status: 'ACTIVE' };
    ports.push(vipPort);
    const lb = {
      id: uid(), name: spec.name, description: spec.description || '', provider: 'amphora',
      vip_address: vip, vip_subnet_id: spec.vip_subnet_id, vip_port_id: vipPort.id,
      provisioning_status: 'PENDING_CREATE', operating_status: 'OFFLINE', created_at: now(), listeners: [],
    };
    for (const ls of spec.listeners || []) {
      const poolSpec = ls.default_pool || { protocol: ls.protocol, lb_algorithm: 'ROUND_ROBIN', members: [] };
      const pool = {
        id: uid(), name: poolSpec.name || `${spec.name}-pool`, protocol: poolSpec.protocol,
        lb_algorithm: poolSpec.lb_algorithm, provisioning_status: 'PENDING_CREATE', operating_status: 'OFFLINE',
        members: (poolSpec.members || []).map((mb) => ({ id: uid(), name: mb.name, address: mb.address, protocol_port: mb.protocol_port, subnet_id: mb.subnet_id, operating_status: 'NO_MONITOR', provisioning_status: 'ACTIVE' })),
        healthmonitor: null, loadbalancers: [{ id: lb.id }],
      };
      if (poolSpec.healthmonitor) {
        pool.healthmonitor = { id: uid(), operating_status: 'ONLINE', ...poolSpec.healthmonitor };
        pool.healthmonitor_id = pool.healthmonitor.id;
        pool.members.forEach((x) => (x.operating_status = 'ONLINE'));
      }
      lbPools.push(pool);
      const lis = { id: uid(), name: ls.name || `${spec.name}-listener`, protocol: ls.protocol, protocol_port: ls.protocol_port, default_pool_id: pool.id, loadbalancer_id: lb.id, provisioning_status: 'PENDING_CREATE', operating_status: 'OFFLINE' };
      lbListeners.push(lis);
      lb.listeners.push({ id: lis.id });
    }
    loadbalancers.push(lb);
    setTimeout(() => {
      lb.provisioning_status = 'ACTIVE'; lb.operating_status = 'ONLINE';
      lb.listeners.forEach((r) => { const l = lbListeners.find((x) => x.id === r.id); if (l) { l.provisioning_status = 'ACTIVE'; l.operating_status = 'ONLINE'; const p = lbPools.find((x) => x.id === l.default_pool_id); if (p) { p.provisioning_status = 'ACTIVE'; p.operating_status = 'ONLINE'; } } });
    }, 6000);
    return { loadbalancer: lb };
  }
  if ((mt = path.match(/^\/v2\/lbaas\/loadbalancers\/([^/]+)$/)) && m === 'DELETE') {
    const lb = loadbalancers.find((x) => x.id === mt[1]);
    if (!lb) throw notFound();
    lb.provisioning_status = 'PENDING_DELETE';
    setTimeout(() => {
      const idx = loadbalancers.indexOf(lb);
      if (idx >= 0) loadbalancers.splice(idx, 1);
      for (const r of lb.listeners) {
        const li = lbListeners.findIndex((x) => x.id === r.id);
        if (li >= 0) { const pi = lbPools.findIndex((x) => x.id === lbListeners[li].default_pool_id); if (pi >= 0) lbPools.splice(pi, 1); lbListeners.splice(li, 1); }
      }
      const pi = ports.findIndex((x) => x.id === lb.vip_port_id);
      if (pi >= 0) ports.splice(pi, 1);
    }, 3000);
    return null;
  }
  if (m === 'GET' && path === '/v2/lbaas/listeners') {
    const lbid = q.get('load_balancer_id');
    return { listeners: lbListeners.filter((x) => !lbid || x.loadbalancer_id === lbid) };
  }
  if (m === 'GET' && path === '/v2/lbaas/pools') {
    const lbid = q.get('loadbalancer_id');
    return { pools: lbPools.filter((x) => !lbid || (x.loadbalancers || []).some((r) => r.id === lbid)).map(({ members, healthmonitor, ...p }) => p) };
  }
  if ((mt = path.match(/^\/v2\/lbaas\/pools\/([^/]+)\/members$/)) && m === 'GET') {
    const p = lbPools.find((x) => x.id === mt[1]);
    if (!p) throw notFound();
    return { members: p.members };
  }
  if ((mt = path.match(/^\/v2\/lbaas\/pools\/([^/]+)\/members$/)) && m === 'POST') {
    const p = lbPools.find((x) => x.id === mt[1]);
    if (!p) throw notFound();
    const mb = { id: uid(), operating_status: p.healthmonitor ? 'ONLINE' : 'NO_MONITOR', provisioning_status: 'ACTIVE', ...body.member };
    p.members.push(mb);
    return { member: mb };
  }
  if ((mt = path.match(/^\/v2\/lbaas\/pools\/([^/]+)\/members\/([^/]+)$/)) && m === 'DELETE') {
    const p = lbPools.find((x) => x.id === mt[1]);
    if (!p) throw notFound();
    const i = p.members.findIndex((x) => x.id === mt[2]);
    if (i < 0) throw notFound();
    p.members.splice(i, 1);
    return null;
  }
  if ((mt = path.match(/^\/v2\/lbaas\/healthmonitors\/([^/]+)$/)) && m === 'GET') {
    const p = lbPools.find((x) => x.healthmonitor?.id === mt[1]);
    if (!p) throw notFound();
    return { healthmonitor: p.healthmonitor };
  }
  throw notFound();
}

// ---------- Identity (Keystone) — cho Admin console ----------
const mockQuotas = {};
const mockUsers = [
  { id: 'u-admin', name: 'admin', enabled: true, email: 'admin@mbfs.vn' },
  { id: 'u-hieptd', name: 'hieptd', enabled: true, email: 'hieptd@mbfs.vn' },
  { id: 'u-portal-task', name: 'portal-task', enabled: true, email: null },
];
const mockRoles = [{ id: 'r-member', name: 'member' }, { id: 'r-admin', name: 'admin' }];
const mockProjectList = [
  { id: 'p-demo', name: 'demo-project', enabled: true, description: 'Project demo' },
  { id: 'p-devops', name: 'devops-team', enabled: true, description: 'Team DevOps MBFS' },
];

function mockIdentity(m, path, q, body) {
  let mt;
  if (m === 'GET' && path === '/v3/projects') return { projects: mockProjectList };
  if (m === 'POST' && path === '/v3/projects') {
    const p = { id: 'p-' + uid().slice(0, 8), name: body.project.name, enabled: true, description: body.project.description || '' };
    mockProjectList.push(p);
    return { project: p };
  }
  if (m === 'GET' && path === '/v3/users') return { users: mockUsers };
  if (m === 'POST' && path === '/v3/users') {
    const u = { id: 'u-' + uid().slice(0, 8), name: body.user.name, enabled: true, email: null };
    mockUsers.push(u);
    return { user: u };
  }
  if ((mt = path.match(/^\/v3\/users\/([^/]+)$/)) && m === 'PATCH') {
    const u = mockUsers.find((x) => x.id === mt[1]);
    if (!u) throw notFound();
    return { user: u };
  }
  if (m === 'GET' && path === '/v3/roles') {
    const name = q.get('name');
    return { roles: mockRoles.filter((r) => !name || r.name === name) };
  }
  if (path.match(/^\/v3\/projects\/[^/]+\/users\/[^/]+\/roles\/[^/]+$/) && m === 'PUT') return null;
  throw notFound();
}

// ---------- Diagnostics giả lập (cho monitor) ----------
const mockDiag = new Map();
function mockDiagnostics(serverId) {
  const s = servers.find((x) => x.id === serverId);
  if (!s) throw notFound();
  let st = mockDiag.get(serverId);
  const now = Date.now();
  if (!st) { st = { cpu_ns: 0, rx: 0, tx: 0, rd: 0, wr: 0, load: 0.05 + Math.random() * 0.5, t: now - 60000 }; mockDiag.set(serverId, st); }
  const dt = (now - st.t) / 1000; st.t = now;
  st.load = Math.min(0.98, Math.max(0.01, st.load + (Math.random() - 0.5) * 0.2));
  const ncpu = s.flavor.vcpus || 1;
  st.cpu_ns += st.load * dt * 1e9 * ncpu;
  st.rx += Math.round(dt * (50 + Math.random() * 900) * 1024);
  st.tx += Math.round(dt * (30 + Math.random() * 500) * 1024);
  st.rd += Math.round(dt * Math.random() * 3e6);
  st.wr += Math.round(dt * Math.random() * 5e6);
  return {
    state: 'running', driver: 'libvirt', num_cpus: ncpu,
    cpu_details: [{ id: 0, time: Math.round(st.cpu_ns) }],
    memory_details: { maximum: s.flavor.ram, used: Math.round(s.flavor.ram * (0.35 + st.load * 0.5)) },
    nic_details: [{ mac_address: 'fa:16:3e:00:00:01', rx_octets: st.rx, tx_octets: st.tx }],
    disk_details: [{ read_bytes: st.rd, write_bytes: st.wr }],
  };
}

// ---------- Object Storage giả lập ----------
const mockContainers = new Map([
  ['backups', new Map([['db/dump-2026-08-01.sql.gz', { bytes: 48210332, content_type: 'application/gzip', last_modified: '2026-08-01T02:00:11', body: 'mock' }]])],
  ['static-web', new Map([['index.html', { bytes: 1240, content_type: 'text/html', last_modified: '2026-07-20T09:12:00', body: '<h1>MBFS</h1>' }]])],
]);

export function mockObject(method, path, headers = {}, body, raw) {
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts.length === 0) { // account
    if (method === 'GET') {
      return [...mockContainers.entries()].map(([name, objs]) => ({
        name, count: objs.size, bytes: [...objs.values()].reduce((a, o) => a + o.bytes, 0),
      }));
    }
    if (method === 'HEAD' || method === 'POST') return { headers: { get: () => null } };
  }
  const [cname, ...rest] = parts;
  const key = rest.join('/');
  if (!key) { // container
    if (method === 'PUT') { if (!mockContainers.has(cname)) mockContainers.set(cname, new Map()); return {}; }
    if (method === 'DELETE') {
      const c = mockContainers.get(cname);
      if (!c) throw notFound();
      if (c.size) { const e = new Error('Container còn dữ liệu — xoá hết object trước'); e.status = 409; throw e; }
      mockContainers.delete(cname); return {};
    }
    if (method === 'GET') {
      const c = mockContainers.get(cname);
      if (!c) throw notFound();
      const prefix = q.get('prefix') || '';
      return [...c.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([name, o]) => ({ name, bytes: o.bytes, content_type: o.content_type, last_modified: o.last_modified }));
    }
  }
  const c = mockContainers.get(cname);
  if (!c) throw notFound();
  if (method === 'PUT') { c.set(key, { bytes: 1024, content_type: headers['Content-Type'] || 'application/octet-stream', last_modified: now(), body: 'uploaded' }); return {}; }
  if (method === 'DELETE') { if (!c.delete(key)) throw notFound(); return {}; }
  if (method === 'GET') { const o = c.get(key); if (!o) throw notFound(); return { body: o.body || '' }; }
  throw notFound();
}
