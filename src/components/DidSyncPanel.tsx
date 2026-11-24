import { useState } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import { MistaiError } from "@tik-choco/mistai";
import { formatPairingCode, normalizePairingCode } from "@tik-choco/mistai/identity";
import { Switch } from "@tik-choco/mistai/preact";
import { getUiLanguage, t } from "../i18n";
import { getDidLink, pairDidDelegation, subscribeDidLink } from "../lib/did/pairing";
import { loadSettings, saveSettings } from "../lib/settings";
import { getDidSyncState, subscribeDidSync, syncDidNow } from "../lib/sync/didSync";

function pairingErrorKey(error: unknown): string {
  if (error instanceof MistaiError) {
    switch (error.code) {
      case "INVALID_PAIRING_CODE": return "settings-did-invalid-code";
      case "PAIRING_REJECTED": return "settings-did-rejected";
      case "PAIRING_TIMEOUT": return "settings-did-timeout";
      case "PAIRING_INVALID_DELEGATION": return "settings-did-invalid-delegation";
      case "JOIN_FAILED": return "settings-did-connect-error";
    }
  }
  return "settings-did-pair-error";
}

export function DidSyncPanel({ enabled }: { enabled: boolean }) {
  const link = useSyncExternalStore(subscribeDidLink, getDidLink);
  const sync = useSyncExternalStore(subscribeDidSync, getDidSyncState);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pair() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await pairDidDelegation(code);
      setCode("");
    } catch (err) { setError(pairingErrorKey(err)); }
    finally { setBusy(false); }
  }

  const date = (value: string | number) => new Date(value).toLocaleString(getUiLanguage());
  const status = sync.status === "error" ? sync.error : {
    off: "settings-did-off", connecting: "settings-sync-status-connecting", syncing: "settings-did-syncing",
    idle: sync.peerCount ? null : "settings-did-waiting", "no-delegation": null,
  }[sync.status];
  return <section class="card-panel">
    <h2>{t("settings-did-heading")}</h2>
    <p class="hint-text" title={link.rootDid ?? undefined}>{link.rootDid && link.expiresAt
      ? t("settings-did-linked", { did: link.rootDid.slice(0, 12) + "…" + link.rootDid.slice(-4), expiry: date(link.expiresAt) })
      : t("settings-did-unlinked")}</p>
    <form onSubmit={e => { e.preventDefault(); void pair(); }}>
      <label for="did-pair-code">{t("settings-did-code")}</label>
      <div class="sync-url-row">
        <input id="did-pair-code" value={code} placeholder={t("settings-did-code-format")} aria-describedby="did-pair-hint"
          autoComplete="off" autoCapitalize="characters" spellcheck={false} disabled={busy}
          onInput={e => {
            const input = e.currentTarget.value;
            const normalized = normalizePairingCode(input);
            setCode(normalized ? formatPairingCode(normalized) : input);
            setError(null);
          }} />
        <button type="submit" disabled={busy || !code.trim()}>
          {t(busy ? "settings-did-pairing" : "settings-did-pair")}
        </button>
      </div>
      <p class="hint-text" id="did-pair-hint">{t("settings-did-hint")}</p>
      {error && <p class="error-text" role="alert">{t(error)}</p>}
    </form>
    <div class="did-sync-controls">
      <div class="toggle-row">
        <Switch label={t("settings-did-auto")} checked={enabled}
          onChange={didAutoSync => saveSettings({ ...loadSettings(), didAutoSync })} />
        {t("settings-did-auto")}
      </div>
      <button type="button" onClick={syncDidNow}
        disabled={!enabled || !link.rootDid || sync.status === "connecting" || sync.status === "syncing"}>
        {t("settings-did-now")}
      </button>
    </div>
    <div aria-live="polite">
      {status && <p class={sync.error ? "error-text" : "hint-text"}>{t(status)}</p>}
      {enabled && link.rootDid && <p class="hint-text">{t("settings-did-peers", { count: sync.peerCount })}</p>}
      {link.rootDid && <p class="hint-text">{sync.lastSyncedAt === null ? t("settings-did-never")
        : t("settings-did-last", { time: date(sync.lastSyncedAt) })}</p>}
    </div>
  </section>;
}
