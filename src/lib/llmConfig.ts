// Shared schema and storage belong to mistai. App reads migrate on load.
export * from "@tik-choco/mistai/llm-config";
import { loadLlmConfig as load, migrateSharedLlmConfig, saveLlmConfig } from "@tik-choco/mistai/llm-config";

export function loadLlmConfig() {
  const config = load();
  if (config && migrateSharedLlmConfig(config).changed) saveLlmConfig(config);
  return config;
}
