#!/usr/bin/env python3
"""Submit an API-format ComfyUI workflow, wait for it, report outputs, wall time and peak VRAM.

Runs on the VM host with stdlib only:
    python3 scripts/run_workflow.py workflows/test-flux.json [--host 127.0.0.1:8188] [--set 7.seed=2]
Peak VRAM is sampled from host nvidia-smi every 0.5 s while the prompt runs.
"""
import argparse
import json
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

ap = argparse.ArgumentParser()
ap.add_argument("workflow")
ap.add_argument("--host", default="127.0.0.1:8188")
ap.add_argument("--timeout", type=int, default=3600)
ap.add_argument("--set", action="append", default=[], help="node_id.input=<json value> to patch before submit")
a = ap.parse_args()

wf = json.load(open(a.workflow))
for s in a.set:
    k, v = s.split("=", 1)
    nid, inp = k.split(".", 1)
    wf[nid]["inputs"][inp] = json.loads(v)

base = "http://" + a.host


def get(path):
    with urllib.request.urlopen(base + path, timeout=30) as r:
        return json.load(r)


peak = {"mib": 0, "stop": False}


def sampler():
    while not peak["stop"]:
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True)
            peak["mib"] = max(peak["mib"], int(out.strip().splitlines()[0]))
        except Exception:
            pass
        time.sleep(0.5)


threading.Thread(target=sampler, daemon=True).start()

cid = str(uuid.uuid4())
t0 = time.time()
req = urllib.request.Request(base + "/prompt", data=json.dumps({"prompt": wf, "client_id": cid}).encode(),
                             headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.load(r)
except urllib.error.HTTPError as e:
    print("SUBMIT FAILED", e.code, e.read().decode()[:4000])
    sys.exit(2)
if "error" in resp or resp.get("node_errors"):
    print("VALIDATION ERROR", json.dumps(resp, indent=1)[:4000])
    sys.exit(2)
pid = resp["prompt_id"]
print("prompt_id", pid)

hist = None
status = {}
while time.time() - t0 < a.timeout:
    h = get("/history/" + pid)
    if pid in h:
        hist = h[pid]
        status = hist.get("status", {})
        break
    time.sleep(2)
peak["stop"] = True
wall = time.time() - t0
if hist is None:
    print("TIMEOUT after %.0fs" % wall)
    sys.exit(3)

ok = status.get("status_str") == "success" and status.get("completed", False)
print("status=%s completed=%s wall=%.1fs peak_vram_mib=%d" % (
    status.get("status_str"), status.get("completed"), wall, peak["mib"]))
for nid, out in hist.get("outputs", {}).items():
    for kind, items in out.items():
        if not isinstance(items, list):
            continue
        for it in items:
            if isinstance(it, dict) and "filename" in it:
                print("output node %s [%s]: %s/%s" % (nid, kind, it.get("subfolder", ""), it["filename"]))
if not ok:
    for m in status.get("messages", []):
        if m[0] == "execution_error":
            print("EXECUTION ERROR node", m[1].get("node_id"), m[1].get("node_type"))
            print(m[1].get("exception_message", "")[:3000])
            print("\n".join(m[1].get("traceback", [])[-25:]))
    sys.exit(1)
