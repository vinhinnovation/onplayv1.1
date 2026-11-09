# OnQuiz v1.1 · OnPoint

Game trắc nghiệm trực tiếp (kiểu Kahoot) mang bộ nhận diện OnPoint. Host đăng nhập để soạn quiz và điều khiển game; người chơi vào bằng **mã PIN + biệt danh**, không cần tài khoản. Chạy trên **GitHub + Vercel + Supabase**, thiết kế cho tới ~5.000 người chơi đồng thời.

## 1. Có gì trong v1.1

| Nhóm | Nội dung |
|---|---|
| Host | Đăng nhập email + mật khẩu (Supabase Auth); tạo, sửa, nhân bản, xóa quiz; nhập câu hỏi từ CSV; tổ chức game; xem lịch sử game và tải kết quả CSV |
| Soạn quiz | Mỗi câu: nội dung, 2–4 đáp án, **tick đáp án đúng (được tick nhiều đáp án đúng)**, **điểm của câu (0–10.000, mặc định 1.000)**, **thời gian trả lời (5–300 giây)**, bật/tắt thưởng điểm theo tốc độ; sắp xếp thứ tự câu |
| Người chơi | Vào bằng PIN hoặc quét QR, đặt biệt danh, trả lời trên điện thoại, xem điểm, hạng, chuỗi đúng; vào lại được sau khi tải lại trang hoặc mất mạng |
| Màn hình host | PIN + QR lớn, số người đã vào, đếm ngược, số người đã trả lời, phân bố lựa chọn, bảng xếp hạng top 5, bục vinh quang; tự chốt câu khi hết giờ hoặc khi mọi người đã trả lời |
| Giao diện | Song ngữ Việt/Anh, logo và màu OnPoint, dùng được trên máy tính và điện thoại |
| Backend | Một file SQL duy nhất (bảng, RLS, hàm RPC, phát sự kiện realtime), không cần server riêng |

**Chưa có trong v1.1:** thanh toán/gói thuê bao, ảnh trong câu hỏi, nhiều game ngoài trắc nghiệm, đăng nhập SSO, giao diện tiếng Thái.

### Quy tắc tính điểm

- Trả lời sai hoặc không trả lời: 0 điểm và **chuỗi đúng về 0**.
- Trả lời đúng (chọn **bất kỳ** đáp án nào được tick đúng): điểm câu hỏi **P**.
  - Bật thưởng tốc độ: `P × (1 − 0.5 × thời gian đã dùng / thời gian cho phép)`, tức từ 100% xuống 50% P.
  - Tắt thưởng tốc độ: luôn đủ P.
- Thưởng chuỗi đúng: `P × 10% × số câu đúng liên tiếp trước đó`, tối đa 50% P (câu đầu tiên không có thưởng chuỗi).
- Thời gian do **server** đo, không tin đồng hồ điện thoại. Server nhận câu trả lời muộn tối đa 1,5 giây để bù độ trễ mạng.

## 2. Kiến trúc

```
Người chơi (điện thoại)  ──┐                        ┌─> Postgres: bảng + RLS + hàm RPC (chấm điểm tại server)
Host (máy tính)          ──┼──>  Vercel (React/Vite) ┤
                           │      tĩnh, CDN         └─> Realtime Broadcast (private channel, chia 10 shard)
                           └────────── supabase-js ──────────────┘
```

- Người chơi **không dùng Supabase Auth** (tránh giới hạn đăng nhập ẩn danh), mà gọi hàm RPC bằng khoá `anon` kèm `(player_id, token)` do `join_game` cấp.
- Người chơi **không đọc được bảng nào**; đáp án đúng chỉ được gửi sau khi host chốt câu.
- Sự kiện (câu mới, đáp án, bảng xếp hạng) do **database phát** qua `realtime.send`, client không thể giả mạo.
- Nếu realtime chập chờn, client tự chuyển sang polling nhẹ (`get_phase`), game vẫn chơi được nhưng chậm hơn vài giây.

## 3. Chạy thử trên máy (10 phút)

Cần: Node.js 20+, một project Supabase (xem mục 4).

```bash
npm install
cp .env.example .env        # điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY
npm run dev                 # mở http://localhost:5173
```

## 4. Triển khai thật, từng bước

### Bước 1. Tạo project Supabase

