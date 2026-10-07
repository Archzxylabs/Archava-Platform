# Pemasangan dari nol

Pilih jalur lokal untuk mengubah dan memeriksa proyek. Setelah itu gunakan [DEPLOYMENT.md](DEPLOYMENT.md) untuk Vercel + Railway atau Docker/VPS. Frontend saja bisa dilihat tanpa kredensial, tetapi percakapan memerlukan LiveKit, Gemini, dan worker yang berjalan.

## Prasyarat

- Node 22.18+ beserta npm; periksa `node --version` dan `npm --version`. Gunakan versi Node yang sama pada lokal dan build hosting.
- Python 3.12 atau 3.13 beserta modul `venv`/pip untuk worker lokal. Periksa `python3.12 --version`; ganti perintah menjadi `python3.13` jika itu versi yang dipasang.
- `tar` untuk export/ekstraksi, Git bila memakai repo, serta akses internet untuk dependency dan provider.
- Untuk Docker, pasang Docker Engine/Desktop dan Compose v2. `docker info` harus berhasil; `docker compose version` harus tersedia. Image menyediakan Node, Python, dan library audio sehingga tidak perlu venv host.
- Browser dengan microphone dan dukungan renderer. Untuk Spatius, cek dukungan `RTCRtpScriptTransform`; mode voice bisa dipakai untuk memisahkan masalah renderer dari masalah audio.

Perintah menggunakan shell Linux/macOS. Di Windows gunakan WSL2 untuk menjalankan resep ini. Untuk worker tanpa Docker di Debian/Ubuntu, pasang library yang juga disediakan Dockerfile:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates libopus0 ffmpeg libstdc++6
```

Jika Python mengeluhkan `ensurepip`/`venv`, pasang paket venv yang cocok dengan Python-mu, misalnya `python3.12-venv`. Di macOS, library audio dapat dipasang dengan `brew install opus ffmpeg`. Binary Python/Node dan Docker harus sudah dipasang sesuai sistem operasi sebelum mengikuti setup.

## Ekstrak atau copy

Copy seluruh source template, termasuk dotfile contoh, ke lokasi baru. Jangan hanya mengambil `src`: API, worker, config, prompt, dan asset ikut diperlukan. Untuk client gunakan arsip export agar `.env` kerja milik pribadi tidak ikut terbawa.

Jika menerima arsip export, ganti path contoh berikut dengan lokasi arsip yang sebenarnya. Ekstrak ke folder baru yang kosong; arsip berisi file proyek langsung, tanpa folder pembungkus:

```bash
mkdir -p "$HOME/Projects/Archava Baru"
tar -xzf "/path/archava-template.tar.gz" -C "$HOME/Projects/Archava Baru"
cd "$HOME/Projects/Archava Baru"
npm ci
npm run setup -- --project hotel-demo --brand "Hotel Demo" --host "Maya" --language "Bahasa Indonesia"
```

Jika memakai folder di repo Archava, masuk dulu dengan `cd "Archava Template"`, lalu jalankan dua perintah npm di atas. Semua perintah berikut dijalankan dari root template yang memiliki `package.json`.

`setup` membuat `.env` dan menyiapkan nama proyek. Edit knowledge contoh sebelum digunakan. Menjalankan kembali `setup --project ...` mengatur `PROJECT_ID` lokal menjadi `<projectId>-dev` dan mengosongkan custom `ARCHAVA_AGENT_NAME`; bila memakai file itu untuk production, sesuaikan lagi namespace production setelah setup. Kredensial yang sudah ada tidak ditimpa.

Untuk proyek pribadi dengan key yang sudah disimpan, ganti command setup menjadi `npm run setup:personal -- --project hotel-demo ...`. Untuk client gunakan `npm run setup:client -- --project hotel-demo ...`. Profil eksplisit menolak mengganti `.env` yang sudah ada tanpa `--force`; lihat [ENV_PROFILES.md](ENV_PROFILES.md) untuk penyimpanan profil dan pergantian env. Setup biasa/default tetap jalur client kosong pada folder baru dan mempertahankan env pada folder yang sudah disiapkan.

## Kredensial dan environment

Isi `.env` lewat editor. Pertahankan `ENABLE_SESSIONS=false` selama setup. Semua key di bawah ditempatkan pada API dan worker, atau pada service gabungan; frontend Vercel hanya membutuhkan URL backend publik.

| Variable | Cara mendapat/mengisinya | Kapan diperlukan |
| --- | --- | --- |
| `LIVEKIT_URL` | Project URL `wss://...` dari project LiveKit Cloud. | Semua provider. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Pasangan key/secret dari project LiveKit yang sama. | Semua provider; simpan hanya di server. |
| `GEMINI_API_KEY` | Buat key proyek di Google AI Studio. | Semua provider. |
| `GEMINI_MODEL`, `GEMINI_VOICE` | Default mengikuti Archava; pastikan akses native audio Live, model, dan kuota tersedia di akun. | Semua provider. |
| `AVATAR_PROVIDER` | `spatius`, `tavus`, atau `voice`. | Pilih satu dan samakan API/worker. |
| `SPATIUS_API_KEY`, `SPATIUS_APP_ID` | Buat/pilih App di dashboard Spatius Apps, lalu ambil API Key dan App ID. | Spatius. |
| `SPATIUS_AVATAR_ID` | Pilih avatar dan copy ID dari Spatius Avatar Library. | Spatius. |
| `TAVUS_API_KEY`, `FACE_ID` | API key Tavus dan ID face yang dapat digunakan akun tersebut. | Tavus. |
| `PAL_ID` | Opsional: PAL untuk LiveKit dengan pipeline `echo` dan transport `livekit`; kosong memakai default plugin. | Tavus. |
| `PROJECT_ID` | Slug unik per proyek/environment, misalnya `hotel-demo-dev` atau `hotel-demo-prod`. | API dan worker harus sama. |
| `ARCHAVA_AGENT_NAME` | Kosong memakai `<PROJECT_ID>-host`; custom name harus sama pada API/worker. | Named dispatch. |
| `PORT` | Lokal default `5002`; hosting dapat menyuplai port sendiri. | API. |
| `WEB_ORIGIN` | Origin frontend persis, misalnya `http://localhost:5174`; tanpa path/trailing slash. | API CORS. |
| `VITE_API_BASE_URL` | Kosong untuk lokal/satu host; URL HTTPS backend publik untuk frontend terpisah. | Frontend saat build. |
| `ENABLE_SESSIONS` | `false` selama setup, `true` setelah siap melakukan uji live. | API admission. |
| `SESSION_SECONDS`, `MAX_ACTIVE_SESSIONS`, `SESSION_STARTS_PER_MINUTE` | Default `120`, `10`, `3`; durasi didukung 30–1800 detik. | API admission/expiry. |
| `TRUST_PROXY` | Default `false`; lihat deployment untuk proxy yang menimpa header client IP. | API rate limit. |

