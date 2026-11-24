import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatDuration, type LeaderboardEntryDTO, type LeaderboardResponse } from '@guessong/shared';
import { api } from '../api';
import { Back } from '../components/Icons';
import { Avatar, RankBadge, ScorePill, Spinner } from '../components/ui';
import { plural } from '../lib/util';

const PAGE = 50;

function Row({ e }: { e: LeaderboardEntryDTO }) {
  return (
    <div className={`lb-row ${e.isMe ? 'me' : ''}`}>
      <RankBadge rank={e.rank} />
      <Avatar name={e.displayName} url={e.avatarUrl} color={e.avatarColor} />
      <span className="name">{e.isMe ? `${e.displayName} (you)` : e.displayName}</span>
      <span className="time">{formatDuration(e.bestDurationMs)}</span>
      <ScorePill value={e.bestScore} />
    </div>
  );
}

export function Leaderboard() {
  const { playlistId = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [entries, setEntries] = useState<LeaderboardEntryDTO[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const r = await api.leaderboard(playlistId, p, PAGE);
        setData(r);
        setEntries((prev) => (p === 1 ? r.entries : [...prev, ...r.entries]));
        setPage(p);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [playlistId],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  const meVisible = entries.some((e) => e.isMe);

  return (
    <div className="screen">
      <header className="topbar">
        <button className="circle-btn" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))} aria-label="Back">
          <Back />
        </button>
        <h1>{data?.playlist.title ?? 'Leaderboard'}</h1>
      </header>
      {data && (
        <div className="lb-head" style={{ marginTop: 0 }}>
          <h3>Best single round</h3>
          <span>{plural(data.total, 'player')}</span>
        </div>
      )}
      {error && <div className="empty">{error}</div>}
      {!data && !error && (
        <div className="center-msg" style={{ minHeight: 200 }}>
          <Spinner />
        </div>
      )}
      {data && entries.length === 0 && <div className="empty">No scores yet. Play a round to claim #1.</div>}
      <div>
        {entries.map((e) => (
          <Row key={e.userId} e={e} />
        ))}
      </div>
      {data && entries.length < data.total && (
        <button className="btn btn-soft btn-block" style={{ marginTop: 14 }} onClick={() => load(page + 1)} disabled={loading}>
          {loading ? <Spinner /> : 'Show more'}
        </button>
      )}
      {data?.me && !meVisible && (
        <div className="sticky-me">
          <Row e={data.me} />
        </div>
      )}
    </div>
  );
}
