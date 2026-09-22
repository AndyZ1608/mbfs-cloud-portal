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

### Billing Integration

Billing chạy như dịch vụ độc lập. CMP không đọc database Billing và không tính giá.
Sửa `server/config/application.yml`, thay địa chỉ mẫu bằng địa chỉ Billing VM:

```yaml
billing:
  enabled: true

  # Billing internal REST API.
  # Example:
  # base_url: "http://100.64.64.150:8080"
  base_url: "http://x.x.x.x:port"

  timeout_seconds: 10
```

CMP chuyển tiếp Keystone token đang scope theo project qua `X-Auth-Token`.
Billing xác thực token với Keystone và tự lấy `project.id`; CMP không gửi
`project_id` để chọn dữ liệu. Xem [docs/BILLING.md](docs/BILLING.md).

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

        # Cần cho upload image lớn (v1.1): không giới hạn size, không buffer ra đĩa
        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

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
| Upload image báo 413 | nginx thiếu `client_max_body_size 0;` |
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

## SSO Keycloak (chế độ cầu nối)

Người dùng bấm "Đăng nhập bằng SSO", xác thực trên Keycloak (Authorization Code
+ PKCE, ID token RS256 verify qua JWKS), portal ánh xạ **nhóm Keycloak → project
OpenStack** và nhóm quản trị → menu Quản trị cụm. Đăng xuất kết thúc cả phiên
Keycloak. Nhật ký hoạt động ghi **tên người thật** từ Keycloak.

### ⚠️ Giới hạn cần biết trước khi bật
Keystone chưa federation, nên mọi lệnh gửi OpenStack thực hiện bằng **tài khoản
dịch vụ OS_TASK_***. Phía OpenStack (chủ sở hữu VM trong Nova, audit Keystone)
chỉ thấy tài khoản dịch vụ, KHÔNG thấy từng nhân viên — truy vết theo người thật
nằm ở Nhật ký hoạt động của portal. Hệ quả:
- Tài khoản dịch vụ phải được gán `member` vào **mọi project** dùng qua SSO
  (thêm `admin` nếu muốn dùng Quản trị cụm).
- Ai truy cập được máy chủ portal / file `.env` là chạm được quyền của tài khoản
  đó → siết SSH và quyền file (`chmod 600 .env`).
- Khi chuyển sang federation thật (Keystone OIDC), cấu hình Keycloak dưới đây
  giữ nguyên, chỉ đổi cách portal lấy token.

### Cấu hình phía Keycloak
1. **Clients → Create client**: Client ID `mbfs-cloud-portal`,
   Client authentication **On**, Standard flow **On**.
2. **Settings**:
   - Valid redirect URIs: `https://cloud.mbfs.vn/api/auth/sso/callback`
   - Valid post logout redirect URIs: `https://cloud.mbfs.vn/login`
   - Web origins: `https://cloud.mbfs.vn`
3. **Client scopes → mbfs-cloud-portal-dedicated → Add mapper → By configuration
   → Group Membership**: Token Claim Name `groups`, Full group path **Off**,
   Add to ID token **On**, Add to access token **On**.
4. **Groups**: tạo mỗi project OpenStack một nhóm — `os-devops-team`,
   `os-demo-project`… và `cloud-admins` cho quản trị viên. Gán user vào nhóm.
5. **Credentials** → copy Client secret.

### Cấu hình phía portal (.env)
```bash
SSO_ENABLED=true
SSO_ISSUER=https://keycloak.mbfs.vn/realms/mbfs
SSO_CLIENT_ID=mbfs-cloud-portal
SSO_CLIENT_SECRET=<client secret vừa copy>
PUBLIC_URL=https://cloud.mbfs.vn          # phải trùng URL người dùng gõ
SSO_ADMIN_GROUP=cloud-admins
SSO_ALLOW_LOCAL_LOGIN=true                # giữ true để có đường dự phòng

# Bắt buộc — tài khoản dịch vụ gọi OpenStack:
OS_TASK_USERNAME=portal-task
OS_TASK_PASSWORD=<mật khẩu>
```

```bash
# Trên controller: tạo tài khoản dịch vụ và gán vào từng project
openstack user create --domain Default --password '<mật khẩu>' portal-task
openstack role add --project devops-team --user portal-task member
openstack role add --project demo-project --user portal-task member
# (thêm role admin nếu muốn dùng menu Quản trị cụm qua SSO)
```

Bật xong: trang đăng nhập hiện nút SSO phía trên, form Keystone vẫn còn bên dưới
làm đường dự phòng. Đặt `SSO_ALLOW_LOCAL_LOGIN=false` nếu muốn ép chỉ dùng SSO.

### Xử lý sự cố SSO

| Triệu chứng | Cách xử lý |
|---|---|
| "chưa thuộc nhóm project nào" | User thiếu nhóm `os-<project>`, hoặc mapper groups chưa bật Add to ID token |
| "Không có project nào khớp" | Tài khoản dịch vụ chưa được gán vào project tương ứng |
| Keycloak báo invalid redirect_uri | `PUBLIC_URL` khác Valid redirect URIs khai trong client |
| "Issuer không khớp" | `SSO_ISSUER` phải đúng dạng `https://kc/realms/<realm>`, không có `/` cuối |
| "Cấu hình SSO chưa đủ" trên trang login | Thiếu SSO_CLIENT_ID hoặc PUBLIC_URL — nút SSO tự ẩn, login Keystone vẫn dùng được |
| Keycloak dùng cert tự ký | `SSO_INSECURE=true` |

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
