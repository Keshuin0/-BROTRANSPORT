class CyberAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private enabled: boolean = false;
  private humOscs: OscillatorNode[] = [];
  private humGain: GainNode | null = null;
  private reeferOscs: OscillatorNode[] = [];
  private reeferGain: GainNode | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.enabled = localStorage.getItem('bro_audio_enabled') === 'true';
    }
  }

  init() {
    if (this.ctx) return;
    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;
      this.ctx = new AudioCtxClass();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.enabled ? 0.35 : 0, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
      
      if (this.enabled) {
        this.startAmbientHum();
      }
    } catch (e) {
      console.warn("WebAudio API initialization failed or unsupported:", e);
    }
  }

  enable() {
    this.enabled = true;
    localStorage.setItem('bro_audio_enabled', 'true');
    this.init();
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setValueAtTime(0.35, this.ctx.currentTime);
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      this.startAmbientHum();
    }
  }

  disable() {
    this.enabled = false;
    localStorage.setItem('bro_audio_enabled', 'false');
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
    this.stopAmbientHum();
    this.stopReeferHum();
  }

  isEnabled() {
    return this.enabled;
  }

  private startAmbientHum() {
    if (!this.ctx || !this.masterGain || this.humOscs.length > 0) return;
    try {
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const lpf = this.ctx.createBiquadFilter();
      this.humGain = this.ctx.createGain();
      
      osc1.type = 'sawtooth';
      osc1.frequency.value = 55; // A1 low drone
      
      osc2.type = 'sine';
      osc2.frequency.value = 110.2; // detuned octave harmonic
      
      lpf.type = 'lowpass';
      lpf.frequency.value = 80; // deep bass dampening
      
      this.humGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.humGain.gain.linearRampToValueAtTime(0.05, this.ctx.currentTime + 1.5);
      
      osc1.connect(lpf);
      osc2.connect(lpf);
      lpf.connect(this.humGain);
      this.humGain.connect(this.masterGain);
      
      osc1.start();
      osc2.start();
      
      this.humOscs = [osc1, osc2];
    } catch (e) {
      console.error("Failed to start ambient loop:", e);
    }
  }

  private stopAmbientHum() {
    this.humOscs.forEach(osc => {
      try {
        osc.stop();
      } catch (e) {}
    });
    this.humOscs = [];
  }

  playTabClick() {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(550, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.04);
      
      gainNode.gain.setValueAtTime(0.06, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.04);
      
      osc.connect(gainNode);
      gainNode.connect(this.masterGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.05);
    } catch (e) {}
  }

  playTerminalType() {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200 + Math.random() * 200, this.ctx.currentTime);
      
      gainNode.gain.setValueAtTime(0.015, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.008);
      
      osc.connect(gainNode);
      gainNode.connect(this.masterGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.01);
    } catch (e) {}
  }

  playScanlineGlitch() {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const bufferSize = this.ctx.sampleRate * 0.15;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noiseNode = this.ctx.createBufferSource();
      noiseNode.buffer = buffer;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1000;
      filter.Q.value = 3.0;
      
      const gainNode = this.ctx.createGain();
      gainNode.gain.setValueAtTime(0.035, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.13);
      
      noiseNode.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(this.masterGain);
      
      noiseNode.start();
    } catch (e) {}
  }

  /* Reefer compressor hum simulation with starter sequence */
  startReeferHum() {
    if (!this.enabled || !this.ctx || !this.masterGain || this.reeferOscs.length > 0) return;
    try {
      const now = this.ctx.currentTime;
      
      // Starter motor cranking sequence (5 ticks)
      for (let i = 0; i < 5; i++) {
        const tickTime = now + i * 0.12;
        const tickOsc = this.ctx.createOscillator();
        const tickGain = this.ctx.createGain();
        
        tickOsc.type = 'triangle';
        tickOsc.frequency.setValueAtTime(90 + i * 12, tickTime);
        
        tickGain.gain.setValueAtTime(0.05, tickTime);
        tickGain.gain.exponentialRampToValueAtTime(0.001, tickTime + 0.05);
        
        tickOsc.connect(tickGain);
        tickGain.connect(this.masterGain);
        tickOsc.start(tickTime);
        tickOsc.stop(tickTime + 0.06);
      }
      
      // Engine Ignition Sequence (Starts at now + 0.6 seconds)
      const roarTime = now + 0.6;
      const roarOsc = this.ctx.createOscillator();
      this.reeferGain = this.ctx.createGain();
      
      roarOsc.type = 'sawtooth';
      roarOsc.frequency.setValueAtTime(30, roarTime);
      roarOsc.frequency.exponentialRampToValueAtTime(160, roarTime + 0.25);
      roarOsc.frequency.exponentialRampToValueAtTime(60, roarTime + 0.6); // settles to 60Hz idle
      
      this.reeferGain.gain.setValueAtTime(0, roarTime);
      this.reeferGain.gain.linearRampToValueAtTime(0.07, roarTime + 0.25);
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(250, roarTime);
      filter.frequency.exponentialRampToValueAtTime(140, roarTime + 0.6);
      
      roarOsc.connect(filter);
      filter.connect(this.reeferGain);
      this.reeferGain.connect(this.masterGain);
      
      roarOsc.start(roarTime);
      
      // Sub-harmonic sine wave
      const subOsc = this.ctx.createOscillator();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(120, roarTime + 0.5);
      
      const subGain = this.ctx.createGain();
      subGain.gain.setValueAtTime(0, roarTime);
      subGain.gain.linearRampToValueAtTime(0.04, roarTime + 0.7);
      
      subOsc.connect(filter);
      filter.connect(subGain);
      subGain.connect(this.masterGain);
      
      subOsc.start(roarTime + 0.5);
      
      this.reeferOscs = [roarOsc, subOsc];
    } catch (e) {
      console.warn("Failed to start reefer hum:", e);
    }
  }

  updateReeferHum(temp: number) {
    if (!this.ctx || this.reeferOscs.length === 0) return;
    try {
      // Map temp [-20C to +15C] -> frequency [90Hz (running hard) to 45Hz (idle)]
      const tempRatio = (temp + 20) / 35; // 0 to 1
      const baseFreq = 90 - tempRatio * 45;
      
      const osc1 = this.reeferOscs[0];
      const osc2 = this.reeferOscs[1];
      if (osc1) {
        osc1.frequency.setTargetAtTime(baseFreq, this.ctx.currentTime, 0.15);
      }
      if (osc2) {
        osc2.frequency.setTargetAtTime(baseFreq * 2.01, this.ctx.currentTime, 0.15);
      }
    } catch (e) {}
  }

  stopReeferHum() {
    if (this.reeferGain && this.ctx) {
      try {
        this.reeferGain.gain.setValueAtTime(this.reeferGain.gain.value, this.ctx.currentTime);
        this.reeferGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
      } catch (e) {}
    }
    setTimeout(() => {
      this.reeferOscs.forEach(osc => {
        try {
          osc.stop();
        } catch (e) {}
      });
      this.reeferOscs = [];
      this.reeferGain = null;
    }, 350);
  }

  /* Biometric verification sound effects */
  playBiometricScan() {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, this.ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(1100, this.ctx.currentTime + 0.5);
      
      gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.03, this.ctx.currentTime + 0.1);
      gainNode.gain.linearRampToValueAtTime(0.03, this.ctx.currentTime + 0.4);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.5);
      
      osc.connect(gainNode);
      gainNode.connect(this.masterGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.55);
    } catch (e) {}
  }

  playBiometricSuccess() {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const now = this.ctx.currentTime;
      [880, 1320].forEach((freq, idx) => {
        const time = now + idx * 0.08;
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        
        gainNode.gain.setValueAtTime(0.04, time);
        gainNode.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
        
        osc.connect(gainNode);
        gainNode.connect(this.masterGain);
        osc.start(time);
        osc.stop(time + 0.07);
      });
    } catch (e) {}
  }

  /* Alarm warning chime sound */
  playWarningChime() {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.linearRampToValueAtTime(240, now + 0.2);
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 350;
      
      gainNode.gain.setValueAtTime(0.08, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      
      osc.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(this.masterGain);
      
      osc.start();
      osc.stop(now + 0.4);
    } catch (e) {}
  }
}

export const broAudio = new CyberAudioEngine();
