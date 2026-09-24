// marketplace.js — App Marketplace: triển khai ứng dụng 1-click
// Deploy = (tuỳ chọn) tạo security group mở cổng app → tạo VM kèm cloud-init
//          → (tuỳ chọn) chờ port xuất hiện rồi cấp Floating IP gắn thẳng vào port.
import { Router } from 'express';
import { osFetch, OSError } from '../openstack.js';
import { publicTemplates, findTemplate, collectParams } from '../templates.js';
import { fetchUsableImage, fetchUsableNetwork, owned } from '../projectScope.js';

const router = Router();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

router.get('/marketplace/templates', (req, res) => {
  res.json({ templates: publicTemplates() });
});

router.post('/marketplace/deploy', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const {
      template_id, params = {}, name, flavorRef, imageRef, network_id, key_name,
      create_sg = true, sg_cidr = '0.0.0.0/0', assign_fip = false, boot_volume_gb,
    } = req.body || {};

    const tpl = findTemplate(template_id);
    if (!tpl) throw new OSError(400, 'Template không tồn tại');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,50}$/.test(name || '')) throw new OSError(400, 'Tên máy không hợp lệ');
    if (!flavorRef || !imageRef || !network_id) throw new OSError(400, 'Thiếu flavor / image / network');
    if (create_sg && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(sg_cidr)) throw new OSError(400, 'CIDR không hợp lệ');
    await fetchUsableNetwork(sess, network_id);
    await fetchUsableImage(sess, imageRef);

    const values = collectParams(tpl, params);
    const userData = tpl.userData(values);
    const warnings = [];
    const warningCodes = [];

    // 1) Security group mở cổng ứng dụng
    const sgNames = ['default'];
    let sgCreated = null;
    if (create_sg && tpl.ports.length) {
      const sgName = `${name}-app`;
      const g = await osFetch(sess, 'network', '/v2.0/security-groups', {
        method: 'POST',
        body: { security_group: { name: sgName, project_id: sess.project.id, description: `MBFS marketplace: ${tpl.name}` } },
      });
      for (const port of tpl.ports) {
        await osFetch(sess, 'network', '/v2.0/security-group-rules', {
          method: 'POST',
          body: { security_group_rule: {
            security_group_id: g.security_group.id, project_id: sess.project.id, direction: 'ingress', ethertype: 'IPv4',
            protocol: 'tcp', port_range_min: port, port_range_max: port, remote_ip_prefix: sg_cidr,
          } },
        });
      }
      sgNames.push(sgName);
      sgCreated = sgName;
    }

    // 2) Tạo VM với cloud-init
    const server = {
      name, flavorRef,
      networks: [{ uuid: network_id }],
      security_groups: sgNames.map((n) => ({ name: n })),
      user_data: Buffer.from(userData).toString('base64'),
    };
    if (key_name) server.key_name = key_name;
    if (boot_volume_gb && Number(boot_volume_gb) > 0) {
      server.block_device_mapping_v2 = [{
        boot_index: 0, uuid: imageRef, source_type: 'image',
        destination_type: 'volume', volume_size: Number(boot_volume_gb), delete_on_termination: true,
      }];
    } else {
      server.imageRef = imageRef;
    }
    const created = await osFetch(sess, 'compute', '/servers', { method: 'POST', body: { server } });
    const serverId = created.server.id;

    // 3) Floating IP (tạo kèm port_id — một lệnh Neutron)
    let fipIp = null;
    if (assign_fip) {
      let port = null;
      for (let i = 0; i < 10 && !port; i++) {
        await sleep(3000);
        const pr = await osFetch(sess, 'network', `/v2.0/ports?device_id=${serverId}`).catch(() => null);
        port = owned(pr?.ports, sess)[0] || null;
      }
      if (!port) {
        warnings.push('Máy chưa có port mạng sau 30s — gắn Floating IP thủ công ở trang Máy ảo sau.');
        warningCodes.push('portUnavailable');
      } else {
        const ext = (await osFetch(sess, 'network', '/v2.0/networks?router:external=true')).networks?.find((network) => network['router:external'] === true);
        if (!ext) {
          warnings.push('Không có mạng external nào để cấp Floating IP.');
          warningCodes.push('externalNetworkUnavailable');
        }
        else {
          const fr = await osFetch(sess, 'network', '/v2.0/floatingips', {
            method: 'POST',
            body: { floatingip: { floating_network_id: ext.id, port_id: port.id } },
          });
          fipIp = fr.floatingip.floating_ip_address;
        }
      }
    }

    // 4) Access note: thay {param} và {ip}
    let access = tpl.access || '';
    for (const [k, v] of Object.entries(values)) {
      if (!/pass|token/i.test(k)) access = access.replaceAll(`{${k}}`, v);
    }
    access = access.replaceAll('{ip}', fipIp || '<IP máy ảo>');
    // param nhạy cảm còn sót placeholder → thay bằng nhãn chung
    access = access.replace(/\{[a-z_]+\}/g, '(đã đặt)');

    console.log(`[marketplace] DEPLOY ${tpl.id} -> ${name} fip=${fipIp || '-'} by=${sess.user.name}`);
    res.json({
      server: { id: serverId, name },
      fip: fipIp,
      security_group: sgCreated,
      access,
      warnings,
      warningCodes,
      note: 'cloud-init cần 2–5 phút cài đặt sau khi máy ACTIVE. Theo dõi bằng "Xem log console" ở trang Máy ảo.',
    });
  } catch (e) { next(e); }
});

export default router;
