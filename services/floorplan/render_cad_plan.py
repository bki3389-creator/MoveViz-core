#!/usr/bin/env python3
"""render_cad_plan.py — v4 평면 JSON → 실제 건축 평면도(SVG).

폴리캠/CAD 도면 관습대로:
  - 벽: 200mm 고정 두께 이중선(채운 벽 밴드). (인테리어라 외벽 실측 무의미 → 200mm 고정)
  - 문: 벽 끊고 문짝 + 스윙 호(arc)
  - 창: 벽 끊고 3평행선(유리) + 양 끝 jamb
  - 치수: 외곽 변마다 치수선(연장선·길이)
입력: run_v4.py 의 출력 JSON. 출력: SVG.
사용: python render_cad_plan.py v4_out.json -o plan.svg
"""
import json, argparse, math
from shapely.geometry import Polygon, box, Point
from shapely.ops import unary_union

WALL_T = 0.20   # 벽 두께 200mm 고정


def _poly_path(geom, T):
    """shapely Polygon/MultiPolygon → SVG path d (구멍은 evenodd)."""
    polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    d = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            pts = list(ring.coords)
            d.append("M " + " L ".join(f"{T(x,z)[0]:.1f},{T(x,z)[1]:.1f}" for x, z in pts) + " Z")
    return " ".join(d)


def _furniture_symbol(f, poly, T):
    """카테고리별 톱뷰 평면 심볼(축정렬 bbox 기준). 박스 대신 가구처럼 보이게."""
    xs = [p[0] for p in poly]; zs = [p[1] for p in poly]
    x0, x1 = min(xs), max(xs); z0, z1 = min(zs), max(zs)
    cat = f.get("category", "unknown"); ko = f.get("category_ko", "")
    long_x = (x1 - x0) >= (z1 - z0)
    FILL = "#efece3"; LN = "#9b9482"; s = []

    def rect(a, b, c, d, fill=FILL, st=LN, w=1.2, rx=0):
        (px0, py0), (px1, py1) = T(a, b), T(c, d)
        return (f'<rect x="{min(px0,px1):.1f}" y="{min(py0,py1):.1f}" '
                f'width="{abs(px1-px0):.1f}" height="{abs(py1-py0):.1f}" rx="{rx}" '
                f'fill="{fill}" stroke="{st}" stroke-width="{w}"/>')
    def line(a, b, c, d, w=1.2, st=LN):
        (px0, py0), (px1, py1) = T(a, b), T(c, d)
        return f'<line x1="{px0:.1f}" y1="{py0:.1f}" x2="{px1:.1f}" y2="{py1:.1f}" stroke="{st}" stroke-width="{w}"/>'
    def circle(cx, cz, r, fill="none", st=LN, w=1.2):
        (px, py) = T(cx, cz); rp = abs(T(cx+r, cz)[0]-px)
        return f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{rp:.1f}" fill="{fill}" stroke="{st}" stroke-width="{w}"/>'
    def ell(cx, cz, rx, rz, fill="none", st=LN, w=1.2):
        (px, py) = T(cx, cz); rpx = abs(T(cx+rx, cz)[0]-px); rpy = abs(T(cx, cz+rz)[1]-py)
        return (f'<ellipse cx="{px:.1f}" cy="{py:.1f}" rx="{rpx:.1f}" ry="{rpy:.1f}" '
                f'fill="{fill}" stroke="{st}" stroke-width="{w}"/>')

    s.append(rect(x0, z0, x1, z1, rx=2))
    inset = 0.06
    if cat == "bed":
        # 베개 띠(머리쪽 = 짧은변 한쪽) + 이불 라인
        if long_x:
            s.append(rect(x0+inset, z0+inset, x0+(x1-x0)*0.22, z1-inset, fill="#e3ddcd"))
        else:
            s.append(rect(x0+inset, z0+inset, x1-inset, z0+(z1-z0)*0.22, fill="#e3ddcd"))
    elif cat == "sofa":
        # 등받이 띠(긴변 한쪽) + 쿠션 분할
        t = 0.12
        if long_x:
            s.append(rect(x0, z0, x1, z0+t, fill="#e3ddcd"))
            for k in (0.33, 0.66): s.append(line(x0+(x1-x0)*k, z0+t, x0+(x1-x0)*k, z1))
        else:
            s.append(rect(x0, z0, x0+t, z1, fill="#e3ddcd"))
            for k in (0.33, 0.66): s.append(line(x0+t, z0+(z1-z0)*k, x1, z0+(z1-z0)*k))
    elif cat in ("table", "desk"):
        s.append(rect(x0+0.1, z0+0.1, x1-0.1, z1-0.1, fill="none"))  # 천판 이중선
    elif cat == "chair":
        s[-1] = rect(x0, z0, x1, z1, rx=4)  # 둥근 의자
    elif cat in ("wardrobe", "shelf", "storage", "cabinet", "rack"):
        if long_x:
            for k in (0.33, 0.66): s.append(line(x0+(x1-x0)*k, z0, x0+(x1-x0)*k, z1, w=0.8))  # 선반칸
        else:
            for k in (0.33, 0.66): s.append(line(x0, z0+(z1-z0)*k, x1, z0+(z1-z0)*k, w=0.8))
    elif cat in ("fridge", "refrigerator"):
        s.append(line(x0, (z0+z1)/2, x1, (z0+z1)/2))  # 양문 분할
    elif cat in ("washer", "appliance"):
        s.append(circle((x0+x1)/2, (z0+z1)/2, min(x1-x0, z1-z0)*0.32))
    elif cat in ("tv", "monitor"):
        s.append(rect(x0+0.03, z0+0.03, x1-0.03, z1-0.03, fill="#cfc8b8"))  # 화면
    elif cat == "toilet":
        cx = (x0+x1)/2; cz = (z0+z1)/2
        if long_x:   # 길이축 X: 물탱크 왼쪽, 보울 오른쪽
            s.append(rect(x0, z0, x0+(x1-x0)*0.30, z1, fill="#e3ddcd"))
            s.append(ell(x0+(x1-x0)*0.64, cz, (x1-x0)*0.30, (z1-z0)*0.42))
        else:
            s.append(rect(x0, z0, x1, z0+(z1-z0)*0.30, fill="#e3ddcd"))
            s.append(ell(cx, z0+(z1-z0)*0.64, (x1-x0)*0.42, (z1-z0)*0.30))
    elif cat == "sink":
        s.append(ell((x0+x1)/2, (z0+z1)/2, (x1-x0)*0.36, (z1-z0)*0.32))  # 세면 분지
    elif cat == "bathtub":
        s.append(rect(x0+0.06, z0+0.06, x1-0.06, z1-0.06, fill="none", rx=6))  # 내측 욕조면
    # counter/plant 등 → 외곽 박스만
    # 라벨
    if ko and ko != "가구":
        tx, ty = T((x0+x1)/2, (z0+z1)/2)
        s.append(f'<text x="{tx:.1f}" y="{ty+3:.1f}" font-size="10.5" fill="#8a8474" text-anchor="middle">{ko}</text>')
    return "".join(s)


