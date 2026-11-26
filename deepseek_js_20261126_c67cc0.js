import { waitEvent } from '../core/utils.js';

export class VisualAnalyzer {
  constructor(videoEl){ this.video = videoEl; this.cancelled = false; }
  cancel(){ this.cancelled = true; }

  async analyze(duration, proxyW, proxyH, onProgress){
    this.cancelled = false;
    const canvas = new OffscreenCanvas(proxyW, proxyH);
    const ctx = canvas.getContext('2d', { willReadFrequently:true });
    const sampleStep = Math.max(1, Math.floor(duration / 600)); // ≤600 sample points
    const n = Math.floor(duration / sampleStep) + 1;
    const scene = new Float32Array(n);
    const motion = new Float32Array(n);
    const centroid = new Float32Array(n); // -1..1 horizontal center of mass
    let prevHist = null, prevGray = null;

    for(let i=0;i<n;i++){
      if(this.cancelled) break;
      const t = i * sampleStep;
      try{
        await this._seek(t);
        ctx.drawImage(this.video, 0, 0, proxyW, proxyH);
        const { data } = ctx.getImageData(0,0,proxyW,proxyH);
        const { hist, gray } = this._histGray(data);
        if(prevHist){
          let hd=0; for(let k=0;k<hist.length;k++) hd += Math.abs(hist[k]-prevHist[k]);
          scene[i] = hd;
          let mad=0, cx=0, cw=0;
          const step = Math.max(1, Math.floor(gray.length/5000));
          for(let p=0;p<gray.length;p+=step){
            const d = Math.abs(gray[p]-prevGray[p]); mad += d;
            const x = (p % proxyW) / proxyW;
            cx += (gray[p] - prevGray[p] > 20) ? x : 0;
            cw += (gray[p] - prevGray[p] > 20) ? 1 : 0;
          }
          motion[i] = mad / (gray.length/step) / 255;
          centroid[i] = cw ? (cx/cw)*2 - 1 : 0;
        }
        prevHist = hist; prevGray = gray;
      }catch{}
      onProgress?.((i+1)/n*100);
    }
    return { sampleStep, scene, motion, centroid, n };
  }
  _seek(t){
    this.video.currentTime = Math.max(0, Math.min(this.video.duration-0.01, t));
    return waitEvent(this.video, 'seeked', 4000).catch(()=>{});
  }
  _histGray(data){
    const hist = new Float32Array(32);
    const gray = new Float32Array(data.length/4);
    for(let i=0,j=0;i<data.length;i+=4,j++){
      const g = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
      gray[j] = g;
      hist[Math.min(31, g>>3)]++;
    }
    const total = gray.length || 1;
    for(let k=0;k<32;k++) hist[k] /= total;
    return { hist, gray };
  }
}