# Memasang Archava di proyek lain

Untuk situs baru, gunakan keseluruhan template. Untuk situs yang sudah ada, ambil komponen call dan API/worker, lalu pasang UI pada halaman proyekmu. Komponen tidak bergantung pada wallet atau kontrak.

Cara paling langsung adalah deploy template sebagai halaman tersendiri, lalu tautkan dari situs utama. Untuk embed halaman yang sama:

```html
<iframe
  src="https://archava.domain-kamu"
  title="Percakapan dengan Archava"
  allow="microphone; autoplay"
  style="width:100%; height:800px; border:0"
></iframe>
```

Ganti URL dengan frontend template yang sudah lolos uji live. Parent dan iframe memakai HTTPS; pastikan Permissions-Policy parent mengizinkan microphone untuk origin iframe. `WEB_ORIGIN` backend adalah origin **frontend iframe**, karena request datang dari halaman itu. Page awareness di dalam iframe hanya membaca section halaman template; untuk mengetahui section situs parent, integrasikan komponen/protokol secara langsung pada situs tersebut. Tidak ada widget script satu baris yang otomatis membaca situs arbitrary.

Untuk integrasi langsung pada React/Vite, pakai `src/components/VideoHero.tsx` sebagai contoh pemanggil, beserta `LiveRoom.tsx`, `SpatiusAvatar.tsx`, `SiteAwareness.tsx`, dependency `src/lib/` yang diimpor, config/project, style, dan asset terkait. Pertahankan versi LiveKit/Spatius dari `package.json` dan plugin asset `avatarkitVitePlugin()` di `vite.config.ts` untuk WASM renderer. Pasang API Node serta worker Python sebagai service yang sama seperti deployment template. UI host proyek tujuan tetap membutuhkan empat ID section atau adaptasi kontrak DOM/validator yang dijelaskan di bawah; menyalin komponen tanpa dependency/asset/protokol belum cukup.

| Endpoint | Kegunaan |
| --- | --- |
| `GET /api/health` | Status proses API. Tidak melakukan panggilan provider. |
| `GET /api/config` | ProjectId, provider public config, flag session, readiness konfigurasi, durasi. |
| `POST /api/session` body `{}` | Buka satu guest conversation; respons memuat token LiveKit, serverUrl, endsAt, ticket, provider dan public renderer IDs. |
| `POST /api/session/end` body `{ "ticket": "..." }` | Tutup room milik ticket. Aman dipanggil berulang. Tidak menerima roomName arbitrary. |

Jangan kirim token/ticket ke log, query string, analytics, atau localStorage. Frontend menyimpannya hanya di state/memory. Provider credentials tidak dikirim browser. Endpoint ini bukan API pelanggan terautentikasi; tambahkan auth server-side untuk integrasi privat.

Urutan penting untuk Spatius:

1. Saat konfigurasi publik diterima, mulai inisialisasi AvatarKit dan preload asset melalui `prepareSpatiusAvatar` di background.
2. Dari aksi pengguna, minta izin microphone dan lepaskan stream preflight; tunggu promise preload yang di-cache sebelum membuat sesi.
3. Panggil API start; render LiveKitRoom dengan `connect=false` dan `singlePeerConnection=false`.
4. Komponen Spatius membuat view/player, `attach(room)`, baru connect dan aktifkan microphone.
5. Saat disconnect/error/deadline, unmount/dispose renderer dan kirim ticket end ke API.

Untuk Tavus/voice, LiveKitRoom terhubung biasa; voice tidak menunggu video. Semua provider memakai RoomAudioRenderer. Model dan kredensial tetap ada di worker.

Page awareness membutuhkan ID DOM yang sama pada frontend dan `config/project.json`. Browser mengirim `archava.page` dengan `{section, revision}`. Worker mengakui melalui `archava.page.ack`. UI tidak boleh mengklaim section terkirim sampai acknowledgement cocok dengan revision terbaru. Navigasi dari agent memakai `archava.navigation` dan section allowlist. Kalau situsmu tidak mempunyai section itu, adaptasi DOM dan config bersama-sama; jangan menggantinya dengan pengiriman seluruh HTML halaman.

Situs yang berbeda origin membutuhkan `VITE_API_BASE_URL`/base API yang sesuai dan `WEB_ORIGIN` pada backend. Jika widget dipasang dalam iframe, host harus memberi izin microphone, contohnya `allow="microphone; autoplay"`, dan kedua halaman memakai HTTPS. Desain visual template bisa diganti tanpa mengubah kontrak room dan page protocol.
