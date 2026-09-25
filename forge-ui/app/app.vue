<template>
  <v-app>
    <v-app-bar color="primary" density="comfortable" flat>
      <v-app-bar-title>
        <NuxtLink to="/" class="text-white text-decoration-none font-weight-bold">Asset Forge</NuxtLink>
      </v-app-bar-title>
      <v-btn to="/uploads" variant="text" class="text-white" prepend-icon="mdi-camera" size="small">Uploads</v-btn>
      <GpuChip />
    </v-app-bar>
    <v-main>
      <v-container class="pa-3 pa-sm-4" style="max-width: 1100px">
        <NuxtPage />
      </v-container>
    </v-main>
  </v-app>
</template>
