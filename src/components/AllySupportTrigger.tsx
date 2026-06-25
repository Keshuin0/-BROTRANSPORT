import React, { useState, useEffect, useRef } from 'react';

export default function AllySupportTrigger() {
  const [isActive, setIsActive] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const logIntervalRef = useRef<any>(null);
  const soundIntervalRef = useRef<any>(null);

  const mockLogSequence = [
    "[SYSTEM] INITIATING BROADCAST TO THE BROTHERHOOD NODE...",
    "[UPLINK] SECURING SATELLITE CHANNELS ON #BROP-NET...",
    "[UPLINK] HANDSHAKE ENCRYPTED VIA COMPANION PROTOCOL (SECURE_256)...",
    "[GPS] BROADCASTING PEI COMMAND CENTER LATITUDE & LONGITUDE...",
    "[LOGISTICS] VEHICLE FLEET INVENTORY ROTATED FOR PRIORITY INTERCEPT...",
    "[NETWORK] DISPATCHING B.R.O ALLY TEAM BEACONS...",
    "[SYSTEM] BHAI AND DON COORDINATORS APPOINTED...",
    "[STATUS] BROTHERHOOD ACTIVE. A BRO IN NEED IS A BRO INDEED.",
    "[LIVE] UPLINK ESTABLISHED. ELITE OPERATIONAL LOYALTY ENGAGED."
  ];

  // Handle synthesized sound sweep
  const startTelemetrySound = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      const ctx = new AudioContextClass();
      audioCtxRef.current = ctx;

      const osc = ctx.createOscillator();
      oscillatorRef.current = osc;

      const gain = ctx.createGain();
      gainNodeRef.current = gain;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(450, ctx.currentTime);
      gain.gain.setValueAtTime(0.04, ctx.currentTime); // Low volume (4% gain) to respect ears

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      let toggle = false;
      soundIntervalRef.current = setInterval(() => {
        if (!oscillatorRef.current || !audioCtxRef.current) return;
        const time = audioCtxRef.current.currentTime;
        // Sweeping sonar/siren sweep: alternates frequency
        const freq = toggle ? 700 : 450;
        oscillatorRef.current.frequency.setValueAtTime(freq, time);
        oscillatorRef.current.frequency.exponentialRampToValueAtTime(toggle ? 450 : 250, time + 0.35);
        toggle = !toggle;
      }, 450);

    } catch (e) {
      console.warn("Web Audio API not supported or user gesture required.", e);
    }
  };

  const stopTelemetrySound = () => {
    if (soundIntervalRef.current) {
      clearInterval(soundIntervalRef.current);
      soundIntervalRef.current = null;
    }
    if (oscillatorRef.current) {
      try { oscillatorRef.current.stop(); } catch(e){}
      oscillatorRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch(e){}
      audioCtxRef.current = null;
    }
  };

  const toggleHotline = () => {
    const nextState = !isActive;
    setIsActive(nextState);
    if (nextState) {
      sessionStorage.setItem('bro_hotline_active', 'true');
      setLogs([`[SYSTEM] ALLY SOS TRIGGERED AT ${new Date().toLocaleTimeString()}`]);
      startTelemetrySound();
    } else {
      sessionStorage.setItem('bro_hotline_active', 'false');
      stopTelemetrySound();
      setLogs([]);
    }
  };

  // Log sequence animation
  useEffect(() => {
    if (isActive) {
      let index = 0;
      logIntervalRef.current = setInterval(() => {
        if (index < mockLogSequence.length) {
          setLogs(prev => [...prev, mockLogSequence[index]]);
          index++;
        } else {
          clearInterval(logIntervalRef.current);
        }
      }, 700);
    } else {
      if (logIntervalRef.current) clearInterval(logIntervalRef.current);
    }
    return () => {
      if (logIntervalRef.current) clearInterval(logIntervalRef.current);
    };
  }, [isActive]);

  // Clean up sounds on unmount
  useEffect(() => {
    // Load persisted state (optional)
    const persisted = sessionStorage.getItem('bro_hotline_active') === 'true';
    if (persisted && !isActive) {
      // Just visually sync, do not autoplay sound immediately due to browser policies
      setIsActive(true);
      setLogs(["[SYSTEM] ALLY HOTLINE COMPROMISED. RE-ESTABLISHING TRANS-BORDER LOGS..."]);
    }
    return () => {
      stopTelemetrySound();
    };
  }, []);

  return (
    <>
      {/* SOS Button inside Header */}
      <button 
        onClick={toggleHotline}
        className={`relative flex items-center gap-3 px-5 py-2.5 border transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden font-mono text-[10px] tracking-wider uppercase group cursor-pointer select-none ${
          isActive 
            ? 'bg-bro-crimson border-bro-crimson text-white shadow-neon-alert animate-pulse'
            : 'bg-transparent border-bro-cyan/35 text-bro-cyan hover:border-bro-cyan hover:shadow-neon-glow hover:text-white'
        }`}
      >
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-cyber-grid bg-[size:8px_8px] pointer-events-none"></div>
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isActive ? 'bg-white' : 'bg-bro-cyan'}`}></span>
          <span className={`relative inline-flex rounded-full h-2 w-2 ${isActive ? 'bg-white' : 'bg-bro-cyan'}`}></span>
        </span>
        <span className="relative z-10 font-bold tracking-widest">
          {isActive ? 'ALLY HOTLINE ACTIVE' : 'REQUEST A BRO'}
        </span>
      </button>

      {/* EMERGENCY FULL SCREEN TAKEOVER OVERLAY */}
      {isActive && (
        <div className="fixed inset-0 z-[9999] bg-[#030307]/95 backdrop-blur-md flex items-center justify-center p-4 md:p-6 overflow-hidden scanlines">
          {/* Pulsing alarm red light sweep */}
          <div className="absolute inset-0 bg-transparent animate-siren pointer-events-none"></div>
          <div className="absolute inset-0 bg-cyber-grid opacity-10 pointer-events-none"></div>
          
          <div className="relative w-full max-w-2xl glass-panel border-bro-crimson/50 shadow-[0_0_50px_rgba(255,0,85,0.25)] rounded p-6 md:p-8 flex flex-col space-y-6 cyber-corners animate-glitch">
            {/* Header / Warning Alert */}
            <div className="flex flex-col items-center text-center space-y-2 border-b border-bro-crimson/30 pb-4">
              <div className="flex items-center gap-3">
                <span className="h-4 w-4 bg-bro-crimson rounded-full animate-ping flex items-center justify-center shrink-0">
                  <span className="h-2.5 w-2.5 bg-white rounded-full"></span>
                </span>
                <h2 className="text-xl sm:text-2xl font-black font-display text-white tracking-widest glow-text-crimson uppercase">
                  Calling the Brotherhood
                </h2>
              </div>
              <span className="font-mono text-xs text-bro-crimson font-bold tracking-widest">// UPLINK ACTIVE // DIRECT OPERATIONAL INTERACTION</span>
            </div>

            {/* Slogan Frame inside terminal */}
            <div className="text-center font-mono py-2 bg-bro-crimson/5 border border-bro-crimson/20 rounded">
              <span className="text-white text-xs font-bold block tracking-widest">"A BRO IN NEED IS A BRO INDEED"</span>
            </div>

            {/* Live Terminal Diagnostic Logs */}
            <div className="flex-1 min-h-[180px] bg-[#030307] border border-slate-900 rounded p-4 font-mono text-[10px] text-slate-350 overflow-y-auto space-y-2 relative select-text">
              <div className="laser-line"></div>
              {logs.map((log, idx) => (
                <div 
                  key={idx} 
                  className={`leading-relaxed border-l-2 pl-2 ${
                    log.includes('[SYSTEM]') 
                      ? 'border-bro-gold text-bro-gold' 
                      : log.includes('[STATUS]') 
                      ? 'border-bro-crimson text-white font-bold'
                      : log.includes('[LIVE]')
                      ? 'border-bro-cyan text-bro-cyan font-bold glow-text-cyan'
                      : 'border-slate-800 text-slate-400'
                  }`}
                >
                  {log}
                </div>
              ))}
              <div className="h-3 w-1.5 bg-bro-cyan animate-pulse inline-block ml-1"></div>
            </div>

            {/* Control Actions */}
            <div className="flex flex-col sm:flex-row gap-4 pt-4 border-t border-slate-900/60">
              <a 
                href="tel:18005552767" // simulated brotherhood dispatch phone
                className="flex-1 py-3 bg-bro-crimson text-white font-bold rounded font-mono text-[11px] uppercase tracking-wider text-center shadow-[0_0_15px_rgba(255,0,85,0.4)] hover:bg-bro-crimson/95 hover:shadow-[0_0_25px_rgba(255,0,85,0.6)] transition-all duration-300"
              >
                UPLINK DIRECT DISPATCH (VOICE)
              </a>
              <button 
                onClick={toggleHotline}
                className="flex-1 py-3 border border-slate-800 hover:border-bro-cyan/30 text-slate-400 hover:text-white rounded font-mono text-[11px] uppercase tracking-wider transition-colors duration-300 cursor-pointer"
              >
                DISCONNECT HOTLINE
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
