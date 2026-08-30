import { useState, useCallback, useRef, useEffect } from "react";

// Provider credentials must remain on a server-side proxy, never in a Vite bundle.
const API_URL = import.meta.env.VITE_FURNITURE_API_URL || "/api/furniture/analyze";

const SYSTEM_PROMPT = `You are a professional furniture analyst for office/commercial space relocation projects.

TASK: Identify all MOVABLE furniture in this image — items that can be physically relocated during an office move.

INCLUDE ONLY:
- Desks, tables (work tables, conference tables, side tables, bar tables, coffee tables)
- Chairs (office chairs, lounge chairs, stools, benches)
- Sofas, couches, ottomans, modular seating
- Storage (bookshelves, cabinets, lockers, drawer units, filing cabinets)
- Freestanding lamps (floor lamps, desk lamps, portable lights)
- Movable whiteboards, partitions, room dividers
- Planters with plants (potted plants, planter boxes)
- Rugs, carpets
- Freestanding monitors/TVs on stands
- Tripods, camera equipment

STRICTLY EXCLUDE:
- Ceiling-mounted items: recessed lights, ceiling panels, sprinklers, HVAC ducts, projectors
- Built-in fixtures: wall-mounted AC, built-in shelving, fixed counters, permanent bars
- Architectural elements: columns, walls, doors, windows, flooring
- Building infrastructure: pipes, electrical outlets, fire alarms, exit signs
- Window blinds/curtains that are part of the building

For each item provide:
1. name_ko: Korean name
2. name_en: English name
3. category: one of [의자/Chair, 테이블/Table, 소파/Sofa, 수납/Storage, 조명/Lighting, 기타/Other]
4. color: primary color
5. material: estimated material
6. quantity: count visible
7. notes: design features or brand guesses
8. confidence: 0.0-1.0
9. point: [x_percent, y_percent] center point as % of image dimensions (0-100)

Be conservative. Respond ONLY with a valid JSON array, no markdown.`;

const COLORS = {
  "의자/Chair": "#E74C3C",
  "테이블/Table": "#3498DB",
  "소파/Sofa": "#2ECC71",
  "수납/Storage": "#F39C12",
  "조명/Lighting": "#9B59B6",
  "기타/Other": "#1ABC9C",
};

