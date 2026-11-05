"""Small, dependency-free stereo measurement engine.

World coordinates: E, N, H (metres, H upwards).
Photo frame: x right, y up, viewing direction -z.
Camera-to-world: Rx(omega) Ry(phi) Rz(kappa); angles in degrees.
Pixels: continuous coordinates from the top-left image edge, centres at .5.
The supplied undistorted images are used without further lens correction.
"""
import csv
import hashlib
import json
import math
import re
from pathlib import Path


def add(a, b): return [x + y for x, y in zip(a, b)]
def sub(a, b): return [x - y for x, y in zip(a, b)]
def mul(a, k): return [x * k for x in a]
def dot(a, b): return sum(x * y for x, y in zip(a, b))
def norm(a): return math.sqrt(dot(a, a))
def unit(a): return mul(a, 1 / norm(a))
def transpose(a): return [list(x) for x in zip(*a)]
def mm(a, b): return [[dot(row, col) for col in zip(*b)] for row in a]
def mv(a, b): return [dot(row, b) for row in a]


def rotation(omega, phi, kappa):
    w, p, k = map(math.radians, (omega, phi, kappa))
    c, s = math.cos, math.sin
    rx = [[1, 0, 0], [0, c(w), -s(w)], [0, s(w), c(w)]]
    ry = [[c(p), 0, s(p)], [0, 1, 0], [-s(p), 0, c(p)]]
    rz = [[c(k), -s(k), 0], [s(k), c(k), 0], [0, 0, 1]]
    return mm(mm(rx, ry), rz)


def solve3(a, b):
    """Pivoted elimination for the three-variable refinement."""
    m = [list(row) + [v] for row, v in zip(a, b)]
    for j in range(3):
        pivot = max(range(j, 3), key=lambda i: abs(m[i][j]))
        if abs(m[pivot][j]) < 1e-15:
            raise ValueError('광선의 교차 조건이 불안정합니다. 다른 사진 쌍을 선택하세요.')
        m[j], m[pivot] = m[pivot], m[j]
        scale = m[j][j]
        m[j] = [v / scale for v in m[j]]
        for i in range(3):
            if i != j:
                f = m[i][j]
                m[i] = [x - f * y for x, y in zip(m[i], m[j])]
    return [m[i][3] for i in range(3)]


