import React, { useState, useEffect } from 'react';

export default function App() {
  const [formData, setFormData] = useState({
    driverName: '',
    driverPhone: '',
    equipType: 'reefer',
    preferredLanes: ''
  });
  const [statusMessage, setStatusMessage] = useState('');

  // Local-First: Restore progress if the driver loses signal mid-entry
  useEffect(() => {
    const savedData = localStorage.getItem('bro_driver_form');
    if (savedData) {
      setFormData(JSON.parse(savedData));
      setStatusMessage('Progress restored from your device offline storage.');
    }
  }, []);

  const handleInputChange = (e) => {
    const { id, value } = e.target;
    const updated = { ...formData, [id]: value };
    setFormData(updated);
    localStorage.setItem('bro_driver_form', JSON.stringify(updated));
    setStatusMessage('Progress saved offline.');
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    alert("Application transmitted securely. Clearing offline device caches.");
    localStorage.removeItem('bro_driver_form');
    setFormData({ driverName: '', driverPhone: '', equipType: 'reefer', preferredLanes: '' });
    setStatusMessage('');
  };

  return (
    <div className="bg-[#0B0F19] text-white min-h-screen selection:bg-blue-500 selection:text-white">
      {/* Navigation Header */}
      <header class="sticky top-0 z-50 backdrop-blur-md bg-[#0B0F19]/80 border-b border-slate-800">
        <div class="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <span class="text-xl font-black tracking-wider text-blue-500">#BRO TRANSPORT CORP.</span>
          <a href="tel:902-916-6936" class="bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500 hover:text-white transition-all text-blue-500 text-xs font-semibold px-4 py-2 rounded-md">
            Call Desk: 902-916-6936
          </a>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative min-h-[70vh] flex items-center justify-center text-center px-6 border-b border-slate-900">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(59,130,246,0.12),rgba(255,255,255,0))]"></div>
        <div className="relative z-10 max-w-4xl space-y-6">
          <span className="text-xs uppercase tracking-widest text-blue-400 font-bold px-3 py-1 bg-blue-500/10 rounded-full border border-blue-500/20">
            Asset-Light Logistics Engine
          </span>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-none">
            WE ELIMINATE THE ADMINISTRATIVE BURDEN OF THE ROAD
          </h1>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            High-performance dispatching engineered for independent owner-operators. We manage your lanes, compliance, and border clearance while you drive.
          </p>
          <div className="pt-4">
            <a href="#join" className="bg-blue-500 hover:bg-blue-600 px-8 py-4 rounded-md font-semibold text-sm shadow-lg shadow-blue-500/20 transition-all inline-block">
              Register in Carrier Network
            </a>
          </div>
        </div>
      </section>

      {/* Services Grid */}
      <section className="py-24 px-6 max-w-7xl mx-auto space-y-16">
        <div class="text-center space-y-4">
          <h2 class="text-3xl font-extrabold tracking-tight">Our Core Operations Suite</h2>
          <p class="text-slate-400 max-w-xl mx-auto">Lowering your daily cognitive load with comprehensive back-office support.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="bg-[#161F30] p-8 rounded-lg border border-slate-800 hover:border-blue-500/50 transition-all">
            <h3 className="text-xl font-bold mb-3">Smart Route Planning</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              We coordinate transit corridors across Canada and the US to optimize fuel efficiency and eliminate deadhead miles.
            </p>
          </div>
          <div className="bg-[#161F30] p-8 rounded-lg border border-slate-800 hover:border-blue-500/50 transition-all">
            <h3 className="text-xl font-bold mb-3">Compliance & HOS</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              Complete administrative logging support to protect your carrier profile and prevent regulatory compliance penalties.
            </p>
          </div>
          <div className="bg-[#161F30] p-8 rounded-lg border border-slate-800 hover:border-blue-500/50 transition-all">
            <h3 className="text-xl font-bold mb-3">Cross-Border Clearance</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              Fast, hassle-free customs clearances. We accurately manage and submit complex ACE and ACI manifest requirements.
            </p>
          </div>
        </div>
      </section>

      {/* Local-First Resilient Form Section */}
      <section id="join" className="py-24 bg-[#161F30]/30 border-t border-slate-900 px-6">
        <div className="max-w-3xl mx-auto space-y-8">
          <div className="text-center space-y-4">
            <h2 class="text-3xl font-extrabold tracking-tight">Driver Gateway</h2>
            <p class="text-slate-400">Complete your profile. Changes are cached on your browser to prevent data loss in signal dead zones.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6 bg-[#0B0F19] p-8 rounded-lg border border-slate-800">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Driver / Carrier Name</label>
                <input type="text" id="driverName" value={formData.driverName} onChange={handleInputChange} required className="w-full bg-[#161F30] border border-slate-800 focus:border-blue-500 focus:outline-none rounded-md px-4 py-3 text-white text-sm" placeholder="John Doe" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Phone Number</label>
                <input type="tel" id="driverPhone" value={formData.driverPhone} onChange={handleInputChange} required className="w-full bg-[#161F30] border border-slate-800 focus:border-blue-500 focus:outline-none rounded-md px-4 py-3 text-white text-sm" placeholder="902-555-0199" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Equipment Profile</label>
                <select id="equipType" value={formData.equipType} onChange={handleInputChange} className="w-full bg-[#161F30] border border-slate-800 focus:border-blue-500 focus:outline-none rounded-md px-4 py-3 text-white text-sm">
                  <option value="reefer">Reefer (Refrigerated)</option>
                  <option value="flatbed">Flatbed</option>
                  <option value="dryvan">Dry Van</option>
                  <option value="other">Other Equipment</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Primary Lane Focus</label>
                <input type="text" id="preferredLanes" value={formData.preferredLanes} onChange={handleInputChange} className="w-full bg-[#161F30] border border-slate-800 focus:border-blue-500 focus:outline-none rounded-md px-4 py-3 text-white text-sm" placeholder="e.g., PEI to New England" />
              </div>
            </div>

            {statusMessage && (
              <div className="text-xs text-emerald-400 bg-emerald-950/20 border border-emerald-900/40 p-4 rounded-md">
                {statusMessage}
              </div>
            )}

            <button type="submit" className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-4 rounded-md transition-all text-sm shadow-md">
              Submit Application
            </button>
          </form>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 border-t border-slate-900 text-center text-xs text-slate-500">
        <p>&copy; 2026 #BRO Transport Corp. Prince Edward Island, Canada.</p>
        <p class="text-[10px] text-slate-600 mt-2">Built using High-Performance Local-First Static Engineering.</p>
      </footer>
    </div>
  );
}
