import { $, fmtTime, waitEvent } from './utils.js';

export class VideoLoader {
  constructor(videoEl){
    this.video = videoEl;
    this.file  = null;
    this.url   = null;
    this.meta  = null;
  }
  async load(file){
    this.revoke();
    this.file = file;
    this.url  = URL.createObjectURL(file);
    this.video.src = this.url;
    this.video.load();
    await Promise.race([
      waitEvent(this.video,'loadedmetadata', 15000),
      waitEvent(this.video,'error', 15000).then(()=>{throw new Error('Codec/format tidak didukung browser ini.');})
    ]);
    // FPS estimation via requestVideoFrameCallback
    const fps = await this._estimateFps();
    this.meta = {
      name: file.name,
      size: file.size,
      type: file.type || 'video/*',
      duration: this.video.duration,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      aspect: (this.video.videoWidth / this.video.videoHeight).toFixed(3),
      fps
    };
    return this.meta;
  }
  _estimateFps(){
    return new Promise(res=>{
      if(!this.video.requestVideoFrameCallback){ res(30); return; }
      let first=0, count=0;
      const cb = (now, meta)=>{
        if(!first) first = meta.mediaTime;
        count++;
        if(count < 20 && meta.mediaTime - first < 1){ this.video.requestVideoFrameCallback(cb); }
        else{ res(Math.round(count / Math.max(0.001, meta.mediaTime - first)) || 30); }
      };
      this.video.requestVideoFrameCallback(cb);
      setTimeout(()=>res(30), 2000);
    });
  }
  revoke(){
    if(this.url){ URL.revokeObjectURL(this.url); this.url = null; }
    this.video.removeAttribute('src'); this.video.load();
  }
  async seek(t){
    this.video.currentTime = Math.max(0, Math.min(this.meta.duration - 0.01, t));
    await waitEvent(this.video, 'seeked', 5000);
  }
}