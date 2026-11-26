export const $  = (s, r=document) => r.querySelector(s);
export const $$ = (s, r=document) => [...r.querySelectorAll(s)];

export function fmtTime(sec){
  if(!isFinite(sec)) sec = 0;
  const ms = Math.floor((sec % 1) * 1000);
  const s  = Math.floor(sec) % 60;
  const m  = Math.floor(sec/60) % 60;
  const h  = Math.floor(sec/3600);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}
export function parseTime(str){
  const m = str.trim().match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if(!m) return NaN;
  return (+m[1])*3600 + (+m[2])*60 + (+m[3]) + (m[4]? +`0.${m[4]}`:0);
}
export const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
export const lerp  = (a,b,t)=>a+(b-a)*t;
export const uid   = () => crypto.randomUUID();

export function toast(msg, ms=3200){
  const el = $('#toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(()=>el.classList.add('hidden'), ms);
}
export function confirmModal(title, body){
  return new Promise(res=>{
    const modal = $('#modal'), box = $('#modalBox');
    box.innerHTML = `<h3>${title}</h3><p class="muted">${body}</p>
      <div class="row gap" style="margin-top:14px">
        <button class="btn btn-primary" id="mOk">Ya</button>
        <button class="btn btn-ghost" id="mCancel">Batal</button>
      </div>`;
    modal.classList.remove('hidden');
    $('#mOk').onclick = ()=>{modal.classList.add('hidden');res(true);};
    $('#mCancel').onclick = ()=>{modal.classList.add('hidden');res(false);};
  });
}
export function waitEvent(el, ev, timeout=8000){
  return new Promise((res, rej)=>{
    const t = setTimeout(()=>{cleanup();rej(new Error('timeout '+ev));}, timeout);
    const h = ()=>{cleanup();res();};
    const cleanup=()=>{clearTimeout(t);el.removeEventListener(ev,h);};
    el.addEventListener(ev,h,{once:true});
  });
}