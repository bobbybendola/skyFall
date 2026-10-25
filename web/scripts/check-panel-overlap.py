"""Layout check: no two globe panels (or Cesium's clock/timeline/toolbar) overlap.

Opens the globe at 1600, 1280, 900 and 390 (phone) px wide, optionally selects an
object from the debris list, and measures each panel's visible box (clipped to the
scrolling panel column). Exits 1 if any two overlap. Needs Python Playwright:
  pip install playwright && playwright install chromium
  python scripts/check-panel-overlap.py http://127.0.0.1:5173/ [object-name] [--shots DIR]
"""
import sys, time
from playwright.sync_api import sync_playwright

PANELS = ('.globe-hud,.globe-debris-list,.globe-legend,.globe-map-controls,.globe-info,.sat-model,'
          '.debris-toggle,.cesium-viewer-animationContainer,.cesium-viewer-timelineContainer,.cesium-viewer-toolbar')
SIZES = [(1600, 900, 'desktop'), (1280, 800, '1280'), (900, 700, '900'), (390, 844, 'phone')]
BOXES = """(q) => {
  const dock = document.querySelector('.globe-docks')?.getBoundingClientRect();
  return [...document.querySelectorAll(q)].filter(e => e.offsetWidth > 0).map(e => {
    let r = e.getBoundingClientRect(), b = [r.left, r.top, r.right, r.bottom];
    if (dock && e.closest('.globe-docks')) b = [Math.max(b[0], dock.left), Math.max(b[1], dock.top), Math.min(b[2], dock.right), Math.min(b[3], dock.bottom)];
    return [e.className.toString().split(' ')[0], ...b];
  }).filter(b => b[3] > b[1] && b[4] > b[2]);
}"""

def main():
    args = sys.argv[1:]
    shots = None
    if '--shots' in args:
        i = args.index('--shots'); shots = args[i + 1]; del args[i:i + 2]
    url, pick = args[0], (args[1] if len(args) > 1 else None)
    bad = 0
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--enable-gpu', '--use-angle=gl-egl', '--ignore-gpu-blocklist'])
        for w, h, tag in SIZES:
            phone = tag == 'phone'
            ctx = b.new_context(viewport={'width': w, 'height': h}, is_mobile=phone, has_touch=phone)
            pg = ctx.new_page(); pg.set_default_timeout(90000)
            pg.add_init_script('try { localStorage.clear() } catch (e) {}')  # default open/closed panels
            pg.goto(url, wait_until='domcontentloaded'); pg.wait_for_selector('.globe-legend'); time.sleep(8)
            if pick:
                if pg.query_selector('.globe-debris-list .panel-title[aria-expanded=false]'):
                    pg.click('.globe-debris-list .panel-title'); time.sleep(0.5)
                row = next((x for x in pg.query_selector_all('.globe-debris-list button') if x.inner_text().startswith(pick)), None)
                if not row:
                    print(f'{tag}: "{pick}" not in the debris list'); bad += 1
                else:
                    row.click(); time.sleep(5)
            if shots: pg.screenshot(path=f'{shots}/{tag}{"-sel" if pick else ""}.png')
            r = pg.evaluate(BOXES, PANELS)
            if pg.evaluate('document.documentElement.scrollWidth') > w:
                print(f'{tag}: page scrolls sideways'); bad += 1
            for i in range(len(r)):
                for j in range(i + 1, len(r)):
                    a, c = r[i], r[j]
                    ox = min(a[3], c[3]) - max(a[1], c[1]); oy = min(a[4], c[4]) - max(a[2], c[2])
                    if ox > 1 and oy > 1:
                        bad += 1; print(f'{tag}: {a[0]} overlaps {c[0]} ({round(ox)}x{round(oy)} px)')
            print(f'{tag}: {len(r)} panels checked')
            ctx.close()
        b.close()
    print('overlaps:', bad)
    sys.exit(1 if bad else 0)

main()
