import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  Search, 
  ChevronRight, 
  CheckCircle2, 
  AlertCircle, 
  Layout, 
  Layers, 
  Bell,
  X,
  Users,
  Activity,
  Settings,
  ShieldCheck,
  Zap,
  Globe,
  SlidersHorizontal,
  Mail,
  ExternalLink,
  ChevronDown,
  Terminal,
  ArrowUpRight,
  TrendingUp,
  Cpu,
  Home,
  Database,
  Fingerprint,
  Radio,
  Share2,
  Lock,
  History,
  HardDrive,
  Network,
  Loader2
} from 'lucide-react';

// --- Constants & Mock Data ---

const INITIAL_USERS = [
  { id: 1, name: 'Alex Rivera', role: 'Architect', color: 'bg-indigo-500', status: 'online' },
  { id: 2, name: 'Sarah Chen', role: 'UI Eng', color: 'bg-emerald-500', status: 'online' },
  { id: 3, name: 'Marco Rossi', role: 'Prod Mgr', color: 'bg-amber-500', status: 'away' },
  { id: 4, name: 'Elena Vance', role: 'Security', color: 'bg-rose-500', status: 'online' },
];

const INITIAL_ACTIVITY = [
  { user: 'Sarah', action: 'Deployed Node-04', time: '2m', type: 'deploy' },
  { user: 'System', action: 'Auto-scaled Cluster', time: '14m', type: 'auto' },
  { user: 'Alex', action: 'Updated Firewall', time: '1h', type: 'security' },
];

// --- Sub-Components ---

const Card = ({ title, icon: Icon, children, className = "", badge, footer }) => (
  <div className={`bg-white rounded-[2rem] p-4 shadow-sm border border-slate-100 hover:shadow-md transition-all flex flex-col ${className}`}>
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-xl bg-slate-50 flex items-center justify-center text-slate-500 border border-slate-100">
          <Icon size={14} />
        </div>
        <h2 className="text-[9px] font-black text-slate-900 uppercase tracking-[0.2em]">{title}</h2>
      </div>
      {badge && <span className="text-[8px] font-black bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-lg uppercase">{badge}</span>}
    </div>
    <div className="flex-1">{children}</div>
    {footer && <div className="mt-4 pt-3 border-t border-slate-50 flex justify-between items-center">{footer}</div>}
  </div>
);

const Heatmap = ({ onSelectNode }) => (
  <div className="grid grid-cols-10 gap-1 mt-2">
    {Array.from({ length: 40 }).map((_, i) => (
      <div 
        key={i} 
        onClick={() => onSelectNode(i + 1)}
        className={`w-full aspect-square rounded-[2px] cursor-pointer transition-all hover:scale-125 hover:z-10 ${
          i % 7 === 0 ? 'bg-rose-500' : i % 5 === 0 ? 'bg-emerald-500' : i % 3 === 0 ? 'bg-blue-400' : 'bg-slate-100'
        } opacity-80 hover:opacity-100`}
      />
    ))}
  </div>
);

const SegmentedControl = ({ options, active, onChange }) => (
  <div className="flex p-1 bg-slate-100 rounded-xl w-full">
    {options.map(opt => (
      <button
        key={opt}
        onClick={() => onChange(opt)}
        className={`flex-1 py-1.5 text-[8px] font-black uppercase tracking-widest rounded-lg transition-all ${
          active === opt ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400'
        }`}
      >
        {opt}
      </button>
    ))}
  </div>
);

