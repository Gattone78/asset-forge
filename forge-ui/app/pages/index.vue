<script setup lang="ts">
// Job list with status chips, filters by game/profile/status, and the new-job form (req §6).
const api = useApi();
const router = useRouter();
const jobs = ref<Job[]>([]);
const profiles = ref<{ name: string; game: string; file: string }[]>([]);
const filter = reactive({ status: null as string | null, profile: null as string | null, game: null as string | null, batch: null as string | null });
const batches = computed(() => [...new Set(jobs.value.map((j) => j.request.batch).filter(Boolean))] as string[]);
// Batch "set view": when a batch is selected, show its thumbnails as a tight grid so the set reads as one style.
const setView = computed(() => !!filter.batch);
const loading = ref(false);
const error = ref("");
let timer: any;

const gameOf = (profile: string) => profiles.value.find((p) => p.name === profile)?.game ?? "";
const filtered = computed(() => jobs.value.filter((j) =>
  (!filter.status || j.status === filter.status) && (!filter.profile || j.request.profile === filter.profile) && (!filter.game || gameOf(j.request.profile) === filter.game) && (!filter.batch || j.request.batch === filter.batch)));
const games = computed(() => [...new Set(profiles.value.map((p) => p.game))]);
const anyActive = computed(() => jobs.value.some((j) => ACTIVE.has(j.status)));

async function refresh() {
  try { jobs.value = await api.jobs({ limit: "200" }); error.value = ""; } catch (e: any) { error.value = "API unreachable"; }
}
onMounted(async () => {
  const qb = useRoute().query.batch; if (typeof qb === "string" && qb) filter.batch = qb;
  try { profiles.value = await api.profiles(); } catch {}
  await refresh();
  timer = setInterval(() => { if (anyActive.value || document.visibilityState === "visible") refresh(); }, 3000);
});
onUnmounted(() => clearInterval(timer));

// ---- new job ----
const dialog = ref(false);
const form = reactive({ type: "creature", prompt: "", profile: "meadowbots-flat", seed: "" as string | number, height_m: "" as string | number, count: 4, rig: false, batch: "",
  kind: "sprite", transparent: true, seamless: false, aspect: "16:9", duration_s: 5, init_image: "", fast: true,
  audio_duration: "" as string | number, audio_count: 4, loop: false, bpm: "" as string | number, key: "", voice: "af_heart", speed: 1.0, clip: "" });
const isAudio = computed(() => ["sfx", "music", "speech", "foley"].includes(form.type));
// Phase 8: photo-driven jobs pick from the uploads list (Uploads page adds photos).
const isPhoto = computed(() => form.type === "promo" || form.type === "model");
const uploads = ref<Upload[]>([]);
const photoForm = reactive({ photo: "" as string, photos: [] as string[], style: "pixar", script: "", narration_at: 1, music: true, foley: true, music_prompt: "", title: "", duration_s: 5, aspect: "16:9", humanoid: false });
const styles = ["realistic", "pixar", "2d", "toy"];
watch(dialog, async (open) => { if (open) { try { uploads.value = await api.uploads(); } catch {} } });
async function addPhoto(files: File | File[] | null) {
  const list = (Array.isArray(files) ? files : files ? [files] : []).filter(Boolean);
  for (const f of list) { try { const u = await api.upload(f); uploads.value.unshift(u); if (form.type === "promo") photoForm.photo = u.id; else photoForm.photos.push(u.id); } catch (e: any) { error.value = e?.data?.error ?? String(e); } }
}
watch(() => form.kind, (k) => { form.transparent = k === "sprite"; form.seamless = k !== "sprite"; });
const submitting = ref(false);
async function submit() {
  if (!form.prompt.trim() && form.type !== "foley") return;
  submitting.value = true;
  try {
    const job = await api.create({ type: form.type, prompt: form.prompt.trim(), profile: form.profile, count: Number(form.count) || 4,
      promo: form.type === "promo" ? { photo: photoForm.photo, style: photoForm.style, duration_s: Number(photoForm.duration_s) || 5, aspect: photoForm.aspect, script: photoForm.script.trim() || undefined,
        narration_at_s: Number(photoForm.narration_at) || 1, music: photoForm.music, foley: photoForm.foley, music_prompt: photoForm.music_prompt.trim() || undefined, title: photoForm.title.trim() || undefined } : undefined,
      model: form.type === "model" ? { photos: photoForm.photos, style: photoForm.style, humanoid: photoForm.humanoid } : undefined,
      audio: isAudio.value ? { duration_s: form.audio_duration === "" ? undefined : Number(form.audio_duration), count: Number(form.audio_count) || 4, loop: form.loop,
        bpm: form.bpm === "" ? undefined : Number(form.bpm), key: form.key.trim() || undefined, voice: form.voice.trim() || undefined, speed: Number(form.speed) || 1, clip: form.clip.trim() || undefined } : undefined,
      seed: form.seed === "" ? undefined : Number(form.seed), height_m: form.height_m === "" ? undefined : Number(form.height_m), rig: form.rig,
      batch: form.batch.trim() || undefined, image: form.type === "image" ? { kind: form.kind, transparent: form.transparent, seamless: form.seamless } : undefined,
      video: form.type === "video" ? { aspect: form.aspect, duration_s: Number(form.duration_s) || 5, init_image: form.init_image.trim() || undefined, fast: form.fast } : undefined } as any);
    dialog.value = false; form.prompt = "";
    router.push(`/jobs/${job.id}`);
  } catch (e: any) { error.value = e?.data?.error ?? String(e); } finally { submitting.value = false; }
}
const thumb = (j: Job) => j.status === "review" || j.status === "approved" || j.status === "rejected" ? api.assetUrl(j.id, "out/thumb.png") : null;
</script>

