i want you to build this admin pgae (import React, { useState } from 'react';
import { 
  PhoneCall, Calendar, MapPin, User, 
  CheckCircle, Clock, AlertCircle, PhoneForwarded, 
  FileText, Send, UserPlus, PhoneIncoming, Users, 
  Target, Briefcase, Zap
} from 'lucide-react';

export default function App() {
  const [callStatus, setCallStatus] = useState('active'); // idle, active, booking
  const [selectedAgent, setSelectedAgent] = useState('');
  
  // Mock Data: Sales Team (Closers)
  const salesTeam = [
    { id: 1, name: 'سامي الطرابلسي', role: 'خبير إغلاق (المقر)', status: 'available', color: 'bg-emerald-500' },
    { id: 2, name: 'نوال الماجري', role: 'مستشارة استثمار', status: 'busy', color: 'bg-rose-500' },
    { id: 3, name: 'كريم بن علي', role: 'مرشد ميداني (الضيعة)', status: 'available', color: 'bg-emerald-500' },
  ];

  // Mock Data: Today's Schedule
  const todayAppointments = [
    { time: '10:00 AM', client: 'محمد الصالح', agent: 'سامي', type: 'زيارة المقر', status: 'done' },
    { time: '14:30 PM', client: 'ليلى بن عمر', agent: 'كريم', type: 'معاينة الضيعة', status: 'pending' },
  ];

  return (
    <div className="bg-[#0f172a] min-h-screen font-sans text-slate-200 p-4 md:p-6">
      
      {/* HEADER */}
      <header className="flex justify-between items-center mb-6 bg-slate-900 border border-slate-800 p-4 rounded-2xl" dir="rtl">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center">
              <span className="font-black text-white">SA</span>
            </div>
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-slate-900"></div>
          </div>
          <div>
            <h1 className="text-sm font-black text-white">سارة (مركز الاتصال)</h1>
            <p className="text-[11px] text-emerald-400 font-bold flex items-center gap-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              متصل وجاهز لاستقبال المكالمات
            </p>
          </div>
        </div>
        
        <div className="flex gap-4 text-center">
          <div className="bg-slate-800 px-4 py-2 rounded-xl border border-slate-700">
            <p className="text-[10px] text-slate-400">مكالمات اليوم</p>
            <p className="text-lg font-black text-blue-400">42</p>
          </div>
          <div className="bg-slate-800 px-4 py-2 rounded-xl border border-slate-700">
            <p className="text-[10px] text-slate-400">مواعيد محجوزة</p>
            <p className="text-lg font-black text-emerald-400">12</p>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" dir="rtl">
        
        {/* CENTER PANE: Active Call & Booking (8 Cols) */}
        <div className="lg:col-span-8 space-y-6">
          
          {/* Active Call Banner */}
          <div className={`border rounded-3xl p-5 flex items-center justify-between transition-all ${callStatus === 'active' ? 'bg-blue-900/20 border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.15)]' : 'bg-slate-900 border-slate-800'}`}>
            <div className="flex items-center gap-4">
              <div className={`p-3 rounded-2xl ${callStatus === 'active' ? 'bg-blue-500 animate-pulse text-white' : 'bg-slate-800 text-slate-500'}`}>
                <PhoneIncoming size={24} />
              </div>
              <div>
                <p className="text-[11px] text-blue-400 font-bold mb-1">مكالمة واردة الآن (حملة فيسبوك)</p>
                <h2 className="text-xl font-black text-white tracking-widest" dir="ltr">+216 22 543 987</h2>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-xs font-bold transition-colors">تعليق المكالمة</button>
              <button className="bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 rounded-xl text-xs font-bold transition-colors">إنهاء</button>
            </div>
          </div>

          {/* Assistant Script (AI Suggested Text) */}
          <div className="bg-gradient-to-r from-slate-900 to-slate-800 border border-slate-700 rounded-2xl p-5">
            <h3 className="text-xs font-black text-slate-400 mb-3 flex items-center gap-2">
              <Zap size={14} className="text-yellow-400" /> دليل المحادثة (Script)
            </h3>
            <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-700/50 text-sm leading-relaxed text-slate-300">
              "أهلاً بك سيدي في شركة ثروة S.A. 
              <br/><span className="text-emerald-400 font-bold">الهدف:</span> أؤكد لك أن رأس المال هو 1000 دينار فقط، وستحصل على مناب مسجل في دفتر خانة لقطعة أرض فلاحية فيها زيتون.
              <br/><span className="text-cyan-400 font-bold">دعوة للإجراء:</span> هل يناسبك أن نحدد موعداً لزيارتنا في المقر لرؤية الوثائق، أو نحدد لك موعداً لزيارة الضيعة على عين المكان؟"
            </div>
          </div>

          {/* CRM Form & Booking */}
          <div className="bg-slate-900 border border-slate-700 rounded-3xl p-6">
            <h3 className="text-sm font-black text-white mb-5 flex items-center gap-2">
              <UserPlus size={18} className="text-blue-400" /> إنشاء بطاقة حريف وحجز موعد
            </h3>
            
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">الاسم واللقب</label>
                <input type="text" placeholder="مثال: صالح الماجري" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none transition-colors" />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">المدينة / الولاية</label>
                <input type="text" placeholder="مثال: تونس العاصمة" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none transition-colors" />
              </div>
            </div>

            <div className="border-t border-slate-800 pt-5 mb-5">
              <h4 className="text-xs font-bold text-slate-300 mb-4 flex items-center gap-2">
                <Calendar size={14} className="text-emerald-400" /> تفاصيل المعاينة والموعد
              </h4>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">تاريخ الموعد</label>
                  <input type="date" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none transition-colors text-slate-300" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">التوقيت</label>
                  <input type="time" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none transition-colors text-slate-300" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">مكان اللقاء</label>
                  <select className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none transition-colors text-slate-300">
                    <option>مقر الشركة (توقيع العقود)</option>
                    <option>الضيعة الفلاحية (معاينة ميدانية)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-800 pt-5">
              <h4 className="text-xs font-bold text-slate-300 mb-4 flex items-center gap-2">
                <Target size={14} className="text-rose-400" /> تكليف بائع / خبير إغلاق (Dispatch)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {salesTeam.map(agent => (
                  <div 
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent.id)}
                    className={`cursor-pointer border p-3 rounded-xl flex items-center gap-3 transition-all ${selectedAgent === agent.id ? 'bg-blue-900/30 border-blue-500' : 'bg-slate-800 border-slate-700 hover:border-slate-500'}`}
                  >
                    <div className="relative">
                      <div className="w-8 h-8 bg-slate-700 rounded-full flex items-center justify-center">
                        <Briefcase size={14} className="text-slate-300" />
                      </div>
                      <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-800 ${agent.color}`}></div>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-white">{agent.name}</p>
                      <p className="text-[9px] text-slate-400">{agent.role}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6">
              <button className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-4 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all flex justify-center items-center gap-2 text-sm">
                <CheckCircle size={18} /> تأكيد الموعد وإرسال التكليف للبائع
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT PANE: Status & Today's Schedule (4 Cols) */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Quick Notes */}
          <div className="bg-slate-900 border border-slate-700 rounded-3xl p-5">
             <h3 className="text-xs font-black text-white mb-3 flex items-center gap-2">
              <FileText size={14} className="text-yellow-400" /> ملاحظات للمبيعات
            </h3>
            <textarea 
              placeholder="اكتب ملاحظات للبائع هنا (مثال: الحريف مهتم جداً ولكنه يريد رؤية شهادة الملكية الأم...)" 
              className="w-full h-24 bg-slate-800 border border-slate-700 rounded-xl p-3 text-xs focus:border-blue-500 focus:outline-none transition-colors resize-none"
            ></textarea>
          </div>

          {/* Today's Schedule Tracker */}
          <div className="bg-slate-900 border border-slate-700 rounded-3xl p-5">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xs font-black text-white flex items-center gap-2">
                <Clock size={14} className="text-blue-400" /> مواعيد اليوم (للمتابعة)
              </h3>
              <span className="bg-slate-800 text-[9px] px-2 py-1 rounded text-slate-400">14 أفريل</span>
            </div>
            
            <div className="space-y-3">
              {todayAppointments.map((apt, idx) => (
                <div key={idx} className="bg-slate-800 p-3 rounded-xl border border-slate-700/50">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-xs font-bold text-white">{apt.client}</span>
                    <span className="text-[10px] font-mono text-slate-400">{apt.time}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-400">
                    <span className="flex items-center gap-1"><MapPin size={10} className="text-rose-400" /> {apt.type}</span>
                    <span className="flex items-center gap-1"><User size={10} className="text-blue-400" /> البائع: {apt.agent}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-700 flex justify-between items-center">
                    {apt.status === 'done' ? (
                      <span className="text-[9px] text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded font-bold">تمت الزيارة</span>
                    ) : (
                      <span className="text-[9px] text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded font-bold">في الانتظار</span>
                    )}
                    <button className="text-[9px] text-blue-400 hover:text-blue-300">تعديل</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}) make it better redsing it to match our lgiht them + add the + button and do what is doabel only finaly build an atehr paeg caled calnder or the phone cals this one we giv it to the commercial and he see the stuff he have in his dai planed by the privias page 