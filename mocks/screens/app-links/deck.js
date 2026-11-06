/* Copied from mocks/deck-v3.html: icons and the status bar. */
const IC = {
  back:'<path d="M15 5l-7 7 7 7"/>',
  close:'<path d="M6 6l12 12M18 6L6 18"/>',
  mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3"/>',
  micoff:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3M4 4l16 16"/>',
  up:'<path d="M12 19V5M6 11l6-6 6 6"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  log:'<path d="M5 7h14M5 12h14M5 17h9"/>',
  chev:'<path d="M9 5l7 7-7 7"/>',
  lock:'<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  kbd:'<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  end:'<path d="M3 14.5c5-4.6 13-4.6 18 0l-2.2 2.3-3.3-1.4v-2.6c-2-.7-4-.7-6 0v2.6l-3.3 1.4z"/>',
  dumbbell:'<path d="M6.5 7.5v9M17.5 7.5v9M3.5 10v4M20.5 10v4M6.5 12h11"/>',
  sun:'<path d="M5 17a7 7 0 0114 0M2.5 17h19M12 4.5v2.5M5.4 8.4l1.7 1.7M18.6 8.4l-1.7 1.7"/>',
  cabin:'<path d="M3.5 11.5L12 4l8.5 7.5M6 10v9.5h12V10M10 19.5v-5h4v5"/>',
  pot:'<path d="M5 10h14v6a3 3 0 01-3 3H8a3 3 0 01-3-3zM3 10h18M9 6.5c0-1 1-1 1-2.5M14 6.5c0-1 1-1 1-2.5"/>',
  wrench:'<path d="M14.5 6.5a4 4 0 005.2 5.2L12 19.4a2.1 2.1 0 01-3-3l7.7-7.7z" transform="translate(-1 0)"/>',
  flash:'<path d="M9 3h6l-1.5 7H17l-7 11 1-8H8z"/>',
  cam:'<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  play:'<path class="f" d="M8 5.5v13l11-6.5z"/>',
  pausei:'<rect x="7" y="5.5" width="3.4" height="13" rx="1"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1"/>',
  chat:'<path d="M5 6h14a1 1 0 011 1v8a1 1 0 01-1 1h-7l-4 3.5V16H5a1 1 0 01-1-1V7a1 1 0 011-1z"/>',
  cpu:'<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  layers:'<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  expand:'<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  spark:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'
};
const FILLED = new Set(['play']);
const ico = (n, s=20) => `<i class="i" style="--s:${s}px"><svg viewBox="0 0 24 24" ${FILLED.has(n)?'class="f"':''}>${IC[n]}</svg></i>`;
const STATUS = `<span class="clock" data-act="index">2:12</span><span class="sbi">
 <svg width="18" height="12" viewBox="0 0 18 12" fill="#fff"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.500" width="3" height="6.500" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
 <svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="#fff" stroke-width="1.700" stroke-linecap="round"><path d="M1 4.200a11 11 0 0115 0M3.500 7a7.200 7.200 0 0110 0"/><circle cx="8.500" cy="10" r="1.300" fill="#fff" stroke="none"/></svg>
 <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.500" stroke="#fff" stroke-opacity=".4"/><rect x="2" y="2" width="16" height="9" rx="2" fill="#fff"/><path d="M25 4.500v4c.8-.3 1.500-1.100 1.500-2s-.7-1.700-1.500-2z" fill="#fff" fill-opacity=".45"/></svg></span>`;
