# Nâng cấp MBFS Cloud Portal

## External Billing integration

- Local metering, rating, pricing, monthly cost reports, and price environment variables have been removed.
- Configure the separately deployed Billing service in `server/config/application.yml`; Docker Compose mounts this file read-only.
- The old `/usage` page redirects to `/billing`. External clients should use `GET /api/billing`, `/api/billing/instances`, and `/api/billing/instances/:instanceId`.
- CMP forwards only the current project-scoped Keystone token. Billing validates it and determines `project.id`.
- Legacy Keycloak bridge-SSO sessions cannot access Billing because they hold a service-account token; migrate those users to Keystone WebSSO federation.

## v2.4 security/architecture refactor

- Production now requires `NODE_ENV=production` and `SESSION_SECRET` with at least 32 characters.
- Add optional `DATA_ENCRYPTION_KEY`; if omitted, `SESSION_SECRET` encrypts persisted Kubernetes join tokens. Keep this key stable across upgrades.
- New timeout settings: `OS_REQUEST_TIMEOUT_MS=30000`, `OS_UPLOAD_TIMEOUT_MS=3600000`, and `SESSION_TTL_SEC=28800`.
- Non-safe API requests now require `X-CMP-Request: 1`. The bundled frontend sends it automatically, including streaming uploads. Update external API clients before deployment.
- API errors now include stable `code` and `requestId` fields while retaining the existing `error` field.
- Existing plaintext Kubernetes tokens are migrated to encrypted form on startup when key material is configured.
- The frontend now uses React Router 7 and Vite 8 to resolve dependency advisories; local builds require Node.js 20.19 or newer.


```bash
# 1. Backup file cấu hình
cp .env /root/backup-cloud-portal.env

# 2. Giải nén bản mới đè lên (KHÔNG đè .env)
tar xzf mbfs-cloud-portal-vX.Y.tar.gz --exclude='.env' -C ./

# 3. Build lại và khởi động
docker compose up -d --build
```

- Portal **stateless** — không có database riêng, mọi dữ liệu nằm trong OpenStack,
  nên nâng cấp/rollback chỉ là đổi image container.
- Session lưu RAM: sau khi up bản mới, người dùng đăng nhập lại (bình thường).
- Rollback: giải nén lại tarball bản cũ, `docker compose up -d --build`.
- So sánh `.env.example` mới với `.env` đang chạy để bổ sung biến mới (nếu có).

## v1.0 → v1.1

Tính năng mới: Báo cáo sử dụng + chi phí, Upload image, Resize VM, Log console.

```bash
cp .env /root/backup-cloud-portal.env
tar xzf mbfs-cloud-portal-v1.1.tar.gz --exclude='.env' -C ./
# compose v1 dính bug ContainerConfig khi recreate → xoá container trước:
docker rm -f mbfs-cloud-portal
docker-compose up -d --build      # (compose v2: docker compose up -d --build)
```

Sau khi up: so sánh `.env.example` để thêm biến mới nếu cần.
Nếu chạy sau nginx và sẽ dùng upload image, thêm vào location `/`:
`client_max_body_size 0; proxy_request_buffering off; proxy_read_timeout 3600;`

## v1.1 → v1.2

Tính năng mới: **Billing kiểu AWS** (biểu đồ theo ngày, hoá đơn theo dịch vụ,
dự báo, ngân sách, tính cả volume/snapshot/FIP) + **Load Balancer (Octavia)**.

```bash
cp .env /root/backup-cloud-portal.env
tar xzf mbfs-cloud-portal-v1.2.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal
docker-compose up -d --build      # (compose v2: docker compose up -d --build)
```

Các biến giá của Billing cục bộ trong bản này đã lỗi thời và không còn được CMP sử dụng.
Trang Load Balancer tự ẩn nếu cụm chưa có Octavia — không cần cấu hình gì thêm.

## v1.2 → v1.3

Tính năng mới: **Backup tự động theo lịch**, **Nhật ký hoạt động**,
**Cảnh báo Telegram**, cloud-init user-data + đổi tên máy ảo.

