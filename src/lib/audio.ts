class CyberAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private enabled: boolean = false;
  private humOscs: OscillatorNode[] = [];
  private humGain: GainNode | null = null;

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
      lpf.frequency.value = 90; // deep bass dampening
      
      this.humGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.humGain.gain.linearRampToValueAtTime(0.06, this.ctx.currentTime + 1.5);
      
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
      osc.frequency.setValueAtTime(600, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(120, this.ctx.currentTime + 0.04);
      
      gainNode.gain.setValueAtTime(0.08, this.ctx.currentTime);
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
      osc.frequency.setValueAtTime(1400 + Math.random() * 200, this.ctx.currentTime);
      
      gainNode.gain.setValueAtTime(0.015, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.008);
      
      osc.connect(gainNode);
      gainNode.connect(this.masterGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.01);
    } catch (e) {}
  }

  playSonarPing(freq = 1000) {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(freq, this.ctx.currentTime);
      filter.Q.value = 12;
      
      gainNode.gain.setValueAtTime(0.2, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 1.0);
      
      osc.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(this.masterGain);
      
      osc.start();
      osc.stop(this.ctx.currentTime + 1.1);
    } catch (e) {}
  }

  playScanlineGlitch() {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    try {
      const bufferSize = this.ctx.sampleRate * 0.12;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noiseNode = this.ctx.createBufferSource();
      noiseNode.buffer = buffer;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1200;
      filter.Q.value = 2.0;
      
      const gainNode = this.ctx.createGain();
      gainNode.gain.setValueAtTime(0.03, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.11);
      
      noiseNode.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(this.masterGain);
      
      noiseNode.start();
    } catch (e) {}
  }
}

export const broAudio = new CyberAudioEngine();
