import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  CLIP_STAGES_MS,
  HINT_ORDER,
  TIMELINE_SEGMENT_PCT,
  formatSeconds,
  isHintUnlocked,
  type HintRules,
  type HintType,
  type RevealDTO,
  type SearchResultDTO,
  type SongStateDTO,
} from '@guessong/shared';
import { api } from '../api';
import type { Playhead } from '../game/useGame';
import { Check, Diamond, ExternalIcon, Note, Close, SearchIcon, SkipIcon, XIcon } from './Icons';
import { Spinner } from './ui';

// ---------------------------------------------------------------------------
// Attempt rows
// ---------------------------------------------------------------------------

export function AttemptRows({ song, wrongCount, resolved }: { song: SongStateDTO; wrongCount: number; resolved: boolean }) {
  return (
    <div className="attempts" aria-label="Attempts">
      {CLIP_STAGES_MS.map((ms, idx) => {
        const n = idx + 1;
        const entry = song.log.find((l) => l.attempt === n);
        const dur = formatSeconds(ms);
        if (n < song.attempt || (resolved && entry)) {
          if (entry?.kind === 'wrong') {
            const shake = n === song.attempt - 1 && wrongCount > 0;
            return (
              <div key={shake ? `w${n}-${wrongCount}` : n} className={`attempt wrong ${shake ? 'shake' : ''}`}>
                <span className="no">
                  <XIcon />
                </span>
                <span className="label">
                  {entry.title} - {entry.artist}
                </span>
                <span className="dur">{dur}</span>
              </div>
            );
          }
          return (
            <div key={n} className="attempt skipped">
              <span className="no">
                <SkipIcon />
              </span>
              <span className="label">Skipped</span>
              <span className="dur">{dur}</span>
            </div>
          );
        }
        if (n === song.attempt && !resolved) {
          return (
            <div key={n} className="attempt active" aria-current="step">
              <span className="no">{n}</span>
              <span className="label">Next guess</span>
              <span className="dur">{dur}</span>
            </div>
          );
        }
        return (
          <div key={n} className="attempt">
            <span className="no">{n}</span>
            <span className="label" />
            <span className="dur">{dur}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented timeline
// ---------------------------------------------------------------------------

export function Timeline({ attempt, playhead, providerLabel }: { attempt: number; playhead: Playhead; providerLabel: string }) {
  const ms = useSyncExternalStore(playhead.subscribe, playhead.get);
  const unlocked = CLIP_STAGES_MS[attempt - 1];
  return (
    <div className="timeline" aria-label={`${formatSeconds(unlocked)} of ${formatSeconds(CLIP_STAGES_MS[5])} unlocked`}>
      <div className="track">
        {TIMELINE_SEGMENT_PCT.map((w, i) => (
          <div key={i} className={`seg ${i < attempt ? 'unlocked' : ''}`} style={{ flex: `${w} 0 0`, position: 'relative' }}>
            {i === attempt - 1 && (
              <div className="marker" style={{ left: '100%' }}>
                {formatSeconds(unlocked)}
                <span className="tri" />
              </div>
            )}
          </div>
        ))}
        <div className="fill" aria-hidden>
          {TIMELINE_SEGMENT_PCT.map((w, i) => {
            const start = i === 0 ? 0 : CLIP_STAGES_MS[i - 1];
            const end = CLIP_STAGES_MS[i];
            const frac = Math.min(1, Math.max(0, (ms - start) / (end - start)));
            return (
              <div key={i} className="seg" style={{ flex: `${w} 0 0` }}>
                <i style={{ width: `${frac * 100}%` }} />
              </div>
            );
          })}
        </div>
      </div>
      <div className="foot">
        <span>0s</span>
        <span className="powered">
          <Note /> Powered by {providerLabel}
        </span>
        <span>15s</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

export function HintBar({
  song,
  rules,
  disabled,
  onHint,
}: {
  song: SongStateDTO;
  rules: HintRules;
  disabled: boolean;
  onHint: (t: HintType) => void;
}) {
  return (
    <div className="hints">
      {HINT_ORDER.map((type) => {
        const r = rules[type];
        const used = song.hintsUsed.includes(type);
        const locked = !isHintUnlocked(type, song.attempt, rules);
        return (
          <button
            key={type}
            className={`hint-btn ${used ? 'used' : ''}`}
            disabled={disabled || used || locked}
            onClick={() => onHint(type)}
            title={locked ? `Unlocks on attempt ${r.unlockAttempt}` : used ? 'Used' : `Costs ${r.penalty} points on this song`}
            aria-label={`${r.label} hint, costs ${r.penalty} points${locked ? `, unlocks on attempt ${r.unlockAttempt}` : ''}${used ? ', used' : ''}`}
          >
            {used && <Check style={{ width: 14, height: 14 }} />}
            {r.label} <span className="cost">↓ {r.penalty}</span>
          </button>
        );
      })}
    </div>
  );
}

export function HintReveals({ song }: { song: SongStateDTO }) {
  const { artist, song: masked, cover } = song.hints;
  if (!artist && !masked && !cover) return null;
  return (
    <div className="hint-reveals">
      {cover && <img src={cover} alt="Album cover hint" />}
      <div className="lines">
        {artist && (
          <div className="v">
            <span className="k">Artist</span>
            {artist}
          </div>
        )}
        {masked && (
          <div className="v masked">
            <span className="k">Song</span>
            {masked}
          </div>
        )}
        {cover && !artist && !masked && (
          <div className="v">
            <span className="k">Cover</span>revealed
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Autocomplete search
// ---------------------------------------------------------------------------

export function GuessSearch({
  playlistId,
  disabled,
  selected,
  onSelect,
  onSubmit,
}: {
  playlistId?: string;
  disabled: boolean;
  selected: SearchResultDTO | null;
  onSelect: (r: SearchResultDTO | null) => void;
  onSubmit: () => void;
}) {
  const [query, setQuery] = useState(selected ? `${selected.title} — ${selected.artist}` : '');
  const [results, setResults] = useState<SearchResultDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [maxHeight, setMaxHeight] = useState(320);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selected) return;
    setQuery(`${selected.title} — ${selected.artist}`);
  }, [selected]);

  // Debounced, cancellable search.
  useEffect(() => {
    if (selected) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.search(q, playlistId, ctrl.signal);
        setResults(res.results);
        setActive(0);
        setOpen(true);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setResults([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [query, playlistId, selected]);

  // Keep the popover between the top of the visible viewport and the input (keyboard-aware).
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const top = inputRef.current?.getBoundingClientRect().top ?? 400;
      const vvTop = window.visualViewport?.offsetTop ?? 0;
      setMaxHeight(Math.max(120, Math.min(360, top - vvTop - 20)));
    };
    update();
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open, results.length]);

  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);

  const choose = (r: SearchResultDTO) => {
    onSelect(r);
    setOpen(false);
    setQuery(`${r.title} — ${r.artist}`);
    inputRef.current?.blur();
  };

  const showPopover = open && !selected && query.trim().length >= 2 && (results.length > 0 || !loading);

  return (
    <div className="search" ref={wrapRef}>
      <div className="search-field">
        <SearchIcon className="lead" />
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          enterKeyHint={selected ? 'send' : 'search'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Search for a song..."
          aria-label="Search for a song"
          role="combobox"
          aria-expanded={showPopover}
          aria-controls="guess-options"
          aria-activedescendant={showPopover && results[active] ? `opt-${results[active].id}` : undefined}
          value={query}
          disabled={disabled}
          onFocus={() => results.length && !selected && setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            if (selected) onSelect(null);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (showPopover && results[active]) choose(results[active]);
              else if (selected) onSubmit();
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
        <span className="trail">
          {loading ? (
            <Spinner />
          ) : query ? (
            <button
              className="clear"
              aria-label="Clear"
              onClick={() => {
                setQuery('');
                onSelect(null);
                setResults([]);
                inputRef.current?.focus();
              }}
            >
              <Close />
            </button>
          ) : null}
        </span>
      </div>
      {showPopover && (
        <div className="popover" id="guess-options" role="listbox" style={{ maxHeight }}>
          {results.map((r, i) => (
            <button
              key={r.id}
              id={`opt-${r.id}`}
              role="option"
              aria-selected={i === active}
              className="opt"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(r)}
            >
              <div className="t">{r.title}</div>
              <div className="a">{r.artist}</div>
            </button>
          ))}
          {results.length === 0 && <div className="note">No songs found. Try the artist's name too.</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading screen (Screen 3)
// ---------------------------------------------------------------------------

const TIPS = [
  'Skipping spends an attempt, but it also lengthens the clip.',
  'Tap ▶ to replay everything you have unlocked so far.',
  'A correct guess on the first 0.5s is worth 100 points.',
  'Different editions count: a remaster or single edit by the same artist is still correct.',
  'Hints cost points on the current song, but a correct answer always scores something.',
  'Ties on the leaderboard go to the faster round.',
  'Challenge a friend and they get the exact same 10 songs.',
];

export function LoadingView({ progress, onCancel, title = 'Loading next song...' }: { progress: number; onCancel: () => void; title?: string }) {
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const t = setInterval(() => setTip((i) => (i + 1) % TIPS.length), 4000);
    return () => clearInterval(t);
  }, []);
  const pct = Math.round(progress * 100);
  return (
    <div className="screen loading-screen" aria-busy="true">
      <div className="vinyl-wrap">
        <div className="vinyl">
          <div className="label" />
        </div>
      </div>
      <h2>{title}</h2>
      <div className="sub">Finding the perfect track for you</div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="bar">
          <div className="fill" style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
        <div className="labels">
          <span>PREPARING</span>
          <span className="num">{pct}%</span>
        </div>
      </div>
      <div className="tip">
        <div className="eyebrow">DID YOU KNOW</div>
        <p>{TIPS[tip]}</p>
      </div>
      <button className="link-btn" style={{ marginTop: 12 }} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result modal (Screen 5)
// ---------------------------------------------------------------------------

export function ResultModal({
  reveal,
  attempts,
  providerLabel,
  onContinue,
}: {
  reveal: RevealDTO;
  attempts: number;
  providerLabel: string;
  onContinue: () => void;
}) {
  const ok = reveal.status === 'correct';
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => btnRef.current?.focus({ preventScroll: true }), []);
  return (
    <div className="backdrop modal-center">
      <div className="result-card" role="dialog" aria-modal="true" aria-label={ok ? 'Correct' : 'Missed'}>
        <div className="result-hero">
          {reveal.artworkUrl ? <img src={reveal.artworkUrl} alt={`${reveal.album ?? reveal.title} cover`} /> : null}
          <span className={`pill ${ok ? 'correct' : 'missed'}`}>{ok ? 'CORRECT' : 'MISSED'}</span>
          <span className="pill attempt">
            ATTEMPT {reveal.attemptsUsed}/{attempts}
          </span>
        </div>
        <div className="result-body">
          <div className={`eyebrow ${ok ? 'ok' : 'miss'}`}>{ok ? 'YOU GOT IT' : 'CORRECT ANSWER'}</div>
          <h2>{reveal.title}</h2>
          <div className="artist">{reveal.artist}</div>
          {reveal.note && <div className="fun-fact">{reveal.note}</div>}
          <div className="stats3">
            <div>
              <span className="k">Attempts used</span>
              <span className="v">
                {reveal.attemptsUsed}/{attempts}
              </span>
            </div>
            <div>
              <span className="k">Time listened</span>
              <span className="v">{formatSeconds(reveal.timeListenedMs)}</span>
            </div>
            <div>
              <span className="k">Points</span>
              <span className="v score">
                <Diamond />
                {reveal.pointsAwarded}
              </span>
            </div>
          </div>
          {reveal.externalUrl && (
            <a className="open-link" href={reveal.externalUrl} target="_blank" rel="noreferrer">
              <ExternalIcon /> Open in {reveal.externalLabel ?? providerLabel}
            </a>
          )}
          <button ref={btnRef} className="btn btn-primary btn-block" onClick={onContinue}>
            {reveal.isLast ? 'See results' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
