import { waitEvent } from '../core/utils.js';

export class ExportEngine {
  constructor(profiler){ this.profiler = profiler; this.cancelled = false; }

  async exportClip({ videoEl, file, clip, settings, compositor, subtitles, onProgress }){
    this.cancelled = false;
    const useWebCodecs = 'VideoEncoder' in window && 'AudioEncoder' in window && window.Mp4Muxer;
    if(useWebCodecs){
      try{
        return await this._webcodecs({ videoEl, file, clip, settings, compositor, subtitles, onProgress });
      }catch(err){
        console.warn('[export] WebCodecs gagal, fallback MediaRecorder:', err);
        if(this.cancelled) throw err;
      }
    }
    return this._mediaRecorder({ videoEl, clip, settings, compositor, subtitles, onProgress });
  }

  async _webcodecs({ videoEl, file, clip, settings, compositor, subtitles, onProgress }){
    const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
    const isV = settings.aspect === '9:16';
    const W = settings.res === '1080p' ? (isV?1080:1920) : (isV?720:1280);
    const H = settings.res === '1080p' ? (isV?1920:1080) : (isV?1280:720);
    const fps = settings.fps;
    const bitrate = settings.bitrate * 1_000_000;

    const prof = await this.profiler.pickVideoProfile();
    if(!prof) throw new Error('VideoEncoder tidak mendukung profil H.264 apa pun');

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 },
      fastStart: 'in-memory'
    });

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta)=> muxer.addVideoChunk(chunk, meta),
      error: (e)=>{ throw e; }
    });
    videoEncoder.configure({
      codec: prof.codec, width: W, height: H, bitrate, framerate: fps,
      hardwareAcceleration: prof.hardwareAcceleration
    });

    // Audio decode range (via mp4box + AudioDecoder)
    const audio = await this._decodeAudioRange(file, clip.start, clip.end).catch(()=>null);
    let audioEncoder = null;
    if(audio){
      audioEncoder = new AudioEncoder({
        output: (chunk, meta)=> muxer.addAudioChunk(chunk, meta),
        error: (e)=>console.warn('audio enc', e)
      });
      audioEncoder.configure({ codec:'mp4a.40.2', sampleRate: audio.sampleRate, numberOfChannels: audio.channels, bitrate:128_000 });
    }

    // Video frames from seeking
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently:false });
    const totalFrames = Math.ceil(clip.duration * fps);
    const dt = 1/fps;

    for(let i=0;i<totalFrames;i++){
      if(this.cancelled){ videoEncoder.close(); audioEncoder?.close(); throw new Error('cancelled'); }
      const t = clip.start + i*dt;
      await seekVideo(videoEl, t);
      const sub = this._activeSub(subtitles, t);
      compositor.draw({ ctx, video: videoEl, canvasW: W, canvasH: H, aspect: settings.aspect,
        cropX: clip.cropX ?? 0.5, t: i*dt, subtitle: sub });
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i*1e6/fps), duration: Math.round(1e6/fps) });
      videoEncoder.encode(frame, { keyFrame: i % (fps*2) === 0 });
      frame.close();
      while(videoEncoder.encodeQueueSize > 2){ await new Promise(r=>setTimeout(r, 4)); }
      if(i % 10 === 0) onProgress?.(i/totalFrames*90);
    }
    await videoEncoder.flush();
    videoEncoder.close();

    if(audio && audioEncoder){
      // Encode audio PCM chunks
      const chunkFrames = 1024;
      const pcm = audio.pcm; // Float32 interleaved? we return planar arrays
      const total = audio.frames;
      for(let off=0; off<total; off+=chunkFrames){
        if(this.cancelled) break;
        const n = Math.min(chunkFrames, total-off);
        const planes = [];
        for(let c=0;c<audio.channels;c++) planes.push(audio.data[c].subarray(off, off+n));
        const ad = new AudioData({
          format: 'f32-planar',
          sampleRate: audio.sampleRate,
          numberOfFrames: n,
          numberOfChannels: audio.channels,
          timestamp: Math.round(off/audio.sampleRate*1e6),
          data: interleavePlanar(planes, n)
        });
        audioEncoder.encode(ad);
        ad.close();
        while(audioEncoder.encodeQueueSize > 4){ await new Promise(r=>setTimeout(r, 4)); }
      }
      await audioEncoder.flush();
      audioEncoder.close();
    }

    muxer.finalize();
    const buffer = muxer.target.buffer;
    onProgress?.(100);
    return new Blob([buffer], { type:'video/mp4' });
  }

  async _decodeAudioRange(file, start, end){
    // Demux full (streaming) but keep only samples in range, decode to PCM
    const mp4 = MP4Box.createFile();
    let track=null, ts=0;
    const keep=[];
    await new Promise((resolve, reject)=>{
      mp4.onReady = (info)=>{
        track = info.audioTracks[0];
        if(!track) return reject(new Error('no audio'));
        ts = track.timescale;
        mp4.setExtractionOptions(track.id, null, { nbSamples:500 });
        // feed chunks
        (async()=>{
          const CH=4*1024*1024;
          for(let off=0; off<file.size; off+=CH){
            const buf = await file.slice(off, Math.min(file.size, off+CH)).arrayBuffer();
            buf.fileStart = off; mp4.appendBuffer(buf);
          }
          mp4.flush(); resolve();
        })().catch(reject);
      };
      mp4.onSamples = (id,u,samps)=>{
        for(const s of samps){
          const t0 = s.cts / ts, t1 = (s.cts + s.duration) / ts;
          if(t1 < start - 1 || t0 > end + 1) continue;
          keep.push(s);
        }
      };
      mp4.onError = (e)=>reject(new Error('demux '+e));
    });
    if(!keep.length) throw new Error('no samples in range');
    const sr = track.audio.sample_rate;
    const ch = track.audio.channel_count;
    const cfg = { codec:'mp4a.40.2', sampleRate:sr, numberOfChannels:ch };
    const asc = (()=>{ try{ const e=track.trak.mdia.minf.stbl.stsd.entries[0]; const esd=(e.esds||e.wave?.entries?.find(x=>x.esds)?.esds)?.esd; for(const d of esd?.descs||[]) for(const d2 of d.descs||[]) if(d2.data) return new Uint8Array(d2.data); }catch{} return null; })();
    if(asc) cfg.description = asc;
    const sup = await AudioDecoder.isConfigSupported(cfg);
    if(!sup.supported) throw new Error('audio decode unsupported');
    const frames = [];
    const dec = new AudioDecoder({ output:(d)=>{ frames.push(d); }, error:(e)=>{console.warn(e);} });
    dec.configure(cfg);
    for(const s of keep){
      dec.decode(new EncodedAudioChunk({ type:'key', timestamp: Math.round(s.cts*1e6/ts), duration: Math.round(s.duration*1e6/ts), data:s.data }));
    }
    await dec.flush(); dec.close();
    // concat
    let total = 0; for(const d of frames) total += d.numberOfFrames;
    const data = Array.from({length:ch}, ()=> new Float32Array(total));
    let off = 0;
    for(const d of frames){
      const n = d.numberOfFrames;
      const planar = d.format.includes('planar');
      if(planar){
        for(let c=0;c<ch;c++){ const a=new Float32Array(n); d.copyTo(a,{planeIndex:c,format:'f32-planar'}); data[c].set(a, off); }
      }else{
        const a = new Float32Array(n*ch); d.copyTo(a,{planeIndex:0,format:'f32'});
        for(let c=0;c<ch;c++) for(let i=0;i<n;i++) data[c][off+i]=a[i*ch+c];
      }
      off += n; d.close();
    }
    return { sampleRate:sr, channels:ch, frames:total, data, pcm:null };
  }

  async _mediaRecorder({ videoEl, clip, settings, compositor, subtitles, onProgress }){
    const isV = settings.aspect==='9:16';
    const W = settings.res==='1080p' ? (isV?1080:1920) : (isV?720:1280);
    const H = settings.res==='1080p' ? (isV?1920:1080) : (isV?1280:720);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(settings.fps);
    // audio via media element source
    const ac = new AudioContext();
    const src = ac.createMediaElementSource(videoEl);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    dest.stream.getAudioTracks().forEach(t=>stream.addTrack(t));

    let mime = ['video/mp4;codecs=avc1,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus']
      .find(m=>MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: settings.bitrate*1_000_000 });
    const chunks = [];
    rec.ondataavailable = e=>{ if(e.data.size) chunks.push(e.data); };
    const done = new Promise(res=>rec.onstop=res);
    rec.start(1000);
    // play clip
    videoEl.currentTime = clip.start;
    videoEl.muted = false;
    await videoEl.play();
    const t0 = performance.now();
    const loop = ()=>{
      if(this.cancelled){ videoEl.pause(); rec.stop(); return; }
      if(videoEl.currentTime >= clip.end){ videoEl.pause(); rec.stop(); return; }
      const t = videoEl.currentTime - clip.start;
      compositor.draw({ ctx, video: videoEl, canvasW:W, canvasH:H, aspect:settings.aspect, cropX:clip.cropX??0.5, t, subtitle:this._activeSub(subtitles, videoEl.currentTime) });
      onProgress?.((t/clip.duration)*100);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    await done;
    src.disconnect(); dest.disconnect(); ac.close();
    videoEl.muted = true;
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    return { blob: new Blob(chunks, {type:mime}), ext };
  }

  _activeSub(subs, t){
    if(!subs) return null;
    return subs.find(s=>t>=s.start && t<=s.end) || null;
  }
}

function seekVideo(videoEl, t){
  return new Promise((res)=>{
    if(Math.abs(videoEl.currentTime - t) < 0.001) return res();
    const h=()=>{ videoEl.removeEventListener('seeked',h); res(); };
    videoEl.addEventListener('seeked',h,{once:true});
    videoEl.currentTime = Math.max(0, Math.min(videoEl.duration-0.02, t));
  });
}
function interleavePlanar(planes, n){
  const ch = planes.length;
  const out = new Float32Array(n*ch);
  for(let c=0;c<ch;c++) for(let i=0;i<n;i++) out[i*ch+c] = planes[c][i];
  return out;
}