import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatDuration, type ChallengeInfoDTO } from '@guessong/shared';
import { api, ApiError, SPOTIFY_LOGIN_URL } from '../api';
import { primeAudio } from '../audio';
import { PlayIcon } from '../components/Icons';
import { Artwork, Avatar, ScorePill, Spinner, Wordmark } from '../components/ui';
import { needsSpotifyConnect, useSession } from '../lib/session';
import { plural, storageSet } from '../lib/util';

/** Deep link /c/:code — play the exact same 10 songs as a friend. */
export function Challenge() {
  const { code = '' } = useParams();
  const { config, user, ensureUser, toast } = useSession();
  const navigate = useNavigate();
  const [info, setInfo] = useState<ChallengeInfoDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.challenge(code).then(setInfo).catch((e) => setError((e as Error).message));
  }, [code]);

  const accept = async () => {
    if (!info) return;
    primeAudio(config);
    if (needsSpotifyConnect(config, user)) {
      storageSet('guessong.pendingChallenge', code);
      window.location.href = SPOTIFY_LOGIN_URL;
      return;
    }
    setStarting(true);
    try {
      await ensureUser();
      const r = await api.createRound(info.playlist.id, code);
      navigate(`/play/${r.round.id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'spotify_not_connected') {
        storageSet('guessong.pendingChallenge', code);
        window.location.href = SPOTIFY_LOGIN_URL;
        return;
      }
      toast((e as Error).message, 'error');
      setStarting(false);
    }
  };

  if (error) {
    return (
      <div className="screen">
        <div className="center-msg">
          <h2>Challenge not found</h2>
          <p>The link may be wrong or the playlist is no longer available.</p>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            Browse playlists
          </button>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="screen">
        <div className="center-msg">
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="topbar" style={{ justifyContent: 'center' }}>
        <Wordmark size={22} />
      </header>
      <div className="challenge-hero">
        <Avatar name={info.challenger.displayName} url={info.challenger.avatarUrl} color={info.challenger.avatarColor} size={72} />
        <h2>{info.challenger.displayName} challenged you</h2>
        <p>Same 10 songs. Beat their score, or tie it faster.</p>
      </div>
      <div className="status-card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Artwork src={info.playlist.artworkUrl} mosaic={info.playlist.mosaic} title={info.playlist.title} style={{ width: 64, height: 64, borderRadius: 12 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{info.playlist.title}</strong>
          {plural(info.playlist.playerCount, 'player')}
        </div>
      </div>
      <div className="status-card best" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <strong>Score to beat</strong>
          in {formatDuration(info.durationMs)}
        </div>
        <ScorePill value={info.score} />
      </div>
      <button className="btn btn-primary btn-block" style={{ marginTop: 22 }} onClick={accept} disabled={starting}>
        {starting ? <Spinner /> : <PlayIcon />} {needsSpotifyConnect(config, user) ? 'Connect Spotify to accept' : 'Accept challenge'}
      </button>
      <button className="link-btn" style={{ display: 'block', margin: '8px auto 0' }} onClick={() => navigate('/')}>
        Not now
      </button>
    </div>
  );
}
