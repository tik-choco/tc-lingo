// Searchable single-select language picker (button trigger + a filterable
// dropdown menu), replacing free-text language inputs across Settings /
// Onboarding / Practice. Self-contained (owns its own open/search state) so
// several instances can sit on one screen — e.g. one per already-added
// target language plus an "add a language" instance. Modeled on
// tc-translate's components/LanguageSelect.tsx, simplified since this app's
// UI has no locale switching (labels are always Japanese, see lib/languages).
import { ChevronDown, Search } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { languageDisplayName, languageOptionLabel, languageOptions } from "../lib/languages";
import { t } from "../i18n";

export interface LanguageSelectProps {
  value: string;
  onChange: (language: string) => void;
  /** Languages to hide from the list — e.g. ones already added elsewhere. */
  exclude?: string[];
  placeholder?: string;
  ariaLabel: string;
}

export function LanguageSelect({ value, onChange, exclude, placeholder, ariaLabel }: LanguageSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    searchRef.current?.focus();
  }, [open]);

  const excluded = new Set(exclude ?? []);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = languageOptions.filter((language) => {
    if (excluded.has(language) && language !== value) return false;
    if (!normalizedQuery) return true;
    return (
      language.toLowerCase().includes(normalizedQuery) || languageDisplayName(language).includes(query.trim())
    );
  });

  function select(language: string) {
    onChange(language);
    setOpen(false);
  }

  return (
    <div
      class="language-select"
      ref={containerRef}
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        class={`language-select-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{value ? languageDisplayName(value) : placeholder ?? t("langsel-select-placeholder")}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div class="language-select-menu" role="listbox" aria-label={ariaLabel}>
          <div class="language-select-search">
            <Search size={14} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered.length > 0) {
                  e.preventDefault();
                  select(filtered[0]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={t("langsel-search-placeholder")}
              aria-label={t("langsel-search-aria-label")}
            />
          </div>
          {filtered.length === 0 ? (
            <p class="language-select-empty">{t("langsel-empty")}</p>
          ) : (
            filtered.map((language) => (
              <button
                type="button"
                key={language}
                class={`language-select-option${language === value ? " current" : ""}`}
                role="option"
                aria-selected={language === value}
                onClick={() => select(language)}
              >
                {languageOptionLabel(language)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
