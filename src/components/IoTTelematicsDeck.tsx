import React, { useState, useEffect } from 'react';

export default function IoTTelematicsDeck() {
  // Dry Van State
  const [doorClosed, setDoorClosed] = useState(true);
  const [volume, setVolume] = useState(85); // percentage cargo space occupied

  // Reefer State
  const [reeferTemp, setReeferTemp] = useState(-18.0);
  const [reeferSetpoint] = useState(-18.0);
  const [reeferFuel, setReeferFuel] = useState(94);

  // Flatbed State
  const [axleWeight, setAxleWeight] = useState(28500);

  // Automatic slight fluctuations to feel "live"
  useEffect(() => {
    const interval = setInterval(() => {
      // Fluctuate temp slightly
      setReeferTemp(prev => {
        const drift = (Math.random() - 0.5) * 0.2;
        return parseFloat((prev + drift).toFixed(1));
      });
      // Fluctuate volume slightly (cargo shifting simulation)
      setVolume(prev => Math.max(80, Math.min(90, prev + (Math.random() > 0.5 ? 1 : -1))));
      // Drifting fuel level down slowly
      setReeferFuel(prev => Math.max(5, prev - 0.05));
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const tempDeviation = Math.abs(reeferTemp - reeferSetpoint);
  const isTempAlert = tempDeviation > 2.0;
  const isWeightAlert = axleWeight > 36287; // kg threshold

  return (
    <div className="w-full flex flex-col space-y-6">
      {/* Container header */}
      <div className="flex justify-between items-center font-mono text-[10px] text-slate-500">
        <span>MODULE_03 // IoT_TELEMATICS</span>
        <span className="text-bro-cyan font-bold flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-bro-cyan animate-pulse"></span>
          REAL-TIME TELEMETRY ENGAGED
        </span>
      </div>

      {/* Grid of Equipment Modules */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Dry Van Module */}
        <div className="bg-bro-obsidian/80 border border-slate-900 rounded p-5 space-y-4 hover:border-bro-cyan/35 transition-colors relative overflow-hidden cyber-corners">
          <div className="flex justify-between items-center border-b border-slate-900 pb-2">
            <span className="text-xs font-bold font-mono text-white">DIV_01 // DRY VAN</span>
            <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${
              doorClosed ? 'text-bro-cyan bg-bro-cyan/10 border border-bro-cyan/20' : 'text-bro-crimson bg-bro-crimson/10 border border-bro-crimson/20'
            }`}>
              {doorClosed ? 'SECURE' : 'ALERT'}
            </span>
          </div>

          {/* Door graphics swing gate */}
          <div className="flex flex-col items-center justify-center py-2 space-y-2">
            <div className="w-16 h-12 border border-slate-800 rounded bg-bro-steel/40 flex items-center justify-between p-1 relative overflow-hidden">
              {/* Swing doors */}
              <div 
                className={`w-[45%] h-full bg-bro-gold/25 border-r border-bro-gold/50 origin-left transition-transform duration-500 ${
                  doorClosed ? 'rotate-y-0' : '-rotate-y-120 opacity-30'
                }`}
                style={{ transformStyle: 'preserve-3d' }}
              ></div>
              <div 
                className={`w-[45%] h-full bg-bro-gold/25 border-l border-bro-gold/50 origin-right transition-transform duration-500 ${
                  doorClosed ? 'rotate-y-0' : 'rotate-y-120 opacity-30'
                }`}
                style={{ transformStyle: 'preserve-3d' }}
              ></div>
            </div>
            
            <button 
              type="button"
              onClick={() => setDoorClosed(!doorClosed)}
              className="text-[9px] font-mono px-3 py-1 border border-slate-800 rounded hover:border-bro-cyan/40 hover:text-white transition-colors"
            >
              Toggle Cargo Door
            </button>
          </div>

          <div className="space-y-2 font-mono text-[9px] text-slate-400">
            <div className="flex justify-between">
              <span>DOOR LOCK SENSOR:</span>
              <span className={doorClosed ? 'text-white' : 'text-bro-crimson font-bold'}>
                {doorClosed ? 'CLOSED / LOCKED' : 'OPEN / COMPROMISED'}
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span>CARGO VOL CAPACITY:</span>
                <span className="text-bro-cyan">{volume}% USED</span>
              </div>
              <div className="w-full h-1 bg-[#030307] rounded-full overflow-hidden">
                <div className="h-full bg-bro-cyan transition-all duration-300" style={{ width: `${volume}%` }}></div>
              </div>
            </div>
          </div>
        </div>

        {/* Reefer Cold Chain Module */}
        <div className={`bg-bro-obsidian/80 border rounded p-5 space-y-4 transition-colors relative overflow-hidden cyber-corners ${
          isTempAlert ? 'border-bro-crimson/50 bg-bro-crimson/5' : 'border-slate-900 hover:border-bro-cyan/35'
        }`}>
          <div className="flex justify-between items-center border-b border-slate-900 pb-2">
            <span className="text-xs font-bold font-mono text-white">DIV_02 // REEFER</span>
            <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${
              isTempAlert ? 'text-bro-crimson bg-bro-crimson/10 border border-bro-crimson/20 animate-pulse' : 'text-bro-cyan bg-bro-cyan/10 border border-bro-cyan/20'
            }`}>
              {isTempAlert ? 'TEMP DEVIATION' : 'OPTIMAL'}
            </span>
          </div>

          {/* Temperature slider control */}
          <div className="space-y-2 font-mono text-[9px]">
            <div className="flex justify-between items-center">
              <span className="text-slate-450">REEFER TEMP ADJUST:</span>
              <span className={`text-xs font-bold ${isTempAlert ? 'text-bro-crimson glow-text-crimson' : 'text-bro-cyan'}`}>
                {reeferTemp.toFixed(1)}°C
              </span>
            </div>
            <input 
              type="range"
              min="-28"
              max="-5"
              step="0.5"
              value={reeferTemp}
              onChange={(e) => setReeferTemp(parseFloat(e.target.value))}
              className="w-full h-1 bg-[#030307] rounded-lg appearance-none cursor-pointer accent-bro-cyan" 
            />
            <div className="flex justify-between text-[7.5px] text-slate-600">
              <span>FREEZER (-28°C)</span>
              <span>SETPOINT: {reeferSetpoint}°C</span>
              <span>COOL (-5°C)</span>
            </div>
          </div>

          {/* Status info */}
          <div className="space-y-2 font-mono text-[9px] text-slate-400">
            <div className="flex justify-between">
              <span>COMPRESSOR CYCLE:</span>
              <span className="text-white">FULL DURATION ACTIVE</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span>DIESEL FUEL RESERVES:</span>
                <span className="text-bro-gold">{Math.round(reeferFuel)}% (48h remaining)</span>
              </div>
              <div className="w-full h-1 bg-[#030307] rounded-full overflow-hidden">
                <div className="h-full bg-bro-gold transition-all duration-300" style={{ width: `${reeferFuel}%` }}></div>
              </div>
            </div>
          </div>
        </div>

        {/* Flatbed Division Module */}
        <div className={`bg-bro-obsidian/80 border rounded p-5 space-y-4 transition-colors relative overflow-hidden cyber-corners-gold ${
          isWeightAlert ? 'border-bro-crimson/50 bg-bro-crimson/5' : 'border-slate-900 hover:border-bro-gold/35'
        }`}>
          <div className="flex justify-between items-center border-b border-slate-900 pb-2">
            <span className="text-xs font-bold font-mono text-white">DIV_03 // FLATBED</span>
            <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${
              isWeightAlert ? 'text-bro-crimson bg-bro-crimson/10 border border-bro-crimson/20 animate-pulse' : 'text-bro-gold bg-bro-gold/10 border border-bro-gold/20'
            }`}>
              {isWeightAlert ? 'OVERLOAD' : 'MONITORING'}
            </span>
          </div>

          {/* Load weight controller */}
          <div className="space-y-2 font-mono text-[9px]">
            <div className="flex justify-between items-center">
              <span className="text-slate-450">AXLE WEIGHT LOAD:</span>
              <span className={`text-xs font-bold ${isWeightAlert ? 'text-bro-crimson glow-text-crimson' : 'text-bro-gold glow-text-gold'}`}>
                {axleWeight.toLocaleString()} KG
              </span>
            </div>
            <input 
              type="range"
              min="20000"
              max="40000"
              step="500"
              value={axleWeight}
              onChange={(e) => setAxleWeight(parseInt(e.target.value))}
              className="w-full h-1 bg-[#030307] rounded-lg appearance-none cursor-pointer accent-bro-gold" 
            />
            <div className="flex justify-between text-[7.5px] text-slate-600">
              <span>LIGHT (20K)</span>
              <span>LEGAL LIMIT: 36,287 KG</span>
              <span>HEAVY (40K)</span>
            </div>
          </div>

          {/* Status info */}
          <div className="space-y-2 font-mono text-[9px] text-slate-450">
            <div className="flex justify-between">
              <span>DECK STRESS RATING:</span>
              <span className={isWeightAlert ? 'text-bro-crimson font-bold' : 'text-white'}>
                {isWeightAlert ? 'CRITICAL AXLE LOAD' : '0.05% FLEX (NORMAL)'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>TPMS TYRE PRESSURE:</span>
              <span className="text-bro-cyan font-bold">110 PSI // STABLE</span>
            </div>
          </div>
        </div>

      </div>

      {/* Warning Flash alerts */}
      {(isTempAlert || isWeightAlert || !doorClosed) && (
        <div className="p-3 bg-bro-crimson/10 border border-bro-crimson/30 rounded font-mono text-[9.5px] text-bro-crimson flex flex-col gap-1.5 animate-pulse">
          {!doorClosed && (
            <div>⚠️ [WARNING_ALERT] CARGO BAY LOCK DISCONNECTED. IMMINENT OUTLET BREACH DETECTED.</div>
          )}
          {isTempAlert && (
            <div>⚠️ [TEMPERATURE_ALERT] REEFER TEMPERATURE ({reeferTemp}°C) EXCEEDS CRITICAL DEV LEVEL FROM SETPOINT (-18.0°C).</div>
          )}
          {isWeightAlert && (
            <div>⚠️ [OVERLOAD_ALERT] FLATBED AXLE LOAD ({axleWeight.toLocaleString()} KG) EXCEEDS 36,287 KG REGULATORY THRESHOLD. PERMITS MANDATORY.</div>
          )}
        </div>
      )}
    </div>
  );
}
