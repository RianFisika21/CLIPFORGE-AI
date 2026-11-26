import { $, $$, toast, confirmModal, fmtTime, parseTime, clamp, uid } from '../core/utils.js';
import { HardwareProfiler } from '../core/HardwareProfiler.js';
import { VideoLoader } from '../core/VideoLoader.js';
import { AudioAnalyzer } from '../analysis/AudioAnalyzer.js';
import { VisualAnalyzer } from '../analysis/VisualAnalyzer.js';
import { HighlightScorer } from '../analysis/HighlightScorer.js';
import { SubtitleIO } from '../subtitles/SubtitleIO.js';
import { Compositor } from '../render/Compositor.js';
import { Thumbnailer } from '../render/Thumbnailer.js';
import { ExportEngine } from '../export/ExportEngine.js';
import { AIProvider } from '../ai/AIProvider.js';

export class App {
  constructor(){
    this.profiler = new HardwareProfiler();
    this.loader = new VideoLoader($('#preview'));
    this.compositor = new Compositor();
    this.exporter = null;
    this.state = {
      videoMeta:null, analysis:null, candidates:[], clips:[], subtitles:[],
      selectedClip:null, ai: AIProvider.configFromUI()
    };
  }

  async init(){
    this._bindTheme();
    this._bindNav();
    this._bindUpload();
    this._bindAnalysis();
    this._bindClips();
    this._bindSubtitles();
    this._bindExport();
    this._bindSettings();
    this._bindPlayer();
    this._renderHW();
    await this._renderCompat();
    this._autosaveLoop();
  }

  _bindTheme(){
    const sel = $('#themeSwitcher');
    sel.value = localStorage.getItem('cf.theme') || 'midnight';
    document.documentElement.dataset.theme = sel.value;
    sel.onchange = ()=>{ document.documentElement.dataset.theme = sel.value; localStorage.setItem('cf.theme', sel.value); };
    $('#projectName').oninput = (e)=> localStorage.setItem('cf.projectName', e.target.value);
    $('#projectName').value = localStorage.getItem('cf.projectName') || 'Untitled Project';
  }

  _bindNav(){
    $$('.nav-item').forEach(b=>{
      b.onclick = ()=>{
        $$('.nav-item').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        $$('.view').forEach(v=>v.classList.remove('active'));
        $('#view-'+b.dataset.view)?.classList.add('active');
        if(b.dataset.view==='thumbnails') this._renderThumbGrid();
      };
    });
  }

  _bindUpload(){
    const dz = $('#dropZone'), fi = $('#fileInput');
    $('#btnBrowse').onclick = ()=> fi.click();
    fi.onchange = ()=> fi.files[0] && this._handleFile(fi.files[0]);
    ['dragenter','dragover'].forEach(ev=> dz.addEventListener(ev, e=>{e.preventDefault();dz.classList.add('drag');}));
    ['dragleave','drop'].forEach(ev=> dz.addEventListener(ev, e=>{e.preventDefault();dz.classList.remove('drag');}));
    dz.addEventListener('drop', e=>{ const f=e.dataTransfer.files[0]; if(f) this._handleFile(f); });
    $('#btnRemoveVideo').onclick = async ()=>{
      if(await confirmModal('Hapus video?','Semua hasil analisis akan hilang.')){
        this.loader.revoke(); this.state = {...this.state, videoMeta:null, analysis:null, candidates:[], clips:[]};
        $('#videoMeta').classList.add('hidden'); $('#uploadActions').style.display='none';
        toast('Video dihapus.');
      }
    };
  }

