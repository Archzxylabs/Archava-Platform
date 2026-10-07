# Frontend dan backend

Runtime memiliki tiga bagian: React statis, API Node yang membuat/menutup sesi, dan worker Python yang terus terhubung ke LiveKit. API dan worker memakai project config serta LiveKit credentials yang sama. Browser bergabung langsung ke LiveKit menggunakan token dari API; audio/video tidak diproxy melalui Vercel atau API Node.

Pertahankan tuning realtime dan preload di [LATENCY.md](LATENCY.md). Worker harus terus hidup; periksa region dan latency dengan panggilan nyata ketika berpindah hosting. Healthcheck API saja tidak mengukur jeda respons.

Selesaikan [INSTALLATION.md](INSTALLATION.md) untuk dependency, nama proyek, knowledge, dan kredensial. Semua perintah Docker dijalankan dari root template. Runtime tidak membutuhkan database atau storage volume untuk pola satu API; ticket/admission masih berada di memory.

## Vercel + Railway

1. Ekspor template ke repo Git baru dan push source ke repo yang dipilih pada Vercel/Railway. Jangan commit `.env`. Untuk repo baru, Root Directory adalah root repo. Jika masih memakai repo Archava ini, set Root Directory Railway ke `/Archava Template` dan Vercel ke `Archava Template`. `package.json`, `config`, `backend`, dan Dockerfile harus berada di root build yang sama.
2. Buat service Railway dari repo tersebut. Railway mendeteksi `Dockerfile` pada root source; konfirmasi build log menggunakan Dockerfile. Atur service sesuai tabel di bawah. Default `RUN_MODE=all` menjalankan API + worker; frontend juga dibangun dan bisa dilayani API. Railway menyuplai `PORT`, dan API bind `0.0.0.0` pada port tersebut. Jangan menyalin PORT lokal ke Railway atau mengisi `VITE_API_BASE_URL` untuk build backend ini.
3. Isi environment Railway: `PROJECT_ID=nama-proyek-prod`, LiveKit, Gemini, provider, provider credentials, `SESSION_SECONDS`, kapasitas, dan rate limit. Awalnya `ENABLE_SESSIONS=false`. API dan worker dalam container otomatis memakai environment yang sama. Model/voice harus tersedia di akun Gemini-mu.
4. Generate public domain Railway; gunakan origin HTTPS itu sebagai backend. Catat URL publik aktual, bukan domain Archava lama atau temporary tunnel.
5. Buat frontend Vercel dari root yang sama dengan preset Vite, install `npm ci`, build `npm run build`, output `dist`; pilih Node 22.x atau versi lebih baru yang memenuhi engine package. Isi **hanya** public build variable `VITE_API_BASE_URL=https://domain-backend-kamu` pada environment Vercel yang akan dideploy. Tanpa trailing `/`, tanpa `/api`. Build Vercel gagal lebih awal kalau variable ini belum diisi. Provider secrets tidak diperlukan di Vercel.
6. Set `WEB_ORIGIN=https://domain-frontend-kamu` di Railway. Origin tanpa trailing slash. Beberapa origin bisa dipisahkan koma; tambahkan staging origin satu per satu. Jangan memakai wildcard untuk seluruh preview Vercel. Bila ingin membuka frontend yang dilayani Railway juga, tambahkan origin Railway tersebut.
7. Redeploy backend dan frontend, cek `/api/health`, `/api/config`, CORS, dan log worker yang terdaftar dengan agentName proyek. Set `ENABLE_SESSIONS=true` dan deploy ulang backend, lalu lakukan uji live di bagian bawah. Jangan menjalankan worker dev dengan project/agentName production yang sama.

Setting Railway yang harus diisi untuk service gabungan:

| Setting | Nilai |
| --- | --- |
| Source / Root Directory | `/` untuk repo hasil export; `/Archava Template` bila template masih berada di repo ini. |
| Builder | Dockerfile yang terdeteksi; tidak perlu install/build command npm terpisah. |
| Start command | `./entrypoint.sh` atau kosong memakai CMD Dockerfile. |
| Variable `RUN_MODE` | `all`. |
| Healthcheck path / timeout | `/api/health` / 120 detik. |
| Restart policy | On Failure, max retries 10; periksa log jika retry habis. |
| Replicas / region | Satu API replica pada satu region. |
| Serverless / sleep | Disabled supaya API dan worker terus hidup. |
| Public networking | Domain HTTPS untuk API; target port mengikuti `PORT` runtime. |

Panduan service baru memakai setting dashboard tersebut. Dokumentasi Railway per 3 Oktober 2026 menyatakan `railway.json`/`railway.toml` tidak dapat diaktifkan pada service baru; karena itu template tidak menyertakan recipe lama yang bergantung pada file tersebut. Jika memakai automation hosting, ikuti [Infrastructure as Code Railway](https://docs.railway.com/config-as-code) yang berlaku saat memasang. [Dockerfile detection](https://docs.railway.com/builds/dockerfiles) dan [pengaturan sleep](https://docs.railway.com/deployments/serverless) dijelaskan pada dokumentasi resmi.

Pembagian environment:

| Tempat | Environment |
| --- | --- |
| Vercel | `VITE_API_BASE_URL` saja; brand/knowledge dari source `config/project.json`. |
| Railway gabungan | Variable server di `.env.example`, termasuk LiveKit/Gemini/provider, namespace, origin, dan admission; gunakan `RUN_MODE=all`, port dari Railway. |
| Railway API + worker terpisah | Samakan LiveKit/Gemini/provider dan namespace di kedua service; `RUN_MODE` berbeda sesuai perannya. Origin/admission berlaku pada API. Kedua build memakai commit/config yang sama. |

Contoh untuk inspeksi konfigurasi publik, tanpa secret:

```bash
curl -fsS https://domain-backend-kamu/api/health
curl -fsS https://domain-backend-kamu/api/config
curl -i -H 'Origin: https://domain-frontend-kamu' https://domain-backend-kamu/api/config
```

`providerConfigured=true` tidak membuktikan worker terdaftar, model dapat dipakai, provider punya kuota, atau browser berhasil merender. Healthcheck Railway hanya memeriksa API. Dalam mode all, entrypoint ikut berhenti jika worker mati sehingga restart policy bisa memulihkan service. Log dan panggilan nyata tetap perlu diperiksa. Akun provider bisa mengenakan biaya ketika sesi dibuat.

Harapkan HTTP 200, health `{"ok":true}`, dan config dengan provider yang dipilih; request ber-Origin harus memiliki `Access-Control-Allow-Origin` yang cocok. `sessionsEnabled` berubah dari false ke true setelah akses dibuka. Jika frontend/backend berada di balik deployment protection/login, sediakan akses publik ke endpoint API untuk browser dan healthcheck; template tidak mengirim token deployment protection.

Tidak ada rewrite ke domain tertentu di `vercel.json`: frontend mengakses backend dari `VITE_API_BASE_URL`, dan API menjawab CORS untuk origin yang diizinkan. `sendBeacon` saat pagehide hanya upaya terbaik; jika browser melewatkannya, expiry menutup room. Rebuild frontend ketika mengubah variable `VITE_*`.

## Satu host dengan Docker

```bash
npm ci
npm run setup
# Isi .env; set WEB_ORIGIN=http://localhost:5002 untuk percobaan lokal.
# VITE_API_BASE_URL kosong. ENABLE_SESSIONS=true setelah worker siap.
docker compose up --build -d
docker compose logs -f api worker
```

Compose memisahkan API dan worker memakai image yang sama. API melayani hasil build frontend; buka `http://localhost:5002`. `PORT` pada `.env` menentukan port host yang dipetakan ke port 5002 container API. Periksa `docker compose ps` dan log worker, lalu ubah `ENABLE_SESSIONS=true` pada `.env` dan jalankan kembali `docker compose up -d` untuk menerapkan environment baru. `docker compose restart` saja tidak membaca ulang environment. LiveKit tetap layanan tersendiri. Worker hanya membutuhkan koneksi keluar, tidak membutuhkan public domain.

Alternatif satu container:

```bash
docker build -t archava-template .
docker run --env-file .env -e PORT=5002 -e RUN_MODE=all -p 5002:5002 --init archava-template
```

Untuk menjalankan tanpa Docker, `npm run build`, `npm run api`, dan `.venv/bin/python backend/agent.py start` sebagai dua proses yang diawasi service manager. API akan melayani `dist`. `npm run preview` hanya melayani frontend untuk inspeksi; tidak menjalankan API atau worker.

Untuk update Compose, ubah source/config, jalankan `docker compose up --build -d`, lalu ulangi inspeksi config dan uji live. Untuk menghentikan service lokal gunakan `docker compose down`. Redeploy/restart API dapat menutup percakapan aktif; lakukan saat tidak ada sesi aktif bila ingin menghindari interupsi.

## VPS dengan HTTPS

Contoh satu container di Debian/Ubuntu dengan Caddy pada host:

1. Pasang Docker dan [Caddy sebagai service](https://caddyserver.com/docs/install). Arahkan DNS A/AAAA domain ke VPS; port 80/443 harus dapat diakses dari internet. Ikuti [prasyarat HTTPS Caddy](https://caddyserver.com/docs/quick-starts/https).
2. Pada `.env`, set `PROJECT_ID=nama-proyek-prod`, `PORT=5002`, `WEB_ORIGIN=https://archava.domain-kamu`, `VITE_API_BASE_URL=` dan awalnya `ENABLE_SESSIONS=false`. Untuk contoh proxy langsung ini, set `TRUST_PROXY=true`; config Caddy di bawah menimpa header client IP dan API hanya dipublish pada loopback. Jangan menambahkan CDN/proxy lain tanpa menyesuaikan aturan trusted proxy.
3. Build dan jalankan container yang tetap hidup setelah terminal ditutup:

```bash
docker build -t archava-template .
docker run -d --name archava --restart unless-stopped --init \
  --env-file .env -e PORT=5002 -e RUN_MODE=all \
  -p 127.0.0.1:5002:5002 archava-template
docker logs -f archava
```

4. Tambahkan blok berikut ke `/etc/caddy/Caddyfile`, memakai domain sebenarnya. Jika sudah ada situs lain di VPS, pertahankan blok situs tersebut.

```caddyfile
archava.domain-kamu {
    reverse_proxy 127.0.0.1:5002 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

5. Validasi lalu reload service Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl -fsS https://archava.domain-kamu/api/health
```

Caddy mengurus sertifikat untuk domain yang DNS/portnya benar. Header proxy mengikuti [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Setelah worker terdaftar, ubah `.env` ke `ENABLE_SESSIONS=true`, hentikan dan hapus container `archava`, lalu jalankan ulang perintah `docker run` di atas; environment baru memerlukan container baru. Perintah penghentiannya `docker stop archava` lalu `docker rm archava`. Update source dilakukan dengan build ulang image sebelum membuat container baru. Jalankan uji live lewat HTTPS, bukan lewat IP HTTP VPS.

## Memisahkan API dan worker di Railway

Gunakan dua service dari source yang sama dan tabel setting Railway di atas. Pada service API, set `RUN_MODE=api`, healthcheck `/api/health`, dan public domain. Pada service worker, set `RUN_MODE=worker`, **kosongkan HTTP healthcheck**, dan jangan buat public domain. Worker memakai koneksi keluar ke LiveKit; healthcheck HTTP akan selalu gagal karena worker tidak menjalankan HTTP server. Keduanya memakai `./entrypoint.sh`, restart policy, dan sleep disabled. Samakan projectId, agentName, LiveKit, provider, dan commit/config. Jalankan tepat satu API replica sampai admission/ticket dipindahkan ke shared store.

Di Railway, default `TRUST_PROXY=false` berarti request dari satu IP proxy dapat berbagi bucket rate limit. Sebelum membuka akses banyak pengguna, pastikan edge yang dipakai menimpa `X-Forwarded-For` dari pengunjung, lalu aktifkan `TRUST_PROXY=true`. Jangan mempercayai header itu pada API yang dapat diakses tanpa proxy tepercaya; lihat [GUARDRAILS.md](GUARDRAILS.md).

## Uji live setelah pemasangan

1. Pastikan config menunjukkan provider yang benar, `providerConfigured:true`, `sessionsEnabled:true`, dan worker terdaftar dengan nama yang cocok.
2. Buka frontend HTTPS atau localhost; mulai percakapan, izinkan microphone, pastikan host menyapa dan mendengar pertanyaan. Untuk Spatius/Tavus, pastikan avatar bergerak dan audio tidak ganda.
3. Tanyakan satu fakta verified, satu fitur planned/unavailable, dan satu hal di luar knowledge. Periksa jawaban mengikuti data/status dan tidak mengarang kemampuan.
4. Pindah section lalu tanya konteks halaman; minta host membuka section yang diizinkan dan pastikan scroll/ack benar.
5. Coba mute, Allow Audio bila autoplay diblokir, disconnect, dan start ulang. Batasi retry sesuai rate limit.
6. Biarkan satu sesi mencapai `SESSION_SECONDS`. Pastikan UI berakhir dan room LiveKit hilang; periksa juga setelah tombol end/halaman ditutup.

Deployment dinyatakan terpasang setelah uji ini lolos. Simpan catatan model/region/provider yang digunakan bila membandingkan delay dengan Archava asal; [LATENCY.md](LATENCY.md) menjelaskan tuning yang sudah dipertahankan.

## Diagnosis

| Gejala | Periksa |
| --- | --- |
| Host offline | ENABLE_SESSIONS, providerConfigured, frontend API origin, CORS. |
| API hidup tetapi host tidak join | Worker terdaftar, agentName/PROJECT_ID sama, LiveKit project sama, model tersedia. |
| Avatar gagal | Provider credentials sama, Spatius public app/avatar ID benar, browser mendukung RTCRtpScriptTransform. |
| Suara tidak terdengar | Izin microphone/autoplay; tombol Allow Audio; Spatius audio_output=False di worker. |
| Jawaban knowledge lama | Worker belum direstart atau frontend/backend memakai config release berbeda. |
| Sesi sering 429 | Rate limiter di belakang shared proxy, kapasitas sesi, atau retry per IP. |
| Container restart loop | Log worker/API, dependencies Python, credentials; entrypoint sengaja mempertahankan status gagal. |
| Build tidak menemukan package/Dockerfile | Root Directory harus folder template, bukan root workspace Archava Platform. |
| Config dibuka curl, tetapi browser gagal | Uji dengan header Origin; samakan WEB_ORIGIN, HTTPS, deployment protection, dan VITE_API_BASE_URL saat build. |
| Perubahan .env tidak terbaca | Restart proses lokal; recreate container Compose/run; redeploy service hosting. Rebuild untuk VITE_* dan perubahan config UI. |
| `check:env` lolos tetapi call gagal 401/403/429 | Key presence bukan validasi akun: periksa akses Gemini Live/model, key provider, kuota, dan namespace worker. |

Recipe ini mengikuti dokumentasi resmi [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite), [Railway Docker deployments](https://docs.railway.com/deployments/reference), [Railway healthchecks](https://docs.railway.com/deployments/healthchecks), [LiveKit explicit dispatch](https://docs.livekit.io/agents/server/agent-dispatch/), dan [Spatius server](https://docs.spatius.ai/livekit-agents/server)/[client](https://docs.spatius.ai/livekit-agents/client). Model Live menggunakan [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api). Referensi diperiksa ketika template disiapkan; deployment baru tetap memerlukan kredensial dan validasi live milik proyekmu.