```bash
cp .env /root/backup-cloud-portal.env
tar xzf mbfs-cloud-portal-v1.3.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal
docker-compose up -d --build      # compose v2: docker compose up -d --build
```

Lưu ý bản này:
- docker-compose.yml MỚI có volume `portal-data:/data` (lưu policy + nhật ký).
  Nếu anh đã tuỳ biến compose thì tự thêm khối volumes tương ứng.
- Biến `.env` mới (tuỳ chọn): `OS_TASK_USERNAME/OS_TASK_PASSWORD/OS_TASK_DOMAIN`,
  `TZ`, `TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID`, `ALERT_QUOTA_PCT/ALERT_INTERVAL_MIN/ALERT_REPEAT_HOURS`.
- Không đặt các biến trên thì portal chạy như v1.2, các trang mới hiện hướng dẫn cấu hình.

## v1.3 → v1.4

Tính năng mới: **App Marketplace** — triển khai 1-click 10 ứng dụng
(PostgreSQL, MySQL, Redis, n8n, GitLab Runner, Nginx, Uptime Kuma, MinIO,
WordPress, Docker Host) với tự động mở firewall + gắn Floating IP.

```bash
cp .env /root/backup-cloud-portal.env
tar xzf mbfs-cloud-portal-v1.4.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal
docker-compose up -d --build      # compose v2: docker compose up -d --build
```

Không có biến .env mới. Cần image Ubuntu 22.04/24.04 cloud trong Glance và
VM ra được Internet (apt + Docker Hub) để app tự cài.
Muốn thêm template riêng: sửa `server/templates.js` rồi build lại.

## v1.4 → v1.4.1 (hotfix build offline)

Sửa: bỏ `RUN apk add tzdata` khỏi Dockerfile (bước này cần Internet tới
dl-cdn.alpinelinux.org và làm treo build trong mạng DC bị chặn egress).
Lịch backup giờ tính múi giờ bằng Intl/ICU có sẵn trong Node — giờ VN vẫn
chuẩn tuyệt đối, không phụ thuộc tzdata hệ điều hành, build không cần mạng
(trừ các layer đã cache sẵn).

```bash
tar xzf mbfs-cloud-portal-v1.4.1.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal
docker-compose up -d --build
```

## v1.4.1 → v1.6 (gộp v1.5 + v1.6)

Tính năng mới: **Kubernetes RKE2 1-click** (menu Kubernetes) và
**Quản trị cụm** (menu chỉ hiện với user role admin: hypervisor stats,
project + quota, users).

```bash
cp .env /root/backup-cloud-portal.env
tar xzf mbfs-cloud-portal-v1.6.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal
docker-compose up -d --build
```

Không có biến .env mới. Lưu ý: portal giờ đọc role từ token Keystone —
user nào có role `admin` trên project đang chọn sẽ thấy menu Quản trị cụm.
Cụm K8s lưu ở volume portal-data (clusters.json).

## v1.6 → v1.6-sso

Tính năng thêm: **SSO Keycloak (chế độ cầu nối)**. Ngoài ra KHÔNG đổi gì khác
so với v1.6 — đúng bản anh đang chạy, chỉ cộng thêm SSO.

```bash
cp .env /root/backup-cloud-portal.env
tar xzf mbfs-cloud-portal-v1.6-sso.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal     # né bug ContainerConfig của compose v1
docker-compose up -d --build
```

Mặc định `SSO_ENABLED=false` → portal chạy y hệt v1.6 hiện tại (đã kiểm chứng:
đăng nhập Keystone, đổi project, nhật ký hoạt động không đổi). Muốn bật SSO:
xem mục "SSO Keycloak" trong INSTALL.md.
Không thêm thư viện npm nào — build vẫn offline được.

## v1.6-sso → v1.6.2 (giao diện đăng nhập)

