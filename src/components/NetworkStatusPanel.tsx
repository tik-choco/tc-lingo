// Thin wrapper around @tik-choco/mistai/preact's ProviderStatusPanel (shared
// LLM Network UI - markup/styling live in the library, imported via
// @tik-choco/mistai/ui.css in app.tsx). Ported from tc-translate's
// src/components/NetworkStatusPanel.tsx, trimmed to the provider-side panel
// only: tc-lingo's AI Network tab keeps its own hand-rolled consumer step
// indicator (SettingsView's NETWORK_STEPS), so the consumer wrapper isn't
// needed here.
import { MESSAGES_EN, MESSAGES_JA, type ProviderLogEntry } from "@tik-choco/mistai";
import { ProviderStatusPanel } from "@tik-choco/mistai/preact";
import { getUiLanguage, t } from "../i18n";
import type { NetworkProviderPeer, NetworkProviderStatus } from "../hooks/useNetworkProvider";

// mistai only ships en/ja catalogs; zh-CN/zh-TW fall back to English, same as
// tc-translate's wrapper.
function mistaiMessages() {
  return getUiLanguage() === "ja" ? MESSAGES_JA : MESSAGES_EN;
}

type NetworkProviderStatusPanelProps = {
  providerStatus: NetworkProviderStatus;
  /** Timestamp (ms) of the last status transition; shown as "· HH:MM:SS" in the summary line. */
  providerStatusUpdatedAt?: number;
  providerError: string;
  ownNodeId: string;
  peers: NetworkProviderPeer[];
  consumerCount: number;
  logs: ProviderLogEntry[];
  upstreamConfigured: boolean;
};

export function NetworkProviderStatusPanel({
  providerStatus,
  providerStatusUpdatedAt,
  providerError,
  ownNodeId,
  peers,
  consumerCount,
  logs,
  upstreamConfigured,
}: NetworkProviderStatusPanelProps) {
  return (
    <ProviderStatusPanel
      status={providerStatus}
      statusUpdatedAt={providerStatusUpdatedAt}
      errorMessage={providerError}
      ownNodeId={ownNodeId}
      peers={peers}
      consumerCount={consumerCount}
      logs={logs}
      messages={mistaiMessages()}
      notice={
        !upstreamConfigured ? (
          <p class="mistai-status-detail error">{t("settings-network-provider-upstream-missing")}</p>
        ) : null
      }
    />
  );
}
