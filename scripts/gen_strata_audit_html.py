#!/usr/bin/env python3
"""Generate docs/strata-feature-audit.html from the workflow audit result JSON."""
import json, re, html, sys, datetime
from collections import Counter, defaultdict

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/claude-1000/-home-natescode-repos-silicon/8b8f7041-4e73-44a7-86ea-63d443f995ec/tasks/wmsdfdr8x.output"
OUT = "/home/natescode/repos/silicon/docs/strata-feature-audit.html"

data = json.load(open(SRC))["result"]
features = data["features"]
synthesis = data["synthesis"]
subsystems = data["subsystems"]

GEN_DATE = "2026-06-08"

# ---- classification + status metadata ----------------------------------
CLASS_META = {
    "via-strata":               ("Implemented via Strata", "Data-driven `.si` stratum — the model working", "strata"),
    "primitive-correct":        ("Primitive (correct)",    "Hardcoded in TS and SHOULD stay primitive — the irreducible substrate", "prim-ok"),
    "primitive-should-migrate": ("Primitive → should migrate", "Hardcoded in TS today but should become a stratum (the Codegen-StrataType gap)", "prim-mig"),
    "missing-should-add":       ("Missing — should add",   "Designed/promised but not yet built", "missing"),
    "missing-non-goal":         ("Missing — non-goal",     "Deliberately excluded (ADR-0023)", "nongoal"),
}
CLASS_ORDER = ["via-strata", "primitive-correct", "primitive-should-migrate", "missing-should-add", "missing-non-goal"]
STATUS_ORDER = ["implemented", "partial", "stubbed", "missing"]
SUB_LABEL = {s["key"]: s["label"] for s in subsystems}

class_counts = Counter(f["classification"] for f in features)
status_counts = Counter(f["status"] for f in features)
cat_counts = Counter(f["category"] for f in features)

# ---- tiny markdown -> html converter (for synthesis + inline fields) ----
def inline(text):
    text = html.escape(text)
    # inline code first (protects content), then bold
    text = re.sub(r"`([^`]+)`", lambda m: f"<code>{m.group(1)}</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*", lambda m: f"<strong>{m.group(1)}</strong>", text)
    return text

def md_to_html(md):
    out, in_ul = [], False
    def close_ul():
        nonlocal in_ul
        if in_ul:
            out.append("</ul>")
            in_ul = False
    for raw in md.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            close_ul()
            continue
        if line.startswith("### "):
            close_ul(); out.append(f"<h4>{inline(line[4:])}</h4>")
        elif line.startswith("## "):
            close_ul(); out.append(f"<h3>{inline(line[3:])}</h3>")
        elif line.startswith("# "):
            close_ul(); out.append(f"<h2 class='sec'>{inline(line[2:])}</h2>")
        elif re.match(r"^\s*-\s+", line):
            if not in_ul:
                out.append("<ul>"); in_ul = True
            out.append(f"<li>{inline(re.sub(r'^\s*-\s+', '', line))}</li>")
        elif re.match(r"^\s*\d+\.\s+", line):
            # numbered item -> render as styled li in an ordered context; keep simple as bullet
            if not in_ul:
                out.append("<ul class='ol'>"); in_ul = True
            out.append(f"<li>{inline(re.sub(r'^\s*\d+\.\s+', '', line))}</li>")
        else:
            close_ul(); out.append(f"<p>{inline(line)}</p>")
    close_ul()
    return "\n".join(out)

synthesis_html = md_to_html(synthesis)

# ---- build feature cards data (json embedded for client filtering) -----
def feat_json(f):
    return {
        "name": f["name"], "surface": f["surface"], "category": f["category"],
        "status": f["status"], "location": f["location"],
        "how": f["howImplemented"], "cls": f["classification"],
        "rec": f["recommendation"], "evidence": f["evidence"],
        "conf": f["confidence"], "sub": f.get("subsystem", ""),
        "verify": f.get("verifyNote", ""),
    }

feat_data = [feat_json(f) for f in features]

# Pre-render each feature row's inline-converted HTML server-side into the data,
# so the client just toggles visibility.
for fd, f in zip(feat_data, features):
    fd["how_h"] = inline(f["howImplemented"])
    fd["rec_h"] = inline(f["recommendation"])
    fd["ev_h"] = inline(f["evidence"])
    fd["surface_h"] = html.escape(f["surface"])
    fd["loc_h"] = inline(f["location"])
    fd["verify_h"] = inline(f.get("verifyNote", "")) if f.get("verifyNote") else ""

