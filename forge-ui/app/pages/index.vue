<script setup lang="ts">
// Job list with status chips, filters by game/profile/status, and the new-job form (req §6).
const api = useApi();
const router = useRouter();
const jobs = ref<Job[]>([]);
const profiles = ref<{ name: string; game: string; file: string }[]>([]);
const filter = reactive({ status: null as string | null, profile: null as string | null, game: null as string | null });
const loading = ref(false);
const error = ref("");
let timer: any;

const gameOf = (profile: string) => profiles.value.find((p) => p.name === profile)?.game ?? "";
const filtered = computed(() => jobs.value.filter((j) =>
  (!filter.status || j.status === filter.status) && (!filter.profile || j.request.profile === filter.profile) && (!filter.game || gameOf(j.request.profile) === filter.game)));
const games = computed(() => [...new Set(profiles.value.map((p) => p.game))]);
const anyActive = computed(() => jobs.value.some((j) => ACTIVE.has(j.status)));

async function refresh() {
  try { jobs.value = await api.jobs({ limit: "200" }); error.value = ""; } catch (e: any) { error.value = "API unreachable"; }
}
onMounted(async () => {
  try { profiles.value = await api.profiles(); } catch {}
  await refresh();
  timer = setInterval(() => { if (anyActive.value || document.visibilityState === "visible") refresh(); }, 3000);
});
onUnmounted(() => clearInterval(timer));

// ---- new job ----
const dialog = ref(false);
const form = reactive({ type: "creature", prompt: "", profile: "meadowbots-flat", seed: "" as string | number, height_m: "" as string | number, count: 4, rig: false });
const submitting = ref(false);
async function submit() {
  if (!form.prompt.trim()) return;
  submitting.value = true;
  try {
    const job = await api.create({ type: form.type, prompt: form.prompt.trim(), profile: form.profile, count: Number(form.count) || 4,
      seed: form.seed === "" ? undefined : Number(form.seed), height_m: form.height_m === "" ? undefined : Number(form.height_m), rig: form.rig });
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
      <v-spacer />
      <v-col cols="12" sm="auto"><v-btn color="primary" prepend-icon="mdi-plus" block @click="dialog = true">New job</v-btn></v-col>
    </v-row>
    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>

    <v-row dense>
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
          <v-select v-model="form.type" :items="['creature', 'prop', 'plant']" label="Type" density="comfortable" />
          <v-textarea v-model="form.prompt" label="Prompt" rows="3" auto-grow placeholder="a round friendly garden robot with big eyes" autofocus />
          <v-select v-model="form.profile" :items="profiles.map(p => p.name)" label="Profile" density="comfortable" />
          <v-row dense>
            <v-col cols="4"><v-text-field v-model="form.seed" label="Seed" type="number" density="comfortable" hint="blank = random" persistent-hint /></v-col>
            <v-col cols="4"><v-text-field v-model="form.height_m" label="Height (m)" type="number" step="0.05" density="comfortable" hint="blank = profile" persistent-hint /></v-col>
            <v-col cols="4"><v-text-field v-model="form.count" label="Candidates" type="number" min="1" max="8" density="comfortable" /></v-col>
          </v-row>
          <v-switch v-model="form.rig" label="Auto-rig (creatures only, adds ~30 s)" color="primary" :disabled="form.type !== 'creature'" hide-details />
        </v-card-text>
        <v-card-actions>
          <v-spacer /><v-btn @click="dialog = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="submitting" :disabled="!form.prompt.trim()" @click="submit">Create</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
