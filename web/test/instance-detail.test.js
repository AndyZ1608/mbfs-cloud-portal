import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { networkRows, attachedStorage, attachedSecurityGroups, canDetachVolume } from '../src/instanceDetailData.js';
import { translate } from '../src/i18n/index.js';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('VM name links to the UUID detail route, which also loads directly from the route parameter', () => {
  assert.match(source('../src/App.jsx'), /path="\/instances\/:instanceId" element={<Suspense/);
  assert.match(source('../src/App.jsx'), /<InstanceDetailRoute \/>/);
  assert.match(source('../src/pages/Instances.jsx'), /<Link className="link-btn" to={`\/instances\/\$\{encodeURIComponent\(s.id\)\}`}>/);
  assert.match(source('../src/pages/InstanceDetail.jsx'), /const \{ instanceId \} = useParams\(\)/);
  assert.match(source('../src/pages/InstanceDetail.jsx'), /api\(`\/servers\/\$\{encodedId\}`\)/);
  assert.match(source('../src/pages/InstanceDetail.jsx'), /useInstanceActions\(/);
  assert.match(source('../src/pages/Instances.jsx'), /useInstanceActions\(/);
});

test('network tab resolves multiple ports, fixed IPs, FIP, and SG via scoped lookup data', () => {
  const ports = [
    { id: 'port-1', network_id: 'net-1', fixed_ips: [{ subnet_id: 'sub-1', ip_address: '10.0.0.2' }, { subnet_id: 'sub-1', ip_address: '10.0.0.3' }], security_groups: ['sg-1'], mac_address: 'fa:16:3e:00:00:01' },
    { id: 'port-2', network_id: 'net-1', fixed_ips: [{ subnet_id: 'sub-1', ip_address: '10.0.0.4' }], security_groups: [] },
  ];
  const rows = networkRows(ports, [{ id: 'net-1', name: 'APP-NET', subnet_details: [{ id: 'sub-1', cidr: '10.0.0.0/24' }] }],
    [{ port_id: 'port-1', floating_ip_address: '100.64.64.190' }], [{ id: 'sg-1', name: 'default' }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].fixed.map((item) => item.address), ['10.0.0.2', '10.0.0.3']);
  assert.equal(rows[0].fixed[0].subnet, '10.0.0.0/24');
  assert.deepEqual(rows[0].floating, ['100.64.64.190']);
  assert.deepEqual(rows[0].groups.map((item) => item.name), ['default']);
  assert.equal(rows[1].networkName, 'APP-NET');
  assert.deepEqual(rows[1].floating, []);
});

test('storage and security tabs show only attached/known project resources', () => {
  const attached = attachedStorage([{ volumeId: 'vol-1', device: '/dev/vdb' }, { volumeId: 'foreign' }],
    [{ id: 'vol-1', name: 'data', size: 100, status: 'in-use' }],
    [{ id: 'snap-1', volume_id: 'vol-1' }, { id: 'snap-foreign', volume_id: 'foreign' }]);
  assert.deepEqual(attached.attached.map((volume) => volume.name), ['data']);
  assert.equal(attached.attached[0].device, '/dev/vdb');
  assert.deepEqual(attached.snapshots.map((snapshot) => snapshot.id), ['snap-1']);
  const multiAttached = attachedStorage([{ volumeId: 'vol-2' }], [{ id: 'vol-2', attachments: [
    { server_id: 'other', device: '/dev/vdc' }, { server_id: 'vm-1', device: '/dev/vdb' },
  ] }], [], 'vm-1');
  assert.equal(multiAttached.attached[0].device, '/dev/vdb');
  const security = attachedSecurityGroups([{ security_groups: ['sg-1', 'foreign'] }],
    [{ id: 'sg-1', name: 'default', security_group_rules: [{ id: 'rule-1' }] }]);
  assert.deepEqual(security.map((group) => group.name), ['default']);
  assert.equal(canDetachVolume({ image: {} }, { bootable: 'true' }), false);
  assert.equal(canDetachVolume({ image: {} }, { bootable: 'false' }), true);
  assert.equal(canDetachVolume({ image: { id: 'image-1' } }, { bootable: 'true' }), true);
});

test('all five detail tabs and critical empty/error labels translate in Vietnamese and English', () => {
  for (const locale of ['vi', 'en']) {
    for (const key of ['overview', 'networking', 'storage', 'security', 'activity', 'noActivity', 'networkError', 'storageError']) {
      assert.notEqual(translate(locale, `instance.detail.${key}`), `instance.detail.${key}`);
    }
  }
  assert.equal(translate('en', 'instance.detail.instanceId'), 'Instance ID');
  assert.equal(translate('vi', 'instance.detail.noActivity'), 'Chưa ghi nhận hoạt động cho máy ảo này.');
});
