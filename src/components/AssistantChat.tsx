import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { Check, Copy, MessageCircleQuestionMark, Send, Trash2, X } from "lucide-preact";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { useShortcuts } from "../hooks/useShortcuts";
import { t } from "../i18n";
import {
  loadAssistantHistory,
  loadAssistantIncludeScreen,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  requestAssistantReply,
  saveAssistantHistory,
  saveAssistantIncludeScreen,
} from "../lib/assistantChat";
import { getAssistantContext, subscribeAssistantContext } from "../lib/assistantContext";
import { SHORTCUT_PRIORITY } from "../lib/keyboard";
import { connectionForTask } from "../lib/llmConnection";
import { localizeNetworkError } from "../lib/network";
import { loadSettings } from "../lib/settings";
import { MarkdownView } from "./MarkdownView";
import "../styles/assistant.css";

/** Copies one reply's raw Markdown source; flips to a check mark briefly. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("assistant-copied") : t("assistant-copy");
  return (
    <button type="button" class="assistant-copy-button" aria-label={label} title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
      }}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

interface AssistantChatProps {
  open: boolean;
  mobile: boolean;
  headerRef: RefObject<HTMLElement>;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}

export function AssistantChat({ open, mobile, headerRef, onOpenChange, onOpenSettings }: AssistantChatProps) {
  const { connection } = useLlmConnection("assistant");
  const [messages, setMessages] = useState(loadAssistantHistory);
  const [includeScreen, setIncludeScreen] = useState(loadAssistantIncludeScreen);
  const [context, setContext] = useState(getAssistantContext);
  const [draft, setDraft] = useState("");
  const [partial, setPartial] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; cause?: unknown } | null>(null);
  const [headerBottom, setHeaderBottom] = useState(0);
  const activeRequest = useRef<symbol | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);

  useLayoutEffect(() => {
    const unsubscribe = subscribeAssistantContext(setContext);
    setContext(getAssistantContext());
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!open || mobile || !header) return;
    const measure = () => setHeaderBottom(header.getBoundingClientRect().bottom);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    if (header.parentElement) observer.observe(header.parentElement);
    return () => observer.disconnect();
  }, [open, mobile, headerRef]);

  useLayoutEffect(() => {
    if (open) {
      // Leave the software keyboard closed until the learner taps the input.
      (mobile ? panelRef.current : inputRef.current)?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      returnFocus.current = false;
      launcherRef.current?.focus({ preventScroll: true });
    }
  }, [open, mobile]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [open, messages, partial, failure]);

  useEffect(() => () => { activeRequest.current = null; }, []);

  function close() {
    returnFocus.current = panelRef.current?.contains(document.activeElement) ?? false;
    onOpenChange(false);
  }

  useShortcuts(SHORTCUT_PRIORITY.view + 1, (e) => {
    if (!open || e.key !== "Escape" || e.isComposing || e.keyCode === 229) return false;
    close();
    return true;
  }, { modal: open && mobile });

  async function send(retry = false) {
    if (activeRequest.current) return;
    const resolved = connectionForTask("assistant");
    const content = draft.trim();
    if (!resolved || (retry ? messages.at(-1)?.role !== "user" : !content)) return;

    const request = Symbol();
    activeRequest.current = request;
    const contextForRequest = includeScreen ? getAssistantContext() : null;
    const { activeLanguage, nativeLanguage } = loadSettings();
    const history = retry ? messages : saveAssistantHistory([...messages, { role: "user", content }]);
    if (!retry) {
      setMessages(history);
      setDraft("");
    }
    inputRef.current?.focus({ preventScroll: true });
    setFailure(null);
    setPartial("");

    try {
      const reply = (await requestAssistantReply({
        connection: resolved,
        targetLanguage: activeLanguage,
        nativeLanguage,
        context: contextForRequest,
        messages: history,
        onDelta: (delta) => {
          if (activeRequest.current === request) {
            setPartial((text) => ((text ?? "") + delta).slice(0, MAX_ASSISTANT_MESSAGE_LENGTH));
          }
        },
      })).trim().slice(0, MAX_ASSISTANT_MESSAGE_LENGTH);
      if (activeRequest.current !== request) return;
      if (reply) setMessages(saveAssistantHistory([...history, { role: "assistant", content: reply }]));
      else setFailure({ key: "error-empty-response" });
    } catch (cause) {
      if (activeRequest.current === request) setFailure({ key: "assistant-error", cause });
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setPartial(null);
      }
    }
  }

  function clearConversation() {
    activeRequest.current = null;
    setMessages(saveAssistantHistory([]));
    setPartial(null);
    setFailure(null);
    inputRef.current?.focus({ preventScroll: true });
  }

  if (!open) {
    return (
      <button type="button" class="assistant-launcher primary-button" ref={launcherRef} onClick={() => onOpenChange(true)}
        aria-haspopup="dialog" aria-label={t("assistant-open")} title={t("assistant-open")}>
        <MessageCircleQuestionMark size={22} aria-hidden="true" />
      </button>
    );
  }

  const streaming = partial !== null;
  const canRetry = !streaming && messages.at(-1)?.role === "user";
  return (
    <section class="assistant-panel" ref={panelRef} style={{ top: mobile ? 0 : headerBottom }}
      role="dialog" aria-modal={mobile || undefined} aria-label={t("assistant-title")} tabIndex={-1}
      onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}>
      <header class="assistant-header">
        <div class="assistant-header-spacer" />
        <button type="button" class="assistant-icon-button" onClick={clearConversation} disabled={messages.length === 0}
          aria-label={t("assistant-clear")} title={t("assistant-clear")}>
          <Trash2 size={17} aria-hidden="true" />
        </button>
        <button type="button" class="assistant-icon-button" onClick={close}
          aria-label={t("app-kbd-close")} title={t("app-kbd-close")}>
          <X size={19} aria-hidden="true" />
        </button>
      </header>
      <div class="assistant-scroll" ref={scrollRef}>
        {messages.length === 0 && <p class="hint-text">{t("assistant-empty")}</p>}
        <div class="assistant-messages" role="log" aria-label={t("assistant-messages")}>
          {messages.map(({ role, content }, index) => (
            <div key={index} class={`assistant-bubble assistant-bubble--${role}`}>
              {role === "assistant" ? (
                <>
                  <div class="md-body" dir="auto"><MarkdownView text={content} tables /></div>
                  <CopyButton text={content} />
                </>
              ) : <p dir="auto">{content}</p>}
            </div>
          ))}
        </div>
        {streaming && <p class="hint-text assistant-progress" role="status">{t("assistant-responding")}</p>}
        {partial && (
          <div class="assistant-bubble assistant-bubble--assistant assistant-partial md-body" dir="auto">
            <MarkdownView text={partial} tables />
          </div>
        )}
        {failure && <p class="error-text assistant-progress" role="alert">{localizeNetworkError(failure.cause, t(failure.key))}</p>}
        {canRetry && <button type="button" class="assistant-progress" disabled={!connection} onClick={() => void send(true)}>{t("assistant-retry")}</button>}
      </div>
      <form class="assistant-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {!connection && (
          <div class="assistant-setup">
            <p class="hint-text">{t("assistant-not-configured")}</p>
            <button type="button" class="link-button" onClick={() => { close(); onOpenSettings(); }}>{t("assistant-open-settings")}</button>
          </div>
        )}
        <div class="assistant-context">
          <label>
            <input type="checkbox" checked={includeScreen} onChange={(e) => {
              const checked = e.currentTarget.checked;
              setIncludeScreen(checked);
              saveAssistantIncludeScreen(checked);
            }} />
            {t("assistant-include-screen")}
          </label>
          {includeScreen && context && <span class="assistant-context-chip">{t(`app-tab-${context.source}`)}</span>}
        </div>
        <div class="assistant-input-row">
          <textarea ref={inputRef} value={draft} rows={2} maxLength={MAX_ASSISTANT_MESSAGE_LENGTH}
            aria-label={t("assistant-input")} placeholder={t("assistant-input")}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
              if (!connection || streaming) return;
              e.preventDefault();
              void send();
            }} />
          <button type="submit" class="assistant-icon-button primary-button" disabled={!connection || streaming || !draft.trim()}
            aria-label={t("assistant-send")} title={t("assistant-send")}>
            <Send size={18} aria-hidden="true" />
          </button>
        </div>
      </form>
    </section>
  );
}
