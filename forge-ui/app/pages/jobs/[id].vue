<script setup lang="ts">
// Job detail (req §6): reference images, thumbnail, inline 3D preview, sidecar summary, log tail,
// approve / reject / rerun / download.
const api = useApi();
const route = useRoute();
const router = useRouter();
const id = route.params.id as string;
const job = ref<Job | null>(null);
const assets = ref<Assets | null>(null);
const candidates = ref<any>(null);
const log = ref("");
const err = ref("");
const busy = ref("");
const viewerInfo = ref<{ tris: number; height: number; minY: number; skinned?: number; bones?: number } | null>(null);
const wiggle = ref(true);
let timer: any;

const active = computed(() => !!job.value && ACTIVE.has(job.value.status));
const outFiles = computed(() => assets.value?.files.filter((f) => f.path.startsWith("out/")) ?? []);
const refFiles = computed(() => assets.value?.files.filter((f) => f.path.startsWith("refs/") && f.path.endsWith(".png")) ?? []);
const finalGlb = computed(() => outFiles.value.find((f) => f.path.endsWith(".glb") && !f.path.endsWith(".blender.glb") && !f.path.endsWith(".rigged.glb"))?.path);
const riggedGlb = computed(() => outFiles.value.find((f) => f.path.endsWith(".rigged.glb"))?.path);
const riggedFbx = computed(() => outFiles.value.find((f) => f.path.endsWith(".rigged.fbx"))?.path);
const showRigged = ref(false);
const previewSrc = computed(() => (showRigged.value && riggedGlb.value) ? riggedGlb.value : finalGlb.value);
const fbx = computed(() => outFiles.value.find((f) => f.path.endsWith(".fbx"))?.path);
const sidecarFile = computed(() => outFiles.value.find((f) => f.path.endsWith(".sidecar.json"))?.path);
const sidecar = computed(() => assets.value?.sidecar);
const logTail = computed(() => log.value.split("\n").filter(Boolean).slice(-40).join("\n"));
const picked = computed(() => candidates.value?.picked as string | undefined);
const isImage = computed(() => job.value?.request.type === "image");
const imageEntries = computed(() => (sidecar.value?.images ?? []) as any[]);

async function refresh() {
  try {
    job.value = await api.job(id);
    assets.value = await api.assets(id);
    log.value = await api.log(id).catch(() => "");
    if (!candidates.value && refFiles.value.length) candidates.value = await $fetch(api.assetUrl(id, "refs/candidates.json")).catch(() => null);
    err.value = "";
  } catch (e: any) { err.value = e?.data?.error ?? String(e); }
}
onMounted(async () => { await refresh(); timer = setInterval(() => { if (active.value) refresh(); }, 2500); });
onUnmounted(() => clearInterval(timer));

async function act(what: "approve" | "reject") { busy.value = what; try { job.value = await api[what](id); } catch (e: any) { err.value = e?.data?.error ?? String(e); } finally { busy.value = ""; } }
const rerunDialog = ref(false); const rerunSeed = ref<string | number>("");
async function rerun(sameSeed: boolean) {
  busy.value = "rerun";
  try { const j = await api.rerun(id, sameSeed ? undefined : (rerunSeed.value === "" ? Math.floor(Math.random() * 2 ** 31) : Number(rerunSeed.value))); rerunDialog.value = false; router.push(`/jobs/${j.id}`); }
  catch (e: any) { err.value = e?.data?.error ?? String(e); } finally { busy.value = ""; }
}
const stage = (name: string) => sidecar.value?.stages?.find((s: any) => s.stage === name);
</script>

