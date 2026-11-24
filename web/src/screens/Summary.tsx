import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDuration, type RoundSummaryDTO } from '@guessong/shared';
import { api } from '../api';
import { primeAudio } from '../audio';
import { Diamond, PlayIcon, PodiumIcon, ShareIcon, Trophy } from '../components/Icons';
import { Artwork, Avatar, Spinner, Wordmark } from '../components/ui';
import { useSession } from '../lib/session';
import { plural, shareLink } from '../lib/util';

/** Screen 6: end-of-round summary. */
export function Summary({ summary }: { summary: RoundSummaryDTO }) {
  const { config, toast } = useSession();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  const challenge = async () => {
    try {
      const c = await api.createChallenge(summary.roundId);
      const res = await shareLink({
        title: 'Guessong challenge',
        text: `I scored ${summary.totalScore} on ${summary.playlist.title} in Guessong (${formatDuration(summary.durationMs)}). Same 10 songs — can you beat me?`,
        url: c.url,
      });
      if (res === 'copied') toast('Challenge link copied', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const playAgain = async () => {
    primeAudio(config);
    setStarting(true);
    try {
      const r = await api.createRound(summary.playlist.id);
      navigate(`/play/${r.round.id}`, { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
      setStarting(false);
    }
  };

  const v = summary.versus;

  return (
    <div className="screen">
      <header className="topbar" style={{ justifyContent: 'center' }}>
        <Wordmark size={22} />
      </header>

      <div className="summary-hero">
        <div className="eyebrow">{summary.playlist.title.toUpperCase()}</div>
        <div className="big">
          <Diamond />
          {summary.totalScore}
        </div>
        <div className="of">out of {summary.maxScore}</div>
        {summary.isNewBest && (
          <div className="badge-best">
            <Trophy style={{ width: 16, height: 16 }} /> {summary.previousBest ? `New personal best (was ${summary.previousBest.score})` : 'First score set!'}
          </div>
        )}
      </div>

      <div className="summary-stats">
        <div>
          <div className="k">Time</div>
          <div className="v">{formatDuration(summary.durationMs)}</div>
        </div>
        <div>
          <div className="k">Guessed</div>
          <div className="v">{summary.correctCount}/10</div>
        </div>
        <div>
          <div className="k">Rank</div>
          <div className="v">#{summary.rank}</div>
        </div>
      </div>
      <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
        Your best rank among {plural(summary.playerCount, 'player')}
      </div>

      {v && (
        <div className={`versus ${v.outcome}`}>
          <Avatar name={v.challenger.displayName} url={v.challenger.avatarUrl} color={v.challenger.avatarColor} size={40} />
          <div style={{ flex: 1 }}>
            <strong>{v.outcome === 'won' ? `You beat ${v.challenger.displayName}!` : v.outcome === 'tied' ? 'Dead heat!' : `${v.challenger.displayName} wins this one`}</strong>
            They scored {v.score} in {formatDuration(v.durationMs)}
          </div>
        </div>
      )}

      <div className="recap">
        {summary.songs.map((s) => (
          <div key={s.position} className="recap-row">
            <Artwork className="art" src={s.artworkUrl} title={s.title} />
            <div className="meta">
              <div className="t">{s.title}</div>
              <div className="a">{s.artist}</div>
            </div>
            <div className="res">
              <div className={`pts num ${s.points === 0 ? 'zero' : ''}`}>{s.status === 'correct' ? `+${s.points}` : 'Missed'}</div>
              <div>
                {s.status === 'correct' ? `Attempt ${s.attemptsUsed}` : '—'}
                {s.hintsUsed.length > 0 ? ' • hint' : ''}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="summary-actions">
        <button className="btn btn-dark btn-block" onClick={challenge}>
          <ShareIcon /> Challenge a friend
        </button>
        <button className="btn btn-primary btn-block" onClick={playAgain} disabled={starting}>
          {starting ? <Spinner /> : <PlayIcon />} Play again
        </button>
        <div className="row2">
          <button className="btn btn-outline" onClick={() => navigate(`/playlist/${summary.playlist.id}/leaderboard`)}>
            <PodiumIcon /> Leaderboard
          </button>
          <button className="btn btn-outline" onClick={() => navigate('/', { replace: true })}>
            Playlists
          </button>
        </div>
      </div>
    </div>
  );
}
