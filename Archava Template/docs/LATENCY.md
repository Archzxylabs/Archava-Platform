# Menjaga respons seperti Archava yang sudah dituning

Template mempertahankan tuning percakapan di worker Archava sumber. Parameter ini dibawa ke `backend/agent.py`, bukan hanya disarankan dalam dokumentasi.

| Bagian | Baseline yang dipertahankan |
| --- | --- |
| Percakapan | Gemini realtime native audio; tidak menambah pipeline STT → LLM → TTS terpisah. |
| Model dan suara | Default `gemini-2.5-flash-native-audio-preview-12-2025`, suara `Kore`; environment bisa menggantinya. |
| Thinking | `thinking_budget=0`. |
| Endpointing | `min_delay=0.15`, `max_delay=0.6`. Ini parameter turn handling, bukan pengukuran total latency. |
| Interruption | Aktif, `min_duration=0.8`, `min_words=1`, sama dengan sumber. |
| Jawaban | Satu atau dua kalimat, tanpa perkenalan berulang dan monolog feature list. |
| Asset avatar | Preload setelah konfigurasi publik diterima saat halaman terbuka; hasil inisialisasi dan asset di-cache. Saat tombol ditekan, tunggu promise yang sama sebelum membuat room. |
| Browser Spatius | Attach renderer sebelum room connect; `singlePeerConnection=false`, sama dengan sumber. |
| Audio Spatius | `audio_output=False` pada worker; audio langsung agent tidak diduplikasi dengan playback avatar. |
| Transport | Browser ↔ LiveKit langsung. API Node dan frontend hosting tidak meneruskan stream audio/video. |

Preload tidak membuka call atau mengaktifkan microphone. Kalau asset belum siap atau preload gagal, tombol start menunggu atau mengulang persiapan, lalu membuat sesi. Permission microphone tetap memerlukan aksi pengguna. Pada kunjungan pertama, unduhan asset dan permission dapat menambah waktu sebelum tersambung; itu berbeda dari jeda antarjawaban ketika call sudah berjalan.

Pada deployment baru, pertahankan provider/model/versi SDK baseline, jalankan worker terus hidup, dan tempatkan backend/worker serta LiveKit sesuai lokasi pengguna. Jaringan, region, beban worker, kuota, provider, dan panjang jawaban bisa mengubah jeda yang dirasakan. Jangan pindahkan worker menjadi fungsi yang hanya hidup selama request HTTP.

Tuning yang sama tidak membuktikan semua deployment memiliki latency yang sama. Test otomatis memeriksa konfigurasi dan lifecycle; belum ada pengukuran live pada template. Ukur terpisah: klik → host siap, selesai bicara → awal jawaban terdengar, dan interupsi → host berhenti bicara. Bandingkan dengan Archava sumber memakai perangkat, jaringan, provider, region, dan pertanyaan yang sama.

Konfigurasi native audio dan playback mengikuti [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api) dan [integrasi server Spatius](https://docs.spatius.ai/livekit-agents/server). Angka tuning di atas berasal dari source Archava yang dipelajari, bukan janji waktu respons provider.
