// k8s.js — Kubernetes Cluster (RKE2) 1-click, không cần Magnum.
// Portal sinh token → tạo SG (mở toàn bộ nội bộ cluster qua remote_group_id,
// mở 6443/9345/22 từ CIDR quản trị) → tạo server node → lấy IP → tạo N worker
// join qua IP đó → (tuỳ chọn) gắn FIP vào server. Cụm lưu ở DATA_DIR/clusters.json.
import { Router } from 'express';
import crypto from 'node:crypto';
import { osFetch, OSError } from '../openstack.js';
import { loadJson, saveJson } from '../store.js';
import { seal, unseal, encryptionConfigured } from '../secrets.js';

const router = Router();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let clusters = loadJson('clusters.json', []);
const save = () => saveJson('clusters.json', clusters);

// Transparently migrate legacy plaintext join tokens when an encryption key exists.
if (encryptionConfigured()) {
  let migrated = false;
  clusters = clusters.map((cluster) => {
    if (!cluster.token || cluster.token_enc) return cluster;
    migrated = true;
    const { token, ...rest } = cluster;
    return { ...rest, token_enc: seal(token) };
  });
  if (migrated) save();
}

const serverUD = (token) => `#cloud-config
package_update: true
packages: [curl]
write_files:
  - path: /etc/rancher/rke2/config.yaml
    permissions: '0600'
    content: |
      token: ${token}
runcmd:
  - [ sh, -c, 'curl -sfL https://get.rke2.io | INSTALL_RKE2_CHANNEL=stable sh -' ]
  - systemctl enable --now rke2-server
  - [ sh, -c, 'ln -sf /var/lib/rancher/rke2/bin/kubectl /usr/local/bin/kubectl || true' ]
`;

const agentUD = (token, serverIp) => `#cloud-config
package_update: true
packages: [curl]
write_files:
  - path: /etc/rancher/rke2/config.yaml
    permissions: '0600'
    content: |
      server: https://${serverIp}:9345
      token: ${token}
runcmd:
  - [ sh, -c, 'curl -sfL https://get.rke2.io | INSTALL_RKE2_CHANNEL=stable INSTALL_RKE2_TYPE=agent sh -' ]
  - systemctl enable --now rke2-agent
`;

async function createVm(sess, { name, flavorRef, imageRef, network_id, key_name, sgName, userData }) {
  const server = {
    name, flavorRef, imageRef,
    networks: [{ uuid: network_id }],
    security_groups: [{ name: 'default' }, { name: sgName }],
    key_name,
    user_data: Buffer.from(userData).toString('base64'),
  };
  const d = await osFetch(sess, 'compute', '/servers', { method: 'POST', body: { server } });
  return d.server.id;
}

router.get('/k8s/clusters', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const mine = clusters.filter((c) => c.project_id === sess.project.id);
    // enrich trạng thái node từ Nova
    let servers = [];
    try { servers = (await osFetch(sess, 'compute', '/servers/detail?limit=1000')).servers || []; } catch { /* tạm thời */ }
    const byId = Object.fromEntries(servers.map((s) => [s.id, s]));
    const out = mine.map((c) => {
      const nodes = [c.server_id, ...c.worker_ids].map((id, i) => {
        const s = byId[id];
        return { id, role: i === 0 ? 'server' : 'worker', name: s?.name || '(đã xoá)', status: s?.status || 'DELETED' };
      });
      const { token: _token, token_enc: _tokenEnc, ...publicCluster } = c;
      return { ...publicCluster, nodes, ready: nodes.filter((n) => n.status === 'ACTIVE').length };
    });
    res.json({ clusters: out });
  } catch (e) { next(e); }
});

// Token chỉ trả khi được hỏi rõ (thêm node thủ công sau này)
router.get('/k8s/clusters/:id/token', (req, res, next) => {
  try {
    const c = clusters.find((x) => x.id === req.params.id && x.project_id === req.session.os.project.id);
    if (!c) throw new OSError(404, 'Không tìm thấy cluster');
    const token = c.token_enc ? unseal(c.token_enc) : c.token;
    if (!token) throw new OSError(503, 'Không thể giải mã token cluster; kiểm tra DATA_ENCRYPTION_KEY', 'secret_unavailable');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token, server_ip: c.server_ip });
  } catch (e) { next(e); }
});

