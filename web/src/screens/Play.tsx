import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DEFAULT_HINT_RULES, skipDeltaMs, skipLabel, formatSeconds, type SearchResultDTO } from '@guessong/shared';
import { SPOTIFY_LOGIN_URL } from '../api';
import { resetEngine } from '../audio';
import { AttemptRows, GuessSearch, HintBar, HintReveals, LoadingView, ResultModal, Timeline } from '../components/game';
import { Close, Note, PauseIcon, PlayIcon, Refresh, SkipIcon } from '../components/Icons';
import { DeviceSheet } from '../components/sheets';
import { ConfirmDialog, Score, Spinner, Wordmark } from '../components/ui';
import { useGame } from '../game/useGame';
import { useSession } from '../lib/session';
import { Summary } from './Summary';

export function Play() {
  const { roundId = '' } = useParams();
  return <PlayRound key={roundId} roundId={roundId} />;
}

function PlayRound({ roundId }: { roundId: string }) {
  const { config, providerLabel } = useSession();
  const navigate = useNavigate();
  const game = useGame(roundId);
  const { state, playhead } = game;
  const [selected, setSelected] = useState<SearchResultDTO | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [pickDevice, setPickDevice] = useState(false);

  // A fresh, empty guess field for every attempt/song. Reset during render
  // (not in an effect) so the field never remounts after the player starts typing.
  const attemptKey = `${state.song?.roundSongId}:${state.song?.attempt}`;
  const [selectionFor, setSelectionFor] = useState(attemptKey);
  if (selectionFor !== attemptKey) {
    setSelectionFor(attemptKey);
    setSelected(null);
  }

  const exit = async () => {
    setConfirmExit(false);
    await game.abandon();
    navigate('/', { replace: true });
  };

  const rules = config?.hints ?? DEFAULT_HINT_RULES;
  const attempts = config?.attempts ?? 6;

  if (state.phase === 'summary' && state.summary) {
    return <Summary summary={state.summary} />;
  }

  if (state.phase === 'error' && state.error) {
    const e = state.error;
    return (
      <div className="screen">
        <div className="center-msg">
          {e.code === 'needs_device' ? (
            <>
              <h2>Pick a Spotify device</h2>
              <p>{e.message}</p>
              <button className="btn btn-primary" onClick={() => setPickDevice(true)}>
                Choose device
              </button>
            </>
          ) : e.code === 'premium_required' ? (
            <>
              <h2>Spotify Premium required</h2>
              <p>Spotify only allows full-song playback in other apps for Premium accounts.</p>
              <a className="btn btn-primary" href={SPOTIFY_LOGIN_URL}>
                Use another account
              </a>
            </>
          ) : e.code === 'spotify_not_connected' ? (
            <>
              <h2>Reconnect Spotify</h2>
              <p>{e.message}</p>
              <a className="btn btn-primary" href={SPOTIFY_LOGIN_URL}>
                Connect Spotify
              </a>
            </>
          ) : (
            <>
              <h2>Something went wrong</h2>
              <p>{e.message}</p>
              {e.retry && (
                <button className="btn btn-primary" onClick={game.retry}>
                  <Refresh /> Try again
                </button>
              )}
            </>
          )}
          <button className="link-btn" onClick={() => navigate('/', { replace: true })}>
            Back to playlists
          </button>
        </div>
        {pickDevice && (
          <DeviceSheet
            onClose={() => setPickDevice(false)}
            onChosen={() => {
              resetEngine();
              game.retry();
            }}
          />
        )}
      </div>
    );
  }

  if (state.phase === 'init' || state.phase === 'loading' || !state.song || !state.round) {
    return (
      <>
        <LoadingView
          progress={state.loadProgress}
          title={state.song && state.song.position > 1 ? 'Loading next song...' : 'Loading first song...'}
          onCancel={() => setConfirmExit(true)}
        />
        {confirmExit && <ExitDialog onConfirm={exit} onCancel={() => setConfirmExit(false)} />}
      </>
    );
  }

  if (state.phase === 'finishing') {
    return (
      <div className="screen">
        <div className="center-msg">
          <Spinner />
          <h2>Tallying your score…</h2>
        </div>
      </div>
    );
  }

  const song = state.song;
  const interactive = state.phase === 'ready';
  const lastAttempt = song.attempt >= attempts;
  const delta = skipDeltaMs(song.attempt);

  const submit = async () => {
    if (!selected || !interactive) return;
    await game.guess(selected.id);
  };

  return (
    <div className="game">
      <header className="game-header">
        <button className="circle-btn" onClick={() => setConfirmExit(true)} aria-label="Leave round">
          <Close />
        </button>
        <div className="titles">
          <div className="pl">{state.round.playlist.title}</div>
          <div className="count num">
            {song.position} / {state.round.totalSongs}
          </div>
        </div>
        <Score value={state.score} />
      </header>

      <AttemptRows song={song} wrongCount={state.wrongCount} resolved={state.phase === 'result'} />

      <Timeline attempt={song.attempt} playhead={playhead} providerLabel={providerLabel} />

      <HintBar song={song} rules={rules} disabled={!interactive} onHint={game.hint} />
      <HintReveals song={song} />

      <div className="stage">
        <Wordmark />
        <button
          className={`play-btn ${state.playing ? 'playing' : ''}`}
          onClick={game.togglePlay}
          disabled={!interactive && state.phase !== 'result'}
          aria-label={state.playing ? 'Pause' : `Play ${formatSeconds(song.unlockedMs)} clip`}
        >
          {state.playing ? <PauseIcon /> : <PlayIcon style={{ marginLeft: 4 }} />}
        </button>
      </div>

      <div className="guess-area">
        <div className="guess-row">
          <GuessSearch
            key={attemptKey}
            playlistId={state.round.playlist.id}
            disabled={!interactive}
            selected={selected}
            onSelect={setSelected}
            onSubmit={submit}
          />
          <button className="skip-btn" onClick={game.skip} disabled={!interactive} aria-label={skipLabel(song.attempt)}>
            {lastAttempt ? (
              <>
                <Note /> Reveal
              </>
            ) : (
              <>
                <SkipIcon /> Skip <span className="accent">+{formatSeconds(delta ?? 0)}</span>
              </>
            )}
          </button>
        </div>
        <button className="btn btn-primary btn-block" disabled={!selected || !interactive} onClick={submit}>
          {state.phase === 'busy' ? <Spinner /> : 'Submit my guess'}
        </button>
      </div>

      {state.phase === 'result' && state.reveal && (
        <ResultModal reveal={state.reveal} attempts={attempts} providerLabel={providerLabel} onContinue={game.next} />
      )}
      {confirmExit && <ExitDialog onConfirm={exit} onCancel={() => setConfirmExit(false)} />}
    </div>
  );
}

function ExitDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog
      title="Leave this round?"
      body="Your progress in this round will be lost and it won't count on the leaderboard."
      confirmLabel="Leave"
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
