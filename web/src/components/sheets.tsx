import { useEffect, useState } from 'react';
import { LANGUAGES, type SpotifyDeviceDTO, type SpotifyPlaylistOptionDTO } from '@guessong/shared';
import { api, SPOTIFY_LOGIN_URL } from '../api';
import { getPlaybackPref, setPlaybackPref, type PlaybackPref } from '../audio';
import { sdkLikelySupported } from '../audio/spotifySdkEngine';
import { useSession } from '../lib/session';
import { Check, Refresh, Speaker } from './Icons';
import { Artwork, Avatar, Sheet, Spinner } from './ui';

export function AccountSheet({ onClose, onImport }: { onClose: () => void; onImport: () => void }) {
  const { user, config, setUser, refresh, toast, providerLabel } = useSession();
  const [name, setName] = useState(user?.displayName ?? '');
  const [devices, setDevices] = useState(false);
  const spotify = config?.provider === 'spotify';
  const library = !!config?.spotifyLibrary;

  const save = async () => {
    try {
      const r = await api.rename(name);
      setUser(r.user);
      toast('Name saved', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (devices) return <DeviceSheet onClose={() => setDevices(false)} />;

  return (
    <Sheet onClose={onClose} label="Your profile">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8 }}>
        {user && <Avatar name={user.displayName} url={user.avatarUrl} color={user.avatarColor} size={56} />}
        <div>
          <div style={{ fontWeight: 800, fontSize: 20 }}>{user?.displayName}</div>
          <div style={{ color: 'var(--muted)', fontSize: 14 }}>
            {spotify || library ? (user?.spotifyConnected ? 'Spotify connected' : 'Guest — Spotify not connected') : 'Guest player'}
          </div>
        </div>
      </div>

      <div className="label-sm">Display name</div>
      <div className="field">
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
        <button className="btn btn-dark btn-sm" style={{ minHeight: 48 }} onClick={save} disabled={name.trim().length < 2 || name === user?.displayName}>
          Save
        </button>
      </div>

      {spotify && (
        <>
          <div className="label-sm">Spotify</div>
          <div className="list">
            {user?.spotifyConnected ? (
              <>
                <button className="list-item" onClick={() => setDevices(true)}>
                  <Speaker style={{ width: 22, height: 22 }} />
                  <div className="grow">
                    <div className="t">Playback device</div>
                    <div className="s">{describePref(getPlaybackPref())}</div>
                  </div>
                </button>
                <button className="list-item" onClick={onImport}>
                  <div className="grow">
                    <div className="t">Add a playlist from your library</div>
                    <div className="s">Playlists you own or collaborate on</div>
                  </div>
                </button>
                <button
                  className="list-item"
                  onClick={async () => {
                    const r = await api.disconnectSpotify();
                    setUser(r.user);
                    toast('Spotify disconnected');
                  }}
                >
                  <div className="grow">
                    <div className="t" style={{ color: 'var(--red-ink)' }}>Disconnect Spotify</div>
                    <div className="s">Removes Guessong's access tokens. Your scores stay.</div>
                  </div>
                </button>
              </>
            ) : (
              <a className="btn btn-primary btn-block" href={SPOTIFY_LOGIN_URL} style={{ marginTop: 10, textDecoration: 'none' }}>
                Connect Spotify Premium
              </a>
            )}
          </div>
        </>
      )}

      {library && (
        <>
          <div className="label-sm">Spotify</div>
          <div className="list">
            {user?.spotifyConnected ? (
              <>
                <button className="list-item" onClick={onImport}>
                  <div className="grow">
                    <div className="t">New game from your Spotify</div>
                    <div className="s">Playlists, liked songs, top songs, genres</div>
                  </div>
                </button>
                <button
                  className="list-item"
                  onClick={async () => {
                    const r = await api.disconnectSpotify();
                    setUser(r.user);
                    toast('Spotify disconnected');
                  }}
                >
                  <div className="grow">
                    <div className="t" style={{ color: 'var(--red-ink)' }}>Disconnect Spotify</div>
                    <div className="s">Removes Guessong's access. Your games and scores stay.</div>
                  </div>
                </button>
              </>
            ) : (
              <>
                <a className="btn btn-primary btn-block" href={SPOTIFY_LOGIN_URL} style={{ marginTop: 10, textDecoration: 'none' }}>
                  Connect Spotify
                </a>
                <p className="fine">Invite only: Spotify allows up to 5 accounts, added by the person who runs this Guessong.</p>
              </>
            )}
          </div>
        </>
      )}

      <div className="label-sm">Session</div>
      <button
        className="btn btn-soft btn-block"
        style={{ marginTop: 10 }}
        onClick={async () => {
          await api.logout();
          await refresh();
          onClose();
        }}
      >
        Sign out
      </button>
      <p className="fine">
        Music previews and metadata are provided by {providerLabel}
        {library ? '. Song lists in Spotify games come from your Spotify account, with previews by Deezer' : ''}. Guessong is an independent game
        and is not affiliated with or endorsed by {library ? `${providerLabel}, Spotify or Deezer` : providerLabel}.
      </p>
    </Sheet>
  );
}

function describePref(p: PlaybackPref) {
  if (p.mode === 'device') return p.name;
  if (p.mode === 'browser') return 'This browser';
  return sdkLikelySupported() ? 'Automatic (this browser)' : 'Automatic — pick a device';
}

/** Choose where Spotify plays: the in-browser player, or a Spotify Connect device (phone app). */
export function DeviceSheet({ onClose, onChosen }: { onClose: () => void; onChosen?: () => void }) {
  const { toast } = useSession();
  const [devices, setDevices] = useState<SpotifyDeviceDTO[] | null>(null);
  const [pref, setPref] = useState(getPlaybackPref());
  const load = async () => {
    setDevices(null);
    try {
      setDevices((await api.spotifyDevices()).devices.filter((d) => d.name !== 'Guessong'));
    } catch (e) {
      toast((e as Error).message, 'error');
      setDevices([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const choose = (p: PlaybackPref) => {
    setPlaybackPref(p);
    setPref(p);
    onChosen?.();
    onClose();
  };
  return (
    <Sheet onClose={onClose} label="Playback device">
      <h2 style={{ margin: '8px 44px 4px 0', fontSize: 21, fontWeight: 800 }}>Where should songs play?</h2>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14, lineHeight: 1.45 }}>
        On iPhone, open the Spotify app and play/pause any song once so it shows up here, then come back.
      </p>
      <div className="list" style={{ marginTop: 10 }}>
        {sdkLikelySupported() && (
          <button className="list-item" onClick={() => choose({ mode: 'browser' })}>
            <Speaker style={{ width: 22, height: 22 }} />
            <div className="grow">
              <div className="t">This browser</div>
              <div className="s">Most precise timing</div>
            </div>
            {pref.mode !== 'device' && <Check style={{ color: 'var(--green)' }} />}
          </button>
        )}
        {devices === null && (
          <div style={{ padding: 16, display: 'grid', placeItems: 'center' }}>
            <Spinner />
          </div>
        )}
        {devices?.map((d) => (
          <button key={d.id} className="list-item" onClick={() => choose({ mode: 'device', deviceId: d.id, name: d.name })}>
            <Speaker style={{ width: 22, height: 22 }} />
            <div className="grow">
              <div className="t">{d.name}</div>
              <div className="s">
                {d.type}
                {d.isActive ? ' • active' : ''}
              </div>
            </div>
            {pref.mode === 'device' && pref.deviceId === d.id && <Check style={{ color: 'var(--green)' }} />}
          </button>
        ))}
        {devices?.length === 0 && <div className="empty" style={{ padding: '18px 0' }}>No Spotify devices found yet.</div>}
      </div>
      <button className="btn btn-soft btn-block" style={{ marginTop: 10 }} onClick={load}>
        <Refresh /> Refresh devices
      </button>
    </Sheet>
  );
}

export function ImportSheet({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { toast } = useSession();
  const [items, setItems] = useState<SpotifyPlaylistOptionDTO[] | null>(null);
  const [lang, setLang] = useState('en');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api
      .spotifyPlaylists()
      .then((r) => setItems(r.playlists))
      .catch((e) => {
        toast((e as Error).message, 'error');
        setItems([]);
      });
  }, [toast]);
  return (
    <Sheet onClose={onClose} label="Add a playlist">
      <h2 style={{ margin: '8px 44px 4px 0', fontSize: 21, fontWeight: 800 }}>Add a playlist</h2>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14, lineHeight: 1.45 }}>
        Spotify lets this app read playlists you own or collaborate on. Everyone here can then play it, with its own leaderboard.
      </p>
      <div className="label-sm">Language</div>
      <div className="chip-row" style={{ marginTop: 8 }}>
        {LANGUAGES.map((l) => (
          <button key={l.code} className="chip" aria-pressed={lang === l.code} onClick={() => setLang(l.code)}>
            <span className="flag">{l.flag}</span>
            {l.label}
          </button>
        ))}
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        {items === null && (
          <div style={{ padding: 16, display: 'grid', placeItems: 'center' }}>
            <Spinner />
          </div>
        )}
        {items?.length === 0 && <div className="empty">No playlists of your own found.</div>}
        {items?.map((p) => (
          <div key={p.id} className="list-item">
            <Artwork src={p.imageUrl} title={p.name} style={{ width: 48, height: 48, borderRadius: 8 }} />
            <div className="grow">
              <div className="t">{p.name}</div>
              <div className="s">{p.trackCount !== null ? `${p.trackCount} songs` : ''}</div>
            </div>
            <button
              className="btn btn-dark btn-sm"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(p.id);
                try {
                  await api.importPlaylist(p.id, lang);
                  toast(`${p.name} added`, 'success');
                  onImported();
                } catch (e) {
                  toast((e as Error).message, 'error');
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === p.id ? <Spinner /> : p.imported ? 'Update' : 'Add'}
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
