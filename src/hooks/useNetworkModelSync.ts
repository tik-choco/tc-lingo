import { useEffect } from "preact/hooks";
import { emptyLlmConfig, ensurePreset, ensureProvider, loadLlmConfig, normalizeBaseUrl, saveLlmConfig } from "../lib/llmConfig";
import { NETWORK_PROVIDER_LABEL, networkProviderBaseUrl } from "../lib/networkModels";
import type { ConsumerStatus } from "../lib/network";
import type { LingoSettings } from "../types";

/**
 * Mirrors the model names advertised by AI Network room providers (their
 * preset labels, falling back to model ids - see advertisedModelName in
 * lib/networkModels.ts) into the shared llm config, so they show up as
 * ordinary presets - under a `mist-network://<roomId>` pseudo-provider - that
 * the user can pick as their default/per-task/TTS preset just like a preset
 * backed by a real HTTP provider (see resolvePreset in lib/llmConfig.ts,
 * which doesn't distinguish the two). Ported from tc-translate's
 * hooks/useNetworkModelSync.ts (see
 * tc-docs/drafts/llm-settings-common-v1.md §4.4).
 *
 * A mirror, not an append-only import: while connected, presets under the
 * room's pseudo-provider whose model is no longer advertised are pruned, so
 * a provider unchecking a shared model makes its card disappear here as soon
 * as the re-broadcast provider_hello lands (see the hello re-broadcast in
 * hooks/useMistaiProvider.ts). Pruning is scoped strictly to the current
 * room's pseudo-provider - entries this sync itself created - so the shared
 * config's append-only convention for OTHER apps' providers/presets still
 * holds. A disconnect ("searching"/error) is NOT a prune trigger: offline
 * isn't the same as un-shared, so imported cards survive reconnects.
 *
 * Unlike tc-translate's version (which threads a reactive `SharedLlmConfigState`
 * through), this app has no such wrapper - the shared config is loaded fresh
 * each time this effect actually has work to do, mutated directly (this app's
 * `lib/llmConfigOps.ts` CRUD helpers each independently load-mutate-save,
 * which would fragment this multi-step add+prune into several separate
 * writes/re-renders if used here), and saved once.
 *
 * Only runs while actively consuming via the network transport
 * (`settings.connectionMode === 'network'`) and connected to a room
 * (`ConsumerStatus`, see lib/network.ts). Writes are skipped entirely when
 * the mirrored set already matches, so reconnects/re-renders don't thrash
 * localStorage or retrigger the cross-tab `storage` event on every tick.
 */
export function useNetworkModelSync(settings: LingoSettings, consumerStatus: ConsumerStatus, roomId: string): void {
  const connected = consumerStatus.phase === "connected";
  const models = connected ? consumerStatus.models : undefined;
  // Deduped/sorted/joined into a single string so the effect below only
  // reruns when the actual model set changes, not on every re-render that
  // produces a new (but equivalent) models array reference.
  const modelsKey = models && models.length ? [...new Set(models)].sort().join("\n") : "";

  useEffect(() => {
    if (settings.connectionMode !== "network" || !connected) return;

    const baseUrl = networkProviderBaseUrl(roomId);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const modelList = modelsKey ? modelsKey.split("\n") : [];
    const modelSet = new Set(modelList);

    const config = loadLlmConfig() ?? emptyLlmConfig();
    const provider = config.providers.find((p) => p.baseUrl === normalizedBaseUrl && p.apiKey === "");

    // No-op check mirroring the save below against the current config, so
    // saveLlmConfig - which re-renders every consumer of the shared config -
    // is only called when there's actually something to add or prune. The
    // dedup keys match ensureProvider's/ensurePreset's own (baseUrl+apiKey
    // for the provider; providerId+model+temperature+reasoningEffort for
    // each preset).
    const inSync =
      provider === undefined
        ? modelList.length === 0
        : modelList.length === 0
          ? false // provider row lingers although nothing is advertised any more
          : config.presets.every((preset) => preset.providerId !== provider.id || modelSet.has(preset.model)) &&
            modelList.every((model) =>
              config.presets.some(
                (preset) =>
                  preset.providerId === provider.id &&
                  preset.model === model &&
                  preset.temperature === undefined &&
                  preset.reasoningEffort === undefined,
              ),
            );
    if (inSync) return;

    if (modelList.length === 0) {
      // Connected, but the room advertises nothing (everything was
      // un-shared): drop the imported presets and the now-empty
      // pseudo-provider row itself.
      if (!provider) return;
      config.presets = config.presets.filter((p) => p.providerId !== provider.id);
      if (config.defaultPresetId && !config.presets.some((p) => p.id === config.defaultPresetId)) {
        config.defaultPresetId = config.presets[0]?.id ?? "";
      }
      config.providers = config.providers.filter((p) => p.id !== provider.id);
      saveLlmConfig(config);
      return;
    }

    const providerId = ensureProvider(config, { label: NETWORK_PROVIDER_LABEL, baseUrl, apiKey: "" });
    for (const model of modelList) {
      ensurePreset(config, { providerId, model, label: model });
    }
    const stalePresetIds = new Set(
      config.presets.filter((p) => p.providerId === providerId && !modelSet.has(p.model)).map((p) => p.id),
    );
    if (stalePresetIds.size > 0) {
      config.presets = config.presets.filter((p) => !stalePresetIds.has(p.id));
      if (config.defaultPresetId && stalePresetIds.has(config.defaultPresetId)) {
        config.defaultPresetId = config.presets[0]?.id ?? "";
      }
    }
    saveLlmConfig(config);
  }, [settings.connectionMode, roomId, connected, modelsKey]);
}
