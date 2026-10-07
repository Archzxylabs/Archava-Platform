# Archava Template

Fondasi Archava yang bisa dicopy ke proyek lain: frontend React, API Node, worker Python, Gemini realtime voice, LiveKit, dan renderer Spatius. Tavus dan mode voice-only juga tersedia. Template ini dipisahkan dari Archava Onchain; wallet, kontrak, token pembayaran, saldo menit, dan dashboard yang memakai tanda tangan wallet tidak ikut dibawa.

Di repo Archava Platform, foldernya berada di `Archava Template/`. Jalankan command template dari folder ini; template memakai npm dan dependency sendiri, sedangkan workspace Platform memakai pnpm.

## Mulai dari sini

Pakai Node **22.18+** dan Python **3.12 atau 3.13**. Semua perintah dijalankan dari folder ini. Panduan dari nol, sumber kredensial, dependency sistem, dan cara ekstrak arsip ada di [docs/INSTALLATION.md](docs/INSTALLATION.md). Perintah shell mengikuti Linux/macOS; di Windows gunakan WSL2.

```bash
cd "Archava Template"
npm ci
npm run setup
```

`setup` membuat `.env` client dari contoh kosong. Isi kredensial proyek **baru**; domain deployment dan state pengguna Archava lama tidak disalin. Untuk proyek pribadi, pilih profil personal di bawah.

Untuk langsung memberi nama proyek:

```bash
npm run setup -- --project hotel-demo --brand "Hotel Demo" --host "Maya" --language "Bahasa Indonesia"
```

## Env pribadi dan client

Profil pribadi disimpan lokal di `~/.config/archava-template/.env.personal`, di luar source dan arsip client. Setelah profil tersimpan, setiap proyek baru di komputer yang sama bisa memakai:

```bash
npm run setup:personal -- --project proyek-gua --brand "Proyek Gua" --host "Maya"
```

Untuk proyek client, mulai dengan contoh `.env.client.example` yang kosong:

```bash
npm run setup:client -- --project proyek-client --brand "Client" --host "Maya"
```

Kedua command membuat `.env` dengan namespace proyek sendiri dan sessions disabled. Kalau `.env` sudah ada, command berhenti; gunakan `--force` hanya saat sengaja mengganti profil/reset environment. `npm run setup` biasa tetap mempertahankan `.env` yang ada. Cara menyimpan/memperbarui profil, memakai komputer lain, dan menyiapkan handoff client dijelaskan di [docs/ENV_PROFILES.md](docs/ENV_PROFILES.md).

## Menyiapkan runtime

Edit `config/project.json`: brand, knowledge, status fitur, deskripsi section, contact URL, dan gambar. Perubahan nama otomatis mengganti penyebutan brand/host di knowledge bawaan; fakta bisnisnya tetap harus kamu review. `PROJECT_ID` pada `.env` membedakan proyek dan environment di LiveKit. API dan worker harus memakai ID serta nama agent yang sama.

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
npm run check
```

Untuk Spatius, isi LiveKit, Gemini, `SPATIUS_API_KEY`, `SPATIUS_APP_ID`, dan `SPATIUS_AVATAR_ID`. Untuk mencoba percakapan tanpa renderer, set `AVATAR_PROVIDER=voice`; cukup LiveKit dan Gemini. Mode Tavus membutuhkan `TAVUS_API_KEY` dan `FACE_ID`. Tidak ada fallback diam-diam yang mengubah provider saat sesi berjalan.

Setelah `.env` diisi, jalankan `npm run check:env`. Biarkan `ENABLE_SESSIONS=false` sampai worker terdaftar; buka akses dengan `true` lalu restart API untuk uji percakapan. Jalankan di tiga terminal, masing-masing dari folder template:

```bash
npm run api
```

```bash
npm run dev
```

```bash
.venv/bin/python backend/agent.py start
```

Buka `http://localhost:5174`. Vite meneruskan `/api` ke port API dari `.env`, default `5002`. Hot reload worker bersifat opsional: setelah memasang [LiveKit CLI](https://docs.livekit.io/reference/developer-tools/livekit-cli/), aktifkan venv dengan `source .venv/bin/activate`, lalu gunakan `lk agent dev backend/agent.py`. Jangan menjalankan worker start dan dev bersamaan untuk environment yang sama. Model Gemini bawaan berasal dari baseline Archava; cek akses model di akunmu dan ubah `GEMINI_MODEL` bila diperlukan.

