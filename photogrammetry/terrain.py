"""A small, dependency-free TIN for explicitly captured ground-point snapshots."""
from datetime import datetime, timezone
from copy import deepcopy


def vertices_from_points(points):
    buckets = {}
    for point in points:
        x, y, z = point['xyz']
        key = (round(x, 5), round(y, 5))
        buckets.setdefault(key, []).append((x, y, z))
    return [[sum(p[j] for p in group) / len(group) for j in range(3)]
            for group in buckets.values()]


def delaunay(vertices):
    if len(vertices) < 3:
        raise ValueError('서로 다른 위치의 지면 점이 세 개 이상 필요합니다.')
    lo = [min(p[j] for p in vertices) for j in range(2)]
    scale = max(max(p[j] for p in vertices) - lo[j] for j in range(2))
    if scale <= 1e-9:
        raise ValueError('지면 점을 서로 떨어진 위치에 찍어주세요.')
    xy = [((p[0] - lo[0]) / scale, (p[1] - lo[1]) / scale) for p in vertices]
    n = len(xy)
    xy.extend([(-20, -20), (20, -20), (0, 20)])
    triangles = [(n, n + 1, n + 2)]

    def orient(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])

    def contains(triangle, p):
        a, b, c = [xy[i] for i in triangle]
        ax, ay = a[0]-p[0], a[1]-p[1]
        bx, by = b[0]-p[0], b[1]-p[1]
        cx, cy = c[0]-p[0], c[1]-p[1]
        determinant = ((ax*ax+ay*ay)*(bx*cy-by*cx)
                       - (bx*bx+by*by)*(ax*cy-ay*cx)
                       + (cx*cx+cy*cy)*(ax*by-ay*bx))
        return determinant * (1 if orient(a,b,c) > 0 else -1) > -1e-12

    for index in range(n):
        bad = {triangle for triangle in triangles if contains(triangle, xy[index])}
        edges = {}
        for a,b,c in bad:
            for edge in [(a,b), (b,c), (c,a)]:
                key = tuple(sorted(edge))
                edges[key] = edges.get(key, 0) + 1
        triangles = [triangle for triangle in triangles if triangle not in bad]
        for (a,b), count in edges.items():
            if count == 1 and abs(orient(xy[a],xy[b],xy[index])) > 1e-12:
                triangles.append((a,b,index) if orient(xy[a],xy[b],xy[index]) > 0 else (b,a,index))
    result = [list(t) for t in triangles if all(i < n for i in t)]
    if not result:
        raise ValueError('지면 점이 한 줄에 놓여 있습니다. 면을 이루도록 점을 더 찍어주세요.')
    return result


def build_terrain(points):
    source = deepcopy([p for p in points if p['kind'] == 'ground'])
    if len(source) > 3000:
        raise ValueError('지면 점이 너무 많습니다.')
    vertices = vertices_from_points(source)
    return dict(algorithm='tin-linear', source_points=source, vertices=vertices,
                triangles=delaunay(vertices),
                generated_at=datetime.now(timezone.utc).isoformat())


def validate_terrain(value, normalized_source):
    vertices = vertices_from_points(normalized_source)
    triangles = value.get('triangles')
    if len(vertices) < 3 or not isinstance(triangles, list) or not 1 <= len(triangles) <= 6000:
        raise ValueError('지형 모형 정보가 올바르지 않습니다.')
    for triangle in triangles:
        if (not isinstance(triangle,list) or len(triangle) != 3
                or any(type(i) is not int or not 0 <= i < len(vertices) for i in triangle)
                or len(set(triangle)) != 3):
            raise ValueError('지형의 삼각형 정보가 올바르지 않습니다.')
        a,b,c = [vertices[i] for i in triangle]
        if abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])) < 1e-10:
            raise ValueError('지형에 면적이 없는 삼각형이 포함되어 있습니다.')
    return dict(algorithm='tin-linear', source_points=normalized_source, vertices=vertices,
                triangles=triangles, generated_at=str(value.get('generated_at',''))[:50])
