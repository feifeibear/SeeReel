import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";

export interface MentionOption {
  /** Stable id, used as React key. */
  id: string;
  /** What gets inserted into the textarea (without the leading @). */
  handle: string;
  /** Human label shown in the popup, e.g. the original asset name with spaces. */
  label: string;
  /** Short tag like "资产 / 参考视频 / 分镜板". */
  tag: string;
  /** Whether this option is already wired into the shot via canvas. Wired-in options are
   * pinned to the top of the popup so the user picks the relevant one first. */
  wired?: boolean;
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  options: MentionOption[];
  rows?: number;
  placeholder?: string;
  /** Called when value changes via blur — lets the caller persist on focus loss without echoing
   * every keystroke up the prop chain. Optional. */
  onCommit?: (value: string) => void;
}

/**
 * Textarea with an @-mention autocomplete popup. Triggers when the user types `@` at a word
 * boundary; while the popup is open, ArrowUp/Down navigates, Enter / Tab picks, and Escape closes
 * without inserting. Click also picks. Filtering is by case-insensitive handle prefix match.
 *
 * Why: lets the user point at any wired reference (or any visible asset in the session) without
 * memorizing the exact handle the server-side parser expects. The handles are normalized the
 * same way the server normalizes mention text — strip whitespace and slashes — so what the
 * user picks is exactly what the server will recognize.
 */
export function MentionTextarea({ value, onChange, options, rows = 10, placeholder, onCommit }: MentionTextareaProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Index inside `value` of the `@` that started the active mention. -1 when not active.
  const [mentionStart, setMentionStart] = useState(-1);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const open = mentionStart >= 0;

  const filtered = useMemo(() => {
    if (!open) return [] as MentionOption[];
    const q = query.toLowerCase();
    const wired: MentionOption[] = [];
    const rest: MentionOption[] = [];
    for (const opt of options) {
      if (q && !opt.handle.toLowerCase().includes(q) && !opt.label.toLowerCase().includes(q)) continue;
      (opt.wired ? wired : rest).push(opt);
    }
    return [...wired, ...rest];
  }, [open, query, options]);

  // Reset active index whenever the filtered list shape shifts.
  useEffect(() => {
    setActiveIndex((prev) => (prev < filtered.length ? prev : 0));
  }, [filtered.length]);

  /**
   * Decide whether a textarea state change just opened a fresh @-mention session, or extended /
   * closed an existing one. Driven entirely from caret position + the character at caret-1.
   */
  const reconcileMention = (next: string, caret: number) => {
    // Walk backwards from caret to find the most recent `@`. Stop at whitespace / newline / start.
    let i = caret - 1;
    while (i >= 0) {
      const ch = next[i];
      if (ch === "@") break;
      if (/\s/.test(ch)) { i = -1; break; } // whitespace before @ → no active mention
      i -= 1;
    }
    if (i < 0) {
      // No active @ in scope.
      if (open) { setMentionStart(-1); setQuery(""); }
      return;
    }
    // Make sure the @ is at a word boundary: previous char must be whitespace, newline, or
    // start-of-string. Otherwise it's part of an email or other token, not a mention.
    const prev = i > 0 ? next[i - 1] : "";
    if (prev && !/\s/.test(prev)) {
      if (open) { setMentionStart(-1); setQuery(""); }
      return;
    }
    setMentionStart(i);
    setQuery(next.slice(i + 1, caret));
  };

  const onTextareaChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next);
    reconcileMention(next, e.target.selectionStart ?? next.length);
  };

  const onSelect = () => {
    const el = textareaRef.current;
    if (!el) return;
    reconcileMention(el.value, el.selectionStart ?? el.value.length);
  };

  const pick = (option: MentionOption) => {
    if (mentionStart < 0) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, mentionStart);
    const after = value.slice(caret);
    // Append a trailing space so the next thing the user types isn't glued onto the handle.
    const inserted = `@${option.handle} `;
    const next = before + inserted + after;
    onChange(next);
    setMentionStart(-1);
    setQuery("");
    // Restore caret to just after the inserted handle on next tick.
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      const pos = (before + inserted).length;
      t.focus();
      t.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(filtered[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMentionStart(-1);
      setQuery("");
    }
  };

  return (
    <div className="mention-textarea-wrap">
      <textarea
        ref={textareaRef}
        rows={rows}
        value={value}
        onChange={onTextareaChange}
        onKeyDown={onKeyDown}
        onSelect={onSelect}
        onClick={onSelect}
        onBlur={() => onCommit?.(value)}
        placeholder={placeholder}
      />
      {open && filtered.length > 0 && (
        <div className="mention-popup" role="listbox" aria-label={t.mention.aria}>
          {filtered.map((option, idx) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={idx === activeIndex}
              className={`mention-option ${idx === activeIndex ? "active" : ""}`}
              // Use onMouseDown to fire BEFORE the textarea blur fires — otherwise blur cancels
              // the click before pick() runs.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(option);
              }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              <span className="mention-option-handle">@{option.handle}</span>
              <span className="mention-option-label">{option.label}</span>
              <small className="mention-option-tag">{option.tag}{option.wired ? ` · ${t.mention.wired}` : ""}</small>
            </button>
          ))}
        </div>
      )}
      {open && filtered.length === 0 && (
        <div className="mention-popup mention-popup-empty">
          {t.mention.empty}
        </div>
      )}
    </div>
  );
}
