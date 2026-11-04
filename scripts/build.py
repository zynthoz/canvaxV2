import os
import zipfile
import shutil
import json

root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
src = os.path.join(root, 'extension')
build = os.path.join(root, 'build')
dist = os.path.join(root, 'dist')

# Safety check
with open(os.path.join(src, 'background.js'), 'r', encoding='utf-8') as f:
    bg = f.read()
if 'const HARDCODED_KEY = "";' not in bg:
    print('WARNING: HARDCODED_KEY is not empty!')

# Check version
with open(os.path.join(src, 'manifest.json'), 'r', encoding='utf-8') as f:
    v = json.load(f)['version']
with open(os.path.join(src, 'manifest.firefox.json'), 'r', encoding='utf-8') as f:
    fv = json.load(f)['version']
assert v == fv, f'Version mismatch: {v} vs {fv}'

if os.path.exists(build):
    shutil.rmtree(build)
if os.path.exists(dist):
    shutil.rmtree(dist)

os.makedirs(dist, exist_ok=True)

files = ['background.js', 'overlay.js', 'overlay.css', 'icons']

for b, manifest_name in [('chrome', 'manifest.json'), ('firefox', 'manifest.firefox.json')]:
    b_dir = os.path.join(build, b)
    os.makedirs(b_dir, exist_ok=True)
    for f in files:
        s_path = os.path.join(src, f)
        d_path = os.path.join(b_dir, f)
        if os.path.isdir(s_path):
            shutil.copytree(s_path, d_path)
        else:
            shutil.copy2(s_path, d_path)
    shutil.copy2(os.path.join(src, manifest_name), os.path.join(b_dir, 'manifest.json'))

    zip_path = os.path.join(dist, f'canvax-{b}.zip')
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for r, dirs, file_list in os.walk(b_dir):
            for file in file_list:
                full_path = os.path.join(r, file)
                rel_path = os.path.relpath(full_path, b_dir)
                zf.write(full_path, rel_path)
    print(f'Created: dist/canvax-{b}.zip ({os.path.getsize(zip_path)} bytes)')

print(f'[OK] Build completed for Canvax v{v}')
