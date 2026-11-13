const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Ambil komponen waktu dalam zona WIB (Vercel jalan di UTC)
function waktuWIB(date = new Date()) {
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const p = {};
  parts.forEach((x) => (p[x.type] = x.value));
  const hh = p.hour === "24" ? "00" : p.hour;
  return {
    hh,
    mm: p.minute,
    detik: Number(hh) * 3600 + Number(p.minute) * 60 + Number(p.second),
    tanggalTeks: `${p.weekday}, ${p.day} ${p.month} ${p.year}`,
    // YYYY-MM-DD versi WIB
    tanggalISO: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Jakarta",
    }).format(date),
  };
}

// 08xxx -> 628xxx
function normalisasiNomor(no) {
  let n = String(no).replace(/\D/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  return n;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", pesan: "Gunakan POST" });
  }

  const { uid, key } = req.body || {};

  if (key !== process.env.DEVICE_API_KEY) {
    return res.status(401).json({ status: "error", pesan: "API key salah" });
  }
  if (!uid) {
    return res.status(400).json({ status: "error", pesan: "UID kosong" });
  }

  const uidBersih = String(uid).trim().toUpperCase();

  try {
    // 1. Cari siswa berdasarkan UID
    const { data: siswa } = await supabase
      .from("siswa")
      .select("*")
      .eq("uid_rfid", uidBersih)
      .maybeSingle();

    if (!siswa) {
      // simpan UID biar bisa didaftarkan lewat web admin
      await supabase
        .from("kartu_baru")
        .upsert({ uid: uidBersih, waktu: new Date().toISOString() });
      return res.status(404).json({
        status: "unknown",
        pesan: "Kartu Tidak Dikenal",
      });
    }

    // 2. Ambil jam batas dari pengaturan
    const { data: set } = await supabase
      .from("pengaturan")
      .select("jam_batas")
      .eq("id", 1)
      .single();
    const [bh, bm, bs = 0] = (set?.jam_batas || "06:45:00")
      .split(":")
      .map(Number);
    const batasDetik = bh * 3600 + bm * 60 + bs;

    // 3. Waktu sekarang (WIB)
    const now = new Date();
    const w = waktuWIB(now);

    // 4. Cek sudah absen hari ini?
    const awalHari = `${w.tanggalISO}T00:00:00+07:00`;
    const { data: sudah } = await supabase
      .from("absensi")
      .select("id")
      .eq("siswa_id", siswa.id)
      .gte("waktu", awalHari)
      .limit(1);

    if (sudah && sudah.length > 0) {
      return res.status(200).json({
        status: "duplicate",
        nama: siswa.nama,
        pesan: "Sudah Absen",
      });
    }

    // 5. Hitung status (jam batas ke atas = telat)
    const telat = w.detik >= batasDetik;
    const menitTelat = telat ? Math.floor((w.detik - batasDetik) / 60) : 0;
    const status = telat ? "terlambat" : "tepat_waktu";

    // 6. Simpan absensi
    const { data: absen, error: errAbsen } = await supabase
      .from("absensi")
      .insert({
        siswa_id: siswa.id,
        waktu: now.toISOString(),
        status,
        menit_telat: menitTelat,
      })
      .select()
      .single();
    if (errAbsen) throw errAbsen;

    // 7. Buat pesan WA untuk ortu
    const teksStatus = telat
      ? menitTelat > 0
        ? `⚠️ Terlambat (${menitTelat} menit)`
        : "⚠️ Terlambat"
      : "✅ Tepat waktu";

    const pesan =
      `📚 *Absensi SMK PGRI 1 Jombang*\n` +
      `Nama: ${siswa.nama}\n` +
      `Kelas: ${siswa.kelas}\n` +
      `No. Absen: ${String(siswa.no_absen).padStart(2, "0")}\n` +
      `Waktu: ${w.tanggalTeks}, ${w.hh}.${w.mm} WIB\n` +
      `Status: ${teksStatus}`;

    await supabase.from("notifikasi").insert({
      absensi_id: absen.id,
      pesan,
      no_tujuan: normalisasiNomor(siswa.no_wa_ortu),
      status: "pending",
    });

    // 8. Balas ke ESP32 (buat LCD + buzzer)
    return res.status(200).json({
      status: "ok",
      nama: siswa.nama,
      kelas: siswa.kelas,
      telat,
      pesan: telat ? "Terlambat" : "Tepat Waktu",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", pesan: "Server error" });
  }
};
