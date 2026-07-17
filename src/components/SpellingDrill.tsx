// Copy-typing drill for what the learner just got wrong in a practice
// attempt (see PracticeView/FeedbackPanel): misspelled words (typed
// REQUIRED_CORRECT_WORD times) and corrected sentences (once — retyping a
// whole sentence three times would be tedium, not practice). There is no
// check button: the diff against the correct text updates live on every
// keystroke, and a rep is counted (and the input cleared) the moment it
// matches exactly. The correct text is shown deliberately — this is
// retrieval-adjacent output practice, not a blind-recall quiz.
import { useEffect, useRef, useState } from "preact/hooks";
import { Check } from "lucide-preact";
import type { CorrectedSentence, MisspelledWord } from "../lib/spelling";
import { diffChars } from "../lib/diff";
import { t } from "../i18n";

export interface SpellingDrillProps {
  words: MisspelledWord[];
  sentences?: CorrectedSentence[];
}

const REQUIRED_CORRECT_WORD = 3;
const REQUIRED_CORRECT_SENTENCE = 1;

interface DrillItem {
  attempted: string;
  correct: string;
  kind: "word" | "sentence";
  required: number;
}

interface ItemState {
  correctCount: number;
  input: string;
}

function initialState(): ItemState {
  return { correctCount: 0, input: "" };
}

export function SpellingDrill({ words, sentences = [] }: SpellingDrillProps) {
  const items: DrillItem[] = [
    ...words.map((w): DrillItem => ({ ...w, kind: "word", required: REQUIRED_CORRECT_WORD })),
    ...sentences.map((s): DrillItem => ({ ...s, kind: "sentence", required: REQUIRED_CORRECT_SENTENCE })),
  ];
  const [states, setStates] = useState<ItemState[]>(() => items.map(() => initialState()));

  // Keyboard-only drill: on mount, and every time a rep finishes, move focus
  // to the first not-yet-finished item's input so the learner can type
  // straight through the whole list without reaching for the mouse. Calling
  // .focus() on an element that already has focus is a no-op, so re-running
  // this on every keystroke (via the `states` dependency) is harmless.
  const inputRefs = useRef<(HTMLInputElement | HTMLTextAreaElement | null)[]>([]);
  useEffect(() => {
    const nextIndex = items.findIndex((item, i) => (states[i]?.correctCount ?? 0) < item.required);
    if (nextIndex !== -1) inputRefs.current[nextIndex]?.focus();
  }, [states]);

  if (items.length === 0) return null;

  function handleInput(index: number, correct: string, value: string) {
    setStates((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        // Exact match (case-sensitive) → one rep done, clear for the next.
        if (value.trim() === correct) return { correctCount: s.correctCount + 1, input: "" };
        return { ...s, input: value };
      }),
    );
  }

  return (
    <div class="feedback-field spelling-drill">
      <h3>{t("practice-spelling-heading")}</h3>
      {words.length > 0 && <p class="spelling-hint">{t("practice-spelling-hint", { count: REQUIRED_CORRECT_WORD })}</p>}
      {sentences.length > 0 && <p class="spelling-hint">{t("practice-spelling-sentence-hint")}</p>}
      {items.map((item, i) => {
        const state = states[i] ?? initialState();
        const finished = state.correctCount >= item.required;
        // Live keystroke feedback: "added" chunks are the characters still to
        // type, "removed" chunks are wrong characters to take out.
        const chunks = state.input !== "" ? diffChars(state.input, item.correct) : null;

        return (
          <div key={i} class="spelling-word-row">
            <div class="spelling-word-info">
              <span class="spelling-target">{item.correct}</span>
              <span class="spelling-progress">
                {t("practice-spelling-progress", { done: state.correctCount, total: item.required })}
              </span>
            </div>
            <span class="spelling-attempted">{t("practice-spelling-you-wrote", { word: item.attempted })}</span>

            {finished ? (
              <div class="spelling-done status-ok">
                <Check size={16} />
                <span>{t("practice-spelling-done")}</span>
              </div>
            ) : (
              <>
                {item.kind === "word" ? (
                  <input
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    type="text"
                    class="spelling-input"
                    value={state.input}
                    placeholder={t("practice-spelling-placeholder")}
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck={false}
                    onInput={(e) => handleInput(i, item.correct, (e.target as HTMLInputElement).value)}
                  />
                ) : (
                  <textarea
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    class="spelling-input spelling-textarea"
                    value={state.input}
                    placeholder={t("practice-spelling-sentence-placeholder")}
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck={false}
                    rows={2}
                    onKeyDown={(e) => {
                      // A drill "sentence" is single-line by design (matched
                      // via exact string equality) — swallow Enter so it
                      // can't insert a newline that would silently block the
                      // match instead of doing anything useful.
                      if (e.key === "Enter") e.preventDefault();
                    }}
                    onInput={(e) => handleInput(i, item.correct, (e.target as HTMLTextAreaElement).value)}
                  />
                )}
                {chunks && (
                  <span class="spelling-diff">
                    {chunks.map((chunk, ci) => (
                      <span key={ci} class={chunk.op === "same" ? undefined : `diff-${chunk.op}`}>
                        {chunk.text}
                      </span>
                    ))}
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
