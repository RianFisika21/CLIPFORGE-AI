export class AIProvider {
  constructor(cfg){ this.cfg = cfg; }
  static configFromUI(){
    return {
      provider: sessionStorage.getItem('cf.ai.provider') || 'openai',
      base: sessionStorage.getItem('cf.ai.base') || 'https://api.openai.com/v1',
      key: sessionStorage.getItem('cf.ai.key') || '',
      model: sessionStorage.getItem('cf.ai.model') || 'gpt-4o-mini'
    };
  }
  static save(cfg){
    sessionStorage.setItem('cf.ai.provider', cfg.provider);
    sessionStorage.setItem('cf.ai.base', cfg.base);
    sessionStorage.setItem('cf.ai.key', cfg.key);
    sessionStorage.setItem('cf.ai.model', cfg.model);
  }
  get enabled(){ return !!this.cfg.key; }

  async scoreTranscript(segments){
    if(!this.enabled) throw new Error('API key belum diisi.');
    const prompt = `Anda asisten editor video. Nilai setiap segmen 0-100 untuk potensi viral (hook, punchline, edukasi). Balas JSON array: [{index, score, reason}].\nSegmen:\n` +
      segments.map((s,i)=>`[${i}] ${s.text}`).join('\n');
    const res = await fetch(`${this.cfg.base.replace(/\/$/,'')}/chat/completions`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${this.cfg.key}` },
      body: JSON.stringify({ model:this.cfg.model, messages:[{role:'user',content:prompt}], temperature:0.2 })
    });
    if(!res.ok) throw new Error('AI error '+res.status);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '[]';
    try{ return JSON.parse(text.match(/\[[\s\S]*\]/)[0]); }catch{ return []; }
  }
}