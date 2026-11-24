import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import { getEngine, getPlaybackPref } from './audio';
import { sdkLikelySupported } from './audio/spotifySdkEngine';
import { Spinner } from './components/ui';
import { useSession } from './lib/session';
import { Challenge } from './screens/Challenge';
import { Discovery } from './screens/Discovery';
import { Leaderboard } from './screens/Leaderboard';
import { Play } from './screens/Play';

export function App() {
  const { ready, config, user, error, refresh } = useSession();

  // Spotify: start the in-browser player early so the Play tap can activate it.
  useEffect(() => {
    if (config?.provider !== 'spotify' || !user?.spotifyConnected) return;
    const pref = getPlaybackPref();
    if (pref.mode === 'browser' || (pref.mode === 'auto' && sdkLikelySupported())) void getEngine(config).catch(() => {});
  }, [config, user?.spotifyConnected]);

  if (!ready) {
    return (
      <div className="app">
        <div className="center-msg" style={{ minHeight: '100dvh' }}>
          <Spinner />
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="app">
        <div className="center-msg" style={{ minHeight: '100dvh' }}>
          <h2>Can't reach Guessong</h2>
          <p>{error ?? 'The server did not respond.'}</p>
          <button className="btn btn-primary" onClick={refresh}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Discovery />} />
        <Route path="/play/:roundId" element={<Play />} />
        <Route path="/playlist/:playlistId/leaderboard" element={<Leaderboard />} />
        <Route path="/c/:code" element={<Challenge />} />
        <Route path="*" element={<Discovery />} />
      </Routes>
    </div>
  );
}
