# auto-social-networks

`fb-digest` lướt trang chủ Facebook, hoặc các trang và nhóm bạn chọn, thay bạn, rồi gửi lên Telegram những bài đáng đọc.

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

Quảng cáo trả tiền bị bỏ ngay lúc thu bài; bài bán hàng còn lại được LLM gắn cờ `is_ad` và loại khỏi digest. Bài gợi ý từ các trang bạn chưa theo dõi vẫn được giữ và chấm điểm theo nội dung.

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
fb-digest manage     # mở trang quản lý: quét bài theo trang/nhóm, dọn bạn bè/trang/nhóm
```

Nếu không activate conda env, gọi thẳng `~/.conda/envs/.env-auto-social-networks/bin/fb-digest`.

Mỗi bài chỉ được gửi một lần. Một lượt với 30 bài mất khoảng 6 phút: khoảng 3,5 phút thu bài và khoảng 2,5 phút chấm điểm (khoảng 5 giây mỗi bài với `antigravity/claude-sonnet-5`).

## Trang quản lý

`fb-digest manage` mở trang web tại `http://127.0.0.1:8765/`, chỉ truy cập được từ máy này. Trang có 4 tab:

| Tab | Nội dung | Lọc | Thao tác |
|---|---|---|---|
| Bài viết | Bài từ các nguồn đã chọn, mới nhất trước: thời gian, nguồn, điểm, tóm tắt, link | Chỉ bài mới quét, chỉ bài từ nguồn, điểm ≥ N, nguồn, ẩn quảng cáo | Quét ngay, có thể kèm gửi digest Telegram |
| Bạn bè | Ảnh, tên, trạng thái, bạn chung, giới tính | Chỉ tài khoản đã khóa, bạn chung ≤ N, giới tính | Hủy kết bạn |
| Trang | Ảnh, tên, loại trang, đã thích, xác minh | Chỉ nguồn quét, loại trang | Bỏ theo dõi, chọn làm nguồn quét |
| Nhóm | Ảnh, tên, lần bạn vào cuối, bài mới nhất, quản trị, đã bỏ theo dõi, đã tắt thông báo | Chỉ nguồn quét, không vào ≥ N ngày, không có bài mới ≥ N ngày | Rời nhóm, bỏ theo dõi, tắt thông báo, chọn làm nguồn quét |

Bấm "Làm mới" để tải danh sách từ Facebook (vài giây với trang, khoảng 30 giây với bạn bè hoặc nhóm). Kết quả được lưu ở `data/manage/`. Nút gạt "Thao tác" ở góc phải chọn giữa nút ngay trên từng dòng và chế độ chọn nhiều dòng rồi làm một lần. "Xuất CSV" xuất các dòng đang chọn, hoặc toàn bộ dòng đang hiển thị nếu chưa chọn dòng nào.

### Quét bài theo trang, nhóm

1. Ở tab Trang hoặc Nhóm, bấm ☆ để chọn nguồn. Danh sách nguồn được lưu ở `data/manage/sources.json`.
2. Ở tab Bài viết (trang mở ra mặc định), bấm "Quét ngay". Bot lấy các bài đăng trong 2 ngày gần nhất của từng nguồn (đổi bằng `SOURCE_DAYS`), lưu vào bảng `fb_posts` trong Postgres, chấm điểm bằng LLM, và gửi digest Telegram nếu bạn tick "Gửi digest Telegram".

Tab Bài viết mặc định chỉ hiển thị những bài mà lượt quét gần nhất mới thu được, mới nhất trước; lượt đó có thể là nút "Quét ngay" hoặc `fb-digest run`. Quét xong, bộ lọc "Chỉ bài mới quét" tự bật lại. Bỏ tick để xem toàn bộ bài đã lưu. Bộ lọc bạn điền (ví dụ "Điểm ≥") được nhớ cho lần mở sau. Nút "Bỏ qua" trên mỗi dòng ẩn bài đó (lưu ở cột `skipped_at`) và loại nó khỏi digest Telegram; bỏ tick "Ẩn bài đã bỏ qua" để xem lại và bấm "Hiện lại". Bài trùng không được lưu lại: trùng nội dung, hoặc trùng link khi tác giả sửa bài.

Khi đã có nguồn, `fb-digest run` (kể cả khi timer chạy) cũng quét các nguồn này thay cho feed. Bỏ hết ☆ thì bot quay lại lướt feed như trước.

Bot quét 4 nguồn cùng lúc bằng cách gọi thẳng API lấy bài của nhóm/trang, không mở từng trang, nên mỗi nguồn chỉ mất vài giây. Lần đầu, một nguồn của mỗi loại (nhóm, trang) được mở và cuộn như người thật để học mẫu request, lưu ở `data/manage/feed_queries.json`. Nếu Facebook đổi API, nguồn đó tự quay về cách mở trang và bot học lại mẫu mới.

Thời gian đăng lấy từ dữ liệu JSON mà Facebook gửi về trang (`creation_time`), nên bài được sắp xếp đúng theo giờ đăng. Bài lấy từ feed không có giờ đăng chính xác; bỏ tick "Chỉ bài từ nguồn đã chọn" để xem cả những bài đó, xếp theo giờ thu bài.

### Lưu ý

