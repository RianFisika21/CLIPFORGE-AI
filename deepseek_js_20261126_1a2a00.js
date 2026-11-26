import { clamp } from '../core/utils.js';

export class HighlightScorer {
  /* Menggabungkan fitur audio (rms, flux, zcr, vad) dan visual (scene, motion, centroid).
     Menghasilkan kandidat dengan skor nyata + NMS. */
  static score({ audio, visual, duration, targetDur, wantCount }){
    const frameSec = audio.frameMs/1000;
    const nA = audio.rms.length;
    const scores = [];
    // Build per-second composite curve
    const perSec = Math.floor(duration);
    const curve = new Float32Array(perSec);
    for(let s=0;s<perSec;s++){
      const a = Math.floor(s/frameSec);
      const rms = audio.rms[a]||0, flux = audio.flux[a]||0, vad = audio.vad[a]||0, zcr = audio.zcr[a]||0;
      // visual index
      const vi = visual ? Math.floor(s / visual.sampleStep) : 0;
      const sc = visual ? (visual.scene[vi]||0) : 0;
      const mo = visual ? (visual.motion[vi]||0) : 0;
      // normalize
      curve[s] = 0.55*Math.min(1,rms*8) + 0.2*Math.min(1,flux*4) + 0.15*vad + 0.1*Math.min(1,mo*3) + 0.15*Math.min(1,sc*5) - 0.1*zcr;
    }
    // Candidate windows
    const win = Math.max(2, Math.round(targetDur));
    const hop = Math.max(1, Math.round(win/2));
    const cands = [];
    for(let s=0; s+win<=perSec; s+=hop){
      let sum=0, peak=0, speech=0, motionSum=0;
      for(let k=s;k<s+win;k++){ sum += curve[k]; if(curve[k]>peak) peak=curve[k]; }
      const avg = sum/win;
      // speech density
      let vSum=0; for(let k=s;k<s+win;k++){ const a=Math.floor(k/frameSec); vSum += audio.vad[a]||0; }
      speech = vSum/win;
      if(visual){ let m=0; for(let k=s;k<s+win;k++){ const vi=Math.floor(k/visual.sampleStep); m+=visual.motion[vi]||0; } motionSum=m/win; }
      const engagement = clamp(avg*100*0.6 + peak*100*0.2 + speech*100*0.2, 0, 100);
      if(engagement < 25) continue; // honest threshold
      cands.push({
        start: s, end: s+win, duration: win,
        engagement, audioEnergy: clamp(Math.min(1, (audio.rms[Math.floor(s/frameSec)]||0)*8)*100,0,100),
        speechDensity: clamp(speech*100,0,100),
        visualActivity: clamp(motionSum*100*3,0,100),
        context: clamp(avg*100,0,100),
        reason: `Energi vokal ${(audio.rms[Math.floor(s/frameSec)]||0)*8>0.6?'tinggi':'sedang'} + pergerakan visual ${motionSum>0.05?'dinamis':'stabil'}`
      });
    }
    // NMS temporal (tidak tumpang tindih)
    cands.sort((a,b)=>b.engagement-a.engagement);
    const picked = [];
    for(const c of cands){
      if(picked.some(p => !(c.end <= p.start+0.5 || c.start >= p.end-0.5))) continue;
      picked.push(c);
      if(picked.length >= wantCount) break;
    }
    return picked;
  }
}