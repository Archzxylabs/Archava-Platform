# Batas percakapan dan akses

| Lapisan | Perilaku |
| --- | --- |
| Prompt | Identitas host tetap, jawab dari fakta, bedakan verified/planned/unavailable, tidak mengklaim aksi bisnis yang tidak memiliki tool. |
| Knowledge | Hanya topic yang ada di konfigurasi operator. Unknown topic tidak dibaca sebagai instruksi baru. |
| Tool | Tiga tool: baca fakta, baca section terakhir, minta scroll. Tidak ada shell, browsing, arbitrary URL, CRM, booking, atau akses data pelanggan. |
| Browser → worker | Maksimal 128 byte; hanya `{section, revision}`; section allowlist; revision integer nonnegatif, monotonik, dan aman untuk JavaScript. Identitas harus sama dengan guest di metadata room. |
| Worker → browser | Browser menerima navigation/ack hanya dari participant agent. Ack tepat section+revision; data tambahan ditolak. Navigation hanya menuju ID section yang dikonfigurasi. |
| HTTP | Origin exact allowlist, body maksimal 4096 byte, malformed JSON ditolak, start hanya menerima `{}`. Tidak ada prompt, provider, roomName, identity, atau knowledge dari request. |
| LiveKit token | Dibuat server-side, room tertentu, identity guest acak, maksimal 300 detik untuk join, publish microphone/data dan subscribe saja. Tidak ada room-admin atau room-create grant. |
| Penutupan sesi | Ticket opaque 256-bit untuk end, idempotent, batas waktu di metadata LiveKit, sweep API tiap 10 detik, dan deadline worker. |
| Proyek | Room metadata memakai product dan `PROJECT_ID`. Sweeper tidak menyentuh room proyek lain; worker menolak konteks proyek/provider yang tidak sesuai. |
| Biaya | Sesi off secara default, batas waktu, kapasitas aktif, dan pembatasan percobaan start per IP. Percobaan gagal tetap dihitung untuk mencegah retry tak terbatas. |

Prompt membantu mengarahkan model, tetapi tidak menjamin seluruh jawaban bebas halusinasi atau seluruh prompt injection ditolak. Batas tool, schema, token, identitas, dan navigasi ditegakkan kode. Tambahkan verifikasi live terhadap pertanyaan bisnis dan adversarial prompts sebelum release.

Template menawarkan **public anonymous sessions**. Origin allowlist adalah aturan browser/CORS, bukan autentikasi; klien non-browser bisa tidak mengirim Origin. Untuk host privat, tambahkan verifikasi login pada API sebelum memanggil `sessions.start()`. Jangan meletakkan secret statis di frontend. Billing atau akses pelanggan perlu lapisan non-chain baru yang sesuai kebutuhan bisnis; template tidak mengaku sudah menyediakannya.

Gunakan satu API replica. Ticket, kuota concurrency, dan rate bucket berada di memory proses. Setelah restart, ticket lama tidak bisa menutup sesi lebih awal; expiry tetap di metadata LiveKit dan dipulihkan sweeper. Worker juga menghapus room saat deadline. Kalau API serta worker sama-sama offline, pengguna yang telah join bisa tetap berada di room sampai cleanup berjalan kembali; token expiry membatasi join, tidak mengusir participant yang sudah terhubung.

Untuk beberapa API replica, pindahkan admission/ticket ke shared transactional store dan gunakan webhook LiveKit untuk settlement/cleanup. Default `TRUST_PROXY=false` memakai IP socket. Di reverse proxy semua pengunjung bisa berbagi IP; aktifkan `TRUST_PROXY=true` hanya ketika edge yang kamu kontrol **menimpa** `X-Forwarded-For` dan tidak membiarkan akses langsung melewati edge. Kalau tidak, gunakan rate limiting di edge. Jangan mempercayai forwarded header dari internet langsung.

Gunakan `PROJECT_ID` dan agentName berbeda antara dev, staging, dan production. Jangan memakai ID yang sama untuk proyek berbeda dalam LiveKit yang sama. Hentikan semua proses dengan graceful shutdown; single-container entrypoint menutup sibling ketika salah satu proses gagal.

`config/project.json`, frontend, dan public asset ikut masuk bundle dan arsip. Simpan hanya konten yang boleh dilihat publik. Kredensial LiveKit, Gemini, Spatius, dan Tavus tetap di environment API/worker. Provider error tidak diteruskan ke browser.
