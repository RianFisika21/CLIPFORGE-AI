export class Thumbnailer {
  static async generate(videoEl, t, aspect, title, sub){
    const W = aspect === '9:16' ? 540 : 960;
    const H = aspect === '9:16' ? 960 : 540;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    await new Promise(res=>{
      videoEl.currentTime = Math.max(0, Math.min(videoEl.duration-0.1, t));
      const h=()=>{videoEl.removeEventListener('seeked',h);res();};
      videoEl.addEventListener('seeked',h,{once:true});
    });
    const s = Math.max(W/videoEl.videoWidth, H/videoEl.videoHeight);
    ctx.drawImage(videoEl, (W-videoEl.videoWidth*s)/2, (H-videoEl.videoHeight*s)/2, videoEl.videoWidth*s, videoEl.videoHeight*s);
    // gradient
    const g = ctx.createLinearGradient(0,H*0.5,0,H);
    g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,.85)');
    ctx.fillStyle=g; ctx.fillRect(0,H*0.5,W,H*0.5);
    // title
    ctx.fillStyle='#fff'; ctx.textAlign='left'; ctx.textBaseline='bottom';
    ctx.font=`800 ${W*0.06}px system-ui`;
    wrap(ctx, title, W*0.06, H*0.85, W*0.88, W*0.06*1.2);
    if(sub){ ctx.font=`500 ${W*0.035}px system-ui`; ctx.fillStyle='#00e5ff'; ctx.fillText(sub, W*0.06, H*0.92); }
    return canvas.toDataURL('image/jpeg', 0.85);
  }
}
function wrap(ctx, text, x, y, maxW, lh){
  const words = text.split(' '); let line=''; let yy=y;
  const lines=[];
  for(const w of words){ const test=line?line+' '+w:w; if(ctx.measureText(test).width>maxW && line){ lines.push(line); line=w; } else line=test; }
  if(line) lines.push(line);
  lines.reverse().forEach((l,i)=>{ ctx.fillText(l, x, yy - i*lh); });
}