  async _handleFile(file){
    try{
      if(!/^video\//.test(file.type) && !/\.(mp4|mov|webm)$/i.test(file.name)) throw new Error('Format bukan video.');
      const meta = await this.loader.load(file);
      this.state.videoMeta = meta;
      this._renderVideoMeta(meta);
      $('#uploadActions').style.display = 'flex';
      $('#videoMeta').classList.remove('hidden');
      toast(`Video dimuat: ${meta.width}×${meta.height} • ${fmtTime(meta.duration)}`);
      this._renderProjectSummary();
    }catch(err){ toast('Gagal memuat: '+err.message, 6000); }
  }

  _renderVideoMeta(m){
    const sizeMB = (m.size/1048576).toFixed(1);
    $('#videoMeta').innerHTML = `
      <div><b>Nama</b>${m.name}</div>
      <div><b>Ukuran</b>${sizeMB} MB</div>
      <div><b>Resolusi</b>${m.width}×${m.height}</div>
      <div><b>Aspect</b>${m.aspect}</div>
      <div><b>Durasi</b>${fmtTime(m.duration)}</div>
      <div><b>Estimasi FPS</b>${m.fps}</div>
      <div><b>Container</b>${m.type||'video/*'}</div>`;
  }

  _bindAnalysis(){
    $('#clipCount').onchange = e=> $('#customCountWrap').classList.toggle('hidden', e.target.value!=='custom');
    $('#targetDur').onchange = e=> $('#customDurWrap').classList.toggle('hidden', e.target.value!=='custom');
    $('#btnRunAnalysis').onclick = ()=> this._runAnalysis();
    $('#btnCancelAnalysis').onclick = ()=>{ this.audio?.cancel(); this.visual?.cancel(); toast('Analisis dibatalkan.'); };
  }

  async _runAnalysis(){
    if(!this.state.videoMeta) return toast('Upload video dulu.');
    const wantCount = $('#clipCount').value==='custom' ? +$('#customCount').value : +$('#clipCount').value;
    const targetDur = $('#targetDur').value==='custom' ? +$('#customDur').value : +$('#targetDur').value;
    const log = $('#analysisLog'); log.textContent='';
    const bar = $('#analysisBar'); bar.style.width='0%';
    $('#btnRunAnalysis').disabled = true; $('#btnCancelAnalysis').disabled = false;
    try{
      log.textContent += 'Mengekstrak audio (streaming)…\n';
      this.audio = new AudioAnalyzer();
      const audioRaw = await this.audio.extract(this.loader.file, (pct,stage)=>{ bar.style.width = (pct*0.5)+'%'; });
      log.textContent += `Audio: ${audioRaw.pcm.length} sampel @16kHz\n`;
      bar.style.width='50%';
      log.textContent += 'Menghitung fitur audio…\n';
      const audioFeat = AudioAnalyzer.features(audioRaw.pcm, audioRaw.sampleRate);

      log.textContent += 'Menganalisis frame proxy…\n';
      this.visual = new VisualAnalyzer(this.loader.video);
      const visual = await this.visual.analyze(
        this.state.videoMeta.duration, this.profiler.profile.proxyW, this.profiler.profile.proxyH,
        pct=>{ bar.style.width = (50+pct*0.4)+'%'; }
      );
      log.textContent += 'Menghitung skor highlight + NMS…\n';
      const candidates = HighlightScorer.score({
        audio: audioFeat, visual, duration: this.state.videoMeta.duration,
        targetDur, wantCount
      });
      this.state.analysis = { audioFeat, visual };
      this.state.candidates = candidates;
      this._renderCandidates();
      bar.style.width='100%';
      log.textContent += candidates.length
        ? `Selesai. ${candidates.length} kandidat di atas ambang.\n`
        : 'Tidak ada kandidat di atas ambang kelayakan. Video terlalu datar.\n';
      if(!candidates.length) toast('Tidak ada kandidat layak. Coba durasi target lebih pendek.', 5000);
    }catch(err){ toast('Analisis gagal: '+err.message, 6000); log.textContent += 'ERROR: '+err.message+'\n'; }
    finally{ $('#btnRunAnalysis').disabled=false; $('#btnCancelAnalysis').disabled=true; }
  }

  _renderCandidates(){
    const box = $('#candidateList');
    if(!this.state.candidates.length){ box.innerHTML='<div class="empty">Tidak ada kandidat.</div>'; return; }
    box.innerHTML = this.state.candidates.map((c,i)=>`
      <div class="candidate" data-i="${i}">
        <div><b>Clip ${i+1}</b><span class="score">${c.engagement.toFixed(0)}</span></div>
        <div class="times">${fmtTime(c.start)} → ${fmtTime(c.end)} (${c.duration}s)</div>
        <div class="reason">${c.reason}</div>
        <div class="row gap" style="margin-top:6px">
          <button class="btn btn-ghost btn-sm" data-act="make">Buat Clip</button>
          <button class="btn btn-ghost btn-sm" data-act="preview">Preview</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('.candidate').forEach(el=>{
      const i = +el.dataset.i, c = this.state.candidates[i];
      el.querySelector('[data-act=make]').onclick = ()=> this._makeClip(c);
      el.querySelector('[data-act=preview]').onclick = ()=> this._previewRange(c.start, c.end);
      el.onclick = (e)=>{ if(e.target.tagName!=='BUTTON') this._previewRange(c.start,c.end); };
    });
  }

  _makeClip(c){
    const clip = {
      id: uid(), title:`Clip ${this.state.clips.length+1}`,
      start:c.start, end:c.end, duration:c.end-c.start,
      score:c.engagement, sub:c, cropX:0.5, thumb:null
    };
    this.state.clips.push(clip);
    this._renderClips();
    toast('Clip dibuat: '+clip.title);
  }

  _bindClips(){
    $('#btnAddManualClip').onclick = ()=>{
      const dur = this.state.videoMeta?.duration || 30;
      this.state.clips.push({ id:uid(), title:`Manual ${this.state.clips.length+1}`, start:0, end:Math.min(30,dur), duration:Math.min(30,dur), score:0, sub:{}, cropX:0.5, thumb:null });
      this._renderClips();
    };
  }

  _renderClips(){
    const box = $('#clipList');
    if(!this.state.clips.length){ box.innerHTML='<div class="empty">Belum ada clip.</div>'; return; }
    box.innerHTML = this.state.clips.map((c,i)=>`
      <div class="clip" data-i="${i}">
        <div class="row space-between"><b>${c.title}</b><span class="score">${Math.round(c.score)}</span></div>
        <div class="times">${fmtTime(c.start)} → ${fmtTime(c.end)} • ${(c.end-c.start).toFixed(1)}s</div>
        <div class="row gap" style="margin-top:6px">
          <button class="btn btn-ghost btn-sm" data-act="preview">Preview</button>
          <button class="btn btn-ghost btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-ghost btn-sm" data-act="thumb">Thumbnail</button>
          <button class="btn btn-danger btn-sm" data-act="del">Hapus</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('.clip').forEach(el=>{
      const i = +el.dataset.i, c = this.state.clips[i];
      el.querySelector('[data-act=preview]').onclick = ()=> this._previewRange(c.start, c.end);
      el.querySelector('[data-act=edit]').onclick = ()=> this._editClip(c);
      el.querySelector('[data-act=thumb]').onclick = ()=> this._makeThumb(c);
      el.querySelector('[data-act=del]').onclick = ()=>{ this.state.clips.splice(i,1); this._renderClips(); };
    });
  }

  _editClip(c){
    const box = $('#modalBox');
    box.innerHTML = `<h3>Edit ${c.title}</h3>
      <label>Start (HH:MM:SS.mmm)<input id="eStart" class="input" value="${fmtTime(c.start)}"></label>
      <label>End<input id="eEnd" class="input" value="${fmtTime(c.end)}"></label>
      <div class="row gap"><button class="btn btn-ghost" id="eNudgeL">-0.5s</button><button class="btn btn-ghost" id="eNudgeR">+0.5s</button></div>
      <label>Judul<input id="eTitle" class="input" value="${c.title}"></label>
      <div class="row gap" style="margin-top:10px"><button class="btn btn-primary" id="eSave">Simpan</button><button class="btn btn-ghost" id="eClose">Tutup</button></div>`;
    $('#modal').classList.remove('hidden');
    $('#eClose').onclick = ()=> $('#modal').classList.add('hidden');
    $('#eNudgeL').onclick = ()=>{ c.start=Math.max(0,c.start-0.5); $('#eStart').value=fmtTime(c.start); c.duration=c.end-c.start; };
    $('#eNudgeR').onclick = ()=>{ c.end=Math.min(this.state.videoMeta.duration,c.end+0.5); $('#eEnd').value=fmtTime(c.end); c.duration=c.end-c.start; };
    $('#eSave').onclick = ()=>{
      c.start = parseTime($('#eStart').value); c.end = parseTime($('#eEnd').value);
      if(c.end<=c.start) return toast('End harus > Start');
      c.title = $('#eTitle').value; c.duration = c.end-c.start;
      this._renderClips(); $('#modal').classList.add('hidden'); toast('Clip diperbarui.');
    };
  }

  async _makeThumb(c){
    const data = await Thumbnailer.generate(this.loader.video, c.start + (c.end-c.start)*0.3, '9:16', c.title, 'Clip');
    c.thumb = data;
    this._renderThumbGrid();
    toast('Thumbnail dibuat.');
  }

  _renderThumbGrid(){
    const box = $('#thumbGrid');
    if(!this.state.clips.length){ box.innerHTML='<div class="empty">Belum ada clip.</div>'; return; }
    box.innerHTML = this.state.clips.map((c,i)=>`
      <div class="thumb-item" data-i="${i}">
        ${c.thumb?`<img src="${c.thumb}" style="width:100%;border-radius:8px">`:`<div class="empty">Belum ada thumb</div>`}
        <div class="row space-between" style="margin-top:6px"><b class="small">${c.title}</b>
          <button class="btn btn-ghost btn-sm" data-act="gen">Generate</button></div>
        ${c.thumb?`<button class="btn btn-ghost btn-sm" data-act="dl">Download JPG</button>`:''}
      </div>`).join('');
    box.querySelectorAll('.thumb-item').forEach(el=>{
      const i=+el.dataset.i, c=this.state.clips[i];
      el.querySelector('[data-act=gen]').onclick = ()=> this._makeThumb(c);
      el.querySelector('[data-act=dl]')?.addEventListener('click', ()=>{
        const a=document.createElement('a'); a.href=c.thumb; a.download=`${c.title.replace(/\s+/g,'_')}.jpg`; a.click();
      });
    });
  }

  _bindSubtitles(){
    $('#srtInput').onchange = async (e)=>{
      const f = e.target.files[0]; if(!f) return;
      const txt = await f.text();
      const segs = f.name.endsWith('.vtt') ? SubtitleIO.parseVTT(txt) : SubtitleIO.parseSRT(txt);
      this.state.subtitles = segs; this._renderSubtitles(); toast(`${segs.length} segmen diimpor.`);
    };
    $('#btnImportSrt').onclick = ()=> $('#srtInput').click();
    $('#btnExportSrt').onclick = ()=> SubtitleIO.download('subtitles.srt', SubtitleIO.toSRT(this.state.subtitles));
    $('#btnExportVtt').onclick = ()=> SubtitleIO.download('subtitles.vtt', SubtitleIO.toVTT(this.state.subtitles), 'text/vtt');
    $('#subPreset').onchange = e=>{
      const p = e.target.value;
      const presets = {
        modern:{fontSize:36,color:'#ffffff',highlight:'#00e5ff',outline:3,bgOpacity:0.35},
        bold:{fontSize:44,color:'#ffffff',highlight:'#ffeb3b',outline:6,bgOpacity:0.2},
        karaoke:{fontSize:38,color:'#ffffff',highlight:'#ff4081',outline:4,bgOpacity:0.0},
        podcast:{fontSize:34,color:'#ffffff',highlight:'#4caf50',outline:2,bgOpacity:0.6},
        cinematic:{fontSize:32,color:'#f5e6c8',highlight:'#d4af37',outline:2,bgOpacity:0.0},
        viral:{fontSize:46,color:'#ffffff',highlight:'#ff1744',outline:6,bgOpacity:0.3},
        clean:{fontSize:30,color:'#ffffff',highlight:'#2196f3',outline:2,bgOpacity:0.5}
      }[p];
      Object.assign(this.compositor.style, {preset:p, ...presets});
      this._syncSubStyleUI();
    };
    ['subSize','subColor','subHighlight','subOutline','subBgOpacity'].forEach(id=>{
      $('#'+id).oninput = ()=> this._syncSubStyleUI();
    });
  }
  _syncSubStyleUI(){
    Object.assign(this.compositor.style, {
      fontSize:+$('#subSize').value, color:$('#subColor').value,
      highlight:$('#subHighlight').value, outline:+$('#subOutline').value,
      bgOpacity:+$('#subBgOpacity').value/100
    });
    $('#subSize').value = this.compositor.style.fontSize;
    $('#subColor').value = this.compositor.style.color;
    $('#subHighlight').value = this.compositor.style.highlight;
    $('#subOutline').value = this.compositor.style.outline;
    $('#subBgOpacity').value = Math.round(this.compositor.style.bgOpacity*100);
  }
  _renderSubtitles(){
    const box = $('#subtitleList');
    if(!this.state.subtitles.length){ box.innerHTML='<div class="empty">Belum ada subtitle.</div>'; return; }
    box.innerHTML = this.state.subtitles.map((s,i)=>`
      <div class="subtitle-item"><div class="times">${fmtTime(s.start)} → ${fmtTime(s.end)}</div>
      <div class="row gap"><input class="input" data-i="${i}" value="${s.text.replace(/"/g,'&quot;')}"></div></div>`).join('');
    box.querySelectorAll('input').forEach(inp=>{
      inp.onchange = ()=>{ this.state.subtitles[+inp.dataset.i].text = inp.value; };
    });
  }

  _bindExport(){
    $('#btnExportAll').onclick = ()=> this._exportQueue(this.state.clips);
    $('#btnExportSelected').onclick = ()=> this._exportQueue(this.state.clips.slice(0,1));
    $('#btnCancelExport').onclick = ()=>{ this.exporter?.cancelled = true; toast('Export dibatalkan.'); };
  }

  async _exportQueue(clips){
    if(!clips.length) return toast('Tidak ada clip.');
    this.exporter = new ExportEngine(this.profiler);
    const settings = {
      res: $('#expRes').value, fps:+$('#expFps').value,
      aspect: $('#expAspect').value, bitrate:+$('#expBitrate').value
    };
    const box = $('#exportQueue'); box.innerHTML='';
    $('#btnCancelExport').disabled = false;
    for(const c of clips){
      if(this.exporter.cancelled) break;
      const item = document.createElement('div');
      item.className='export-item';
      item.innerHTML = `<div class="row space-between"><b>${c.title}</b><span class="status">Queued</span></div>
        <div class="progress"><div class="fill" style="width:0%"></div></div>`;
      box.appendChild(item);
      const status = item.querySelector('.status'), fill = item.querySelector('.fill');
      status.textContent='Rendering…';
      try{
        const out = await this.exporter.exportClip({
          videoEl: this.loader.video, file: this.loader.file, clip: c, settings,
          compositor: this.compositor, subtitles: this.state.subtitles,
          onProgress: p=>{ fill.style.width=p+'%'; }
        });
        const blob = out.blob || out;
        const ext = out.ext || 'mp4';
        const url = URL.createObjectURL(blob);
        status.textContent='Completed';
        item.innerHTML += `<a class="btn btn-primary btn-sm" href="${url}" download="${c.title.replace(/\s+/g,'_')}.${ext}">Download .${ext}</a>`;
      }catch(err){
        status.textContent='Failed: '+err.message;
        item.querySelector('.progress').classList.add('hidden');
      }
    }
    $('#btnCancelExport').disabled = true;
    toast('Antrean ekspor selesai.');
  }

  _bindSettings(){
    $('#btnSaveAI').onclick = ()=>{
      AIProvider.save({
        provider: $('#aiProvider').value, base: $('#aiBase').value,
        key: $('#aiKey').value, model: $('#aiModel').value
      });
      this.state.ai = AIProvider.configFromUI();
      toast('Konfigurasi AI disimpan (sessionStorage).');
    };
    $('#aiBase').value = this.state.ai.base;
    $('#aiModel').value = this.state.ai.model;
  }

  _bindPlayer(){
    const play = $('#btnPlay'), v = this.loader.video;
    play.onclick = ()=>{ if(v.paused){ v.play(); play.textContent='⏸'; } else { v.pause(); play.textContent='▶'; } };
    v.addEventListener('timeupdate', ()=> $('#timeDisplay').textContent = fmtTime(v.currentTime));
  }

  _previewRange(start, end){
    const v = this.loader.video;
    v.currentTime = start;
    v.play();
    const loop = ()=>{
      if(v.currentTime >= end){ v.pause(); v.removeEventListener('timeupdate', loop); }
    };
    v.addEventListener('timeupdate', loop);
  }

  _renderHW(){
    const p = this.profiler.profile;
    $('#hwBadge').textContent = `${p.name} • ${this.profiler.cores}T • ${this.profiler.memGB}GB`;
    $('#hwCard').innerHTML = `
      <div><b>Profil:</b> ${p.name}</div>
      <div><b>CPU Threads:</b> ${this.profiler.cores}</div>
      <div><b>RAM:</b> ${this.profiler.memGB} GB</div>
      <div><b>GPU:</b> ${this.profiler.gpu}</div>
      <div><b>Worker pool:</b> ${p.workers}</div>
      <div><b>Proxy:</b> ${p.proxyW}×${p.proxyH}</div>
      <div><b>Rekomendasi ekspor:</b> ${p.defaultRes} @ ${p.defaultFps}fps</div>`;
  }

  async _renderCompat(){
    const codes = await this.profiler.detectCodecs();
    const items = [
      ['VideoEncoder', 'VideoEncoder' in window],
      ['AudioEncoder', 'AudioEncoder' in window],
      ['VideoDecoder', 'VideoDecoder' in window],
      ['AudioDecoder', 'AudioDecoder' in window],
      ['MediaRecorder', 'MediaRecorder' in window],
      ['OffscreenCanvas', 'OffscreenCanvas' in window],
      ['IndexedDB', 'indexedDB' in window],
      ['isSecureContext', window.isSecureContext],
      ...Object.entries(codes.video).map(([k,v])=>[`H.264 ${k}`, v]),
      ...Object.entries(codes.audio).map(([k,v])=>[`AAC ${k}`, v])
    ];
    $('#compatPanel').innerHTML = items.map(([k,v])=>`
      <div class="compat-item"><span><span class="dot ${v?'ok':'bad'}"></span>${k}</span><span>${v?'OK':'Tidak'}</span></div>`).join('');
  }

  _renderProjectSummary(){
    const m = this.state.videoMeta;
    $('#projectSummary').innerHTML = m
      ? `<div><b>${m.name}</b></div><div class="small muted">${m.width}×${m.height} • ${fmtTime(m.duration)}</div>`
      : 'Belum ada video.';
  }

  _autosaveLoop(){
    setInterval(()=>{
      try{
        localStorage.setItem('cf.autosave', JSON.stringify({
          clips: this.state.clips, subtitles: this.state.subtitles, ts: Date.now()
        }));
      }catch{}
    }, 30000);
  }
}