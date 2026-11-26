import { toast } from '../core/utils.js';

export class AudioAnalyzer {
  constructor(){ this.worker = null; this.cancelled = false; }
  cancel(){ this.cancelled = true; this.worker?.postMessage({type:'cancel'}); this.worker?.terminate(); this.worker=null; }

  async extract(file, onProgress){
    this.cancelled = false;
    return new Promise((resolve, reject)=>{
      this.worker = new Worker('js/workers/audio-worker.js');
      this.worker.onmessage = (e)=>{
        const m = e.data;
        if(m.type === 'progress'){ onProgress?.(m.pct, m.stage); }
        else if(m.type === 'done'){ resolve(m); this.worker?.terminate(); this.worker=null; }
        else if(m.type === 'error'){ reject(new Error(m.message)); this.worker?.terminate(); this.worker=null; }
      };
      this.worker.onerror = (err)=>{ reject(new Error('Worker error: '+err.message)); };
      this.worker.postMessage({ type:'start', blob: file });
    });
  }

  // Feature extraction dari PCM 16kHz mono.
  static features(pcm, sr){
    const frameMs = 50, hop = Math.floor(sr*frameMs/1000);
    const nFrames = Math.max(1, Math.floor((pcm.length - hop) / hop) + 1);
    const rms = new Float32Array(nFrames);
    const zcr = new Float32Array(nFrames);
    const flux = new Float32Array(nFrames);
    const vad = new Float32Array(nFrames);

    // Simple band-energy proxy via one-pole high/low separation
    let prevMag = new Float32Array(64);
    for(let f=0; f<nFrames; f++){
      const start = f*hop, end = Math.min(pcm.length, start+hop);
      let sumSq=0, zc=0, prev=0;
      // crude band split
      let low=0, high=0, lowPrev=0;
      for(let i=start;i<end;i++){
        const x = pcm[i];
        sumSq += x*x;
        if((x>=0)!==(prev>=0)) zc++;
        prev = x;
        // one-pole LP ~300Hz, HP ~3400Hz proxy
        lowPrev = lowPrev + 0.05*(x - lowPrev);
        low = lowPrev;
        const band = x - low; // speech band-ish
        high = band;
      }
      const r = Math.sqrt(sumSq / Math.max(1,end-start));
      rms[f] = r;
      zcr[f] = zc / Math.max(1,end-start);

      // spectral flux proxy via block energies
      const m = new Float32Array(64);
      const blk = Math.floor((end-start)/64);
      for(let k=0;k<64;k++){ let s=0; for(let i=0;i<blk;i++){ const idx=start+k*blk+i; if(idx<end) s+=pcm[idx]*pcm[idx]; } m[k]=Math.sqrt(s/Math.max(1,blk)); }
      let fl=0; for(let k=0;k<64;k++){ const d=m[k]-prevMag[k]; if(d>0) fl+=d; }
      flux[f]=fl; prevMag=m;

      // VAD: speech band energy vs noise floor (adaptive)
      vad[f] = high * high; // proxy; refined below
    }

    // Adaptive noise floor + VAD ratio (speech 300-3400 vs floor)
    const sorted = Float32Array.from(rms).sort();
    const floor = sorted[Math.floor(sorted.length*0.1)] || 0;
    const vadN = new Float32Array(nFrames);
    for(let f=0; f<nFrames; f++) vadN[f] = rms[f] > floor*2.2 ? Math.min(1,(rms[f]-floor*1.5)/(floor*6+1e-6)) : 0;

    return { frameMs, hop, rms, zcr, flux, vad:vadN };
  }
}