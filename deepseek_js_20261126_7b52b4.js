/* Audio extraction worker — streaming demux (mp4box) + AudioDecoder.
   Downsample segera ke 16kHz mono untuk analisis & buang PCM penuh. */
importScripts('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');

let cancelled = false;

self.onmessage = async (e)=>{
  const { type, blob } = e.data;
  if(type === 'cancel'){ cancelled = true; return; }
  if(type !== 'start') return;
  try{
    cancelled = false;
    const result = await extract(blob);
    self.postMessage({ type:'done', ...result });
  }catch(err){
    self.postMessage({ type:'error', message: err.message });
  }
};

function readSlice(blob, start, end){ return blob.slice(start, end).arrayBuffer(); }

async function extract(blob){
  // 1. Demux
  const mp4 = MP4Box.createFile();
  const samples = [];
  let trackInfo = null, aacConfig = null, timescale = 0, duration = 0;

  mp4.onReady = (info)=>{
    const track = info.audioTracks[0];
    if(!track) throw new Error('Tidak ada track audio.');
    trackInfo = track;
    timescale = track.timescale;
    duration  = track.duration;
    aacConfig = getASC(track);
    mp4.setExtractionOptions(track.id, null, { nbSamples: 1000 });
  };
  mp4.onSamples = (id, user, samp)=>{ samples.push(...samp); };
  mp4.onError = (e)=>{ throw new Error('Demux error: '+e); };

  const CHUNK = 4 * 1024 * 1024;
  for(let off=0; off < blob.size; off += CHUNK){
    if(cancelled) throw new Error('cancelled');
    const buf = await readSlice(blob, off, Math.min(blob.size, off+CHUNK));
    buf.fileStart = off;
    mp4.appendBuffer(buf);
    self.postMessage({ type:'progress', stage:'demux', pct: Math.min(50, off/blob.size*50) });
  }
  mp4.flush();

  if(!trackInfo) throw new Error('Gagal membaca track audio.');
  if(!('AudioDecoder' in self)) throw new Error('AudioDecoder tidak tersedia');

  // 2. Decode semua sampel
  const sr = trackInfo.audio.sample_rate;
  const ch = trackInfo.audio.channel_count;
  const cfg = { codec:'mp4a.40.2', sampleRate: sr, numberOfChannels: ch };
  if(aacConfig) cfg.description = aacConfig;
  const support = await AudioDecoder.isConfigSupported(cfg);
  if(!support.supported) throw new Error('AudioDecoder config tidak didukung');

  const down = new Downsampler(sr, ch, 16000);
  let decodedFrames = 0;
  const dec = new AudioDecoder({
    output: (audioData)=>{
      if(cancelled){ audioData.close(); return; }
      down.push(audioData);
      audioData.close();
      decodedFrames++;
      if((decodedFrames & 31) === 0){
        self.postMessage({ type:'progress', stage:'decode', pct: 50 + Math.min(45, decodedFrames/samples.length*45) });
      }
    },
    error: (err)=>{ self.postMessage({type:'error', message:'Decode error: '+err.message}); }
  });
  dec.configure(cfg);
  for(const s of samples){
    if(cancelled) break;
    dec.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: Math.round(s.cts * 1e6 / timescale),
      duration: Math.round(s.duration * 1e6 / timescale),
      data: s.data
    }));
  }
  await dec.flush();
  dec.close();
  const pcm = down.finish();
  self.postMessage({ type:'progress', stage:'done', pct:100 });
  return { sampleRate:16000, pcm, duration };
}

function getASC(track){
  try{
    const stsd = track.trak.mdia.minf.stbl.stsd;
    const entry = stsd.entries[0];
    const esds = entry.esds || entry.wave?.entries?.find(e=>e.esds)?.esds;
    if(!esds) return null;
    const esd = esds.esd;
    for(const d of (esd.descs||[])){
      for(const d2 of (d.descs||[])){
        if(d2.data) return new Uint8Array(d2.data);
      }
    }
  }catch{}
  return null;
}

// Downsampler streaming: mixdown ke mono lalu decimate ke 16k (rata-rata blok)
class Downsampler {
  constructor(inRate, inCh, outRate){
    this.inRate = inRate; this.inCh = inCh; this.outRate = outRate;
    this.ratio = inRate / outRate;
    this.out = []; this.acc = 0; this.accN = 0; this.phase = 0; this.totalIn = 0;
  }
  push(audioData){
    const n = audioData.numberOfFrames;
    const planar = audioData.format && audioData.format.includes('planar');
    const chData = [];
    if(planar){
      for(let c=0;c<this.inCh;c++){ const a = new Float32Array(n); audioData.copyTo(a, {planeIndex:c, format:'f32-planar'}); chData.push(a); }
    }else{
      const a = new Float32Array(n * this.inCh);
      audioData.copyTo(a, {planeIndex:0, format:'f32'});
      for(let c=0;c<this.inCh;c++){ const ch = new Float32Array(n); for(let i=0;i<n;i++) ch[i]=a[i*this.inCh+c]; chData.push(ch); }
    }
    for(let i=0;i<n;i++){
      let v = 0; for(let c=0;c<this.inCh;c++) v += chData[c][i];
      v /= this.inCh;
      this.acc += v; this.accN++;
      this.phase += 1;
      if(this.phase >= this.ratio){
        this.out.push(this.acc / this.accN);
        this.acc = 0; this.accN = 0; this.phase -= this.ratio;
      }
    }
  }
  finish(){ return new Float32Array(this.out); }
}