1. Vào https://supabase.com/dashboard, **New project**.
2. Chọn **region gần người chơi nhất** (Việt Nam/Thái Lan: Singapore), đặt mật khẩu database và **lưu lại**.
3. Chờ project khởi tạo xong (1–2 phút).

> **Gói dịch vụ:** gói Free chỉ phù hợp để thử. Với sự kiện lớn (hàng trăm đến 5.000 người) bạn cần gói trả phí và phải kiểm tra hạn mức **Realtime concurrent connections** (mỗi người chơi giữ 1 kết nối). Tại thời điểm viết tài liệu, hạn mức tham khảo là Free 200, Pro 500 mặc định, Team 10.000, và có thể nâng bằng cách chỉnh Spend Cap hoặc liên hệ Supabase. **Hãy kiểm tra lại trang Realtime Limits trong tài liệu Supabase và mục Settings → Realtime trong Dashboard trước sự kiện.**

### Bước 2. Chạy file SQL tạo backend

Cách A (đơn giản nhất): Dashboard → **SQL Editor** → **New query** → dán toàn bộ nội dung file `supabase/migrations/20261109000001_onquiz_v1_1.sql` → **Run**. Kết quả mong đợi: *Success. No rows returned*.

Cách B (CLI):

```bash
npx supabase login
npx supabase init                       # chỉ cần chạy một lần, giữ nguyên thư mục migrations
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
```

**Chỉ chạy file một lần** trên project trống. Chạy lại sẽ báo lỗi "already exists". Muốn làm lại từ đầu, hãy tạo project mới (hoặc xóa các bảng `answers, players, game_questions, games, questions, quizzes` rồi chạy lại).

### Bước 3. Cấu hình Authentication (cho host)

1. **Authentication → URL Configuration**: đặt **Site URL** = địa chỉ web cuối cùng (ví dụ `https://onquiz.onpoint.vn`), thêm vào **Redirect URLs**: `https://onquiz.onpoint.vn/**` và `http://localhost:5173/**`. Bạn có thể cập nhật sau khi có địa chỉ Vercel.
2. Chọn một trong hai cách quản lý host:
   - **Khuyến nghị cho dùng nội bộ:** tắt "Allow new users to sign up" (mục Email provider), rồi tạo host thủ công ở **Authentication → Users → Add user → Create new user** (tick *Auto Confirm User*). Đặt `VITE_ENABLE_SIGNUP=false` ở Vercel để ẩn form đăng ký.
   - **Cho phép tự đăng ký:** giữ đăng ký mở. Email xác nhận cần SMTP riêng (**Authentication → SMTP Settings**), vì dịch vụ email mặc định của Supabase bị giới hạn rất thấp và có thể chỉ gửi cho thành viên dự án. Nếu không cấu hình SMTP, hãy tắt "Confirm email".
3. (Tuỳ chọn) Đăng nhập Google: bật Google provider, rồi đặt `VITE_ENABLE_GOOGLE=true`.

### Bước 4. Lấy khoá kết nối

**Project Settings → API**: chép **Project URL** và khoá **anon / publishable**. Hai giá trị này sẽ đặt ở Vercel (bước 6).

> Khoá `anon` được phép công khai, vì mọi quyền đã bị khoá bằng RLS và hàm RPC. **Không bao giờ đưa khoá `service_role` vào frontend hoặc lên GitHub.**

### Bước 5. Đưa mã nguồn lên GitHub

```bash
git init
git add .
git commit -m "OnQuiz v1.1"
git branch -M main
git remote add origin https://github.com/<tổ-chức>/<repo>.git   # tạo repo trống (nên để Private) trước
git push -u origin main
```

File `.env` đã nằm trong `.gitignore`, sẽ không bị đẩy lên.

### Bước 6. Deploy trên Vercel

1. https://vercel.com → **Add New → Project** → chọn repo GitHub vừa tạo (cấp quyền cho Vercel nếu được hỏi).
2. **Framework Preset:** Vite (tự nhận). Build Command `npm run build`, Output `dist` (đã khai báo trong `vercel.json`).
3. Mở **Environment Variables**, thêm cho cả Production và Preview:

| Biến | Giá trị |
|---|---|
| `VITE_SUPABASE_URL` | Project URL ở bước 4 |
| `VITE_SUPABASE_ANON_KEY` | khoá anon ở bước 4 |
| `VITE_ENABLE_SIGNUP` | `true` hoặc `false` (xem bước 3) |
| `VITE_ENABLE_GOOGLE` | `false` (hoặc `true` nếu đã bật Google) |

