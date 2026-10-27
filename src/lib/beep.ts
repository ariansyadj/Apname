// Bunyi "pip" singkat untuk hasil scan yang berhasil, pakai Web Audio API
// (tanpa file audio). Konteks dibuat saat pertama dipakai dan di-resume bila
// tertunda — pemanggilan pertama sebaiknya terjadi dari gestur pengguna
// (ketuk tombol / Enter) supaya iOS mengizinkan audio.
let ctx: AudioContext | null = null;

export function playScanBeep() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  } catch {
    // Audio tidak tersedia — scan tetap tercatat, hanya tanpa bunyi.
  }
}
