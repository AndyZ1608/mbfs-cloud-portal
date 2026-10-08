# MBFS Cloud Portal — Hướng dẫn cài đặt

Cổng tự phục vụ (self-service) cho OpenStack, phong cách console FPT Cloud.
Người dùng đăng nhập bằng tài khoản Keystone, tự quản lý máy ảo / ổ đĩa / mạng /
Floating IP / security group / SSH key trong project của mình.

**Kiến trúc:** 1 container duy nhất — Node.js/Express làm proxy tới OpenStack API
(token nằm ở server, không lộ ra trình duyệt) + React SPA giao diện tiếng Việt.

---

## 1. Chạy thử ngay (chế độ demo, KHÔNG cần OpenStack)

```bash
tar xzf mbfs-cloud-portal-v1.0.tar.gz && cd mbfs-cloud-portal
cp .env.example .env          # mặc định OS_MOCK=true
docker compose up -d --build
```

Mở `http://<ip-server>:8080` → đăng nhập tài khoản/mật khẩu **bất kỳ** (vd `demo` / `demo`).

Chế độ demo giả lập đầy đủ: máy ảo có sẵn, tạo/tắt/bật/xoá VM, gắn volume,
cấp Floating IP, security group… — dữ liệu nằm trong RAM, restart là về mặc định.
Dùng để duyệt giao diện với sếp/anh em trước khi trỏ vào OpenStack thật.

## 2. Trỏ vào OpenStack thật

Sửa `.env`:

```bash
OS_MOCK=false
OS_AUTH_URL=https://<keystone>:5000/v3     # endpoint Keystone v3
OS_REGION_NAME=RegionOne
OS_INTERFACE=public                        # portal nằm ngoài mgmt network → public
OS_DEFAULT_DOMAIN=Default
OS_COMPUTE_MICROVERSION=2.60
OS_INSECURE=true                           # nếu dùng cert tự ký
SESSION_SECRET=$(openssl rand -hex 32)
```

```bash
docker compose up -d --build
```

Đăng nhập bằng **tài khoản Keystone** (user/password/domain). Portal sẽ:
unscoped token → liệt kê project user có quyền → scope vào project đầu tiên.
Đổi project bằng dropdown góc trên trái.

### Yêu cầu phía OpenStack

- Keystone v3, các service Nova / Neutron / Cinder v3 / Glance v2 có trong catalog.
- Container portal **phải gọi được** các endpoint đó (chú ý DNS + firewall).
  Nếu portal chạy trong mgmt network thì đặt `OS_INTERFACE=internal`.
- Nova microversion 2.60 ≈ Queens trở lên. Bản cũ hơn: hạ `OS_COMPUTE_MICROVERSION`
  (vd `2.42`) — portal vẫn chạy, chỉ thiếu vài trường phụ.

### Tạo user/project cho nhân viên (chạy trên node có openstack CLI)

```bash
openstack project create --domain Default team-devops
openstack user create --domain Default --password 'MatKhau@123' hieptd
openstack role add --project team-devops --user hieptd member
```

User `member` là đủ cho mọi chức năng portal. Quota chỉnh bằng
`openstack quota set --instances 20 --cores 40 --ram 81920 team-devops`.

### Đổi mật khẩu VM

Hành động **Đổi mật khẩu** có sẵn cho VM trong project Keystone hiện tại. CMP xác minh VM qua Nova bằng token project-scoped, rồi gửi Nova `changePassword` với mật khẩu mới. CMP không kiểm tra image, distro, Guest Agent, nguồn boot hay trạng thái VM để quyết định hỗ trợ: Nova là bên quyết định và trả lỗi nếu thao tác không khả dụng. Mật khẩu chỉ tồn tại trong bộ nhớ cho yêu cầu này, không được lưu hay ghi log.

Nova trả HTTP 202 khi **nhận** yêu cầu; đây không phải xác nhận đồng bộ rằng mật khẩu trong guest đã đổi. Sau khi gửi, hãy xác minh bằng đăng nhập VM nếu cần.

### External networking cho Router và Floating IP

