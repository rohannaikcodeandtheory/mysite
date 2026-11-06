// EDS Parts Finder diagnostics and cascading vehicle selection.
// Configure a same-origin /api/catalog proxy for local EDS development when CORS is unavailable.
const create = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
const dropdown = (name) => {
  const label = create('label', name);
  const select = create('select'); select.setAttribute('aria-label', name);
  label.append(select);
  return { label, select, name };
};
const optionsFor = (data, route) => {
  const values = Array.isArray(data) ? data : data?.[route] ?? data?.data?.[route] ?? data?.results;
  if (!Array.isArray(values)) return null;
  return values.map((item) => {
    if (typeof item !== 'object' || item === null) return { value: String(item), label: String(item) };
    const value = item.id ?? item.year_id ?? item.make_id ?? item.model_id ?? item.value;
    return value == null ? null : { value: String(value), label: String(item.name ?? item.label ?? item.year ?? item.value ?? value) };
  }).filter(Boolean);
};
export default function decorate(block) {
  block.replaceChildren();
  const mode = dropdown('API environment');
  mode.select.append(new Option('Deployed / same-origin', 'deployed'), new Option('Local Edge Function (127.0.0.1:7676)', 'local'));
  const endpoint = create('input'); endpoint.type = 'url'; endpoint.placeholder = 'Custom API origin (optional)'; endpoint.setAttribute('aria-label', 'Custom API origin');
  const brand = create('input'); brand.value = 'corporate'; brand.setAttribute('aria-label', 'Brand');
  const country = dropdown('Country'); [['US', 'US'], ['CA', 'CA'], ['MX', 'MX']].forEach(([a,b]) => country.select.append(new Option(a,b)));
  const group = dropdown('Vehicle group'); group.select.append(new Option('Select vehicle group',''), new Option('Groups 2,8','2,8'), new Option('Group 7','7'));
  const year = dropdown('Year'); const make = dropdown('Make'); const model = dropdown('Model');
  const run = create('button', 'Find Parts'); const health = create('button', 'Test API health');
  const route = dropdown('Direct API test');
  ['years','makes','models','parts','parts-light','search','engine-mfrs','engine-bases','engine-usages','engine-versions-ld','engine-parts-ld'].forEach((v) => route.select.append(new Option(v,v)));
  const extra = create('input'); extra.placeholder = 'Additional query: part_number=...'; extra.setAttribute('aria-label', 'Additional query parameters');
  const test = create('button', 'Test selected API');
  const status = create('p'); status.setAttribute('aria-live','polite');
  const output = create('pre'); output.className = 'parts-finder-response';
  block.append(mode.label, endpoint, create('label','Brand'), brand, country.label, group.label, year.label, make.label, model.label, run, health, route.label, extra, test, status, output);
  const fields = [year,make,model];
  const reset = (index=0) => { fields.slice(index).forEach(({select,name}) => { select.replaceChildren(new Option(`Select ${name}`,'')); select.disabled=true; }); run.disabled=true; };
  reset();
  let generation=0;
  const base = () => {
    if (endpoint.value.trim()) return new URL(endpoint.value.trim());
    return new URL(mode.select.value === 'local' ? 'http://127.0.0.1:7676' : window.location.origin);
  };
  const shared = () => ({brand:brand.value.trim(), country_code:country.select.value, locale:'en_US', vehicle_group_ids:group.select.value});
  async function load(name, params={}, target=null) {
    const current=++generation;
    let url;
    try {
      url=new URL(`/api/catalog/${name}`,base());
      Object.entries(params).forEach(([key,value]) => { if(value!=='' && value!=null) url.searchParams.set(key,value); });
      status.textContent=`Loading ${name}...`;
      const start=performance.now();
      const response=await fetch(url,{headers:{Accept:'application/json'}});
      const elapsed=Math.round(performance.now()-start);
      const body=await response.text();
      if(current!==generation) return;
      let data; try { data=JSON.parse(body); } catch { data={raw:body.slice(0,3000)}; }
      const id=response.headers.get('X-Request-ID') || data?.error?.requestId || 'unavailable';
      status.textContent=`${name}: HTTP ${response.status} | ${elapsed} ms | request ID ${id}`;
      output.textContent=JSON.stringify({requestUrl:url.toString(),status:response.status,requestId:id,data},null,2);
      if(!response.ok) return;
      const entries=optionsFor(data,name);
      if(target && entries) {
        target.select.replaceChildren(new Option(`Select ${target.name}`,''));
        entries.forEach(({value,label}) => target.select.append(new Option(label,value)));
        target.select.disabled=entries.length===0;
        status.textContent+=` | ${entries.length} results`;
      }
    } catch (error) { if(current===generation) { status.textContent=`Network/CORS error: ${error.message}`; output.textContent='Verify the Edge Function is running and configure a local same-origin proxy or approved CORS policy.'; } }
  }
  group.select.addEventListener('change',()=>{ ++generation; reset(); if(group.select.value) load('years',shared(),year); });
  year.select.addEventListener('change',()=>{ ++generation; reset(1); if(year.select.value) load('makes',{...shared(),year_id:year.select.value},make); });
  make.select.addEventListener('change',()=>{ ++generation; reset(2); if(make.select.value) load('models',{...shared(),year_id:year.select.value,make_id:make.select.value},model); });
  model.select.addEventListener('change',()=>{run.disabled=!model.select.value;});
  run.addEventListener('click',()=>load('parts',{...shared(),year_id:year.select.value,make_id:make.select.value,model_id:model.select.value,page:'1',limit:'50'}));
  health.addEventListener('click',()=>load('health'));
  test.addEventListener('click',()=>{const params={...shared(),year_id:year.select.value,make_id:make.select.value,model_id:model.select.value}; const additional=new URLSearchParams(extra.value); additional.forEach((v,k)=>{params[k]=v;});load(route.select.value,params);});
}
