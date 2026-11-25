import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryJobDTO, LibraryOverviewDTO, LibrarySourceDTO, PlaylistCardDTO } from '@guessong/shared';
import { api, ApiError, SPOTIFY_LOGIN_URL } from '../api';
import { useSession } from '../lib/session';
import { plural, storageGet, storageSet } from '../lib/util';
import { Close, Diamond, Heart, PlusIcon, Star } from './Icons';
import { Artwork, Sheet, Spinner } from './ui';

/** Discovery section: connect Spotify, or the games built from your library. */
export function SpotifyGames({
  games,
  onOpen,
  onNew,
}: {
  games: PlaylistCardDTO[];
  onOpen: (p: PlaylistCardDTO) => void;
  onNew: () => void;
}) {
  const { user } = useSession();
  const [hidden, setHidden] = useState(() => storageGet('guessong.hideSpotifyBanner') === '1');
  if (!user?.spotifyConnected) {
    if (hidden) return null;
    return (
      <div className="banner lib-connect">
        <div style={{ flex: 1 }}>
          <strong>Play your own music</strong>
          <p>Games from your Spotify playlists, liked songs and genres. Invite only.</p>
        </div>
        <div className="lib-connect-actions">
          <a className="btn btn-primary btn-sm" href={SPOTIFY_LOGIN_URL}>
            Connect Spotify
          </a>
          <button
            className="link-btn"
            onClick={() => {
              storageSet('guessong.hideSpotifyBanner', '1');
              setHidden(true);
            }}
            aria-label="Hide this"
          >
            <Close /> Hide
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="section-head">
        <h2>Your Spotify games</h2>
      </div>
      <div className="recent-row lib-row" aria-label="Your Spotify games">
        <button className="lib-card lib-new" onClick={onNew}>
          <div className="art">
            <PlusIcon />
          </div>
          <div className="title">New game</div>
          <div className="sub">From your library</div>
        </button>
        {games.map((g) => (
          <button key={g.id} className="lib-card" onClick={() => onOpen(g)}>
            <Artwork className="art" src={g.artworkUrl} mosaic={g.mosaic} title={g.title} />
            <div className="title">{g.title}</div>
            <div className="sub">
              {g.me ? (
                <span className="status-best">
                  <Diamond /> <span className="num">{g.me.bestScore}</span>
                </span>
              ) : (
                plural(g.songCount, 'song')
              )}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'spotify_forbidden') return "Spotify didn't let Guessong read your library. Is your account on the app's invite list?";
    return e.message;
  }
  return (e as Error).message;
}

/** Pick what to build a game from, then follow the build. */
export function LibrarySheet({ onClose, onCreated }: { onClose: () => void; onCreated: (playlistId: string) => void }) {
  const { toast } = useSession();
  const [data, setData] = useState<LibraryOverviewDTO | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [job, setJob] = useState<LibraryJobDTO | null>(null);
  const [jobTitle, setJobTitle] = useState('');
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await api.library();
      if (!alive.current) return;
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      if (alive.current) setError({ message: describeError(e), code: e instanceof ApiError ? e.code : undefined });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // Genres are read in the background: refresh until they're ready.
  useEffect(() => {
    if (!data || (data.genresStatus !== 'scanning' && data.genresStatus !== 'idle')) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [data, load]);

  // Follow a build until it finishes.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const t = setTimeout(async () => {
      try {
        const r = await api.libraryJob(job.id);
        if (!alive.current) return;
        setJob(r.job);
        if (r.job.status === 'done' && r.job.playlistId) {
          toast(`${r.job.title ?? jobTitle} is ready`, 'success');
          onCreated(r.job.playlistId);
        }
      } catch (e) {
        if (alive.current) setJob({ ...job, status: 'error', error: { code: 'poll_failed', message: describeError(e) } });
      }
    }, 700);
    return () => clearTimeout(t);
  }, [job, jobTitle, onCreated, toast]);

  const build = async (source: LibrarySourceDTO, title: string) => {
    setJobTitle(title);
    try {
      const r = await api.createLibraryGame(source);
      setJob(r.job);
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };

  if (job) {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    return (
      <Sheet onClose={onClose} label="Building your game">
        <div className="lib-build">
          <h2>{job.title ?? jobTitle}</h2>
          {job.status === 'error' ? (
            <>
              <p className="lib-error">{job.error?.message ?? 'Something went wrong'}</p>
              <button className="btn btn-soft btn-block" onClick={() => setJob(null)}>
                Choose something else
              </button>
            </>
          ) : (
            <>
              <p className="sub">
                {job.phase === 'reading'
                  ? 'Reading your songs from Spotify…'
                  : job.phase === 'saving'
                    ? 'Almost there…'
                    : `Finding preview clips: ${job.matched} found so far`}
              </p>
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="bar">
                  <div className="fill" style={{ width: `${Math.max(4, pct)}%` }} />
                </div>
                <div className="labels">
                  <span>{job.total ? `${job.done} / ${job.total} SONGS` : 'STARTING'}</span>
                  <span className="num">{pct}%</span>
                </div>
              </div>
              <p className="fine">You can close this, the game keeps building and shows up in “Your Spotify games”.</p>
            </>
          )}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose} label="New game from Spotify">
      <h2 className="lib-title">New game from Spotify</h2>
      <p className="lib-lead">Pick songs you know. Every game gets its own leaderboard, and you can challenge friends to it.</p>

      {error && (
        <div className="empty" style={{ padding: '24px 8px' }}>
          {error.message}
          <div style={{ marginTop: 12 }}>
            {error.code === 'spotify_not_connected' ? (
              <a className="btn btn-primary btn-sm" href={SPOTIFY_LOGIN_URL}>
                Connect Spotify
              </a>
            ) : (
              <button className="btn btn-soft btn-sm" onClick={load}>
                Try again
              </button>
            )}
          </div>
        </div>
      )}

      {!data && !error && (
        <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
          <Spinner />
        </div>
      )}

      {data && (
        <>
          <div className="lib-tiles">
            <button className="lib-tile" onClick={() => build({ kind: 'liked' }, 'Liked Songs')}>
              <Heart />
              <span className="t">Liked Songs</span>
              <span className="s">{data.likedCount !== null ? plural(data.likedCount, 'song') : 'Your saved songs'}</span>
            </button>
            <button className="lib-tile" onClick={() => build({ kind: 'top' }, 'Your Top Songs')}>
              <Star />
              <span className="t">Your Top Songs</span>
              <span className="s">What you play most</span>
            </button>
          </div>

          <div className="label-sm">Your genres</div>
          {data.genresStatus === 'ready' && data.genres.length > 0 && (
            <div className="chip-row lib-genres">
              {data.genres.map((g) => (
                <button key={g.key} className="chip" onClick={() => build({ kind: 'genre', key: g.key }, `Your ${g.label}`)}>
                  {g.label}
                  <span className="count num">{g.count}</span>
                </button>
              ))}
            </div>
          )}
          {data.genresStatus === 'ready' && data.genres.length === 0 && (
            <p className="lib-note">Not enough genre info yet. Like more songs on Spotify and check back.</p>
          )}
          {(data.genresStatus === 'scanning' || data.genresStatus === 'idle') && (
            <p className="lib-note">
              <Spinner /> Reading your favorite genres…
            </p>
          )}
          {data.genresStatus === 'error' && <p className="lib-note">Couldn't read your genres right now.</p>}

          <div className="label-sm">Your playlists</div>
          <div className="list" style={{ marginTop: 8 }}>
            {data.playlists.length === 0 && <div className="empty">No playlists in your library.</div>}
            {data.playlists.map((p) => (
              <button
                key={p.id}
                className="list-item"
                disabled={!p.readable}
                onClick={() => build({ kind: 'playlist', id: p.id }, p.name)}
                aria-label={p.readable ? `Build a game from ${p.name}` : `${p.name} (Spotify doesn't allow reading it)`}
              >
                <Artwork src={p.imageUrl} title={p.name} style={{ width: 48, height: 48, borderRadius: 8 }} />
                <div className="grow">
                  <div className="t">{p.name}</div>
                  <div className="s">
                    {p.readable ? (p.trackCount !== null ? plural(p.trackCount, 'song') : '') : 'Not yours, so Spotify keeps it private'}
                  </div>
                </div>
                {p.readable && <span className="lib-go">Play</span>}
              </button>
            ))}
          </div>
          {data.playlists.some((p) => !p.readable) && (
            <p className="fine">
              Spotify lets this app read only playlists you own or collaborate on. To play someone else's, copy its songs into a playlist of your own.
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}