router.post('/k8s/deploy', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { name, workers = 2, flavorRef, imageRef, network_id, key_name, admin_cidr = '0.0.0.0/0', assign_fip = true } = req.body || {};
    if (!/^[a-z0-9][a-z0-9-]{1,24}$/.test(name || '')) throw new OSError(400, 'Tên cluster: chữ thường, số, gạch ngang (2–25 ký tự)');
    if (clusters.some((c) => c.project_id === sess.project.id && c.name === name)) throw new OSError(400, 'Tên cluster đã tồn tại trong project');
    const nW = Math.min(9, Math.max(0, Number(workers) || 0));
    if (!flavorRef || !imageRef || !network_id) throw new OSError(400, 'Thiếu flavor / image / network');
    if (!key_name) throw new OSError(400, 'Bắt buộc chọn SSH key (để lấy kubeconfig từ server node)');
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(admin_cidr)) throw new OSError(400, 'CIDR quản trị không hợp lệ');

    const token = 'mbfs-' + crypto.randomBytes(24).toString('hex');
    const warnings = [];

    // 1) Security group cụm
    const sgName = `${name}-k8s`;
    const g = await osFetch(sess, 'network', '/v2.0/security-groups', {
      method: 'POST',
      body: { security_group: { name: sgName, description: `MBFS K8s cluster ${name}` } },
    });
    const sgId = g.security_group.id;
    const mkRule = (rule) => osFetch(sess, 'network', '/v2.0/security-group-rules', {
      method: 'POST', body: { security_group_rule: { security_group_id: sgId, direction: 'ingress', ethertype: 'IPv4', ...rule } },
    });
    await mkRule({ remote_group_id: sgId }); // mọi giao thức giữa các node trong cụm
    for (const port of [6443, 9345, 22]) {
      await mkRule({ protocol: 'tcp', port_range_min: port, port_range_max: port, remote_ip_prefix: admin_cidr });
    }

    // 2) Server node
    const serverId = await createVm(sess, {
      name: `${name}-server`, flavorRef, imageRef, network_id, key_name, sgName, userData: serverUD(token),
    });

    // 3) Chờ IP của server node (worker cần để join)
    let serverIp = null; let portId = null;
    for (let i = 0; i < 15 && !serverIp; i++) {
      await sleep(3000);
      const pr = await osFetch(sess, 'network', `/v2.0/ports?device_id=${serverId}`).catch(() => null);
      const port = pr?.ports?.[0];
      if (port?.fixed_ips?.[0]?.ip_address) { serverIp = port.fixed_ips[0].ip_address; portId = port.id; }
    }
    if (!serverIp) throw new OSError(502, 'Server node chưa có IP sau 45s — kiểm tra Nova/Neutron rồi thử lại (đã tạo VM ' + `${name}-server, cần xoá tay)`);

    // 4) Worker nodes
    const workerIds = [];
    for (let i = 1; i <= nW; i++) {
      workerIds.push(await createVm(sess, {
        name: `${name}-worker-${i}`, flavorRef, imageRef, network_id, key_name, sgName, userData: agentUD(token, serverIp),
      }));
    }

    // 5) FIP cho server node
    let fip = null;
    if (assign_fip) {
      const ext = (await osFetch(sess, 'network', '/v2.0/networks?router:external=true')).networks?.[0];
      if (!ext) warnings.push('Không có mạng external — bỏ qua Floating IP.');
      else {
        const fr = await osFetch(sess, 'network', '/v2.0/floatingips', {
          method: 'POST', body: { floatingip: { floating_network_id: ext.id, port_id: portId } },
        });
        fip = fr.floatingip.floating_ip_address;
      }
    }

    const cluster = {
      id: crypto.randomUUID(), name,
      project_id: sess.project.id, project_name: sess.project.name,
      server_id: serverId, server_ip: serverIp, fip,
      worker_ids: workerIds, sg_id: sgId, sg_name: sgName,
      ...(encryptionConfigured() ? { token_enc: seal(token) } : { token }),
      key_name, created_by: sess.user.name, created_at: new Date().toISOString(),
    };
    clusters.push(cluster);
    save();
    console.log(`[k8s] DEPLOY cluster=${name} nodes=${1 + nW} by=${sess.user.name}`);
    res.json({
      cluster: { ...cluster, token: undefined, token_enc: undefined },
      warnings,
      kubeconfig_hint: `ssh ubuntu@${fip || serverIp} "sudo cat /etc/rancher/rke2/rke2.yaml" > ${name}.yaml  # rồi sửa 127.0.0.1 → ${fip || serverIp}`,
      note: 'RKE2 cài 5–10 phút/node sau khi VM ACTIVE (tải từ get.rke2.io). Theo dõi: ssh vào node, journalctl -u rke2-server -f.',
    });
  } catch (e) { next(e); }
});

router.delete('/k8s/clusters/:id', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const idx = clusters.findIndex((c) => c.id === req.params.id && c.project_id === sess.project.id);
    if (idx < 0) throw new OSError(404, 'Không tìm thấy cluster');
    const c = clusters[idx];
    const warnings = [];
    for (const id of [...c.worker_ids, c.server_id]) {
      try { await osFetch(sess, 'compute', `/servers/${id}`, { method: 'DELETE' }); }
      catch (e) { if (e.status !== 404) warnings.push(`Không xoá được VM ${id.slice(0, 8)}: ${e.message}`); }
    }
    // SG xoá sau khi VM giải phóng port — thử vài lần
    let sgGone = false;
    for (let i = 0; i < 6 && !sgGone; i++) {
      await sleep(3000);
      try { await osFetch(sess, 'network', `/v2.0/security-groups/${c.sg_id}`, { method: 'DELETE' }); sgGone = true; }
      catch (e) { if (e.status === 404) sgGone = true; }
    }
    if (!sgGone) warnings.push(`Security group ${c.sg_name} còn kẹt port — xoá tay sau ở trang Security Group.`);
    clusters.splice(idx, 1);
    save();
    console.log(`[k8s] DELETE cluster=${c.name} by=${sess.user.name}`);
    res.json({ ok: true, warnings });
  } catch (e) { next(e); }
});

export default router;
