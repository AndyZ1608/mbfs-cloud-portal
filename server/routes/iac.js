// iac.js — Xuất hạ tầng hiện có thành file Terraform (provider openstack)
import { Router } from 'express';
import { osFetch } from '../openstack.js';

const router = Router();
const tfName = (s, fb) => (String(s || fb).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || fb);
const q = (s) => `"${String(s ?? '').replace(/"/g, '\\"')}"`;

router.get('/export/terraform', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const [srvR, netR, subR, rtrR, sgR, kpR, volR, fipR] = await Promise.allSettled([
      osFetch(sess, 'compute', '/servers/detail?limit=1000'),
      osFetch(sess, 'network', '/v2.0/networks'),
      osFetch(sess, 'network', '/v2.0/subnets'),
      osFetch(sess, 'network', '/v2.0/routers'),
      osFetch(sess, 'network', '/v2.0/security-groups'),
      osFetch(sess, 'compute', '/os-keypairs'),
      osFetch(sess, 'volume', '/volumes/detail?limit=1000'),
      osFetch(sess, 'network', '/v2.0/floatingips'),
    ]);
    const val = (r, k) => (r.status === 'fulfilled' ? r.value?.[k] || [] : []);
    const servers = val(srvR, 'servers');
    const nets = val(netR, 'networks').filter((n) => !n['router:external']);
    const subs = val(subR, 'subnets');
    const routers = val(rtrR, 'routers');
    const sgs = val(sgR, 'security_groups');
    const keys = val(kpR, 'keypairs').map((k) => k.keypair || k);
    const vols = val(volR, 'volumes');
    const fips = val(fipR, 'floatingips');

    const L = [];
    L.push(`# Terraform xuất từ MBFS Cloud Portal`);
    L.push(`# Project: ${sess.project.name} · ${new Date().toISOString()}`);
    L.push(`# LƯU Ý: đây là ảnh chụp hiện trạng để tham khảo/tái tạo môi trường tương tự.`);
    L.push(`#   Muốn quản lý hạ tầng ĐANG CHẠY bằng Terraform thì phải "terraform import" từng resource.`);
    L.push('');
    L.push('terraform {\n  required_providers {\n    openstack = {\n      source  = "terraform-provider-openstack/openstack"\n      version = "~> 2.1"\n    }\n  }\n}');
    L.push('');
    L.push('# Cấu hình provider: dùng biến môi trường OS_* hoặc clouds.yaml');
    L.push('provider "openstack" {}');
    L.push('');

    const netRef = {};
    for (const n of nets) {
      const id = tfName(n.name, 'net');
      netRef[n.id] = id;
      L.push(`resource "openstack_networking_network_v2" ${q(id)} {\n  name           = ${q(n.name)}\n  admin_state_up = ${n.admin_state_up !== false}\n}`);
      for (const s of subs.filter((x) => x.network_id === n.id)) {
        L.push(`\nresource "openstack_networking_subnet_v2" ${q(tfName(s.name, id + '_subnet'))} {\n  name        = ${q(s.name)}\n  network_id  = openstack_networking_network_v2.${id}.id\n  cidr        = ${q(s.cidr)}\n  ip_version  = 4\n  enable_dhcp = ${!!s.enable_dhcp}${s.gateway_ip ? `\n  gateway_ip  = ${q(s.gateway_ip)}` : ''}${(s.dns_nameservers || []).length ? `\n  dns_nameservers = [${s.dns_nameservers.map(q).join(', ')}]` : ''}\n}`);
      }
      L.push('');
    }
    for (const r of routers) {
      L.push(`resource "openstack_networking_router_v2" ${q(tfName(r.name, 'router'))} {\n  name                = ${q(r.name)}\n  admin_state_up      = true${r.external_gateway_info?.network_id ? `\n  external_network_id = ${q(r.external_gateway_info.network_id)}` : ''}\n}`);
      L.push('');
    }
    for (const g of sgs) {
      const id = tfName(g.name, 'sg');
      L.push(`resource "openstack_networking_secgroup_v2" ${q(id)} {\n  name        = ${q(g.name)}\n  description = ${q(g.description || '')}\n}`);
      let i = 0;
      for (const r of (g.security_group_rules || []).filter((x) => x.direction === 'ingress' && x.remote_ip_prefix)) {
        L.push(`\nresource "openstack_networking_secgroup_rule_v2" ${q(`${id}_rule_${++i}`)} {\n  direction         = "ingress"\n  ethertype         = "IPv4"${r.protocol ? `\n  protocol          = ${q(r.protocol)}` : ''}${r.port_range_min != null ? `\n  port_range_min    = ${r.port_range_min}\n  port_range_max    = ${r.port_range_max}` : ''}\n  remote_ip_prefix  = ${q(r.remote_ip_prefix)}\n  security_group_id = openstack_networking_secgroup_v2.${id}.id\n}`);
      }
      L.push('');
    }
    for (const k of keys) {
      L.push(`resource "openstack_compute_keypair_v2" ${q(tfName(k.name, 'key'))} {\n  name       = ${q(k.name)}\n  public_key = ${q(k.public_key || '<<DÁN PUBLIC KEY VÀO ĐÂY>>')}\n}`);
      L.push('');
    }
    for (const v of vols.filter((x) => !x.bootable || x.status === 'available')) {
      L.push(`resource "openstack_blockstorage_volume_v3" ${q(tfName(v.name, 'vol_' + v.id.slice(0, 6)))} {\n  name = ${q(v.name || v.id.slice(0, 8))}\n  size = ${v.size}${v.volume_type ? `\n  volume_type = ${q(v.volume_type)}` : ''}\n}`);
      L.push('');
    }
    for (const s of servers) {
      const id = tfName(s.name, 'vm');
      const nics = Object.keys(s.addresses || {}).map((netName) => {
        const n = nets.find((x) => x.name === netName);
        return n ? `  network {\n    uuid = openstack_networking_network_v2.${netRef[n.id]}.id\n  }` : `  network {\n    name = ${q(netName)}\n  }`;
      }).join('\n');
      L.push(`resource "openstack_compute_instance_v2" ${q(id)} {\n  name        = ${q(s.name)}\n  flavor_name = ${q(s.flavor?.original_name || s.flavor?.id || 'CHỈNH_TÊN_FLAVOR')}${s.image?.id ? `\n  image_id    = ${q(s.image.id)}` : '\n  # máy boot-from-volume: khai block_device thay cho image_id'}${s.key_name ? `\n  key_pair    = ${q(s.key_name)}` : ''}\n  security_groups = [${(s.security_groups || []).map((g) => q(g.name)).join(', ') || '"default"'}]\n${nics}\n}`);
      L.push('');
    }
    for (const f of fips) {
      L.push(`resource "openstack_networking_floatingip_v2" ${q(tfName('fip_' + f.floating_ip_address.replace(/\./g, '_')))} {\n  pool = ${q('CHỈNH_TÊN_MẠNG_EXTERNAL')}  # ${f.floating_ip_address}\n}`);
      L.push('');
    }

    const tf = L.join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${sess.project.name}-infra.tf"`);
    console.log(`[iac] EXPORT terraform project=${sess.project.name} by=${sess.user.name} (${servers.length} VM, ${nets.length} net)`);
    res.send(tf);
  } catch (e) { next(e); }
});

export default router;