4. **Deploy.** Sau khi xong, bạn có địa chỉ dạng `https://<tên>.vercel.app`.
5. (Tuỳ chọn) **Settings → Domains**: thêm tên miền riêng, trỏ DNS theo hướng dẫn của Vercel.
6. Quay lại Supabase (bước 3.1) và cập nhật **Site URL / Redirect URLs** theo địa chỉ thật.

Mỗi lần `git push` lên `main`, Vercel tự deploy lại. Đổi biến môi trường thì phải **Redeploy** mới có hiệu lực.

### Bước 7. Nghiệm thu (thực hiện đủ trước khi dùng thật)

1. Mở địa chỉ web: thấy trang chủ OnPoint, không có cảnh báo "Chưa cấu hình Supabase".
2. Đăng nhập host → tạo quiz mới (thử tick 2 đáp án đúng, đổi điểm và thời gian) → **Lưu**.
3. Thử **Nhập từ CSV** bằng file `samples/onpoint-sample-quiz.csv`.
4. Bấm **Lưu & tổ chức**: thấy PIN lớn và mã QR.
5. Dùng **hai điện thoại thật** (một bằng Wi-Fi, một bằng 4G): quét QR, vào với hai biệt danh, thấy tên xuất hiện trên màn hình host.
6. Chơi đủ vài câu: kiểm tra đếm ngược, đáp án đúng, điểm, bảng xếp hạng, bục vinh quang.
7. Tải lại trang trên điện thoại giữa chừng: phải vào lại đúng trạng thái.
8. Kết thúc game, tải CSV kết quả và xem lại ở **Lịch sử game** trên trang host.
9. Mở DevTools → Network trên điện thoại hoặc máy tính, kiểm tra có kết nối **WebSocket** tới Supabase (xác nhận realtime hoạt động; nếu không có, game vẫn chạy bằng polling nhưng chậm hơn).

## 5. Chuẩn bị cho sự kiện lớn (1.000–5.000 người)

1. **Nâng gói Supabase** và kiểm tra hạn mức Realtime (xem bước 1). Với 5.000 người chơi cần hạn mức kết nối đồng thời tối thiểu 5.000 cộng thêm host.
2. **Nâng cấu hình compute của database** trước sự kiện (Settings → Compute and Disk), vì khoảnh khắc 5.000 người cùng gửi đáp án trong vài giây là điểm nghẽn. Hạ lại sau sự kiện.
3. **Chạy thử tải** trên project staging hoặc project thật (script tạo ra 1 game có tên bắt đầu bằng `[LOADTEST]`, nhớ xóa sau khi chạy):

```bash
SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=... \
HOST_EMAIL=host@congty.vn HOST_PASSWORD=... \
PLAYERS=2000 CONCURRENCY=150 node loadtest/simulate.mjs
```

   Mục tiêu: **0 lỗi và p95 dưới ~800 ms**. Script chỉ kiểm tra phần RPC/database qua HTTP, **không giả lập kết nối realtime**, nên vẫn cần buổi tổng duyệt với người thật (xem dưới).
4. **Tổng duyệt** với 30–50 người thật (đồng nghiệp) trên điện thoại, đúng địa điểm và Wi-Fi của sự kiện. Mạng Wi-Fi hội trường thường là điểm yếu số một: khuyến khích người chơi dùng 4G/5G nếu Wi-Fi yếu, và bố trí nhiều access point.
5. **Quy trình ngày diễn ra:** mở lobby sớm 10–15 phút, chiếu PIN + QR; chỉ bấm Bắt đầu khi số người vào ổn định; giữ một máy dự phòng đã đăng nhập host.
6. Nếu mạng chập chờn: người chơi sẽ tự kết nối lại, điện thoại hiện trạng thái "reconnecting" và vẫn nhận câu hỏi qua cơ chế polling dự phòng.

Kết quả đo trên database Postgres cục bộ khi phát triển (không phải Supabase, chỉ để tham khảo logic): 5.000 người vào phòng p95 khoảng 0,2 giây, 5.000 câu trả lời trong khoảng 2 giây, chấm điểm toàn bộ 5.000 người khi host chốt câu khoảng 0,25 giây. Hiệu năng thực tế trên Supabase phụ thuộc gói, compute và mạng, nên **phải tự đo bằng script ở trên**.

