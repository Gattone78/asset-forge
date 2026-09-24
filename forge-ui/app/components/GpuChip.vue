<script setup lang="ts">
// Health chip in the app bar: comfyui up/down, VRAM, idle countdown. Polls /health every 5 s.
const api = useApi();
const health = ref<Health | null>(null);
let timer: any;
const refresh = async () => { try { health.value = await api.health(); } catch { health.value = null; } };
onMounted(() => { refresh(); timer = setInterval(refresh, 5000); });
onUnmounted(() => clearInterval(timer));
const label = computed(() => {
  const h = health.value; if (!h) return "API offline";
  const g = h.gpu;
  if (!g.comfyui_up) return "GPU idle";
  const vram = g.vram_used_mib != null ? `${(g.vram_used_mib / 1024).toFixed(0)} GB` : "";
  return (h.worker_busy ? "GPU working " : "GPU warm ") + vram;
});
const color = computed(() => !health.value ? "red" : health.value.worker_busy ? "amber" : health.value.gpu.comfyui_up ? "light-green" : "grey-lighten-1");
</script>
<template>
  <v-chip :color="color" variant="flat" size="small" class="mr-3" :prepend-icon="health?.worker_busy ? 'mdi-cog' : 'mdi-memory'">{{ label }}</v-chip>
</template>
