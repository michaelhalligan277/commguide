/* Comm Guide — Roads tab.
   USFS National Forest System Roads drawn on a map, each road its own colour, with crew edits
   (slang names, condition, notes, colour, crew-road star) saved on THIS phone.

   Data rule: road geometry and official attributes come live from the USFS Enterprise Data
   Warehouse (EDW_RoadBasic_01, layer 0). Nothing is hand-typed. Fetched cells are cached in
   IndexedDB so previously viewed / downloaded areas work with no signal.
   Crew edits: localStorage 'cg_roads_v1' = { v:1, edits:{ <roadKey>:{slang,cond,note,color,star,ts} } } */
(function(){
  if(window.__cgRoads) return;

  var SVC='https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer/0/query';
  var FIELDS='objectid,id,name,surface_type,oper_maint_level,route_status,symbol_code,seg_length,county';
  var CELL=0.05;          // degrees per fetch cell (~5 km)
  var MIN_ZOOM=11;        // don't draw/fetch roads zoomed out further than this
  var LABEL_ZOOM=13;
  var MAX_CELLS_VIEW=30;
  var LSKEY='cg_roads_v1';
  var DBNAME='cg_roads_db', STORE='cells';

  // ---- condition set: colour = casing under the road line, so the road keeps its own colour ----
  var CONDS=[
    {k:'',     label:'Not reported', col:null,      dash:null},
    {k:'good', label:'Good',         col:'#3FB950', dash:null},
    {k:'rough',label:'Rough',        col:'#FFB23E', dash:null},
    {k:'4wd',  label:'4WD / high clearance', col:'#FF7A45', dash:null},
    {k:'snow', label:'Snow / ice',   col:'#9ED8FF', dash:null},
    {k:'wash', label:'Washout / blocked', col:'#E5484D', dash:'2 9'},
    {k:'closed',label:'Gated / closed',col:'#E5484D', dash:'10 8'}
  ];
  function cond(k){ for(var i=0;i<CONDS.length;i++) if(CONDS[i].k===k) return CONDS[i]; return CONDS[0]; }

  var SWATCHES=['#FF5C5C','#FF9A3D','#FFD23F','#8BE04E','#2ED3A0','#2EC8F0','#4C8DFF','#9B7BFF','#E36BFF','#FF6BB5','#C9A27A','#E8EDF2'];

  function esc(s){ return (''+(s==null?'':s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ---------- crew edits (localStorage) ----------
  function loadStore(){ try{ var o=JSON.parse(localStorage.getItem(LSKEY)||'null'); if(o&&o.edits) return o; }catch(e){} return {v:1,edits:{}}; }
  var store=loadStore();
  function saveStore(){ try{ localStorage.setItem(LSKEY,JSON.stringify(store)); return true; }catch(e){ return false; } }

  // ---------- IndexedDB cell cache ----------
  var dbp=null;
  function db(){
    if(dbp) return dbp;
    dbp=new Promise(function(res){
      try{
        var rq=indexedDB.open(DBNAME,1);
        rq.onupgradeneeded=function(){ rq.result.createObjectStore(STORE); };
        rq.onsuccess=function(){ res(rq.result); };
        rq.onerror=function(){ res(null); };
      }catch(e){ res(null); }
    });
    return dbp;
  }
  function dbGet(k){ return db().then(function(d){ return !d?null:new Promise(function(res){ try{ var r=d.transaction(STORE).objectStore(STORE).get(k); r.onsuccess=function(){res(r.result||null);}; r.onerror=function(){res(null);}; }catch(e){res(null);} }); }); }
  function dbPut(k,v){ return db().then(function(d){ if(!d) return; return new Promise(function(res){ try{ var t=d.transaction(STORE,'readwrite'); t.objectStore(STORE).put(v,k); t.oncomplete=res; t.onerror=res; }catch(e){res();} }); }); }
  function dbCount(){ return db().then(function(d){ return !d?0:new Promise(function(res){ try{ var r=d.transaction(STORE).objectStore(STORE).count(); r.onsuccess=function(){res(r.result);}; r.onerror=function(){res(0);}; }catch(e){res(0);} }); }); }
  function dbClear(){ return db().then(function(d){ if(!d) return; return new Promise(function(res){ try{ var t=d.transaction(STORE,'readwrite'); t.objectStore(STORE).clear(); t.oncomplete=res; t.onerror=res; }catch(e){res();} }); }); }

  // ---------- USFS fetch (fetch first, JSONP fallback if CORS blocks) ----------
  function qs(o){ return Object.keys(o).map(function(k){ return encodeURIComponent(k)+'='+encodeURIComponent(o[k]); }).join('&'); }
  function jsonp(url){
    return new Promise(function(res,rej){
      var cb='cgr_'+Math.random().toString(36).slice(2), s=document.createElement('script'), done=false;
      var t=setTimeout(function(){ fin(); rej(new Error('timeout')); },20000);
      function fin(){ done=true; clearTimeout(t); try{ delete window[cb]; }catch(e){ window[cb]=undefined; } if(s.parentNode) s.parentNode.removeChild(s); }
      window[cb]=function(d){ if(done) return; fin(); res(d); };
      s.onerror=function(){ if(done) return; fin(); rej(new Error('script')); };
      s.src=url+'&callback='+cb; document.head.appendChild(s);
    });
  }
  function getJson(url){
    return fetch(url).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .catch(function(){ return jsonp(url); });
  }
  function fetchCell(cx,cy){
    var x0=cx*CELL, y0=cy*CELL, out=[];
    function page(off){
      var url=SVC+'?'+qs({where:'1=1',geometry:[x0,y0,x0+CELL,y0+CELL].join(','),geometryType:'esriGeometryEnvelope',inSR:4326,
        spatialRel:'esriSpatialRelIntersects',outFields:FIELDS,returnGeometry:'true',outSR:4326,geometryPrecision:5,
        resultOffset:off,resultRecordCount:1000,f:'json'});
      return getJson(url).then(function(d){
        if(d&&d.error) throw new Error(d.error.message||'service error');
        var fs=(d&&d.features)||[];
        for(var i=0;i<fs.length;i++){
          var a=fs[i].attributes||{}, g=fs[i].geometry; if(!g||!g.paths) continue;
          out.push({o:a.objectid,id:a.id||'',n:a.name||'',s:a.surface_type||'',m:a.oper_maint_level||'',r:a.route_status||'',c:a.county||'',l:a.seg_length,p:g.paths});
        }
        if(d&&d.exceededTransferLimit&&fs.length&&off<6000) return page(off+fs.length);
        return out;
      });
    }
    return page(0);
  }

  // ---------- state ----------
  var map=null, root=null, ui={}, renderer=null, group=null, labelGroup=null, meDot=null;
  var segs={};            // objectid -> segment (merged across cells)
  var cellsSeen={};       // cell key -> true (loaded into memory)
  var layersByKey={};     // roadKey -> {casings:[], lines:[]}
  var inflight=0, errMsg='', filterMode='all', query='', selKey=null, built=false, moveT=null;

  function roadKey(s){ return (s.id||('~'+s.n)||('~'+s.o)).toString().toUpperCase(); }
  function hashHue(k){ var h=0; for(var i=0;i<k.length;i++) h=(h*31+k.charCodeAt(i))>>>0; return (h*137.508)%360; }
  function autoColor(k){ return 'hsl('+hashHue(k).toFixed(0)+',85%,60%)'; }
  function edit(k){ return store.edits[k]||null; }
  function colorOf(k){ var e=edit(k); return (e&&e.color)||autoColor(k); }
  function isCrew(k){ var e=edit(k); return !!(e&&(e.star||e.slang||e.cond||e.note)); }
  function roadTitle(k){
    var first=null; for(var o in segs){ if(segs[o].k===k){ first=segs[o]; break; } }
    return first? { id:first.id, name:first.n } : { id:k, name:'' };
  }

  // ---------- drawing ----------
  function clearDraw(){ if(group) group.clearLayers(); if(labelGroup) labelGroup.clearLayers(); layersByKey={}; }
  function styleFor(k){
    var e=edit(k), crew=isCrew(k), c=colorOf(k), sel=(k===selKey);
    return { color:c, weight: sel?7:(crew?5:3), opacity: sel?1:(crew?0.98:0.82), lineCap:'round', lineJoin:'round' };
  }
  function casingFor(k){
    var e=edit(k), cd=cond(e&&e.cond||''), sel=(k===selKey);
    if(!cd.col && !sel) return null;
    return { color: sel?'#FFFFFF':cd.col, weight: sel?11:9, opacity: sel?0.55:0.8, lineCap: cd.dash?'butt':'round', lineJoin:'round', dashArray: (!sel&&cd.dash)?cd.dash:null };
  }
  function matches(k,s){
    if(filterMode==='crew' && !isCrew(k)) return false;
    if(!query) return true;
    var e=edit(k), hay=(k+' '+(s.n||'')+' '+(e&&e.slang||'')+' '+(e&&e.note||'')).toLowerCase();
    return hay.indexOf(query)>=0;
  }
  function draw(){
    if(!map) return;
    clearDraw();
    var z=map.getZoom();
    if(z<MIN_ZOOM){ setStatus('Zoom in to see roads'); return; }
    var b=map.getBounds().pad(0.1), L=window.L, labeled={}, nLabels=0, shown=0;
    var order=Object.keys(segs);
    for(var i=0;i<order.length;i++){
      var s=segs[order[i]], k=s.k;
      if(!matches(k,s)) continue;
      var lls=[]; var inView=false;
      for(var j=0;j<s.p.length;j++){
        var path=s.p[j], ll=[];
        for(var q=0;q<path.length;q++){ var y=path[q][1], x=path[q][0]; ll.push([y,x]); if(!inView&&b.contains([y,x])) inView=true; }
        lls.push(ll);
      }
      if(!inView) continue;
      shown++;
      var rec=layersByKey[k]||(layersByKey[k]={casings:[],lines:[]});
      var cs=casingFor(k);
      if(cs){ var c=L.polyline(lls,Object.assign({renderer:renderer,interactive:false},cs)).addTo(group); rec.casings.push(c); }
      var ln=L.polyline(lls,Object.assign({renderer:renderer,interactive:true},styleFor(k))).addTo(group);
      ln._ck=k; ln.on('click',onRoadTap); rec.lines.push(ln);
      if(z>=LABEL_ZOOM && !labeled[k] && nLabels<70){
        var mid=lls[0][Math.floor(lls[0].length/2)]; if(!mid||!b.contains(mid)) continue;
        labeled[k]=1; nLabels++;
        var e=edit(k), txt=(e&&e.slang)? e.slang.split(',')[0].trim() : (s.id||s.n);
        if(txt){
          L.marker(mid,{interactive:false,icon:L.divIcon({className:'',iconSize:[0,0],
            html:'<div style="transform:translate(-50%,-50%);white-space:nowrap;font:700 10px \'Helvetica Neue\';color:#fff;background:rgba(10,12,16,.78);border:1px solid '+colorOf(k)+';border-radius:8px;padding:1px 5px;pointer-events:none">'+esc(txt)+'</div>'})}).addTo(labelGroup);
        }
      }
    }
    setStatus(shown? (shown+' road segments'+(inflight?' · loading…':'')) : (inflight?'Loading roads…':(errMsg||'No roads in view')));
  }
  function setStatus(t){ if(ui.status) ui.status.textContent=t; }

  // ---------- loading cells in view ----------
  function cellsInView(){
    var b=map.getBounds(), out=[];
    var x0=Math.floor(b.getWest()/CELL), x1=Math.floor(b.getEast()/CELL), y0=Math.floor(b.getSouth()/CELL), y1=Math.floor(b.getNorth()/CELL);
    for(var x=x0;x<=x1;x++) for(var y=y0;y<=y1;y++) out.push([x,y]);
    return out;
  }
  function ingest(list){
    for(var i=0;i<list.length;i++){ var s=list[i]; s.k=roadKey(s); segs[s.o]=s; }
  }
  function loadCell(c,force){
    var key=c[0]+':'+c[1];
    if(cellsSeen[key]&&!force) return Promise.resolve(false);
    cellsSeen[key]=true;
    return dbGet(key).then(function(hit){
      if(hit&&hit.f&&!force){ ingest(hit.f); return true; }
      inflight++; setStatus('Loading roads…');
      return fetchCell(c[0],c[1]).then(function(list){
        ingest(list); errMsg='';
        return dbPut(key,{t:Date.now(),f:list}).then(function(){ return true; });
      }).catch(function(e){
        delete cellsSeen[key];
        errMsg=(hit&&hit.f)? '' : 'Can’t reach USFS road service — showing saved areas only';
        if(hit&&hit.f){ ingest(hit.f); return true; }
        return false;
      }).then(function(r){ inflight--; return r; });
    });
  }
  function loadView(force){
    if(!map||map.getZoom()<MIN_ZOOM){ draw(); return Promise.resolve(); }
    var cs=cellsInView();
    if(cs.length>MAX_CELLS_VIEW){ setStatus('Zoom in a bit more to load roads'); draw(); return Promise.resolve(); }
    var changed=false, chain=Promise.resolve();
    cs.forEach(function(c){ chain=chain.then(function(){ return loadCell(c,force); }).then(function(ch){ if(ch){ changed=true; draw(); } }); });
    return chain.then(function(){ draw(); refreshCount(); });
  }
  function downloadArea(){
    var cs=cellsInView(); if(!cs.length) return;
    if(cs.length>60){ toast('Zoom in first — that area is too big to save in one go'); return; }
    var n=0, bad=0, chain=Promise.resolve();
    toast('Saving '+cs.length+' map cells…');
    cs.forEach(function(c){ chain=chain.then(function(){ return loadCell(c,false); }).then(function(ok){ if(ok) n++; else bad++; setStatus('Saved '+n+'/'+cs.length+(bad?' ('+bad+' failed)':'')); }); });
    chain.then(function(){ draw(); refreshCount(); toast(bad? 'Saved '+n+' cells, '+bad+' failed — check signal and retry' : 'Saved '+n+' cells for offline use'); });
  }
  function refreshCount(){ dbCount().then(function(n){ if(ui.cached) ui.cached.textContent=n+' cells saved offline'; }); }

  // ---------- selection + editor sheet ----------
  function onRoadTap(ev){ if(ev&&ev.originalEvent){ try{ window.L.DomEvent.stopPropagation(ev); }catch(e){} } openSheet(ev.target._ck); }
  function restyle(k){
    var rec=layersByKey[k]; if(!rec) return;
    rec.lines.forEach(function(l){ l.setStyle(styleFor(k)); l.bringToFront(); });
  }
  function select(k){
    var prev=selKey; selKey=k;
    if(prev&&prev!==k) draw(); else draw();
  }
  function segInfo(k){ var arr=[]; for(var o in segs) if(segs[o].k===k) arr.push(segs[o]); return arr; }
  function uniq(a){ var m={},o=[]; a.forEach(function(x){ if(x&&!m[x]){ m[x]=1; o.push(x); } }); return o; }

  function openSheet(k){
    select(k);
    var arr=segInfo(k); if(!arr.length) return;
    var t=roadTitle(k), e=edit(k)||{};
    var miles=0; arr.forEach(function(s){ miles+= (s.l||0); });
    var facts=[];
    var surf=uniq(arr.map(function(s){return s.s;})).join(', '), maint=uniq(arr.map(function(s){return s.m;})).join(', '), stat=uniq(arr.map(function(s){return s.r;})).join(', '), cnty=uniq(arr.map(function(s){return s.c;})).join(', ');
    if(surf) facts.push('Surface: '+surf); if(maint) facts.push('Maint. level: '+maint); if(stat) facts.push('Status: '+stat); if(cnty) facts.push('County: '+cnty);
    if(miles) facts.push('~'+miles.toFixed(1)+' mi in loaded area');
    var curCol=colorOf(k), curCond=e.cond||'';
    var sheet=ui.sheet; sheet.style.display='flex';
    setMenuBtn(false); // the floating app menu button would cover Save
    sheet.innerHTML=
      '<div style="display:flex;align-items:flex-start;gap:10px">'+
        '<div style="width:12px;height:36px;border-radius:6px;background:'+curCol+';flex-shrink:0" id="rd-sw"></div>'+
        '<div style="flex:1;min-width:0"><div style="font:700 17px/1.15 \'Helvetica Neue\';color:#ECEEF1">'+esc(t.id||'Unnumbered road')+'</div>'+
        '<div style="font:500 12px \'Helvetica Neue\';color:#9AA3AE;margin-top:2px">'+esc(t.name||'(no USFS name)')+'</div></div>'+
        '<button id="rd-star" style="background:none;border:none;font-size:24px;line-height:1;cursor:pointer;color:'+(e.star?'#FFD23F':'#56606B')+'">'+(e.star?'★':'☆')+'</button>'+
        '<button id="rd-x" style="background:none;border:none;color:#9AA3AE;font-size:24px;line-height:1;cursor:pointer">×</button>'+
      '</div>'+
      '<div style="font:500 10px/1.5 \'Helvetica Neue\';color:#6E7781;margin-top:6px">'+esc(facts.join(' · '))+'</div>'+
      '<label style="display:block;font:700 9px \'Helvetica Neue\';letter-spacing:.1em;color:#7A828C;margin:12px 0 4px">CREW / SLANG NAME(S) — comma separated</label>'+
      '<input id="rd-slang" value="'+esc(e.slang||'')+'" placeholder="e.g. Dead Cow Road, The Back Way" autocomplete="off" autocapitalize="words" style="width:100%;box-sizing:border-box;background:#14181C;border:1px solid #2A3439;border-radius:10px;padding:10px 11px;font:600 14px \'Helvetica Neue\';color:#ECEEF1">'+
      '<div style="font:700 9px \'Helvetica Neue\';letter-spacing:.1em;color:#7A828C;margin:12px 0 5px">CONDITION</div>'+
      '<div id="rd-conds" style="display:flex;flex-wrap:wrap;gap:6px"></div>'+
      '<label style="display:block;font:700 9px \'Helvetica Neue\';letter-spacing:.1em;color:#7A828C;margin:12px 0 4px">NOTE</label>'+
      '<input id="rd-note" value="'+esc(e.note||'')+'" placeholder="e.g. Gate locked at mile 3, bridge weight limit" autocomplete="off" style="width:100%;box-sizing:border-box;background:#14181C;border:1px solid #2A3439;border-radius:10px;padding:10px 11px;font:500 13px \'Helvetica Neue\';color:#ECEEF1">'+
      '<div style="font:700 9px \'Helvetica Neue\';letter-spacing:.1em;color:#7A828C;margin:12px 0 5px">LINE COLOUR</div>'+
      '<div id="rd-cols" style="display:flex;flex-wrap:wrap;gap:8px"></div>'+
      '<div style="display:flex;align-items:center;gap:8px;margin-top:14px">'+
        '<div id="rd-ts" style="flex:1;font:500 10px \'Helvetica Neue\';color:#6E7781">'+(e.ts?('Updated '+new Date(e.ts).toLocaleString()):'No crew edits yet')+'</div>'+
        '<button id="rd-reset" style="background:#14181C;border:1px solid #2A3439;border-radius:16px;padding:8px 13px;font:600 12px \'Helvetica Neue\';color:#9AA3AE;cursor:pointer">Reset</button>'+
        '<button id="rd-save" style="background:#4C8DFF;border:none;border-radius:16px;padding:8px 18px;font:700 12px \'Helvetica Neue\';color:#fff;cursor:pointer">Save</button>'+
      '</div>';
    var working={cond:curCond,color:e.color||'',star:!!e.star};
    function paintConds(){
      var h=''; CONDS.forEach(function(c){
        var on=(c.k===working.cond);
        h+='<button data-c="'+c.k+'" style="border-radius:15px;padding:6px 11px;cursor:pointer;font:600 11px \'Helvetica Neue\';border:1px solid '+(on?(c.col||'#4C8DFF'):'#2A3439')+';background:'+(on?'rgba(76,141,255,.14)':'#14181C')+';color:'+(on?'#ECEEF1':'#9AA3AE')+'">'+(c.col?'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+c.col+';margin-right:6px"></span>':'')+esc(c.label)+'</button>';
      });
      sheet.querySelector('#rd-conds').innerHTML=h;
      Array.prototype.forEach.call(sheet.querySelectorAll('#rd-conds button'),function(b){ b.onclick=function(){ working.cond=b.getAttribute('data-c'); paintConds(); }; });
    }
    function paintCols(){
      var h='<button data-col="" style="width:30px;height:30px;border-radius:50%;cursor:pointer;background:'+autoColor(k)+';border:'+(!working.color?'3px solid #fff':'2px solid #2A3439')+';font:700 8px \'Helvetica Neue\';color:#0E1214">AUTO</button>';
      SWATCHES.forEach(function(c){ h+='<button data-col="'+c+'" style="width:30px;height:30px;border-radius:50%;cursor:pointer;background:'+c+';border:'+(working.color===c?'3px solid #fff':'2px solid #2A3439')+'"></button>'; });
      sheet.querySelector('#rd-cols').innerHTML=h;
      Array.prototype.forEach.call(sheet.querySelectorAll('#rd-cols button'),function(b){ b.onclick=function(){ working.color=b.getAttribute('data-col'); sheet.querySelector('#rd-sw').style.background=working.color||autoColor(k); paintCols(); }; });
    }
    paintConds(); paintCols();
    sheet.querySelector('#rd-star').onclick=function(){ working.star=!working.star; this.textContent=working.star?'★':'☆'; this.style.color=working.star?'#FFD23F':'#56606B'; };
    sheet.querySelector('#rd-x').onclick=closeSheet;
    sheet.querySelector('#rd-save').onclick=function(){
      var slang=sheet.querySelector('#rd-slang').value.trim(), note=sheet.querySelector('#rd-note').value.trim();
      if(!slang&&!note&&!working.cond&&!working.color&&!working.star){ delete store.edits[k]; }
      else store.edits[k]={slang:slang,cond:working.cond,note:note,color:working.color,star:working.star,ts:Date.now()};
      if(!saveStore()) toast('Could not save — phone storage is full or blocked');
      else toast('Saved on this phone');
      closeSheet();
    };
    sheet.querySelector('#rd-reset').onclick=function(){ if(confirm('Clear all crew edits for '+(t.id||'this road')+'?')){ delete store.edits[k]; saveStore(); toast('Cleared'); closeSheet(); } };
    map.fitBounds(L_bounds(arr),{padding:[40,40],maxZoom:14,paddingBottomRight:[40,300]});
  }
  function L_bounds(arr){
    var L=window.L, b=null;
    arr.forEach(function(s){ s.p.forEach(function(path){ path.forEach(function(pt){ var ll=L.latLng(pt[1],pt[0]); b=b?b.extend(ll):L.latLngBounds(ll,ll); }); }); });
    return b;
  }
  function setMenuBtn(on){ var b=document.getElementById('cg-menu-btn'); if(b) b.style.display=on?'':'none'; }
  function closeSheet(){ ui.sheet.style.display='none'; ui.sheet.innerHTML=''; selKey=null; setMenuBtn(true); draw(); }

  // ---------- toolbar: search, filter, locate, area save, export/import ----------
  var toastT=null;
  function toast(t){ ui.toast.textContent=t; ui.toast.style.opacity='1'; clearTimeout(toastT); toastT=setTimeout(function(){ ui.toast.style.opacity='0'; },2600); }

  function exportEdits(){
    var txt=JSON.stringify(store,null,1), n=Object.keys(store.edits).length;
    if(!n){ toast('No crew edits to export yet'); return; }
    var name='commguide-roads-'+new Date().toISOString().slice(0,10)+'.json';
    try{
      var file=new File([txt],name,{type:'application/json'});
      if(navigator.canShare&&navigator.canShare({files:[file]})){ navigator.share({files:[file],title:'Comm Guide roads'}).catch(function(){}); return; }
    }catch(e){}
    try{ var a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([txt],{type:'application/json'})); a.download=name; document.body.appendChild(a); a.click(); a.remove(); toast('Exported '+n+' roads'); }
    catch(e){ toast('Export not supported here'); }
  }
  function importEdits(file){
    var fr=new FileReader();
    fr.onload=function(){
      try{
        var o=JSON.parse(fr.result); if(!o||!o.edits) throw 0;
        var n=0, kept=0;
        Object.keys(o.edits).forEach(function(k){ var inc=o.edits[k], cur=store.edits[k];
          if(!cur||(inc.ts||0)>(cur.ts||0)){ store.edits[k]=inc; n++; } else kept++; });
        saveStore(); draw();
        toast('Imported '+n+' road'+(n===1?'':'s')+(kept?' ('+kept+' newer kept)':''));
      }catch(e){ toast('That file isn’t a Comm Guide roads export'); }
    };
    fr.readAsText(file);
  }
  function locate(){
    if(!navigator.geolocation){ toast('Location not available'); return; }
    navigator.geolocation.getCurrentPosition(function(p){
      var ll=[p.coords.latitude,p.coords.longitude], L=window.L;
      if(!meDot) meDot=L.circleMarker(ll,{radius:7,color:'#fff',weight:2,fillColor:'#4C8DFF',fillOpacity:1,interactive:false}).addTo(map); else meDot.setLatLng(ll);
      map.setView(ll,Math.max(map.getZoom(),13));
    },function(){ toast('Couldn’t get your location'); },{enableHighAccuracy:true,timeout:12000});
  }

  function chip(id,label){ return '<button id="'+id+'" style="flex-shrink:0;background:rgba(10,12,16,.86);border:1px solid #2A3439;border-radius:16px;padding:7px 12px;font:600 11px \'Helvetica Neue\';color:#ECEEF1;cursor:pointer;backdrop-filter:blur(8px)">'+label+'</button>'; }

  function build(){
    root=document.getElementById('roads-root'); if(!root||built) return;
    built=true;
    root.innerHTML=
      '<div id="rd-map" style="position:absolute;inset:0;z-index:0"></div>'+
      '<div style="position:absolute;left:10px;right:10px;top:10px;z-index:700;display:flex;flex-direction:column;gap:7px;pointer-events:none">'+
        '<input id="rd-q" type="search" placeholder="Search road #, name or slang" autocomplete="off" style="pointer-events:auto;width:100%;box-sizing:border-box;background:rgba(10,12,16,.9);backdrop-filter:blur(8px);border:1px solid #2A3439;border-radius:12px;padding:10px 12px;font:500 14px \'Helvetica Neue\';color:#ECEEF1">'+
        '<div style="display:flex;gap:6px;overflow-x:auto;pointer-events:auto" class="hscroll">'+chip('rd-f','All roads')+chip('rd-loc','◎ Me')+chip('rd-dl','Save area offline')+chip('rd-ex','Export')+chip('rd-im','Import')+'</div>'+
        '<div style="align-self:flex-start;background:rgba(10,12,16,.8);border:1px solid #2A3439;border-radius:10px;padding:4px 9px;font:500 10px \'Helvetica Neue\';color:#9AA3AE"><span id="rd-st">Loading…</span> · <span id="rd-cached"></span></div>'+
      '</div>'+
      '<div id="rd-toast" style="position:absolute;left:50%;transform:translateX(-50%);top:118px;z-index:900;background:rgba(10,12,16,.94);border:1px solid #2A3439;border-radius:14px;padding:7px 13px;font:600 11px \'Helvetica Neue\';color:#ECEEF1;opacity:0;transition:opacity .25s;pointer-events:none;max-width:86%;text-align:center"></div>'+
      '<div id="rd-sheet" style="display:none;position:absolute;left:0;right:0;bottom:0;z-index:800;max-height:62%;overflow:auto;-webkit-overflow-scrolling:touch;flex-direction:column;background:#0E1214;border-top:1px solid #2a3439;border-radius:16px 16px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.5);padding:14px 14px 18px"></div>'+
      '<input id="rd-file" type="file" accept="application/json,.json" style="display:none">';
    ui={ status:root.querySelector('#rd-st'), cached:root.querySelector('#rd-cached'), sheet:root.querySelector('#rd-sheet'), toast:root.querySelector('#rd-toast') };
    var L=window.L, home={lat:38.240639,lng:-120.208366}; // Skull Creek Station (verified)
    map=L.map(root.querySelector('#rd-map'),{attributionControl:true,zoomControl:false,preferCanvas:true}).setView([home.lat,home.lng],12);
    map.attributionControl.setPrefix(false);
    if(window.__cgTileLayer) window.__cgTileLayer().addTo(map);
    else L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap'}).addTo(map);
    map.attributionControl.addAttribution('Roads: USDA Forest Service');
    renderer=L.canvas({padding:0.3,tolerance:10});
    group=L.layerGroup().addTo(map); labelGroup=L.layerGroup().addTo(map);
    map.on('moveend',function(){ clearTimeout(moveT); moveT=setTimeout(function(){ loadView(false); },250); });
    map.on('click',function(){ if(selKey) closeSheet(); });
    root.querySelector('#rd-q').oninput=function(){ query=this.value.trim().toLowerCase(); draw(); };
    root.querySelector('#rd-f').onclick=function(){ filterMode=filterMode==='all'?'crew':'all'; this.textContent=filterMode==='all'?'All roads':'★ Crew roads only'; draw(); };
    root.querySelector('#rd-loc').onclick=locate;
    root.querySelector('#rd-dl').onclick=downloadArea;
    root.querySelector('#rd-ex').onclick=exportEdits;
    root.querySelector('#rd-im').onclick=function(){ root.querySelector('#rd-file').click(); };
    root.querySelector('#rd-file').onchange=function(){ if(this.files&&this.files[0]) importEdits(this.files[0]); this.value=''; };
    refreshCount();
    setTimeout(function(){ map.invalidateSize(); loadView(false); },60);
  }

  window.__cgRoads={
    show:function(){ if(!built) build(); else setTimeout(function(){ map.invalidateSize(); loadView(false); },60); },
    _map:function(){ return map; },
    _debug:function(){ return {segs:Object.keys(segs).length, edits:store.edits}; }
  };
  // if the tab was already opened while this file was loading
  if(document.getElementById('panel-roads') && document.getElementById('panel-roads').style.display==='flex') window.__cgRoads.show();
})();