def render(data, out_svg, wall_t=WALL_T):
    b = data["boundary"][:]
    if b[0] != b[-1]:
        b = b + [b[0]]
    poly = Polygon(b)
    if not poly.is_valid:
        poly = poly.buffer(0)
    cen = poly.representative_point()
    half = wall_t / 2
    outer = poly.buffer(half, join_style="mitre", mitre_limit=6)
    inner = poly.buffer(-half, join_style="mitre", mitre_limit=6)
    wall = outer.difference(inner)

    # 개구부 사각형(벽을 끊음)
    rects = []
    for o in data["openings"]:
        lo, hi = o["span"]; pos = o["wall_pos"]
        if o["wall_dir"] == "x":
            rects.append(box(pos - wall_t, lo, pos + wall_t, hi))
        else:
            rects.append(box(lo, pos - wall_t, hi, pos + wall_t))
    cut = unary_union(rects) if rects else None
    wall_cut = wall.difference(cut) if cut else wall

    # 좌표 변환
    minx, minz, maxx, maxz = outer.bounds
    M = 1.4  # 치수 여백(m)
    minx -= M; minz -= M; maxx += M; maxz += M
    S = 900.0 / max(maxx - minx, maxz - minz)  # px/m
    W = int((maxx - minx) * S); H = int((maxz - minz) * S)
    def T(x, z): return ((x - minx) * S, (z - minz) * S)

    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}" font-family="Helvetica,Arial,sans-serif">']
    svg.append(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')

    # 방 채움(아주 옅게)
    for r in data.get("rooms", []):
        rp = r.get("polygon")
        if rp and len(rp) >= 3:
            pts = " ".join(f"{T(x,z)[0]:.1f},{T(x,z)[1]:.1f}" for x, z in rp)
            svg.append(f'<polygon points="{pts}" fill="#f3efe7" stroke="none"/>')

    # 가구 — 톱뷰 건축 심볼(카테고리별)
    for f in data.get("furniture", []):
        poly_f = f.get("obb") or f.get("polygon")
        if not (poly_f and len(poly_f) >= 4):
            continue
        svg.append(_furniture_symbol(f, poly_f, T))

    # 벽(채운 밴드 = 이중선 효과)
    svg.append(f'<path d="{_poly_path(wall_cut, T)}" fill="#2b2b33" fill-rule="evenodd" stroke="none"/>')

    # 개구부 심볼
    for o in data["openings"]:
        lo, hi = o["span"]; pos = o["wall_pos"]; w = o["width"]
        if o["wall_dir"] == "x":     # 벽이 z 방향으로 진행, x=pos 고정
            p0 = (pos, lo); p1 = (pos, hi); t = (0.0, 1.0)
        else:                         # 벽이 x 방향, z=pos 고정
            p0 = (lo, pos); p1 = (hi, pos); t = (1.0, 0.0)
        # 안쪽(interior) 법선 결정
        n1 = (-t[1], t[0]); n2 = (t[1], -t[0])
        cx, cz = (p0[0]+p1[0])/2, (p0[1]+p1[1])/2
        n = n1 if poly.contains(Point(cx + n1[0]*0.12, cz + n1[1]*0.12)) else n2

        if o["type"] == "door":
            # 문짝(열린 상태) + 스윙 호
            hinge = p0
            popen = (hinge[0] + n[0]*w, hinge[1] + n[1]*w)
            x1, y1 = T(*hinge); x2, y2 = T(*popen)
            svg.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#2b2b33" stroke-width="2"/>')
            # 호: 닫힘(p1 방향) → 열림(n 방향)
            a0 = math.atan2(p1[1]-hinge[1], p1[0]-hinge[0])
            a1 = math.atan2(n[1], n[0])
            d = a1 - a0
            while d > math.pi: d -= 2*math.pi
            while d < -math.pi: d += 2*math.pi
            pts = []
            for i in range(25):
                a = a0 + d*i/24
                px, py = T(hinge[0]+w*math.cos(a), hinge[1]+w*math.sin(a))
                pts.append(f"{px:.1f},{py:.1f}")
            svg.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#9a9a9a" stroke-width="1.2"/>')
        else:  # window / lintel → 창 심볼(3평행선 + jamb)
            for off in (-half, 0.0, half):
                a = (p0[0]+n[0]*off, p0[1]+n[1]*off)
                bb = (p1[0]+n[0]*off, p1[1]+n[1]*off)
                x1, y1 = T(*a); x2, y2 = T(*bb)
                wdt = 2 if off == 0.0 else 1.4
                svg.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#3a6ea5" stroke-width="{wdt}"/>')
            for endp in (p0, p1):  # jamb
                a = (endp[0]-n[0]*half, endp[1]-n[1]*half)
                bb = (endp[0]+n[0]*half, endp[1]+n[1]*half)
                x1, y1 = T(*a); x2, y2 = T(*bb)
                svg.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#2b2b33" stroke-width="1.6"/>')

    # 치수선(외곽 변)
    cxp, czp = poly.centroid.x, poly.centroid.y
    for i in range(len(b)-1):
        a = b[i]; c = b[i+1]
        L = math.hypot(c[0]-a[0], c[1]-a[1])
        if L < 0.5: continue
        tx, tz = (c[0]-a[0])/L, (c[1]-a[1])/L
        nx, nz = -tz, tx
        # 바깥쪽으로
        mx, mz = (a[0]+c[0])/2, (a[1]+c[1])/2
        if (nx*(mx-cxp) + nz*(mz-czp)) < 0: nx, nz = -nx, -nz
        off = 0.55
        a2 = (a[0]+nx*off, a[1]+nz*off); c2 = (c[0]+nx*off, c[1]+nz*off)
        for p, q in [(a, a2), (c, c2)]:  # 연장선
            x1, y1 = T(*p); x2, y2 = T(*q)
            svg.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#bbb" stroke-width="0.8"/>')
        x1, y1 = T(*a2); x2, y2 = T(*c2)
        svg.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#888" stroke-width="0.8"/>')
        tmx, tmy = T((a2[0]+c2[0])/2, (a2[1]+c2[1])/2)
        ang = math.degrees(math.atan2(y2-y1, x2-x1))
        if ang > 90 or ang < -90: ang += 180
        svg.append(f'<text x="{tmx:.1f}" y="{tmy-3:.1f}" font-size="13" fill="#444" '
                   f'text-anchor="middle" transform="rotate({ang:.1f} {tmx:.1f} {tmy:.1f})">{L:.2f}</text>')

    # 제목 · 면적 · 스케일바
    xs = [p[0] for p in data["boundary"]]; zs = [p[1] for p in data["boundary"]]
    area = 0.5*abs(sum(xs[i]*zs[i+1]-xs[i+1]*zs[i] for i in range(len(xs)-1)))
    svg.append(f'<text x="{W/2:.0f}" y="34" font-size="22" font-weight="700" fill="#222" text-anchor="middle">Floor Plan</text>')
    svg.append(f'<text x="{W/2:.0f}" y="56" font-size="13" fill="#777" text-anchor="middle">'
               f'~{area:.1f} m² ({area/3.3058:.1f} 평) · walls 200mm · doors {sum(1 for o in data["openings"] if o["type"]=="door")} · windows {sum(1 for o in data["openings"] if o["type"]!="door")}</text>')
    sb = S*1.0
    svg.append(f'<line x1="40" y1="{H-30}" x2="{40+sb:.0f}" y2="{H-30}" stroke="#222" stroke-width="2.5"/>')
    svg.append(f'<text x="{40+sb+8:.0f}" y="{H-25}" font-size="12" fill="#222">1 m</text>')
    svg.append("</svg>")
    open(out_svg, "w").write("\n".join(svg))
    return out_svg, area


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("json")
    ap.add_argument("-o", "--out", default="cad_plan.svg")
    ap.add_argument("--wall", type=float, default=WALL_T)
    a = ap.parse_args()
    out, area = render(json.load(open(a.json)), a.out, a.wall)
    print(f"저장: {out}  면적 {area:.1f}m² 벽 {a.wall*1000:.0f}mm")
