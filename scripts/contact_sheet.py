"""Contact sheet of a batch's thumbnails (runs inside the comfyui image: PIL is there).
Usage: python contact_sheet.py <jobs.json from GET /jobs?batch=...> <out.png> [--tile 256] [--cols 5]"""
import json
import sys

from PIL import Image, ImageDraw

jobs_json, out = sys.argv[1], sys.argv[2]
tile = int(sys.argv[sys.argv.index("--tile") + 1]) if "--tile" in sys.argv else 256
cols = int(sys.argv[sys.argv.index("--cols") + 1]) if "--cols" in sys.argv else 5
jobs = sorted(json.load(open(jobs_json)), key=lambda j: j["request"]["seed"])
rows = (len(jobs) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tile, rows * (tile + 22)), "white")
draw = ImageDraw.Draw(sheet)
for i, j in enumerate(jobs):
    x, y = (i % cols) * tile, (i // cols) * (tile + 22)
    try:
        im = Image.open("/srv/forge/jobs/%s/out/thumb.png" % j["id"]).convert("RGB").resize((tile, tile))
        sheet.paste(im, (x, y))
    except Exception as e:
        draw.text((x + 4, y + tile // 2), "no thumb: %s" % e, fill="red")
    draw.text((x + 4, y + tile + 4), "seed %s: %s" % (j["request"]["seed"], j["request"]["prompt"][:34]), fill="black")
sheet.save(out)
print("sheet", sheet.size, "->", out)
