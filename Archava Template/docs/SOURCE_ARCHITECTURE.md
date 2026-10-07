# Fondasi yang diambil dari Archava

Template ini dibuat dengan membaca implementasi Archava Onchain di workspace, termasuk test, build config, dan deployment recipe. Folder asal tetap utuh.

| Bagian asal | Pelajaran / hasil di template |
| --- | --- |
| `backend/agent.py` | Pisahkan identitas, kondisi active call, bahasa, kebenaran produk, page awareness, dan scope. Pertahankan parameter interruption/endpointing serta urutan avatar sebelum session start. |
| `backend/knowledge.py` | Klaim fitur harus berasal dari fakta yang direview, bukan keberadaan route atau environment flag. Ganti fact sheet khusus produk dengan knowledge `verified`, `planned`, `unavailable`. |
| `backend/site_context.py` | Payload harus tepat `{section, revision}`, ukurannya dibatasi, ID allowlist, revision monotonik. Template menambahkan binding ke identitas guest tertentu dari metadata API. |
| `src/lib/siteAwareness.ts` dan `SiteAwareness.tsx` | Acknowledgement harus cocok dengan section dan revision yang sedang ditunggu. Pesan terlambat tidak boleh mengonfirmasi section baru. |
| `server/livekit-rooms.mjs` | Dispatch agent secara eksplisit; hapus automatic dispatch dan bersihkan agent otomatis yang terlambat join. Rollback room saat setup gagal. |
| `server/preview.mjs` dan `server/app.mjs` | Browser memperoleh token pendek dan ticket opaque; server menutup room, bukan hanya UI menghitung mundur. Template memakai endpoint anonymous `/api/session` dengan admission limit. |
| `src/components/LiveRoom.tsx`, `SpatiusAvatar.tsx`, `src/lib/spatius.ts` | Lazy-load renderer, preload dan cache avatar saat halaman terbuka sebelum memakai durasi sesi, attach player sebelum connect, enable microphone, dan dispose saat berakhir. |
| Landing page dan `src/styles.css` | Pertahankan visual hero, concept artwork, section avatar, workflow, business, kontrol audio, motion, dan responsivitas. Hapus UI wallet/checkout/developer. |
| `Dockerfile`, `entrypoint.sh`, `vercel.json`, `railway.json` | Template memakai Node 22, membangun frontend dalam image, parameter origin milik proyek baru, serta supervisor yang menghentikan kedua proses dan mempertahankan status kegagalan. Recipe Railway untuk proyek baru dijelaskan lewat setting service di `DEPLOYMENT.md`; file config-as-code lama tidak disalin karena kebijakan Railway saat audit. |

Bagian yang tidak dibawa: `packages/contracts`, RPC chain, ethers, signature challenge, entitlement, API key yang terikat wallet, credit/usage ledger, checkout, faucet, quote, domain lama, `.env`, `.venv`, `.git`, dan state runtime.

Versi dependency JavaScript dipin ke versi lockfile Archava. LiveKit Python plugins tetap 1.7.1. Ini baseline yang dipelajari, bukan klaim bahwa semua library atau model provider adalah versi terbaru. Perubahan runtime dipisahkan dan harus diverifikasi kembali dengan panggilan nyata.
