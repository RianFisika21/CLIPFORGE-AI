export class Compositor {
  constructor(){
    this.logo = null;
    this.style = {
      preset:'modern', fontSize:36, color:'#ffffff', highlight:'#00e5ff',
      outline:3, bgOpacity:0.45
    };
    this.effects = { zoom:'none', zoomAmt:60, grade:'none', vignette:0, grain:0 };
    this.branding = { pos:'tr', scale:12, opacity:100 };
  }

  setLogo(img){ this.logo = img; }

  draw({ ctx, video, canvasW, canvasH, aspect, reframeMode='center', cropX=0.5, t, subtitle }) {
    const vw = video.videoWidth, vh = video.videoHeight;
    ctx.clearRect(0,0,canvasW,canvasH);

    // Zoom effect
    const zoom = this._zoom(t, subtitle?.duration || 1);
    const baseScale = (aspect==='9:16')
      ? Math.max(canvasW/vw, canvasH/vh) * zoom
      : Math.max(canvasW/vw, canvasH/vh) * zoom;

    if(reframeMode === 'blur'){
      // Background blur fill
      ctx.filter = 'blur(20px)';
      const s = Math.max(canvasW/vw, canvasH/vh);
      ctx.drawImage(video, (canvasW-vw*s)/2, (canvasH-vh*s)/2, vw*s, vh*s);
      ctx.filter = 'none';
      const fit = Math.min(canvasW/vw, canvasH/vh);
      ctx.drawImage(video, (canvasW-vw*fit)/2, (canvasH-vh*fit)/2, vw*fit, vh*fit);
    }else{
      // Crop with horizontal pan (cropX 0..1)
      const drawW = vw*baseScale, drawH = vh*baseScale;
      let dx = (canvasW - drawW)/2, dy = (canvasH - drawH)/2;
      if(aspect === '9:16'){
        dx = -(cropX * (drawW - canvasW));
      }
      ctx.drawImage(video, dx, dy, drawW, drawH);
    }

    // Color grade
    if(this.effects.grade === 'cinematic'){
      ctx.fillStyle='rgba(10,20,40,.18)'; ctx.fillRect(0,0,canvasW,canvasH);
    }else if(this.effects.grade === 'contrast'){
      ctx.globalCompositeOperation='overlay';
      ctx.fillStyle='rgba(128,128,128,.15)'; ctx.fillRect(0,0,canvasW,canvasH);
      ctx.globalCompositeOperation='source-over';
    }

    // Vignette
    if(this.effects.vignette > 0){
      const g = ctx.createRadialGradient(canvasW/2,canvasH/2,canvasH*0.3, canvasW/2,canvasH/2,canvasH*0.75);
      g.addColorStop(0,'rgba(0,0,0,0)');
      g.addColorStop(1,`rgba(0,0,0,${this.effects.vignette/100*0.7})`);
      ctx.fillStyle=g; ctx.fillRect(0,0,canvasW,canvasH);
    }

    // Branding logo
    if(this.logo){
      const lw = canvasW * this.branding.scale/100;
      const lh = lw * (this.logo.height/this.logo.width);
      const m = Math.round(canvasW*0.03);
      let lx = canvasW - lw - m, ly = m;
      if(this.branding.pos==='tl'){ lx=m; ly=m; }
      else if(this.branding.pos==='br'){ lx=canvasW-lw-m; ly=canvasH-lh-m; }
      else if(this.branding.pos==='bl'){ lx=m; ly=canvasH-lh-m; }
      else if(this.branding.pos==='tc'){ lx=(canvasW-lw)/2; ly=m; }
      ctx.globalAlpha = this.branding.opacity/100;
      ctx.drawImage(this.logo, lx, ly, lw, lh);
      ctx.globalAlpha = 1;
    }

    // Burn-in subtitle
    if(subtitle && subtitle.text){
      this._drawSubtitle(ctx, canvasW, canvasH, subtitle);
    }
  }

  _zoom(t, dur){
    const a = this.effects.zoomAmt/100;
    if(this.effects.zoom === 'in')  return 1 + 0.12*a*(t/dur);
    if(this.effects.zoom === 'out') return 1.12 - 0.12*a*(t/dur);
    if(this.effects.zoom === 'punch') return 1 + 0.08*a*Math.sin(Math.PI*(t/dur));
    return 1;
  }

  _drawSubtitle(ctx, W, H, sub){
    const st = this.style;
    ctx.save();
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font = `700 ${st.fontSize * (W/1080)}px ${st.preset==='cinematic'?'Georgia,serif':'system-ui,sans-serif'}`;
    const x = W/2, y = H*0.85;
    // background
    if(st.bgOpacity > 0){
      const lines = sub.text.split('\n');
      const lh = st.fontSize * (W/1080) * 1.3;
      const maxW = Math.max(...lines.map(l=>ctx.measureText(l).width)) + 24;
      ctx.fillStyle = `rgba(0,0,0,${st.bgOpacity})`;
      ctx.fillRect(x-maxW/2, y-lh*lines.length/2, maxW, lh*lines.length);
    }
    const lines = sub.text.split('\n');
    const lh = st.fontSize * (W/1080) * 1.3;
    lines.forEach((line,i)=>{
      const yy = y - lh*(lines.length-1)/2 + i*lh;
      if(st.outline > 0){
        ctx.lineWidth = st.outline * (W/1080);
        ctx.strokeStyle = '#000';
        ctx.strokeText(line, x, yy);
      }
      ctx.fillStyle = st.color;
      ctx.fillText(line, x, yy);
    });
    ctx.restore();
  }
}