// templates.js — Catalog ứng dụng 1-click (App Marketplace)
// Mỗi template = cloud-config cài Docker + docker-compose.yml, chạy khi VM boot lần đầu.
// Params được validate bằng pattern TRƯỚC khi render → an toàn khi nội suy vào YAML.

const indent = (s, n) => s.trim().split('\n').map((l) => ' '.repeat(n) + l).join('\n');

// cloud-config chuẩn: cài docker, ghi compose file, up -d (restart:always → sống qua reboot)
function dockerApp(composeYaml, { preRun = [], postRun = [] } = {}) {
  return `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
write_files:
  - path: /opt/app/docker-compose.yml
    permissions: '0600'
    content: |
${indent(composeYaml, 6)}
runcmd:
  - systemctl enable --now docker
${preRun.map((c) => '  - ' + c).join('\n')}${preRun.length ? '\n' : ''}  - [ sh, -c, 'cd /opt/app && docker compose up -d' ]
${postRun.map((c) => '  - ' + c).join('\n')}
`;
}

// Pattern dùng chung
const PAT = {
  ident: '^[a-zA-Z_][a-zA-Z0-9_]{0,31}$',
  pass: '^[A-Za-z0-9@#%_.\\-]{8,64}$',
  url: '^https?://[a-zA-Z0-9._:/\\-]+$',
  token: '^[A-Za-z0-9_\\-]{8,128}$',
};

