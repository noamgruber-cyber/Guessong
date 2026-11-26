import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDuration, type PlaylistCardDTO, type PlaylistsResponse, type PlaylistSummaryResponse } from '@guessong/shared';
import { api, ApiError, SPOTIFY_LOGIN_URL } from '../api';
import { primeAudio } from '../audio';
import { LibrarySheet, SpotifyGames } from '../components/library';
import { AccountSheet, ImportSheet } from '../components/sheets';
import { Diamond, Note, PlayIcon, PlusIcon, PodiumIcon, ShareIcon } from '../components/Icons';
import { Artwork, Avatar, RankBadge, ScorePill, Sheet, Spinner } from '../components/ui';
import { needsSpotifyConnect, useSession } from '../lib/session';
import { haptic, plural, shareLink, storageGet, storageSet } from '../lib/util';

export function Discovery() {
  const { config, user, toast } = useSession();
  const navigate = useNavigate();
  const [lang, setLang] = useState<string>(() => storageGet('guessong.lang') ?? '');
  const [filter, setFilter] = useState<'popular' | 'unplayed'>('popular');
  const [data, setData] = useState<PlaylistsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<PlaylistCardDTO | null>(null);
  const [account, setAccount] = useState(false);
  const [importing, setImporting] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [openWhenLoaded, setOpenWhenLoaded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.playlists(undefined, filter));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load, user?.id]);

  // Playlists ingest in the background on a fresh server: poll until some appear.
  useEffect(() => {
    if (!data || data.playlists.length > 0 || filter !== 'popular') return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [data, filter, load]);

  // Spotify OAuth round-trip feedback + resuming a challenge accepted before login.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('spotify') === 'connected') {
      toast('Spotify connected', 'success');
      if (config?.spotifyLibrary && !storageGet('guessong.pendingChallenge')) setLibraryOpen(true);
      const pending = storageGet('guessong.pendingChallenge');
      if (pending) {
        storageSet('guessong.pendingChallenge', null);
        navigate(`/c/${pending}`, { replace: true });
        return;
      }
    }
    const err = q.get('spotify_error');
    if (err) {
      toast(
        err === 'access_denied'
          ? 'Spotify sign-in was cancelled'
          : err === 'not_allowlisted'
            ? "This Spotify account isn't on Guessong's invite list yet. Ask the person who runs it to add you."
            : `Spotify sign-in failed (${err})`,
        'error',
      );
    }
    if (q.size) window.history.replaceState(null, '', window.location.pathname);
  }, [navigate, toast, config?.spotifyLibrary]);

  // Open a freshly built library game once the list includes it.
  useEffect(() => {
    if (!openWhenLoaded || !data) return;
    const card = data.mine.find((p) => p.id === openWhenLoaded);
    if (card) {
      setOpen(card);
      setOpenWhenLoaded(null);
    }
  }, [data, openWhenLoaded]);

  // Themed shelves (Eurovision, Themes…) come first, then languages.
  const shelves = useMemo(() => [...(data?.collections ?? []), ...(data?.languages ?? [])], [data]);
  // With no saved choice, open on the first language; the themed chips sit in front of it.
  const activeLang = lang && shelves.some((l) => l.code === lang) ? lang : (data?.languages[0]?.code ?? shelves[0]?.code ?? '');
  const visible = useMemo(
    () => (data?.playlists ?? []).filter((p) => !activeLang || p.lang === activeLang || p.collection === activeLang),
    [data, activeLang],
  );
  const langLabel = shelves.find((l) => l.code === activeLang)?.label ?? 'Playlists';
  const isShelf = (code: string) => data?.collections.some((c) => c.code === code) ?? false;
  const spotifyNeeded = needsSpotifyConnect(config, user);

  return (
    <div className="screen">
      <header className="topbar">
        <button className="circle-btn" onClick={() => setAccount(true)} aria-label="Your profile">
          {user ? <Avatar name={user.displayName} url={user.avatarUrl} color={user.avatarColor} size={40} /> : <Spinner />}
        </button>
        <h1>Guessong Picks</h1>
      </header>

      {spotifyNeeded && (
        <div className="banner">
          <div style={{ flex: 1 }}>
            <strong>Connect Spotify Premium to play</strong>
            <p>Songs play in full through your Spotify account.</p>
          </div>
          <a className="btn btn-primary btn-sm" href={SPOTIFY_LOGIN_URL}>
            Connect
          </a>
        </div>
      )}

      {config?.spotifyLibrary && user && (
        <SpotifyGames games={data?.mine ?? []} onOpen={setOpen} onNew={() => setLibraryOpen(true)} />
      )}

      {shelves.length > 0 && (
        <div className="chip-row" role="group" aria-label="Playlist shelves" style={{ marginTop: spotifyNeeded || config?.spotifyLibrary ? 14 : 0 }}>
          {shelves.map((l) => (
            <button
              key={l.code}
              className={`chip${isShelf(l.code) ? ' chip-shelf' : ''}`}
              aria-pressed={l.code === activeLang}
              onClick={() => {
                setLang(l.code);
                storageSet('guessong.lang', l.code);
              }}
            >
              <span className="flag" aria-hidden>
                {l.flag}
              </span>
              {l.label}
            </button>
          ))}
        </div>
      )}

      {data && data.recent.length > 0 && (
        <div className="recent-row" aria-label="Recently played">
          {data.recent.map((r) => (
            <button key={r.playlist.id} className="recent-card" onClick={() => setOpen(r.playlist)}>
              <Artwork className="art" src={r.playlist.artworkUrl} mosaic={r.playlist.mosaic} title={r.playlist.title} />
              <div className="meta">
                <div className="title">{r.playlist.title}</div>
                {r.playlist.me && (
                  <div className="stats status-best">
                    <Diamond /> <b className="num">{r.playlist.me.bestScore}</b> • #{r.playlist.me.rank}
                  </div>
                )}
                <div className="beat">Beat your record</div>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="section-head">
        <h2>{langLabel}</h2>
        <div className="segmented" role="group" aria-label="Filter">
          <button aria-pressed={filter === 'popular'} onClick={() => setFilter('popular')}>
            Popular
          </button>
          <button aria-pressed={filter === 'unplayed'} onClick={() => setFilter('unplayed')}>
            Not played yet
          </button>
        </div>
      </div>

      {loadError && (
        <div className="empty">
          {loadError}
          <div>
            <button className="btn btn-soft btn-sm" style={{ marginTop: 12 }} onClick={load}>
              Try again
            </button>
          </div>
        </div>
      )}

      {!data && !loadError && (
        <div className="grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i}>
              <div className="skeleton" style={{ aspectRatio: '1' }} />
              <div className="skeleton" style={{ height: 14, marginTop: 10, width: '80%' }} />
            </div>
          ))}
        </div>
      )}

      {data && visible.length === 0 && (
        <div className="empty">
          {filter === 'unplayed'
            ? "You've played every playlist here. Beat your records!"
            : 'Playlists are being prepared. This takes a minute on a fresh server…'}
        </div>
      )}

      <div className="grid">
        {visible.map((p) => (
          <button key={p.id} className="pcard" onClick={() => setOpen(p)}>
            <Artwork className="art" src={p.artworkUrl} mosaic={p.mosaic} title={p.title} />
            <div className="title">{p.title}</div>
            <div className="sub">
              {plural(p.songCount, 'song')} • {plural(p.playerCount, 'player')}
            </div>
            <div className="status">
              {p.me ? (
                <span className="status-best">
                  <Diamond /> <span className="num">{p.me.bestScore}</span> • #{p.me.rank}
                </span>
              ) : (
                <span className="status-new">Set your first score</span>
              )}
            </div>
          </button>
        ))}
        {config?.provider === 'spotify' && user?.spotifyConnected && (
          <button className="pcard" onClick={() => setImporting(true)}>
            <div className="art" style={{ aspectRatio: '1', borderRadius: 14, display: 'grid', placeItems: 'center', border: '2px dashed var(--border)', background: 'var(--bg)' }}>
              <PlusIcon style={{ width: 32, height: 32, color: 'var(--muted)' }} />
            </div>
            <div className="title">Add your playlist</div>
            <div className="sub">From your Spotify library</div>
          </button>
        )}
      </div>

      {open && (
        <PlaylistSheet
          playlist={open}
          onClose={() => setOpen(null)}
          onRemoved={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
      {account && (
        <AccountSheet
          onClose={() => setAccount(false)}
          onImport={() => {
            setAccount(false);
            if (config?.spotifyLibrary) setLibraryOpen(true);
            else setImporting(true);
          }}
        />
      )}
      {libraryOpen && (
        <LibrarySheet
          onClose={() => {
            setLibraryOpen(false);
            void load();
            // A build left running finishes in the background.
            setTimeout(() => void load(), 20_000);
          }}
          onCreated={(playlistId) => {
            setLibraryOpen(false);
            setOpenWhenLoaded(playlistId);
            void load();
          }}
        />
      )}
      {importing && (
        <ImportSheet
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

export function PlaylistSheet({
  playlist,
  onClose,
  onRemoved,
}: {
  playlist: PlaylistCardDTO;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { config, user, ensureUser, toast, providerLabel } = useSession();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<PlaylistSummaryResponse | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.playlistSummary(playlist.id).then(setSummary).catch(() => {});
  }, [playlist.id, user?.id]);

  const p = summary?.playlist ?? playlist;
  const me = summary?.me ?? null;

  const play = async () => {
    haptic();
    primeAudio(config); // inside the tap: unlocks audio for the autoplaying first clip
    if (needsSpotifyConnect(config, user)) {
      window.location.href = SPOTIFY_LOGIN_URL;
      return;
    }
    setStarting(true);
    try {
      await ensureUser();
      const r = await api.createRound(playlist.id);
      navigate(`/play/${r.round.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'spotify_not_connected') window.location.href = SPOTIFY_LOGIN_URL;
      else toast((e as Error).message, 'error');
      setStarting(false);
    }
  };

  const challenge = async () => {
    if (!me) {
      toast('Play a round first, then challenge friends to beat your score.');
      return;
    }
    try {
      const c = await api.challengeFromBest(playlist.id);
      const res = await shareLink({
        title: 'Guessong challenge',
        text: `I scored ${me.bestScore} on ${p.title} in Guessong. Can you beat me?`,
        url: c.url,
      });
      if (res === 'copied') toast('Challenge link copied', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Sheet onClose={onClose} label={p.title}>
      <div className="pl-head">
        <Artwork className="art" src={p.artworkUrl} mosaic={p.mosaic} title={p.title} />
        <div style={{ minWidth: 0 }}>
          <h2>{p.title}</h2>
          <div className="attribution">
            <Note /> {playlist.source === 'library' ? 'From your Spotify · previews by Deezer' : providerLabel}
          </div>
          <div className="meta">
            {plural(p.songCount, 'song')} • {summary?.songsPerRound ?? 10} per round
          </div>
        </div>
      </div>
      {p.description && playlist.source === 'seed' && <p className="pl-desc">{p.description}</p>}

      <div className="status-card">
        {me ? (
          <div className="best">
            <div>
              <strong>Your best: #{me.rank}</strong>
              {formatDuration(me.bestDurationMs)} • of {plural(p.playerCount, 'player')}
            </div>
            <ScorePill value={me.bestScore} />
          </div>
        ) : (
          <>
            <strong>No score yet</strong>
            Play your first round and see where you stand among {plural(p.playerCount, 'player')}.
          </>
        )}
      </div>

      <div className="lb-head">
        <h3>Top</h3>
        <span>Best single round</span>
      </div>
      {summary && summary.top.length === 0 && <div className="empty" style={{ padding: '16px 0' }}>Nobody has played yet. Be the first!</div>}
      {!summary && <div className="skeleton" style={{ height: 150 }} />}
      {summary?.top.map((e) => (
        <div key={e.userId} className={`lb-row ${e.isMe ? 'me' : ''}`}>
          <RankBadge rank={e.rank} />
          <Avatar name={e.displayName} url={e.avatarUrl} color={e.avatarColor} />
          <span className="name">{e.isMe ? `${e.displayName} (you)` : e.displayName}</span>
          <span className="time">{formatDuration(e.bestDurationMs)}</span>
          <ScorePill value={e.bestScore} />
        </div>
      ))}

      <div className="sheet-actions">
        <button className="btn btn-outline" onClick={challenge}>
          <ShareIcon /> Challenge
        </button>
        <button className="btn btn-outline" onClick={() => navigate(`/playlist/${playlist.id}/leaderboard`)}>
          <PodiumIcon /> Leaderboard
        </button>
      </div>
      <button className="btn btn-primary btn-block play-cta" onClick={play} disabled={starting}>
        {starting ? <Spinner /> : <PlayIcon />} {needsSpotifyConnect(config, user) ? 'Connect Spotify to play' : 'Play'}
      </button>
      {playlist.source === 'library' && onRemoved && (
        <button
          className="link-btn lib-remove"
          onClick={async () => {
            try {
              await api.removeLibraryGame(playlist.id);
              toast(`${p.title} removed`);
              onRemoved();
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          Remove this game
        </button>
      )}
    </Sheet>
  );
}