## 6. Vận hành và bảo trì

- **Dọn dữ liệu cũ** (xóa game cũ kèm người chơi và câu trả lời) trong SQL Editor:
  ```sql
  delete from public.games where created_at < now() - interval '180 days';
  ```
- **Backup:** bật Point-in-Time Recovery hoặc dùng backup hằng ngày của gói trả phí; có thể xuất dữ liệu bằng `pg_dump`.
- **Game bị bỏ quên** sẽ tự đóng khi host tạo game mới sau 12 giờ (giải phóng PIN). Host cũng có thể bấm "Dừng game".
- **Sửa quiz** khi game đang chạy không ảnh hưởng game đó, vì câu hỏi được chụp lại (snapshot) lúc tạo game.
- **Thay đổi schema sau này:** tạo file migration mới trong `supabase/migrations/` (đặt tên theo thời gian) rồi `npx supabase db push`, không sửa file đã chạy.

## 7. Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Trang chủ báo "Chưa cấu hình Supabase" | Thiếu hoặc sai biến môi trường | Kiểm tra `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` trên Vercel rồi Redeploy |
| Host đăng ký xong không vào được | Bật xác nhận email nhưng chưa có SMTP | Cấu hình SMTP, hoặc tạo host thủ công ở Authentication → Users |
| Link xác nhận email mở ra localhost | Site URL chưa cập nhật | Sửa Site URL và Redirect URLs (bước 3) |
| Người chơi báo "Không tìm thấy phòng" | Gõ sai PIN, hoặc game đã kết thúc | Kiểm tra PIN trên màn hình host |
| Câu hỏi đến chậm hoặc đến theo từng đợt | Realtime bị giới hạn kết nối hoặc mạng yếu, client đang dùng polling | Kiểm tra hạn mức Realtime, nâng gói, xem tab Network có WebSocket |
| Lỗi khi lưu quiz "Mỗi câu cần ít nhất một đáp án đúng" | Chưa tick đáp án đúng, hoặc đáp án được tick đang để trống | Điền nội dung đáp án và tick lại |
| Tải trang con (vd `/host`) báo 404 trên Vercel | Thiếu rewrite SPA | Giữ nguyên `vercel.json` trong repo |
| Chạy file SQL báo "already exists" | Đã chạy file trước đó | Xem bước 2 để làm lại từ đầu |

## 8. Cấu trúc thư mục

```
supabase/migrations/…_onquiz_v1_1.sql   toàn bộ backend (bảng, RLS, RPC, realtime)
src/lib/        supabase client, api, i18n (VI/EN), hook người chơi, CSV
src/pages/      Home, Join, Play, HostLogin, HostDashboard, QuizEditor, HostGame
src/components/ Shell, Logo, đếm ngược, bảng xếp hạng, bục vinh quang
public/brand/   logo và nền OnPoint
loadtest/       script thử tải
samples/        file CSV mẫu
```

## 9. Lưu ý bảo mật và quyền riêng tư

- Người chơi chỉ nhập biệt danh; hệ thống không thu thập email hay số điện thoại của người chơi. Dữ liệu game được lưu trong database cho tới khi bạn xóa (xem mục 6).
- Mọi bảng đều bật RLS: host chỉ thấy quiz và game của chính mình. Người chơi không có quyền đọc bảng nào.
- Khi xuất CSV, các biệt danh bắt đầu bằng `= + - @` được vô hiệu hóa để tránh chèn công thức Excel.
- Nên đặt mật khẩu host mạnh và tắt đăng ký công khai khi dùng nội bộ.
- Logo và hình nền OnPoint trong `public/brand/` là tài sản thương hiệu của OnPoint, chỉ dùng cho các sản phẩm của OnPoint.

---

## Quick start (English)

1. Create a Supabase project, run `supabase/migrations/20261109000001_onquiz_v1_1.sql` in the SQL Editor.
2. Authentication → URL Configuration: set Site URL and Redirect URLs; create host users (Authentication → Users) or enable sign-up with SMTP.
3. Push this repo to GitHub, import it in Vercel (Vite preset), set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (+ `VITE_ENABLE_SIGNUP`, `VITE_ENABLE_GOOGLE`), deploy.
4. Before a large event: upgrade the Supabase plan and check the Realtime concurrent-connection limit, raise database compute, run `loadtest/simulate.mjs`, and rehearse with real phones on the venue network.
