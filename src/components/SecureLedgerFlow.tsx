import React, { useState } from 'react';

// Browser-native SHA-256 helper
async function generateHash(message: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return '0000000000000000000000000000000000000000000000000000000000000000';
  }
}

export default function SecureLedgerFlow() {
  const [step, setStep] = useState(1);
  const [signatures, setSignatures] = useState({
    keyA: '',
    keyB: '',
    keyC: '',
    finalHash: ''
  });
  const [signing, setSigning] = useState(false);

  const handleSign = async (keyType: 'keyA' | 'keyB' | 'keyC') => {
    setSigning(true);
    let payload = '';
    let updatedSigs = { ...signatures };

    if (keyType === 'keyA') {
      payload = `SHIPPER_BOOKING_9948_TIME_${Date.now()}`;
      const hash = await generateHash(payload);
      updatedSigs.keyA = hash;
      setStep(2);
    } else if (keyType === 'keyB') {
      payload = `DRIVER_PICKUP_9948_PARENT_${signatures.keyA}_TIME_${Date.now()}`;
      const hash = await generateHash(payload);
      updatedSigs.keyB = hash;
      setStep(3);
    } else if (keyType === 'keyC') {
      payload = `CONSIGNEE_DELIVERY_9948_PARENT_${signatures.keyB}_TIME_${Date.now()}`;
      const hash = await generateHash(payload);
      updatedSigs.keyC = hash;
      
      // Calculate terminal immutable state
      const finalPayload = hash + signatures.keyA + signatures.keyB;
      const finalHashResult = await generateHash(finalPayload);
      updatedSigs.finalHash = finalHashResult;
      setStep(4);
    }

    // Simulate cryptographic processing time
    setTimeout(() => {
      setSignatures(updatedSigs);
      setSigning(false);
    }, 800);
  };

  const resetLedger = () => {
    setStep(1);
    setSignatures({
      keyA: '',
      keyB: '',
      keyC: '',
      finalHash: ''
    });
  };

  return (
    <div className="w-full flex flex-col space-y-6">
      {/* Module Title */}
      <div className="flex justify-between items-center font-mono text-[10px] text-slate-500">
        <span>MODULE_04 // SECURE_LEDGER_INTEGRATION</span>
        <span className="text-bro-gold font-bold flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-bro-gold animate-pulse"></span>
          LEDGER_SECURE_SYNC
        </span>
      </div>

      {/* Interactive Visual Stepper Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        
        {/* Step 1: Initialization */}
        <div className={`p-4 bg-bro-obsidian/70 border rounded flex flex-col justify-between space-y-3 transition-all duration-300 relative overflow-hidden ${
          step === 1 ? 'border-bro-cyan shadow-neon-glow scale-[1.01]' : 'border-slate-900 opacity-60'
        }`}>
          <div className="space-y-1">
            <span className="text-[8px] font-mono text-slate-500">STEP_01 // SHIPPER_UPLINK</span>
            <h4 className="text-xs font-bold text-white font-mono uppercase">1. Init Booking</h4>
            <p className="text-[8.5px] text-slate-400 font-sans leading-relaxed">
              Booking generated on private ledger. Shipper signs payload with Key A.
            </p>
          </div>
          {signatures.keyA ? (
            <div className="font-mono text-[7px] text-bro-cyan bg-bro-cyan/5 p-1 border border-bro-cyan/25 rounded break-all">
              SIG_A: {signatures.keyA.substring(0, 16)}...
            </div>
          ) : (
            <button 
              onClick={() => handleSign('keyA')} 
              disabled={step !== 1 || signing}
              className="w-full py-1.5 bg-bro-cyan text-black font-bold font-mono text-[9px] uppercase tracking-wider rounded hover:bg-bro-cyan/90 disabled:opacity-30 transition-all cursor-pointer"
            >
              {signing && step === 1 ? 'SIGNING...' : 'SIGN WITH KEY A'}
            </button>
          )}
        </div>

        {/* Step 2: Driver Custody Transfer */}
        <div className={`p-4 bg-bro-obsidian/70 border rounded flex flex-col justify-between space-y-3 transition-all duration-300 relative overflow-hidden ${
          step === 2 ? 'border-bro-cyan shadow-neon-glow scale-[1.01]' : 'border-slate-900 opacity-60'
        }`}>
          <div className="space-y-1">
            <span className="text-[8px] font-mono text-slate-500">STEP_02 // CARRIER_UPLINK</span>
            <h4 className="text-xs font-bold text-white font-mono uppercase">2. Pickup Scan</h4>
            <p className="text-[8.5px] text-slate-400 font-sans leading-relaxed">
              Upon pickup, driver scans digital eBOL receipt with Key B, appending location coordinates.
            </p>
          </div>
          {signatures.keyB ? (
            <div className="font-mono text-[7px] text-bro-cyan bg-bro-cyan/5 p-1 border border-bro-cyan/25 rounded break-all">
              SIG_B: {signatures.keyB.substring(0, 16)}...
            </div>
          ) : (
            <button 
              onClick={() => handleSign('keyB')} 
              disabled={step !== 2 || signing}
              className="w-full py-1.5 bg-bro-cyan text-black font-bold font-mono text-[9px] uppercase tracking-wider rounded hover:bg-bro-cyan/90 disabled:opacity-30 transition-all cursor-pointer"
            >
              {signing && step === 2 ? 'SIGNING...' : 'SIGN WITH KEY B'}
            </button>
          )}
        </div>

        {/* Step 3: In-Transit Integrity */}
        <div className={`p-4 bg-bro-obsidian/70 border rounded flex flex-col justify-between space-y-3 transition-all duration-300 relative overflow-hidden ${
          step === 3 ? 'border-bro-cyan shadow-neon-glow scale-[1.01]' : 'border-slate-900 opacity-60'
        }`}>
          <div className="space-y-1">
            <span className="text-[8px] font-mono text-slate-500">STEP_03 // LEDGER_STREAM</span>
            <h4 className="text-xs font-bold text-white font-mono uppercase">3. In-Transit Sync</h4>
            <p className="text-[8.5px] text-slate-400 font-sans leading-relaxed">
              Consignee verifies receipt using Key C, terminating the shipment lifecycle block.
            </p>
          </div>
          {signatures.keyC ? (
            <div className="font-mono text-[7px] text-bro-cyan bg-bro-cyan/5 p-1 border border-bro-cyan/25 rounded break-all">
              SIG_C: {signatures.keyC.substring(0, 16)}...
            </div>
          ) : (
            <button 
              onClick={() => handleSign('keyC')} 
              disabled={step !== 3 || signing}
              className="w-full py-1.5 bg-bro-cyan text-black font-bold font-mono text-[9px] uppercase tracking-wider rounded hover:bg-bro-cyan/90 disabled:opacity-30 transition-all cursor-pointer"
            >
              {signing && step === 3 ? 'SIGNING...' : 'SIGN WITH KEY C'}
            </button>
          )}
        </div>

        {/* Step 4: Final Immutable Block */}
        <div className={`p-4 bg-bro-obsidian/70 border rounded flex flex-col justify-between space-y-3 transition-all duration-300 relative overflow-hidden ${
          step === 4 ? 'border-bro-gold shadow-[0_0_15px_rgba(255,170,0,0.25)] scale-[1.01] cyber-corners-gold' : 'border-slate-900 opacity-60'
        }`}>
          <div className="space-y-1">
            <span className="text-[8px] font-mono text-slate-500">STEP_04 // IMMUTABLE_STATE</span>
            <h4 className="text-xs font-bold text-white font-mono uppercase">4. Block Finalized</h4>
            <p className="text-[8.5px] text-slate-450 font-sans leading-relaxed">
              Cryptographic chain verification complete. Smart contract settled.
            </p>
          </div>
          {signatures.finalHash ? (
            <div className="space-y-1.5">
              <div className="font-mono text-[7px] text-bro-gold bg-bro-gold/5 p-1 border border-bro-gold/25 rounded break-all">
                HASH: {signatures.finalHash.substring(0, 24)}...
              </div>
              <button 
                onClick={resetLedger}
                className="w-full py-1.5 border border-bro-gold text-bro-gold hover:bg-bro-gold/10 font-bold font-mono text-[8px] uppercase tracking-wider rounded transition-all cursor-pointer"
              >
                RESET CHAIN FLOW
              </button>
            </div>
          ) : (
            <div className="w-full py-1.5 border border-dashed border-slate-800 text-slate-650 text-center font-mono text-[9px] uppercase rounded">
              Awaiting Signatures
            </div>
          )}
        </div>

      </div>

      {/* Cryptographic Hash Ledger Terminal */}
      <div className="bg-[#030307]/50 border border-slate-900 rounded p-4 font-mono text-[9.5px] text-slate-450 space-y-2 relative">
        <div className="laser-line"></div>
        <div className="flex justify-between items-center text-[8px] text-slate-650 border-b border-slate-900 pb-1">
          <span>LEDGER BLOCKCHAIN TELEMETRY</span>
          <span className="text-bro-cyan font-bold">// SECURE_LEDGER_SYSTEM</span>
        </div>
        <div className="space-y-1 font-mono">
          <div className="flex justify-between">
            <span>[LEDGER] genesis_block:</span>
            <span className="text-slate-600">000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f</span>
          </div>
          {signatures.keyA && (
            <div className="flex justify-between text-bro-cyan animate-pulse">
              <span>[KEY_A] shipper_payload_hash:</span>
              <span>{signatures.keyA}</span>
            </div>
          )}
          {signatures.keyB && (
            <div className="flex justify-between text-bro-cyan animate-pulse">
              <span>[KEY_B] driver_verification_hash:</span>
              <span>{signatures.keyB}</span>
            </div>
          )}
          {signatures.keyC && (
            <div className="flex justify-between text-bro-cyan animate-pulse">
              <span>[KEY_C] consignee_pod_hash:</span>
              <span>{signatures.keyC}</span>
            </div>
          )}
          {signatures.finalHash && (
            <div className="flex justify-between text-bro-gold font-bold animate-pulse">
              <span>[BLOCK] consensus_state_merkle_root:</span>
              <span>{signatures.finalHash}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
