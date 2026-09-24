// Minimal same-origin debug viewer: GET /viewer?job=<id>. Loads the job's final GLB with Three.js
// GLTFLoader + MeshoptDecoder (what Meadowbots needs too), on a 1 m grid with axes, and prints the
// bounding box so "stands on the ground, at height, facing -Z" can be checked by eye and by number.
// Not the Phase 3 UI — a verification aid that costs one file.
export function viewerHtml(job: string, glbPath: string, three = "0.186.0"): string {  // Meadowbots pins three ^0.186
  const glbUrl = `/assets/${job}/${glbPath}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>forge viewer</title>
<style>html,body{margin:0;height:100%;background:#dfe6ec;font:13px/1.4 system-ui}#hud{position:fixed;left:10px;top:10px;background:#fff9;padding:8px 10px;border-radius:6px;white-space:pre}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@${three}/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@${three}/examples/jsm/"}}</script>
</head><body><div id="hud">loading ${glbUrl}</div>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const hud = document.getElementById("hud");
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xdfe6ec);
const camera = new THREE.PerspectiveCamera(40, innerWidth/innerHeight, 0.01, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(devicePixelRatio); document.body.appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(2, 4, 3); scene.add(sun);
scene.add(new THREE.GridHelper(2, 20, 0x667788, 0xaabbcc));     // 2 m grid, 10 cm cells, at y=0
scene.add(new THREE.AxesHelper(0.5));                          // red +X, green +Y, blue +Z
const url = new URL(location.href); const view = url.searchParams.get("view") || "front";
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
loader.load(${JSON.stringify(glbUrl)}, (gltf) => {
  scene.add(gltf.scene);
  let tris = 0, skinned = 0; const bones = [];
  gltf.scene.traverse((o) => { if (o.isMesh) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } if (o.isSkinnedMesh) skinned++; if (o.isBone) bones.push(o); });
  const pivot = gltf.scene.getObjectByName("pivot_root"); const armature = gltf.scene.getObjectByName("Armature");
  // wiggle=1: drive every bone procedurally so a rigged asset visibly deforms (acceptance for Phase 4).
  const wiggle = url.searchParams.get("wiggle") === "1";
  const rest = bones.map((b) => b.rotation.clone());
  const drive = (t) => { if (!wiggle) return; bones.forEach((b, i) => { b.rotation.z = rest[i].z + Math.sin(t * 2 + i * 0.7) * 0.25; }); };
  const box = new THREE.Box3().setFromObject(gltf.scene); const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) * 2.2;
  // "front" camera sits on -Z looking at +Z, so a model facing -Z shows its face.
  const pos = view === "back" ? [c.x, c.y + d*0.25, c.z + d] : view === "side" ? [c.x + d, c.y + d*0.25, c.z] : view === "top" ? [c.x, c.y + d, c.z + 0.001] : [c.x, c.y + d*0.25, c.z - d];
  camera.position.set(...pos); camera.lookAt(c);
  const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(c); controls.update();
  hud.textContent = "job ${job}\\n" + "file ${glbPath}\\n" + "triangles " + Math.round(tris) + "\\n" +
    "bbox min " + box.min.toArray().map(v => v.toFixed(3)).join(", ") + "\\n" +
    "bbox max " + box.max.toArray().map(v => v.toFixed(3)).join(", ") + "\\n" +
    "height " + size.y.toFixed(3) + " m   min y " + box.min.y.toFixed(4) + "\\n" +
    "camera on " + (view === "front" ? "-Z (looking at the -Z face = front)" : view) + "\\n" +
    "extensions " + (gltf.parser.json.extensionsRequired || []).join(", ") + "\\n" +
    "skinned meshes " + skinned + "   bones " + bones.length + (bones.length ? " (" + bones.slice(0, 4).map(b => b.name).join(", ") + "…)" : "") + "\\n" +
    "pivot_root " + (pivot ? "found (" + pivot.type + ")" : "absent") + "   Armature " + (armature ? "found" : "absent") + (wiggle ? "   wiggling bones" : "");
  document.title = "forge viewer ok";
  (function animate() { requestAnimationFrame(animate); drive(performance.now() / 1000); controls.update(); renderer.render(scene, camera); })();
}, undefined, (err) => { hud.textContent = "LOAD FAILED: " + err; document.title = "forge viewer failed"; });
addEventListener("resize", () => { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
</script></body></html>`;
}
