# auto-social-networks

`fb-digest` lướt trang chủ Facebook thay bạn, rồi gửi lên Telegram những bài đáng đọc.

Bot mở Chrome thật với một profile riêng đã đăng nhập, cuộn feed như người thật và lấy nguyên văn bản của từng bài. Việc nhận ra tác giả, quảng cáo hay chủ đề được giao hết cho một LLM qua API tương thích OpenAI (mặc định là router cục bộ tại `localhost:20128`). Nhờ vậy, khi Facebook đổi giao diện, code gần như không phải sửa.

```
Chrome (zendriver, profile riêng, cửa sổ thu nhỏ)
  │  cuộn trang chủ, bấm "Xem thêm", lấy innerText + link từng bài    fb_digest/collector.js
  ▼
Postgres  fb_posts / fb_runs      lọc trùng giữa các lượt chạy         fb_digest/store.py
  ▼
LLM /v1/chat/completions + schema is_ad, author, summary, score 0-10   fb_digest/scorer.py
  ▼
Telegram                          digest bài score ≥ ngưỡng, cảnh báo   fb_digest/telegram.py
```

Bài quảng cáo bị loại khỏi digest. Bài gợi ý từ các trang bạn chưa theo dõi vẫn được giữ và chấm điểm theo nội dung.

## Yêu cầu

- Linux có Google Chrome (hoặc Brave/Edge)
- Conda env `.env-auto-social-networks` (Python ≥ 3.11)
- Một database Postgres
- Một endpoint LLM tương thích OpenAI (`/v1/chat/completions` có hỗ trợ `response_format` JSON schema), mặc định là router tại `http://localhost:20128/v1` với model `antigravity/claude-sonnet-5`. Ollama cũng dùng được qua `http://<host>:11434/v1`.
- Một bot Telegram, không bắt buộc. Nếu chưa có, digest được in ra terminal.

## Cài đặt

```bash
conda activate .env-auto-social-networks
pip install -e .
```