CMP tự truy vấn Neutron `GET /v2.0/networks?router:external=true`; không cần UUID
External Network/Subnet trong YAML và không hiển thị bộ chọn hạ tầng cho người dùng.
Nếu file cấu hình cũ còn mục `networking`, hãy xóa mục đó; CMP không đọc các UUID này nữa.
Chỉ Network external đang bật (`admin_state_up=true`) mới được xét. Với nhiều ứng viên,
Network duy nhất có `is_default=true` được ưu tiên; nếu không có duy nhất một default,
CMP chọn Network có UUID nhỏ nhất theo thứ tự chữ cái và ghi cảnh báo operator. Nếu
không có ứng viên khả dụng, thao tác thất bại trước khi tạo Router.

Router mới được tạo với gateway đến Network đã chọn và CMP xác minh gateway sau khi tạo.
Floating IP chưa gắn vào máy dùng cùng quy tắc chọn Network. Nếu thao tác có VM/Port đích,
CMP lấy External Network từ Router nối Subnet của Port đó; không chuyển sang Network khác
khi cấp địa chỉ thất bại. Trong Network đã chọn, CMP ưu tiên IPv4 Subnet có service type
`network:floatingip` và Allocation Pool hợp lệ; nếu còn nhiều ứng viên, chọn UUID nhỏ nhất.
Neutron IPAM cấp địa chỉ; CMP kiểm tra IP trả về thuộc pool được chọn. Quota/policy Neutron
vẫn áp dụng. Với admin, Network external thuộc project khác nhưng không shared chỉ được
xét khi RBAC `access_as_external` cấp cho project hiện tại hoặc `*`.

Quy tắc tự động chỉ áp dụng cho thao tác **mới**. CMP không tự sửa Router/FIP đã tồn tại;
Router cũ chưa có gateway sẽ hiển thị “Chưa cấu hình”. UUID hạ tầng không nằm trong
request từ trình duyệt hay màn hình người dùng.

### Billing Integration

Billing chạy như dịch vụ độc lập. CMP không đọc database Billing và không tính giá.
Menu Billing được bật sẵn; cấu hình `base_url` trong `server/config/application.yml`
bằng địa chỉ thực của Billing service để tải dữ liệu:

```yaml
billing:
  enabled: true

  # Billing internal REST API; replace with the actual reachable URL.
  base_url: ""

  timeout_seconds: 10
```

CMP chuyển tiếp Keystone token đang scope theo project qua `X-Auth-Token`.
Billing xác thực token với Keystone và tự lấy `project.id`; CMP không gửi
`project_id` để chọn dữ liệu. Xem [docs/BILLING.md](docs/BILLING.md).
Khi `base_url` chưa được cấu hình, menu vẫn hiển thị và trang báo dịch vụ chưa khả dụng.
Đặt `enabled: false` chỉ khi muốn tắt hẳn tính năng.

## 3. Reverse proxy HTTPS (khuyến nghị: cloud.mbfs.vn)

`.env` thêm:

