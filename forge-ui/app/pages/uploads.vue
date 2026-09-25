<script setup lang="ts">
// Uploads (Phase 8): photos that photo-driven jobs (promo, model) start from. Stored on the VM under /srv/forge/uploads,
// independent of jobs; deleting is refused while a job references the upload.
const api = useApi();
const items = ref<Upload[]>([]);
const busy = ref(false);
const error = ref("");
async function refresh() { try { items.value = await api.uploads(); error.value = ""; } catch { error.value = "API unreachable"; } }
onMounted(refresh);
async function onFiles(files: File | File[] | null) {
  const list = (Array.isArray(files) ? files : files ? [files] : []).filter(Boolean);
  if (!list.length) return;
  busy.value = true;
  try { for (const f of list) await api.upload(f); await refresh(); } catch (e: any) { error.value = e?.data?.error ?? String(e); } finally { busy.value = false; }
}
async function remove(u: Upload) {
  try { await api.deleteUpload(u.id); await refresh(); } catch (e: any) { error.value = e?.data?.error ?? String(e); }
}
const copy = (t: string) => navigator.clipboard?.writeText(t);
</script>

<template>
  <div>
    <div class="d-flex flex-wrap align-center ga-3 mb-3">
      <h2 class="text-h6">Uploads</h2>
      <v-spacer />
      <v-file-input label="Add photos" accept="image/png,image/jpeg,image/webp" multiple density="compact" hide-details prepend-icon="mdi-camera" :loading="busy" style="max-width: 320px" @update:model-value="onFiles" />
    </div>
    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-row dense>
      <v-col v-for="u in items" :key="u.id" cols="6" sm="4" md="3" lg="2">
        <v-card>
          <v-img :src="api.uploadUrl(u.id)" aspect-ratio="1" cover />
          <v-card-text class="py-1 px-2">
            <div class="text-caption text-truncate" :title="u.name">{{ u.name }}</div>
            <div class="text-caption text-medium-emphasis">{{ u.width }}×{{ u.height }} · {{ fmtBytes(u.bytes) }} · {{ ago(u.uploaded_at) }}</div>
            <div class="d-flex align-center">
              <code class="text-caption" style="cursor: pointer" :title="u.id" @click="copy(u.id)">{{ short(u.id) }}</code>
              <v-spacer />
              <v-btn icon="mdi-delete-outline" size="x-small" variant="text" @click="remove(u)" />
            </div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col v-if="!items.length && !error" cols="12"><v-card variant="tonal"><v-card-text>No uploads yet. Add a photo, then create a <b>promo</b> or <b>model</b> job from it.</v-card-text></v-card></v-col>
    </v-row>
  </div>
</template>
