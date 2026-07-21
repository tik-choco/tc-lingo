// The whole 設定 > 同期 UI: start/join a one-shot device-to-device sync
// session, show the QR/URL invite while waiting, and the per-store merge
// summary once done. Pure view over lib/sync/session.ts's module-level
// store (same subscribe*/get* pattern as the domain modules) — this
// component owns no sync logic itself, only rendering per SyncPhase.
import { useEffect, useState } from "preact/hooks";
import { Check, Copy, Loader2, RotateCcw, Users } from "lucide-preact";
import { QrCode } from "./QrCode";
import {
  clearPendingSyncJoin,
  getSyncState,
  joinGuestSync,
  startHostSync,
  stopSync,
  subscribeSync,
  syncUrlFor,
} from "../lib/sync/session";
import type { SyncStoreName } from "../lib/sync/types";
import { t } from "../i18n";

const SUMMARY_STORE_ORDER: SyncStoreName[] = ["cards", "topics", "attempts", "passages", "conversations", "levels"];

const SUMMARY_LABEL_KEYS: Record<SyncStoreName, string> = {
  cards: "settings-sync-store-cards",
  topics: "settings-sync-store-topics",
  attempts: "settings-sync-store-attempts",
  passages: "settings-sync-store-passages",
  conversations: "settings-sync-store-conversations",
  levels: "settings-sync-store-levels",
};

function InviteCard({ url, copied, onCopy }: { url: string; copied: boolean; onCopy: () => void }) {
  return (
    <>
      <div class="sync-qr-card">
        <QrCode text={url} size={200} />
      </div>
      <div class="sync-url-row">
        <input
          type="text"
          readOnly
          value={url}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
          aria-label={t("settings-sync-url-aria-label")}
        />
        <button
          type="button"
          class="icon-button"
          onClick={onCopy}
          title={copied ? t("settings-sync-copy-done") : t("settings-sync-copy-button")}
          aria-label={copied ? t("settings-sync-copy-done") : t("settings-sync-copy-button")}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
    </>
  );
}