<template>
  <div v-if="job">
    <div class="d-flex flex-wrap align-center ga-2 mb-2">
      <v-btn icon="mdi-arrow-left" variant="text" to="/" />
      <v-chip :color="STATUS_COLOR[job.status]" variant="flat" label>{{ job.status }}</v-chip>
      <span v-if="active" class="text-body-2">{{ job.stage }} · {{ Math.round(job.progress * 100) }}%</span>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">{{ short(job.id) }} · {{ ago(job.created_at) }}</span>
    </div>
    <h2 class="text-h6 mb-1">{{ job.request.prompt }}</h2>
    <div class="text-caption text-medium-emphasis mb-3">{{ job.request.type }}<span v-if="job.request.image"> ({{ job.request.image.kind }}<span v-if="job.request.image.transparent">, transparent</span><span v-if="job.request.image.seamless">, seamless</span>)</span> · {{ job.request.profile }} · seed {{ job.request.seed }} · {{ job.request.count }} candidates<span v-if="job.request.batch"> · batch <NuxtLink :to="`/?batch=${encodeURIComponent(job.request.batch)}`">{{ job.request.batch }}</NuxtLink></span><span v-if="job.request.rerun_of"> · rerun of {{ short(job.request.rerun_of) }}</span></div>
    <v-progress-linear v-if="active" :model-value="job.progress * 100" :indeterminate="job.status === 'queued'" color="primary" height="6" rounded class="mb-3" />
    <v-alert v-if="job.error" type="error" density="compact" class="mb-3">{{ job.error }}</v-alert>
    <v-alert v-if="err" type="warning" density="compact" class="mb-3">{{ err }}</v-alert>

    <div class="d-flex flex-wrap ga-2 mb-4">
      <v-btn v-if="['review', 'rejected'].includes(job.status)" color="green" variant="flat" prepend-icon="mdi-check" :loading="busy === 'approve'" @click="act('approve')">Approve</v-btn>
      <v-btn v-if="['review', 'approved'].includes(job.status)" color="red" variant="tonal" prepend-icon="mdi-close" :loading="busy === 'reject'" @click="act('reject')">Reject</v-btn>
      <v-btn v-if="!active" variant="tonal" prepend-icon="mdi-refresh" @click="rerunDialog = true">Rerun</v-btn>
      <v-spacer />
      <v-btn v-if="finalGlb" :href="api.assetUrl(job.id, finalGlb)" download color="primary" variant="flat" prepend-icon="mdi-cube-outline">GLB</v-btn>
      <v-btn v-if="fbx" :href="api.assetUrl(job.id, fbx)" download variant="tonal" prepend-icon="mdi-download">FBX</v-btn>
      <v-btn v-if="riggedGlb" :href="api.assetUrl(job.id, riggedGlb)" download color="secondary" variant="flat" prepend-icon="mdi-bone">Rigged GLB</v-btn>
      <v-btn v-if="riggedFbx" :href="api.assetUrl(job.id, riggedFbx)" download variant="tonal" prepend-icon="mdi-bone">Rigged FBX</v-btn>
      <v-btn v-if="sidecarFile" :href="api.assetUrl(job.id, sidecarFile)" download variant="tonal" prepend-icon="mdi-code-json">Sidecar</v-btn>
    </div>

    <v-row dense>
      <v-col cols="12" md="7">
        <v-card v-if="isImage && imageEntries.length" class="mb-3" title="Images" :subtitle="`${imageEntries.length} candidate(s)` + (imageEntries[0]?.alpha ? ' · transparent PNG' : '')">
          <v-card-text class="pt-0">
            <v-row dense>
              <v-col v-for="im in imageEntries" :key="im.file" cols="6">
                <a :href="api.assetUrl(job.id, 'out/' + im.file)" target="_blank"><v-img :src="api.assetUrl(job.id, 'out/' + im.file)" aspect-ratio="1" contain class="checker" rounded="lg" /></a>
                <div class="text-caption text-center">{{ im.width }}×{{ im.height }}<span v-if="im.seam_score !== undefined"> · seam {{ im.seam_score.toFixed(3) }} <span :class="im.seam_score < 0.05 ? 'text-green' : 'text-orange'">({{ im.seam_score < 0.05 ? 'tiles cleanly' : 'visible seam' }})</span></span></div>
                <v-img v-if="im.tiled" :src="api.assetUrl(job.id, 'out/' + im.tiled)" aspect-ratio="1" cover rounded="lg" class="mt-1" title="2x2 tiled preview" />
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>
        <v-card v-if="previewSrc" class="mb-3">
          <ModelViewer :src="api.assetUrl(job.id, previewSrc)" :wiggle="showRigged && wiggle" @loaded="viewerInfo = $event" @error="err = 'preview failed: ' + $event" />
          <v-card-text v-if="viewerInfo" class="text-caption py-2 d-flex flex-wrap align-center ga-2">
            <span>Three.js preview · {{ viewerInfo.tris.toLocaleString() }} tris · height {{ viewerInfo.height.toFixed(3) }} m · feet at y = {{ viewerInfo.minY.toFixed(4) }}<span v-if="viewerInfo.bones"> · {{ viewerInfo.skinned }} SkinnedMesh · {{ viewerInfo.bones }} bones</span> · drag to orbit</span>
            <v-spacer />
            <v-btn-toggle v-if="riggedGlb" v-model="showRigged" density="compact" variant="outlined" mandatory>
              <v-btn :value="false" size="small">static</v-btn><v-btn :value="true" size="small">rigged</v-btn>
            </v-btn-toggle>
            <v-switch v-if="riggedGlb && showRigged" v-model="wiggle" label="wiggle bones" density="compact" hide-details color="primary" />
          </v-card-text>
        </v-card>
        <v-card v-else-if="active" class="mb-3"><v-card-text class="text-center py-8"><v-progress-circular indeterminate color="primary" /><div class="mt-3 text-body-2">{{ job.stage }}…</div></v-card-text></v-card>

        <v-card v-if="refFiles.length" class="mb-3" title="Reference images" :subtitle="picked ? `picked ${picked}` : undefined">
          <v-card-text class="pt-0">
            <v-row dense>
              <v-col v-for="f in refFiles" :key="f.path" cols="6" sm="3">
                <v-img :src="api.assetUrl(job.id, f.path)" aspect-ratio="1" cover rounded="lg" :class="{ 'picked': picked && f.path.endsWith(picked) }" />
                <div class="text-caption text-center">{{ f.path.replace('refs/', '') }}</div>
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="5">
        <v-card v-if="sidecar" class="mb-3" title="Asset">
          <v-list density="compact" class="py-0">
            <v-list-item title="Name" :subtitle="sidecar.files?.glb" />
            <v-list-item title="Geometry" :subtitle="`${sidecar.geometry?.tris?.toLocaleString()} tris · ${sidecar.geometry?.verts?.toLocaleString()} verts · ${sidecar.geometry?.height_m} m · ${sidecar.geometry?.up_axis}-up, ${sidecar.geometry?.forward} forward, origin at ${sidecar.geometry?.origin}`" />
            <v-list-item title="Textures" :subtitle="(sidecar.textures ?? []).map((t: any) => `${t.name} (${t.mimeType})`).join(', ') || 'vertex colours'" />
            <v-list-item v-if="stage('image')" title="Image stage" :subtitle="`${stage('image').model} · seed ${stage('image').seed} · ${stage('image').steps} steps · ${stage('image').license}`" />
            <v-list-item v-if="stage('3d')" title="3D stage" :subtitle="`${stage('3d').model} · seed ${stage('3d').seed} · res ${stage('3d').resolution} · ${stage('3d').license}`" />
            <v-list-item v-if="stage('rig')" title="Rig stage" :subtitle="`${stage('rig').model} · ${stage('rig').template} · ${stage('rig').bones} bones, root ${stage('rig').skeleton_root} · ${stage('rig').license}`" />
            <v-list-item v-if="stage('post')" title="Post stage" :subtitle="`${stage('post').tool} · ${stage('post').ops?.join(', ')} · ${stage('post').tris_before?.toLocaleString()} → ${stage('post').tris_after?.toLocaleString()} tris`" />
            <v-list-item title="Profile hash" :subtitle="sidecar.profile_hash?.slice(0, 16) + '…'" />
          </v-list>
        </v-card>
        <v-card v-if="outFiles.length" class="mb-3" title="Files">
          <v-list density="compact" class="py-0">
            <v-list-item v-for="f in outFiles" :key="f.path" :href="api.assetUrl(job.id, f.path)" :title="f.path.replace('out/', '')" :subtitle="fmtBytes(f.bytes)" append-icon="mdi-download" />
          </v-list>
        </v-card>
        <v-card v-if="logTail" title="Log">
          <v-card-text><pre class="log">{{ logTail }}</pre></v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-dialog v-model="rerunDialog" max-width="420">
      <v-card title="Rerun">
        <v-card-text>
          <p class="text-body-2 mb-3">Same seed restarts the GPU service for a reproducible run (about 40 s extra). A new seed gives a new variant.</p>
          <v-text-field v-model="rerunSeed" label="New seed (blank = random)" type="number" density="comfortable" />
        </v-card-text>
        <v-card-actions>
          <v-btn @click="rerunDialog = false">Cancel</v-btn><v-spacer />
          <v-btn variant="tonal" :loading="busy === 'rerun'" @click="rerun(true)">Same seed</v-btn>
          <v-btn color="primary" variant="flat" :loading="busy === 'rerun'" @click="rerun(false)">New seed</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
  <v-alert v-else-if="err" type="error">{{ err }}</v-alert>
  <v-progress-linear v-else indeterminate color="primary" />
</template>

<style scoped>
.log { font-size: 11px; line-height: 1.35; white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow: auto; margin: 0; }
.picked { outline: 3px solid #2e7d32; }
.checker { background-color: #ddd; background-image: linear-gradient(45deg, #bbb 25%, transparent 25%), linear-gradient(-45deg, #bbb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #bbb 75%), linear-gradient(-45deg, transparent 75%, #bbb 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
</style>
