export class SubtitleIO {
  static parseSRT(text){
    const segs = [];
    const blocks = text.replace(/\r/g,'').split(/\n\n+/);
    for(const b of blocks){
      const lines = b.split('\n').filter(l=>l.trim());
      if(lines.length < 2) continue;
      const m = lines[0].match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3}) --> (\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
      if(!m) continue;
      const s = (+m[1])*3600+(+m[2])*60+(+m[3])+(+m[4])/1000;
      const e = (+m[5])*3600+(+m[6])*60+(+m[7])+(+m[8])/1000;
      const textContent = lines.slice(1).join(' ');
      segs.push({ start:s, end:e, text:textContent });
    }
    return segs;
  }
  static parseVTT(text){
    return this.parseSRT(text.replace('WEBVTT',''));
  }
  static toSRT(segs){
    const f = (t)=>{
      const h=Math.floor(t/3600), m=Math.floor(t%3600/60), s=Math.floor(t%60), ms=Math.round((t%1)*1000);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
    };
    return segs.map((s,i)=>`${i+1}\n${f(s.start)} --> ${f(s.end)}\n${s.text}`).join('\n\n');
  }
  static toVTT(segs){
    const f = (t)=>{
      const h=Math.floor(t/3600), m=Math.floor(t%3600/60), s=Math.floor(t%60), ms=Math.round((t%1)*1000);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
    };
    return 'WEBVTT\n\n' + segs.map((s,i)=>`${i+1}\n${f(s.start)} --> ${f(s.end)}\n${s.text}`).join('\n\n');
  }
  static download(name, content, mime='text/plain'){
    const blob = new Blob([content], {type:mime});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 3000);
  }
}