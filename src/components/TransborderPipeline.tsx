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

  const runValidation = async () => {
    setScanning(true);
    setStatus('idle');
    const initialLogs = [
      "[SYSTEM] INITIATING MANIFEST STRUCTURE COMPLIANCE CHECK...",
      "[ABI-GATE] TRANSMITTING PAYLOAD TO CLOUDFLARE WORKER COMPLIANCE PIPELINE..."
    ];
    setLogs(initialLogs);

    const apiUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://127.0.0.1:8787/api/customs/validate'
      : 'https://brotransport-edge-api.keshuin0.workers.dev/api/customs/validate';

    try {
      const obj = JSON.parse(manifestStr);
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj)
      });
      const data = await res.json();
      
      const newLogs = [...initialLogs];
      if (!res.ok) {
        throw new Error(data.error || 'Schema validation parse rejection.');
      }

      newLogs.push(`[SCHEMA] Manifest Model Verified. referenceId: ${data.manifestId}`);
      if (data.warnings && data.warnings.length > 0) {
        data.warnings.forEach((warn: string) => {
          newLogs.push(`[WARNING] ${warn}`);
        });
      } else {
        newLogs.push("[COMPLIANT] Zero anomalies detected in cargo, vehicle, or crew credentials.");
      }
      newLogs.push("[SUCCESS] manifest cleared by Automated Broker Interface (ABI). ACE Manifest generated.");
      
      setLogs(newLogs);
      setStatus(data.compliant ? 'success' : 'error');
    } catch (err: any) {
      setLogs(prev => [
        ...prev,
        `[CRITICAL] Compliance sync failed: ${err.message}`,
        "[ABI-GATE] Manifest rejected by gatekeeper."
      ]);
      setStatus('error');
    } finally {
      setScanning(false);
    }
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
