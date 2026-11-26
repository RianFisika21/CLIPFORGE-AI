export class HardwareProfiler {
  constructor(){
    this.cores = navigator.hardwareConcurrency || 4;
    this.memGB = navigator.deviceMemory || this._guessMem();
    this.gpu   = this._gpu();
    this.isMobile = /Android|HarmonyOS|Mobile|Tablet/i.test(navigator.userAgent);
    this.isLowEnd = this.memGB <= 6 && !this.isMobile;
    this.profile  = this._decide();
  }
  _guessMem(){ return this.isMobile ? 4 : 6; }
  _gpu(){
    try{
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      if(!gl) return 'unknown';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'masked';
    }catch{ return 'unknown'; }
  }
  _decide(){
    if(this.isMobile || this.memGB <= 4){
      return { name:'Mobile/Tablet ARM', workers:1, proxyW:240, proxyH:135,
        defaultRes:'720p', defaultFps:30, frameRecycling:true, preferSoftware:false };
    }
    if(this.isLowEnd || /Intel.*HD Graphics 3/i.test(this.gpu)){
      return { name:'Low-VRAM Laptop', workers:2, proxyW:320, proxyH:180,
        defaultRes:'720p', defaultFps:30, frameRecycling:true, preferSoftware:true };
    }
    return { name:'Standard Desktop', workers:Math.min(4, Math.max(2, this.cores-2)),
      proxyW:320, proxyH:180, defaultRes:'1080p', defaultFps:30, frameRecycling:false, preferSoftware:false };
  }
  async detectCodecs(){
    const out = { video:{}, audio:{} };
    if(!('VideoEncoder' in window)) return out;
    const videoProfiles = ['avc1.4d002a','avc1.4d001f','avc1.42001f','avc1.42e01e'];
    for(const codec of videoProfiles){
      try{
        const r = await VideoEncoder.isConfigSupported({codec, width:1280, height:720, bitrate:4_000_000, framerate:30});
        out.video[codec] = !!r.supported;
      }catch{ out.video[codec] = false; }
    }
    if('AudioEncoder' in window){
      for(const [codec, sr, ch] of [['mp4a.40.2',48000,2],['mp4a.40.2',44100,2]]){
        try{
          const r = await AudioEncoder.isConfigSupported({codec, sampleRate:sr, numberOfChannels:ch, bitrate:128_000});
          out.audio[`${codec}@${sr}`] = !!r.supported;
        }catch{ out.audio[`${codec}@${sr}`] = false; }
      }
    }
    return out;
  }
  async pickVideoProfile(){
    const profiles = ['avc1.4d002a','avc1.4d001f','avc1.42001f','avc1.42e01e'];
    if(!('VideoEncoder' in window)) return null;
    for(const accel of ['no-preference','prefer-software']){
      for(const codec of profiles){
        try{
          const r = await VideoEncoder.isConfigSupported({
            codec, width:1280, height:720, bitrate:4_000_000, framerate:30,
            hardwareAcceleration: accel
          });
          if(r.supported) return { codec, hardwareAcceleration: accel };
        }catch{}
      }
    }
    return null;
  }
}