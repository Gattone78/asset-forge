<script setup lang="ts">
// Inline 3D preview: Three.js GLTFLoader + MeshoptDecoder (the same loader path Meadowbots uses),
// 1 m grid at y=0, axes, orbit controls. Client-only component (.client.vue).
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const props = defineProps<{ src: string; wiggle?: boolean }>();
const emit = defineEmits<{ (e: "loaded", info: { tris: number; height: number; minY: number; skinned: number; bones: number }): void; (e: "error", msg: string): void }>();
let bones: THREE.Bone[] = []; let rest: THREE.Euler[] = [];
const el = ref<HTMLDivElement | null>(null);
const status = ref("loading…");
let renderer: THREE.WebGLRenderer | null = null;
let raf = 0;
let dispose: (() => void) | null = null;

function frameFront(camera: THREE.PerspectiveCamera, controls: OrbitControls, obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj); const size = box.getSize(new THREE.Vector3()); const c = box.getCenter(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) * 2.0;
  camera.position.set(c.x + d * 0.35, c.y + d * 0.3, c.z - d);   // front-left: the model faces -Z
  controls.target.copy(c); controls.update();
  return { box, size };
}

async function setup() {
  const host = el.value!; host.innerHTML = "";
  const w = host.clientWidth, h = Math.max(260, Math.round(w * 0.75));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe6ebe9);
  const camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 100);
  renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(2, 4, -3); scene.add(sun);
  scene.add(new THREE.GridHelper(2, 20, 0x667788, 0xb8c4cc)); scene.add(new THREE.AxesHelper(0.4));
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(props.src, (gltf) => {
    scene.add(gltf.scene);
    let tris = 0, skinned = 0; bones = []; rest = [];
    gltf.scene.traverse((o: any) => { if (o.isMesh) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } if (o.isSkinnedMesh) skinned++; if (o.isBone) { bones.push(o); rest.push(o.rotation.clone()); } });
    const { box, size } = frameFront(camera, controls, gltf.scene);
    status.value = "";
    emit("loaded", { tris: Math.round(tris), height: size.y, minY: box.min.y, skinned, bones: bones.length });
  }, undefined, (err) => { status.value = "load failed"; emit("error", String(err)); });
  // Procedural bone drive (Phase 4 acceptance): a gentle per-bone sway proves the skeleton deforms the mesh.
  const animate = () => {
    raf = requestAnimationFrame(animate);
    const t = performance.now() / 1000;
    bones.forEach((b, i) => { b.rotation.z = props.wiggle ? rest[i].z + Math.sin(t * 2 + i * 0.7) * 0.25 : rest[i].z; });
    controls.update(); renderer!.render(scene, camera);
  };
  animate();
  const onResize = () => { if (!renderer) return; const w2 = host.clientWidth, h2 = Math.max(260, Math.round(w2 * 0.75)); camera.aspect = w2 / h2; camera.updateProjectionMatrix(); renderer.setSize(w2, h2); };
  addEventListener("resize", onResize);
  dispose = () => { removeEventListener("resize", onResize); cancelAnimationFrame(raf); controls.dispose(); renderer?.dispose(); renderer = null; };
}
onMounted(setup);
watch(() => props.src, () => { dispose?.(); setup(); });
onUnmounted(() => dispose?.());
</script>
<template>
  <div class="viewer">
    <div ref="el" class="canvas-host" />
    <div v-if="status" class="overlay">{{ status }}</div>
  </div>
</template>
<style scoped>
.viewer { position: relative; border-radius: 12px; overflow: hidden; background: #e6ebe9; }
.canvas-host { width: 100%; min-height: 260px; }
.overlay { position: absolute; inset: 0; display: grid; place-items: center; color: #555; font-size: 14px; }
</style>
