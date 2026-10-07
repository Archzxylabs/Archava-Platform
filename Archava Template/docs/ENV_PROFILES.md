# Env pribadi dan client

Source bisa dipakai untuk proyek pribadi dan client; pemilihan kredensial dilakukan ketika setup. Runtime tetap membaca `.env` proyek seperti sebelumnya. Tidak ada profil pribadi yang otomatis dimuat oleh API, worker, Vite, atau export.

| Jalur | Sumber env | Hasil |
| --- | --- | --- |
| `npm run setup:personal` | Profil pribadi lokal bersama. | `.env` dengan akses provider milikmu dan namespace proyek baru. |
| `npm run setup:client` | `.env.client.example` yang kosong. | `.env` kosong untuk kredensial client; tidak membaca profil pribadi. |
| `npm run setup` | Contoh client jika `.env` belum ada. | Jika `.env` sudah ada, mempertahankan isinya. |

## Profil pribadi

Lokasi default adalah `~/.config/archava-template/.env.personal`. Jika `XDG_CONFIG_HOME` diatur, lokasi mengikuti `$XDG_CONFIG_HOME/archava-template/.env.personal`. File berada di luar repo/template sehingga semua proyek baru di komputer yang sama dapat menggunakannya. Permission file `600`; direktori profil yang baru dibuat memakai `700`.

Untuk menyiapkan profil satu kali dari env proyek milikmu, jalankan dari folder template:

```bash
npm run env:save -- --from "/path/proyek-pribadi/.env"
```

Jika template berada di `Archverse/Lab/Archava_Platform/Archava Template`, env Archava Onchain dapat diimport dengan `npm run env:save -- --from "../../Archava_onchain/.env"`. Import ini opsional; profil pribadi yang sudah tersimpan tetap bisa dipakai setelah folder dipindah. Profil hanya menyimpan LiveKit URL/key/secret, Gemini key/model/voice, pilihan provider, ID/key Spatius, optional region Spatius, serta key/face/PAL Tavus yang terisi. Field onchain, wallet, billing, domain frontend/backend lama, port, origin, trust proxy, project ID, agent name, dan flag membuka sesi tidak disalin. Nilai secret tidak dicetak command.

Untuk memakai profil pada proyek baru:

```bash
npm ci
npm run setup:personal -- --project demo-gua --brand "Demo Gua" --host "Maya" --language "Bahasa Indonesia"
npm run check:env
```

Namespace otomatis `demo-gua-dev`, agent name otomatis `demo-gua-dev-host`. `WEB_ORIGIN` kembali ke localhost, `VITE_API_BASE_URL` kosong, dan `ENABLE_SESSIONS=false`. Ubah namespace/origin sesuai environment saat deploy, lalu buka sessions ketika worker siap seperti [INSTALLATION.md](INSTALLATION.md). Key provider yang sama tetap memakai akun/kuota milikmu.

Di komputer lain, import env milikmu melalui `env:save` pada komputer tersebut. Arsip template tidak membawa profil pribadi. Untuk lokasi profil custom, set `ARCHAVA_PERSONAL_ENV` sebelum command; variable ini juga dipakai `env:save` sebagai lokasi tujuan:

```bash
ARCHAVA_PERSONAL_ENV="/lokasi/private/.env.personal" npm run setup:personal -- --project demo-gua
```

Untuk penggunaan satu kali tanpa menyimpan profil bersama:

```bash
npm run setup:personal -- --env-file "/path/proyek-pribadi/.env" --project demo-gua
```

Memperbarui key bersama dilakukan dengan import ulang yang eksplisit:

```bash
npm run env:save -- --from "/path/proyek-pribadi/.env" --force
```

Proyek yang sudah memiliki `.env` mempertahankan snapshot key saat setup. Memperbarui profil bersama tidak otomatis mengubah deployment atau `.env` proyek yang sudah ada. Edit `.env` proyek tersebut atau lakukan reset profil berikut setelah mencatat setting deploy-nya.

## Jalur client

```bash
npm ci
npm run setup:client -- --project client-demo --brand "Client Demo" --host "Maya"
```

Isi `.env` dengan key milik client/proyek client, lalu lanjutkan [INSTALLATION.md](INSTALLATION.md). `.env.client.example` dan `.env.example` hanya berisi default publik dan field secret yang kosong. Jalur client tidak melakukan fallback ke profil pribadi, walaupun profil tersedia di komputer itu.

Jika sengaja mengganti env pada proyek yang sama:

```bash
npm run setup:client -- --force --project client-demo
# Atau reset memakai key pribadi:
npm run setup:personal -- --force --project demo-gua
```

`--force` membuat ulang `.env`: key, domain, port, admission, dan setting deploy sebelumnya diganti dengan default profil yang dipilih. Tanpa `--force`, profil eksplisit menolak mengganti `.env` yang sudah ada dan tidak mengubah identitas proyek. `npm run setup` tanpa profil eksplisit tetap mempertahankan env yang ada; untuk memulai client dari proyek yang pernah personal, gunakan reset client eksplisit atau folder baru.

## Handoff client

Jalankan `npm run export` dan berikan `exports/<projectId>.tar.gz`. Export memuat contoh client kosong dan source setup, tanpa `.env` aktif maupun profil pribadi. Setup client/export menolak contoh env yang terisi key atau ID provider asli. Git, build context Docker, dan upload Vercel mengecualikan file `.env` asli. Hindari mengirim folder kerja yang memuat `.env` pribadi; pakai arsip export untuk handoff.

Setup/import/check hanya menyiapkan dan memeriksa konfigurasi lokal; tidak deploy, membuka room, atau menggunakan kuota panggilan. Model/suara dan tuning realtime mengikuti profil/source yang dipilih, tanpa menambah delay pada runtime call.