class Project:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.settings = json.loads((self.root / 'project.json').read_text(encoding='utf-8-sig'))
        self.folder = (self.root / self.settings['data_directory']).resolve()
        if not self.folder.is_relative_to(self.root):
            raise ValueError('자료 폴더는 작업 폴더 안에 있어야 합니다.')
        camera = {}
        for line in (self.folder / 'cam.txt').read_text(encoding='utf-8-sig').splitlines():
            if ':' in line:
                key, value = line.split(':', 1)
                found = re.search(r'[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?', value)
                if found:
                    camera[key.strip()] = float(found[0])
        self.width, self.height = int(camera['image_size_x']), int(camera['image_size_y'])
        self.focal_mm, self.pixel_mm = camera['focal_length'], camera['pixel_size']
        self.f = self.focal_mm / self.pixel_mm
        if min(self.width, self.height, self.f) <= 0:
            raise ValueError('카메라 수치가 올바르지 않습니다.')
        pp = self.settings.get('principal_point')
        self.cx, self.cy = pp if pp is not None else (self.width / 2, self.height / 2)
        if not self.settings.get('images_undistorted'):
            raise ValueError('이 버전은 왜곡보정 영상과 그에 맞는 내부표정요소를 사용합니다.')
        if self.settings['pose_convention'] != 'camera_to_world_RxRyRz':
            raise ValueError('설정된 자세각 정의는 지원하지 않습니다.')
        with (self.folder / 'eo.txt').open(encoding='utf-8-sig', newline='') as handle:
            self.pose_rows = list(csv.DictReader(handle))
        self.cameras, self.missing = self._scan_images()
        self.origin = next(iter(self.cameras.values()))['centre'][:] if self.cameras else [0,0,0]
        self.calibration_signature = self.signature([self.width,self.height,self.f,self.cx,self.cy,
            self.settings['crs'],self.settings['height_reference'],self.settings['pose_convention']])
        self.revision = self.signature([self.calibration_signature,
            {name:self.camera_signature(name) for name in self.cameras},
            {name:c['file_revision'] for name,c in self.cameras.items()},self.settings])

    @staticmethod
    def signature(value):
        return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode('utf-8')).hexdigest()[:24]

    def camera_signature(self, name):
        c = self.cameras[name]
        return self.signature([c['centre'],c['rotation']])

    def _scan_images(self):
        files = {p.stem.casefold(): p for p in self.folder.iterdir()
                 if p.is_file() and p.suffix.lower() in ('.jpg', '.jpeg', '.png')}
        cameras, missing = {}, []
        for row in self.pose_rows:
            name = row['PhotoID'].strip()
            path = files.get(Path(name).stem.casefold())
            if path is None:
                missing.append(name)
            if name in cameras:
                raise ValueError('중복된 사진 ID: ' + name)
            centre = [float(row[k]) for k in ('X', 'Y', 'Z')]
            angles = [float(row[k]) for k in ('Omega', 'Phi', 'Kappa')]
            if not all(math.isfinite(x) for x in centre + angles):
                raise ValueError('유효하지 않은 표정요소: ' + name)
            stat = path.stat() if path else None
            cameras[name] = dict(id=name, filename=path.name if path else name, path=path,
                                 file_revision=self.signature([str(path),stat.st_size,stat.st_mtime_ns]) if stat else None,
                                 centre=centre, angles=angles, rotation=rotation(*angles))
        return cameras, missing

    def refreshed_images(self):
        return Project(self.root)

    def session_compatible(self, value):
        if not value.get('calibration_signature'):
            return True
        if value['calibration_signature'] != self.calibration_signature:
            return False
        for name, signature in value.get('source_cameras',{}).items():
            if name not in self.cameras or self.camera_signature(name) != signature:
                return False
        for name, signature in value.get('source_images',{}).items():
            current = self.cameras.get(name,{}).get('file_revision')
            if signature and current and current != signature:
                return False
        return True

    def camera(self, image_id):
        if image_id not in self.cameras:
            raise ValueError('알 수 없는 사진입니다.')
        return self.cameras[image_id]

    def observation(self, obs):
        if not isinstance(obs, dict):
            raise ValueError('관측값 형식이 올바르지 않습니다.')
        self.camera(obs.get('image_id'))
        x, y = float(obs['x']), float(obs['y'])
        if not all(math.isfinite(v) for v in (x, y)) or not (0 <= x < self.width and 0 <= y < self.height):
            raise ValueError('사진 안의 지점을 선택하세요.')
        return dict(image_id=obs['image_id'], x=x, y=y)

    def ray(self, obs):
        cam = self.camera(obs['image_id'])
        direction = unit(mv(cam['rotation'], [(obs['x'] - self.cx) / self.f,
                                              -(obs['y'] - self.cy) / self.f, -1]))
        return cam['centre'], direction

    def project(self, image_id, xyz):
        cam = self.camera(image_id)
        q = mv(transpose(cam['rotation']), sub(xyz, cam['centre']))
        if q[2] >= -1e-8:
            return None
        return [self.cx - self.f * q[0] / q[2], self.cy + self.f * q[1] / q[2]]

    def measure(self, observations):
        if not isinstance(observations, list) or len(observations) != 2:
            raise ValueError('서로 다른 사진 두 장에서 같은 지점을 선택하세요.')
        obs = [self.observation(v) for v in observations]
        if obs[0]['image_id'] == obs[1]['image_id']:
            raise ValueError('서로 다른 사진 두 장을 선택하세요.')
        c1, d1 = self.ray(obs[0])
        c2, d2 = self.ray(obs[1])
        baseline = norm(sub(c2, c1))
        if baseline < .01:
            raise ValueError('촬영 위치가 너무 가깝습니다.')
        b = dot(d1, d2)
        denom = 1 - b * b
        if denom < 1e-8:
            raise ValueError('두 광선이 거의 평행합니다. 지점을 다시 선택하세요.')
        delta = sub(c1, c2)
        d, e = dot(d1, delta), dot(d2, delta)
        t1, t2 = (b * e - d) / denom, (e - b * d) / denom
        if t1 <= 0 or t2 <= 0:
            raise ValueError('카메라 뒤쪽에서 만나는 지점입니다. 같은 지점인지 확인하세요.')
        # Use a local origin before solving to keep large projected coordinates stable.
        local = mul(add(mul(d1, t1), add(sub(c2, c1), mul(d2, t2))), .5)
        gap = norm(sub(add(c1, mul(d1, t1)), add(c2, mul(d2, t2))))

        def residual(q):
            world = add(c1, q)
            result = []
            for o in obs:
                predicted = self.project(o['image_id'], world)
                if predicted is None:
                    raise ValueError('카메라 앞쪽의 지점을 선택하세요.')
                result.extend([predicted[0] - o['x'], predicted[1] - o['y']])
            return result

        for _ in range(8):
            r = residual(local)
            columns = []
            h = .001
            for j in range(3):
                shifted = local[:]
                shifted[j] += h
                columns.append([(v - old) / h for v, old in zip(residual(shifted), r)])
            a = [[dot(columns[i], columns[j]) for j in range(3)] for i in range(3)]
            step = solve3(a, [-dot(col, r) for col in columns])
            old_cost = dot(r, r)
            factor = 1.0
            for _ in range(8):
                trial = add(local, mul(step, factor))
                tr = residual(trial)
                if dot(tr, tr) <= old_cost + 1e-12:
                    local = trial
                    break
                factor *= .5
            if norm(step) * factor < 1e-7:
                break
        xyz = add(c1, local)
        rr = residual(local)
        rms = math.sqrt(dot(rr, rr) / 2)  # RMS Euclidean error per image, original pixels.
        angle = math.degrees(math.acos(max(-1, min(1, b))))
        if angle < .1:
            raise ValueError('교회각이 너무 작아 높이를 안정적으로 계산할 수 없습니다.')
        projections = {image_id: self.project(image_id, xyz) for image_id in self.cameras}
        return dict(xyz=xyz, observations=obs, reprojection_rms_px=rms,
                    ray_gap_m=gap, intersection_angle_deg=angle,
                    baseline_m=baseline, projections=projections,
                    save_allowed=rms <= self.settings['max_save_reprojection_px'])

    def guide(self, observation, target):
        obs = self.observation(observation)
        self.camera(target)
        if target == obs['image_id']:
            raise ValueError('다른 사진을 선택하세요.')
        c, ray = self.ray(obs)
        if abs(ray[2]) < 1e-10:
            raise ValueError('높이에 대한 탐색선을 만들 수 없습니다.')
        low, high = self.settings['guide_height_range']
        high = min(high, c[2] - 1, self.camera(target)['centre'][2] - 1)
        samples = []
        for i in range(101):
            z = low + (high - low) * i / 100
            t = (z - c[2]) / ray[2]
            if t <= 0:
                continue
            p = self.project(target, add(c, mul(ray, t)))
            if p:
                samples.append(dict(x=p[0], y=p[1], height=z))
        return samples

    def height_point(self, observation, target, height, method='guided'):
        """A ray intersected with a specified elevation; B is projected, not independent."""
        if method not in ('guided', 'height_locked'):
            raise ValueError('지원하지 않는 높이 지정 방식입니다.')
        obs = self.observation(observation)
        other = self.camera(target)
        if obs['image_id'] == target:
            raise ValueError('서로 다른 사진 두 장을 선택하세요.')
        height = float(height)
        centre, direction = self.ray(obs)
        low, high = self.settings['guide_height_range']
        high = min(high, centre[2] - 1, other['centre'][2] - 1)
        if not math.isfinite(height) or not low <= height <= high or abs(direction[2]) < 1e-10:
            raise ValueError('유효한 범위의 표고를 지정하세요.')
        t = (height - centre[2]) / direction[2]
        if t <= 0:
            raise ValueError('카메라 앞쪽의 표고를 지정하세요.')
        xyz = add(centre, mul(direction, t))
        pixel = self.project(target, xyz)
        if pixel is None:
            raise ValueError('B 사진에서 볼 수 없는 지점입니다.')
        target_obs = self.observation(dict(image_id=target, x=pixel[0], y=pixel[1]))
        _, d2 = self.ray(target_obs)
        angle = math.degrees(math.acos(max(-1, min(1, dot(direction, d2)))))
        return dict(xyz=xyz, observations=[obs, target_obs], method=method,
                    height_constraint_m=height, reprojection_rms_px=None, ray_gap_m=None,
                    intersection_angle_deg=angle, baseline_m=norm(sub(centre, other['centre'])),
                    projections={name: self.project(name, xyz) for name in self.cameras},
                    save_allowed=angle >= .1)

    def public(self):
        images = [{k:v for k,v in c.items() if k != 'path'} for c in self.cameras.values() if c.get('path')]
        available = {c['id'] for c in images}
        pair = self.settings.get('default_pair',[])
        if len(pair) != 2 or len(set(pair)) != 2 or not all(name in available for name in pair):
            pair = [c['id'] for c in images[:2]]
        return dict(name=self.settings['name'], crs=self.settings['crs'], revision=self.revision,
                    axis_order='E,N,H', height_reference=self.settings['height_reference'],
                    camera=dict(width=self.width, height=self.height, focal_mm=self.focal_mm,
                                pixel_mm=self.pixel_mm, focal_px=self.f, cx=self.cx, cy=self.cy,
                                principal_point_assumed=self.settings.get('principal_point') is None,
                                images_undistorted=True),
                    images=images,
                    missing_images=len(self.missing), default_pair=pair,
                    max_save_reprojection_px=self.settings['max_save_reprojection_px'],
                    guide_height_range=self.settings['guide_height_range'],
                    notes=self.settings['notes'], origin=self.origin,
                    pose_convention=self.settings['pose_convention'])

    def normalize_session(self, value):
        if not isinstance(value, dict):
            raise ValueError('저장 자료 형식이 올바르지 않습니다.')
        points = value.get('points', [])
        features = value.get('features', [])
        if not isinstance(points, list) or not isinstance(features, list) or len(points) > 3000 or len(features) > 1000:
            raise ValueError('실습 자료의 최대 크기를 초과했습니다.')
        ids, normalized = set(), []
        for point in points:
            pid = str(point['id'])
            if not re.fullmatch(r'P\d{1,7}', pid) or pid in ids:
                raise ValueError('점 번호가 중복되거나 올바르지 않습니다.')
            ids.add(pid)
            method = point.get('method', 'stereo')
            if method == 'stereo':
                m = self.measure(point['observations'])
                m['method'] = 'stereo'
            elif method in ('guided', 'height_locked'):
                obs = point['observations']
                if not isinstance(obs, list) or len(obs) != 2:
                    raise ValueError('높이 지정점의 관측 정보가 올바르지 않습니다.')
                m = self.height_point(obs[0], obs[1]['image_id'], point['height_constraint_m'], method)
            else:
                raise ValueError('알 수 없는 점 생성 방식입니다.')
            if not m['save_allowed']:
                raise ValueError('대응점 오차가 큰 점은 저장할 수 없습니다: ' + pid)
            normalized.append(dict(id=pid, label=str(point.get('label', pid))[:80],
                                   kind='building' if point.get('kind') == 'building' else 'ground', **m))
        fs, fids = [], set()
        for feature in features:
            fid = str(feature['id'])
            if not re.fullmatch(r'B\d{1,7}', fid) or fid in fids:
                raise ValueError('건물 번호가 중복되거나 올바르지 않습니다.')
            fids.add(fid)
            point_ids = feature['point_ids']
            if not isinstance(point_ids, list) or any(pid not in ids for pid in point_ids):
                raise ValueError('건물에 존재하지 않는 점이 포함되어 있습니다.')
            if len(point_ids) != len(set(point_ids)):
                raise ValueError('건물의 점이 중복되었습니다.')
            closed = bool(feature.get('closed'))
            if closed and len(point_ids) < 3:
                raise ValueError('닫힌 건물은 점이 세 개 이상 필요합니다.')
            ref = feature.get('ground_reference')
            if ref is not None and ref not in {p['id'] for p in normalized if p['kind'] == 'ground'}:
                raise ValueError('건물 기준 지면은 저장된 지면 점에서 선택하세요.')
            entry = dict(id=fid, label=str(feature.get('label', fid))[:80], point_ids=point_ids, closed=closed)
            if ref is not None:
                entry['ground_reference'] = ref
            fs.append(entry)
        ground = value.get('ground_reference')
        ground_ids = {p['id'] for p in normalized if p['kind'] == 'ground'}
        if ground is not None and ground not in ground_ids:
            raise ValueError('기준 지면은 저장된 지면 점에서 선택하세요.')
        terrain = None
        if value.get('terrain') is not None:
            from terrain import validate_terrain
            if not isinstance(value['terrain'],dict):
                raise ValueError('지형 모형 정보가 올바르지 않습니다.')
            source = value['terrain'].get('source_points',[])
            if not isinstance(source,list) or any(not isinstance(p,dict) or p.get('kind') != 'ground' for p in source):
                raise ValueError('지형은 지면 점으로만 구성할 수 있습니다.')
            normalized_source = self.normalize_session({'points':source})['points']
            terrain = validate_terrain(value['terrain'],normalized_source)
        source_ids = {o['image_id'] for p in normalized + (terrain['source_points'] if terrain else []) for o in p['observations']}
        return dict(version=3, crs=self.settings['crs'], axis_order='E,N,H', project_revision=self.revision,
                    calibration_signature=self.calibration_signature,
                    source_cameras={name:self.camera_signature(name) for name in sorted(source_ids)},
                    source_images={name:self.cameras[name].get('file_revision') for name in sorted(source_ids)},
                    height_reference=self.settings['height_reference'], camera=self.public()['camera'],
                    points=normalized, features=fs, ground_reference=ground, terrain=terrain)