```bash
SECURE_COOKIES=true
TRUST_PROXY=true
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name cloud.mbfs.vn;
    ssl_certificate     /etc/nginx/ssl/mbfs.crt;
    ssl_certificate_key /etc/nginx/ssl/mbfs.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # CMP giới hạn file < 15 GiB; 16G cho phép overhead HTTP nhưng chặn request quá lớn sớm.
        # Không buffer request ra đĩa tại nginx.
        # Giữ proxy_read_timeout/proxy_send_timeout phù hợp OS_UPLOAD_TIMEOUT_MS.
        client_max_body_size 16G;
        proxy_request_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

Image Upload hỗ trợ QCOW2 và ISO, với kích thước file **nhỏ hơn** 15 GiB
(16,106,127,360 byte; đúng 15 GiB bị từ chối). CMP nhận raw request body và ghi tạm vào
`IMAGE_UPLOAD_TEMP_DIR` theo từng chunk; Docker Compose dùng `/data/image-upload-temp`
trên volume `portal-data`. CMP dừng ghi trước mốc 15 GiB, trả 413, và xoá thư mục tạm
riêng của request. Chỉ sau khi nhận đủ file hợp lệ, CMP mới tạo metadata và stream file
tạm đến Glance; thư mục tạm được xoá sau thành công hoặc lỗi provider. Không buffer cả
image trong Node.js. Express JSON limit 1 MB không áp dụng cho raw image upload.
`OS_UPLOAD_TIMEOUT_MS` mặc định 1 giờ; Node giữ request-body deadline hữu hạn dài hơn 60
giây. Provision đủ dung lượng tạm cho nhiều upload đồng thời (mỗi file gần 15 GiB);
giới hạn mỗi file không phải quota tổng. Sau sự cố process/host bất thường, kiểm tra
thư mục tạm để dọn file mồ côi trước khi tiếp tục upload.

Sau đó thêm service card `cloud.mbfs.vn` vào dashboard insight.mbfs.vn là xong.

> **Console noVNC:** portal nhúng noVNC và tạo đúng một phiên RFB từ URL web client do
> Nova cấp. Trình duyệt người dùng phải resolve/truy cập được domain/IP `novncproxy` và
> tin cậy chứng chỉ TLS của proxy. Khi portal chạy HTTPS, Nova console cũng phải trả URL
> HTTPS để trình duyệt có thể dùng WSS mà không vi phạm mixed-content. Console Input chỉ
> giữ nội dung trong bộ nhớ component và gửi phím qua cùng phiên RFB đang hiển thị.

## 4. Chạy thủ công không Docker (tuỳ chọn)

```bash
cd web && npm install && npm run build && cd ..
cp -r web/dist server/public
cd server && npm install
OS_MOCK=true PORT=8080 node index.js
```

## 5. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Đăng nhập báo 401 | Sai user/password/domain Keystone, hoặc user chưa được gán role vào project nào |
| Lỗi 406 khi thao tác máy ảo | Nova quá cũ so với microversion — hạ `OS_COMPUTE_MICROVERSION` |
| `unable to verify the first certificate` | Cert tự ký → `OS_INSECURE=true` |
| Login được nhưng list VM lỗi timeout | Portal không gọi được endpoint Nova/Neutron public → thử `OS_INTERFACE=internal` hoặc mở firewall |
| Console noVNC không mở | Trình duyệt user không resolve/truy cập được WebSocket của novncproxy, hoặc không tin cậy chứng chỉ TLS — kiểm tra DNS/firewall/certificate |
| Đăng xuất ngẫu nhiên sau khi restart container | Session lưu RAM (thiết kế v1) — restart container là mất session, đăng nhập lại |
| Upload image báo 413 | File từ 15 GiB trở lên bị CMP từ chối đúng chính sách; nếu file nhỏ hơn 15 GiB, kiểm tra nginx `client_max_body_size 16G;` |
| Upload image chậm/timeout với file lớn | nginx thiếu `proxy_request_buffering off;` + tăng `proxy_read_timeout` |
| Resize báo lỗi "No valid host" | Cụm 1 compute node cần `allow_resize_to_same_host=True` trong nova.conf |
| Trang Báo cáo sử dụng trống | Kỳ chọn không có máy nào chạy; lưu ý mốc thời gian tính theo UTC |
| Trang Load Balancer báo "chưa deploy Octavia" | Cụm không có service `load-balancer` trong catalog — cài Octavia hoặc bỏ qua trang này |
| Tạo LB treo PENDING_CREATE lâu | Octavia amphora đang boot VM (1–3 phút là bình thường); ERROR → xem log octavia-worker |

Log: `docker logs -f mbfs-cloud-portal` — mỗi request API có user + thời gian xử lý.

## 6. Phạm vi & lộ trình gợi ý

**v1.0:** VM (tạo nhiều máy, boot-from-volume, start/stop/reboot/console/snapshot),
Volume + snapshot (gắn/tháo/mở rộng), Network + subnet + router, Floating IP,
Security group, Images (xem/xoá), SSH keypair, quota dashboard, đổi project.

**v1.1:** Upload image qua web (stream thẳng lên Glance, có progress) · Resize máy ảo
(đổi flavor, xác nhận/hoàn tác) · Xem log console (boot/cloud-init) khi VM không SSH được.

**v1.2:**
- Billing hiện được cung cấp bởi Billing service độc lập. Portal chỉ chuyển tiếp
  Keystone project-scoped token và hiển thị phản hồi; toàn bộ metering/rating/pricing
  đã được gỡ khỏi CMP.
- **Load Balancer (Octavia)** — tạo LB một bước (listener + pool + members + health
  monitor), HTTP/HTTPS-passthrough/TCP, round-robin/least-connections/source-IP,
  thêm/gỡ backend, gắn Floating IP vào VIP, xoá cascade. Trang tự ẩn nếu cụm
  chưa deploy Octavia (kiểm tra: `openstack service list | grep -i octavia`).

**v1.3:**
- **Backup tự động** (kiểu vBackup/FPT Backup bản gọn) — policy snapshot volume
  hoặc tạo image máy ảo theo lịch hàng ngày/hàng tuần, tự xoá bản cũ theo số
  lượng giữ lại (retention 1–90), nút "Chạy ngay", trạng thái lần chạy cuối.
  Cần **tài khoản dịch vụ** trong `.env` (user Keystone có role `member` trên
  các project cần backup):

  ```bash
  OS_TASK_USERNAME=portal-task
  OS_TASK_PASSWORD=MatKhauManh@123
  TZ=Asia/Ho_Chi_Minh        # giờ chạy lịch theo múi giờ này
  ```

  ```bash
  # tạo tài khoản dịch vụ trên controller:
  openstack user create --domain Default --password 'MatKhauManh@123' portal-task
  openstack role add --project <project> --user portal-task member   # từng project cần backup
  ```

  Policy lưu tại volume `portal-data:/data` (đã khai báo sẵn trong
  docker-compose.yml) — restart container không mất.
- **Nhật ký hoạt động** — tự động ghi mọi thao tác thay đổi (ai, làm gì, lúc nào,
  kết quả, kể cả đăng nhập và job backup nền), lọc theo project, tìm kiếm.
  Lưu tối đa 5000 dòng gần nhất trong `/data/audit.jsonl`.
- **Cảnh báo Telegram** — quota vượt ngưỡng (mặc định 85%), máy ảo rơi vào ERROR,
  load balancer suy giảm; có tin "đã phục hồi" và chống spam (nhắc lại sau 6h):

  ```bash
  TELEGRAM_BOT_TOKEN=123456:ABC...
  TELEGRAM_CHAT_ID=-100xxxxxxxxxx
  ALERT_QUOTA_PCT=85
  ```
- **Cloud-init user-data** khi tạo máy ảo (script chạy lần boot đầu) và
  **đổi tên máy ảo** trong menu hành động.

**v1.4 — App Marketplace (Ứng dụng mẫu):**
Triển khai ứng dụng 1-click kiểu Marketplace của FPT/Viettel/CMC Cloud. Chọn app
→ điền tham số → portal tự động: tạo security group mở đúng cổng app (giới hạn
CIDR tuỳ chọn) → tạo VM kèm cloud-init cài Docker + dựng app (`restart: always`,
sống qua reboot) → cấp & gắn Floating IP nếu chọn → trả về thông tin truy cập
và thông tin đăng nhập (hiện một lần).

10 template có sẵn: Docker Host · PostgreSQL 16 · MySQL 8 · Redis 7 ·
n8n Automation · GitLab Runner (tự register) · Nginx Web · Uptime Kuma ·
MinIO (S3) · WordPress.

Yêu cầu: image **Ubuntu 22.04/24.04 cloud** trong Glance (template dùng gói
`docker.io`/`docker-compose-v2` của Ubuntu) và VM ra được Internet (hoặc apt
mirror + registry mirror nội bộ) để tải package/image. Cài đặt mất 2–5 phút sau
khi máy ACTIVE — theo dõi bằng "Xem log console". Dữ liệu app nằm ở `/opt/<app>`
trên VM. Template chỉ là file trong `server/templates.js` — team có thể tự thêm
mẫu riêng (vd chuẩn hoá golden image MBFS) rồi rebuild.

**v1.5 — Kubernetes (RKE2) 1-click:**
Menu "Kubernetes" dựng cụm RKE2 tự động: 1 server + 0–9 worker. Portal sinh
token, tạo security group (mở toàn bộ giao thức giữa các node qua
remote_group_id; mở 6443/9345/22 từ CIDR quản trị), tạo server node, chờ IP,
tạo worker join qua IP đó, gắn Floating IP vào server. Cụm được theo dõi
(node ready x/y), xoá cả cụm một nút (VM + SG). Kubeconfig lấy qua SSH —
hướng dẫn hiện sẵn trong chi tiết cụm. Node cần ra Internet tải get.rke2.io;
yêu cầu flavor ≥ 2 vCPU / 4 GB và Ubuntu cloud image.

**v1.6 — Quản trị cụm (menu chỉ hiện với user có role `admin`):**
- Tổng quan hypervisor toàn cụm: vCPU/RAM/disk vật lý đã cấp phát, số VM đang chạy.
- Projects & Quota: tạo project, sửa 9 chỉ số quota (Nova/Cinder/Neutron) ngay trên web.
- Users: tạo user Keystone, gán role member/admin vào project, đổi mật khẩu.
Role đọc từ token Keystone của chính người đăng nhập — không cần cấu hình thêm.
Đổi role trên project nào thì phải đăng nhập/switch lại project đó mới nhận.

## SSO Keycloak — Phase 1 identity binding

CMP uses OIDC Authorization Code + PKCE via the backend, then binds verified
`iss + sub` to a Keystone User UUID. A bound SSO identity is **not** an OpenStack
resource session until Keystone federation is implemented in Phase 2. Local
Keystone login remains available and is still required for resource APIs.
No Keycloak group is mapped to a Keystone project or role in Phase 1.

### Cấu hình phía Keycloak
1. **Clients → Create client**: Client ID `mbfs-cloud-portal`,
   Client authentication **On**, Standard flow **On**.
2. **Settings**:
   - Valid redirect URIs: `https://cloud.mbfs.vn/api/auth/sso/callback`
   - Valid post logout redirect URIs: `https://cloud.mbfs.vn/login`
   - Web origins: `https://cloud.mbfs.vn`