export default function FurnitureExtractor() {
  const [image, setImage] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [threshold, setThreshold] = useState(0.6);
  const [selCat, setSelCat] = useState("all");
  const fileRef = useRef(null);
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const [imgRect, setImgRect] = useState(null); // { offsetX, offsetY, width, height }

  // Calculate actual rendered image area within the container (accounting for object-fit: contain)
  const updateImgRect = useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container || !img.naturalWidth) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;

    const scale = Math.min(cw / nw, ch / nh);
    const renderedW = nw * scale;
    const renderedH = nh * scale;
    const offsetX = (cw - renderedW) / 2;
    const offsetY = (ch - renderedH) / 2;

    setImgRect({ offsetX, offsetY, width: renderedW, height: renderedH });
  }, []);

  useEffect(() => {
    window.addEventListener("resize", updateImgRect);
    return () => window.removeEventListener("resize", updateImgRect);
  }, [updateImgRect]);

  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      setImage({
        dataUrl,
        base64: dataUrl.split(",")[1],
        name: file.name,
        mimeType: file.type.includes("png") ? "image/png" : file.type.includes("webp") ? "image/webp" : "image/jpeg",
      });
      setResults([]); setSelectedIdx(null); setError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  const analyze = async () => {
    if (!image) return;
    setLoading(true); setError(null); setResults([]); setSelectedIdx(null);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: image.mimeType, data: image.base64 } },
              { text: SYSTEM_PROMPT },
            ],
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 16384 },
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Error ${res.status}`); }
      const data = await res.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      text = text.replace(/```json|```/g, "").trim();
      try {
        setResults(JSON.parse(text));
      } catch {
        // Truncated JSON recovery: close open strings/objects/arrays
        let fixed = text;
        // Remove trailing incomplete object/value after last comma
        fixed = fixed.replace(/,\s*[^}\]]*$/, "");
        // Close any unclosed brackets
        const opens = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
        const braces = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
        for (let i = 0; i < braces; i++) fixed += "}";
        for (let i = 0; i < opens; i++) fixed += "]";
        setResults(JSON.parse(fixed));
      }
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  const reset = () => { setImage(null); setResults([]); setSelectedIdx(null); setError(null); setSelCat("all"); };

  const aboveT = results.filter(r => (r.confidence || 0) >= threshold);
  const filtered = aboveT.filter(r => selCat === "all" || r.category === selCat);
  const catCounts = aboveT.reduce((a, r) => { a[r.category] = (a[r.category] || 0) + r.quantity; return a; }, {});
  const total = aboveT.reduce((s, r) => s + r.quantity, 0);
  const activeIdx = selectedIdx !== null ? selectedIdx : hoveredIdx;

  const exportCSV = () => {
    const h = ["이름(KO)","Name(EN)","카테고리","색상","소재","수량","비고","확신도"];
    const rows = aboveT.map(r => [r.name_ko,r.name_en,r.category,r.color,r.material,r.quantity,r.notes,r.confidence].map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(","));
    const blob = new Blob(["\uFEFF"+[h.join(","),...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "furniture_list.csv"; a.click();
  };
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(aboveT, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "furniture_list.json"; a.click();
  };

  // ── Upload screen ──
  if (!image) {
    return (
      <div style={S.uploadScreen}>
        <div style={S.uploadInner}>
          <h1 style={S.logoTitle}>Furniture Extractor</h1>
          <p style={S.logoSub}>이미지 속 이사 가능한 가구를 자동 인식합니다</p>
          <div
            style={{ ...S.drop, ...(dragOver ? S.dropActive : {}) }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={e => handleFile(e.target.files[0])} />
            <span style={S.dropIcon}>+</span>
            <span style={S.dropText}>클릭하거나 이미지를 드래그하세요</span>
            <span style={S.dropHint}>JPG, PNG, WEBP</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Main split layout ──
  return (
    <div style={S.splitWrap}>
      {/* LEFT: Image */}
      <div style={S.leftPane}>
        <div ref={containerRef} style={S.imgContainer}>
          <img ref={imgRef} src={image.dataUrl} alt="" style={S.img} onLoad={updateImgRect} />

          {imgRect && filtered.map((item, i) => {
            const ri = results.indexOf(item);
            if (!item.point) return null;
            const [px, py] = item.point;
            const left = imgRect.offsetX + (px / 100) * imgRect.width;
            const top = imgRect.offsetY + (py / 100) * imgRect.height;
            const active = activeIdx === ri;
            const c = COLORS[item.category] || "#999";
            return (
              <div key={i} style={{ position:"absolute", left, top, transform:"translate(-50%,-50%)", zIndex: active?20:5, pointerEvents:"none" }}>
                {active && <div style={{ position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)", width:36,height:36,borderRadius:"50%",border:`2px solid ${c}`,opacity:0.4,animation:"pulse 1.5s ease-in-out infinite" }}/>}
                <div style={{ width:active?14:8, height:active?14:8, borderRadius:"50%", background:c, border:"2px solid #fff", boxShadow:"0 1px 4px rgba(0,0,0,0.3)", transition:"all 0.2s" }}/>
                {active && <div style={{ position:"absolute",top:-28,left:"50%",transform:"translateX(-50%)", background:c,color:"#fff",fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:3,whiteSpace:"nowrap",boxShadow:"0 1px 4px rgba(0,0,0,0.2)" }}>{item.name_ko}</div>}
              </div>
            );
          })}
        </div>

        {/* Bottom bar */}
        <div style={S.imgBottom}>
          <span style={S.imgName}>{image.name}</span>
          <button style={S.resetBtn} onClick={reset}>다른 이미지</button>
        </div>

        {results.length === 0 && !loading && (
          <button style={S.analyzeBtn} onClick={analyze}>이미지 분석하기</button>
        )}
        {loading && (
          <div style={S.loadWrap}>
            <div style={S.spinner}/><span style={S.loadText}>가구를 찾고 있습니다...</span>
          </div>
        )}
        {error && <div style={S.error}>{error}</div>}
      </div>

      {/* RIGHT: List */}
      <div style={S.rightPane}>
        <div style={S.panelHeader}>
          <h2 style={S.panelTitle}>가구 목록</h2>
          {results.length > 0 && <span style={S.panelCount}>{total}개</span>}
        </div>

        {results.length === 0 && !loading && (
          <div style={S.emptyPanel}>
            <span style={S.emptyIcon}>◎</span>
            <span style={S.emptyText}>이미지를 분석하면<br/>가구 목록이 여기에 표시됩니다</span>
          </div>
        )}

        {results.length > 0 && (
          <>
            {/* Confidence slider */}
            <div style={S.sliderRow}>
              <span style={S.sliderLabel}>확신도</span>
              <input type="range" min="0" max="100" value={threshold*100}
                onChange={e => setThreshold(e.target.value/100)} style={S.slider}/>
              <span style={S.sliderVal}>{Math.round(threshold*100)}%</span>
            </div>

            {/* Category filter */}
            <div style={S.filterRow}>
              <button style={{...S.fBtn,...(selCat==="all"?S.fBtnA:{})}} onClick={()=>setSelCat("all")}>전체</button>
              {Object.keys(COLORS).map(cat => catCounts[cat] ? (
                <button key={cat}
                  style={{...S.fBtn,...(selCat===cat?{...S.fBtnA,background:COLORS[cat],borderColor:COLORS[cat]}:{})}}
                  onClick={()=>setSelCat(cat)}
                >{cat.split("/")[0]}</button>
              ) : null)}
            </div>

            {/* Scrollable list */}
            <div style={S.listScroll}>
              {filtered.map((item, i) => {
                const ri = results.indexOf(item);
                const active = activeIdx === ri;
                const c = COLORS[item.category] || "#999";
                const conf = Math.round((item.confidence||0)*100);
                return (
                  <div key={i}
                    style={{ ...S.card, borderLeft:`3px solid ${active?c:"#eee"}`, background:active?`${c}08`:"#fff" }}
                    onMouseEnter={()=>setHoveredIdx(ri)}
                    onMouseLeave={()=>setHoveredIdx(null)}
                    onClick={()=>setSelectedIdx(selectedIdx===ri?null:ri)}
                  >
                    <div style={S.cardTop}>
                      <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0,flex:1}}>
                        <div style={{width:7,height:7,borderRadius:"50%",background:c,flexShrink:0}}/>
                        <span style={{...S.cardName,color:active?c:"#1a1a1a"}}>{item.name_ko}</span>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
                        <span style={{...S.conf,color:conf>=80?"#22c55e":conf>=60?"#f59e0b":"#ef4444"}}>{conf}%</span>
                        <span style={{...S.qty,background:`${c}12`,color:c}}>×{item.quantity}</span>
                      </div>
                    </div>
                    <div style={S.cardEn}>{item.name_en}</div>
                    <div style={S.cardMeta}>
                      <span style={S.tag}>{item.color}</span>
                      <span style={S.tag}>{item.material}</span>
                    </div>
                    {item.notes && <div style={S.cardNotes}>{item.notes}</div>}
                  </div>
                );
              })}
            </div>

            {/* Export */}
            <div style={S.exportRow}>
              <button style={S.expBtn} onClick={exportCSV}>CSV</button>
              <button style={S.expBtn} onClick={exportJSON}>JSON</button>
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.4}50%{transform:translate(-50%,-50%) scale(1.5);opacity:0} }
        input[type="range"]{-webkit-appearance:none;height:3px;background:#e0e0e0;border-radius:2px;outline:none}
        input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#1a1a1a;cursor:pointer}
        *::-webkit-scrollbar{width:4px}
        *::-webkit-scrollbar-track{background:transparent}
        *::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
      `}</style>
    </div>
  );
}

