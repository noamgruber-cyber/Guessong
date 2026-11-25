import type { UserDTO } from '@guessong/shared';
import { get, run, tx, type Db } from '../db';
import { ApiError, newId, now, pickAvatarColor, randomDisplayName, TokenCipher } from '../lib/util';
import type { SpotifyApi, SpotifyProfile, SpotifyTokenSet } from '../providers/spotify';

export interface UserRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  avatar_color: string;
  spotify_id: string | null;
  spotify_access_token: string | null;
  spotify_refresh_token: string | null;
  spotify_token_expires_at: number | null;
  created_at: number;
}

export function userDTO(u: UserRow): UserDTO {
  return {
    id: u.id,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    avatarColor: u.avatar_color,
    isGuest: !u.spotify_id,
    spotifyConnected: !!u.spotify_refresh_token,
  };
}

export class Users {
  private cipher: TokenCipher;

  constructor(
    private db: Db,
    sessionSecret: string,
    private spotify: SpotifyApi | null,
  ) {
    this.cipher = new TokenCipher(sessionSecret);
  }

  get(id: string): UserRow | undefined {
    return get<UserRow>(this.db, 'SELECT * FROM users WHERE id = ?', id);
  }

  require(id: string): UserRow {
    const u = this.get(id);
    if (!u) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    return u;
  }

  createGuest(displayName?: string): UserRow {
    const id = newId();
    const name = sanitizeName(displayName) ?? randomDisplayName();
    run(
      this.db,
      'INSERT INTO users (id, display_name, avatar_color, created_at) VALUES (?, ?, ?, ?)',
      id,
      name,
      pickAvatarColor(id),
      now(),
    );
    return this.get(id)!;
  }

  rename(userId: string, displayName: string): UserRow {
    const name = sanitizeName(displayName);
    if (!name) throw new ApiError(400, 'invalid_name', 'Name must be 2–24 characters');
    run(this.db, 'UPDATE users SET display_name = ? WHERE id = ?', name, userId);
    return this.require(userId);
  }

  // ---- sessions -----------------------------------------------------------

  createSession(userId: string): string {
    const id = newId(32);
    const t = now();
    run(this.db, 'INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', id, userId, t, t);
    return id;
  }

  sessionUser(sessionId: string | undefined): UserRow | undefined {
    if (!sessionId) return undefined;
    const s = get<{ user_id: string; last_seen_at: number }>(
      this.db,
      'SELECT user_id, last_seen_at FROM sessions WHERE id = ?',
      sessionId,
    );
    if (!s) return undefined;
    if (now() - s.last_seen_at > 60_000) run(this.db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), sessionId);
    return this.get(s.user_id);
  }

  deleteSession(sessionId: string) {
    run(this.db, 'DELETE FROM sessions WHERE id = ?', sessionId);
  }

  // ---- Spotify ------------------------------------------------------------

  /**
   * Called after the OAuth callback. A guest signing in keeps their scores
   * (the guest account is upgraded); if that Spotify account already has a
   * Guessong user, the session switches to it.
   */
  linkSpotify(currentUserId: string | null, profile: SpotifyProfile, tokens: SpotifyTokenSet): UserRow {
    const spotifyId = profile.accountId ?? profile.id;
    return tx(this.db, () => {
      const existing = get<UserRow>(this.db, 'SELECT * FROM users WHERE spotify_id = ?', spotifyId);
      let userId: string;
      if (existing) {
        userId = existing.id;
      } else {
        const current = currentUserId ? this.get(currentUserId) : undefined;
        if (current && !current.spotify_id) {
          userId = current.id;
        } else {
          userId = this.createGuest(profile.displayName).id;
        }
      }
      run(
        this.db,
        `UPDATE users SET spotify_id = ?, display_name = ?, avatar_url = ?, spotify_access_token = ?,
           spotify_refresh_token = COALESCE(?, spotify_refresh_token), spotify_token_expires_at = ? WHERE id = ?`,
        spotifyId,
        sanitizeName(profile.displayName) ?? 'Spotify listener',
        profile.imageUrl,
        this.cipher.encrypt(tokens.accessToken),
        tokens.refreshToken ? this.cipher.encrypt(tokens.refreshToken) : null,
        tokens.expiresAt,
        userId,
      );
      return this.get(userId)!;
    });
  }

  /** A valid Spotify access token for the user, refreshing it when close to expiry. */
  async spotifyAccessToken(userId: string): Promise<{ accessToken: string; expiresAt: number }> {
    const u = this.require(userId);
    if (!this.spotify || !u.spotify_refresh_token) {
      throw new ApiError(401, 'spotify_not_connected', 'Connect your Spotify account first');
    }
    const access = u.spotify_access_token ? this.cipher.decrypt(u.spotify_access_token) : null;
    if (access && (u.spotify_token_expires_at ?? 0) > now() + 90_000) {
      return { accessToken: access, expiresAt: u.spotify_token_expires_at! };
    }
    const refresh = this.cipher.decrypt(u.spotify_refresh_token);
    if (!refresh) throw new ApiError(401, 'spotify_not_connected', 'Reconnect Spotify to continue');
    let t: SpotifyTokenSet;
    try {
      t = await this.spotify.refresh(refresh);
    } catch {
      this.disconnectSpotify(userId);
      throw new ApiError(401, 'spotify_not_connected', 'Your Spotify session expired. Reconnect to continue');
    }
    run(
      this.db,
      `UPDATE users SET spotify_access_token = ?, spotify_refresh_token = COALESCE(?, spotify_refresh_token),
         spotify_token_expires_at = ? WHERE id = ?`,
      this.cipher.encrypt(t.accessToken),
      t.refreshToken ? this.cipher.encrypt(t.refreshToken) : null,
      t.expiresAt,
      userId,
    );
    return { accessToken: t.accessToken, expiresAt: t.expiresAt };
  }

  /** Spotify policy: users must be able to disconnect their account easily. */
  disconnectSpotify(userId: string) {
    run(
      this.db,
      `UPDATE users SET spotify_access_token = NULL, spotify_refresh_token = NULL, spotify_token_expires_at = NULL
       WHERE id = ?`,
      userId,
    );
  }
}

function sanitizeName(name: string | undefined | null): string | null {
  if (!name) return null;
  const clean = name.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return clean.length >= 2 ? clean : null;
}