3. Include standard `openid profile email` scopes and the stable Keycloak `sub`.
4. **Credentials** → copy Client secret. Do not configure Horizon for this flow.

### Cấu hình phía portal (.env)
```bash
SSO_ENABLED=true
OIDC_ISSUER_URL=https://keycloak.mbfs.vn/realms/mbfs
OIDC_CLIENT_ID=mbfs-cloud-portal
OIDC_CLIENT_SECRET=<Keycloak client secret>
OIDC_REDIRECT_URI=https://cloud.mbfs.vn/api/auth/sso/callback
OIDC_SCOPES=openid profile email
SECURE_COOKIES=true

# Dedicated system-scoped Keystone identity, restricted by Keystone policy to
# reading users and, only if provisioning is enabled, creating/deleting users.
SSO_KEYSTONE_USERNAME=portal-sso-identity
SSO_KEYSTONE_PASSWORD=<service password>
SSO_KEYSTONE_DOMAIN=Default
SSO_PROVISIONING_ENABLED=false
```

```bash
# On the controller, create a dedicated service account and grant only the
# required Keystone system-scope user-read policy. If enabling provisioning,
# additionally grant user create/delete in the onboarding domain. Do not grant
# this identity Nova/Neutron/Cinder project roles. Exact role names depend on
# the deployment's Keystone policy and must be reviewed by its administrator.
```