DATA_JSON = json.dumps(feat_data, ensure_ascii=False)

# ---- metric tiles -------------------------------------------------------
def tile(num, label, cls=""):
    return f"<div class='tile {cls}'><div class='num'>{num}</div><div class='lbl'>{label}</div></div>"

metric_tiles = "".join([
    tile(len(features), "features audited"),
    tile(class_counts["via-strata"], "via Strata", "t-strata"),
    tile(class_counts["primitive-correct"], "primitive (keep)", "t-prim-ok"),
    tile(class_counts["primitive-should-migrate"], "should migrate", "t-prim-mig"),
    tile(class_counts["missing-should-add"], "missing — add", "t-missing"),
    tile(class_counts["missing-non-goal"], "non-goals", "t-nongoal"),
])

# bar segments for classification distribution
total = len(features)
bar_segments = "".join(
    f"<div class='seg seg-{CLASS_META[c][2]}' style='flex:{class_counts[c]}' "
    f"title='{CLASS_META[c][0]}: {class_counts[c]}'><span>{class_counts[c]}</span></div>"
    for c in CLASS_ORDER if class_counts[c]
)

legend = "".join(
    f"<span class='lg'><i class='dot d-{CLASS_META[c][2]}'></i>{CLASS_META[c][0]} "
    f"<b>({class_counts[c]})</b></span>"
    for c in CLASS_ORDER
)

# status & subsystem mini-bars
def mini_bar(counter, order, total):
    rows = ""
    mx = max(counter.values()) if counter else 1
    for k in order:
        v = counter.get(k, 0)
        rows += (f"<div class='mb-row'><span class='mb-lbl'>{html.escape(str(k))}</span>"
                 f"<span class='mb-track'><span class='mb-fill' style='width:{(v/mx*100):.1f}%'></span></span>"
                 f"<span class='mb-num'>{v}</span></div>")
    return rows

status_bars = mini_bar(status_counts, STATUS_ORDER, total)
sub_bars = mini_bar(Counter({SUB_LABEL[s["key"]]: s["featureCount"] for s in subsystems}),
                    [SUB_LABEL[s["key"]] for s in subsystems], total)
cat_bars = mini_bar(cat_counts, [c for c, _ in cat_counts.most_common()], total)

corrections_total = sum(s["corrections"] for s in subsystems)

# subsystem option list for filter
sub_options = "".join(f"<option value='{s['key']}'>{html.escape(SUB_LABEL[s['key']])}</option>" for s in subsystems)