Chỉ đổi trang đăng nhập: bố cục kiểu landing page (hero giới thiệu + card đăng
nhập), nền động 3D — aurora chuyển màu, sàn lưới phối cảnh, hạt sáng bay, khối
isometric Compute/Storage/Network. Toàn bộ bằng CSS/SVG nội bộ, KHÔNG tải ảnh
hay font từ Internet (chạy tốt trong mạng cô lập). Tự tắt hiệu ứng nếu máy người
dùng bật "reduce motion"; màn hình hẹp tự rút gọn còn card đăng nhập.

Tên hiển thị lấy từ biến CLOUD_NAME trong .env — không phải sửa code.

```bash
tar xzf mbfs-cloud-portal-v1.6.2.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal
docker-compose up -d --build
```
Không có biến .env mới. Backend không đổi.

## v1.6.2 → v2.0 — SSO đúng chuẩn (Keystone WebSSO federation)

Portal đi đúng đường Horizon: Keystone cấp token federated CHO CHÍNH NGƯỜI DÙNG.
Không còn cần tài khoản dịch vụ OS_TASK_*, không cần nhóm/mapper Keycloak.

### 1) Phía Keystone (kolla) — thêm URL portal vào danh sách tin cậy
```yaml
# /etc/kolla-2025.1/globals.yml
keystone_trusted_dashboards:
  - "https://cloud-tttkvh.mbfs.vn/auth/websso/"          # giữ nguyên của Horizon
  - "https://cloud.mbfs.vn/api/auth/websso/callback"      # thêm cho portal
```
```bash
kolla-ansible -i <inventory> reconfigure -t keystone
```
(Sửa trực tiếp keystone.conf trong container sẽ bị ghi đè lần deploy sau.)

### 2) Phía Keycloak
Client hiện có của Keystone dùng lại nguyên vẹn — KHÔNG cần client mới, KHÔNG
cần mapper groups. Portal không nói chuyện trực tiếp với Keycloak nữa.

### 3) Phía portal (.env)
```bash
OS_WEBSSO_ENABLED=true
OS_WEBSSO_IDP=mbfs
OS_WEBSSO_PROTOCOL=openid          # đổi nếu protocol khác
PUBLIC_URL=https://cloud.mbfs.vn   # phải trùng trusted_dashboard
# Có thể xoá: SSO_*, OS_TASK_* (nếu không dùng backup/cảnh báo)
```
```bash
tar xzf mbfs-cloud-portal-v2.0.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal && docker-compose up -d --build
```

Chế độ cầu nối (SSO_*) vẫn còn trong bản này làm phương án dự phòng; nếu bật cả
hai thì nút WebSSO được ưu tiên hiển thị.

## v2.0 → v2.0.1

Sửa: tách URL Keystone dành cho trình duyệt (`OS_WEBSSO_URL`) khỏi URL portal gọi
server-side (`OS_AUTH_URL`). Trước đó portal chuyển hướng trình duyệt tới endpoint
nội bộ (thường là IP), nơi mod_auth_openidc không phục vụ → HAProxy trả 502.

```bash
tar xzf mbfs-cloud-portal-v2.0.1.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal && docker-compose up -d --build
```
Thêm vào .env: `OS_WEBSSO_URL=<đúng URL Keystone mà Horizon dùng cho SSO>`
(có hoặc không có /v3 đều được).

## v2.0.1 → v2.1 — Vận hành nâng cao & tối ưu chi phí

Tính năng mới (không cần bật thêm service OpenStack nào):
- **Tối ưu chi phí** (menu mới): quét máy tắt lâu ngày, máy ERROR, volume rời,
  Floating IP rảnh, snapshot quá cũ → quy ra tiền lãng phí mỗi tháng, xuất CSV.
- **Lịch bật/tắt máy ảo** (menu mới): tắt ngoài giờ + bật đầu giờ theo thứ trong
  tuần, giờ Việt Nam. Cần OS_TASK_USERNAME/PASSWORD như backup tự động.
- **Cài lại HĐH (rebuild)**: giữ IP/ID/volume, bắt gõ đúng tên máy để xác nhận.
- **Shelve / Unshelve**: tắt sâu, giải phóng tài nguyên compute mà không mất máy.
- **Quản lý card mạng (NIC)**: gắn thêm/gỡ network cho máy đang chạy.
- **Đổi security group** của máy đang chạy — không cần vào Horizon nữa.
- **Ô tìm kiếm** theo tên/IP trong trang Máy ảo.

