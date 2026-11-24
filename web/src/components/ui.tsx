import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { initials } from '../lib/util';
import { Close, Diamond } from './Icons';

export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <div className="wordmark" style={{ fontSize: size }} aria-label="Guessong">
      Guess<span>ong</span>
    </div>
  );
}

export function Score({ value, className = '' }: { value: number; className?: string }) {
  return (
    <span className={`score ${className}`}>
      <Diamond />
      <span className="num">{value.toLocaleString()}</span>
    </span>
  );
}

export function ScorePill({ value }: { value: number }) {
  return (
    <span className="score-pill">
      <Diamond />
      {value.toLocaleString()}
    </span>
  );
}

/** Playlist/track artwork; falls back to a 2×2 mosaic or a gradient placeholder. */
export function Artwork({
  src,
  mosaic = [],
  title,
  className = '',
  style,
}: {
  src?: string | null;
  mosaic?: string[];
  title: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (src) {
    return (
      <div className={`art ${className}`} style={style}>
        <img src={src} alt="" loading="lazy" decoding="async" />
      </div>
    );
  }
  if (mosaic.length >= 4) {
    return (
      <div className={`art mosaic ${className}`} style={style}>
        {mosaic.slice(0, 4).map((m, i) => (
          <img key={i} src={m} alt="" loading="lazy" decoding="async" />
        ))}
      </div>
    );
  }
  if (mosaic.length > 0) {
    return (
      <div className={`art ${className}`} style={style}>
        <img src={mosaic[0]} alt="" loading="lazy" />
      </div>
    );
  }
  return (
    <div className={`art ${className}`} style={style}>
      <div className="ph">{initials(title)}</div>
    </div>
  );
}

export function Avatar({ name, url, color, size = 36 }: { name: string; url?: string | null; color: string; size?: number }) {
  return (
    <div className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {url ? <img src={url} alt="" /> : initials(name)}
    </div>
  );
}

export function RankBadge({ rank }: { rank: number }) {
  return <span className={`rank ${rank <= 3 ? `rank-${rank}` : ''} ${rank > 99 ? 'wide' : ''}`}>{rank}</span>;
}

function usePortal() {
  return document.body;
}

/** Bottom sheet over a dimmed backdrop. Esc / backdrop tap closes it. */
export function Sheet({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grabber" />
        <span id={id} className="visually-hidden">
          {label}
        </span>
        <button className="circle-btn sheet-close" onClick={onClose} aria-label="Close">
          <Close />
        </button>
        {children}
      </div>
    </div>,
    usePortal(),
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Keep playing',
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return createPortal(
    <div className="backdrop modal-center" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="row2">
          <button className="btn btn-soft" onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'btn-dark' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}