HTML = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Silicon — Strata vs Primitive Feature Audit</title>
<style>
  :root {{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --border:#2a3140;
    --fg:#e6edf3; --muted:#8b97a7; --faint:#6b7585;
    --strata:#3fb950; --prim-ok:#58a6ff; --prim-mig:#d29922; --missing:#f778ba; --nongoal:#8b949e;
    --accent:#a371f7; --code:#1f6feb;
  }}
  * {{ box-sizing:border-box; }}
  html {{ scroll-behavior:smooth; }}
  body {{ margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }}
  code {{ background:#1f2733; color:#9ad1ff; padding:1px 5px; border-radius:5px;
    font:0.86em/1.4 "SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace; word-break:break-word; }}
  a {{ color:var(--prim-ok); }}
  .wrap {{ max-width:1180px; margin:0 auto; padding:0 22px 80px; }}

  header.hero {{ padding:54px 0 30px; border-bottom:1px solid var(--border);
    background:radial-gradient(1200px 380px at 12% -10%, rgba(163,113,247,.16), transparent 60%),
               radial-gradient(900px 320px at 95% -20%, rgba(63,185,80,.12), transparent 55%); }}
  .eyebrow {{ color:var(--accent); font-weight:700; letter-spacing:.14em; text-transform:uppercase; font-size:12px; }}
  h1 {{ margin:.3em 0 .15em; font-size:36px; line-height:1.12; letter-spacing:-.02em; }}
  .thesis {{ color:var(--muted); font-size:18px; max-width:860px; }}
  .thesis b {{ color:var(--fg); }}
  .meta {{ margin-top:14px; color:var(--faint); font-size:13px; }}
  .meta b {{ color:var(--muted); }}

  .tiles {{ display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin:26px 0 8px; }}
  .tile {{ background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px 14px; text-align:center; }}
  .tile .num {{ font-size:30px; font-weight:800; letter-spacing:-.02em; }}
  .tile .lbl {{ color:var(--muted); font-size:12px; margin-top:3px; line-height:1.3; }}
  .t-strata .num {{ color:var(--strata); }} .t-prim-ok .num {{ color:var(--prim-ok); }}
  .t-prim-mig .num {{ color:var(--prim-mig); }} .t-missing .num {{ color:var(--missing); }}
  .t-nongoal .num {{ color:var(--nongoal); }}

  .distbar {{ display:flex; height:30px; border-radius:8px; overflow:hidden; margin:18px 0 10px; border:1px solid var(--border); }}
  .seg {{ display:flex; align-items:center; justify-content:center; min-width:26px; color:#0d1117; font-weight:800; font-size:12px; }}
  .seg-strata {{ background:var(--strata); }} .seg-prim-ok {{ background:var(--prim-ok); }}
  .seg-prim-mig {{ background:var(--prim-mig); }} .seg-missing {{ background:var(--missing); }}
  .seg-nongoal {{ background:var(--nongoal); }}
  .legend {{ display:flex; flex-wrap:wrap; gap:16px; color:var(--muted); font-size:13px; }}
  .lg {{ display:inline-flex; align-items:center; gap:7px; }}
  .dot {{ width:11px; height:11px; border-radius:50%; display:inline-block; }}
  .d-strata {{ background:var(--strata); }} .d-prim-ok {{ background:var(--prim-ok); }}
  .d-prim-mig {{ background:var(--prim-mig); }} .d-missing {{ background:var(--missing); }}
  .d-nongoal {{ background:var(--nongoal); }}

  .grid3 {{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; margin:24px 0; }}
  .card {{ background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px 18px; }}
  .card h4 {{ margin:0 0 12px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }}
  .mb-row {{ display:flex; align-items:center; gap:9px; margin:6px 0; font-size:12.5px; }}
  .mb-lbl {{ width:120px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }}
  .mb-track {{ flex:1; height:7px; background:#0d1117; border-radius:4px; overflow:hidden; }}
  .mb-fill {{ display:block; height:100%; background:linear-gradient(90deg,var(--accent),var(--prim-ok)); }}
  .mb-num {{ width:26px; text-align:right; color:var(--faint); }}

  nav.toc {{ position:sticky; top:0; z-index:20; background:rgba(13,17,23,.92); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border); padding:11px 0; margin:0 0 8px; }}
  nav.toc .wrap {{ padding-bottom:0; padding-top:0; display:flex; gap:6px; flex-wrap:wrap; }}
  nav.toc a {{ color:var(--muted); text-decoration:none; font-size:13px; padding:5px 11px; border-radius:7px; }}
  nav.toc a:hover {{ background:var(--panel2); color:var(--fg); }}

  section {{ margin:30px 0; }}
  .prose h2.sec {{ font-size:24px; margin:38px 0 12px; padding-top:10px; letter-spacing:-.01em; border-top:1px solid var(--border); }}
  .prose h2.sec:first-child {{ border-top:none; }}
  .prose h3 {{ font-size:18px; margin:24px 0 8px; color:#cdb8ff; }}
  .prose h4 {{ font-size:15px; margin:18px 0 6px; color:var(--prim-ok); }}
  .prose p {{ color:#d2dae4; }}
  .prose ul {{ margin:8px 0 14px; padding-left:22px; }}
  .prose li {{ margin:5px 0; color:#d2dae4; }}
  .prose ul.ol {{ list-style:decimal; }}
  .callout {{ background:linear-gradient(180deg, rgba(163,113,247,.08), rgba(163,113,247,.02));
    border:1px solid #34304a; border-left:3px solid var(--accent); border-radius:10px; padding:14px 18px; margin:18px 0; }}

  /* explorer */
  .controls {{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:14px 0 8px;
    position:sticky; top:46px; z-index:15; background:rgba(13,17,23,.92); backdrop-filter:blur(6px); padding:10px 0; }}
  .controls input[type=search] {{ flex:1; min-width:220px; background:var(--panel); border:1px solid var(--border);
    color:var(--fg); padding:9px 13px; border-radius:9px; font-size:14px; }}
  .controls select {{ background:var(--panel); border:1px solid var(--border); color:var(--fg); padding:9px 11px; border-radius:9px; font-size:13px; }}
  .chips {{ display:flex; flex-wrap:wrap; gap:7px; margin:6px 0 4px; }}
  .chip {{ cursor:pointer; user-select:none; border:1px solid var(--border); background:var(--panel);
    color:var(--muted); padding:6px 12px; border-radius:20px; font-size:12.5px; display:inline-flex; gap:7px; align-items:center; }}
  .chip.active {{ color:#0d1117; font-weight:700; }}
  .chip[data-c=via-strata].active {{ background:var(--strata); border-color:var(--strata); }}
  .chip[data-c=primitive-correct].active {{ background:var(--prim-ok); border-color:var(--prim-ok); }}
  .chip[data-c=primitive-should-migrate].active {{ background:var(--prim-mig); border-color:var(--prim-mig); }}
  .chip[data-c=missing-should-add].active {{ background:var(--missing); border-color:var(--missing); }}
  .chip[data-c=missing-non-goal].active {{ background:var(--nongoal); border-color:var(--nongoal); }}
  .countline {{ color:var(--faint); font-size:13px; margin:4px 0 10px; }}

  .feat {{ border:1px solid var(--border); border-left-width:3px; border-radius:10px; background:var(--panel);
    margin:9px 0; overflow:hidden; }}
  .feat.via-strata {{ border-left-color:var(--strata); }}
  .feat.primitive-correct {{ border-left-color:var(--prim-ok); }}
  .feat.primitive-should-migrate {{ border-left-color:var(--prim-mig); }}
  .feat.missing-should-add {{ border-left-color:var(--missing); }}
  .feat.missing-non-goal {{ border-left-color:var(--nongoal); }}
  .feat summary {{ list-style:none; cursor:pointer; padding:13px 16px; display:flex; gap:12px; align-items:flex-start; }}
  .feat summary::-webkit-details-marker {{ display:none; }}
  .feat summary:hover {{ background:var(--panel2); }}
  .fsurface {{ font:13px ui-monospace,monospace; background:#11161f; border:1px solid var(--border); color:#9ad1ff;
    padding:3px 9px; border-radius:7px; white-space:nowrap; max-width:230px; overflow:hidden; text-overflow:ellipsis; flex-shrink:0; }}
  .fmain {{ flex:1; min-width:0; }}
  .fname {{ font-weight:650; font-size:15px; }}
  .ftags {{ margin-top:5px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }}
  .tag {{ font-size:11px; padding:2px 8px; border-radius:6px; border:1px solid var(--border); color:var(--muted); }}
  .tag.cls {{ color:#0d1117; font-weight:700; border:none; }}
  .tag.cls.via-strata {{ background:var(--strata); }}
  .tag.cls.primitive-correct {{ background:var(--prim-ok); }}
  .tag.cls.primitive-should-migrate {{ background:var(--prim-mig); }}
  .tag.cls.missing-should-add {{ background:var(--missing); }}
  .tag.cls.missing-non-goal {{ background:var(--nongoal); }}
  .tag.st-implemented {{ color:var(--strata); border-color:#1f4427; }}
  .tag.st-partial {{ color:var(--prim-mig); border-color:#4a3c14; }}
  .tag.st-stubbed {{ color:var(--missing); border-color:#4a2237; }}
  .tag.st-missing {{ color:var(--faint); }}
  .conf {{ font-size:11px; color:var(--faint); flex-shrink:0; }}
  .conf b.h {{ color:var(--strata); }} .conf b.m {{ color:var(--prim-mig); }} .conf b.l {{ color:var(--missing); }}
  .fbody {{ padding:2px 16px 16px 16px; border-top:1px solid var(--border); }}
  .frow {{ margin:11px 0; }}
  .frow .k {{ font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--faint); margin-bottom:3px; }}
  .frow .v {{ color:#d2dae4; font-size:14px; }}
  .frow.ev .v {{ font-family:ui-monospace,monospace; font-size:12.5px; color:#9ad1ff; }}
  .frow.verify {{ background:rgba(247,120,186,.07); border:1px solid #4a2237; border-radius:8px; padding:9px 12px; }}
  .frow.verify .k {{ color:var(--missing); }}
  .empty {{ text-align:center; color:var(--faint); padding:40px; }}

  footer {{ border-top:1px solid var(--border); margin-top:50px; padding:24px 0; color:var(--faint); font-size:13px; }}
  @media (max-width:880px) {{
    .tiles {{ grid-template-columns:repeat(2,1fr); }}
    .grid3 {{ grid-template-columns:1fr; }}
    h1 {{ font-size:28px; }}
  }}
</style>
</head>
<body>
<header class="hero">
  <div class="wrap" style="padding-bottom:0">
    <div class="eyebrow">Silicon Language · Architecture Audit</div>
    <h1>Strata vs. Primitive: a feature audit</h1>
    <p class="thesis">Silicon's bet is <b>syntax&nbsp;&ne;&nbsp;semantics</b>: operators and keywords are
    registered as <b>data</b> in <code>@stratum</code> files, not baked into the grammar. This audit
    classifies every language feature into one of three buckets — <b>implemented via Strata</b>,
    <b>should stay a compiler primitive</b>, or <b>not yet built but should be</b>.</p>
    <div class="meta">Generated <b>{GEN_DATE}</b> · {len(features)} features across {len(subsystems)} subsystems ·
    multi-agent inventory + adversarial citation verification ({corrections_total} corrections applied) ·
    branch <b>main</b></div>
    <div class="tiles">{metric_tiles}</div>
    <div class="distbar">{bar_segments}</div>
    <div class="legend">{legend}</div>
  </div>
</header>

<nav class="toc"><div class="wrap">
  <a href="#summary">Executive Summary</a>
  <a href="#buckets">The Three Buckets</a>
  <a href="#tensions">Tensions</a>
  <a href="#roadmap">Roadmap</a>
  <a href="#explorer">Feature Explorer ({len(features)})</a>
</div></nav>

<div class="wrap">

  <div class="grid3">
    <div class="card"><h4>By status</h4>{status_bars}</div>
    <div class="card"><h4>By subsystem</h4>{sub_bars}</div>
    <div class="card"><h4>By category</h4>{cat_bars}</div>
  </div>

  <section class="prose" id="summary">
  {synthesis_html}
  </section>

  <section id="explorer">
    <h2 class="sec">Feature Explorer</h2>
    <p style="color:var(--muted)">Every audited feature with its classification, status, location, and the
    evidence the verifier confirmed. Filter by bucket, subsystem, or search file paths &amp; names.
    Rows flagged with a pink note were <b>corrected during adversarial verification</b>.</p>

    <div class="controls">
      <input type="search" id="q" placeholder="Search name, surface, file path, recommendation…" autocomplete="off">
      <select id="subsel"><option value="">All subsystems</option>{sub_options}</select>
      <select id="stsel"><option value="">All statuses</option>
        <option value="implemented">implemented</option>
        <option value="partial">partial</option>
        <option value="stubbed">stubbed</option>
        <option value="missing">missing</option>
      </select>
    </div>
    <div class="chips" id="chips">
      <span class="chip active" data-c="all">All</span>
      <span class="chip active" data-c="via-strata"><i class="dot d-strata"></i>via Strata</span>
      <span class="chip active" data-c="primitive-correct"><i class="dot d-prim-ok"></i>primitive (keep)</span>
      <span class="chip active" data-c="primitive-should-migrate"><i class="dot d-prim-mig"></i>should migrate</span>
      <span class="chip active" data-c="missing-should-add"><i class="dot d-missing"></i>missing — add</span>
      <span class="chip active" data-c="missing-non-goal"><i class="dot d-nongoal"></i>non-goal</span>
    </div>
    <div class="countline" id="countline"></div>
    <div id="list"></div>
    <div class="empty" id="empty" style="display:none">No features match these filters.</div>
  </section>

</div>

<footer><div class="wrap" style="padding-bottom:0">
  Silicon (compiler: <b>Sigil</b>) · audit produced by a 15-agent verification workflow over
  <code>compiler/src/strata</code>, <code>compiler/src/ir/lower.ts</code>, <code>compiler/src/modules</code>,
  <code>docs/adr</code> and the stdlib. Classifications reflect repository state on {GEN_DATE};
  re-run the generator after the dissolution / FFI work lands.
</div></footer>

<script>
const DATA = {DATA_JSON};
const CLSLABEL = {{
  "via-strata":"via Strata","primitive-correct":"primitive (keep)",
  "primitive-should-migrate":"should migrate","missing-should-add":"missing — add","missing-non-goal":"non-goal"
}};
const SUBLABEL = {json.dumps(SUB_LABEL, ensure_ascii=False)};
const active = new Set(["via-strata","primitive-correct","primitive-should-migrate","missing-should-add","missing-non-goal"]);
const $ = s => document.querySelector(s);
const list = $("#list"), empty = $("#empty"), countline = $("#countline");

function confClass(c){{ return c==="high"?"h":c==="medium"?"m":"l"; }}

function render(){{
  const q = $("#q").value.trim().toLowerCase();
  const sub = $("#subsel").value, st = $("#stsel").value;
  let n = 0; const html = [];
  for(const f of DATA){{
    if(!active.has(f.cls)) continue;
    if(sub && f.sub !== sub) continue;
    if(st && f.status !== st) continue;
    if(q){{
      const hay = (f.name+" "+f.surface+" "+f.location+" "+f.how+" "+f.rec+" "+f.evidence+" "+f.category).toLowerCase();
      if(!hay.includes(q)) continue;
    }}
    n++;
    const verifyBlock = f.verify_h ? `<div class="frow verify"><div class="k">⚠ Corrected during verification</div><div class="v">${{f.verify_h}}</div></div>` : "";
    html.push(`<details class="feat ${{f.cls}}">
      <summary>
        <span class="fsurface">${{f.surface_h || "—"}}</span>
        <span class="fmain">
          <span class="fname">${{escapeHtml(f.name)}}</span>
          <span class="ftags">
            <span class="tag cls ${{f.cls}}">${{CLSLABEL[f.cls]}}</span>
            <span class="tag st-${{f.status}}">${{f.status}}</span>
            <span class="tag">${{escapeHtml(f.category)}}</span>
            <span class="tag">${{escapeHtml(SUBLABEL[f.sub]||f.sub)}}</span>
          </span>
        </span>
        <span class="conf">conf <b class="${{confClass(f.conf)}}">${{f.conf}}</b></span>
      </summary>
      <div class="fbody">
        <div class="frow"><div class="k">How it's implemented</div><div class="v">${{f.how_h}}</div></div>
        <div class="frow"><div class="k">Recommendation</div><div class="v">${{f.rec_h}}</div></div>
        <div class="frow"><div class="k">Location</div><div class="v">${{f.loc_h}}</div></div>
        <div class="frow ev"><div class="k">Evidence</div><div class="v">${{f.ev_h}}</div></div>
        ${{verifyBlock}}
      </div>
    </details>`);
  }}
  list.innerHTML = html.join("");
  empty.style.display = n ? "none" : "block";
  countline.textContent = `Showing ${{n}} of ${{DATA.length}} features`;
}}
function escapeHtml(s){{ const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }}

document.querySelectorAll("#chips .chip").forEach(chip=>{{
  chip.addEventListener("click",()=>{{
    const c = chip.dataset.c;
    if(c==="all"){{
      const allOn = active.size===5;
      active.clear();
      document.querySelectorAll("#chips .chip").forEach(ch=>{{
        if(ch.dataset.c==="all") return;
        if(!allOn){{ active.add(ch.dataset.c); ch.classList.add("active"); }}
        else {{ ch.classList.remove("active"); }}
      }});
      chip.classList.toggle("active", !allOn);
    }} else {{
      if(active.has(c)){{ active.delete(c); chip.classList.remove("active"); }}
      else {{ active.add(c); chip.classList.add("active"); }}
      $("#chips .chip[data-c=all]").classList.toggle("active", active.size===5);
    }}
    render();
  }});
}});
$("#q").addEventListener("input", render);
$("#subsel").addEventListener("change", render);
$("#stsel").addEventListener("change", render);
render();
</script>
</body>
</html>"""

open(OUT, "w").write(HTML)
print(f"wrote {OUT} ({len(HTML)} bytes, {len(features)} features)")