## Yang bisa diubah

| Kebutuhan | File |
| --- | --- |
| Brand, nama host, bahasa, gambar, contact, knowledge | `config/project.json` |
| Cara menjawab, scope, guardrail percakapan | `prompts/system.md` |
| Penyusunan prompt dan konteks sesi tepercaya | `backend/instructions.py` |
| Integrasi suara/avatar dan tool agent | `backend/agent.py` |
| Izin, durasi, kapasitas, kredensial | `.env` / environment hosting |
| Tampilan dan tema | `src/components/`, `src/styles.css` |
| Frontend terpisah dari backend | `VITE_API_BASE_URL` + `WEB_ORIGIN` |

Konfigurasi project adalah **data publik**: frontend menyertakannya di bundle. Rahasia selalu di environment API/worker. Setelah mengubah knowledge atau prompt, restart worker; setelah mengubah data UI, rebuild frontend dan deploy keduanya.

## Respons percakapan

Tuning worker mengikuti Archava sumber: Gemini realtime native audio, thinking budget `0`, endpointing `0.15–0.6` detik, dan interruption aktif. Avatar dipreload saat halaman terbuka serta di-cache sebelum room dibuat. Lihat [docs/LATENCY.md](docs/LATENCY.md) untuk parameter yang dipertahankan dan cara memeriksa performa deployment baru. Template belum diukur dalam panggilan live; konfigurasi yang sama tidak menjamin jeda yang sama pada region, jaringan, atau provider berbeda.

## Deploy

- **Frontend Vercel + backend Railway:** ikuti [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Frontend memakai `VITE_API_BASE_URL`; backend memakai allowlist `WEB_ORIGIN`. Backend menjalankan API dan worker yang terus hidup.
- **Satu server / VPS:** `npm run build`, lalu jalankan API dan worker. API melayani `dist`. Atau gunakan `docker compose up --build -d` dengan `.env` yang sudah diisi. Set `WEB_ORIGIN` ke origin situs yang dibuka, misalnya `http://localhost:5002` untuk Docker lokal; `VITE_API_BASE_URL` kosong.

File deploy masih berupa recipe; template ini belum dipublish ke akun atau domain baru. `/api/health` memeriksa proses API, bukan kualitas panggilan atau kesiapan worker. `providerConfigured` hanya menyatakan konfigurasi lengkap. Pastikan ada percakapan nyata yang berhasil sebelum menganggap deployment selesai.

## Verifikasi dan pindahkan

```bash
npm test
npm run test:agent
.venv/bin/python -m unittest discover -s backend -p 'integration_*.py' -v
npm run build
npm run export
```

`test:agent` memeriksa knowledge, prompt, dan protokol halaman tanpa kredensial atau SDK provider. Test `integration_*.py` memakai SDK yang terpasang dan mock room; tidak membuka panggilan berbayar. `export` menghasilkan `exports/<projectId>.tar.gz`, berisi source, lima gambar konsep, contoh environment, lockfile, serta dokumen. `.env` asli, dependency, build, cache, dan link ke deployment lama tidak disertakan. Ekstrak arsip di lokasi baru, lalu ulangi setup. Arsip tidak bergantung pada folder Archava asal.

Sesi bersifat publik dan anonymous. Default membatasi 3 percobaan start per IP per menit, 10 sesi aktif, dan 120 detik per sesi. Origin allowlist bukan autentikasi; lihat [docs/GUARDRAILS.md](docs/GUARDRAILS.md) sebelum membuat akses privat atau menjalankan lebih dari satu API replica.

Panduan lanjutan: [pemasangan](docs/INSTALLATION.md), [env pribadi/client](docs/ENV_PROFILES.md), [deploy](docs/DEPLOYMENT.md), [prompting](docs/PROMPTING.md), [guardrail](docs/GUARDRAILS.md), [API dan integrasi](docs/INTEGRATION.md), [hasil mempelajari Archava](docs/SOURCE_ARCHITECTURE.md), [hasil validasi](docs/VALIDATION.md).
