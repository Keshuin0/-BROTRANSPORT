import React, { useState } from 'react';

const defaultManifest = {
  manifestType: "ACE_EManifest",
  scac: "BROP",
  tripNumber: "BROP20261024A",
  portOfEntry: "0115",
  estimatedArrival: "2026-10-24T14:30:00Z",
  conveyance: {
    vin: "1FVACWDB2GHXXXXXX",
    plate: "PE9948",
    state: "PE"
  },
  crew: [
    {
      fastCardNumber: "980012345",
      firstName: "Robert",
      lastName: "MacDonald",
      dateOfBirth: "1982-04-12"
    }
  ],
  shipments: [
    {
      papsNumber: "BROP8843921",
      shipper: {
        name: "PEI Potato Co-Op",
        address: "100 Spud Road, Summerside, PE"
      },
      consignee: {
        name: "Boston Distribution Hub",
        address: "45 Market Blvd, Boston, MA"
      },
      commodity: "Potatoes",
      weight: 22679.6,
      weightUnit: "KG",
      quantity: 24,
      packageType: "Pallet"
    }
  ]
};

export default function TransborderPipeline() {
  const [manifestStr, setManifestStr] = useState(JSON.stringify(defaultManifest, null, 2));
  const [logs, setLogs] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const runValidation = () => {
    setScanning(true);
    setStatus('idle');
    setLogs(["[SYSTEM] INITIATING MANIFEST STRUCTURE COMPLIANCE CHECK...", "[ABI-GATE] PARSING JSON PAYLOAD..."]);

    setTimeout(() => {
      try {
        const obj = JSON.parse(manifestStr);
        const newLogs = [...logs];
        newLogs.push(`[SCHEMA] Manifest Type: ${obj.manifestType || 'UNKNOWN'}`);

        // Validate SCAC
        if (obj.scac === 'BROP') {
          newLogs.push("[SCAC] Standard Carrier Alpha Code matched: BROP (Secure Carrier Status).");
        } else {
          newLogs.push(`[WARNING] Carrier SCAC '${obj.scac}' is not registered under #BRO fleet.`);
        }

        // Validate Crew Fast Card
        const fastCard = obj.crew?.[0]?.fastCardNumber;
        if (fastCard && /^\d{9}$/.test(fastCard.toString())) {
          newLogs.push(`[CREW] Driver FAST Card ${fastCard} format verified. CBP Pre-Screen approved.`);
        } else {
          throw new Error(`Invalid FAST Card format: '${fastCard}'. Must be exactly 9 numeric digits.`);
        }

        // Validate Weight
        const weight = obj.shipments?.[0]?.weight;
        if (weight && weight > 0 && weight <= 45000) {
          newLogs.push(`[CARGO] Payload Weight: ${weight} ${obj.shipments[0].weightUnit || 'KG'}. Legal limits respected.`);
        } else if (weight > 45000) {
          newLogs.push(`[WARNING] Cargo Weight exceeds standard legal limits. Permits mandatory.`);
        }

        newLogs.push("[API] Transmitting vehicle and manifest to CBP Descartes endpoint...");
        newLogs.push("[SUCCESS] manifest cleared by Automated Broker Interface (ABI). ACE Manifest generated.");
        
        setLogs(newLogs);
        setStatus('success');
      } catch (err: any) {
        setLogs(prev => [
          ...prev, 
          `[PARSING_ERROR] Validation failed. Reason: ${err.message}`,
          "[CRITICAL] ABI transmission aborted. Manifest rejected by gatekeeper."
        ]);
        setStatus('error');
      } finally {
        setScanning(false);
      }
    }, 1500);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setManifestStr(e.target.value);
  };

  return (
    <div className="w-full flex flex-col lg:flex-row gap-6 items-stretch">
      {/* JSON Schema Editor */}
      <div className="flex-1 bg-bro-obsidian/75 border border-slate-900 rounded p-5 space-y-4 flex flex-col justify-between hover:border-bro-cyan/35 transition-colors relative overflow-hidden cyber-corners">
        <div className="flex justify-between items-center border-b border-slate-900 pb-2 font-mono text-[10px]">
          <span className="text-white font-bold">ACE_eMANIFEST_JSON_SCHEMA</span>
          <span className="text-bro-cyan">// LIVE_EDITOR</span>
        </div>
        
        <div className="relative flex-1 min-h-[280px] font-mono text-[9.5px]">
          {scanning && <div className="laser-line"></div>}
          <textarea
            value={manifestStr}
            onChange={handleTextChange}
            spellCheck="false"
            className="w-full h-full min-h-[280px] bg-[#030307]/80 text-cyan-400 border border-slate-950 rounded p-3 font-mono text-[9px] focus:outline-none focus:border-bro-cyan transition-colors resize-none select-text"
          />
        </div>

        <div className="flex justify-between items-center pt-2 font-mono text-[9px]">
          <span className="text-slate-500">Edit fields directly to test CBP validator thresholds.</span>
          <button
            onClick={runValidation}
            disabled={scanning}
            className="px-4 py-2 bg-bro-cyan text-black font-bold uppercase tracking-wider rounded hover:bg-bro-cyan/90 transition-colors cursor-pointer"
          >
            {scanning ? 'SCANNING...' : 'SCAN & VALIDATE'}
          </button>
        </div>
      </div>

      {/* Terminal Compliance Validator Logs */}
      <div className="w-full lg:w-[320px] bg-bro-obsidian/75 border border-slate-900 rounded p-5 flex flex-col justify-between hover:border-bro-cyan/35 transition-colors relative overflow-hidden cyber-corners-gold">
        <div className="flex justify-between items-center border-b border-slate-900 pb-2 font-mono text-[10px]">
          <span className="text-white font-bold">COMPLIANCE_TERMINAL</span>
          <span className={`font-bold px-2 py-0.5 rounded ${
            status === 'success' ? 'text-bro-cyan bg-bro-cyan/10 border border-bro-cyan/20 animate-pulse' :
            status === 'error' ? 'text-bro-crimson bg-bro-crimson/10 border border-bro-crimson/20' : 'text-slate-500 bg-slate-900/50'
          }`}>
            {status === 'success' ? 'CBP_COMPLIANT' : status === 'error' ? 'REJECTED' : 'AWAITING_SCAN'}
          </span>
        </div>

        {/* Live log feed */}
        <div className="flex-1 my-4 bg-[#030307]/90 border border-slate-950 rounded p-3 font-mono text-[9px] text-slate-400 overflow-y-auto space-y-1.5 min-h-[200px]">
          {logs.length === 0 ? (
            <div className="text-slate-600 italic">[Awaiting schema validation execution...]</div>
          ) : (
            logs.map((log, idx) => (
              <div 
                key={idx} 
                className={`leading-relaxed border-l pl-1.5 ${
                  log.includes('[SUCCESS]') ? 'border-bro-cyan text-bro-cyan font-bold' :
                  log.includes('[WARNING]') ? 'border-bro-gold text-bro-gold' :
                  log.includes('[CRITICAL]') || log.includes('[PARSING_ERROR]') ? 'border-bro-crimson text-bro-crimson font-bold' :
                  'border-slate-800 text-slate-500'
                }`}
              >
                {log}
              </div>
            ))
          )}
          {scanning && (
            <div className="text-bro-cyan animate-pulse">Running checksum routines...</div>
          )}
        </div>

        <div className="border-t border-slate-900/60 pt-3 flex justify-between font-mono text-[8px] text-slate-500">
          <span>PORT 0115 // DESCARTES API</span>
          <span>100% REGULATORY SYNC</span>
        </div>
      </div>
    </div>
  );
}