- **Tài khoản đã khóa:** là bạn bè vẫn có trong danh sách trên trang cá nhân nhưng Facebook không trả về trong danh sách bạn bè đang hoạt động.
- **Thao tác:** chạy lần lượt, mỗi thao tác cách nhau 3–7 giây, và tự dừng ở lỗi đầu tiên vì lỗi thường là do Facebook đang hạn chế tài khoản. Hủy kết bạn, bỏ theo dõi trang và rời nhóm không hoàn tác được. Bỏ theo dõi nhóm (vẫn là thành viên nhưng không thấy bài trên bảng feed) và tắt thông báo nhóm (tắt cả thông báo trong Facebook lẫn thông báo đẩy) giữ nhóm trong danh sách và đánh dấu ✓ ở cột tương ứng; Facebook không cho biết trạng thái này khi tải danh sách, nên cột chỉ ghi những gì đã làm từ trang quản lý. Muốn bật lại thì làm trên Facebook. Nên xử lý vài chục mục mỗi lần, đừng xử lý cả trăm mục liền. Rời nhóm hoặc bỏ theo dõi một nguồn quét cũng bỏ nó khỏi danh sách nguồn.
- **Bỏ theo dõi trang:** trang không còn hiện trên feed, nhưng lượt thích trang (nếu có) vẫn giữ nguyên.
- **Chạy cùng lệnh khác:** trang quản lý dùng chung profile Chrome với bot. Khi đang mở trang quản lý, hãy quét bằng nút "Quét ngay" thay vì `fb-digest run`, và tắt trang quản lý (Ctrl+C) trước giờ timer chạy.

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
| `FEED_URL` | `https://www.facebook.com/` | Trang chủ; `/?filter=all&sk=h_chr` là tab Bảng feed: chỉ bạn bè, nhóm và trang bạn theo dõi, xếp theo thời gian, không có bài gợi ý |
| `MAX_POSTS` | `60` | Dừng khi thu đủ số bài này |
| `SCROLL_ROUNDS` | `60` | Số vòng cuộn tối đa; bot cũng dừng sau 8 vòng liền không có bài mới |
| `SCROLL_DELAY_MIN` / `SCROLL_DELAY_MAX` | `1` / `2.5` | Thời gian chờ ngẫu nhiên giữa các lần cuộn (giây) |
| `MIN_POSTS` | `5` | Lướt feed mà thu ít hơn số này thì gửi cảnh báo (quét nguồn chỉ cảnh báo khi không có bài nào) |
| `SCORE_BATCH_SIZE` | `8` | Số bài gửi cho LLM mỗi lần |
| `LLM_CONCURRENCY` | `4` | Số lô bài gửi cho LLM cùng lúc khi chấm điểm |
| `SCORE_THRESHOLD` | `7` | Điểm tối thiểu để bài vào digest |
| `INTERESTS_FILE` | `interests.txt` | Mô tả sở thích mà LLM dùng để chấm điểm |
| `SOURCE_DAYS` | `2` | Khi quét trang/nhóm đã chọn, chỉ lấy bài đăng trong số ngày gần nhất này (tính lùi từ lúc quét) |

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

- **Nhận diện quảng cáo:** Facebook làm rối nhãn "Được tài trợ" nên chữ này gần như không có trong innerText. Thay vào đó, ở chỗ thời gian đăng bài, quảng cáo chỉ có một dòng chứa ký tự WORD JOINER (U+2060). `collector.js` bỏ các bài này trước khi lưu. Nếu Facebook đổi cách hiển thị, quảng cáo vẫn bị LLM bắt qua `is_ad`.
- **API của trang quản lý:** [fb_digest/account.py](fb_digest/account.py) gọi API GraphQL nội bộ của Facebook bằng `fetch()` từ bên trong tab facebook.com đã đăng nhập, giống cách web Facebook gọi, nên dùng đúng phiên và token thật. Các `doc_id` được ghi lại từ web Facebook. Khi Facebook đổi `doc_id`, thao tác sẽ báo lỗi kèm tên API; lấy `doc_id` mới trong tab Network của DevTools rồi sửa hằng số tương ứng ở đầu file.
- **Lọc trùng:** mỗi lượt, văn bản của bài có thể khác đi (thời gian tương đối, số like). Vì vậy khóa của bài là hash của các dòng dài nhất sau khi bỏ chữ số, tức phần thân bài.
- **Đóng Chrome:** `stop()` của zendriver luôn SIGKILL Chrome sau 3 giây, làm mất cookie chưa kịp ghi. Bot tự đóng Chrome một cách từ tốn trước khi gọi `stop()`; xem `_close()` trong `collector.py`.
- **Cửa sổ 1280×1400:** cửa sổ mặc định chỉ khoảng 800×600, khiến mỗi lần cuộn chưa qua hết một bài.
- **LLM sau Cloudflare:** request có User-Agent riêng, vì UA mặc định `Python-urllib` bị Cloudflare trả 403.
- **Router trả stream:** router tại `localhost:20128` trả SSE nếu không có `"stream": false`, nên scorer luôn gửi tham số này.
- **Schema nằm trong prompt, không dùng `response_format`:** router chuyển `response_format` thành tool call cho Claude, và Claude trả `items` thành chuỗi JSON với dấu ngoặc kép không được escape. Router còn cache cả phản hồi hỏng đó, nên chạy lại cũng không khỏi.
- **Giấy phép:** zendriver dùng AGPL-3.0. Dùng cá nhân thì không sao, nhưng cần lưu ý nếu phân phối lại.
- **Điều khoản Facebook:** tự động hóa tài khoản thật là vi phạm điều khoản của Facebook. Hãy giữ tần suất thấp: vài lượt mỗi ngày, cuộn như người thật.