<template>
  <div>
    <v-row dense class="align-center mb-2">
      <v-col cols="4" sm="auto"><v-select v-model="filter.status" :items="['queued', 'running', 'review', 'approved', 'rejected', 'failed']" label="Status" density="compact" hide-details clearable style="min-width: 110px" /></v-col>
      <v-col cols="4" sm="auto"><v-select v-model="filter.game" :items="games" label="Game" density="compact" hide-details clearable style="min-width: 110px" /></v-col>
      <v-col cols="4" sm="auto"><v-select v-model="filter.profile" :items="profiles.map(p => p.name)" label="Profile" density="compact" hide-details clearable style="min-width: 140px" /></v-col>
      <v-col v-if="batches.length" cols="12" sm="auto"><v-select v-model="filter.batch" :items="batches" label="Batch" density="compact" hide-details clearable style="min-width: 160px" /></v-col>
      <v-spacer />
      <v-col cols="12" sm="auto"><v-btn color="primary" prepend-icon="mdi-plus" block @click="dialog = true">New job</v-btn></v-col>
    </v-row>
    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>

    <v-row v-if="setView" dense>
      <v-col v-for="j in filtered" :key="j.id" cols="6" sm="4" md="3" lg="2">
        <v-card :to="`/jobs/${j.id}`" hover>
          <v-img v-if="thumb(j)" :src="thumb(j)!" aspect-ratio="1" cover />
          <div v-else class="d-flex align-center justify-center bg-grey-lighten-3" style="aspect-ratio: 1"><v-progress-circular v-if="ACTIVE.has(j.status)" :model-value="j.progress * 100" :indeterminate="j.status === 'queued'" color="primary" size="40" /><v-icon v-else color="grey">mdi-alert-circle-outline</v-icon></div>
          <v-card-text class="py-1 px-2"><div class="text-caption text-truncate" :title="j.request.prompt">{{ j.request.prompt }}</div><div class="text-caption text-medium-emphasis">seed {{ j.request.seed }} · {{ j.status }}</div></v-card-text>
        </v-card>
      </v-col>
    </v-row>
    <v-row v-else dense>
      <v-col v-for="j in filtered" :key="j.id" cols="12" sm="6" md="4">
        <v-card :to="`/jobs/${j.id}`" hover>
          <v-img v-if="thumb(j)" :src="thumb(j)!" height="180" cover />
          <div v-else class="d-flex align-center justify-center bg-grey-lighten-3" style="height: 180px">
            <v-progress-circular v-if="ACTIVE.has(j.status)" :model-value="j.progress * 100" :indeterminate="j.status === 'queued'" color="primary" size="56" width="5">
              <small>{{ Math.round(j.progress * 100) }}%</small>
            </v-progress-circular>
            <v-icon v-else size="48" color="grey">mdi-alert-circle-outline</v-icon>
          </div>
          <v-card-text class="pb-2">
            <div class="d-flex align-center ga-2 mb-1">
              <v-chip :color="STATUS_COLOR[j.status]" size="x-small" variant="flat" label>{{ j.status }}</v-chip>
              <v-chip v-if="j.request.batch" size="x-small" variant="tonal" label prepend-icon="mdi-view-grid" @click.prevent="filter.batch = j.request.batch">{{ j.request.batch }}</v-chip>
              <span v-if="ACTIVE.has(j.status)" class="text-caption">{{ j.stage }}</span>
              <v-spacer />
              <span class="text-caption text-medium-emphasis">{{ ago(j.created_at) }}</span>
            </div>
            <div class="text-body-2 text-truncate" :title="j.request.prompt">{{ j.request.prompt }}</div>
            <div class="text-caption text-medium-emphasis">{{ j.request.type }} · {{ j.request.profile }} · seed {{ j.request.seed }} · {{ short(j.id) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col v-if="!filtered.length && !error" cols="12"><v-card variant="tonal"><v-card-text>No jobs yet. Create one.</v-card-text></v-card></v-col>
    </v-row>

    <v-dialog v-model="dialog" max-width="560" :fullscreen="$vuetify.display.xs">
      <v-card title="New job">
        <v-card-text>
          <v-select v-model="form.type" :items="['creature', 'prop', 'plant', 'image', 'video', 'sfx', 'music', 'speech', 'foley', 'promo', 'model']" label="Type" density="comfortable" />
          <template v-if="isPhoto">
            <div class="d-flex flex-wrap ga-3 align-center mb-2">
              <v-select v-model="photoForm.style" :items="styles" label="Style" density="compact" hide-details style="max-width: 160px" />
              <v-file-input label="Add photo" accept="image/png,image/jpeg,image/webp" :multiple="form.type === 'model'" density="compact" hide-details prepend-icon="mdi-camera" style="max-width: 260px" @update:model-value="addPhoto" />
            </div>
            <div v-if="uploads.length" class="d-flex flex-wrap ga-2 mb-2">
              <v-avatar v-for="u in uploads.slice(0, 24)" :key="u.id" size="56" rounded="lg" :style="{ outline: (form.type === 'promo' ? photoForm.photo === u.id : photoForm.photos.includes(u.id)) ? '3px solid #2e7d32' : '1px solid #ccc', cursor: 'pointer' }" :title="u.name"
                @click="form.type === 'promo' ? (photoForm.photo = u.id) : (photoForm.photos.includes(u.id) ? photoForm.photos.splice(photoForm.photos.indexOf(u.id), 1) : photoForm.photos.push(u.id))">
                <v-img :src="api.uploadUrl(u.id)" cover />
              </v-avatar>
            </div>
            <div v-else class="text-caption text-medium-emphasis mb-2">No uploads yet: add a photo above (or on the Uploads page).</div>
            <template v-if="form.type === 'promo'">
              <v-text-field v-model="photoForm.script" label="Narration script (optional)" density="comfortable" hint="spoken by Kokoro over the clip" persistent-hint class="mb-2" />
              <div class="d-flex flex-wrap ga-3 align-center mb-2">
                <v-btn-toggle v-model="photoForm.aspect" mandatory density="comfortable" variant="outlined" divided><v-btn value="16:9">16:9</v-btn><v-btn value="9:16">9:16</v-btn></v-btn-toggle>
                <v-text-field v-model="photoForm.duration_s" label="Seconds" type="number" min="1" max="10" density="compact" hide-details style="max-width: 100px" />
                <v-switch v-model="photoForm.music" label="music" color="primary" density="compact" hide-details />
                <v-switch v-model="photoForm.foley" label="sound effects" color="primary" density="compact" hide-details />
              </div>
              <v-text-field v-model="photoForm.title" label="Title card (optional)" density="compact" hide-details class="mb-2" />
            </template>
            <v-switch v-if="form.type === 'model'" v-model="photoForm.humanoid" label="the subject is a person (humanoid skeleton)" color="primary" density="compact" hide-details class="mb-2" />
          </template>
          <template v-if="form.type === 'sfx'">
            <div class="d-flex flex-wrap ga-3 align-center mb-2">
              <v-text-field v-model="form.audio_duration" label="Seconds" type="number" min="0.5" max="30" placeholder="4" density="compact" hide-details style="max-width: 110px" />
              <v-text-field v-model="form.audio_count" label="Variations" type="number" min="1" max="8" density="compact" hide-details style="max-width: 110px" />
            </div>
          </template>
          <template v-if="form.type === 'music'">
            <div class="d-flex flex-wrap ga-3 align-center mb-2">
              <v-text-field v-model="form.audio_duration" label="Seconds" type="number" min="5" max="300" placeholder="30" density="compact" hide-details style="max-width: 110px" />
              <v-text-field v-model="form.bpm" label="BPM" type="number" placeholder="profile" density="compact" hide-details style="max-width: 100px" />
              <v-text-field v-model="form.key" label="Key" placeholder="C major" density="compact" hide-details style="max-width: 120px" />
              <v-switch v-model="form.loop" label="seamless loop" color="primary" density="compact" hide-details />
            </div>
          </template>
          <template v-if="form.type === 'speech'">
            <div class="d-flex flex-wrap ga-3 align-center mb-2">
              <v-text-field v-model="form.voice" label="Voice (Kokoro id)" density="compact" hide-details style="max-width: 200px" hint="af_heart, am_michael, bf_emma, bm_george …" />
              <v-text-field v-model="form.speed" label="Speed" type="number" step="0.05" min="0.5" max="2" density="compact" hide-details style="max-width: 100px" />
            </div>
          </template>
          <v-text-field v-if="form.type === 'foley'" v-model="form.clip" label="Video job id (finished)" density="comfortable" hint="MMAudio generates sound synchronised to that clip; the prompt is optional" persistent-hint class="mb-2" />
          <template v-if="form.type === 'video'">
            <div class="d-flex flex-wrap ga-3 align-center mb-2">
              <v-btn-toggle v-model="form.aspect" mandatory density="comfortable" variant="outlined" divided><v-btn value="16:9">16:9</v-btn><v-btn value="9:16">9:16</v-btn></v-btn-toggle>
              <v-text-field v-model="form.duration_s" label="Seconds" type="number" min="1" max="10" density="compact" hide-details style="max-width: 110px" />
              <v-switch v-model="form.fast" label="fast (4-step)" color="primary" density="compact" hide-details />
            </div>
            <v-text-field v-model="form.init_image" label="Init image (optional): job id, or job id/out/thumb.png" density="comfortable" hint="image-to-video from an approved asset's thumbnail" persistent-hint class="mb-2" />
          </template>
          <v-textarea v-model="form.prompt" :label="form.type === 'speech' ? 'Text to speak' : form.type === 'foley' ? 'Sound hint (optional)' : 'Prompt'" rows="3" auto-grow placeholder="a round friendly garden robot with big eyes" autofocus />
          <template v-if="form.type === 'image'">
            <v-btn-toggle v-model="form.kind" mandatory density="comfortable" variant="outlined" divided class="mb-3">
              <v-btn value="sprite">sprite</v-btn><v-btn value="texture">texture</v-btn><v-btn value="tile">tile</v-btn>
            </v-btn-toggle>
            <div class="d-flex flex-wrap ga-4"><v-switch v-model="form.transparent" label="transparent background" color="primary" density="compact" hide-details /><v-switch v-model="form.seamless" label="seamless (tile check)" color="primary" density="compact" hide-details /></div>
          </template>
          <v-select v-model="form.profile" :items="profiles.map(p => p.name)" label="Profile" density="comfortable" />
          <v-row dense>
            <v-col cols="4"><v-text-field v-model="form.seed" label="Seed" type="number" density="comfortable" hint="blank = random" persistent-hint /></v-col>
            <v-col cols="4"><v-text-field v-model="form.height_m" label="Height (m)" type="number" step="0.05" density="comfortable" hint="blank = profile" persistent-hint /></v-col>
            <v-col cols="4"><v-text-field v-model="form.count" label="Candidates" type="number" min="1" max="8" density="comfortable" /></v-col>
          </v-row>
          <v-switch v-if="form.type !== 'image' && form.type !== 'video' && !isAudio && form.type !== 'promo'" v-model="form.rig" :label="form.type === 'model' ? 'Auto-rig the model (UniRig)' : 'Auto-rig (creatures only, adds ~30 s)'" color="primary" :disabled="form.type !== 'creature' && form.type !== 'model'" hide-details />
          <v-text-field v-model="form.batch" label="Batch label (optional)" density="comfortable" hint="jobs with the same label show as a set" persistent-hint class="mt-2" />
        </v-card-text>
        <v-card-actions>
          <v-spacer /><v-btn @click="dialog = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="submitting" :disabled="(!form.prompt.trim() && form.type !== 'foley') || (form.type === 'promo' && !photoForm.photo) || (form.type === 'model' && !photoForm.photos.length)" @click="submit">Create</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