const S = {
  // Upload screen
  uploadScreen: {
    minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
    fontFamily:"'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    padding:20,
  },
  uploadInner: { maxWidth:480,width:"100%",textAlign:"center" },
  logoTitle: { fontSize:24,fontWeight:600,letterSpacing:"-0.02em",margin:"0 0 4px" },
  logoSub: { fontSize:13,color:"#999",margin:"0 0 28px" },
  drop: {
    border:"1.5px dashed #ccc",borderRadius:10,padding:"60px 24px",cursor:"pointer",
    transition:"all 0.2s",display:"flex",flexDirection:"column",alignItems:"center",gap:8,
  },
  dropActive: { borderColor:"#1a1a1a",background:"#fafafa" },
  dropIcon: { fontSize:32,fontWeight:300,color:"#bbb" },
  dropText: { fontSize:14,color:"#666" },
  dropHint: { fontSize:12,color:"#aaa" },

  // Split layout
  splitWrap: {
    display:"flex",height:"100vh",overflow:"hidden",
    fontFamily:"'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    color:"#1a1a1a",
  },

  // Left pane
  leftPane: {
    flex:1,display:"flex",flexDirection:"column",overflow:"hidden",
    background:"#f8f8f8",
  },
  imgContainer: {
    flex:1,position:"relative",overflow:"hidden",
    display:"flex",alignItems:"center",justifyContent:"center",
    background:"#111",
  },
  img: { maxWidth:"100%",maxHeight:"100%",objectFit:"contain",display:"block" },
  imgBottom: {
    display:"flex",justifyContent:"space-between",alignItems:"center",
    padding:"8px 12px",background:"#fff",borderTop:"1px solid #eee",
  },
  imgName: { fontSize:11,color:"#999",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  resetBtn: {
    fontSize:11,padding:"3px 10px",borderRadius:4,
    background:"#f5f5f5",color:"#555",border:"1px solid #e0e0e0",cursor:"pointer",
  },
  analyzeBtn: {
    margin:0,padding:"12px 0",background:"#1a1a1a",color:"#fff",
    border:"none",fontSize:13,fontWeight:500,cursor:"pointer",
  },
  loadWrap: { display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"14px 0",background:"#fff" },
  spinner: { width:16,height:16,border:"2px solid #eee",borderTopColor:"#1a1a1a",borderRadius:"50%",animation:"spin 0.6s linear infinite" },
  loadText: { fontSize:12,color:"#888" },
  error: { padding:"10px 14px",background:"#fef2f2",color:"#b91c1c",fontSize:12 },

  // Right pane
  rightPane: {
    width:340,minWidth:280,maxWidth:400,display:"flex",flexDirection:"column",
    borderLeft:"1px solid #eee",background:"#fff",
  },
  panelHeader: {
    display:"flex",justifyContent:"space-between",alignItems:"center",
    padding:"16px 16px 12px",borderBottom:"1px solid #f0f0f0",
  },
  panelTitle: { fontSize:15,fontWeight:600,margin:0 },
  panelCount: { fontSize:12,color:"#999",fontWeight:500 },

  emptyPanel: {
    flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
    gap:8,padding:20,
  },
  emptyIcon: { fontSize:32,color:"#ddd" },
  emptyText: { fontSize:12,color:"#bbb",textAlign:"center",lineHeight:1.6 },

  sliderRow: { display:"flex",alignItems:"center",gap:8,padding:"10px 16px",borderBottom:"1px solid #f5f5f5" },
  sliderLabel: { fontSize:11,fontWeight:500,color:"#888",whiteSpace:"nowrap" },
  slider: { flex:1,cursor:"pointer" },
  sliderVal: { fontSize:12,fontWeight:600,color:"#1a1a1a",minWidth:30,textAlign:"right" },

  filterRow: { display:"flex",gap:4,padding:"8px 16px",flexWrap:"wrap",borderBottom:"1px solid #f5f5f5" },
  fBtn: { padding:"3px 8px",border:"1px solid #e0e0e0",borderRadius:3,background:"#fff",fontSize:10,cursor:"pointer",color:"#666" },
  fBtnA: { background:"#1a1a1a",color:"#fff",borderColor:"#1a1a1a" },

  listScroll: { flex:1,overflowY:"auto",padding:"8px 12px",display:"flex",flexDirection:"column",gap:4 },
  card: { padding:"8px 10px",borderRadius:5,border:"1px solid #eee",cursor:"pointer",transition:"all 0.12s" },
  cardTop: { display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2 },
  cardName: { fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",transition:"color 0.12s" },
  conf: { fontSize:10,fontWeight:600 },
  qty: { fontSize:10,fontWeight:600,padding:"1px 5px",borderRadius:3 },
  cardEn: { fontSize:10,color:"#aaa",marginBottom:3 },
  cardMeta: { display:"flex",gap:3,flexWrap:"wrap" },
  tag: { fontSize:9,color:"#888",padding:"1px 4px",background:"#f5f5f5",borderRadius:2 },
  cardNotes: { fontSize:10,color:"#999",marginTop:3 },

  exportRow: { display:"flex",gap:4,padding:"10px 16px",borderTop:"1px solid #f0f0f0" },
  expBtn: { flex:1,padding:"6px 0",border:"1px solid #ddd",borderRadius:4,background:"#fff",fontSize:11,cursor:"pointer",color:"#555",textAlign:"center" },
};