export const TEMPLATES = [
  {
    id: 'docker-host', name: 'Docker Host', emoji: '🐳', category: 'devops',
    tagline: 'Ubuntu + Docker Engine + Compose, sẵn sàng chạy container',
    ports: [], min: { vcpus: 1, ram: 2048, disk: 20 }, params: [],
    access: 'SSH vào máy bằng key đã chọn, user ubuntu đã trong group docker. Thử: docker run hello-world',
    userData: () => `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
runcmd:
  - systemctl enable --now docker
  - usermod -aG docker ubuntu || true
`,
  },
  {
    id: 'postgres', name: 'PostgreSQL 16', emoji: '🐘', category: 'database',
    tagline: 'CSDL quan hệ mạnh nhất giới mã nguồn mở',
    ports: [5432], min: { vcpus: 1, ram: 2048, disk: 20 },
    params: [
      { key: 'db_name', label: 'Tên database', default: 'appdb', pattern: PAT.ident },
      { key: 'db_user', label: 'User', default: 'appuser', pattern: PAT.ident },
      { key: 'db_pass', label: 'Mật khẩu', type: 'password', generate: true, pattern: PAT.pass },
    ],
    access: 'Kết nối: psql -h {ip} -p 5432 -U {db_user} -d {db_name} (mật khẩu đã đặt). Dữ liệu tại /opt/postgres/data.',
    userData: (p) => dockerApp(`
services:
  db:
    image: postgres:16
    restart: always
    environment:
      POSTGRES_DB: ${p.db_name}
      POSTGRES_USER: ${p.db_user}
      POSTGRES_PASSWORD: "${p.db_pass}"
    ports:
      - "5432:5432"
    volumes:
      - /opt/postgres/data:/var/lib/postgresql/data
`),
  },
  {
    id: 'mysql', name: 'MySQL 8', emoji: '🐬', category: 'database',
    tagline: 'CSDL quan hệ phổ biến cho web app',
    ports: [3306], min: { vcpus: 1, ram: 2048, disk: 20 },
    params: [
      { key: 'db_name', label: 'Tên database', default: 'appdb', pattern: PAT.ident },
      { key: 'db_user', label: 'User', default: 'appuser', pattern: PAT.ident },
      { key: 'db_pass', label: 'Mật khẩu user', type: 'password', generate: true, pattern: PAT.pass },
      { key: 'root_pass', label: 'Mật khẩu root', type: 'password', generate: true, pattern: PAT.pass },
    ],
    access: 'Kết nối: mysql -h {ip} -P 3306 -u {db_user} -p {db_name}. Dữ liệu tại /opt/mysql/data.',
    userData: (p) => dockerApp(`
services:
  db:
    image: mysql:8
    restart: always
    environment:
      MYSQL_DATABASE: ${p.db_name}
      MYSQL_USER: ${p.db_user}
      MYSQL_PASSWORD: "${p.db_pass}"
      MYSQL_ROOT_PASSWORD: "${p.root_pass}"
    ports:
      - "3306:3306"
    volumes:
      - /opt/mysql/data:/var/lib/mysql
`),
  },
  {
    id: 'redis', name: 'Redis 7', emoji: '⚡', category: 'database',
    tagline: 'Cache / message broker in-memory, bật AOF persistence',
    ports: [6379], min: { vcpus: 1, ram: 1024, disk: 10 },
    params: [{ key: 'redis_pass', label: 'Mật khẩu (requirepass)', type: 'password', generate: true, pattern: PAT.pass }],
    access: 'Kết nối: redis-cli -h {ip} -a <mật khẩu>. Dữ liệu AOF tại /opt/redis/data.',
    userData: (p) => dockerApp(`
services:
  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --requirepass "${p.redis_pass}" --appendonly yes
    ports:
      - "6379:6379"
    volumes:
      - /opt/redis/data:/data
`),
  },
  {
    id: 'n8n', name: 'n8n Automation', emoji: '🔁', category: 'devops',
    tagline: 'Nền tảng workflow automation — như bản MBFS đang dùng',
    ports: [5678], min: { vcpus: 2, ram: 4096, disk: 20 },
    params: [
      { key: 'admin_user', label: 'User đăng nhập', default: 'admin', pattern: PAT.ident },
      { key: 'admin_pass', label: 'Mật khẩu', type: 'password', generate: true, pattern: PAT.pass },
    ],
    access: 'Mở http://{ip}:5678 — đăng nhập basic auth bằng user {admin_user}. Workflow lưu tại /opt/n8n.',
    userData: (p) => dockerApp(`
services:
  n8n:
    image: n8nio/n8n:latest
    restart: always
    ports:
      - "5678:5678"
    environment:
      N8N_BASIC_AUTH_ACTIVE: "true"
      N8N_BASIC_AUTH_USER: ${p.admin_user}
      N8N_BASIC_AUTH_PASSWORD: "${p.admin_pass}"
      N8N_SECURE_COOKIE: "false"
      GENERIC_TIMEZONE: Asia/Ho_Chi_Minh
    volumes:
      - /opt/n8n:/home/node/.n8n
`, { preRun: ['mkdir -p /opt/n8n && chown 1000:1000 /opt/n8n'] }),
  },
  {
    id: 'gitlab-runner', name: 'GitLab Runner', emoji: '🦊', category: 'devops',
    tagline: 'CI runner với Docker executor, tự đăng ký vào GitLab',
    ports: [], min: { vcpus: 2, ram: 4096, disk: 40 },
    params: [
      { key: 'gitlab_url', label: 'GitLab URL', default: 'https://gitlab.com', pattern: PAT.url },
      { key: 'reg_token', label: 'Registration token', type: 'password', pattern: PAT.token },
    ],
    access: 'Runner tự đăng ký vào {gitlab_url} sau khi boot xong (2–5 phút). Kiểm tra ở GitLab → Settings → CI/CD → Runners.',
    userData: (p) => dockerApp(`
services:
  runner:
    image: gitlab/gitlab-runner:latest
    restart: always
    volumes:
      - /opt/gitlab-runner:/etc/gitlab-runner
      - /var/run/docker.sock:/var/run/docker.sock
`, { postRun: [
      'sleep 8',
      `[ sh, -c, 'docker exec runner gitlab-runner register --non-interactive --url "${p.gitlab_url}" --registration-token "${p.reg_token}" --executor docker --docker-image alpine:latest --description "$(hostname)" || true' ]`,
    ] }),
  },
  {
    id: 'nginx-web', name: 'Nginx Web Server', emoji: '🌐', category: 'web',
    tagline: 'Web server tĩnh, có sẵn trang landing để test',
    ports: [80], min: { vcpus: 1, ram: 1024, disk: 10 }, params: [],
    access: 'Mở http://{ip} — nội dung web tại /opt/web trên máy (sửa trực tiếp, không cần restart).',
    userData: () => `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
write_files:
  - path: /opt/web/index.html
    content: |
      <!doctype html><html lang="vi"><head><meta charset="utf-8"><title>MBFS Cloud</title>
      <style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#16202f;color:#fff}
      .c{text-align:center}.c h1{color:#7aa5f0}</style></head>
      <body><div class="c"><h1>☁️ MBFS Cloud</h1><p>Máy chủ web đã sẵn sàng — deploy từ App Marketplace.</p></div></body></html>
  - path: /opt/app/docker-compose.yml
    permissions: '0600'
    content: |
      services:
        web:
          image: nginx:alpine
          restart: always
          ports:
            - "80:80"
          volumes:
            - /opt/web:/usr/share/nginx/html:ro
runcmd:
  - systemctl enable --now docker
  - [ sh, -c, 'cd /opt/app && docker compose up -d' ]
`,
  },
  {
    id: 'uptime-kuma', name: 'Uptime Kuma', emoji: '📈', category: 'tool',
    tagline: 'Giám sát uptime website/service, cảnh báo Telegram',
    ports: [3001], min: { vcpus: 1, ram: 1024, disk: 10 }, params: [],
    access: 'Mở http://{ip}:3001 — lần đầu vào sẽ tạo tài khoản admin. Dữ liệu tại /opt/kuma.',
    userData: () => dockerApp(`
services:
  kuma:
    image: louislam/uptime-kuma:1
    restart: always
    ports:
      - "3001:3001"
    volumes:
      - /opt/kuma:/app/data
`),
  },
  {
    id: 'minio', name: 'MinIO (S3)', emoji: '🪣', category: 'tool',
    tagline: 'Object storage tương thích S3, chạy single-node',
    ports: [9000, 9001], min: { vcpus: 2, ram: 4096, disk: 40 },
    params: [
      { key: 'root_user', label: 'Root user', default: 'minioadmin', pattern: PAT.ident },
      { key: 'root_pass', label: 'Root password', type: 'password', generate: true, pattern: PAT.pass },
    ],
    access: 'Console: http://{ip}:9001 (user {root_user}) · S3 endpoint: http://{ip}:9000. Dữ liệu tại /opt/minio.',
    userData: (p) => dockerApp(`
services:
  minio:
    image: minio/minio:latest
    restart: always
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${p.root_user}
      MINIO_ROOT_PASSWORD: "${p.root_pass}"
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - /opt/minio:/data
`),
  },
  {
    id: 'wordpress', name: 'WordPress', emoji: '📝', category: 'web',
    tagline: 'CMS phổ biến nhất, kèm MySQL trong một máy',
    ports: [80], min: { vcpus: 2, ram: 4096, disk: 30 },
    params: [{ key: 'db_pass', label: 'Mật khẩu database', type: 'password', generate: true, pattern: PAT.pass }],
    access: 'Mở http://{ip} để chạy trình cài đặt WordPress. Dữ liệu tại /opt/wp.',
    userData: (p) => dockerApp(`
services:
  db:
    image: mysql:8
    restart: always
    environment:
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wp
      MYSQL_PASSWORD: "${p.db_pass}"
      MYSQL_ROOT_PASSWORD: "${p.db_pass}"
    volumes:
      - /opt/wp/db:/var/lib/mysql
  wordpress:
    image: wordpress:latest
    restart: always
    ports:
      - "80:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wp
      WORDPRESS_DB_PASSWORD: "${p.db_pass}"
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - /opt/wp/html:/var/www/html
`),
  },
];

export const CATEGORIES = [
  ['all', 'Tất cả'],
  ['database', 'Database'],
  ['devops', 'DevOps'],
  ['web', 'Web'],
  ['tool', 'Công cụ'],
];

// Metadata gửi cho frontend (bỏ hàm userData)
export const publicTemplates = () =>
  TEMPLATES.map(({ userData, ...t }) => t);

export function findTemplate(id) {
  return TEMPLATES.find((t) => t.id === id);
}

// Validate + thu thập params theo khai báo của template
export function collectParams(tpl, input = {}) {
  const out = {};
  for (const p of tpl.params) {
    const v = String(input[p.key] ?? p.default ?? '').trim();
    if (!v) throw Object.assign(new Error(`Thiếu tham số: ${p.label}`), { status: 400 });
    if (p.pattern && !new RegExp(p.pattern).test(v)) {
      throw Object.assign(new Error(`Tham số "${p.label}" không hợp lệ (không dùng khoảng trắng/ký tự đặc biệt lạ)`), { status: 400 });
    }
    out[p.key] = v;
  }
  return out;
}