Sumber resmi: [LiveKit CLI/project URL](https://docs.livekit.io/reference/developer-tools/livekit-cli/) dan [pasangan project credentials](https://docs.livekit.io/reference/developer-tools/livekit-cli/projects/), [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key), [Spatius Apps/Avatar Library](https://docs.spatius.ai/livekit-agents/server), serta [Tavus face/PAL dan authentication](https://docs.livekit.io/agents/models/avatar/plugins/tavus/). Template memakai SDK yang dipin di `backend/requirements.txt`; gunakan requirements tersebut untuk memasang, jangan mengganti versinya dengan contoh terbaru di dokumentasi provider tanpa menguji ulang.

LiveKit API key/secret, Gemini key, dan provider API key adalah secret. Spatius App/Avatar ID memang dikirim sebagai konfigurasi renderer publik oleh API. Jangan menaruh secret pada `config/project.json`, variable `VITE_*`, repo Git, atau frontend hosting. Buat project LiveKit terpisah untuk dev/prod jika memungkinkan; namespace unik tetap diperlukan jika satu project dibagi.

## Install dan nyalakan lokal

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
npm run check
npm run check:env
```

`check` memvalidasi project, section, gambar, dan URL build. `check:env` memeriksa kelengkapan konfigurasi; jika gagal, lengkapi `.env` sebelum melanjutkan. Perintah ini tidak memeriksa keabsahan key melalui jaringan.

Jalankan dari folder template di tiga terminal:

| Terminal | Perintah | Tanda berhasil |
| --- | --- | --- |
| API | `npm run api` | Log API menampilkan port, project, dan agent name. |
| Frontend | `npm run dev` | Vite tersedia di `http://localhost:5174`. |
| Worker | `.venv/bin/python backend/agent.py start` | Worker terdaftar pada LiveKit dengan nama agent yang cocok; tidak exit/retry karena key salah. |

Periksa API dari terminal tambahan, tanpa membuat room:

```bash
curl -fsS http://localhost:5002/api/health
curl -fsS http://localhost:5002/api/config
curl -i -H 'Origin: http://localhost:5174' http://localhost:5002/api/config
```

Health harus menjawab `{"ok":true}`. Dengan key lengkap, config harus menunjukkan `providerConfigured:true`, provider yang dipilih, dan `sessionsEnabled:false` selama setup. Request dengan origin frontend harus HTTP 200 dan memiliki `Access-Control-Allow-Origin` yang sama. Ganti port bila `PORT` diubah. `localhost` dan `127.0.0.1` adalah origin berbeda; pakai URL yang tercantum di `WEB_ORIGIN`.

Set `ENABLE_SESSIONS=true`, restart API, lalu cek config menunjukkan `sessionsEnabled:true`. Buka `http://localhost:5174`, klik tombol percakapan, izinkan microphone, dan ikuti uji live di [DEPLOYMENT.md](DEPLOYMENT.md). Worker sudah terhubung sebelum klik. Membuka room dapat memakai kuota provider. Untuk akses dari perangkat lain, gunakan frontend HTTPS beserta origin yang sesuai; HTTP dari IP LAN tidak setara dengan localhost untuk izin microphone.

Jika hanya ingin melihat UI tanpa akun provider: cukup `npm run api` dan `npm run dev`, biarkan sessions disabled. Worker dan `check:env` belum bisa dinyatakan siap dalam mode ini.

## Pemeriksaan source dan handoff

```bash
npm test
npm run test:agent
.venv/bin/python -m unittest discover -s backend -p 'integration_*.py' -v
npm run build
npm run export
```

Test memakai mock dan tidak membuat room provider. Test SDK dijalankan memakai venv di atas. Export menghasilkan `exports/<projectId>.tar.gz`; pindahkan arsip itu lalu ulangi ekstraksi/setup dengan kredensial proyek tujuan. Dependency/build dan `.env` asli tidak ikut. Untuk production, lanjutkan ke [DEPLOYMENT.md](DEPLOYMENT.md); untuk memasang pada situs yang sudah ada, lihat [INTEGRATION.md](INTEGRATION.md).
