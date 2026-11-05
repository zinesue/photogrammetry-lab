"""Create public, entirely fictional stereo data; never reads classroom data.

The independent nadir pinhole equations below also provide test oracles.
Pillow is needed only to regenerate the bundled PNG images.
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT, FOCAL = 1600, 1200, 1200.0
CAMERAS = {'SYNTH_A': [-15.0, 0.0, 160.0], 'SYNTH_B': [15.0, 0.0, 160.0]}
IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
SETTINGS = {
    'name': '건국대학교 공간정보 수업 · 사진측량 실습 · 가상 예제',
    'data_directory': 'examples/synthetic',
    'crs': 'LOCAL_SYNTHETIC_METRES', 'coordinate_order': 'E,N,H',
    'horizontal_axes_note': '가상 로컬 좌표. 실제 촬영 위치 또는 지도 좌표와 관련 없음.',
    'height_reference': '가상 지면 H=0 m 기준 높이',
    'images_undistorted': True, 'principal_point': [800, 600],
    'pose_convention': 'camera_to_world_RxRyRz',
    'default_pair': ['SYNTH_A', 'SYNTH_B'], 'guide_height_range': [-20, 100],
    'max_save_reprojection_px': 5.0,
    'notes': '실제 드론사진이 아닌 수식으로 생성한 가상 예제입니다. 실제 촬영 위치·사진·표정요소를 포함하지 않습니다.',
}
MARKERS = {
    'G1': [-40, -30, 0], 'G2': [35, -30, 0], 'G3': [-40, 35, 0],
    'R1': [-22, -16, 20], 'R2': [18, -16, 20],
    'R3': [18, 16, 20], 'R4': [-22, 16, 20],
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def pixel(camera, xyz):
    """Independent closed-form projection for zero-angle, downward cameras."""
    cx, cy, cz = camera
    x, y, z = xyz
    return [WIDTH / 2 + FOCAL * (x - cx) / (cz - z),
            HEIGHT / 2 - FOCAL * (y - cy) / (cz - z)]


def render(path, name, camera):
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new('RGB', (WIDTH, HEIGHT), '#d8e2da')
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=20)
    small = ImageFont.load_default(size=16)
    def line(a, b, fill, width=1):
        draw.line([tuple(pixel(camera, a)), tuple(pixel(camera, b))], fill=fill, width=width)
    for x in range(-150, 151, 10):
        line([x, -100, 0], [x, 100, 0], '#b3c4b6')
    for y in range(-100, 101, 10):
        line([-150, y, 0], [150, y, 0], '#b3c4b6')
    for bounds, z, roof in [((-22, -16, 18, 16), 20, '#e5be79'), ((35, 15, 55, 40), 35, '#8dbbcb')]:
        x0, y0, x1, y1 = bounds
        ground = [[x0,y0,0], [x1,y0,0], [x1,y1,0], [x0,y1,0]]
        top = [[x,y,z] for x,y,_ in ground]
        for i in range(4):
            j = (i+1) % 4
            face = [ground[i], ground[j], top[j], top[i]]
            draw.polygon([tuple(pixel(camera, p)) for p in face], fill='#9e977f', outline='#5f635a', width=2)
        draw.polygon([tuple(pixel(camera, p)) for p in top], fill=roof, outline='#485a57', width=3)
        for x in range(x0+5, x1, 5):
            line([x,y0,z], [x,y1,z], '#8b927c')
        at = pixel(camera, [(x0+x1)/2, (y0+y1)/2, z])
        draw.text((at[0]-28, at[1]-12), f'{z} m', font=font, fill='#203f45')
    for label, xyz in MARKERS.items():
        u, v = pixel(camera, xyz)
        draw.ellipse((u-8,v-8,u+8,v+8), fill='#fffdf2', outline='#bd283b', width=2)
        draw.line((u-12,v,u+12,v), fill='#b51b31', width=1)
        draw.line((u,v-12,u,v+12), fill='#b51b31', width=1)
        draw.text((u+13,v-22), label, font=font, fill='#8b1630', stroke_width=2, stroke_fill='#fffdf2')
    draw.rectangle((20,20,720,91), fill='#173b46')
    draw.text((36,30), f'SYNTHETIC STEREO DEMO / {name}', font=font, fill='white')
    draw.text((36,60), 'Fictional local coordinates / grid 10 m / no real imagery or location', font=small, fill='#d8e8df')
    # A new image is saved without EXIF, GPS, or source-image metadata.
    image.save(path, format='PNG')


def main():
    data = ROOT / 'examples/synthetic'
    data.mkdir(parents=True, exist_ok=True)
    write_json(data/'project.json', SETTINGS)
    (data/'cam.txt').write_text('focal_length: 12.0\npixel_size: 0.01\nimage_size_x: 1600\nimage_size_y: 1200\n', encoding='utf-8')
    with (data/'eo.txt').open('w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        writer.writerow(['PhotoID','X','Y','Z','Omega','Phi','Kappa'])
        for name, camera in CAMERAS.items():
            writer.writerow([name, *camera, 0, 0, 0])
            render(data/(name+'.PNG'), name, camera)
    write_json(data/'checkpoints.json', {'description': 'Entirely synthetic pinhole ground truth, metres and pixels.',
        'points': [{'label': label, 'xyz': xyz, 'observations': [dict(image_id=name, x=pixel(c,xyz)[0], y=pixel(c,xyz)[1]) for name,c in CAMERAS.items()]} for label,xyz in MARKERS.items()]})

    # Tests include three additional fictional cameras to exercise image changes.
    test_cameras = {'SYNTH_0': [-40,0,160], **CAMERAS, 'SYNTH_3': [40,0,160], 'SYNTH_4': [60,0,160]}
    fixture = dict(name='Synthetic test fixture', crs=SETTINGS['crs'], axis_order='E,N,H',
        height_reference=SETTINGS['height_reference'],
        camera=dict(width=WIDTH,height=HEIGHT,focal_mm=12.0,pixel_mm=0.01,focal_px=FOCAL,cx=800,cy=600,principal_point_assumed=False,images_undistorted=True),
        images=[dict(id=name,filename=name+'.JPG',centre=c,angles=[0,0,0],rotation=IDENTITY) for name,c in test_cameras.items()],
        missing_images=0, default_pair=SETTINGS['default_pair'], max_save_reprojection_px=5.0,
        guide_height_range=[-100,300], notes='Synthetic test fixture; no classroom data.', origin=[-40,0,160], pose_convention=SETTINGS['pose_convention'])
    write_json(ROOT/'tests/fixtures/project.json', fixture)
    matches = []
    for i in range(21):
        xyz = [-20+(i%7)*6, -15+(i//7)*15, 0 if i == 0 else 10+(i%4)*5]
        matches.append({'xyz': xyz, 'left': pixel(CAMERAS['SYNTH_A'],xyz), 'right': pixel(CAMERAS['SYNTH_B'],xyz)})
    write_json(ROOT/'tests/fixtures/observations.json', {'provenance': 'Analytical synthetic pinhole projections; no real correspondences.', 'images': list(CAMERAS), 'matches': matches})
    points=[]
    for i, item in enumerate(matches[:4]):
        points.append(dict(id=f'P{i+1:03}',kind='ground' if i==0 else 'building',xyz=item['xyz'],
            observations=[dict(image_id=name,x=item[key][0],y=item[key][1]) for name,key in zip(CAMERAS,('left','right'))]))
    write_json(ROOT/'tests/fixtures/legacy-session.json', {'version':1,'points':points,'features':[dict(id='B001',point_ids=['P002','P003','P004'],closed=True)],'ground_reference':'P001'})
    print('Created synthetic stereo images, calibration, checkpoints and test fixtures.')


if __name__ == '__main__':
    main()