1. Tạo `.env` ở thư mục gốc. Tối thiểu cần `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID`; các biến khác xem mục [Cấu hình](#cấu-hình-env).
2. Viết `interests.txt` gồm những chủ đề bạn muốn đọc và không muốn đọc. Xem mục [Chỉnh chất lượng digest](#chỉnh-chất-lượng-digest).
3. Chạy `fb-digest login` để đăng nhập Facebook một lần.

### Đăng nhập Facebook

`fb-digest login` mở một cửa sổ Chrome dùng profile riêng tại `data/browser-profile/`. Bạn đăng nhập trong cửa sổ đó, kể cả bước xác minh 2 bước, và nên chọn **"Tin cậy thiết bị này"**. Đừng đóng cửa sổ bằng tay: khi thấy cookie đăng nhập, bot tự đóng nó và lưu phiên. Bot chờ tối đa 15 phút.

Bot không dùng lại được phiên Facebook trong Chrome hay Brave thường ngày của bạn. Từ bản 136, Chromium chặn điều khiển tự động (`--remote-debugging-port`) trên profile mặc định, nên bot bắt buộc phải có profile riêng.

`data/browser-profile/` chứa cookie đăng nhập Facebook. Đừng chia sẻ hay commit thư mục này; nó đã có trong `.gitignore`.

### Lấy Telegram chat ID

Nhắn một tin bất kỳ cho bot, hoặc thêm bot vào nhóm rồi nhắn trong nhóm. Sau đó mở `https://api.telegram.org/bot<TOKEN>/getUpdates` và tìm giá trị `"chat":{"id": ...}`. Chat ID của nhóm là số âm.

## Sử dụng

```bash
fb-digest            # = fb-digest run: thu bài → chấm điểm → gửi digest
fb-digest collect    # chỉ thu bài
fb-digest score      # chấm các bài chưa có điểm
fb-digest digest     # gửi các bài đủ điểm mà chưa gửi
fb-digest login      # đăng nhập lại khi nhận cảnh báo hết session/checkpoint
```

Nếu không activate conda env, gọi thẳng `~/.conda/envs/.env-auto-social-networks/bin/fb-digest`.

Mỗi bài chỉ được gửi một lần. Một lượt với 30 bài mất khoảng 6 phút: khoảng 3,5 phút thu bài và khoảng 2,5 phút chấm điểm (khoảng 5 giây mỗi bài với `antigravity/claude-sonnet-5`).

## Chạy tự động

```bash
mkdir -p ~/.config/systemd/user
cp deploy/fb-digest.service deploy/fb-digest.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fb-digest.timer
systemctl --user list-timers fb-digest.timer   # lần chạy kế tiếp
journalctl --user -u fb-digest -f              # log
```

Timer chạy lúc 8h, 13h và 20h, mỗi lần lệch ngẫu nhiên tối đa 30 phút. Nếu đến giờ mà máy đang tắt, lượt đó được chạy bù khi máy bật lại.

Chế độ có giao diện, kể cả khi thu nhỏ, cần `DISPLAY`/`WAYLAND_DISPLAY` của phiên desktop. Hầu hết desktop tự export các biến này cho systemd user. Trên máy không có desktop, đặt `HEADLESS=true` hoặc dùng dòng `xvfb-run` ghi trong file service.

## Cấu hình (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | bắt buộc | Chuỗi kết nối Postgres; bảng được tạo tự động ở lần chạy đầu |
| `LLM_URL` / `LLM_MODEL` | `http://localhost:20128/v1` / `antigravity/claude-sonnet-5` | Base URL tương thích OpenAI và model dùng để chấm điểm |
| `LLM_TIMEOUT` | `600` | Timeout mỗi request (giây) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | trống | Để trống thì digest được in ra stdout |
| `BROWSER` / `BROWSER_PATH` | `auto` / trống | `chrome`, `brave`, `msedge`; có thể trỏ thẳng tới file chạy |
| `HEADLESS` | `false` | `true` để chạy không giao diện (đã chạy được với Facebook) |
| `MINIMIZED` | `false` | `true` để thu nhỏ cửa sổ ngay khi mở (khi `HEADLESS=false`) |
| `FEED_URL` | `https://www.facebook.com/` | Trang chủ; `/?filter=all&sk=h_chr` là feed "Mới nhất" |
| `MAX_POSTS` | `60` | Dừng khi thu đủ số bài này |
| `SCROLL_ROUNDS` | `60` | Số vòng cuộn tối đa; bot cũng dừng sau 8 vòng liền không có bài mới |
| `SCROLL_DELAY_MIN` / `SCROLL_DELAY_MAX` | `1` / `2.5` | Thời gian chờ ngẫu nhiên giữa các lần cuộn (giây) |
| `MIN_POSTS` | `5` | Thu ít hơn số này thì gửi cảnh báo |
| `SCORE_BATCH_SIZE` | `8` | Số bài gửi cho LLM mỗi lần |
| `SCORE_THRESHOLD` | `7` | Điểm tối thiểu để bài vào digest |
| `INTERESTS_FILE` | `interests.txt` | Mô tả sở thích mà LLM dùng để chấm điểm |

## Chỉnh chất lượng digest

LLM chấm điểm hoàn toàn dựa vào `interests.txt`. Càng viết cụ thể thì kết quả càng sát: "AI: model mới, tool mã nguồn mở, kỹ thuật RAG/agent" cho kết quả tốt hơn nhiều so với chỉ ghi "AI". Nên liệt kê cả những gì bạn không muốn đọc.

Nếu digest vẫn còn nhiều bài thừa, thử lần lượt các cách sau:
1. Nâng `SCORE_THRESHOLD` lên 8.
2. Đổi `LLM_MODEL`; xem danh sách tại `http://localhost:20128/v1/models`. Nên ghim một model cụ thể: combo như `auto/claude-sonnet` khi lỗi sẽ rơi xuống cả model yếu hơn (Haiku, Llama), làm điểm dao động giữa các lượt.
3. Sửa thang điểm trong `SYSTEM_PROMPT` tại [fb_digest/scorer.py](fb_digest/scorer.py).

## Cảnh báo qua Telegram

| Cảnh báo | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Facebook yêu cầu đăng nhập/checkpoint | Phiên hết hạn hoặc Facebook nghi ngờ | `fb-digest login` |
| Chỉ thu được N bài | Facebook đổi DOM, hoặc feed không tải thêm khi cuộn | Xem các selector ở đầu `fb_digest/collector.js`; thử `HEADLESS=false` |
| Thu bài lỗi / Chấm điểm lỗi | Chrome bị đóng, endpoint LLM không phản hồi | Xem `journalctl --user -u fb-digest` |
| Không kết nối được Postgres | Sai `DATABASE_URL` hoặc server tắt | Kiểm tra DB |

## Ghi chú kỹ thuật

- **Lọc trùng:** mỗi lượt, văn bản của bài có thể khác đi (thời gian tương đối, số like). Vì vậy khóa của bài là hash của các dòng dài nhất sau khi bỏ chữ số, tức phần thân bài.
- **Đóng Chrome:** `stop()` của zendriver luôn SIGKILL Chrome sau 3 giây, làm mất cookie chưa kịp ghi. Bot tự đóng Chrome một cách từ tốn trước khi gọi `stop()`; xem `_close()` trong `collector.py`.
- **Cửa sổ 1280×1400:** cửa sổ mặc định chỉ khoảng 800×600, khiến mỗi lần cuộn chưa qua hết một bài.
- **LLM sau Cloudflare:** request có User-Agent riêng, vì UA mặc định `Python-urllib` bị Cloudflare trả 403.
- **Router trả stream:** router tại `localhost:20128` trả SSE nếu không có `"stream": false`, nên scorer luôn gửi tham số này.
- **Schema nằm trong prompt, không dùng `response_format`:** router chuyển `response_format` thành tool call cho Claude, và Claude trả `items` thành chuỗi JSON với dấu ngoặc kép không được escape. Router còn cache cả phản hồi hỏng đó, nên chạy lại cũng không khỏi.
- **Giấy phép:** zendriver dùng AGPL-3.0. Dùng cá nhân thì không sao, nhưng cần lưu ý nếu phân phối lại.
- **Điều khoản Facebook:** tự động hóa tài khoản thật là vi phạm điều khoản của Facebook. Hãy giữ tần suất thấp: vài lượt mỗi ngày, cuộn như người thật.