```bash
cp .env /root/backup-cloud-portal.env
tar xzf mbfs-cloud-portal-v2.1.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal && docker-compose up -d --build
```
Không có biến .env mới. Trang tối ưu chỉ phân tích mức sử dụng tài nguyên;
lịch bật/tắt lưu ở volume portal-data (power-rules.json).

## v2.1 → v2.2 — Giám sát VM + khuyến nghị hạ cấu hình

- **Giám sát VM tích hợp**: cột CPU realtime trong bảng Máy ảo, biểu đồ
  CPU/RAM/mạng/đĩa 1h·6h·24h, cảnh báo Telegram khi CPU cao kéo dài.
  Dữ liệu lấy từ Nova `os-diagnostics` (libvirt) — KHÔNG cần agent trong VM,
  không cần Ceilometer.
- **Trang Tối ưu chi phí** nhận thêm loại phát hiện mạnh nhất: *máy đang chạy
  nhưng CPU trung bình dưới ngưỡng* → gợi ý hạ flavor, ước tính tiết kiệm ~50%.

```bash
tar xzf mbfs-cloud-portal-v2.2.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal && docker-compose up -d --build
```

Cần `OS_TASK_USERNAME/PASSWORD` + quyền đọc Nova diagnostics (xem .env.example).
Chưa cấu hình thì cột CPU hiện dấu "—", các chức năng khác không ảnh hưởng.

## v2.2 → v2.3 — Object Storage, IaC, Thông báo

- **Object Storage** (menu mới): quản lý container + file trên Swift/Ceph RGW,
  upload stream có progress, tải về, xoá, tạo **link chia sẻ tạm thời (TempURL)**.
  Trang tự ẩn nếu cụm chưa có service `object-store`.
- **Xuất Terraform**: nút ở trang Tổng quan tải file .tf mô tả toàn bộ hạ tầng
  project (network/subnet/router/secgroup/keypair/volume/VM/FIP).
- **Trung tâm thông báo**: chuông trên thanh trên cùng, gom sự kiện backup,
  lịch bật/tắt, cảnh báo CPU; có đếm số chưa đọc.

```bash
tar xzf mbfs-cloud-portal-v2.3.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal && docker-compose up -d --build
```

## v2.3 → v2.4 — Sẵn sàng sản xuất

- **Lưu phiên bền vững**: `SESSION_STORE=file` (restart không mất phiên) hoặc
  `SESSION_STORE=redis` (chạy nhiều replica sau load balancer). Client Redis tự
  viết bằng node:net — KHÔNG thêm thư viện npm nào, build vẫn offline được.
- **Rate limiting**: chặn dò mật khẩu ở /auth/login (mặc định 10 lần/5 phút/IP)
  và hạn mức API chung; trả 429 kèm Retry-After.
- **Security headers**: CSP, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy, HSTS (khi SECURE_COOKIES=true).
- **Tắt êm (graceful shutdown)**: nhận SIGTERM thì ngừng nhận kết nối mới, chờ
  request đang chạy xong rồi mới thoát — không cắt ngang thao tác người dùng.
- **Dark mode**: nút mặt trăng/mặt trời trên thanh trên cùng, nhớ lựa chọn; và
  tối ưu hiển thị trên màn hình hẹp (bảng cuộn ngang thay vì vỡ layout).
- **Test tự động**: `cd server && npm test` (9 test, dùng node:test có sẵn) +
  workflow CI GitHub Actions ở .github/workflows/ci.yml.

```bash
tar xzf mbfs-cloud-portal-v2.4.tar.gz --exclude='.env' -C ./
docker rm -f mbfs-cloud-portal && docker-compose up -d --build
```
Mặc định giữ nguyên hành vi cũ. Khuyến nghị tối thiểu đặt `SESSION_STORE=file`.