export function SyncPanel() {
  const [state, setState] = useState(getSyncState);
  useEffect(() => subscribeSync(() => setState(getSyncState())), []);

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard permission denied/unavailable: the URL is still visible
      // and selectable in the input, so this is a silent no-op.
    }
  }

  // A pending deep-link join takes priority over whatever phase we're
  // otherwise in (normally still "idle" at this point) — the learner must
  // confirm before anything joins the room.
  if (state.pendingJoinRoomId) {
    const roomId = state.pendingJoinRoomId;
    return (
      <section class="card-panel">
        <h2>{t("settings-sync-confirm-heading")}</h2>
        <p class="hint-text">{t("settings-sync-confirm-body")}</p>
        <div class="button-row">
          <button type="button" class="primary-button" onClick={() => joinGuestSync(roomId)}>
            {t("settings-sync-confirm-accept")}
          </button>
          <button type="button" onClick={() => clearPendingSyncJoin()}>
            {t("settings-sync-confirm-cancel")}
          </button>
        </div>
      </section>
    );
  }

  if (state.phase === "idle") {
    return (
      <section class="card-panel">
        <h2>{t("settings-sync-heading")}</h2>
        <p class="hint-text">{t("settings-sync-intro")}</p>
        <p class="hint-text">{t("settings-sync-privacy-hint")}</p>
        <div class="button-row">
          <button type="button" class="primary-button" onClick={() => startHostSync()}>
            {t("settings-sync-start-button")}
          </button>
        </div>
        <p class="hint-text">{t("settings-sync-start-hint")}</p>
      </section>
    );
  }

  if (state.phase === "connecting") {
    return (
      <section class="card-panel">
        <h2>{t("settings-sync-heading")}</h2>
        <p class="sync-status" aria-live="polite">
          <Loader2 size={15} class="sync-spin" />
          {t("settings-sync-status-connecting")}
        </p>
        <div class="button-row">
          <button type="button" onClick={() => stopSync()}>
            {t("settings-sync-abort-button")}
          </button>
        </div>
      </section>
    );
  }

  if (state.phase === "waiting" && state.role === "host") {
    const url = state.roomId ? syncUrlFor(state.roomId) : "";
    return (
      <section class="card-panel">
        <h2>{t("settings-sync-heading")}</h2>
        <InviteCard url={url} copied={copied} onCopy={() => handleCopy(url)} />
        <p class="hint-text">{t("settings-sync-waiting-hint")}</p>
        <p class="sync-status" aria-live="polite">
          {state.peerCount > 0 ? (
            <>
              <Users size={15} />
              {t("settings-sync-status-peer-connected", { count: state.peerCount })}
            </>
          ) : (
            t("settings-sync-status-waiting-host")
          )}
        </p>
        {state.peerCount > 0 && (
          <p class="hint-text sync-debug-line">
            {t("settings-sync-debug-line", {
              hello: state.debug.helloReceived,
              sent: state.debug.dataChunksSent,
              received: state.debug.dataChunksReceived,
            })}
          </p>
        )}
        <div class="button-row">
          <button type="button" onClick={() => stopSync()}>
            {t("settings-sync-abort-button")}
          </button>
        </div>
      </section>
    );
  }

  if (state.phase === "waiting" || state.phase === "exchanging") {
    const statusKey =
      state.phase === "exchanging" ? "settings-sync-status-exchanging" : "settings-sync-status-waiting-guest";
    return (
      <section class="card-panel">
        <h2>{t("settings-sync-heading")}</h2>
        <p class="sync-status" aria-live="polite">
          <Loader2 size={15} class="sync-spin" />
          {t(statusKey)}
        </p>
        <p class="hint-text sync-debug-line">
          {t("settings-sync-debug-line", {
            hello: state.debug.helloReceived,
            sent: state.debug.dataChunksSent,
            received: state.debug.dataChunksReceived,
          })}
        </p>
        <div class="button-row">
          <button type="button" onClick={() => stopSync()}>
            {t("settings-sync-abort-button")}
          </button>
        </div>
      </section>
    );
  }

  if (state.phase === "done") {
    const summary = state.summary;
    const rows = summary
      ? SUMMARY_STORE_ORDER.map((store) => ({ store, counts: summary[store] })).filter(
          ({ counts }) => counts.added + counts.updated + counts.removed > 0,
        )
      : [];
    const url = state.role === "host" && state.roomId ? syncUrlFor(state.roomId) : "";
    return (
      <section class="card-panel">
        <h2>{t("settings-sync-done-heading")}</h2>
        {rows.length === 0 ? (
          <p class="hint-text">{t("settings-sync-done-no-changes")}</p>
        ) : (
          <ul class="sync-summary-list">
            {rows.map(({ store, counts }) => (
              <li key={store} class="sync-summary-row">
                <span class="sync-summary-store">{t(SUMMARY_LABEL_KEYS[store])}</span>
                <span class="sync-summary-counts">
                  {t("settings-sync-summary-counts", {
                    added: counts.added,
                    updated: counts.updated,
                    removed: counts.removed,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
        {state.role === "host" ? (
          <>
            <p class="hint-text">{t("settings-sync-done-host-more-hint")}</p>
            <InviteCard url={url} copied={copied} onCopy={() => handleCopy(url)} />
          </>
        ) : null}
        <div class="button-row">
          <button type="button" onClick={() => stopSync()}>
            {t("settings-sync-finish-button")}
          </button>
        </div>
      </section>
    );
  }

  // phase === "error"
  return (
    <section class="card-panel">
      <h2>{t("settings-sync-heading")}</h2>
      <p class="error-text" aria-live="polite">
        {state.error ? t(state.error) : t("settings-sync-error-connect")}
      </p>
      <div class="button-row">
        <button type="button" onClick={() => stopSync()}>
          {t("settings-sync-close-button")}
        </button>
        {state.role === "host" ? (
          <button type="button" class="primary-button" onClick={() => startHostSync()}>
            <RotateCcw size={15} />
            {t("settings-sync-retry-button")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
