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
  var FIELDS='objectid,id,name,surface_type,oper_maint_level,objective_maint_level,route_status,openforuseto,jurisdiction,primary_maintainer,lanes,functional_class,symbol_code,seg_length,county';
  var fieldsMode=FIELDS;   // falls back to '*' if the service rejects a field name
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

  // Display form of a USFS road number: drop leading zeros ("05N03" -> "5N03"). The stored key stays the official ID.
  function fmtId(id){ return (id||'').toString().replace(/^0+(?=\d)/,''); }
  // ---------- battalion boundary (user-supplied GPX -> battalion.js, ring of [lng,lat]) ----------
  var BATT=null, battFailed=false, BB=null;   // BB = ring bbox [minx,miny,maxx,maxy]
  var battOn=true; try{ battOn=localStorage.getItem('cg_roads_batt')!=='0'; }catch(e){}
  function battActive(){ return battOn && !!BATT; }
  function pip(x,y){ var r=BATT, c=false; for(var i=0,j=r.length-1;i<r.length;j=i++){ var xi=r[i][0],yi=r[i][1],xj=r[j][0],yj=r[j][1]; if(((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) c=!c; } return c; }
  function segX(ax,ay,bx,by,cx,cy,dx,dy){   // AB x CD -> t along AB (0..1) or null
    var rx=bx-ax, ry=by-ay, sx=dx-cx, sy=dy-cy, den=rx*sy-ry*sx; if(!den) return null;
    var t=((cx-ax)*sy-(cy-ay)*sx)/den, u=((cx-ax)*ry-(cy-ay)*rx)/den;
    return (t>=0&&t<=1&&u>=0&&u<=1)? t : null;
  }
  function edgeCross(p,q,entering){  // boundary crossing point on p->q (nearest to the inside end)
    var best=null, r=BATT;
    for(var i=0;i<r.length-1;i++){
      var t=segX(p[0],p[1],q[0],q[1],r[i][0],r[i][1],r[i+1][0],r[i+1][1]);
      if(t!==null && (best===null || (entering? t>best : t<best))) best=t;
    }
    if(best===null) return entering? q : p;
    return [p[0]+(q[0]-p[0])*best, p[1]+(q[1]-p[1])*best];
  }
  function clipPaths(paths){                  // keep only the parts of each path inside the boundary
    var out=[];
    for(var a=0;a<paths.length;a++){
      var path=paths[a], run=null, prevIn=false, prev=null;
      for(var i=0;i<path.length;i++){
        var pt=path[i], inn=pip(pt[0],pt[1]);
        if(inn){
          if(!run){ run=[]; if(prev) run.push(edgeCross(prev,pt,true)); }
          run.push(pt);
        } else if(run){
          run.push(edgeCross(prev,pt,false)); if(run.length>1) out.push(run); run=null;
        }
        prev=pt; prevIn=inn;
      }
      if(run && run.length>1) out.push(run);
    }
    return out;
  }
  function clipSeg(s){
    if(!BATT){ s.pc=null; return; }
    var x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    for(var a=0;a<s.p.length;a++) for(var i=0;i<s.p[a].length;i++){ var pt=s.p[a][i]; if(pt[0]<x0)x0=pt[0]; if(pt[0]>x1)x1=pt[0]; if(pt[1]<y0)y0=pt[1]; if(pt[1]>y1)y1=pt[1]; }
    if(x1<BB[0]||x0>BB[2]||y1<BB[1]||y0>BB[3]){ s.pc=[]; return; }
    s.pc=clipPaths(s.p);
  }
  // Battalion rule: a road is shown WHOLE if any part of it is inside the boundary (roads that merely branch off it
  // outside the boundary are not). Only pieces connected end-to-end to the inside part count, so a same-numbered road
  // elsewhere is ignored.
  var incl={}, inclDirty=true, TOL=0.0004, GRID=0.0005;
  function ends(s){ var e=[]; for(var a=0;a<s.p.length;a++){ var pa=s.p[a]; if(pa.length){ e.push(pa[0]); e.push(pa[pa.length-1]); } } return e; }
  function computeIncl(){
    inclDirty=false; incl={}; if(!BATT) return;
    var byKey={};
    Object.keys(segs).forEach(function(o){ var sg=segs[o]; if(!sg.pc&&BATT) clipSeg(sg); (byKey[sg.k]||(byKey[sg.k]=[])).push(sg); });
    Object.keys(byKey).forEach(function(k){
      var arr=byKey[k], seeds=arr.filter(function(sg){ return sg.pc&&sg.pc.length; });
      if(!seeds.length) return;
      seeds.forEach(function(sg){ incl[sg.o]=true; });
      if(seeds.length===arr.length) return;
      var grid={};
      function gk(x,y){ return Math.floor(x/GRID)+':'+Math.floor(y/GRID); }
      arr.forEach(function(sg){ ends(sg).forEach(function(pt){ var g=gk(pt[0],pt[1]); (grid[g]||(grid[g]=[])).push(sg); }); });
      var queue=seeds.slice();
      while(queue.length){
        var cur=queue.pop();
        ends(cur).forEach(function(pt){
          var gx=Math.floor(pt[0]/GRID), gy=Math.floor(pt[1]/GRID);
          for(var dx=-1;dx<=1;dx++) for(var dy=-1;dy<=1;dy++){
            var l=grid[(gx+dx)+':'+(gy+dy)]; if(!l) continue;
            l.forEach(function(n){
              if(incl[n.o]) return;
              var hit=ends(n).some(function(q){ return Math.abs(q[0]-pt[0])<=TOL && Math.abs(q[1]-pt[1])<=TOL; });
              if(hit){ incl[n.o]=true; queue.push(n); }
            });
          }
        });
      }
    });
  }
  function pathsOf(s){
    if(battOn && !battFailed){ if(!BATT) return []; if(inclDirty) computeIncl(); return incl[s.o]? s.p : []; }
    return s.p;
  }
  function cellTouches(x0,y0,x1,y1){          // does this fetch cell overlap the boundary?
    if(!battActive()) return true;
    if(x1<BB[0]||x0>BB[2]||y1<BB[1]||y0>BB[3]) return false;
    var r=BATT, i;
    for(i=0;i<r.length;i++) if(r[i][0]>=x0&&r[i][0]<=x1&&r[i][1]>=y0&&r[i][1]<=y1) return true;
    if(pip(x0,y0)||pip(x1,y0)||pip(x0,y1)||pip(x1,y1)) return true;
    var cs=[[x0,y0,x1,y0],[x1,y0,x1,y1],[x1,y1,x0,y1],[x0,y1,x0,y0]];
    for(i=0;i<r.length-1;i++) for(var k=0;k<4;k++) if(segX(cs[k][0],cs[k][1],cs[k][2],cs[k][3],r[i][0],r[i][1],r[i+1][0],r[i+1][1])!==null) return true;
    return false;
  }
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
  function fetchQuery(extra){
    var out=[];
    function at(a,n){ var v=a[n]; if(v==null) v=a[n.toUpperCase()]; return v==null?'':v; }
    function page(off){
      var url=SVC+'?'+qs(Object.assign({where:'1=1',outFields:fieldsMode,returnGeometry:'true',outSR:4326,geometryPrecision:5,
        resultOffset:off,resultRecordCount:1000,f:'json'},extra));
      return getJson(url).then(function(d){
        if(d&&d.error){
          if(fieldsMode!=='*'){ fieldsMode='*'; return page(off); }   // a field name was rejected: ask for everything instead
          throw new Error(d.error.message||'service error');
        }
        var fs=(d&&d.features)||[];
        for(var i=0;i<fs.length;i++){
          var a=fs[i].attributes||{}, g=fs[i].geometry; if(!g||!g.paths) continue;
          out.push({o:at(a,'objectid'),id:at(a,'id'),n:at(a,'name'),s:at(a,'surface_type'),m:at(a,'oper_maint_level'),ob:at(a,'objective_maint_level'),r:at(a,'route_status'),
            op:at(a,'openforuseto'),j:at(a,'jurisdiction'),mt:at(a,'primary_maintainer'),ln:at(a,'lanes'),fc:at(a,'functional_class'),c:at(a,'county'),l:a.seg_length!=null?a.seg_length:a.SEG_LENGTH,p:g.paths});
        }
        if(d&&d.exceededTransferLimit&&fs.length&&off<6000) return page(off+fs.length);
        return out;
      });
    }
    return page(0);
  }
  function envQ(x0,y0,x1,y1){ return {geometry:[x0,y0,x1,y1].join(','),geometryType:'esriGeometryEnvelope',inSR:4326,spatialRel:'esriSpatialRelIntersects'}; }
  function fetchCell(cx,cy){ return fetchQuery(envQ(cx*CELL,cy*CELL,(cx+1)*CELL,(cy+1)*CELL)); }
  // full length of numbered roads (they run past the boundary), searched within a buffer around the battalion
  var EXT_BUF=0.25;
  function sqlStr(id){ return "'"+String(id).replace(/'/g,"''")+"'"; }
  function fetchExt(ids){
    return fetchQuery(Object.assign({where:'id IN ('+ids.map(sqlStr).join(',')+')'},envQ(BB[0]-EXT_BUF,BB[1]-EXT_BUF,BB[2]+EXT_BUF,BB[3]+EXT_BUF)));
  }
  function strip(list){ return list.map(function(s){ var o={}; for(var k in s) if(k!=='k'&&k!=='pc') o[k]=s[k]; return o; }); }

  // ---------- state ----------
  var map=null, root=null, ui={}, renderer=null, group=null, labelGroup=null, meDot=null;
  var segs={};            // objectid -> segment (merged across cells)
  var cellsSeen={};       // cell key -> true (loaded into memory)
  var layersByKey={};     // roadKey -> {casings:[], lines:[]}
  var inflight=0, errMsg='', filterMode='all', query='', selKey=null, built=false, moveT=null;

  function roadKey(s){ return (s.id||('~'+s.n)||('~'+s.o)).toString().toUpperCase(); }
  function hashHue(k){ var h=0; for(var i=0;i<k.length;i++) h=(h*31+k.charCodeAt(i))>>>0; return (h*137.508)%360; }
  function autoColor(k){ return 'hsl('+hashHue(k).toFixed(0)+',85%,60%)'; }
  function edit(k){ return store.edits[k]||(window.CG_ROADS&&window.CG_ROADS[k])||null; }
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
    var e=edit(k), hay=(k+' '+fmtId(k)+' '+(s.n||'')+' '+(e&&e.slang||'')+' '+(e&&e.note||'')).toLowerCase();
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
      var P=pathsOf(s); if(!P.length) continue;
      var lls=[]; var inView=false;
      for(var j=0;j<P.length;j++){
        var path=P[j], ll=[];
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
        var e=edit(k), txt=(e&&e.slang)? e.slang.split(',')[0].trim() : (fmtId(s.id)||s.n);
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
    for(var x=x0;x<=x1;x++) for(var y=y0;y<=y1;y++) if(cellTouches(x*CELL,y*CELL,(x+1)*CELL,(y+1)*CELL)) out.push([x,y]);
    return out;
  }
  function ingest(list){
    for(var i=0;i<list.length;i++){ var s=list[i]; s.k=roadKey(s); if(BATT) clipSeg(s); segs[s.o]=s; }
    inclDirty=true;
  }
  function loadCell(c,force){
    var key=c[0]+':'+c[1];
    if(cellsSeen[key]&&!force) return Promise.resolve(false);
    cellsSeen[key]=true;
    return dbGet(key).then(function(hit){
      if(hit&&hit.f&&hit.v===2&&!force){ ingest(hit.f); return true; }
      inflight++; setStatus('Loading roads…');
      return fetchCell(c[0],c[1]).then(function(list){
        ingest(list); errMsg='';
        return dbPut(key,{t:Date.now(),v:2,f:strip(list)}).then(function(){ return true; });
      }).catch(function(e){
        delete cellsSeen[key];
        errMsg=(hit&&hit.f)? '' : 'Can’t reach USFS road service — showing saved areas only';
        if(hit&&hit.f){ ingest(hit.f); return true; }
        return false;
      }).then(function(r){ inflight--; return r; });
    });
  }
  var extDone={};
  function ensureExt(){
    if(!battActive()) return Promise.resolve();
    var ids={};
    Object.keys(segs).forEach(function(o){ var sg=segs[o]; if(!sg.pc&&BATT) clipSeg(sg); if(sg.id&&sg.pc&&sg.pc.length) ids[sg.id]=true; });
    var todo=Object.keys(ids).filter(function(id){ return !extDone[id]; });
    if(!todo.length) return Promise.resolve();
    todo.forEach(function(id){ extDone[id]=true; });
    var chain=Promise.resolve();
    for(var i=0;i<todo.length;i+=20) (function(batch){ chain=chain.then(function(){ return extBatch(batch); }); })(todo.slice(i,i+20));
    return chain;
  }
  function extBatch(ids){
    return Promise.all(ids.map(function(id){ return dbGet('x:'+id); })).then(function(hits){
      var missing=[], stale=[]; hits.forEach(function(h,i){ if(h&&h.f&&h.v===2) ingest(h.f); else { missing.push(ids[i]); if(h&&h.f) stale=stale.concat(h.f); } });
      if(!missing.length) return;
      inflight++; setStatus('Loading full road lengths\u2026');
      return fetchExt(missing).then(function(list){
        ingest(list);
        var by={}; missing.forEach(function(id){ by[id]=[]; }); list.forEach(function(sg){ if(by[sg.id]) by[sg.id].push(sg); });
        return Promise.all(missing.map(function(id){ return dbPut('x:'+id,{t:Date.now(),v:2,f:strip(by[id])}); }));
      }).catch(function(){ missing.forEach(function(id){ delete extDone[id]; }); ingest(stale); }).then(function(){ inflight--; });
    });
  }
  function loadView(force){
    if(!map||map.getZoom()<MIN_ZOOM){ draw(); return Promise.resolve(); }
    var cs=cellsInView();
    if(cs.length>MAX_CELLS_VIEW){ setStatus('Zoom in a bit more to load roads'); draw(); return Promise.resolve(); }
    var changed=false, chain=Promise.resolve();
    cs.forEach(function(c){ chain=chain.then(function(){ return loadCell(c,force); }).then(function(ch){ if(ch){ changed=true; draw(); } }); });
    return chain.then(function(){ draw(); return ensureExt(); }).then(function(){ draw(); refreshCount(); });
  }
  function downloadArea(){
    var cs=cellsInView(); if(!cs.length) return;
    if(cs.length>60){ toast('Zoom in first — that area is too big to save in one go'); return; }
    var n=0, bad=0, chain=Promise.resolve();
    toast('Saving '+cs.length+' map cells…');
    cs.forEach(function(c){ chain=chain.then(function(){ return loadCell(c,false); }).then(function(ok){ if(ok) n++; else bad++; setStatus('Saved '+n+'/'+cs.length+(bad?' ('+bad+' failed)':'')); }); });
    chain.then(function(){ return ensureExt(); }).then(function(){ draw(); refreshCount(); toast(bad? 'Saved '+n+' cells, '+bad+' failed — check signal and retry' : 'Saved '+n+' cells for offline use'); });
  }
  function refreshCount(){ dbCount().then(function(n){ if(ui.cached) ui.cached.textContent=n+' cells saved offline'; }); }

  // ---------- selection + editor sheet ----------
  function onRoadTap(ev){ if(ev&&ev.originalEvent){ try{ window.L.DomEvent.stopPropagation(ev); }catch(e){} } openInfo(ev.target._ck); }
  function restyle(k){
    var rec=layersByKey[k]; if(!rec) return;
    rec.lines.forEach(function(l){ l.setStyle(styleFor(k)); l.bringToFront(); });
  }
  function select(k){
    var prev=selKey; selKey=k;
    if(prev&&prev!==k) draw(); else draw();
  }
  function segInfo(k){ var arr=[]; for(var o in segs) if(segs[o].k===k && pathsOf(segs[o]).length) arr.push(segs[o]); return arr; }
  function uniq(a){ var m={},o=[]; a.forEach(function(x){ if(x&&!m[x]){ m[x]=1; o.push(x); } }); return o; }

  // USFS values arrive in CAPS ("AGG - CRUSHED AGGREGATE OR GRAVEL"): keep the short code, tidy the words
  function nice(v){
    v=(v==null?'':v).toString().trim(); if(!v) return ''; if(v!==v.toUpperCase()||!/[A-Z]{2}/.test(v)) return v;
    var m=/^([A-Z0-9]{1,4}) - (.+)$/.exec(v), code=m?m[1]+' - ':'', rest=m?m[2]:v, small={or:1,of:1,and:1,to:1,for:1,the:1,a:1,in:1,on:1};
    rest=rest.toLowerCase().replace(/[a-z0-9']+/g,function(w,i){ return (i>0&&small[w])? w : w.charAt(0).toUpperCase()+w.slice(1); });
    return code+rest;
  }
  function infoRow(l,v){ return v? '<div style="display:flex;gap:10px;padding:6px 0;border-top:1px solid #1C2226"><div style="width:108px;flex-shrink:0;font:600 9px/1.5 \'Helvetica Neue\';letter-spacing:.08em;color:#7A828C">'+esc(l.toUpperCase())+'</div><div style="flex:1;min-width:0;font:500 13px/1.35 \'Helvetica Neue\';color:#ECEEF1">'+esc(v)+'</div></div>' : ''; }

  // Tap a road -> read-only info card (crew info + USFS data). Edit button opens the editor.
  function openInfo(k){
    select(k);
    var arr=segInfo(k); if(!arr.length) return;
    var t=roadTitle(k), e=edit(k)||{}, col=colorOf(k), cd=cond(e.cond||'');
    function U(f){ return uniq(arr.map(function(sg){ return nice(sg[f]); })).join(', '); }
    var miles=0; arr.forEach(function(sg){ miles+=(+sg.l||0); });
    var slangs=(e.slang||'').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
    var sheet=ui.sheet; sheet.style.display='flex'; setMenuBtn(false);
    var crew='';
    if(slangs.length) crew+='<div style="font:700 15px/1.3 \'Helvetica Neue\';color:#FFD23F;margin-top:8px">“'+esc(slangs.join('” · “'))+'”</div>';
    if(cd.k) crew+='<div style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;border:1px solid '+cd.col+';border-radius:14px;padding:4px 10px;font:700 11px \'Helvetica Neue\';color:#ECEEF1"><span style="width:8px;height:8px;border-radius:50%;background:'+cd.col+'"></span>'+esc(cd.label)+'</div>';
    if(e.note) crew+='<div style="margin-top:8px;background:#14181C;border:1px solid #2A3439;border-radius:10px;padding:8px 10px;font:500 13px/1.4 \'Helvetica Neue\';color:#ECEEF1">'+esc(e.note)+'</div>';
    if(!crew) crew='<div style="margin-top:8px;font:500 12px \'Helvetica Neue\';color:#6E7781">No crew info yet — tap Edit to add a slang name, condition or note.</div>';
    var facts=infoRow('Surface',U('s'))+infoRow('Maintenance level',U('m'))+infoRow('Objective level',U('ob'))+infoRow('Status',U('r'))+infoRow('Open to',U('op'))+
      infoRow('Class',U('fc'))+infoRow('Jurisdiction',U('j'))+infoRow('Maintained by',U('mt'))+infoRow('Lanes',U('ln'))+infoRow('County',U('c'))+
      infoRow('Length loaded',miles?('~'+miles.toFixed(1)+' mi'):'');
    sheet.innerHTML=
      '<div style="display:flex;align-items:flex-start;gap:10px">'+
        '<div style="width:12px;height:38px;border-radius:6px;background:'+col+';flex-shrink:0"></div>'+
        '<div style="flex:1;min-width:0"><div style="font:700 19px/1.15 \'Helvetica Neue\';color:#ECEEF1">'+esc(fmtId(t.id)||'Unnumbered road')+(e.star?' <span style="color:#FFD23F">★</span>':'')+'</div>'+
        '<div style="font:500 12px \'Helvetica Neue\';color:#9AA3AE;margin-top:2px">'+esc(nice(t.name)||'(no USFS name)')+'</div></div>'+
        '<button id="rd-x" style="background:none;border:none;color:#9AA3AE;font-size:24px;line-height:1;cursor:pointer">×</button>'+
      '</div>'+crew+
      '<div style="font:700 9px \'Helvetica Neue\';letter-spacing:.1em;color:#7A828C;margin:14px 0 4px">USFS ROAD DATA</div>'+
      (facts||'<div style="font:500 12px \'Helvetica Neue\';color:#6E7781">No USFS details available.</div>')+
      '<div style="display:flex;align-items:center;gap:8px;margin-top:14px">'+
        '<div style="flex:1;font:500 10px \'Helvetica Neue\';color:#6E7781">'+(e.ts?('Crew info updated '+esc(new Date(e.ts).toLocaleString())):'')+'</div>'+
        '<button id="rd-edit" style="background:#4C8DFF;border:none;border-radius:16px;padding:9px 22px;font:700 12px \'Helvetica Neue\';color:#fff;cursor:pointer">Edit</button>'+
      '</div>';
    sheet.querySelector('#rd-x').onclick=closeSheet;
    sheet.querySelector('#rd-edit').onclick=function(){ openSheet(k); };
    map.fitBounds(L_bounds(arr),{padding:[30,30],maxZoom:14,paddingBottomRight:[30,280]});
  }

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
        '<div style="flex:1;min-width:0"><div style="font:700 17px/1.15 \'Helvetica Neue\';color:#ECEEF1">'+esc(fmtId(t.id)||'Unnumbered road')+'</div>'+
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
      openInfo(k);
    };
    sheet.querySelector('#rd-reset').onclick=function(){ if(confirm('Clear all crew edits for '+(fmtId(t.id)||'this road')+'?')){ delete store.edits[k]; saveStore(); toast('Cleared'); closeSheet(); } };
  }
  function L_bounds(arr){
    var L=window.L, b=null;
    arr.forEach(function(s){ pathsOf(s).forEach(function(path){ path.forEach(function(pt){ var ll=L.latLng(pt[1],pt[0]); b=b?b.extend(ll):L.latLngBounds(ll,ll); }); }); });
    return b;
  }
  function setMenuBtn(on){ var b=document.getElementById('cg-menu-btn'); if(b) b.style.display=on?'':'none'; }
  function closeSheet(){ ui.sheet.style.display='none'; ui.sheet.innerHTML=''; selKey=null; setMenuBtn(true); draw(); }

  // ---------- toolbar: search, filter, locate, area save, export/import ----------
  var toastT=null;
  function toast(t){ ui.toast.textContent=t; ui.toast.style.opacity='1'; clearTimeout(toastT); toastT=setTimeout(function(){ ui.toast.style.opacity='0'; },2600); }

  // ---------- main routes: bundled (routes.js) + added on this phone from GPX ----------
  var RKEY='cg_routes_v1', routesOn=true, routeGroup=null, routeLabels=null, pointGroup=null, imported=[], importedPts=[];
  try{ routesOn=localStorage.getItem('cg_routes_on')!=='0'; }catch(e){}
  try{ var _ri=JSON.parse(localStorage.getItem(RKEY)||'null'); if(_ri&&_ri.routes) imported=_ri.routes; if(_ri&&_ri.points) importedPts=_ri.points; }catch(e){}
  function saveImported(){ try{ localStorage.setItem(RKEY,JSON.stringify({v:1,routes:imported,points:importedPts})); return true; }catch(e){ return false; } }
  function allRoutes(){
    var b=(window.CG_ROUTES||[]).map(function(r){ return {id:r.id,name:r.name,pts:r.pts,note:r.note||'',dest:r.dest||null,src:'bundled'}; });
    return b.concat(imported.map(function(r){ return {id:r.id,name:r.name,pts:r.pts,src:'phone'}; }));
  }
  function allPoints(){
    var b=(window.CG_POINTS||[]).map(function(p){ return {id:p.id,name:p.name,kind:p.kind||'point',at:p.at,ele:p.ele,note:p.note||'',src:'bundled'}; });
    return b.concat(importedPts.map(function(p){ return {id:p.id,name:p.name,kind:p.kind||'point',at:p.at,ele:p.ele,note:p.note||'',src:'phone'}; }));
  }
  function routeMiles(pts){
    var R=3958.8,pp=Math.PI/180,m=0;
    for(var i=1;i<pts.length;i++){ var dy=(pts[i][1]-pts[i-1][1])*pp, dx=(pts[i][0]-pts[i-1][0])*pp, a=Math.sin(dy/2)*Math.sin(dy/2)+Math.cos(pts[i-1][1]*pp)*Math.cos(pts[i][1]*pp)*Math.sin(dx/2)*Math.sin(dx/2); m+=2*R*Math.asin(Math.sqrt(a)); }
    return m;
  }
  function syncRouteLabels(){
    if(!map||!routeLabels) return;
    var on=routesOn&&map.getZoom()>=12;
    if(on&&!map.hasLayer(routeLabels)) map.addLayer(routeLabels);
    if(!on&&map.hasLayer(routeLabels)) map.removeLayer(routeLabels);
    if(pointGroup){ var pon=routesOn&&map.getZoom()>=11; if(pon&&!map.hasLayer(pointGroup)) map.addLayer(pointGroup); if(!pon&&map.hasLayer(pointGroup)) map.removeLayer(pointGroup); }
  }
  function drawRoutes(){
    if(!map||!routeGroup) return;
    routeGroup.clearLayers(); routeLabels.clearLayers(); pointGroup.clearLayers();
    if(routesOn){
      var L=window.L;
      drawPoints();
      allRoutes().forEach(function(r){
        if(!r.pts||r.pts.length<2) return;
        var ll=r.pts.map(function(pt){ return [pt[1],pt[0]]; });
        var glow=L.polyline(ll,{renderer:renderer,interactive:true,color:'#FFC53D',weight:18,opacity:0.30,lineCap:'round',lineJoin:'round'});
        var core=L.polyline(ll,{renderer:renderer,interactive:true,color:'#FFC53D',weight:3.5,opacity:0.95,lineCap:'round',lineJoin:'round'});
        [glow,core].forEach(function(l){ l.on('click',function(ev){ try{ L.DomEvent.stopPropagation(ev); }catch(e){} openRouteInfo(r); }); routeGroup.addLayer(l); });
        glow.bringToBack(); core.bringToBack(); glow.bringToBack();
        if(r.dest&&r.dest.at){
          var tower='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFC53D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21l3-11M17 21l-3-11M8.5 15.5h7M9.5 10h5"></path><path d="M8 10V7.5h8V10"></path><path d="M12 7.5V4.5M9 4.5l3-1.5 3 1.5"></path></svg>';
          var dm=L.marker([r.dest.at[1],r.dest.at[0]],{interactive:true,keyboard:false,icon:L.divIcon({className:'',iconSize:[0,0],
            html:'<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:auto;cursor:pointer">'+
              '<div style="white-space:nowrap;font:700 10px \'Helvetica Neue\';color:#FFC53D;background:rgba(10,12,16,.92);border:1px solid #FFC53D;border-radius:9px;padding:2px 8px;box-shadow:0 1px 6px rgba(0,0,0,.5)">'+esc(r.dest.name)+'</div>'+
              '<div style="width:30px;height:30px;border-radius:50%;background:rgba(10,12,16,.95);border:2px solid #FFC53D;box-shadow:0 0 10px #FFC53D99;display:flex;align-items:center;justify-content:center">'+tower+'</div></div>'})});
          dm.on('click',function(ev){ try{ L.DomEvent.stopPropagation(ev); }catch(e){} openRouteInfo(r); });
          routeGroup.addLayer(dm);
        }
        var mid=ll[Math.floor(ll.length/2)];
        L.marker(mid,{interactive:false,icon:L.divIcon({className:'',iconSize:[0,0],
          html:'<div style="transform:translate(-50%,-50%);white-space:nowrap;font:700 10px \'Helvetica Neue\';letter-spacing:.04em;color:#1A1300;background:#FFC53D;border-radius:9px;padding:2px 8px;box-shadow:0 1px 6px rgba(0,0,0,.5);pointer-events:none">★ '+esc(r.name.length>32?r.name.slice(0,31)+'…':r.name)+'</div>'})}).addTo(routeLabels);
      });
    }
    syncRouteLabels();
  }
  var GATE_SVG='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#46C9B4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5M20 21V5"></path><path d="M4 9h16M4 15h16M4 9l16 6"></path></svg>';
  var PIN_SVG='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#46C9B4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.6-6-10a6 6 0 1 1 12 0c0 4.4-6 10-6 10z"></path><circle cx="12" cy="11" r="2"></circle></svg>';
  function svgOf(c,p){ return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="'+c+'" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>'; }
  var KINDS={
    gate:{label:'GATE',color:'#46C9B4',svg:GATE_SVG,src:'Gaia GPS waypoint'},
    hydrant:{label:'WATER \u00b7 HYDRANT',color:'#4C8DFF',svg:svgOf('#4C8DFF','<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"></path>'),src:'Gaia GPS waypoint'},
    heli:{label:'HELISPOT',color:'#FF8FD0',svg:svgOf('#FF8FD0','<circle cx="12" cy="12" r="9"></circle><path d="M9 7v10M15 7v10M9 12h6"></path>')},
    view:{label:'VIEWPOINT',color:'#FFC53D',svg:svgOf('#FFC53D','<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>')},
    cabin:{label:'CABIN',color:'#7FD36B',svg:svgOf('#7FD36B','<path d="M3 11l9-7 9 7"></path><path d="M5 10v10h14V10M10 20v-5h4v5"></path>')},
    water:{label:'WATER',color:'#4C8DFF',svg:svgOf('#4C8DFF','<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"></path>')},
    warn:{label:'WARNING',color:'#E5484D',svg:svgOf('#E5484D','<path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v5M12 18v.5"></path>')},
    station:{label:'FIRE STATION',color:'#FF5A4D',svg:svgOf('#FF5A4D','<path d="M3 21V9l9-6 9 6v12"></path><path d="M3 21h18M9 21v-6h6v6M12 7v3M10.5 8.5h3"></path>')},
    camp:{label:'CAMP',color:'#7FD36B',svg:svgOf('#7FD36B','<path d="M3 20L12 4l9 16H3z"></path><path d="M12 4v16M9 20l3-6 3 6"></path>'),src:'Gaia GPS waypoint'}
  };
  function kindOf(pt){ return KINDS[pt.kind]||{label:'MAP POINT',color:'#46C9B4',svg:PIN_SVG}; }
  function drawPoints(){
    var L=window.L;
    allPoints().forEach(function(pt){
      if(!pt.at) return;
      var K=kindOf(pt);
      var m=L.marker([pt.at[1],pt.at[0]],{interactive:true,keyboard:false,icon:L.divIcon({className:'',iconSize:[0,0],
        html:'<div style="position:relative;pointer-events:auto;cursor:pointer">'+
          '<div style="position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;background:rgba(10,12,16,.95);border:2px solid '+K.color+';box-shadow:0 0 8px '+K.color+'88;display:flex;align-items:center;justify-content:center">'+K.svg+'</div>'+
          '<div style="position:absolute;left:0;top:17px;transform:translateX(-50%);white-space:nowrap;font:700 10px \'Helvetica Neue\';color:'+K.color+';background:rgba(10,12,16,.92);border:1px solid '+K.color+';border-radius:8px;padding:1px 7px">'+esc(pt.name)+'</div></div>'})});
      m.on('click',function(ev){ try{ L.DomEvent.stopPropagation(ev); }catch(e){} openPointInfo(pt); });
      pointGroup.addLayer(m);
    });
  }
  function openPointInfo(pt){
    if(selKey){ selKey=null; draw(); }
    var K=kindOf(pt);
    var sheet=ui.sheet; sheet.style.display='flex'; setMenuBtn(false);
    var ft=pt.ele!=null&&pt.ele!==''? Math.round(pt.ele*3.28084).toLocaleString()+' ft (from GPX)' : '';
    sheet.innerHTML=
      '<div style="display:flex;align-items:flex-start;gap:10px">'+
        '<div style="width:12px;height:38px;border-radius:6px;background:'+K.color+';flex-shrink:0;box-shadow:0 0 10px '+K.color+'99"></div>'+
        '<div style="flex:1;min-width:0"><div style="font:700 10px \'Helvetica Neue\';letter-spacing:.12em;color:'+K.color+'">'+K.label+'</div>'+
        '<div style="font:700 19px/1.2 \'Helvetica Neue\';color:#ECEEF1;margin-top:3px">'+esc(pt.name)+'</div></div>'+
        '<button id="pt-x" style="background:none;border:none;color:#9AA3AE;font-size:24px;line-height:1;cursor:pointer">\u00d7</button>'+
      '</div>'+
      '<div style="margin-top:10px">'+infoRow('Note',pt.note||'')+infoRow('Elevation',ft)+infoRow('Coordinates',pt.at[1].toFixed(5)+', '+pt.at[0].toFixed(5))+infoRow('Source',pt.src==='bundled'?'Built into Comm Guide (Gaia GPS waypoint)':'Added on this phone from a GPX file')+'</div>'+
      '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">'+
        (pt.src==='phone'?'<button id="pt-del" style="background:#14181C;border:1px solid #2A3439;border-radius:16px;padding:8px 14px;font:600 12px \'Helvetica Neue\';color:#E5484D;cursor:pointer">Remove</button>':'')+
        '<button id="pt-fit" style="background:#4C8DFF;border:none;border-radius:16px;padding:9px 20px;font:700 12px \'Helvetica Neue\';color:#fff;cursor:pointer">Zoom to</button>'+
      '</div>';
    sheet.querySelector('#pt-x').onclick=closeSheet;
    sheet.querySelector('#pt-fit').onclick=function(){ map.setView([pt.at[1],pt.at[0]],15); };
    var d=sheet.querySelector('#pt-del'); if(d) d.onclick=function(){ if(confirm('Remove "'+pt.name+'" from this phone?')){ importedPts=importedPts.filter(function(x){ return x.id!==pt.id; }); saveImported(); drawRoutes(); closeSheet(); toast('Removed'); } };
  }
  function openRouteInfo(r){
    if(selKey) { selKey=null; draw(); }
    var sheet=ui.sheet; sheet.style.display='flex'; setMenuBtn(false);
    var mi=routeMiles(r.pts);
    sheet.innerHTML=
      '<div style="display:flex;align-items:flex-start;gap:10px">'+
        '<div style="width:12px;height:38px;border-radius:6px;background:#FFC53D;flex-shrink:0;box-shadow:0 0 10px #FFC53D99"></div>'+
        '<div style="flex:1;min-width:0"><div style="font:700 10px \'Helvetica Neue\';letter-spacing:.12em;color:#FFC53D">★ MAIN ROUTE</div>'+
        '<div style="font:700 17px/1.2 \'Helvetica Neue\';color:#ECEEF1;margin-top:3px">'+esc(r.name)+'</div></div>'+
        '<button id="rt-x" style="background:none;border:none;color:#9AA3AE;font-size:24px;line-height:1;cursor:pointer">×</button>'+
      '</div>'+
      '<div style="margin-top:10px">'+infoRow('Destination',r.dest?r.dest.name:'')+infoRow('Note',r.note||'')+infoRow('Length','~'+mi.toFixed(1)+' mi')+infoRow('Source',r.src==='bundled'?'Built into Comm Guide (Gaia GPS track)':'Added on this phone from a GPX file')+'</div>'+
      '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">'+
        (r.src==='phone'?'<button id="rt-del" style="background:#14181C;border:1px solid #2A3439;border-radius:16px;padding:8px 14px;font:600 12px \'Helvetica Neue\';color:#E5484D;cursor:pointer">Remove</button>':'')+
        '<button id="rt-fit" style="background:#4C8DFF;border:none;border-radius:16px;padding:9px 20px;font:700 12px \'Helvetica Neue\';color:#fff;cursor:pointer">Zoom to route</button>'+
      '</div>';
    sheet.querySelector('#rt-x').onclick=closeSheet;
    sheet.querySelector('#rt-fit').onclick=function(){ map.fitBounds(window.L.latLngBounds(r.pts.map(function(pt){ return [pt[1],pt[0]]; })),{padding:[30,30],paddingBottomRight:[30,220]}); };
    var d=sheet.querySelector('#rt-del'); if(d) d.onclick=function(){ if(confirm('Remove "'+r.name+'" from this phone?')){ imported=imported.filter(function(x){ return x.id!==r.id; }); saveImported(); drawRoutes(); closeSheet(); toast('Route removed'); } };
  }
  function importGpx(file){
    var fr=new FileReader();
    fr.onload=function(){
      try{
        var doc=new DOMParser().parseFromString(fr.result,'application/xml');
        if(doc.getElementsByTagName('parsererror').length) throw 0;
        var made=[], trks=doc.getElementsByTagName('trk'), i;
        function grab(nodes){ var pts=[]; for(var j=0;j<nodes.length;j++){ var la=parseFloat(nodes[j].getAttribute('lat')), lo=parseFloat(nodes[j].getAttribute('lon')); if(isFinite(la)&&isFinite(lo)) pts.push([+lo.toFixed(5),+la.toFixed(5)]); } return pts; }
        function nm(el,fallback){ var n=el.getElementsByTagName('name')[0]; return (n&&n.textContent.trim())||fallback; }
        for(i=0;i<trks.length;i++) made.push({name:nm(trks[i],file.name.replace(/\.gpx$/i,'')),pts:grab(trks[i].getElementsByTagName('trkpt'))});
        if(!made.length){ var rtes=doc.getElementsByTagName('rte'); for(i=0;i<rtes.length;i++) made.push({name:nm(rtes[i],file.name.replace(/\.gpx$/i,'')),pts:grab(rtes[i].getElementsByTagName('rtept'))}); }
        made=made.filter(function(r){ return r.pts.length>1; });
        var wpts=doc.getElementsByTagName('wpt'), madePts=[];
        for(i=0;i<wpts.length;i++){ var wl=parseFloat(wpts[i].getAttribute('lat')), wo=parseFloat(wpts[i].getAttribute('lon')); if(!isFinite(wl)||!isFinite(wo)) continue;
          var ee=wpts[i].getElementsByTagName('ele')[0]; madePts.push({id:'p'+Date.now().toString(36)+i,name:nm(wpts[i],'Point'),kind:'point',at:[+wo.toFixed(6),+wl.toFixed(6)],ele:ee?parseFloat(ee.textContent):null}); }
        if(!made.length&&!madePts.length){ toast('No track, route or waypoint found in that GPX'); return; }
        madePts.forEach(function(pt){ importedPts=importedPts.filter(function(x){ return x.name!==pt.name; }); importedPts.push(pt); });
        made.forEach(function(r,n){
          if(r.pts.length>6000){ var step=Math.ceil(r.pts.length/6000); r.pts=r.pts.filter(function(_,x){ return x%step===0||x===r.pts.length-1; }); }
          r.id='u'+Date.now().toString(36)+n; r.name=nice(r.name)||r.name;
          imported=imported.filter(function(x){ return x.name!==r.name; }); imported.push(r);
        });
        if(!saveImported()){ toast('Could not save — phone storage is full or blocked'); return; }
        var addedTxt=[made.length?made.length+' main route'+(made.length===1?'':'s'):'',madePts.length?madePts.length+' point'+(madePts.length===1?'':'s'):''].filter(Boolean).join(' + ');
        if(!routesOn){ routesOn=true; try{ localStorage.setItem('cg_routes_on','1'); }catch(e){} var c=root.querySelector('#rd-r'); if(c) c.textContent='★ Main routes'; }
        drawRoutes();
        var fitPts=made.length? made[0].pts : madePts.map(function(pt){ return pt.at; });
        if(fitPts.length>1) map.fitBounds(window.L.latLngBounds(fitPts.map(function(pt){ return [pt[1],pt[0]]; })),{padding:[30,30]}); else map.setView([fitPts[0][1],fitPts[0][0]],14);
        toast('Added '+addedTxt+' on this phone');
      }catch(e){ toast('Couldn’t read that GPX file'); }
    };
    fr.readAsText(file);
  }

  function exportEdits(){
    var n=Object.keys(store.edits).length, txt=JSON.stringify({v:1,edits:store.edits,routes:imported,points:importedPts},null,1);
    if(!n&&!imported.length&&!importedPts.length){ toast('Nothing to export yet'); return; }
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
        var o=JSON.parse(fr.result); if(!o||(!o.edits&&!o.routes&&!o.points)) throw 0;
        var n=0, kept=0;
        (o.routes||[]).forEach(function(r){ if(r&&r.pts&&r.name&&!imported.some(function(x){ return x.id===r.id||x.name===r.name; })){ imported.push({id:r.id||('u'+Date.now().toString(36)+imported.length),name:r.name,pts:r.pts}); n++; } });
        (o.points||[]).forEach(function(pt){ if(pt&&pt.at&&pt.name&&!importedPts.some(function(x){ return x.id===pt.id||x.name===pt.name; })){ importedPts.push({id:pt.id||('p'+Date.now().toString(36)+importedPts.length),name:pt.name,kind:pt.kind||'point',at:pt.at,ele:pt.ele,note:pt.note||''}); n++; } });
        if((o.routes||[]).length||(o.points||[]).length){ saveImported(); drawRoutes(); }
        Object.keys(o.edits||{}).forEach(function(k){ var inc=o.edits[k], cur=store.edits[k];
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
        '<div style="display:flex;gap:6px;overflow-x:auto;pointer-events:auto" class="hscroll">'+chip('rd-r',routesOn?'\u2605 Main routes':'\u2606 Routes hidden')+chip('rd-b',battOn?'\u25e7 Battalion only':'\u25eb Include outside')+chip('rd-f','All roads')+chip('rd-loc','◎ Me')+chip('rd-dl','Save area offline')+chip('rd-ex','Export')+chip('rd-im','Import')+'</div>'+
        '<div style="align-self:flex-start;background:rgba(10,12,16,.8);border:1px solid #2A3439;border-radius:10px;padding:4px 9px;font:500 10px \'Helvetica Neue\';color:#9AA3AE"><span id="rd-st">Loading…</span> · <span id="rd-cached"></span></div>'+
      '</div>'+
      '<div id="rd-toast" style="position:absolute;left:50%;transform:translateX(-50%);top:118px;z-index:900;background:rgba(10,12,16,.94);border:1px solid #2A3439;border-radius:14px;padding:7px 13px;font:600 11px \'Helvetica Neue\';color:#ECEEF1;opacity:0;transition:opacity .25s;pointer-events:none;max-width:86%;text-align:center"></div>'+
      '<div id="rd-sheet" style="display:none;position:absolute;left:0;right:0;bottom:0;z-index:800;max-height:62%;overflow:auto;-webkit-overflow-scrolling:touch;flex-direction:column;background:#0E1214;border-top:1px solid #2a3439;border-radius:16px 16px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.5);padding:14px 14px 18px"></div>'+
      '<input id="rd-file" type="file" accept="application/json,.json,.gpx,application/gpx+xml,text/xml,application/xml" style="display:none">';
    ui={ status:root.querySelector('#rd-st'), cached:root.querySelector('#rd-cached'), sheet:root.querySelector('#rd-sheet'), toast:root.querySelector('#rd-toast') };
    var L=window.L, home={lat:38.240639,lng:-120.208366}; // Skull Creek Station (verified)
    map=L.map(root.querySelector('#rd-map'),{attributionControl:true,zoomControl:false,preferCanvas:true}).setView([home.lat,home.lng],12);
    map.attributionControl.setPrefix(false);
    if(window.__cgTileLayer) window.__cgTileLayer().addTo(map);
    else L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap'}).addTo(map);
    map.attributionControl.addAttribution('Roads: USDA Forest Service');
    renderer=L.canvas({padding:0.3,tolerance:10});
    routeGroup=L.layerGroup().addTo(map); routeLabels=L.layerGroup().addTo(map); pointGroup=L.layerGroup().addTo(map);
    group=L.layerGroup().addTo(map); labelGroup=L.layerGroup().addTo(map);
    map.on('zoomend',syncRouteLabels);
    map.on('moveend',function(){ clearTimeout(moveT); moveT=setTimeout(function(){ loadView(false); },250); });
    map.on('click',function(){ if(selKey) closeSheet(); });
    root.querySelector('#rd-q').oninput=function(){ query=this.value.trim().toLowerCase(); draw(); };
    root.querySelector('#rd-f').onclick=function(){ filterMode=filterMode==='all'?'crew':'all'; this.textContent=filterMode==='all'?'All roads':'★ Crew roads only'; draw(); };
    root.querySelector('#rd-b').onclick=function(){
      if(battFailed){ toast('Battalion boundary file did not load'); return; }
      battOn=!battOn; try{ localStorage.setItem('cg_roads_batt',battOn?'1':'0'); }catch(e){}
      this.textContent=battOn?'\u25e7 Battalion only':'\u25eb Include outside';
      if(selKey) closeSheet(); loadView(false);
    };
    root.querySelector('#rd-r').onclick=function(){
      routesOn=!routesOn; try{ localStorage.setItem('cg_routes_on',routesOn?'1':'0'); }catch(e){}
      this.textContent=routesOn?'\u2605 Main routes':'\u2606 Routes hidden'; drawRoutes();
    };
    (function(){ var sc=document.createElement('script'); sc.src='./routes.js';
      sc.onload=function(){ drawRoutes(); }; sc.onerror=function(){ drawRoutes(); };
      document.head.appendChild(sc); })();
    root.querySelector('#rd-loc').onclick=locate;
    (function(){ var sc=document.createElement('script'); sc.src='./battalion.js';
      sc.onload=function(){ initBatt(); };
      sc.onerror=function(){ battFailed=true; toast('Battalion boundary not loaded \u2014 showing all roads'); draw(); };
      document.head.appendChild(sc); })();
    root.querySelector('#rd-dl').onclick=downloadArea;
    root.querySelector('#rd-ex').onclick=exportEdits;
    root.querySelector('#rd-im').onclick=function(){ root.querySelector('#rd-file').click(); };
    root.querySelector('#rd-file').onchange=function(){ var f=this.files&&this.files[0]; if(f){ if(/\.gpx$/i.test(f.name)||/gpx/i.test(f.type)) importGpx(f); else importEdits(f); } this.value=''; };
    refreshCount();
    setTimeout(function(){ map.invalidateSize(); loadView(false); },60);
  }

  function initBatt(){
    var b=window.CG_BATT; if(!b||!b.ring||b.ring.length<4){ battFailed=true; draw(); return; }
    BATT=b.ring; BB=[1e9,1e9,-1e9,-1e9];
    BATT.forEach(function(pt){ if(pt[0]<BB[0])BB[0]=pt[0]; if(pt[0]>BB[2])BB[2]=pt[0]; if(pt[1]<BB[1])BB[1]=pt[1]; if(pt[1]>BB[3])BB[3]=pt[1]; });
    Object.keys(segs).forEach(function(o){ clipSeg(segs[o]); });
    if(map){
      window.L.polyline(BATT.map(function(pt){ return [pt[1],pt[0]]; }),{renderer:renderer,color:'#ECEEF1',weight:2,opacity:0.75,dashArray:'7 6',interactive:false}).addTo(map);
    }
    loadView(false);
  }

  window.__cgRoads={
    show:function(){ if(!built) build(); else setTimeout(function(){ map.invalidateSize(); loadView(false); },60); },
    _map:function(){ return map; },
    _segs:function(){ return segs; },
    _routes:function(){ return allRoutes(); },
    _points:function(){ return allPoints(); },
    _routeLayers:function(){ return routeGroup? routeGroup.getLayers().length : -1; },
    _incl:function(){ if(inclDirty) computeIncl(); return incl; },
    _debug:function(){ return {segs:Object.keys(segs).length, edits:store.edits}; }
  };
  // if the tab was already opened while this file was loading
  if(document.getElementById('panel-roads') && document.getElementById('panel-roads').style.display==='flex') window.__cgRoads.show();
})();
