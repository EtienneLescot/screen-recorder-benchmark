/**
 * The page's visual language, in one place.
 *
 * Set out in the design system that accompanies this file: one accent, hairlines rather than
 * shadows, numbers in a monospace with tabular figures, and no colour that means anything
 * except the platform a number came from. Ranking is never colour-coded — bar length carries
 * the comparison, so a reader who cannot separate the two hues loses nothing but the platform.
 */
export const STYLE = `
  /* --ink-3 carries table headers, axis labels and the Bg-load column, all of it normal-size
     text. The values the design system named — #8b8880 and #6e6c67 — measure 3.36:1 and 3.63:1
     against their own ground, under the 4.5:1 WCAG AA threshold. These clear it on both paper
     and surface while staying a clear third tier below --ink-2. */
  :root{
    --paper:#faf9f6; --surface:#ffffff; --sunk:#f3f1ec;
    --ink:#17171a; --ink-2:#5c5a55; --ink-3:#757269;
    --line:#e3e0d8; --line-2:#cdc9bf;
    --accent:#33547f; --accent-soft:#e7ecf3;
    --warm:#8a6a3b; --warm-soft:#f2ece1;
    --mono:"IBM Plex Mono", ui-monospace, monospace;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --paper:#101011; --surface:#191a1c; --sunk:#1e1f21;
      --ink:#ecebe6; --ink-2:#9a9791; --ink-3:#858279;
      --line:#2a2b2d; --line-2:#3c3d40;
      --accent:#8fabd6; --accent-soft:#1c2431;
      --warm:#c9a273; --warm-soft:#2a2318;
    }
  }
  :root[data-theme="dark"]{
    --paper:#101011; --surface:#191a1c; --sunk:#1e1f21;
    --ink:#ecebe6; --ink-2:#9a9791; --ink-3:#858279;
    --line:#2a2b2d; --line-2:#3c3d40;
    --accent:#8fabd6; --accent-soft:#1c2431;
    --warm:#c9a273; --warm-soft:#2a2318;
  }
  *{box-sizing:border-box}
  [hidden]{display:none !important}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:400 17px/1.6 Newsreader,Georgia,serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  a{color:var(--accent);text-underline-offset:.18em;text-decoration-thickness:.06em}
  a:hover{color:var(--ink)}
  ::selection{background:var(--accent-soft);color:var(--ink)}
  select,button{font:inherit;color:inherit}
  code{font-family:var(--mono);font-size:.86em}
  .page{max-width:78rem;margin:0 auto;padding:clamp(20px,4vw,48px) clamp(16px,4vw,44px) 96px}

  .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
    flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px}
  .brand{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--ink-3);display:flex;gap:14px;flex-wrap:wrap;padding-top:6px}
  .brand b{font-weight:400;color:var(--ink-2)}
  .btn{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
    background:transparent;border:1px solid var(--line-2);border-radius:2px;padding:6px 10px;
    cursor:pointer;color:var(--ink-2)}
  .btn:hover{border-color:var(--ink-3);color:var(--ink)}

  .hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));
    gap:clamp(20px,3vw,48px);padding:clamp(18px,2.6vw,30px) 0 clamp(16px,2vw,26px);
    border-bottom:1px solid var(--line)}
  h1{margin:0 0 12px;font-weight:500;font-size:clamp(1.9rem,3.4vw,2.7rem);line-height:1.05;
    letter-spacing:-.025em;text-wrap:balance}
  .hero-lede{margin:0;font-size:clamp(1rem,1.2vw,1.08rem);line-height:1.5;color:var(--ink-2);
    max-width:52ch;text-wrap:pretty}
  .hero-side{display:flex;flex-direction:column;justify-content:flex-end;gap:10px}
  /* Hairlines drawn by the cells, not by a coloured gap behind them: a row that does not fill
     its last track would otherwise paint the leftover as one solid block of --line. */
  .stats,.cards{background:var(--paper);border:1px solid var(--line);overflow:hidden}
  .stats>div,.cards>div{box-shadow:1px 0 0 var(--line),0 1px 0 var(--line)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr))}
  .stats div{padding:9px 12px}
  .stats b{display:block;font-family:var(--mono);font-size:19px;font-weight:500;line-height:1;
    letter-spacing:-.02em}
  .stats span{display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;
    text-transform:uppercase;color:var(--ink-3);margin-top:6px}
  .stamp{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;color:var(--ink-3)}

  section{padding:clamp(44px,6vw,72px) 0 0}
  section.lead-section{padding-top:clamp(20px,2.8vw,30px)}
  .sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;
    flex-wrap:wrap;margin-bottom:10px}
  h2{margin:0;font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.16em;
    text-transform:uppercase;color:var(--ink-3)}
  .sec-note{font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--ink-3)}
  .prose{margin:0 0 30px;font-size:1rem;line-height:1.6;color:var(--ink-2);max-width:66ch;
    text-wrap:pretty}
  .prose strong{color:var(--ink);font-weight:600}
  .mono-note{margin:14px 0 0;font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;
    line-height:1.6;color:var(--ink-3)}

  .lead-line{margin:0 0 16px;font-size:clamp(1.15rem,1.9vw,1.5rem);line-height:1.3;
    letter-spacing:-.015em;max-width:40ch;text-wrap:pretty}
  .lead-line strong{font-weight:600}
  .scopes{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin:0 0 12px;
    padding-top:6px;border-top:1px solid var(--line)}
  .scope-group{display:flex;align-items:center;gap:10px}
  .scope-group>span{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;
    text-transform:uppercase;color:var(--ink-3)}
  .scope-btn{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
    padding:6px 11px;border-radius:2px;cursor:pointer;background:transparent;
    border:1px solid var(--line-2);color:var(--ink-3)}
  .scope-btn:hover{border-color:var(--ink-3);color:var(--ink-2)}
  .scope-btn[aria-pressed="true"]{border-color:var(--ink);color:var(--ink);font-weight:600}
  .scope-note{margin:0 0 18px;font-family:var(--mono);font-size:10.5px;line-height:1.6;
    letter-spacing:.02em;color:var(--ink-3);max-width:84ch}

  .aside{border:1px solid var(--line);border-left:2px solid var(--warm);background:var(--surface);
    padding:18px 20px}
  .aside p.lead{margin:0 0 8px;font-size:1.02rem;line-height:1.5}
  .aside p.fine{margin:0;font-size:.9rem;line-height:1.6;color:var(--ink-2);max-width:80ch;
    text-wrap:pretty}
  .aside.empty{padding:20px 22px}
  .aside.empty p.lead{font-size:1.1rem;line-height:1.45;font-weight:600}
  .aside.after{margin-top:26px}
  .aside.before{margin:24px 0 0}

  .chart{border-top:1px solid var(--ink)}
  .chart-axis{position:relative;height:22px}
  .chart-axis span{position:absolute;bottom:2px;font-family:var(--mono);font-size:10px;
    letter-spacing:.08em;color:var(--ink-3);white-space:nowrap}
  /* Narrow enough and the interior ticks land under the floor label. Floor and ceiling are the
     two that have to survive; the rest are a convenience. */
  @media (max-width:620px){.chart-axis .tick:not(.top){display:none}}
  .rank-row{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;padding:22px 0 24px;
    border-bottom:1px solid var(--line)}
  .rank-head{display:flex;align-items:baseline;gap:clamp(12px,2vw,26px);flex-wrap:wrap}
  .rank-no{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.1em;
    color:var(--ink-3);width:26px}
  .rank-row h3{margin:0;font-size:clamp(1.6rem,2.6vw,2.1rem);font-weight:500;
    letter-spacing:-.02em}
  .tag{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--warm);border:1px solid var(--warm);border-radius:2px;padding:3px 6px}
  .rank-val{margin-left:auto;display:flex;align-items:baseline;gap:6px}
  .rank-val b{font-family:var(--mono);font-size:clamp(2rem,4vw,3rem);font-weight:500;
    line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
  .rank-val span{font-family:var(--mono);font-size:16px;color:var(--ink-3)}
  .rank-track{position:relative;height:12px;background:var(--sunk);border:1px solid var(--line)}
  .rank-track i{position:absolute;left:0;top:0;bottom:0;background:var(--ink-2)}
  .rank-track i.thin{background:repeating-linear-gradient(45deg,
    var(--ink-2) 0 5px,var(--line-2) 5px 10px)}
  .chart-foot{margin:0;padding:14px 0 0;font-family:var(--mono);font-size:10.5px;line-height:1.6;
    letter-spacing:.02em;color:var(--ink-3)}

  .tri{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
    gap:clamp(18px,3vw,40px);margin-top:30px;padding-top:26px;border-top:1px solid var(--line)}
  .tri p{margin:0;font-size:.98rem;line-height:1.6;color:var(--ink-2);text-wrap:pretty}
  .tri strong{color:var(--ink);font-weight:600}
  .tri.tight{margin-top:22px;padding-top:0;border-top:0;gap:clamp(16px,3vw,36px)}
  .tri.tight p{font-size:.9rem}

  .legend{display:flex;gap:16px;flex-wrap:wrap;font-family:var(--mono);font-size:11px;
    color:var(--ink-2)}
  .legend span{display:inline-flex;align-items:center;gap:6px}
  .legend i{width:9px;height:9px;border-radius:50%;display:inline-block}

  .strip-wrap{overflow-x:auto;padding-bottom:4px}
  .strip{position:relative;min-width:640px}
  .strip-grid{position:absolute;left:132px;right:0;top:0;bottom:26px;pointer-events:none}
  .strip-grid i{position:absolute;top:0;bottom:0;width:1px;background:var(--line)}
  .strip-grid i.floor{background:var(--line-2)}
  .strip-head,.strip-foot{display:grid;grid-template-columns:132px 1fr;height:26px}
  .strip-head>div:last-child,.strip-foot>div:last-child{position:relative;height:100%}
  .floor-tag{position:absolute;top:2px;transform:translateX(7px);font-family:var(--mono);
    font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);
    white-space:nowrap}
  .strip-rows{border-bottom:1px solid var(--line)}
  .strip-row{display:grid;grid-template-columns:132px 1fr;align-items:center;
    border-top:1px solid var(--line)}
  .strip-name{font-family:var(--mono);font-size:13px;font-weight:500;padding-right:16px;
    text-align:right}
  .strip-lane{position:relative;height:54px}
  .strip-lane .rng{position:absolute;top:50%;height:3px;transform:translateY(-50%);
    background:var(--line-2)}
  .strip-lane .dot{position:absolute;top:50%;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;
    border-radius:50%;border:1.5px solid var(--paper)}
  .strip-foot span{position:absolute;top:6px;transform:translateX(-50%);font-family:var(--mono);
    font-size:10.5px;color:var(--ink-3)}

  .filters{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:0 0 14px;
    font-family:var(--mono);font-size:11.5px}
  .filters label{display:flex;gap:8px;align-items:center;color:var(--ink-3);letter-spacing:.08em;
    text-transform:uppercase;font-size:10px}
  .filters select{font-family:var(--mono);font-size:11.5px;text-transform:none;letter-spacing:0;
    color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:2px;
    padding:5px 7px}

  .tw{overflow-x:auto;border-top:1px solid var(--ink)}
  .tw.ruled{border-bottom:1px solid var(--line)}
  table{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12px}
  #runs{min-width:1000px}
  .tw.narrow table{min-width:420px}
  th{text-align:left;padding:10px 12px;font-size:9.5px;font-weight:600;letter-spacing:.12em;
    text-transform:uppercase;color:var(--ink-3);border-bottom:1px solid var(--line);
    white-space:nowrap}
  td{padding:9px 12px;border-bottom:1px solid var(--line)}
  th:first-child,td:first-child{padding-left:0}
  th:last-child,td:last-child{padding-right:0}
  th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
  th.mid,td.mid{text-align:center}
  td strong{font-weight:600}
  .dim{color:var(--ink-3)}
  .nw{white-space:nowrap}
  .mark{display:inline-block;width:7px;height:7px;background:var(--ink)}
  .deg{color:var(--warm);font-size:10px;letter-spacing:.06em}
  .cites{margin:12px 0 0;padding-left:1.1rem;font-size:.85rem;line-height:1.55;color:var(--ink-3)}
  .cites strong{color:var(--ink-2);font-weight:600}

  .duo{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));
    gap:clamp(28px,4vw,56px)}
  .duo .prose{margin:0 0 18px;font-size:.95rem;max-width:48ch}

  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));margin-top:18px}
  .cards>div{padding:20px 22px}
  .cards h3{margin:0 0 10px;font-family:var(--mono);font-size:10px;font-weight:600;
    letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
  .cards p{margin:0;font-size:.95rem;line-height:1.6;color:var(--ink-2);text-wrap:pretty}

  .cta{margin-top:clamp(44px,6vw,72px);border:1px solid var(--line);background:var(--surface);
    padding:clamp(24px,3vw,36px)}
  .cta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));
    gap:clamp(24px,4vw,48px);align-items:start}
  .cta h2{margin-bottom:12px}
  .cta-lead{margin:0 0 16px;font-size:1.15rem;line-height:1.45;letter-spacing:-.01em;
    max-width:34ch;text-wrap:pretty}
  .cmd{font-family:var(--mono);font-size:12.5px;background:var(--sunk);
    border:1px solid var(--line);padding:10px 12px;overflow-x:auto;white-space:nowrap}
  .steps{margin:0;padding:0;list-style:none;display:grid;gap:14px}
  .steps li{display:grid;grid-template-columns:26px 1fr;gap:12px;align-items:baseline}
  .steps b{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--ink-3)}
  .steps span{font-size:.95rem;line-height:1.55;color:var(--ink-2)}

  footer{margin-top:clamp(40px,5vw,64px);padding-top:18px;border-top:1px solid var(--line);
    display:flex;gap:clamp(14px,3vw,32px);flex-wrap:wrap;align-items:baseline;
    font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
  footer .end{margin-left:auto}
`;
