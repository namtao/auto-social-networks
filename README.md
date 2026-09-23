# auto-social-networks

`fb-digest` lướt trang chủ Facebook thay bạn, rồi gửi lên Telegram những bài đáng đọc.

Bot mở Chrome thật với một profile riêng đã đăng nhập, cuộn feed như người thật và lấy nguyên văn bản của từng bài. Việc nhận ra tác giả, quảng cáo hay chủ đề được giao hết cho một LLM chạy trên Ollama. Nhờ vậy, khi Facebook đổi giao diện, code gần như không phải sửa.

```
Chrome (zendriver, profile riêng, cửa sổ thu nhỏ)
  │  cuộn trang chủ, bấm "Xem thêm", lấy innerText + link từng bài    fb_digest/collector.js
  ▼
Postgres  fb_posts / fb_runs      lọc trùng giữa các lượt chạy         fb_digest/store.py
  ▼
Ollama /api/chat + JSON schema    is_ad, author, summary, score 0-10   fb_digest/scorer.py
  ▼
Telegram                          digest bài score ≥ ngưỡng, cảnh báo   fb_digest/telegram.py
```

Bài quảng cáo bị loại khỏi digest. Bài gợi ý từ các trang bạn chưa theo dõi vẫn được giữ và chấm điểm theo nội dung.

## Yêu cầu

- Linux có Google Chrome (hoặc Brave/Edge)
- Conda env `.env-auto-social-networks` (Python ≥ 3.11)
- Một database Postgres
- Server Ollama, mặc định là `https://ollama.namtao.dpdns.org` với model `qwen3:14b`
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

Mỗi bài chỉ được gửi một lần. Một lượt với 30 bài mất khoảng 7–8 phút: khoảng 3,5 phút thu bài và khoảng 4 phút chấm điểm (khoảng 9 giây mỗi bài với `qwen3:14b`).

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
| `OLLAMA_URL` / `OLLAMA_MODEL` | `https://ollama.namtao.dpdns.org` / `qwen3:14b` | Server và model dùng để chấm điểm |
| `OLLAMA_NUM_CTX` / `OLLAMA_TIMEOUT` | `32768` / `600` | Context window (token) và timeout mỗi request (giây) |
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
2. Thử `OLLAMA_MODEL=gemma4:26b`. Model này lớn hơn, có thể bám thang điểm sát hơn nhưng chậm hơn.
3. Sửa thang điểm trong `SYSTEM_PROMPT` tại [fb_digest/scorer.py](fb_digest/scorer.py).

## Cảnh báo qua Telegram

| Cảnh báo | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Facebook yêu cầu đăng nhập/checkpoint | Phiên hết hạn hoặc Facebook nghi ngờ | `fb-digest login` |
| Chỉ thu được N bài | Facebook đổi DOM, hoặc feed không tải thêm khi cuộn | Xem các selector ở đầu `fb_digest/collector.js`; thử `HEADLESS=false` |
| Thu bài lỗi / Chấm điểm lỗi | Chrome bị đóng, Ollama không phản hồi | Xem `journalctl --user -u fb-digest` |
| Không kết nối được Postgres | Sai `DATABASE_URL` hoặc server tắt | Kiểm tra DB |

## Ghi chú kỹ thuật

- **Lọc trùng:** mỗi lượt, văn bản của bài có thể khác đi (thời gian tương đối, số like). Vì vậy khóa của bài là hash của các dòng dài nhất sau khi bỏ chữ số, tức phần thân bài.
- **Đóng Chrome:** `stop()` của zendriver luôn SIGKILL Chrome sau 3 giây, làm mất cookie chưa kịp ghi. Bot tự đóng Chrome một cách từ tốn trước khi gọi `stop()`; xem `_close()` trong `collector.py`.
- **Cửa sổ 1280×1400:** cửa sổ mặc định chỉ khoảng 800×600, khiến mỗi lần cuộn chưa qua hết một bài.
- **Ollama sau Cloudflare:** request phải có User-Agent riêng, vì UA mặc định `Python-urllib` bị trả 403.
- **Giấy phép:** zendriver dùng AGPL-3.0. Dùng cá nhân thì không sao, nhưng cần lưu ý nếu phân phối lại.
- **Điều khoản Facebook:** tự động hóa tài khoản thật là vi phạm điều khoản của Facebook. Hãy giữ tần suất thấp: vài lượt mỗi ngày, cuộn như người thật.