export default function App() {
  // --- State Management ---
  const [activeTab, setActiveTab] = useState('home');
  const [toast, setToast] = useState(null);
  const [sliderVal, setSliderVal] = useState(84);
  const [view, setView] = useState('Traffic');
  const [searchQuery, setSearchQuery] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState('');
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [notifications, setNotifications] = useState(3);
  const [selectedNode, setSelectedNode] = useState(null);

  // --- Derived State ---
  const filteredUsers = useMemo(() => {
    return INITIAL_USERS.filter(u => 
      u.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      u.role.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery]);

  // --- Actions ---
  const triggerProcess = (label, type, nextTitle, nextDesc) => {
    setIsProcessing(true);
    setProcessingLabel(label);
    setTimeout(() => {
      setIsProcessing(false);
      setToast({
        type: type,
        title: nextTitle,
        desc: nextDesc
      });
    }, 1800);
  };

  const fireToast = (type, title, desc) => {
    setToast({ type, title, desc });
  };

  const handleMFA = () => {
    const newState = !mfaEnabled;
    triggerProcess(
      newState ? "Enabling MFA..." : "Disabling MFA...",
      newState ? "success" : "error",
      newState ? "PROTOCOL: SECURE" : "PROTOCOL: VULNERABLE",
      newState ? "Multi-factor authentication is now active across all nodes." : "Security override: MFA has been deactivated."
    );
    setMfaEnabled(newState);
  };

  return (
    <div className="min-h-screen bg-[#FDFDFF] text-slate-900 font-sans selection:bg-blue-100 pb-28 text-[11px]">
      
      {/* Header with Search Logic */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-2xl border-b border-slate-100 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div onClick={() => setActiveTab('home')} className="w-10 h-10 bg-slate-900 rounded-[1.25rem] flex items-center justify-center text-white shadow-2xl shadow-slate-200 group cursor-pointer active:scale-90 transition-transform">
            <Fingerprint size={20} strokeWidth={2.5} className="group-hover:text-blue-400 transition-colors" />
          </div>
          <div className="hidden xs:block">
            <span className="text-[11px] font-black tracking-tighter uppercase leading-none block italic">Quantum.V3</span>
            <span className="text-[8px] font-bold text-emerald-500 uppercase tracking-[0.2em] flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping" /> Global Sync
            </span>
          </div>
        </div>

        <div className="flex-1 max-w-xs mx-4 relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-blue-500 transition-colors" size={14} />
          <input 
            type="text"
            placeholder="Search nodes or users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-50 border border-slate-100 rounded-xl py-2 pl-9 pr-4 text-[10px] focus:outline-none focus:ring-2 focus:ring-blue-100 focus:bg-white transition-all"
          />
        </div>

        <div className="flex items-center gap-2">
          <button 
            onClick={() => {
              setNotifications(0);
              fireToast('info', 'INBOX CLEARED', 'All system alerts have been archived.');
            }}
            className="relative p-2.5 rounded-2xl bg-slate-50 text-slate-400 hover:bg-white hover:shadow-md transition-all"
          >
            <Bell size={16} />
            {notifications > 0 && (
              <span className="absolute top-2 right-2 w-3.5 h-3.5 bg-rose-500 border-2 border-white rounded-full flex items-center justify-center text-[7px] text-white font-black">
                {notifications}
              </span>
            )}
          </button>
          <div className="hidden sm:block w-px h-6 bg-slate-100 mx-1" />
          <button 
            onClick={() => triggerProcess("Generating key...", "success", "KEY GENERATED", "New RSA-4096 access token created.")}
            className="relative p-2.5 rounded-2xl bg-slate-900 text-white shadow-lg active:scale-95 transition-all"
          >
            <Plus size={16} />
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 mt-6 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
        
        {/* Quick Actions - Now Functional */}
        <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar px-1">
          {[
            { label: 'Security Scan', icon: Lock, color: 'bg-amber-50 text-amber-600', action: () => triggerProcess("Scanning nodes...", "success", "SCAN COMPLETE", "No vulnerabilities detected in 40 nodes.") },
            { label: 'Network Graph', icon: Network, color: 'bg-blue-50 text-blue-600', action: () => setActiveTab('nodes') },
            { label: 'Cloud Vault', icon: Database, color: 'bg-indigo-50 text-indigo-600', action: () => fireToast('info', 'VAULT STATUS', 'Encrypted storage at 64% capacity.') },
            { label: 'Logs Audit', icon: History, color: 'bg-slate-50 text-slate-600', action: () => fireToast('info', 'LOGS EXPORTED', 'Recent system logs sent to admin mail.') },
          ].map((act, i) => (
            <button key={i} onClick={act.action} className="flex flex-col items-center gap-2 shrink-0 group">
              <div className={`w-14 h-14 rounded-3xl ${act.color} flex items-center justify-center border border-transparent group-hover:border-current transition-all group-active:scale-90 shadow-sm`}>
                <act.icon size={20} />
              </div>
              <span className="text-[8px] font-black uppercase tracking-widest opacity-60 group-hover:opacity-100">{act.label}</span>
            </button>
          ))}
        </div>

        {/* Hero Bento */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 bg-slate-900 rounded-[2.5rem] p-7 text-white relative overflow-hidden group min-h-[240px] flex flex-col justify-between shadow-2xl shadow-slate-200">
            <div className="absolute -top-20 -right-20 w-80 h-80 bg-blue-600/20 blur-[100px] pointer-events-none" />
            
            <div className="relative z-10 flex justify-between items-start">
              <div>
                <h1 className="text-4xl font-black italic uppercase leading-none tracking-tighter mb-2">Cluster<br/>Metrics</h1>
                <div className="flex gap-2">
                  <span className="px-2 py-0.5 rounded bg-white/10 text-[8px] font-black uppercase tracking-widest">Region: US-East</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[8px] font-black uppercase tracking-widest">Active</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Live Health</p>
                <p className="text-3xl font-black text-blue-400 tracking-tighter">99.8%</p>
              </div>
            </div>

            <div className="relative z-10 flex items-center gap-3 mt-8">
              <button 
                onClick={() => triggerProcess("Synchronizing cluster...", "success", "NODES SYNCED", "All 128 threads are now aligned.")}
                className="flex-1 py-4 bg-white text-slate-900 rounded-2xl font-black uppercase text-[10px] tracking-[0.2em] shadow-lg hover:bg-blue-50 transition-all active:scale-95 flex items-center justify-center gap-2"
              >
                <Zap size={14} fill="currentColor" /> Force Sync Nodes
              </button>
              <button onClick={() => setActiveTab('settings')} className="p-4 bg-white/10 rounded-2xl hover:bg-white/20 transition-all">
                <Settings size={18} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-1 gap-4">
            <button onClick={() => fireToast('info', 'IO OPTIMIZED', 'Disk throughput increased by 12%')} className="bg-white border border-slate-100 rounded-[2.5rem] p-6 flex flex-col justify-between shadow-sm text-left group hover:border-blue-200 transition-all">
              <div className="flex items-center justify-between text-slate-300">
                <HardDrive size={18} className="group-hover:text-blue-500 transition-colors" />
                <ArrowUpRight size={14} className="text-blue-500" />
              </div>
              <div>
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">IO Speed</p>
                <p className="text-3xl font-black text-slate-900 tracking-tighter">1.2<span className="text-[10px] text-slate-400 ml-1">GB/s</span></p>
              </div>
            </button>
            <button onClick={() => fireToast('success', 'THREAD BOOST', 'High-priority task allocation active')} className="bg-indigo-600 rounded-[2.5rem] p-6 text-white flex flex-col justify-between shadow-xl shadow-indigo-100 text-left group">
              <div className="flex items-center justify-between opacity-70">
                <Cpu size={18} />
                <div className="flex gap-1">
                  <div className="w-1 h-3 bg-white/30 rounded-full" />
                  <div className="w-1 h-3 bg-white/30 rounded-full" />
                  <div className="w-1 h-3 bg-white rounded-full animate-pulse" />
                </div>
              </div>
              <div>
                <p className="text-[8px] font-black uppercase tracking-[0.2em] opacity-60 mb-1">Threads</p>
                <p className="text-3xl font-black tracking-tighter">128<span className="text-[10px] text-indigo-200 ml-1">Lnk</span></p>
              </div>
            </button>
          </div>
        </div>

        {/* Data Views */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          <Card 
            title="Infrastructure Monitor" 
            icon={Activity} 
            badge={selectedNode ? `Node #${selectedNode}` : "Global"}
            footer={
              <SegmentedControl options={['Traffic', 'Uptime', 'Drops']} active={view} onChange={setView} />
            }
          >
            <div className="py-2">
              <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-3">Load Distribution Map</p>
              <Heatmap onSelectNode={setSelectedNode} />
              <div className="flex justify-between mt-4 text-[7px] font-black text-slate-400 uppercase tracking-widest">
                <span>{selectedNode ? "Target Selected" : "Node 001"}</span>
                <span>{selectedNode ? <button onClick={() => setSelectedNode(null)} className="text-blue-600">Reset</button> : "Node 040"}</span>
              </div>
            </div>
          </Card>

          <Card title="Signal Logic" icon={SlidersHorizontal}>
            <div className="space-y-6 py-2">
              <div className="space-y-4">
                {[
                  { label: 'Carrier Wave', val: sliderVal, setter: setSliderVal, color: 'bg-blue-600' },
                  { label: 'Amplitude', val: 42, setter: () => {}, color: 'bg-emerald-500' }
                ].map((s, i) => (
                  <div key={i}>
                    <div className="flex justify-between items-center mb-2">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{s.label}</label>
                      <span className="text-[9px] font-black text-slate-900">{s.val}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden relative">
                      <div className={`h-full ${s.color} transition-all duration-300`} style={{ width: `${s.val}%` }} />
                      {s.label === 'Carrier Wave' && (
                        <input 
                          type="range" 
                          min="0" max="100" 
                          value={s.val} 
                          onChange={(e) => s.setter(e.target.value)}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="pt-2">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-3">Security Protocol</p>
                <div className="flex gap-2">
                  <button 
                    onClick={handleMFA}
                    className={`flex-1 py-3 rounded-xl text-[8px] font-black uppercase tracking-widest transition-all ${
                      mfaEnabled ? 'bg-emerald-500 text-white shadow-lg' : 'bg-slate-900 text-white'
                    }`}
                  >
                    {mfaEnabled ? 'MFA Enabled' : 'Enable MFA'}
                  </button>
                  <button onClick={() => fireToast('error', 'EMERGENCY STOP', 'All outbound traffic has been terminated.')} className="flex-1 py-3 rounded-xl border border-rose-100 bg-rose-50 text-rose-600 text-[8px] font-black uppercase tracking-widest active:scale-95 transition-all">Emergency Stop</button>
                </div>
              </div>
            </div>
          </Card>

          <Card title="Node Registry" icon={Users} className="md:col-span-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-3">
                {filteredUsers.length > 0 ? filteredUsers.map((user) => (
                  <div key={user.id} onClick={() => fireToast('info', 'USER INFO', `Contacting ${user.name}...`)} className="flex items-center justify-between p-3 rounded-2xl bg-slate-50/50 hover:bg-white border border-transparent hover:border-slate-100 transition-all cursor-pointer group">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className={`w-8 h-8 rounded-xl ${user.color} flex items-center justify-center text-white text-[10px] font-black`}>{user.name[0]}</div>
                        <div className={`absolute -bottom-1 -right-1 w-3 h-3 border-2 border-white rounded-full ${user.status === 'online' ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      </div>
                      <div>
                        <p className="text-[10px] font-black text-slate-900 uppercase tracking-tight leading-none mb-1">{user.name}</p>
                        <p className="text-[9px] text-slate-400 font-medium italic">{user.role}</p>
                      </div>
                    </div>
                    <ChevronRight size={14} className="text-slate-300 group-hover:text-blue-600 transition-colors" />
                  </div>
                )) : (
                  <div className="py-8 text-center text-slate-400 text-[9px] font-black uppercase tracking-widest">No matching nodes found</div>
                )}
              </div>
              <div className="bg-slate-50 p-4 rounded-2xl">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <History size={10} /> Live Activity
                </p>
                <div className="space-y-3">
                  {INITIAL_ACTIVITY.map((act, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 ${act.type === 'deploy' ? 'bg-blue-500' : 'bg-slate-300'}`} />
                      <div>
                        <p className="text-[9px] font-bold text-slate-700 leading-none mb-1">{act.user} <span className="text-slate-400 font-medium">{act.action}</span></p>
                        <p className="text-[7px] text-slate-400 uppercase font-black">{act.time} ago</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </main>

      {/* MOBILE BOTTOM NAVIGATION */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white/90 backdrop-blur-2xl border-t border-slate-100 md:hidden flex items-center justify-around px-6 py-4">
        {[
          { id: 'home', icon: Home, label: 'Core' },
          { id: 'nodes', icon: Cpu, label: 'Nodes' },
          { id: 'plus', icon: Zap, label: '', primary: true },
          { id: 'vault', icon: Lock, label: 'Vault' },
          { id: 'settings', icon: Settings, label: 'Set' },
        ].map(item => (
          <button 
            key={item.id}
            onClick={() => {
              setActiveTab(item.id);
              if (item.id === 'plus') triggerProcess("Deploying...", "success", "DEPLOYED", "New environment provisioned.");
            }}
            className={`flex flex-col items-center gap-1.5 transition-all ${
              item.primary 
                ? 'w-12 h-12 -mt-10 bg-blue-600 rounded-2xl text-white shadow-2xl shadow-blue-200 border-4 border-[#FDFDFF]' 
                : activeTab === item.id ? 'text-blue-600' : 'text-slate-400'
            }`}
          >
            <item.icon size={item.primary ? 22 : 20} strokeWidth={item.primary ? 2.5 : 2} />
            {!item.primary && <span className="text-[8px] font-black uppercase tracking-[0.2em]">{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* CENTERED LIQUID TOAST ALERT */}
      {toast && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-2xl animate-in fade-in duration-300">
          <div className="absolute inset-0" onClick={() => setToast(null)} />
          <div className={`relative w-full max-w-[300px] p-8 rounded-[3.5rem] shadow-2xl border-2 text-center animate-in zoom-in slide-in-from-bottom-12 duration-500 ease-out ${
            toast.type === 'success' ? 'bg-white border-emerald-100' : 
            toast.type === 'info' ? 'bg-white border-blue-100' :
            'bg-white border-rose-100'
          }`}>
            <div className={`w-20 h-20 rounded-[2.5rem] mx-auto mb-8 flex items-center justify-center animate-bounce ${
              toast.type === 'success' ? 'bg-emerald-50 text-emerald-500' : 
              toast.type === 'info' ? 'bg-blue-50 text-blue-500' :
              'bg-rose-50 text-rose-500 shadow-xl'
            }`}>
              {toast.type === 'success' ? <Zap size={40} strokeWidth={2.5} /> : 
               toast.type === 'info' ? <Layout size={40} strokeWidth={2.5} /> :
               <AlertCircle size={40} strokeWidth={2.5} />}
            </div>
            <h3 className="text-[11px] font-black text-slate-900 uppercase tracking-[0.25em] mb-3">{toast.title}</h3>
            <p className="text-[10px] text-slate-500 leading-relaxed mb-10 font-medium italic px-4">
              {toast.desc}
            </p>
            <button 
              onClick={() => setToast(null)}
              className={`w-full py-4.5 rounded-[1.75rem] text-[9px] font-black uppercase tracking-[0.2em] transition-all shadow-xl active:scale-95 ${
                toast.type === 'success' ? 'bg-emerald-600 text-white' : 
                toast.type === 'info' ? 'bg-blue-600 text-white' :
                'bg-rose-600 text-white shadow-rose-200'
              }`}
            >
              Acknowledge
            </button>
          </div>
        </div>
      )}

      {/* GLOBAL LOADING OVERLAY */}
      {isProcessing && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-4">
            <Loader2 size={40} className="text-blue-400 animate-spin" />
            <p className="text-white text-[10px] font-black uppercase tracking-[0.3em] animate-pulse">{processingLabel}</p>
          </div>
        </div>
      )}

    </div>
  );
}