After sign-in, unbound users may prove ownership with their existing Keystone
password. If provisioning is enabled, CMP creates a passwordless Keystone user
without projects or roles. The SQLite binding DB must be persisted and backed
up along with `DATA_DIR`; a crashed provisioning claim needs operator
reconciliation before retrying. The local Keystone login form remains visible.

### Xử lý sự cố SSO

| Triệu chứng | Cách xử lý |
|---|---|
| Keycloak reports invalid redirect_uri | `OIDC_REDIRECT_URI` must exactly match the Keycloak client redirect URI |
| SSO button hidden | Check `OIDC_*` and `SSO_KEYSTONE_*`; local login remains available |
| Linked account missing/disabled | Restore or enable the original Keystone UUID; CMP never auto-rebinds |
| Username collision on create | Link the existing user with its password; CMP never claims matching names |
| Self-signed Keycloak certificate | Import the private CA into the container trust store; do not disable TLS verification |

## 7. Xử lý sự cố bổ sung (v1.3)

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Trang Backup báo "chưa cấu hình tài khoản dịch vụ" | Thiếu `OS_TASK_USERNAME/OS_TASK_PASSWORD` trong .env |
| Policy chạy nhưng last run báo lỗi 403 | Tài khoản dịch vụ chưa được gán role `member` vào project đó |
| Backup chạy sai giờ | Kiểm tra `TZ` trong .env (mặc định UTC nếu bỏ trống) |
| Policy/nhật ký mất sau restart | Volume `portal-data:/data` chưa được mount (xem docker-compose.yml) |
| Telegram không nhận cảnh báo | Sai token/chat_id; bot phải được add vào group; xem `docker logs` dòng [alerts] |
| App marketplace tạo VM nhưng app không lên | VM không ra được Internet để apt/docker pull — kiểm tra router gateway/DNS; xem "Xem log console" |
| App marketplace lỗi với image CentOS/Rocky | Template thiết kế cho Ubuntu cloud image — dùng Ubuntu 22.04/24.04 |
