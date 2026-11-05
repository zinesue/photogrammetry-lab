"""Fixed calibration fixtures; tests do not depend on the user's replaceable photos."""
import csv
import json
import tempfile
from pathlib import Path
from photogrammetry import Project

ROOT=Path(__file__).resolve().parents[1]

def fixture_project(image_ids=None):
    source=json.loads((ROOT/'tests/fixtures/project.json').read_text(encoding='utf-8'))
    temp=tempfile.TemporaryDirectory()
    root=Path(temp.name)
    settings=dict(name='Test project',data_directory='data',crs='LOCAL_SYNTHETIC_METRES',
        height_reference='표고',images_undistorted=True,principal_point=None,
        pose_convention='camera_to_world_RxRyRz',default_pair=[],guide_height_range=[-100,300],
        max_save_reprojection_px=5,notes='Fixture')
    (root/'project.json').write_text(json.dumps(settings),encoding='utf-8')
    folder=root/'data';folder.mkdir()
    k=source['camera']
    (folder/'cam.txt').write_text(f"focal_length: {k['focal_mm']}\npixel_size: {k['pixel_mm']}\nimage_size_x: {k['width']}\nimage_size_y: {k['height']}\n",encoding='utf-8')
    with (folder/'eo.txt').open('w',newline='',encoding='utf-8') as handle:
        writer=csv.writer(handle);writer.writerow(['PhotoID','X','Y','Z','Omega','Phi','Kappa'])
        for image in source['images']:
            writer.writerow([image['id'],*image['centre'],*image['angles']])
            if image_ids is None or image['id'] in image_ids:
                (folder/(image['id']+'.JPG')).write_bytes(b'fixture photo')
    return Project(root),temp
